/**
 * THE UPDATE DEFINITION FILE — `install/update/catalog.json` (update audit
 * 2026-10-29, owner decision D-7: the update definition is a JSON file, not
 * code). This module reads and validates it and turns each release into the
 * engine's descriptor shape (catalog.ts UpdateDescriptor), so the data engine,
 * the manifest walk and the wire serializer keep one input. catalog.ts keeps
 * the atomic-contract validator, the matcher and the serializer; the RELEASES
 * live in the file.
 *
 *   {
 *     "format": 1,
 *     "releases": {
 *       "7.0.1": {},                                  // code only, default steps
 *       "7.1.0": {
 *         "compat": "incompatible",
 *         "steps": [
 *           { "kind": "code" },
 *           { "kind": "schema" },
 *           { "kind": "data",
 *             "sql": ["7.1.0/01_rename.sql"],         // files under install/update/
 *             "scripts": [{ "id": "…", "info": "…", "stop_on_error": true }],
 *             "order": ["sql", "scripts"] },
 *           { "kind": "ancillary" }
 *         ]
 *       }
 *     }
 *   }
 *
 * RULES (refused at load, so a bad file never ships — update_catalog_json_tripwire):
 *  - releases are a LINEAR walk: each key is the next rung (major/minor/patch)
 *    of the previous one, the first the next rung of the line start. A data
 *    release's `from` is the previous DATA release (or the line start) —
 *    derived, never hand-written, so it cannot drift.
 *  - `steps` (when declared) carries `code` exactly once; `ontology` at most
 *    twice — one with `min` (a precondition, BEFORE code) and one without
 *    (after code); every other kind at most once.
 *  - `compat` (D-4): required when a release declares a schema, data or
 *    ontology step, forbidden otherwise. `incompatible` (an SQL schema or data
 *    change: crossing it needs a human restore, D-2) only on a minor or major
 *    release; a `data` step is always `incompatible`. `compatible` (an index,
 *    an ontology change with no schema/data impact) may ride a patch.
 *  - `ontology.min` names an earlier release of the catalog on the SAME data
 *    model (no incompatible release strictly between it and this one).
 *  - SQL lives in files `install/update/<this release>/<name>.sql`, one
 *    statement each (the atomic contract of catalog.ts applies to its text).
 *
 * A declared `ontology` step executes (run/ontology_phase.ts, since
 * 2026-10-30). A kind declared before its executor exists is refused loudly as
 * uncovered scope (UNCOVERED_STEPS — empty today), never silently skipped.
 *
 * Today only a `data` step moves the data version (dataVersionOf). The
 * `compatible` ontology step that will move it on a patch arrives with the run
 * that can execute and stamp it.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
// STATIC on purpose: the shipped file is part of the module graph, so `bun
// --watch` (the museum-cycle probe's master) reloads on an edit, and a tree
// without it fails at import — never an empty catalog.
import SHIPPED_CATALOG from '../../../install/update/catalog.json';
import { projectRoot } from '../../config/env.ts';
import type {
	DescriptorViolation,
	UpdateDescriptor,
	UpdateScriptStep,
	UpdateStepKind,
} from './catalog.ts';
import { compareVersionArrays, DATA_LINE_START } from './version.ts';
import { nextRungKind } from './version_walk.ts';

/** The directory holding catalog.json and the per-release SQL files. */
export const UPDATE_CATALOG_DIR: string = join(projectRoot, 'install/update');

/**
 * Every `.sql` file shipped under the catalog directory, relative to it, sorted
 * — the one enumeration the catalog gate compares the file's references with
 * (update_catalog_json_tripwire: no orphan, no dangling path).
 */
export function shippedCatalogSqlFiles(dir: string = UPDATE_CATALOG_DIR): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, encoding: 'utf8' })
		.filter((path) => path.endsWith('.sql'))
		.map((path) => relative(dir, join(dir, path)))
		.sort();
}

/** The file format this engine reads. */
export const CATALOG_FILE_FORMAT = 1;

/** The phases a release may order (owner decision D-1). */
export type ReleaseStepKind = 'code' | 'ontology' | 'schema' | 'data' | 'ancillary';

/** D-4: whether crossing the release keeps the data model. */
export type ReleaseCompat = 'compatible' | 'incompatible';

