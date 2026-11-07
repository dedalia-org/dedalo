/**
 * TRIPWIRE — a tool action's declared authorization names the target the action
 * actually WRITES (audit 2026-08-26 P1-24: CARRY-08 / TOOLS-04).
 *
 * The defect this exists to end: `update_cache` declared `permission:'section'`
 * over `options.section_tipo`, then read a SEPARATE client SQO and re-saved
 * components on every row it matched — the gate asserted a right about a
 * sibling field (any section the caller held write on, dd655 included, which
 * every principal holds) while the thing actually written was ungated.
 * `generate_virtual_section` gated `options.section_tipo` and wrote
 * `hierarchy1/<section_id>` by constant; `import_files` gated `(section_tipo,
 * tipo)` and wrote into every `tool_config.ddo_map` destination the client
 * supplied. Three doors, one mistake, proven open by execution. A previous
 * audit had recorded it CLOSED.
 *
 * THE RULE, stated as three source-derived bindings over EVERY action in
 * EVERY tool server module (census TOTAL over `tools/*\/server/index.ts`, the
 * modules loaded through the real loader so a spec the loader sees is a spec
 * this gate sees; the handler's source is walked TRANSITIVELY through the
 * functions and constants of its own tool directory):
 *
 *  R1  a handler that reads a scope off `options.sqo` declares the 'targets'
 *      kind, and its `targets` extractor derives the targets FROM `sqo`;
 *  R2  a handler that reads a NESTED CLIENT MAP KEY (`tool_config`, `ddo_map`,
 *      `target_section_tipo`, `target_filename`, `ar_section_tipo`) declares
 *      'targets' or 'section_list', and its extractor references THAT key;
 *  R3  a handler that calls a PINNED writer (`ensureHierarchy` /
 *      `rebuildHierarchy` / `inspectHierarchy` — id-only, HIERARCHY_SECTION by
 *      constant) or a write door with a CONSTANT/LITERAL section declares
 *      'targets', and its extractor names that constant.
 *
 * ENUMERATED exemptions, each with a reason and SHRINK-ONLY: an entry whose
 * action no longer trips any rule is stale and reddens; an entry is never a
 * blanket pass — it names what stands in for the binding (a read, a
 * developer-only surface, a per-row in-handler re-authorization pinned by
 * another gate, a bookkeeping write) and the gate re-checks the parts of that
 * claim it can (a READ exemption that grows a write verb reddens).
 *
 * The three rules are PURE over (kind, handler source, extractor source), so the
 * gate plants positive-control offenders through the same judge the census
 * runs: a rule that stopped matching its own offender is a rule that enforces
 * nothing. The extractor-side checks (`sqo` / the key / the constant present in
 * the extractor's transitive source) are what a wrong rebinding — a 'targets'
 * kind whose extractor still reads the sibling field — trips on.
 *
 * WHAT THIS GATE CANNOT SEE, and says so: it binds a DECLARATION to a SOURCE
 * shape. That the extractor derives the RIGHT set from the key (every ddo_map
 * role that writes, every sqo section × every selected component) is asserted
 * behaviourally by test/unit/action_scope_binding_native.test.ts, where a
 * principal holding the declared-but-wrong grant and 0 on the real target is
 * REFUSED at each of the three doors, and the refusal precedes the fork.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverFiles } from '../../scripts/lib/throw_census.ts';
import { loadToolModules } from '../../src/core/tools/loader.ts';
import { unguarded } from '../../src/core/tools/reason_keys.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

// ── the rules ────────────────────────────────────────────────────────────────

/** R1: reading a scope off the request SQO (the batch_scope_tripwire shape). */
const READS_REQUEST_SQO = /\b(?:options|o)\.sqo\b/;

/** R2: the nested client-map keys a handler may take a WRITE target from. */
const NESTED_CLIENT_KEYS = [
	'tool_config',
	'ddo_map',
	'target_section_tipo',
	'target_filename',
	'ar_section_tipo',
] as const;

