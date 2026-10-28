/**
 * Data-migration catalog (UPDATE_PROCESS Phase 3) — the TS twin of PHP
 * core/base/update/updates.php. One descriptor per reachable upgrade,
 * matched on `updateFrom*` against the INSTALLED data version
 * (matrix_updates), strictly linear (no skipping — PHP parity).
 *
 * 7.0.0 is the current data version; the only descriptor so far is the
 * code-only 7.0.1 release. The v6→v7 content (updates.php $v=700, class.v6_to_v7,
 * dataframe_v7_migration) is PHP-OWNED and deliberately NOT carried — that
 * migration runs exactly once, on the engine that owns its catalog
 * (rewrite/prompts/UPDATE_PROCESS.md §8).
 *
 * Scripts are TS-native: `scriptId` keys into SCRIPT_REGISTRY (update/scripts.ts)
 * — never a dynamic class/method lookup. On the WIRE the descriptor is
 * serialized into the PHP key shape (`SQL_update`, `run_scripts` with
 * script_class/script_method, …) because the byte-identical client derives
 * its checkbox keys from those names (render_update_data_version.js:
 * `key + '_' + i`, 0-based).
 *
 * THE ATOMIC CONTRACT (OPS-6). The engine runs a data descriptor as ONE
 * transaction on the maintenance pool (update/engine.ts): every statement, every
 * script and the version stamp land together or not at all. A descriptor that
 * cannot honour that is REFUSED — at module load (validateCatalog, below: a bad
 * entry fails loud and never ships) and again in the engine's preflight, before
 * any statement. The key set is CLOSED (`runPreScripts` / `componentsUpdate` are
 * `engine.uncovered_scope`), and each `sqlUpdate` entry must be ONE statement
 * that can run inside a transaction: no transaction control, no session `SET`,
 * no mention of `statement_timeout`/`lock_timeout` anywhere, quoted or not (the
 * engine owns both), no `set_config()`/`pg_settings` and no quoted setting name
 * (they hide which setting changes — `SET LOCAL <name>` is the one form), no
 * CONCURRENTLY / VACUUM / REINDEX SCHEMA|DATABASE|SYSTEM / a table-less CLUSTER /
 * ALTER SYSTEM / CREATE|DROP DATABASE|TABLESPACE / ALTER DATABASE … SET
 * TABLESPACE / SUBSCRIPTION commands (NOT_IN_TRANSACTION). A `DO` block's body is CODE the run executes
 * now, not a literal, so its RAW text is read too: a set_config()/pg_settings,
 * or a session SET/RESET/DISCARD leading a body statement or an EXECUTE'd
 * string, is refused there as well. Residual blind spot (ledgered here): a
 * GUC change the text does not SPELL — an EXECUTE of a string assembled at run
 * time (`'SE' || 'T …'`), or a function the run calls whose body was created
 * earlier. Work that needs CONCURRENTLY belongs to the
 * boot migrator's ONLINE lane (install/db/migrate.ts), not here. SQL literals
 * here are subject to the T2 rule (db/postgres.ts header): a matrix jsonb write
 * binds `$n::text::jsonb`.
 */

import { BODY_SESSION_STATE, DO_BLOCK, stripSqlLiterals } from '../db/sql_lexer.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { SCRIPT_REGISTRY } from './scripts.ts';
import { compareVersionArrays, DATA_LINE_START } from './version.ts';

/** One catalog script step (PHP run_scripts entry). */
export interface UpdateScriptStep {
	info: string;
	/** SCRIPT_REGISTRY key (the TS twin of script_class::script_method). */
	scriptId: string;
	stopOnError: boolean;
	scriptVars?: readonly unknown[];
}

/** The version fields every descriptor carries. */
interface UpdateDescriptorVersion {
	versionMajor: number;
	versionMedium: number;
	versionMinor: number;
	updateFromMajor: number;
	updateFromMedium: number;
	updateFromMinor: number;
}

/** A code-only release: skipped by getUpdateVersion (PHP parity), carries no steps. */
export interface CodeOnlyUpdateDescriptor extends UpdateDescriptorVersion {
	updateData: false;
}