/** One declared step, as the file spells it (validated). */
export interface ReleaseStep {
	kind: ReleaseStepKind;
	/** ontology only: the minimum installed ontology/data version this release needs first. */
	min?: string;
	/** data only: SQL file paths relative to install/update/. */
	sql?: readonly string[];
	/** data only: registered scripts. */
	scripts?: readonly { id: string; info: string; stop_on_error: boolean; vars?: unknown[] }[];
	/** data only: the order of the two lists (default sql → scripts). */
	order?: readonly ('sql' | 'scripts')[];
}

/** One release of the file, as the update run will read it. */
export interface ReleasePlan {
	version: string;
	compat: ReleaseCompat | null;
	/** The declared steps, or the default order when the release declares none. */
	steps: readonly ReleaseStep[];
	declared: boolean;
}

/** What a release runs when it declares no steps (D-1 default order; data only when declared). */
export const DEFAULT_RELEASE_STEPS: readonly ReleaseStep[] = Object.freeze([
	{ kind: 'code' },
	{ kind: 'ontology' },
	{ kind: 'schema' },
	{ kind: 'ancillary' },
]);

/** The parsed file: the engine's descriptors, the run's plans, and every violation. */
export interface ParsedCatalogFile {
	descriptors: Record<string, UpdateDescriptor>;
	plans: Record<string, ReleasePlan>;
	violations: DescriptorViolation[];
}

const STEP_KINDS: ReadonlySet<string> = new Set<ReleaseStepKind>([
	'code',
	'ontology',
	'schema',
	'data',
	'ancillary',
]);
const RELEASE_KEYS: ReadonlySet<string> = new Set(['compat', 'steps']);
const STEP_KEYS: Readonly<Record<ReleaseStepKind, readonly string[]>> = {
	code: ['kind'],
	ontology: ['kind', 'min'],
	schema: ['kind'],
	data: ['kind', 'sql', 'scripts', 'order'],
	ancillary: ['kind'],
};
const SCRIPT_KEYS: ReadonlySet<string> = new Set(['id', 'info', 'stop_on_error', 'vars']);
const VERSION_KEY = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SQL_FILE = /^[a-z0-9][a-z0-9_]*\.sql$/;

/**
 * Kinds whose executor does not exist yet — refused as uncovered scope, with the
 * reason. EMPTY since 2026-10-30: the ontology step runs (run/ontology_phase.ts,
 * its `min` checked against the source's version). The door stays for the next
 * kind that is declared before its executor lands.
 */
const UNCOVERED_STEPS: Readonly<Partial<Record<ReleaseStepKind, string>>> = {};

function violation(where: string, rule: string, detail: string): DescriptorViolation {
	return { rule, code: 'update.refused', detail: `${where}: ${detail}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tripleOf(key: string): number[] {
	return key.split('.').map(Number);
}

/** The keys of `record` outside `allowed`, as violations. */
function unknownKeys(
	where: string,
	record: Record<string, unknown>,
	allowed: ReadonlySet<string> | readonly string[],
): DescriptorViolation[] {
	const known = allowed instanceof Set ? allowed : new Set(allowed);
	return Object.keys(record)
		.filter((name) => !known.has(name))
		.map((name) => violation(where, 'unknown_key', `unknown key '${name}'`));
}

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

/** Every key a valid dotted triple, each the next rung of the one before (the first of the line start). */
function walkViolations(
	keys: readonly string[],
	lineStart: readonly number[],
): DescriptorViolation[] {
	const found: DescriptorViolation[] = [];
	let previous: readonly number[] = lineStart;
	for (const key of keys) {
		if (!VERSION_KEY.test(key)) {
			found.push(violation(key, 'release_key', 'a release key is a dotted triple (7.0.1)'));
			continue;
		}
		const triple = tripleOf(key);
		if (nextRungKind(previous, triple) === null) {
			found.push(
				violation(
					key,
					'release_walk',
					`not the next rung after ${previous.join('.')} — releases are listed in order, none skipped`,
				),
			);
		}
		previous = triple;
	}
	return found;
}

// ---------------------------------------------------------------------------
// one step
// ---------------------------------------------------------------------------

/** `found` when `cond`, else none — keeps each rule a flat line. */
function onlyIf(cond: boolean, ...found: DescriptorViolation[]): DescriptorViolation[] {
	return cond ? found : [];
}

function scriptShapeOk(script: Record<string, unknown>): boolean {
	return (
		typeof script.id === 'string' &&
		typeof script.info === 'string' &&
		typeof script.stop_on_error === 'boolean' &&
		(script.vars === undefined || Array.isArray(script.vars))
	);
}

function oneScriptViolations(at: string, script: unknown): DescriptorViolation[] {
	if (!isRecord(script)) return [violation(at, 'data_scripts', 'a script is an object')];
	return [
		...unknownKeys(at, script, SCRIPT_KEYS),
		...onlyIf(
			!scriptShapeOk(script),
			violation(
				at,
				'data_scripts',
				'a script carries id, info, stop_on_error (and optional vars[])',
			),
		),
	];
}

function scriptViolations(where: string, scripts: unknown): DescriptorViolation[] {
	if (scripts === undefined) return [];
	if (!Array.isArray(scripts))
		return [violation(where, 'data_scripts', 'scripts must be an array')];
	return scripts.flatMap((script, index) =>
		oneScriptViolations(`${where}.scripts[${index}]`, script),
	);
}

function sqlPathViolations(where: string, release: string, sql: unknown): DescriptorViolation[] {
	if (sql === undefined) return [];
	if (!Array.isArray(sql))
		return [violation(where, 'data_sql', 'sql must be an array of file paths')];
	return sql.flatMap((path, index) => {
		const [dir, name, ...rest] = typeof path === 'string' ? path.split('/') : [];
		const ok = dir === release && name !== undefined && SQL_FILE.test(name) && rest.length === 0;
		return ok
			? []
			: [
					violation(
						`${where}.sql[${index}]`,
						'data_sql_path',
						`'${String(path)}' is not '${release}/<name>.sql' — a release's SQL lives in its own directory`,
					),
				];
	});
}