/** R3a: writers that take ONLY an id and pin HIERARCHY_SECTION by constant. */
const PINNED_WRITERS = ['ensureHierarchy', 'rebuildHierarchy', 'inspectHierarchy'] as const;
const PINNED_WRITER_CONSTANT = 'HIERARCHY_SECTION';

/** R3b: write doors whose SECTION argument a handler may pin by constant. */
const WRITE_DOORS = [
	'saveComponentData',
	'createSectionRecord',
	'deleteSectionRecord',
	'updateMatrixKeyData',
	'persistUploadedMedia',
] as const;

/** The kinds whose extractor can name a nested/derived target. */
const BOUND_KINDS: ReadonlySet<string> = new Set(['targets', 'section_list']);

/** One judged action: what the census derived from the tree. */
interface JudgedAction {
	kind: string | null;
	/** The handler's transitive source (comments stripped). */
	handlerSrc: string;
	/** The `targets` / `sectionTipos` extractor's transitive source, '' when none. */
	extractorSrc: string;
}

/** A constant a write-door call pins its section with. `null` when none found. */
function pinnedSectionConstants(src: string): string[] {
	const found = new Set<string>();
	for (const door of WRITE_DOORS) {
		for (const match of src.matchAll(new RegExp(`\\b${door}\\(`, 'g'))) {
			const args = argumentSpan(src, (match.index ?? 0) + match[0].length - 1);
			// Keyed form `sectionTipo: CONST.member` / `sectionTipo: 'dd800'`, or the
			// positional first argument of the id-first doors.
			const keyed = args.match(/\bsectionTipo:\s*([A-Z][A-Z0-9_]*(?:\.\w+)?|'[a-z]+\d+')/);
			const positional = args.match(/^\(\s*([A-Z][A-Z0-9_]*(?:\.\w+)?|'[a-z]+\d+')\s*,/);
			const pinned = keyed?.[1] ?? positional?.[1];
			if (pinned !== undefined) found.add(pinned);
		}
	}
	return [...found];
}

/** The root identifier of a pinned constant (`BULK_PROCESS_TIPOS.section` → `BULK_PROCESS_TIPOS`). */
function constantRoot(pinned: string): string {
	return pinned.split('.')[0] as string;
}

/**
 * THE JUDGE — pure over the action's shapes. Returns the violations; [] when
 * the declaration is bound to what the handler writes.
 */
function judge(action: JudgedAction): string[] {
	const violations: string[] = [];
	const bound = action.kind !== null && BOUND_KINDS.has(action.kind);

	// R1 — the SQO scope.
	if (READS_REQUEST_SQO.test(action.handlerSrc)) {
		if (action.kind !== 'targets') {
			violations.push(
				`R1: reads options.sqo but declares '${action.kind}' — the scope it acts on is not what the gate authorizes; declare 'targets' derived from sqo`,
			);
		} else if (!/\bsqo\b/.test(action.extractorSrc)) {
			violations.push(
				"R1: declares 'targets' but its extractor never reads `sqo` — the gate is still bound to a sibling field",
			);
		}
	}

	// R2 — a nested client map key.
	for (const key of NESTED_CLIENT_KEYS) {
		if (!new RegExp(`\\b${key}\\b`).test(action.handlerSrc)) continue;
		if (!bound) {
			violations.push(
				`R2: reads the nested client key '${key}' but declares '${action.kind}' — declare 'targets' (or 'section_list') derived from that key`,
			);
		} else if (!new RegExp(`\\b${key}\\b`).test(action.extractorSrc)) {
			violations.push(
				`R2: reads the nested client key '${key}' but its extractor never references it — the targets it gates are not the ones the handler writes`,
			);
		}
	}

	// R3a — the pinned hierarchy writer.
	if (PINNED_WRITERS.some((writer) => new RegExp(`\\b${writer}\\(`).test(action.handlerSrc))) {
		if (action.kind !== 'targets') {
			violations.push(
				`R3: calls an id-only pinned writer (${PINNED_WRITERS.join('/')}) but declares '${action.kind}' — the section it writes is a constant the gate never sees`,
			);
		} else if (!new RegExp(`\\b${PINNED_WRITER_CONSTANT}\\b`).test(action.extractorSrc)) {
			violations.push(
				`R3: calls a pinned writer but its extractor does not name ${PINNED_WRITER_CONSTANT}`,
			);
		}
	}
	// R3b — a write door with a constant/literal section.
	for (const pinned of pinnedSectionConstants(action.handlerSrc)) {
		const root = constantRoot(pinned);
		if (action.kind !== 'targets') {
			violations.push(
				`R3: writes with a pinned section (${pinned}) but declares '${action.kind}' — declare 'targets' naming it`,
			);
		} else if (!new RegExp(`\\b${root.replace(/'/g, '')}\\b`).test(action.extractorSrc)) {
			violations.push(`R3: writes with a pinned section (${pinned}) its extractor does not name`);
		}
	}
	return violations;
}

// ── ENUMERATED exemptions (shrink-only, reasoned) ────────────────────────────

/**
 * `tool.action` → why the binding is not required there. Each entry MUST still
 * trip at least one rule (else it is stale and the gate reddens), and a reason
 * must be substantive. An exemption is never "it is fine": it names the
 * standing gate or the nature of the surface.
 */
const EXEMPT: Record<string, string> = {
	'tool_export.get_export_grid':
		'A READ (R1). The handler reads sqo.section_tipo only to assert level >= 1 on every ' +
		'section the export touches (export_gate_b_native) and writes nothing; the batch_scope_tripwire ' +
		'carries the same read exemption, and this gate re-checks that no write verb has grown here.',
	'tool_export.build_export_artifact':
		'A READ (R1) run as a background job: the SAME producer and the SAME sqo section gate as ' +
		'get_export_grid (assertExportSqoSections, level >= 1 on every sqo.section_tipo, pinned by ' +
		'tool_export_sqo_gate) — its only writes are the export spool files under the caller-owned ' +
		'export artifacts directory, never a matrix record; tool_export_job_native gates the refusal.',
	'tool_export.build_export_file':
		'A READ (R1) of the RECORDED sqo, not the request one: resolveOwnedJob/listOwnedExportJobs re-ask ' +
		"the build gates (exportStillReadable) over the options the caller's own job manifest stored, " +
		'so the sqo only ADDS level >= 1 checks; the scope acted on is the caller-owned job directory, ' +
		'never a matrix record. tool_export_job_native H measures the re-check (a revoked grant closes it).',
	'tool_export.get_export_preview':
		'A READ (R1) of the RECORDED sqo, not the request one: resolveOwnedJob/listOwnedExportJobs re-ask ' +
		"the build gates (exportStillReadable) over the options the caller's own job manifest stored, " +
		'so the sqo only ADDS level >= 1 checks; the scope acted on is the caller-owned job directory, ' +
		'never a matrix record. tool_export_job_native H measures the re-check (a revoked grant closes it).',
	'tool_export.list_export_jobs':
		'A READ (R1) of the RECORDED sqo, not the request one: resolveOwnedJob/listOwnedExportJobs re-ask ' +
		"the build gates (exportStillReadable) over the options the caller's own job manifest stored, " +
		'so the sqo only ADDS level >= 1 checks; the scope acted on is the caller-owned job directory, ' +
		'never a matrix record. tool_export_job_native H measures the re-check (a revoked grant closes it).',
	'tool_identify.cluster':
		'A READ (R1/R2) already declared over its payload: section_list whose extractor is the ' +
		'clustering pool sections, and record_pool.ts re-stamps the caller sectionTipos onto the ' +
		'sanitized SQO so a client cannot widen it; the run writes nothing back to the records it reads.',
	'tool_ontology.set_records_in_dd_ontology':
		"A DEVELOPER-ONLY surface (R1): the kind is 'developer', which is a flag, not a per-section " +
		'grant — a developer may rewrite dd_ontology for any section, so scope binding has no grant to ' +
		'bind to. The scope itself is REQUIRED (batch_scope_tripwire: an absent sqo refuses, WC-058).',
	'tool_ontology_parser.get_ontologies':
		"DEVELOPER-ONLY (R2): 'developer' is a flag, not a per-section grant, so there is no grant to " +
		'bind a target to. `target_section_tipo` here is the hierarchy record FIELD the parser REPORTS ' +
		'per TLD (the ontology listing the panel renders), not a client map the handler writes through; ' +
		'the ontology writes are owned by ontology_state.ts (ontology_single_writer_tripwire).',
	'tool_import_dedalo_csv.import_files':
		'BOOKKEEPING WRITE (R3b): the pinned section is BULK_PROCESS_TIPOS (dd800), the bulk-process ' +
		'record every CSV import creates to label itself and tag its files — never a user-targeted ' +
		"write; the user-targeted rows land in files[].section_tipo, each gated by the 'section_list' " +
		'extractor before any file is imported (SEC-024 §9.2, tool_import_dedalo_csv.test).',
	'tool_import_rdf.get_rdf_data':
		'PER-WRITE IN-HANDLER RE-AUTHORIZATION (R2): `ddo_map` is the EXTERNAL ONTOLOGY node property ' +
		'(owl:ObjectProperty properties.ddo_map, read from dd_ontology by rdf_import_plan.ts), never a ' +
		"client map; the caller record is gated by the 'section_list' extractor over " +
		'options.locator.section_tipo, and every write the import makes (the caller, a found term, an ' +
		'intermediate, a created record) is asked again of the write door as the importer ' +
		'(authorizeRecordAccess / authorizeSectionTarget, rdf_import_execute_native + authz_door_matrix_native).',
	'tool_time_machine.bulk_revert_process':
		'PER-ROW IN-HANDLER RE-AUTHORIZATION (R2/R3b): the rows a bulk revert touches come from the TM ' +
		'table by bulk_process_id, not from a client map — `ddo_map` is reached through the dataframe ' +
		'restore helpers it shares with apply_value — and every row is gated getPermissions(row pair) ' +
		'>= 2 + principalCanAccessRecord(row) before its write (tm_scope_authz_native); the pinned ' +
		'BULK_PROCESS_SECTION_TIPO (dd800) is the bookkeeping record that makes the revert revertible.',
	'tool_propagate_component_data.propagate_component_data':
		"A NAMED null exemption (R1): 'permission: null' with a gatedInHandler that " +
		'human_write_scope_tripwire pins — the loop authorizes EVERY row it reaches ' +
		'(principalCanAccessRecord + getRecordComponentPermission on row.section_tipo/section_id) before ' +
		'persistRecordKeys, so the binding is per-row in the handler; tool_permission_census_tripwire ' +
		'keeps the null spec shrink-only. Converting it to the declarative kind is tracked, not done.',
	'tool_update_cache.update_cache':
		'BOOKKEEPING WRITE (R3b): the one pinned section is BULK_PROCESS_TIPOS (dd800) — the bulk-process ' +
		'record every run creates to label itself and to tag moved files, never a user-targeted write; ' +
		'its user-targeted writes are on row.section_tipo × selection tipo, which the targets extractor ' +
		'derives from sqo (R1 is bound, not exempt, here).',
};

// ── the source model: functions + constants of a tool directory ──────────────

/**
 * Every measured `*.ts` under `tools/` — taken from the registered shared lister
 * (`scripts/lib/throw_census.ts` discoverFiles: `src` + `tools`, tests and
 * `.d.ts` excluded) so this gate chooses no walk root of its own; the census
 * anti-vacuity test floors it.
 */
const TOOL_SERVER_FILES: readonly string[] = discoverFiles().filter((file) =>
	/^tools\/[^/]+\/server\//.test(file),
);

/** Every `server/**\/*.ts` of a tool dir, comment-stripped and concatenated per file. */
function toolSources(toolName: string): string[] {
	const prefix = `tools/${toolName}/server/`;
	return TOOL_SERVER_FILES.filter((file) => file.startsWith(prefix)).map((file) =>
		stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')),
	);
}

/** Span of the bracketed argument list starting at the `(` at `open`. */
function argumentSpan(src: string, open: number): string {
	return bracketSpan(src, open, '(', ')');
}

/** The text from `open` (an opening bracket) to its matching close, inclusive. */
function bracketSpan(src: string, open: number, lhs: string, rhs: string): string {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (ch === lhs) depth++;
		else if (ch === rhs) {
			depth--;
			if (depth === 0) return src.slice(open, i + 1);
		}
	}
	return src.slice(open);
}