/** The step kinds a data descriptor may order. */
export type UpdateStepKind = 'SQL_update' | 'run_scripts';

/** A data migration (PHP updates.php $updates->{NNN} shape, minus the pruned keys). */
export interface DataUpdateDescriptor extends UpdateDescriptorVersion {
	updateData: true;
	/** Raw SQL statements (PHP SQL_update) — ONE statement each (see the atomic contract). */
	sqlUpdate?: readonly string[];
	runScripts?: readonly UpdateScriptStep[];
	/** PHP execution_order (default SQL_update → run_scripts). */
	executionOrder?: readonly UpdateStepKind[];
}

/** One upgrade descriptor. `runPreScripts`/`componentsUpdate` are refused (see header). */
export type UpdateDescriptor = CodeOnlyUpdateDescriptor | DataUpdateDescriptor;

/**
 * The catalog, keyed by the target version as a DOTTED triple: `'7.0.1'` names
 * 7.0.1, `'7.11.1'` names 7.11.1 (VERSIONING_SPEC §4 rule 3, D5). A concatenated
 * key cannot say which release it names: `'7110'` is both 7.1.10 and 7.11.0. The
 * key must equal the entry's own triple (validateUpdateDescriptor refuses a
 * mismatch).
 *
 * ⚠️ EVERY CODE RELEASE NEEDS A DESCRIPTOR HERE, even when it carries NO data
 * migration (`updateData: false`): `src/core/update/code_manifest.ts`
 * (`linearUpgradeTargets`) WALKS THIS CATALOG to decide which release zips the
 * master advertises. An empty/omitted entry means the master answers
 * `files: []` and no consumer can ever see the release — the coupling is
 * invisible from here, which is exactly why this comment exists.
 */
export const UPDATE_CATALOG: Readonly<Record<string, UpdateDescriptor>> = Object.freeze({
	'7.0.1': {
		versionMajor: 7,
		versionMedium: 0,
		versionMinor: 1,
		updateFromMajor: 7,
		updateFromMedium: 0,
		updateFromMinor: 0,
		updateData: false, // code-only release — no data migration
	},
	// NO FABRICATED RUNGS BEYOND THE NEXT ONE. '702'/'703' lived here to let the
	// museum-cycle probe walk several hops, and they cost more than they bought:
	// `scripts/update_drill.ts` picks the NEWEST descriptor, so `bun run
	// test:update` rehearsed 7.0.2 → 7.0.3 — a hop nobody will ever cut —
	// instead of the rung a release manager actually ships, and the shipped
	// manifest advertised upgrade paths to releases that do not exist. The probe
	// is made repeatable by RESETTING the museum tree to the rung's FROM end
	// (it already re-materializes that tree), never by inventing more rungs.
	// Ratcheted by catalogRungIsReachable in test/unit/code_update.test.ts.
} satisfies Record<string, UpdateDescriptor>);

/** Key for a descriptor's target version: the dotted triple (`'7.0.1'`). */
export function catalogKeyOf(descriptor: UpdateDescriptorVersion): string {
	return `${descriptor.versionMajor}.${descriptor.versionMedium}.${descriptor.versionMinor}`;
}

// DATA_LINE_START (the first data version of the line) lives in version.ts: a
// version literal belongs there only (update_ownership_tripwire). Re-exported here.
export { DATA_LINE_START } from './version.ts';

/**
 * The data version a build derives from the catalog (VERSIONING_SPEC §4, D2/D4 b):
 * the highest `updateData: true` entry BELOW the build's next release, plus the
 * entry AT that release only when the build IS that release tagged (`tagged`).
 * An untagged nightly of the next release never moves the data version: its
 * unreleased entry waits for the tag. No such entry → the line start.
 */
export function dataVersionOf(
	catalog: Readonly<Record<string, UpdateDescriptor>>,
	next: readonly number[],
	tagged: boolean,
): number[] {
	let best: number[] = [...DATA_LINE_START];
	for (const descriptor of Object.values(catalog)) {
		if (!isDataDescriptor(descriptor)) continue;
		const triple = [descriptor.versionMajor, descriptor.versionMedium, descriptor.versionMinor];
		const order = compareVersionArrays(triple, next);
		if (order > 0 || (order === 0 && !tagged)) continue;
		if (compareVersionArrays(triple, best) > 0) best = triple;
	}
	return best;
}

