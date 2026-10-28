/**
 * The install seed's PROVENANCE MANIFEST — install/db/dedalo_install.manifest.json,
 * written by the seed compiler (seed_build.ts) next to the seed it produced.
 *
 * It answers, for a committed seed, the three questions a binary blob cannot:
 *  - is this the file the compiler wrote? (`seed.sha256`)
 *  - was it compiled from the sources in this checkout? (`sources`: one sha256
 *    per source file — schema, migrations, ontology release, langs, registry,
 *    scaffold, the compiler's own three files — plus `engine_version` and
 *    `rules_digest`). HONEST LIMIT: the engine code the compile child runs
 *    (parser, ontology writers, record creation…) is NOT fingerprinted here —
 *    an edit there that changes the output is caught by seed_build_native's
 *    REPRODUCIBLE leg (a fresh compile's content digest vs this manifest), on
 *    the DB tier, not by the hermetic tripwire.
 *  - what does it contain? (`tables`: COPY rows per table; `seed.content_sha256`:
 *    the dump with pg_dump's per-run noise removed — equal across machines)
 * and records what proved it (`verified`: the fresh-install checks).
 *
 * Pure + file reads only (no database): install_seed_manifest_tripwire runs it
 * hermetically against the committed artefact.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { projectRoot } from '../../config/env.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../update/version.ts';
import {
	ONTOLOGY_RELEASE_DIR,
	SEED_LANGS_PATH,
	SEED_MIGRATIONS_DIR,
	SEED_ONTOLOGY_TLDS,
	SEED_RECORDS,
	SEED_REGISTRY_PATH,
	SEED_SCAFFOLD_PATH,
	SEED_SCHEMA_PATH,
	SEED_SHIPPED_TABLES,
} from './seed_sources.ts';

export const SEED_MANIFEST_FORMAT = 1;

export interface SeedManifest {
	format: number;
	engine_version: string;
	seed: {
		file: string;
		bytes: number;
		sha256: string;
		content_sha256: string;
		/** The pg_dump that wrote it: its header lines are part of the content. */
		pg_dump_version: string;
	};
	/** repo-relative path → sha256, every file the seed was compiled from. */
	sources: Record<string, string>;
	/** sha256 of the compiler's declared rules (records, TLD lists, shipped tables). */
	rules_digest: string;
	/** The ontology release the seed ships (ontology.json). */
	ontology_release: { version: string; date: string };
	/** COPY rows per table in the dump (tables with zero rows included). */
	tables: Record<string, number>;
	/** The fresh-install verification that proved this seed. */
	verified: { checks: string[] };
}

export function sha256Hex(bytes: Uint8Array | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
	return sha256Hex(await readFile(path));
}

const COMPILER_FILES = [
	'src/core/install/seed_build.ts',
	'src/core/install/seed_sources.ts',
	// The COPY section_id codec every staged matrix source passes through (cross-ops:r2).
	'src/core/install/copy_section_ids.ts',
	'scripts/seed_build_child.ts',
];

/**
 * Every file the seed is compiled from, repo-relative and sorted. A file
 * added here (a new migration) or changed makes the committed seed STALE.
 */
export function seedSourceFiles(): string[] {
	const absolute = [
		SEED_SCHEMA_PATH,
		SEED_SCAFFOLD_PATH,
		SEED_LANGS_PATH,
		SEED_REGISTRY_PATH,
		join(ONTOLOGY_RELEASE_DIR, 'ontology.json'),
		join(ONTOLOGY_RELEASE_DIR, 'matrix_dd.copy.gz'),
		...SEED_ONTOLOGY_TLDS.map((tld) => join(ONTOLOGY_RELEASE_DIR, `${tld}.copy.gz`)),
		...readdirSync(SEED_MIGRATIONS_DIR)
			.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
			.map((name) => join(SEED_MIGRATIONS_DIR, name)),
		...COMPILER_FILES.map((file) => join(projectRoot, file)),
	];
	return absolute.map((path) => relative(projectRoot, path)).sort();
}

/** sha256 per source file (a missing file is reported as such, not thrown). */
export async function seedSourceDigests(): Promise<Record<string, string>> {
	const digests: Record<string, string> = {};
	for (const file of seedSourceFiles()) {
		const path = join(projectRoot, file);
		digests[file] = existsSync(path) ? await sha256File(path) : 'MISSING';
	}
	return digests;
}

/** The compiler's declared rules, as one digest. */
export function seedRulesDigest(): string {
	return sha256Hex(
		JSON.stringify({
			records: SEED_RECORDS,
			ontology_tlds: SEED_ONTOLOGY_TLDS,
			shipped: SEED_SHIPPED_TABLES,
		}),
	);
}

/**
 * pg_dump's per-run noise: the random `\restrict` key (PG ≥ 17.6) and the
 * dated header/footer comments. Everything else is the seed's content.
 */
const DUMP_NOISE =
	/^(?:\\restrict .*|\\unrestrict .*|-- Dumped from database version .*|-- Dumped by pg_dump version .*|-- Started on .*|-- Completed on .*)$/;

/** sha256 of the dump text without pg_dump's per-run noise. */
export function seedContentDigest(dumpText: string): string {
	const lines = dumpText.split('\n').filter((line) => !DUMP_NOISE.test(line));
	return sha256Hex(lines.join('\n'));
}

