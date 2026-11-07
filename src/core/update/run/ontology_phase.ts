/**
 * THE RUN'S ONTOLOGY PHASE (update audit 2026-10-29, design §5; owner
 * decisions D-3, D-6, D-8).
 *
 * The run decides the request itself — no browser relays it: for every
 * configured source (this install's own export when it IS the ontology master
 * with no provider entry; else each entry — an ontology master's entries with
 * `tlds` are PROMOTION sources, usable only for the TLDs they list; entries
 * without are code-only and no source), the files are that source's manifest
 * entries for the shared TLDs this install updates —
 *
 *   ACTIVE_ONTOLOGY_TLDS ∩ admissible (never a local TLD, never localontology0)
 *   ∩ the source's own `tlds` (D-8; a single undeclared source serves them all)
 *   + matrix_dd (the shared value lists), from the source that declares it
 *
 * — and each goes through the one ontology update door (ontology_update.ts
 * updateOntology), which re-checks scope, source assignment, the data model
 * and the file digests server-side. The run REQUIRES those digests: a source
 * whose manifest publishes none for a selected file is refused before the door
 * (the panel's manual door may still stage such a file, logged UNVERIFIED — an
 * unattended run never does; review 2026-10-30 #14). A step with `min` (an
 * ontology precondition of the release) also requires the source's version ≥ min.
 *
 * Seams: the catalog, the active TLDs, the manifest reader and the door.
 */

import { join } from 'node:path';
import { config } from '../../../config/config.ts';
import type { ManifestResult } from '../../ontology/ontology_manifest.ts';
import {
	fetchOntologyManifest,
	readLocalOntologyManifest,
} from '../../ontology/ontology_manifest.ts';
import { admissibleUpdateTlds, updateOntology } from '../../ontology/ontology_update.ts';
import { unattendedSources } from '../../ontology/ontology_update_source.ts';
import {
	findConfiguredServer,
	type OntologyUpdateCatalog,
	pullServers,
} from '../../ontology/ontology_update_target.ts';
import type { ReleaseStep } from '../catalog_file.ts';
import {
	compareVersionArrays,
	DEDALO_VERSION_MAJOR_MINOR,
	parseVersionString,
} from '../version.ts';
import type { PhaseResult } from './executor.ts';
import type { RunJournal } from './journal.ts';

/** One source the phase updates from: the update door's `server` shape. */
interface OntologySource {
	server: { name: string; url: string; code: string };
	/** The shared TLDs declared for it (D-8); undefined = undeclared. */
	tlds: readonly string[] | undefined;
}

export interface OntologyPhaseDeps {
	catalog?: OntologyUpdateCatalog;
	/**
	 * The step is a release's DEFAULT ontology step (the release declared no
	 * steps) inside a code run: with no ontology source configured it is skipped,
	 * recorded — the install never received ontology updates, and a code update
	 * must not fail on that (docs review 2026-10-30). A declared step, or the
	 * panel's ontology-only run, still fails without a source.
	 */
	sourceOptional?: boolean;
	/**
	 * The run's narrowing (RunJournal.ontology_scope). Unattended, matrix_dd is
	 * never narrowed away; with a `source` (the panel's pick) it IS the selection.
	 */
	scope?: readonly string[];
	/**
	 * The master the OPERATOR picked (RunJournal.ontology_source): its configured
	 * url, or `localhost` (this master's own export). The run then takes the
	 * scope's TLDs from that one source — any TLD it lists, no D-8 map, no
	 * ACTIVE_ONTOLOGY_TLDS boundary (ontology_update.ts assertUpdateTldScope).
	 */
	source?: string;
	activeTlds?: readonly string[];
	readManifest?: (
		source: OntologySource,
		catalog: OntologyUpdateCatalog,
	) => Promise<ManifestResult>;
	update?: (
		options: unknown,
		userId: number,
		doorDeps?: { operatorPicked?: boolean },
	) => Promise<{
		ok: boolean;
		msg: string;
		errors: string[];
		root_info?: unknown;
		/** What the import removes / re-models (U-14; report only). */
		census?: unknown;
	}>;
}

/**
 * This install's sources. An ontology server with NO provider (no
 * ONTOLOGY_SERVERS entry with `tlds` — entries without them are CODE-ONLY: an
 * accepted access code, never a source) updates from its own export
 * (localhost), as it always did. With providers it PROMOTES from them — only
 * the TLDs each lists, one source per TLD; its own authored TLDs that no
 * provider lists are untouched, so its own export is no source then. Anything
 * else: the configured servers.
 */
function sourcesOf(catalog: OntologyUpdateCatalog): OntologySource[] {
	const providers = pullServers(catalog);
	if (catalog.isOntologyServer && providers.length === 0) {
		return [
			{
				server: { name: 'localhost', url: 'http://localhost/', code: 'localhost' },
				tlds: undefined,
			},
		];
	}
	// unattended: the declaring providers, else the first (an ordinary install)
	return unattendedSources(providers).map((entry) => ({
		server: { name: entry.url, url: entry.url, code: entry.code },
		tlds: entry.tlds,
	}));
}