// ---------------------------------------------------------------------------
// THE DESCRIPTOR VALIDATOR (OPS-6)
// ---------------------------------------------------------------------------

/** One reason a descriptor cannot run atomically. */
export interface DescriptorViolation {
	rule: string;
	code: 'engine.uncovered_scope' | 'update.refused';
	detail: string;
}

const VERSION_KEYS = [
	'versionMajor',
	'versionMedium',
	'versionMinor',
	'updateFromMajor',
	'updateFromMedium',
	'updateFromMinor',
] as const;

/** The CLOSED key set of a descriptor (anything else is refused). */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
	...VERSION_KEYS,
	'updateData',
	'sqlUpdate',
	'runScripts',
	'executionOrder',
]);

/** Keys the engine cannot honour — refused as uncovered scope, with the reason. */
const UNCOVERED_KEYS: Readonly<Record<string, string>> = {
	runPreScripts:
		'run_pre_scripts steps are not supported by the TS engine: they ran OUTSIDE the migration in PHP, which the atomic unit cannot express — fold the work into run_scripts',
	componentsUpdate:
		'components_update steps are not supported by the TS engine yet — implement the component updateDataVersion facet with the first 7.x descriptor that needs it',
};

const STEP_KINDS: ReadonlySet<string> = new Set<UpdateStepKind>(['SQL_update', 'run_scripts']);