/** COPY rows per table in a plain dump. */
export function copyRowCounts(dumpText: string): Record<string, number> {
	const counts: Record<string, number> = {};
	let table: string | null = null;
	for (const line of dumpText.split('\n')) {
		if (table === null) {
			const header = /^COPY public\.([a-z_0-9]+) \(/.exec(line);
			if (header !== null) {
				table = header[1] as string;
				counts[table] = 0;
			}
		} else if (line === '\\.') {
			table = null;
		} else {
			counts[table] = (counts[table] ?? 0) + 1;
		}
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** The plain-text dump inside a gzipped seed. */
export async function readSeedDump(seedPath: string): Promise<string> {
	return gunzipSync(await readFile(seedPath)).toString('utf8');
}

/** Build the manifest of a freshly compiled seed. */
export async function buildSeedManifest(input: {
	/** The file to fingerprint (the compiler's `.part`). */
	seedPath: string;
	/** Where it lands (recorded repo-relative). */
	seedFile: string;
	ontologyRelease: { version: string; date: string };
	verifiedChecks: string[];
}): Promise<SeedManifest> {
	const dump = await readSeedDump(input.seedPath);
	const bytes = await readFile(input.seedPath);
	return {
		format: SEED_MANIFEST_FORMAT,
		engine_version: formatVersion(DEDALO_DATA_VERSION),
		seed: {
			file: relative(projectRoot, input.seedFile),
			bytes: bytes.length,
			sha256: sha256Hex(bytes),
			content_sha256: seedContentDigest(dump),
			pg_dump_version: /^-- Dumped by pg_dump version (.*)$/m.exec(dump)?.[1] ?? 'unknown',
		},
		sources: await seedSourceDigests(),
		rules_digest: seedRulesDigest(),
		ontology_release: input.ontologyRelease,
		tables: copyRowCounts(dump),
		verified: { checks: input.verifiedChecks },
	};
}

/** Write the manifest atomically (`.part` → rename). */
export async function writeSeedManifest(manifest: SeedManifest, path: string): Promise<void> {
	const part = `${path}.part`;
	await writeFile(part, `${JSON.stringify(manifest, null, '\t')}\n`);
	await rename(part, path);
}

/** What the tripwire compares a manifest against: the committed seed + this checkout. */
export interface SeedObservation {
	seedSha256: string;
	contentSha256: string;
	tables: Record<string, number>;
	sources: Record<string, string>;
	rulesDigest: string;
	engineVersion: string;
}

export async function observeCommittedSeed(seedPath: string): Promise<SeedObservation> {
	const dump = await readSeedDump(seedPath);
	return {
		seedSha256: await sha256File(seedPath),
		contentSha256: seedContentDigest(dump),
		tables: copyRowCounts(dump),
		sources: await seedSourceDigests(),
		rulesDigest: seedRulesDigest(),
		engineVersion: formatVersion(DEDALO_DATA_VERSION),
	};
}

/**
 * Every way the manifest disagrees with the observation, one line each. Pure:
 * the tripwire plants a mutated manifest / observation to prove each line fires.
 */
export function manifestFindings(manifest: SeedManifest, observed: SeedObservation): string[] {
	return [
		...artefactFindings(manifest, observed),
		...sourceFindings(manifest.sources, observed.sources),
		...versionFindings(manifest, observed),
	];
}

/** The seed file itself: the one written, with the content and rows recorded. */
function artefactFindings(manifest: SeedManifest, observed: SeedObservation): string[] {
	const findings: string[] = [];
	if (manifest.format !== SEED_MANIFEST_FORMAT) findings.push(`manifest format ${manifest.format}`);
	if (manifest.seed.sha256 !== observed.seedSha256) {
		findings.push('the seed file is not the one the compiler wrote (sha256 differs)');
	}
	if (manifest.seed.content_sha256 !== observed.contentSha256) {
		findings.push('the seed content differs from the manifest (content_sha256)');
	}
	if (JSON.stringify(manifest.tables) !== JSON.stringify(observed.tables)) {
		findings.push('the seed row counts differ from the manifest');
	}
	return findings;
}

/** Every source: present in both, with the same digest — else the seed is STALE. */
function sourceFindings(
	declared: Record<string, string>,
	current: Record<string, string>,
): string[] {
	const findings: string[] = [];
	for (const file of Object.keys(current).filter((name) => !(name in declared))) {
		findings.push(`STALE: source ${file} is newer than the seed (not in the manifest)`);
	}
	for (const file of Object.keys(declared).filter((name) => !(name in current))) {
		findings.push(`STALE: source ${file} is gone`);
	}
	for (const file of Object.keys(current).filter((name) => name in declared)) {
		if (declared[file] !== current[file]) {
			findings.push(`STALE: source ${file} changed since the seed was compiled`);
		}
	}
	return findings.sort();
}

/** The compiler's rules and the engine version the seed was compiled for. */
function versionFindings(manifest: SeedManifest, observed: SeedObservation): string[] {
	const findings: string[] = [];
	if (manifest.rules_digest !== observed.rulesDigest) {
		findings.push('STALE: the compiler rules changed since the seed was compiled');
	}
	if (manifest.engine_version !== observed.engineVersion) {
		findings.push(
			`STALE: compiled for ${manifest.engine_version}, engine is ${observed.engineVersion}`,
		);
	}
	return findings;
}