/** The operator's pick as a source; null = no longer configured. */
function pickedSource(source: string, catalog: OntologyUpdateCatalog): OntologySource | null {
	if (source === 'localhost')
		return catalog.isOntologyServer ? (sourcesOf(catalog)[0] ?? null) : null;
	// a pick is a pull source: an ontology server's code-only entries are not
	const entry = findConfiguredServer({ ...catalog, servers: pullServers(catalog) }, source);
	return entry === undefined
		? null
		: { server: { name: entry.url, url: entry.url, code: entry.code }, tlds: undefined };
}

async function defaultReadManifest(
	source: OntologySource,
	catalog: OntologyUpdateCatalog,
): Promise<ManifestResult> {
	if (source.server.code === 'localhost') {
		return readLocalOntologyManifest(
			join(config.ops.ontologyDataIoDir, DEDALO_VERSION_MAJOR_MINOR),
		);
	}
	return fetchOntologyManifest(source.server, pullServers(catalog));
}

/** The files this source serves for this install (see the header). */
export function filesFor(
	source: OntologySource,
	manifest: Extract<ManifestResult, { ok: true }>,
	activeTlds: readonly string[],
): { tld: string; url: string }[] {
	const admissible = admissibleUpdateTlds(activeTlds);
	const declared = (tld: string) => source.tlds === undefined || source.tlds.includes(tld);
	const ontologies = manifest.ontologies
		.filter((entry) => admissible.has(entry.tld) && declared(entry.tld))
		.map((entry) => ({ tld: entry.tld, url: entry.url }));
	const lists =
		manifest.matrixDdUrl !== null && declared('matrix_dd')
			? [{ tld: 'matrix_dd', url: manifest.matrixDdUrl }]
			: [];
	return [...ontologies, ...lists];
}

/** The selected files whose manifest entry carries no sha256 (an unattended run imports none of them). */
export function undigested(
	files: readonly { tld: string }[],
	manifest: Extract<ManifestResult, { ok: true }>,
): string[] {
	const digestOf = (tld: string) =>
		tld === 'matrix_dd'
			? manifest.matrixDdSha256
			: manifest.ontologies.find((entry) => entry.tld === tld)?.sha256;
	return files.map((file) => file.tld).filter((tld) => digestOf(tld) === undefined);
}

/** What refuses a source before the door: the step's `min`, then an undigested file (#14). */
function beforeTheDoor(
	step: ReleaseStep,
	manifest: Extract<ManifestResult, { ok: true }>,
	files: readonly { tld: string }[],
): string | null {
	const short = belowMin(step, manifest.version);
	if (short !== null) return short;
	const unverifiable = undigested(files, manifest);
	return unverifiable.length === 0
		? null
		: `the source publishes no file digest for ${unverifiable.join(', ')} — re-export it on the master`;
}

/** Below the step's `min` (an ontology precondition), or null when it is met / not declared. */
function belowMin(step: ReleaseStep, version: string | null): string | null {
	if (step.min === undefined) return null;
	const met =
		version !== null &&
		compareVersionArrays(parseVersionString(version), parseVersionString(step.min)) >= 0;
	return met
		? null
		: `the source offers ontology ${version ?? 'of no version'}, this release needs ${step.min} first`;
}

/** Update from one source; its evidence line. */
async function updateFrom(
	source: OntologySource,
	step: ReleaseStep,
	userId: number,
	deps: ResolvedDeps,
): Promise<Record<string, unknown>> {
	const manifest = await deps.readManifest(source, deps.catalog);
	if (!manifest.ok)
		return { source: source.server.url, succeeded: false, problems: [manifest.reason] };
	const files = selectedFiles(source, manifest, deps);
	const problem = beforeTheDoor(step, manifest, files);
	if (problem !== null) return { source: source.server.url, succeeded: false, problems: [problem] };
	if (files.length === 0)
		return { source: source.server.url, succeeded: true, skipped: 'nothing to update' };
	const response = await deps.update({ server: source.server, files }, userId, doorDepsOf(deps));
	return {
		source: source.server.url,
		version: manifest.version,
		tlds: files.map((file) => file.tld),
		succeeded: response.ok,
		problems: response.errors,
		// the door's own operator sentence and dd1 read-back (the panel shows them)
		msg: response.msg,
		...(response.root_info === undefined ? {} : { root_info: response.root_info }),
		...(response.census === undefined ? {} : { census: response.census }),
	};
}

/**
 * The files to take from this source. A pick: exactly the scope's TLDs the
 * manifest lists (matrix_dd only when selected). Unattended: {@link filesFor},
 * narrowed by the scope, matrix_dd never narrowed away.
 */