/** A statement span from `start` to the first `;` at bracket depth 0. */
function statementSpan(src: string, start: number): string {
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		const ch = src[i];
		if (ch === '(' || ch === '{' || ch === '[') depth++;
		else if (ch === ')' || ch === '}' || ch === ']') depth--;
		else if (ch === ';' && depth === 0) return src.slice(start, i + 1);
	}
	return src.slice(start);
}

/**
 * The top-level symbols of a tool directory: `function NAME(` (body =
 * signature + matched braces) and `const NAME =` (body = the statement).
 */
function symbolTable(sources: string[]): Map<string, string> {
	const symbols = new Map<string, string>();
	for (const src of sources) {
		for (const match of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm)) {
			const start = match.index ?? 0;
			const params = argumentSpan(src, start + match[0].length - 1);
			const bodyOpen = functionBodyOpen(src, start + match[0].length - 1 + params.length);
			if (bodyOpen < 0) continue;
			symbols.set(match[1] as string, params + bracketSpan(src, bodyOpen, '{', '}'));
		}
		for (const match of src.matchAll(/^(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=/gm)) {
			const name = match[1] as string;
			// `tool` is the module object itself — every handler at once, never a
			// helper a handler calls; resolving it would attribute every action's
			// source to every other action.
			if (name === MODULE_EXPORT) continue;
			if (!symbols.has(name)) symbols.set(name, statementSpan(src, match.index ?? 0));
		}
	}
	return symbols;
}