function orderViolations(where: string, step: Record<string, unknown>): DescriptorViolation[] {
	const order = step.order;
	if (order === undefined) return [];
	const present = (['sql', 'scripts'] as const).filter((list) => step[list] !== undefined);
	const valid =
		Array.isArray(order) &&
		order.length === present.length &&
		new Set(order).size === order.length &&
		order.every((entry) => present.includes(entry));
	return valid
		? []
		: [
				violation(
					where,
					'data_order',
					`order must list exactly the lists the step carries (${present.join(', ')})`,
				),
			];
}

function dataStepViolations(
	where: string,
	release: string,
	step: Record<string, unknown>,
): DescriptorViolation[] {
	const count =
		(Array.isArray(step.sql) ? step.sql.length : 0) +
		(Array.isArray(step.scripts) ? step.scripts.length : 0);
	return [
		...sqlPathViolations(where, release, step.sql),
		...scriptViolations(where, step.scripts),
		...orderViolations(where, step),
		...(count === 0
			? [
					violation(
						where,
						'data_without_steps',
						'a data step carries no sql and no scripts: it would change nothing',
					),
				]
			: []),
	];
}

/** ontology.min, when present, is a dotted version — never a date (D-4). */
function minFormatViolations(where: string, step: Record<string, unknown>): DescriptorViolation[] {
	return onlyIf(
		step.min !== undefined && !VERSION_KEY.test(String(step.min)),
		violation(where, 'ontology_min', 'min is a dotted version (7.0.4), never a date'),
	);
}

/** A kind whose executor does not exist yet: uncovered scope, said loudly. */
function uncoveredViolations(where: string, kind: ReleaseStepKind): DescriptorViolation[] {
	const uncovered = UNCOVERED_STEPS[kind];
	return uncovered === undefined
		? []
		: [{ rule: `${kind}_step`, code: 'engine.uncovered_scope', detail: `${where}: ${uncovered}` }];
}

function stepViolations(where: string, release: string, step: unknown): DescriptorViolation[] {
	if (!isRecord(step)) return [violation(where, 'step_shape', 'a step is an object')];
	const kind = String(step.kind);
	if (!STEP_KINDS.has(kind)) return [violation(where, 'step_kind', `unknown step kind '${kind}'`)];
	const typed = kind as ReleaseStepKind;
	return [
		...unknownKeys(where, step, STEP_KEYS[typed]),
		...(typed === 'data' ? dataStepViolations(where, release, step) : []),
		...minFormatViolations(where, step),
		...uncoveredViolations(where, typed),
	];
}

// ---------------------------------------------------------------------------
// one release
// ---------------------------------------------------------------------------

function countOf(steps: readonly ReleaseStep[], match: (step: ReleaseStep) => boolean): number {
	return steps.filter(match).length;
}

/** Every kind but ontology at most once, code exactly once. */
function stepCountViolations(where: string, steps: readonly ReleaseStep[]): DescriptorViolation[] {
	const twice = [...STEP_KINDS].filter(
		(kind) =>
			kind !== 'code' && kind !== 'ontology' && countOf(steps, (step) => step.kind === kind) > 1,
	);
	return [
		...onlyIf(
			countOf(steps, (step) => step.kind === 'code') !== 1,
			violation(where, 'code_step', 'declared steps carry the code step exactly once'),
		),
		...twice.map((kind) => violation(where, 'step_twice', `the ${kind} step is declared twice`)),
	];
}

