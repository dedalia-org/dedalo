/**
 * Bring an ontology release into a directory the seed compiles from — by default the shipped
 * `install/import/ontology/<major.minor>/`:
 *   - `pullOntologyRelease`: from a configured ontology master (`ONTOLOGY_SERVERS` by name) —
 *     `bun run seed:build --from <name>`, the build_database_version panel's "Pull from master";
 *   - `copyLocalRelease`: from this server's own export dir (an ontology master's panel).
 *
 * No new outbound door: the manifest comes through `fetchOntologyManifest` and every file
 * through `downloadRemoteOntologyFile` (origin-pinned, size-capped, sha256-checked), the same
 * two calls an ontology update makes. Stricter than an update: a file the source publishes no
 * sha256 for refuses — the seed is committed, so its bytes must be the master's. A local copy
 * holds the export to the same digests (`digestRefusal`).
 *
 * All files are downloaded and verified into a staging dir first; only then is the release
 * target dir mirrored: `<tld>.copy.gz` + `ontology.json` replaced, `.copy.gz` files the master no
 * longer lists removed, anything else (`ontology_llm_map.json`, `recovery/`) left alone.
 */

import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config/config.ts';
import { DedaloError } from '../errors/index.ts';
import { isTestFixtureTld } from '../ontology/core_tlds.ts';
import {
	digestRefusal,
	downloadRemoteOntologyFile,
	type OntologyIoResponse,
} from '../ontology/data_io_import.ts';
import {
	fetchOntologyManifest,
	type ManifestResult,
	readLocalOntologyManifest,
} from '../ontology/ontology_manifest.ts';
import { DEDALO_DATA_VERSION } from '../update/version.ts';
import { ontologyCompatibility } from '../update/version_contract.ts';
import { ONTOLOGY_RELEASE_DIR } from './seed_sources.ts';

export interface ReleasePullDeps {
	servers?: readonly { name: string; url: string; code: string }[];
	releaseDir?: string;
	fetchManifest?: typeof fetchOntologyManifest;
	download?: (
		options: Parameters<typeof downloadRemoteOntologyFile>[0],
	) => Promise<OntologyIoResponse>;
}

export interface ReleasePullResult {
	/** The source as the operator named it (a master's name, or the export dir). */
	server: string;
	version: string | null;
	written: string[];
	removed: string[];
	warnings: string[];
}

/** One file into `targetDir/name`; THROWS (refuse) unless it is the bytes `sha256` names. */
type FetchFile = (file: {
	url: string;
	name: string;
	targetDir: string;
	sha256?: string;
}) => Promise<void>;

function refuse(sentence: string): never {
	throw new DedaloError('maintenance.action_failed', { publicMessage: `Error. ${sentence}` });
}

export async function pullOntologyRelease(
	serverName: string,
	deps: ReleasePullDeps = {},
): Promise<ReleasePullResult> {
	const servers = deps.servers ?? config.ontologyIo.servers;
	const server = configuredServer(serverName, servers);
	const manifest: ManifestResult = await (deps.fetchManifest ?? fetchOntologyManifest)(
		{ name: server.name, url: server.url, code: server.code },
		servers,
	);
	const fetchFile = originPinnedFetch(
		deps.download ?? downloadRemoteOntologyFile,
		new URL(server.url).origin,
	);
	return mirrorRelease(serverName, manifest, fetchFile, deps.releaseDir ?? ONTOLOGY_RELEASE_DIR);
}

type ServerEntry = NonNullable<ReleasePullDeps['servers']>[number];

/** The ONTOLOGY_SERVERS entry by name — never an address the caller supplies. */
function configuredServer(name: string, servers: readonly ServerEntry[]): ServerEntry {
	const server = servers.find((entry) => entry.name === name);
	if (server !== undefined) return server;
	const known = servers.map((entry) => entry.name).join(', ');
	return refuse(`no ONTOLOGY_SERVERS entry named '${name}' (configured: ${known || 'none'})`);
}

/** Each file through the update panel's download door, pinned to the server's configured origin. */
function originPinnedFetch(
	download: typeof downloadRemoteOntologyFile,
	configuredOrigin: string,
): FetchFile {
	return async (file) => {
		const got = await download({
			url: file.url,
			configuredOrigin,
			expectedBasename: file.name,
			targetDir: file.targetDir,
			...(file.sha256 === undefined ? {} : { expectedSha256: file.sha256 }),
		});
		if (!got.ok) refuse(`${file.name}: ${got.msg} ${got.errors.join('; ')}`);
	};
}

/** This server's own export dir (`<io dir>/<major.minor>`) into `releaseDir`, held to its digests. */
export async function copyLocalRelease(
	exportDir: string,
	releaseDir: string = ONTOLOGY_RELEASE_DIR,
): Promise<ReleasePullResult> {
	const copy: FetchFile = async (file) => {
		const target = join(file.targetDir, file.name);
		await copyFile(fileURLToPath(file.url), target);
		const refused = await digestRefusal(target, file.sha256);
		if (refused !== null) refuse(`${file.name}: ${refused.msg} ${refused.error}`);
	};
	return mirrorRelease(exportDir, readLocalOntologyManifest(exportDir), copy, releaseDir);
}

/**
 * Packages an ontology master exports that the vendored release NEVER carries, each with its
 * reason (owner rulings). The pull skips the package and its `files_sha256` digest but keeps the
 * `active_ontologies` entry — the catalog's description, not an offer: the installer offers only
 * packages present. install_seed_drift_tripwire holds the vendored release to this list.
 */
export const RELEASE_EXCLUDED_TLDS: Readonly<Record<string, string>> = Object.freeze({
	mht: "Woman and Memory — an installation's own ontology, marked '[USE LOCAL!]' on the master (owner ruling 2026-11-26)",
});