/** The `tool` export every server module carries (ToolServerModule). */
const MODULE_EXPORT = 'tool';

/**
 * The `{` that opens a function BODY, skipping a return-type annotation
 * (`): { entries: … } {` / `): Promise<void> {`): a `{` counts as the body only
 * when nothing of a type is still open and it is not introduced by `:`, `,`,
 * `<`, `|`, `&`, `(` or `=` (the tokens that precede an object TYPE literal).
 */
function functionBodyOpen(src: string, from: number): number {
	let typeDepth = 0;
	let previous = ')';
	for (let i = from; i < src.length; i++) {
		const ch = src[i] as string;
		if (/\s/.test(ch)) continue;
		if (ch === '{') {
			if (typeDepth === 0 && !TYPE_BRACE_INTRODUCERS.has(previous)) return i;
			typeDepth++;
		} else if (ch === '}') typeDepth--;
		else if (ch === '<' || ch === '[' || ch === '(') typeDepth++;
		else if (ch === '>' || ch === ']' || ch === ')') typeDepth--;
		previous = ch;
	}
	return -1;
}
const TYPE_BRACE_INTRODUCERS: ReadonlySet<string> = new Set([':', ',', '<', '|', '&', '(', '=']);

/** The transitive source of `roots` through the symbol table (identifier walk). */
function transitiveSource(roots: string[], symbols: Map<string, string>): string {
	const seen = new Set<string>();
	const queue = [...roots];
	const parts: string[] = [];
	while (queue.length > 0) {
		const body = queue.shift() as string;
		parts.push(body);
		// An identifier in KEY position (`{ tool: … }`, `sectionTipo: x`) names a
		// property, not a symbol — it is skipped.
		for (const match of body.matchAll(/\b([A-Za-z_]\w*)\b(?!\s*:)/g)) {
			const name = match[1] as string;
			if (seen.has(name) || !symbols.has(name)) continue;
			seen.add(name);
			queue.push(symbols.get(name) as string);
		}
	}
	return parts.join('\n');
}