/** An ontology step with min (a precondition) comes BEFORE code; one without, after; one of each at most. */
function ontologyPlacementViolations(
	where: string,
	steps: readonly ReleaseStep[],
): DescriptorViolation[] {
	const codeAt = steps.findIndex((step) => step.kind === 'code');
	const misplaced = steps.filter(
		(step, index) => step.kind === 'ontology' && (step.min !== undefined) !== index < codeAt,
	);
	const pre = countOf(steps, (step) => step.kind === 'ontology' && step.min !== undefined);
	const post = countOf(steps, (step) => step.kind === 'ontology' && step.min === undefined);
	return [
		...misplaced.map((step) =>
			violation(
				where,
				'ontology_placement',
				step.min !== undefined
					? 'an ontology step with min is a precondition: it comes BEFORE code'
					: 'an ontology step without min comes AFTER code',
			),
		),
		...onlyIf(
			Math.max(pre, post) > 1,
			violation(where, 'step_twice', 'at most one ontology precondition and one ontology step'),
		),
	];
}

/**
 * Only an ontology precondition may precede code: the planner (plan.ts
 * splitAtCode) runs every other step AFTER the swap, so a schema/data/ancillary
 * step declared before code would vanish from the plan silently (review
 * 2026-10-30 (4) #8) — refused here instead.
 */
function preCodeViolations(where: string, steps: readonly ReleaseStep[]): DescriptorViolation[] {
	const codeAt = steps.findIndex((step) => step.kind === 'code');
	return steps
		.slice(0, Math.max(codeAt, 0))
		.filter((step) => step.kind !== 'ontology')
		.map((step) =>
			violation(
				where,
				'step_placement',
				`a ${step.kind} step comes AFTER code (only an ontology precondition precedes it)`,
			),
		);
}

/** code exactly once; ontology ≤ 2 (min before code, plain after); others ≤ 1, after code. */
function stepSetViolations(where: string, steps: readonly ReleaseStep[]): DescriptorViolation[] {
	return [
		...stepCountViolations(where, steps),
		...ontologyPlacementViolations(where, steps),
		...preCodeViolations(where, steps),
	];
}

/** Whether the release declares a step that touches the data model (schema, data, ontology). */
function touchesModel(steps: readonly ReleaseStep[] | null): boolean {
	return (steps ?? []).some((step) => step.kind !== 'code' && step.kind !== 'ancillary');
}

/** incompatible never on a patch; a data step never compatible. */
function compatPlacementViolations(
	where: string,
	triple: readonly number[],
	compat: ReleaseCompat,
	steps: readonly ReleaseStep[] | null,
): DescriptorViolation[] {
	const hasData = (steps ?? []).some((step) => step.kind === 'data');
	return [
		...onlyIf(
			compat === 'incompatible' && triple[2] !== 0,
			violation(
				where,
				'incompatible_on_patch',
				'an incompatible change (SQL schema or data) belongs to a minor or major release, never a patch',
			),
		),
		...onlyIf(
			compat === 'compatible' && hasData,
			violation(
				where,
				'data_is_incompatible',
				'a data step changes the data model: compat is incompatible',
			),
		),
	];
}

/** D-4: compat declared iff schema/data/ontology; data ⇒ incompatible; incompatible ⇒ minor/major. */
function compatViolations(
	where: string,
	triple: readonly number[],
	compat: unknown,
	steps: readonly ReleaseStep[] | null,
): DescriptorViolation[] {
	const model = touchesModel(steps);
	if (compat === undefined) {
		return onlyIf(
			model,
			violation(
				where,
				'compat_missing',
				'a release with a schema, data or ontology step declares compat',
			),
		);
	}
	if (compat !== 'compatible' && compat !== 'incompatible') {
		return [violation(where, 'compat_value', "compat is 'compatible' or 'incompatible'")];
	}
	if (!model) {
		return [
			violation(
				where,
				'compat_without_steps',
				'compat is declared only by a release with a schema, data or ontology step',
			),
		];
	}
	return compatPlacementViolations(where, triple, compat, steps);
}