type ReleaseFile = { name: string; url: string; sha256: string | undefined };
type UsableManifest = Extract<ManifestResult, { ok: true }>;

/** A readable manifest of a compatible release, or a refusal. */
function usableManifest(label: string, manifest: ManifestResult): UsableManifest {
	if (!manifest.ok) refuse(`the ontology manifest of ${label} cannot be read: ${manifest.reason}`);
	const verdict = ontologyCompatibility(manifest.version, DEDALO_DATA_VERSION);
	if (!verdict.ok) refuse(verdict.detail);
	return manifest;
}

const isExcludedTld = (tld: string): boolean => Object.hasOwn(RELEASE_EXCLUDED_TLDS, tld);

/**
 * The files a release vendors: every package but the suite's `test` fixture (core_tlds.ts: `zz*`
 * scratch TLDs are not matched — they never reach a master; install_seed_drift holds the release
 * to it) and the RELEASE_EXCLUDED_TLDS, plus matrix_dd. Each must carry a published sha256.
 */
function vendoredFiles(label: string, manifest: UsableManifest): ReleaseFile[] {
	const files: ReleaseFile[] = manifest.ontologies
		.filter((o) => !isTestFixtureTld(o.tld) && !isExcludedTld(o.tld))
		.map((o) => ({ name: `${o.tld}.copy.gz`, url: o.url, sha256: o.sha256 }));
	if (manifest.matrixDdUrl !== null) {
		files.push({
			name: 'matrix_dd.copy.gz',
			url: manifest.matrixDdUrl,
			sha256: manifest.matrixDdSha256,
		});
	}
	if (files.length === 0) refuse(`${label} publishes no ontology files`);
	const unverified = files.filter((f) => f.sha256 === undefined).map((f) => f.name);
	if (unverified.length > 0) {
		refuse(
			`${label} publishes no sha256 for ${unverified.join(', ')} — re-export it on the master`,
		);
	}
	return files;
}

/**
 * The staged ontology.json, held to the packages just verified (the manifest WAS this file), with
 * the digests of every package not vendored dropped; fixtures leave its description too.
 */
async function checkReleaseInfo(
	infoPath: string,
	files: readonly ReleaseFile[],
	dropped: { fixtures: string[]; excluded: string[] },
): Promise<void> {
	const info = JSON.parse(await readFile(infoPath, 'utf8')) as {
		files_sha256?: Record<string, string>;
		active_ontologies?: { tld: string }[];
	};
	const declared = info.files_sha256 ?? {};
	const disagreeing = files.find((file) => declared[file.name] !== file.sha256);
	if (disagreeing !== undefined) {
		refuse(`ontology.json disagrees with the manifest on ${disagreeing.name}`);
	}
	const unshipped = [...dropped.fixtures, ...dropped.excluded];
	if (unshipped.length === 0) return;
	for (const tld of unshipped) delete declared[`${tld}.copy.gz`];
	info.active_ontologies = (info.active_ontologies ?? []).filter((e) => !isTestFixtureTld(e.tld));
	await writeFile(infoPath, `${JSON.stringify(info, null, '\t')}\n`);
}

/** Replace the release dir's packages + ontology.json with the staged ones; returns the removed. */
function mirrorInto(releaseDir: string, staging: string, incoming: ReadonlySet<string>): string[] {
	const removed = readdirSync(releaseDir).filter(
		(name) => name.endsWith('.copy.gz') && !incoming.has(name),
	);
	for (const name of removed) rmSync(join(releaseDir, name));
	for (const name of incoming) renameSync(join(staging, name), join(releaseDir, name));
	return removed;
}

function pullWarnings(
	label: string,
	manifest: UsableManifest,
	dropped: { fixtures: string[]; excluded: string[] },
): string[] {
	const fixtures =
		dropped.fixtures.length === 0
			? []
			: [
					`${label} exports the suite's test fixtures (${dropped.fixtures.join(', ')}): not vendored`,
				];
	return [
		...manifest.warnings,
		...fixtures,
		...dropped.excluded.map(
			(tld) => `${label} exports '${tld}': not vendored (${RELEASE_EXCLUDED_TLDS[tld]})`,
		),
	];
}

/**
 * Every file of `manifest` (packages + `ontology.json`) fetched and verified into a staging
 * dir; only then is `releaseDir` mirrored. Nothing is written there when anything refuses.
 */
async function mirrorRelease(
	label: string,
	rawManifest: ManifestResult,
	fetchFile: FetchFile,
	releaseDir: string,
): Promise<ReleasePullResult> {
	const manifest = usableManifest(label, rawManifest);
	const files = vendoredFiles(label, manifest);
	const tlds = manifest.ontologies.map((o) => o.tld);
	const dropped = { fixtures: tlds.filter(isTestFixtureTld), excluded: tlds.filter(isExcludedTld) };

	mkdirSync(releaseDir, { recursive: true });
	const staging = mkdtempSync(join(dirname(releaseDir), '.release_pull_'));
	try {
		for (const file of files) await fetchFile({ ...file, targetDir: staging });
		// ontology.json sits next to the packages (the master's files route serves the IO dir).
		const infoUrl = new URL('ontology.json', files[0]?.url).href;
		await fetchFile({ url: infoUrl, name: 'ontology.json', targetDir: staging });
		await checkReleaseInfo(join(staging, 'ontology.json'), files, dropped);

		// Everything verified: mirror into the release dir.
		const incoming = new Set([...files.map((f) => f.name), 'ontology.json']);
		return {
			server: label,
			version: manifest.version,
			written: [...incoming].sort(),
			removed: mirrorInto(releaseDir, staging, incoming),
			warnings: pullWarnings(label, manifest, dropped),
		};
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