/**
 * The handler's own source: by its function name in the table, else its toString.
 * The registry SERVES each handler behind the reason-key guard (reason_keys.ts), a
 * three-line wrapper that names no write door — so the census reads the RAW
 * function behind it (`unguarded`), or every rule below would judge the wrapper
 * and go dark (the anti-vacuity test on update_cache's `saveComponentData(` is what
 * catches a census that stopped unwrapping).
 */
function handlerRoot(handler: (...args: never[]) => unknown, symbols: Map<string, string>): string {
	const raw = unguarded(handler);
	return symbols.get(raw.name) ?? stripComments(raw.toString());
}

// ── the census ───────────────────────────────────────────────────────────────

interface CensusRow {
	id: string;
	tool: string;
	action: string;
	judged: JudgedAction;
	violations: string[];
}

async function census(): Promise<CensusRow[]> {
	const modules = await loadToolModules();
	const rows: CensusRow[] = [];
	for (const [tool, loaded] of modules) {
		const symbols = symbolTable(toolSources(tool));
		for (const [action, spec] of Object.entries(loaded.module.apiActions)) {
			const handlerSrc = transitiveSource([handlerRoot(spec.handler, symbols)], symbols);
			const extractor = spec.targets ?? spec.sectionTipos;
			const extractorSrc =
				extractor === undefined ? '' : transitiveSource([handlerRoot(extractor, symbols)], symbols);
			const judged: JudgedAction = { kind: spec.permission, handlerSrc, extractorSrc };
			rows.push({ id: `${tool}.${action}`, tool, action, judged, violations: judge(judged) });
		}
	}
	return rows.sort((a, b) => a.id.localeCompare(b.id));
}