/** ontology.min: an earlier release of this catalog on the same data model. */
function minViolations(
	where: string,
	key: string,
	steps: readonly ReleaseStep[] | null,
	compatOf: ReadonlyMap<string, unknown>,
): DescriptorViolation[] {
	const keys = [...compatOf.keys()];
	return (steps ?? []).flatMap((step) => {
		if (step.min === undefined || !VERSION_KEY.test(step.min)) return [];
		const at = keys.indexOf(step.min);
		const self = keys.indexOf(key);
		if (at === -1 || at >= self) {
			return [
				violation(
					where,
					'ontology_min',
					`min ${step.min} is not an earlier release of this catalog`,
				),
			];
		}
		const crossed = keys
			.slice(at + 1, self)
			.filter((between) => compatOf.get(between) === 'incompatible');
		return crossed.length === 0
			? []
			: [
					violation(
						where,
						'ontology_min',
						`min ${step.min} is on another data model (crosses ${crossed.join(', ')})`,
					),
				];
	});
}

// ---------------------------------------------------------------------------
// the file → descriptors + plans
// ---------------------------------------------------------------------------

function engineScript(script: NonNullable<ReleaseStep['scripts']>[number]): UpdateScriptStep {
	return {
		info: script.info,
		scriptId: script.id,
		stopOnError: script.stop_on_error,
		...(script.vars === undefined ? {} : { scriptVars: script.vars }),
	};
}

/** The engine descriptor of one valid release. `from` = the previous data release. */
function descriptorOf(
	key: string,
	from: readonly number[],
	data: ReleaseStep | undefined,
	readSql: (path: string) => string,
): UpdateDescriptor {
	const [versionMajor = 0, versionMedium = 0, versionMinor = 0] = tripleOf(key);
	const [updateFromMajor = 0, updateFromMedium = 0, updateFromMinor = 0] = from;
	const version = {
		versionMajor,
		versionMedium,
		versionMinor,
		updateFromMajor,
		updateFromMedium,
		updateFromMinor,
	};
	if (data === undefined) return { ...version, updateData: false };
	const order = data.order?.map(
		(list): UpdateStepKind => (list === 'sql' ? 'SQL_update' : 'run_scripts'),
	);
	return {
		...version,
		updateData: true,
		...(data.sql === undefined ? {} : { sqlUpdate: data.sql.map(readSql) }),
		...(data.scripts === undefined ? {} : { runScripts: data.scripts.map(engineScript) }),
		...(order === undefined ? {} : { executionOrder: order }),
	};
}

/** The release's declared steps, when they are a list of objects (each validated on its own). */
function declaredSteps(release: unknown): ReleaseStep[] | null {
	// A non-object release is a `release_shape` violation already: no steps, never a TypeError.
	if (!isRecord(release)) return null;
	const steps = release.steps;
	return Array.isArray(steps) && steps.every(isRecord) ? (steps as unknown as ReleaseStep[]) : null;
}

/** steps, when declared, is a non-empty array of steps, each valid on its own. */
function stepListViolations(key: string, steps: unknown): DescriptorViolation[] {
	if (steps === undefined) return [];
	if (!Array.isArray(steps) || steps.length === 0) {
		return [violation(key, 'steps_shape', 'steps, when declared, is a non-empty array')];
	}
	return steps.flatMap((step, index) => stepViolations(`${key}.steps[${index}]`, key, step));
}

function releaseViolations(
	key: string,
	release: unknown,
	compatOf: ReadonlyMap<string, unknown>,
): DescriptorViolation[] {
	if (!isRecord(release)) return [violation(key, 'release_shape', 'a release is an object')];
	const steps = declaredSteps(release);
	return [
		...unknownKeys(key, release, RELEASE_KEYS),
		...stepListViolations(key, release.steps),
		...(steps === null ? [] : stepSetViolations(key, steps)),
		...(VERSION_KEY.test(key) ? compatViolations(key, tripleOf(key), release.compat, steps) : []),
		...minViolations(key, key, steps, compatOf),
	];
}

/** The file's head: an object with exactly `format` (this engine's) and `releases` (an object). */
function headViolations(raw: Record<string, unknown>): DescriptorViolation[] {
	return [
		...unknownKeys('catalog', raw, ['format', 'releases']),
		...onlyIf(
			raw.format !== CATALOG_FILE_FORMAT,
			violation('catalog', 'file_format', `format must be ${CATALOG_FILE_FORMAT}`),
		),
		...onlyIf(
			!isRecord(raw.releases),
			violation('catalog', 'releases_shape', 'releases is an object'),
		),
	];
}