/** Statement-leading keywords that end or nest the engine's transaction. */
const TRANSACTION_CONTROL =
	/^(BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\b|^PREPARE\s+TRANSACTION\b/i;
/** A session-level SET (outlives the run) — LOCAL/TRANSACTION/CONSTRAINTS die with it. */
const SESSION_STATE = /^(SET(?!\s+(LOCAL|TRANSACTION|CONSTRAINTS)\b)|RESET|DISCARD)\b/i;
/**
 * Forms PostgreSQL refuses inside a transaction block (PreventInTransactionBlock):
 * CONCURRENTLY, VACUUM, REINDEX SCHEMA|DATABASE|SYSTEM, a table-less CLUSTER,
 * ALTER SYSTEM, CREATE|DROP DATABASE|TABLESPACE, ALTER DATABASE … SET
 * TABLESPACE, and the SUBSCRIPTION commands (refused WHOLESALE — most of their
 * forms are refused in a block, and a data update never manages replication).
 * Not lexically visible (the run fails at that step with 25001, rolled back):
 * a CLUSTER naming a PARTITIONED table.
 */
const NOT_IN_TRANSACTION = new RegExp(
	[
		String.raw`\bCONCURRENTLY\b`,
		String.raw`^VACUUM\b`,
		String.raw`^REINDEX\s+(\([^)]*\)\s*)?(SCHEMA|DATABASE|SYSTEM)\b`,
		String.raw`^CLUSTER(\s+VERBOSE|\s*\([^)]*\))?\s*$`,
		String.raw`^ALTER\s+SYSTEM\b`,
		String.raw`^(CREATE|DROP)\s+(DATABASE|TABLESPACE)\b`,
		String.raw`^ALTER\s+DATABASE\b[\s\S]*\bSET\s+TABLESPACE\b`,
		String.raw`^(CREATE|DROP|ALTER)\s+SUBSCRIPTION\b`,
	].join('|'),
	'i',
);
/**
 * The engine owns both timeouts. Matched on the RAW text — inside a literal, a
 * comment or a quoted identifier (`SET LOCAL "lock_timeout" = 0`) too: naming
 * either GUC anywhere in a descriptor is refused, so no quoting defeats it.
 */
const TIMEOUT_NAME = /(statement|lock)_timeout/i;
/**
 * The function/catalog forms of SET — `set_config(…)` (any spelling of its
 * arguments: `E'…'`, `$$…$$`, a concatenation) and a write to `pg_settings` —
 * hide WHICH setting they change, so a descriptor may use neither: a GUC is set
 * with `SET LOCAL <name>` or not at all. Matched with quoted identifiers
 * UNQUOTED (`"set_config"(…)` is the same call).
 */
const GUC_FUNCTION = /\bset_config\s*\(|\bpg_settings\b/i;
/**
 * A `DO` block (DO_BLOCK, shared with the pool — db/sql_lexer.ts): its
 * dollar-quoted (or quoted) body is PL/pgSQL the run executes NOW — to the lexer
 * a literal, so the rules below read its RAW text (BODY_SESSION_STATE, shared
 * with the pool's session-state refusal; RAW_GUC_FUNCTION, this door's stricter
 * policy — a descriptor may use no set_config at all).
 */
/** GUC_FUNCTION on raw text (a quoted `"set_config"(` call included). */
const RAW_GUC_FUNCTION = /\bset_config"?\s*\(|\bpg_settings\b/i;
/** `SET [LOCAL|SESSION] "…"` / `U&"…"` — a quoted GUC name hides what it sets. */
const QUOTED_GUC_NAME = /^SET\s+((LOCAL|SESSION)\s+)?(U&)?""/i;

/** One sqlUpdate entry, as each rule reads it. */
interface StatementView {
	/** Literals, comments and quoted identifiers blanked; no trailing `;`. */
	body: string;
	/** The same with quoted identifiers UNQUOTED (rules about what is named). */
	named: string;
	/** The entry as written. */
	raw: string;
}

/** The lexical rules for ONE sqlUpdate entry, in order (see the atomic contract). */
const STATEMENT_RULES: readonly {
	rule: string;
	detail: string;
	breaks: (view: StatementView) => boolean;
}[] = [
	{
		rule: 'one_statement',
		detail: 'holds more than one statement',
		breaks: ({ body }) => body.includes(';'),
	},
	{
		rule: 'transaction_control',
		detail: 'transaction control would end the atomic unit',
		breaks: ({ body }) => TRANSACTION_CONTROL.test(body),
	},
	{
		rule: 'timeout_directive',
		detail: 'statement_timeout/lock_timeout are owned by the engine',
		breaks: ({ raw }) => TIMEOUT_NAME.test(raw),
	},
	{
		rule: 'guc_function',
		detail: 'set_config()/pg_settings hide which setting they change — use SET LOCAL <name>',
		breaks: ({ named, body, raw }) =>
			GUC_FUNCTION.test(named) || (DO_BLOCK.test(body) && RAW_GUC_FUNCTION.test(raw)),
	},
	{
		rule: 'quoted_guc_name',
		detail: 'a quoted setting name hides what it sets — use SET LOCAL <name>',
		breaks: ({ body }) => QUOTED_GUC_NAME.test(body),
	},
	{
		rule: 'session_state',
		detail: 'a session SET/RESET/DISCARD outlives the run',
		breaks: ({ body, raw }) =>
			SESSION_STATE.test(body) || (DO_BLOCK.test(body) && BODY_SESSION_STATE.test(raw)),
	},
	{
		rule: 'not_in_transaction',
		detail: 'this form cannot run inside a transaction',
		breaks: ({ body }) => NOT_IN_TRANSACTION.test(body),
	},
];

/** One `update.refused` violation. */
function refused(rule: string, detail: string): DescriptorViolation[] {
	return [{ rule, code: 'update.refused', detail }];
}

/** One trailing `;` is part of one statement. */
function withoutTrailingSemicolon(stripped: string): string {
	return stripped.trim().replace(/;\s*$/, '').trim();
}

/** The lexical rules for ONE sqlUpdate entry (the lexer is db/sql_lexer.ts, shared with the pool). */
function statementViolations(index: number, statement: unknown): DescriptorViolation[] {
	const where = `sqlUpdate[${index}]`;
	if (typeof statement !== 'string' || statement.trim() === '') {
		return refused('statement_shape', `${where}: must be a non-empty SQL string`);
	}
	const blanked = stripSqlLiterals(statement, 'blank');
	const unquoted = stripSqlLiterals(statement, 'unquote');
	if (blanked === null || unquoted === null) {
		return refused('statement_lexing', `${where}: unterminated literal or comment`);
	}
	const view: StatementView = {
		body: withoutTrailingSemicolon(blanked),
		named: withoutTrailingSemicolon(unquoted),
		raw: statement,
	};
	const broken = STATEMENT_RULES.find((rule) => rule.breaks(view));
	return broken === undefined ? [] : refused(broken.rule, `${where}: ${broken.detail}`);
}

/** sqlUpdate: an array of statements, each lexically valid. */
function sqlUpdateViolations(statements: unknown): DescriptorViolation[] {
	if (statements === undefined) return [];
	if (!Array.isArray(statements)) return refused('sql_update', 'sqlUpdate must be an array');
	return statements.flatMap((statement, index) => statementViolations(index, statement));
}

/** executionOrder, as a list: an array of distinct, known step kinds. */
function executionOrderShapeProblem(order: unknown): string | null {
	if (!Array.isArray(order)) return 'must be an array';
	if (new Set(order).size !== order.length) return 'names a step kind twice';
	const unknown = order.filter((entry) => !STEP_KINDS.has(String(entry)));
	return unknown.length > 0 ? `unknown step kind(s) ${unknown.join(', ')}` : null;
}

/** executionOrder vs the descriptor: names only present steps, omits none. */
function executionOrderCoverageProblem(
	order: readonly string[],
	record: Record<string, unknown>,
): string | null {
	const present = (['SQL_update', 'run_scripts'] as const).filter(
		(kind) => record[kind === 'SQL_update' ? 'sqlUpdate' : 'runScripts'] !== undefined,
	);
	const absent = order.find((kind) => !present.includes(kind as UpdateStepKind));
	if (absent !== undefined) return `names '${absent}', which the descriptor does not carry`;
	const omitted = present.find((kind) => !order.includes(kind));
	return omitted === undefined ? null : `omits '${omitted}' — its steps would never run`;
}

/** executionOrder: no duplicate, no unknown kind, names only present steps, omits none. */
function executionOrderViolations(record: Record<string, unknown>): DescriptorViolation[] {
	const order = record.executionOrder;
	if (order === undefined) return [];
	const problem =
		executionOrderShapeProblem(order) ??
		executionOrderCoverageProblem(order as readonly string[], record);
	return problem === null ? [] : refused('execution_order', `executionOrder: ${problem}`);
}

/** One runScripts entry: well-formed, with a registered id. */
function scriptStepViolations(
	step: unknown,
	index: number,
	knownScriptIds: ReadonlySet<string>,
): DescriptorViolation[] {
	const shape = step as Partial<UpdateScriptStep> | null;
	const wellFormed =
		typeof shape?.scriptId === 'string' &&
		typeof shape.stopOnError === 'boolean' &&
		typeof shape.info === 'string';
	if (!wellFormed) {
		return refused('run_scripts', `runScripts[${index}] must carry info, scriptId and stopOnError`);
	}
	return knownScriptIds.has(shape.scriptId as string)
		? []
		: refused('unknown_script', `runScripts[${index}]: unknown scriptId '${shape.scriptId}'`);
}

/** runScripts: an array of well-formed steps with registered ids. */
function scriptViolations(
	steps: unknown,
	knownScriptIds: ReadonlySet<string>,
): DescriptorViolation[] {
	if (steps === undefined) return [];
	if (!Array.isArray(steps)) return refused('run_scripts', 'runScripts must be an array');
	return steps.flatMap((step, index) => scriptStepViolations(step, index, knownScriptIds));
}

/** The CLOSED key set: pruned keys are uncovered scope, anything else unknown is refused. */
function keyViolations(record: Record<string, unknown>): DescriptorViolation[] {
	return Object.keys(record).flatMap((name): DescriptorViolation[] => {
		const uncovered = UNCOVERED_KEYS[name];
		if (uncovered !== undefined) {
			return [{ rule: name, code: 'engine.uncovered_scope', detail: uncovered }];
		}
		return KNOWN_KEYS.has(name) ? [] : refused('unknown_key', `unknown key '${name}'`);
	});
}

/** The version fields, the catalog key they must produce, and updateData. */
function versionViolations(key: string, record: Record<string, unknown>): DescriptorViolation[] {
	const updateData =
		typeof record.updateData === 'boolean'
			? []
			: refused('update_data', 'updateData must be a boolean');
	const badVersion = VERSION_KEYS.filter(
		(name) => !Number.isInteger(record[name]) || (record[name] as number) < 0,
	);
	if (badVersion.length > 0) {
		return [
			...refused(
				'version_fields',
				`version fields must be non-negative integers: ${badVersion.join(', ')}`,
			),
			...updateData,
		];
	}
	const keyMatches = catalogKeyOf(record as unknown as UpdateDescriptorVersion) === key;
	return keyMatches
		? updateData
		: [
				...refused('catalog_key', `catalog key '${key}' does not match the descriptor version`),
				...updateData,
			];
}

/**
 * DATA RULE (2026-10-25): a data migration rides a MINOR or MAJOR release only.
 * A patch (versionMinor > 0) is code-only by construction — its data triple is
 * the minor it was cut from — so a data descriptor keyed on a patch would run
 * SQL the release identity never declared. Refused here at module load and in
 * the engine preflight; the gate is update_descriptor_tripwire.test.ts.
 */
function dataPlacementViolations(record: Record<string, unknown>): DescriptorViolation[] {
	const minor = record.versionMinor;
	return typeof minor === 'number' && minor !== 0
		? refused(
				'data_on_patch',
				`a data descriptor belongs to a minor or major release, not patch ${record.versionMajor}.${record.versionMedium}.${minor}`,
			)
		: [];
}

/**
 * A data descriptor must apply something: `updateData: true` with no
 * `sqlUpdate` and no `runScripts` (absent or empty) would advance the data
 * version while changing nothing. Refused at module load.
 */
function steplessDataViolations(record: Record<string, unknown>): DescriptorViolation[] {
	const count = stepCount(record.sqlUpdate) + stepCount(record.runScripts);
	return count === 0
		? refused(
				'data_without_steps',
				'a data descriptor (updateData: true) carries no sqlUpdate and no runScripts: it would change nothing',
			)
		: [];
}

/** The number of entries of a step list (a non-list counts as none; its own rule refuses it). */
function stepCount(steps: unknown): number {
	return Array.isArray(steps) ? steps.length : 0;
}

/** A code-only release carries no steps. */
function codeOnlyViolations(record: Record<string, unknown>): DescriptorViolation[] {
	const steps = ['sqlUpdate', 'runScripts', 'executionOrder'].filter((name) => name in record);
	return steps.length === 0
		? []
		: refused('code_only_steps', `a code-only descriptor carries steps: ${steps.join(', ')}`);
}

/**
 * Every reason `descriptor` (catalog key `key`) cannot run as the engine's
 * atomic unit; `[]` = runnable. `engine.uncovered_scope` for the pruned keys,
 * `update.refused` for everything else.
 */
export function validateUpdateDescriptor(
	key: string,
	descriptor: unknown,
	knownScriptIds: ReadonlySet<string> | readonly string[],
): DescriptorViolation[] {
	if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
		return refused('shape', 'a descriptor must be an object');
	}
	const record = descriptor as Record<string, unknown>;
	const head = [...keyViolations(record), ...versionViolations(key, record)];
	if (record.updateData === false) return [...head, ...codeOnlyViolations(record)];
	const scriptIds = knownScriptIds instanceof Set ? knownScriptIds : new Set(knownScriptIds);
	return [
		...head,
		...dataPlacementViolations(record),
		...steplessDataViolations(record),
		...sqlUpdateViolations(record.sqlUpdate),
		...executionOrderViolations(record),
		...scriptViolations(record.runScripts, scriptIds),
	];
}

/** The first violation as the typed refusal (uncovered scope first, like the engine). */
export function descriptorRefusal(violations: readonly DescriptorViolation[]): DedaloError | null {
	const first =
		violations.find((violation) => violation.code === 'engine.uncovered_scope') ?? violations[0];
	if (first === undefined) return null;
	return new DedaloError(first.code, {
		message: `update descriptor refused (${first.rule}): ${first.detail}`,
		...(first.code === 'update.refused' ? { publicMessage: first.detail } : {}),
		coordinates: { rule: first.rule },
	});
}

/**
 * THE MODULE-LOAD CHECK: throws the first violation of any entry. Called on
 * UPDATE_CATALOG below, so a descriptor the engine cannot honour fails the
 * process at import — it never ships. `knownScriptIds` defaults to the live
 * SCRIPT_REGISTRY.
 */
export function validateCatalog(
	catalog: Readonly<Record<string, unknown>>,
	knownScriptIds: ReadonlySet<string> | readonly string[] = Object.keys(SCRIPT_REGISTRY),
): void {
	for (const [key, descriptor] of Object.entries(catalog)) {
		const refusal = descriptorRefusal(validateUpdateDescriptor(key, descriptor, knownScriptIds));
		if (refusal !== null) throw refusal;
	}
}

validateCatalog(UPDATE_CATALOG);

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

function isDataDescriptor(descriptor: UpdateDescriptor): descriptor is DataUpdateDescriptor {
	return descriptor.updateData !== false;
}

/**
 * The target version triple for the INSTALLED version, or null (PHP
 * update::get_update_version): first descriptor whose updateFrom* equals the
 * current triple, skipping updateData===false code-only releases.
 */
export function getUpdateVersion(
	current: readonly number[],
	catalog: Readonly<Record<string, UpdateDescriptor>> = UPDATE_CATALOG,
): number[] | null {
	if (current.length === 0) return null;
	for (const descriptor of Object.values(catalog)) {
		const from = [
			descriptor.updateFromMajor,
			descriptor.updateFromMedium,
			descriptor.updateFromMinor,
		];
		if (compareVersionArrays(current, from) !== 0) continue;
		if (!isDataDescriptor(descriptor)) continue;
		return [descriptor.versionMajor, descriptor.versionMedium, descriptor.versionMinor];
	}
	return null;
}

/** The matched DATA descriptor for the installed version (PHP $updates->{key}). */
export function getMatchedDescriptor(
	current: readonly number[],
	catalog: Readonly<Record<string, UpdateDescriptor>> = UPDATE_CATALOG,
): DataUpdateDescriptor | null {
	const target = getUpdateVersion(current, catalog);
	if (target === null) return null;
	const descriptor = catalog[target.join('.')];
	return descriptor !== undefined && isDataDescriptor(descriptor) ? descriptor : null;
}

/**
 * Serialize a descriptor into the PHP wire shape the byte-identical client
 * renders (render_update_data_version.js iterates SQL_update /
 * components_update / run_scripts / alert_update; other keys are inert). The
 * pruned keys (`run_pre_scripts`, `components_update`) are never emitted: no
 * valid descriptor carries them.
 */
export function toWireDescriptor(descriptor: UpdateDescriptor): Record<string, unknown> {
	const wireScript = (step: UpdateScriptStep) => ({
		info: step.info,
		script_class: 'ts_script',
		script_method: step.scriptId,
		stop_on_error: step.stopOnError,
		script_vars: step.scriptVars ?? [],
	});
	const wire: Record<string, unknown> = {
		version_major: descriptor.versionMajor,
		version_medium: descriptor.versionMedium,
		version_minor: descriptor.versionMinor,
		update_from_major: descriptor.updateFromMajor,
		update_from_medium: descriptor.updateFromMedium,
		update_from_minor: descriptor.updateFromMinor,
	};
	if (!isDataDescriptor(descriptor)) return wire;
	if (descriptor.sqlUpdate !== undefined) wire.SQL_update = [...descriptor.sqlUpdate];
	if (descriptor.runScripts !== undefined) wire.run_scripts = descriptor.runScripts.map(wireScript);
	if (descriptor.executionOrder !== undefined)
		wire.execution_order = [...descriptor.executionOrder];
	return wire;
}