const ROWS = await census();

// ── the gate ─────────────────────────────────────────────────────────────────

describe('action_scope_binding — the declared gate names the target the action writes', () => {
	test('the census is TOTAL over the loaded tool modules (anti-vacuity)', () => {
		const tools = new Set(ROWS.map((row) => row.tool));
		expect(TOOL_SERVER_FILES.length, 'tool server sources listed').toBeGreaterThan(30);
		expect(tools.size, 'tool server modules seen').toBeGreaterThan(10);
		expect(ROWS.length, 'actions seen').toBeGreaterThan(40);
		// The three doors the audit proved open MUST be in the census — a scan
		// that lost them would police everything but the defect.
		for (const id of [
			'tool_update_cache.update_cache',
			'tool_hierarchy.generate_virtual_section',
			'tool_import_files.import_files',
		]) {
			expect(
				ROWS.map((row) => row.id),
				`${id} must be censused`,
			).toContain(id);
		}
		// The source walk reached the handlers: the update_cache handler's
		// transitive source contains its write door, or the walk is broken and
		// every rule below judges an empty string.
		const updateCache = ROWS.find((row) => row.id === 'tool_update_cache.update_cache');
		expect(updateCache?.judged.handlerSrc).toContain('saveComponentData(');
		expect(updateCache?.judged.handlerSrc).toMatch(READS_REQUEST_SQO);
	});

	test('the three doors are bound: R1 on update_cache, R3 on hierarchy, R2 on import_files', () => {
		// Stated positively — a census that judged them clean because a rule went
		// dark is caught by the positive controls; this pins that the BINDING is
		// the reason they are clean.
		const byId = new Map(ROWS.map((row) => [row.id, row]));
		const updateCache = byId.get('tool_update_cache.update_cache');
		expect(updateCache?.judged.kind).toBe('targets');
		expect(updateCache?.judged.extractorSrc).toMatch(/\bsqo\b/);
		for (const id of [
			'tool_hierarchy.generate_virtual_section',
			'tool_hierarchy.inspect_hierarchy',
		]) {
			const row = byId.get(id);
			expect(row?.judged.kind, id).toBe('targets');
			expect(row?.judged.extractorSrc, id).toContain(PINNED_WRITER_CONSTANT);
			expect(row?.violations, id).toEqual([]);
		}
		const importFiles = byId.get('tool_import_files.import_files');
		expect(importFiles?.judged.kind).toBe('targets');
		for (const key of ['tool_config', 'ddo_map', 'target_section_tipo']) {
			expect(importFiles?.judged.extractorSrc, key).toContain(key);
		}
		expect(importFiles?.violations).toEqual([]);
		// The two component-level twins the TOTAL census surfaced (zotero /
		// marc21 field-maps) are bound the same way, not exempted.
		for (const id of ['tool_import_zotero.import_files', 'tool_import_marc21.import_files']) {
			const row = byId.get(id);
			expect(row?.judged.kind, id).toBe('targets');
			expect(row?.judged.extractorSrc, id).toContain('tool_config');
			expect(row?.violations, id).toEqual([]);
		}
	});

	test('every non-exempt action is bound (no violation)', () => {
		const offenders = ROWS.filter(
			(row) => row.violations.length > 0 && EXEMPT[row.id] === undefined,
		);
		expect(
			offenders.map((row) => `${row.id}\n    ${row.violations.join('\n    ')}`),
			'An action whose handler takes its write target from options.sqo, a nested client map, or a ' +
				"pinned section constant must declare the 'targets' kind with an extractor derived from " +
				'that same key. Bind it, or add a reasoned ENUMERATED exemption.',
		).toEqual([]);
	});

	test('every exemption is still earned (shrink-only)', () => {
		const byId = new Map(ROWS.map((row) => [row.id, row]));
		for (const [id, reason] of Object.entries(EXEMPT)) {
			expect(reason.length, `${id}: an exemption needs a real reason`).toBeGreaterThan(160);
			const row = byId.get(id);
			expect(row, `${id}: exempt action no longer exists — DELETE the entry`).toBeDefined();
			expect(
				row?.violations.length,
				`${id}: no rule trips any more — the exemption is stale, DELETE it`,
			).toBeGreaterThan(0);
			// A READ exemption that grows a write verb is no longer a read.
			if (/^A READ/.test(reason)) {
				expect(
					WRITE_DOORS.some((door) =>
						new RegExp(`\\b${door}\\(`).test(row?.judged.handlerSrc ?? ''),
					),
					`${id} is exempt as a READ but its handler now calls a write door — re-judge it`,
				).toBe(false);
			}
			// A DEVELOPER exemption must still be the developer kind.
			if (/DEVELOPER-ONLY/.test(reason)) expect(row?.judged.kind, id).toBe('developer');
			// A null exemption must still be the named null kind (its own census applies).
			if (/null exemption/.test(reason)) expect(row?.judged.kind, id).toBeNull();
		}
	});

	test('positive controls: each rule trips on a planted offender and clears the bound shape', () => {
		const sqoHandler = 'async function h(ctx) { const sqoRaw = ctx.options.sqo; if (o.sqo) {} }';
		// R1a — the audit shape: 'section' over a sibling field, scope from the SQO.
		expect(judge({ kind: 'section', handlerSrc: sqoHandler, extractorSrc: '' })).toEqual([
			expect.stringContaining('R1: reads options.sqo'),
		]);
		// R1b — a WRONG rebinding: 'targets' whose extractor still reads section_tipo.
		expect(
			judge({
				kind: 'targets',
				handlerSrc: sqoHandler,
				extractorSrc: '(options) => [{ section_tipo: options.section_tipo }]',
			}),
		).toEqual([expect.stringContaining('never reads `sqo`')]);
		// R1 clears the bound shape.
		expect(
			judge({
				kind: 'targets',
				handlerSrc: sqoHandler,
				extractorSrc: '(options) => sqoSections(options.sqo)',
			}),
		).toEqual([]);

		// R2a — 'tipo' over the caller pair, writes through a client ddo_map.
		const mapHandler = 'async function h(ctx) { const m = ctx.options.tool_config.ddo_map; }';
		const r2 = judge({ kind: 'tipo', handlerSrc: mapHandler, extractorSrc: '' });
		expect(r2).toEqual([
			expect.stringContaining("nested client key 'tool_config'"),
			expect.stringContaining("nested client key 'ddo_map'"),
		]);
		// R2b — bound kind, but the extractor references only one of the two keys.
		expect(
			judge({ kind: 'targets', handlerSrc: mapHandler, extractorSrc: '(o) => o.tool_config' }),
		).toEqual([expect.stringContaining("'ddo_map' but its extractor never references it")]);
		expect(
			judge({
				kind: 'targets',
				handlerSrc: mapHandler,
				extractorSrc: '(o) => o.tool_config.ddo_map',
			}),
		).toEqual([]);

		// R3a — the hierarchy shape: 'section' + an id-only pinned writer.
		const pinnedHandler = 'async function h(ctx) { await ensureHierarchy(id, ctx.userId); }';
		expect(judge({ kind: 'section', handlerSrc: pinnedHandler, extractorSrc: '' })).toEqual([
			expect.stringContaining('R3: calls an id-only pinned writer'),
		]);
		expect(
			judge({
				kind: 'targets',
				handlerSrc: pinnedHandler,
				extractorSrc: '(o) => [{ section_tipo: o.section_tipo }]',
			}),
		).toEqual([expect.stringContaining(`does not name ${PINNED_WRITER_CONSTANT}`)]);
		expect(
			judge({
				kind: 'targets',
				handlerSrc: pinnedHandler,
				extractorSrc: '(o) => [{ section_tipo: HIERARCHY_SECTION, section_id: o.section_id }]',
			}),
		).toEqual([]);
		// R3b — a write door with a literal / constant section.
		const literalHandler =
			"async function h() { await saveComponentData({ componentTipo: t, sectionTipo: 'dd800', sectionId: 1 }); }";
		expect(judge({ kind: 'record', handlerSrc: literalHandler, extractorSrc: '' })).toEqual([
			expect.stringContaining("pinned section ('dd800')"),
		]);
		const constHandler = 'async function h() { await createSectionRecord(BULK.section, userId); }';
		expect(
			judge({
				kind: 'targets',
				handlerSrc: constHandler,
				extractorSrc: '(o) => [{ section_tipo: o.x }]',
			}),
		).toEqual([expect.stringContaining('(BULK.section) its extractor does not name')]);
		expect(
			judge({
				kind: 'targets',
				handlerSrc: constHandler,
				extractorSrc: '(o) => [{ section_tipo: BULK.section }]',
			}),
		).toEqual([]);
		// A variable section is not a pinned one.
		expect(
			judge({
				kind: 'record',
				handlerSrc:
					'async function h() { await saveComponentData({ sectionTipo: row.section_tipo }); }',
				extractorSrc: '',
			}),
		).toEqual([]);
	});

	test('the source walk resolves functions AND constants transitively', () => {
		// The judge sees through helpers: a handler that reads the SQO inside a
		// helper it calls, and an extractor that names a key through a module
		// constant, must both be resolved — or R1/R2 could be dodged by one hop.
		const symbols = symbolTable([
			stripComments(
				[
					'const ROLES = new Set(["ddo_map"]);',
					'function readScope(options) {',
					'\treturn options.sqo;',
					'}',
					'export async function handler(ctx) {',
					'\treturn readScope(ctx.options);',
					'}',
					'export function extractor(options): { section_tipo: unknown }[] {',
					'\treturn [...ROLES];',
					'}',
				].join('\n'),
			),
		]);
		const handlerSrc = transitiveSource([symbols.get('handler') as string], symbols);
		expect(handlerSrc).toMatch(READS_REQUEST_SQO);
		const extractorSrc = transitiveSource([symbols.get('extractor') as string], symbols);
		expect(extractorSrc).toContain('ddo_map');
	});
});