/** Read every data step's SQL file; a missing one is pushed onto `violations`. */
function readSqlTexts(
	keys: readonly string[],
	releases: Record<string, unknown>,
	readSql: (path: string) => string | null,
	violations: DescriptorViolation[],
): Map<string, string> {
	const texts = new Map<string, string>();
	const dataSteps = keys.map((key) => ({
		key,
		data: declaredSteps(releases[key])?.find((step) => step.kind === 'data'),
	}));
	for (const { key, data } of dataSteps) {
		const paths: unknown[] = Array.isArray(data?.sql) ? data.sql : [];
		for (const path of paths) {
			const text = typeof path === 'string' ? readSql(path) : null;
			if (text === null) {
				violations.push(
					violation(key, 'data_sql_missing', `SQL file '${String(path)}' does not exist`),
				);
			} else texts.set(path as string, text);
		}
	}
	return texts;
}

/**
 * Parse and validate the file's JSON. `readSql` reads one SQL file (path
 * relative to install/update/); a missing file is a violation. Descriptors and
 * plans are built only when the file is valid — a caller never sees a half.
 */
export function parseCatalogFile(
	raw: unknown,
	readSql: (path: string) => string | null,
	lineStart: readonly number[] = DATA_LINE_START,
): ParsedCatalogFile {
	const empty = { descriptors: {}, plans: {} };
	if (!isRecord(raw)) {
		return {
			...empty,
			violations: [violation('catalog', 'file_shape', 'the file is a JSON object')],
		};
	}
	const head = headViolations(raw);
	if (!isRecord(raw.releases)) return { ...empty, violations: head };
	const releases = raw.releases;
	const keys = Object.keys(releases);
	const compatOf = new Map(
		keys.map((key) => [key, (releases[key] as { compat?: unknown } | null)?.compat]),
	);
	const violations = [
		...head,
		...walkViolations(keys, lineStart),
		...keys.flatMap((key) => releaseViolations(key, releases[key], compatOf)),
	];
	const sqlTexts = readSqlTexts(keys, releases, readSql, violations);
	if (violations.length > 0) return { ...empty, violations };
	return {
		...buildCatalog(keys, releases, lineStart, (path) => sqlTexts.get(path) ?? ''),
		violations: [],
	};
}

/** Descriptors + plans of a VALID file. */
function buildCatalog(
	keys: readonly string[],
	releases: Record<string, unknown>,
	lineStart: readonly number[],
	readSql: (path: string) => string,
): Omit<ParsedCatalogFile, 'violations'> {
	const descriptors: Record<string, UpdateDescriptor> = {};
	const plans: Record<string, ReleasePlan> = {};
	let from: readonly number[] = lineStart;
	for (const key of keys) {
		const release = releases[key] as Record<string, unknown>;
		const steps = declaredSteps(release);
		const data = steps?.find((step) => step.kind === 'data');
		descriptors[key] = descriptorOf(key, from, data, readSql);
		plans[key] = {
			version: key,
			compat: (release.compat as ReleaseCompat | undefined) ?? null,
			steps: steps ?? DEFAULT_RELEASE_STEPS,
			declared: steps !== null,
		};
		if (data !== undefined && compareVersionArrays(tripleOf(key), from) > 0) from = tripleOf(key);
	}
	return { descriptors, plans };
}

/** Read a catalog file (`<dir>/<path>`, an SQL file or a scratch catalog.json), trimmed; null when absent. */
export function readCatalogSqlFile(path: string, dir: string = UPDATE_CATALOG_DIR): string | null {
	const file = join(dir, path);
	return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

/**
 * Load the catalog (module load, once): the shipped `install/update/catalog.json`
 * by default, or `<dir>/catalog.json` (a gate's scratch catalog). An unreadable
 * or unparsable file is a violation, never an empty catalog: an install that
 * cannot see its catalog must not report "nothing to update".
 */
export function loadCatalogFile(dir?: string): ParsedCatalogFile {
	if (dir === undefined)
		return parseCatalogFile(SHIPPED_CATALOG, (path) => readCatalogSqlFile(path));
	let raw: unknown;
	try {
		// the ONE read helper: the file's absence is a parse error here, said below
		raw = JSON.parse(readCatalogSqlFile('catalog.json', dir) ?? '');
	} catch (error) {
		return {
			descriptors: {},
			plans: {},
			violations: [
				violation('catalog', 'file_unreadable', `install/update/catalog.json: ${String(error)}`),
			],
		};
	}
	return parseCatalogFile(raw, (path) => readCatalogSqlFile(path, dir));
}