function selectedFiles(
	source: OntologySource,
	manifest: Extract<ManifestResult, { ok: true }>,
	deps: ResolvedDeps,
): { tld: string; url: string }[] {
	const scope = deps.scope;
	if (deps.source !== undefined && scope !== undefined) {
		const ontologies = manifest.ontologies
			.filter((entry) => scope.includes(entry.tld))
			.map((entry) => ({ tld: entry.tld, url: entry.url }));
		const lists =
			manifest.matrixDdUrl !== null && scope.includes('matrix_dd')
				? [{ tld: 'matrix_dd', url: manifest.matrixDdUrl }]
				: [];
		return [...lists, ...ontologies];
	}
	return filesFor(source, manifest, deps.activeTlds).filter(
		(file) => scope === undefined || file.tld === 'matrix_dd' || scope.includes(file.tld),
	);
}

/** The door's mode: an operator's pick, or the unattended run. */
function doorDepsOf(deps: ResolvedDeps): { operatorPicked?: boolean } {
	return deps.source === undefined ? {} : { operatorPicked: true };
}

/** One failed source, for the run's note: where, and the door's own sentences. */
function failureLine(line: Record<string, unknown>): string {
	const problems = Array.isArray(line.problems) ? line.problems.map(String) : [];
	return `${String(line.source)}: ${[line.msg, ...problems].filter(Boolean).join(' — ')}`;
}

type ResolvedDeps = Required<Omit<OntologyPhaseDeps, 'scope' | 'source' | 'sourceOptional'>> &
	Pick<OntologyPhaseDeps, 'scope' | 'source'>;

/** The run's scope and pick, each only when set (absent ≠ undefined). */
function narrowingOf(deps: OntologyPhaseDeps): Pick<OntologyPhaseDeps, 'scope' | 'source'> {
	return {
		...(deps.scope === undefined ? {} : { scope: deps.scope }),
		...(deps.source === undefined ? {} : { source: deps.source }),
	};
}

function resolvedDeps(deps: OntologyPhaseDeps): ResolvedDeps {
	return {
		...narrowingOf(deps),
		catalog: deps.catalog ?? config.ontologyIo,
		activeTlds: deps.activeTlds ?? config.ontologyIo.activeOntologyTlds,
		readManifest: deps.readManifest ?? defaultReadManifest,
		update: deps.update ?? updateOntology,
	};
}

/** The operator's pick: that one master, or a failed phase when it is no longer configured. */
async function runPickedPhase(
	source: string,
	step: ReleaseStep,
	userId: number,
	resolved: ResolvedDeps,
): Promise<PhaseResult> {
	const picked = pickedSource(source, resolved.catalog);
	if (picked === null) {
		return {
			outcome: 'failed',
			evidence: { summary: 'the picked ontology master is no longer configured on this instance' },
		};
	}
	const line = await updateFrom(picked, step, userId, resolved);
	return line.succeeded === true
		? { outcome: 'ok', evidence: { sources: [line] } }
		: { outcome: 'failed', evidence: { sources: [line], summary: failureLine(line) } };
}

/** The phase: the operator's pick, else every unattended source in catalog order; failed when any failed. */
export async function runOntologyPhase(
	step: ReleaseStep,
	userId: number,
	deps: OntologyPhaseDeps = {},
): Promise<PhaseResult> {
	const resolved = resolvedDeps(deps);
	const sources: Record<string, unknown>[] = [];
	if (resolved.source !== undefined) return runPickedPhase(resolved.source, step, userId, resolved);
	for (const source of sourcesOf(resolved.catalog)) {
		sources.push(await updateFrom(source, step, userId, resolved));
	}
	if (sources.length === 0) {
		const summary = 'no ontology source is configured';
		if (deps.sourceOptional === true) return { outcome: 'ok', evidence: { skipped: summary } };
		return { outcome: 'failed', evidence: { summary } };
	}
	const failed = sources.filter((line) => line.succeeded !== true);
	if (failed.length === 0) return { outcome: 'ok', evidence: { sources } };
	return { outcome: 'failed', evidence: { sources, summary: failed.map(failureLine).join('; ') } };
}

/**
 * What the panel shows for a CONFIRMED ontology-only run: each source's door
 * sentence, the problems it reported (warnings of a successful import), and the
 * last dd1 read-back.
 */
export function ontologyRunAnswer(journal: RunJournal): {
	msg: string;
	errors: string[];
	rootInfo: unknown;
	/** Every source's import census, flattened (U-14; WC-2026-10-30-ontology-import-census-restore); null when none reported one. */
	census: unknown[] | null;
} {
	const phase = journal.phases.filter((record) => record.step.kind === 'ontology').at(-1);
	const lines = Array.isArray(phase?.evidence.sources)
		? (phase.evidence.sources as Record<string, unknown>[])
		: [];
	return {
		msg: lines.map((line) => String(line.msg ?? line.skipped ?? '')).join('\n') || 'OK',
		errors: lines.flatMap((line) =>
			Array.isArray(line.problems) ? line.problems.map(String) : [],
		),
		rootInfo: lines.filter((line) => line.root_info !== undefined).at(-1)?.root_info ?? null,
		census: censusOf(lines),
	};
}

function censusOf(lines: Record<string, unknown>[]): unknown[] | null {
	const reported = lines.filter((line) => Array.isArray(line.census));
	return reported.length === 0 ? null : reported.flatMap((line) => line.census as unknown[]);
}
