/**
 * tool_import_marc21 server module (PHP tool_import_marc21). import_files parses
 * the staged MARC21 (ISO 2709) files with the from-scratch parser (marc21.ts, no
 * 3rd-party lib), applies the marc21_map (tool_config.config.map: field/subfield
 * → component tipo, + config.main's field_to_section_id) to each record, and
 * imports the mapped records through the shared executor (conform +
 * createSectionRecord + saveComponentData — the same write path the CSV import
 * scratch-twin-verifies).
 *
 * STAGED-FILE WIRE (PHP prepare_import_context :218 + process_marc21_file :294):
 * the client posts `key_dir` ONCE at the TOP LEVEL of options and each
 * `files_data[]` entry carries only `{name, size, …}` — the service_dropzone
 * descriptor. So the staged path is rebuilt as
 * `<staging root>/<ctx.userId>/<sanitized key_dir>/<staged name>`, never from a
 * client-supplied directory, and the resolved path is re-confined under the
 * user's staging dir (PHP sanitize_key_dir + safe_upload_target).
 *
 * THE IDENTIFIER IS AN IDENTIFIER (audit DATA-08, closed 2026-08-30). The
 * `field_to_section_id` value is a LIBRARY CONTROL NUMBER, and this door
 * resolves it the way `resolve_target_section` did: through the section's CODE
 * component (`findSectionIdByCode`, the `id` map entry's ddo_map), to an
 * existing record or to none — in which case the executor creates one. It is
 * never cast to a section_id. The header used to document the opposite against
 * itself ("the field_to_section_id value is used here as the section_id
 * directly"), which is exactly what it did: '42' wrote onto record 42.
 *
 * CONFIG IS SERVER-SIDE (T1-6, PHP tool_common::get_config): `map` and `main`
 * come from the Tools configuration (dd996), else the register default
 * (dd1633), per key (`getToolConfig`). The client-posted `tool_config` is read
 * for its `ddo_map` ONLY (the Values form); a posted `map`/`main` is ignored —
 * a client-chosen field map would let any level-2 caller pick which components
 * a file (and `dd_action`/`dd_data_map` locators) writes. A background run reads
 * the config when it RUNS, not when it was queued.
 *
 * PORTED VALUE SEMANTICS (marc21.ts; reference: v6 class.tool_import_marc21.php
 * — frozen v7 `prepare_import_context` reads `$config->config->main` off the
 * ARRAY `get_config` returns, so frozen v7 imported nothing): first occurrence
 * per tag (`occurrences:'all'` opts one tag into every occurrence — owner C17),
 * `field_multiple` + `row_separator`, `marc21_conditional` WITHOUT the PHP
 * fallback (no guarded occurrence → no value — owner C16), the transforms (trailing punctuation,
 * partial_left_content, date_format 'year', dd_data_map, dd_action), last-wins
 * for a tipo bound twice, and the Values form (`input_component`) applied to
 * every imported record. Divergences, each deliberate
 * (WC-2026-11-12-marc21-config-map-and-transforms): '0' is a value; a year <= 0
 * and a dd_data_map miss are REFUSED per field (PHP stored an empty date / the
 * raw code); the `id` entry is not punctuation-stripped; control fields (00X)
 * are readable; unknown config keys and malformed transforms REFUSE the run by
 * name; a Values field of another section is refused (PHP wrote that section's
 * record of the same number).
 */

import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { stagingDir } from '../../../src/core/media/ingest/add_file.ts';
import { resolveStagedName } from '../../../src/core/media/ingest/staged_files.ts';
import { getToolConfig } from '../../../src/core/tools/config.ts';
import {
	type ImportCodeTarget,
	resolveMappedCodes,
} from '../../../src/core/tools/import_code_lookup.ts';
import {
	importMappedRecords,
	type MappedField,
	type MappedRecord,
} from '../../../src/core/tools/import_execute.ts';
import {
	type FormDdo,
	formValueFields,
	type TempDataEntry,
} from '../../../src/core/tools/import_form_values.ts';
import {
	applyMarcMap,
	type MarcMapEntry,
	type MarcMappedRecord,
	type MarcValueSpec,
	marcSpecLabel,
	parseMarc,
} from '../../../src/core/tools/marc21.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
	type WriteTarget,
} from '../../../src/core/tools/module.ts';

/**
 * A caller fault. `message` AND `publicMessage`: import_files is
 * backgroundRunnable, and the executor records the converter's wire sentence
 * on the job (background.ts `wireMessage`: this `publicMessage`, the code's
 * disclosure being public) — `message` is the log line only.
 */
function invalidRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/** The tool's name — its config key in dd996 / dd1324. */
const TOOL_NAME = 'tool_import_marc21';

/** Where an admin fixes the map — named by every config refusal. */
const CONFIG_HOME = 'the Tools configuration (dd996) / register default (dd1633)';

/**
 * Every key a map entry may carry (PHP transform_marc21_value + get_value +
 * the `id` role). An unknown key REFUSES the run, naming it: PHP ignored a
 * typo'd `date_fromat`, and the import silently stored the raw text.
 */
const MAP_ENTRY_KEYS: ReadonlySet<string> = new Set([
	'info',
	'name',
	'tipo',
	'ddo_map',
	'field',
	'subfield',
	'subfield_separator',
	'field_multiple',
	'row_separator',
	/** `'all'`: every occurrence of the ONE tag joined by row_separator (owner C17). */
	'occurrences',
	'marc21_conditional',
	/** Accepted and inert: frozen PHP could never reach it (its own `(!)` note). */
	'skip_on_empty',
	'partial_left_content',
	'date_format',
	'dd_data_map',
	'dd_action',
]);

/** The effective marc21 config: the bindings, the identifier spec and its code component. */
export interface MarcConfig {
	entries: MarcMapEntry[];
	idSpec?: MarcValueSpec;
	/**
	 * WHERE the `field_to_section_id` value is looked up: the code component
	 * named by the `id` map entry's first ddo_map row (PHP
	 * get_section_id_from_code reads exactly `reset($id_item->ddo_map)`).
	 * Undefined when the config declares no such entry — which, when an id field
	 * IS configured, is a refusal at the door and never a fallback to "use the
	 * value as an address" (audit DATA-08).
	 */
	idTarget?: ImportCodeTarget;
}

type Refuse = (why: string) => never;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A refusal naming the entry (`#index` + its `info`) and the config home. */
function entryRefusal(where: string): Refuse {
	return (why) => {
		throw invalidRequest(`marc21 config ${where} (${CONFIG_HOME}): ${why}`);
	};
}

function optionalString(raw: Record<string, unknown>, key: string, refuse: Refuse): void {
	if (raw[key] !== undefined && typeof raw[key] !== 'string') refuse(`'${key}' must be a string`);
}

/** `field`: one tag, or (with `field_multiple`) a non-empty list of tags. */
function parseField(raw: Record<string, unknown>, refuse: Refuse): string | string[] {
	const field = raw.field;
	if (typeof field === 'string' && field !== '') return field;
	if (!Array.isArray(field)) return refuse(`'field' must be a MARC tag or a list of tags`);
	if (raw.field_multiple !== true) {
		return refuse(`'field' is a list of tags but 'field_multiple' is not true`);
	}
	if (field.length === 0 || !field.every((tag) => typeof tag === 'string' && tag !== '')) {
		return refuse(`'field' must be a non-empty list of MARC tags`);
	}
	return field as string[];
}

/** `marc21_conditional`: `{subfield, value}`, on ONE tag with a target subfield. */
function parseConditional(
	raw: Record<string, unknown>,
	refuse: Refuse,
): { subfield: string; value: string } | undefined {
	const cond = raw.marc21_conditional;
	if (cond === undefined) return undefined;
	if (!isPlainObject(cond) || typeof cond.subfield !== 'string' || typeof cond.value !== 'string') {
		return refuse(`'marc21_conditional' must be {"subfield": "<code>", "value": "<text>"}`);
	}
	if (typeof raw.field !== 'string' || raw.field_multiple === true) {
		return refuse(`'marc21_conditional' reads ONE tag: it cannot combine with 'field_multiple'`);
	}
	if (typeof raw.subfield !== 'string') {
		return refuse(`'marc21_conditional' needs the 'subfield' it reads from the matching field`);
	}
	return { subfield: cond.subfield, value: cond.value };
}

/** A field/subfield spec (a map entry's, or `main.field_to_section_id.value`). */
function parseSpec(raw: Record<string, unknown>, refuse: Refuse): MarcValueSpec {
	for (const key of ['subfield', 'subfield_separator', 'row_separator']) {
		optionalString(raw, key, refuse);
	}
	if (raw.field_multiple !== undefined && typeof raw.field_multiple !== 'boolean') {
		refuse(`'field_multiple' must be true or false`);
	}
	if (raw.occurrences !== undefined && raw.occurrences !== 'all') {
		refuse(`'occurrences' supports only "all" (the default reads the first occurrence)`);
	}
	const conditional = parseConditional(raw, refuse);
	if (raw.occurrences === 'all' && conditional !== undefined) {
		refuse(`'occurrences' cannot combine with 'marc21_conditional', which reads ONE occurrence`);
	}
	return {
		field: parseField(raw, refuse),
		...(raw.field_multiple === true ? { field_multiple: true } : {}),
		...(raw.occurrences === 'all' ? { occurrences: 'all' as const } : {}),
		...(typeof raw.row_separator === 'string' ? { row_separator: raw.row_separator } : {}),
		...(typeof raw.subfield === 'string' ? { subfield: raw.subfield } : {}),
		...(typeof raw.subfield_separator === 'string'
			? { subfield_separator: raw.subfield_separator }
			: {}),
		...(conditional === undefined ? {} : { marc21_conditional: conditional }),
	};
}

/** `{key: [data…]}` — the dd_data_map / dd_action shape. */
function parseDataTable(
	raw: Record<string, unknown>,
	key: 'dd_data_map' | 'dd_action',
	refuse: Refuse,
): Record<string, unknown[]> | undefined {
	const table = raw[key];
	if (table === undefined) return undefined;
	if (!isPlainObject(table) || !Object.values(table).every(Array.isArray)) {
		return refuse(`'${key}' must be an object whose every value is a list (the stored data)`);
	}
	return table as Record<string, unknown[]>;
}

/** The value transforms (PHP transform_marc21_value), validated. */
function parseTransforms(raw: Record<string, unknown>, refuse: Refuse): Partial<MarcMapEntry> {
	const partial = raw.partial_left_content;
	if (partial !== undefined && !(Number.isInteger(partial) && (partial as number) > 0)) {
		refuse(`'partial_left_content' must be a positive integer`);
	}
	if (raw.date_format !== undefined && raw.date_format !== 'year') {
		refuse(`'date_format' supports only "year"`);
	}
	if (raw.skip_on_empty !== undefined && typeof raw.skip_on_empty !== 'boolean') {
		refuse(`'skip_on_empty' must be true or false`);
	}
	const dataMap = parseDataTable(raw, 'dd_data_map', refuse);
	if (raw.date_format !== undefined && dataMap !== undefined) {
		refuse(`'date_format' and 'dd_data_map' cannot both apply to one value`);
	}
	const action = parseDataTable(raw, 'dd_action', refuse);
	return {
		...(partial === undefined ? {} : { partial_left_content: partial as number }),
		...(raw.date_format === 'year' ? { date_format: 'year' as const } : {}),
		...(dataMap === undefined ? {} : { dd_data_map: dataMap }),
		...(action === undefined ? {} : { dd_action: action }),
	};
}

/** One `config.map` entry → a validated binding, or a refusal naming it. */
function parseMapEntry(raw: unknown, index: number): MarcMapEntry {
	const info = isPlainObject(raw) && typeof raw.info === 'string' ? ` ('${raw.info}')` : '';
	const refuse = entryRefusal(`map entry #${index}${info}`);
	if (!isPlainObject(raw)) return refuse('an entry must be an object');
	const unknown = Object.keys(raw).filter((key) => !MAP_ENTRY_KEYS.has(key));
	if (unknown.length > 0) refuse(`unknown key(s) ${unknown.map((k) => `'${k}'`).join(', ')}`);
	optionalString(raw, 'info', refuse);
	optionalString(raw, 'name', refuse);
	if (typeof raw.tipo !== 'string' || raw.tipo === '') {
		return refuse(`'tipo' (the target component) is required`);
	}
	return {
		component_tipo: raw.tipo,
		...parseSpec(raw, refuse),
		...parseTransforms(raw, refuse),
		...(raw.name === 'id' ? { is_id: true } : {}),
	};
}

/** The `id` entry's ddo_map code component (PHP `reset($id_item->ddo_map)`). */
function parseIdTarget(map: readonly unknown[]): ImportCodeTarget | undefined {
	const idEntry = map.find((entry) => isPlainObject(entry) && entry.name === 'id') as
		| { ddo_map?: unknown }
		| undefined;
	const ddo = Array.isArray(idEntry?.ddo_map)
		? (idEntry.ddo_map[0] as { tipo?: unknown; section_tipo?: unknown } | undefined)
		: undefined;
	return typeof ddo?.tipo === 'string' && typeof ddo?.section_tipo === 'string'
		? { sectionTipo: ddo.section_tipo, componentTipo: ddo.tipo }
		: undefined;
}

/** `main.field_to_section_id.value` — the identifier spec, validated. */
function parseIdSpec(main: unknown): MarcValueSpec | undefined {
	if (main === undefined) return undefined;
	const refuse = entryRefusal(`'main'`);
	if (!Array.isArray(main)) return refuse(`'main' must be a list`);
	const idEntry = main.find((e) => isPlainObject(e) && e.name === 'field_to_section_id') as
		| { value?: unknown }
		| undefined;
	if (idEntry === undefined) return undefined;
	if (!isPlainObject(idEntry.value)) {
		return refuse(`'field_to_section_id' needs a 'value' {"field": …, "subfield": …}`);
	}
	return parseSpec(idEntry.value, entryRefusal(`main 'field_to_section_id'`));
}

/**
 * The marc21 config as the SERVER resolves it (`getToolConfig`: dd996 per key
 * over dd1633): `map` holds the field→component bindings (PHP $context->map),
 * `main` the global settings — among them `field_to_section_id`. Validates every
 * entry and REFUSES (request.invalid_options) a missing/empty map, an entry
 * without a target, a malformed field/transform, and any unknown key — each
 * refusal names the entry and where the config lives.
 */
export function parseMarcConfig(config: Record<string, unknown>): MarcConfig {
	const map = config.map;
	if (!Array.isArray(map) || map.length === 0) {
		throw invalidRequest(
			`Missing marc21_map: ${CONFIG_HOME} declares no 'map' for ${TOOL_NAME} — author the field→component bindings there.`,
		);
	}
	const entries = map.map(parseMapEntry);
	const idSpec = parseIdSpec(config.main);
	const idTarget = parseIdTarget(map);
	return {
		entries,
		...(idSpec === undefined ? {} : { idSpec }),
		...(idTarget === undefined ? {} : { idTarget }),
	};
}

/** The client `tool_config.ddo_map` (the Values form's fields) — the only client config read. */
function clientDdoMap(toolConfig: unknown): FormDdo[] {
	const ddoMap = isPlainObject(toolConfig) ? toolConfig.ddo_map : undefined;
	return Array.isArray(ddoMap) ? (ddoMap as FormDdo[]) : [];
}

/**
 * Resolve ONE staged file inside the user's staging dir, or null when the name
 * is not stageable there.
 *
 * The staged name is SERVER-ASSIGNED since 2026-08-03 (two client names that
 * sanitize alike now yield `x.mrc` and `x-1.mrc`), so the authoritative source
 * is the `tmp_name` this tool's client forwards per entry. `resolveStagedName`
 * takes it when present and falls back to the legacy transform otherwise —
 * THROWING rather than guessing when collision-suffixed candidates exist.
 *
 * THE `null` RETURN IS CURRENTLY UNREACHABLE, and is kept deliberately. Both
 * branches of `resolveStagedName` now produce a name that cannot escape: a
 * forwarded value goes through `sanitizeSegment` (which THROWS on '', '.', '..',
 * NUL, '/' and anything outside [A-Za-z0-9_.-]), and the legacy transform
 * rewrites every other character to '_' and prefixes a leading dot, so '..'
 * becomes '_..'. No input reaches `resolve(dir, name)` with a traversal left in
 * it. Stating that here rather than deleting the check, because it is the last
 * line of a confinement guarantee and the transforms in front of it are two
 * modules away; the gate that replaces the lost branch coverage asserts the
 * INVARIANT instead (test/unit/tool_import_marc21.test.ts: no hostile client
 * name resolves outside `dir`).
 */
export function resolveStagedFile(
	dir: string,
	clientName: string,
	tmpName?: string | null,
): string | null {
	const target = resolve(dir, resolveStagedName(dir, clientName, tmpName));
	if (!target.startsWith(dir + sep)) return null;
	return target;
}

async function importFiles(ctx: ToolActionContext): Promise<ToolResponse> {
	const o = ctx.options;
	const sectionTipo = String(o.section_tipo ?? '');
	const filesData = (o.files_data ?? []) as { name?: string; tmp_name?: string | null }[];
	if (sectionTipo === '' || filesData.length === 0) {
		throw invalidRequest('Missing section_tipo or files_data');
	}
	// The map is the SERVER's (dd996 over dd1633, per key) — never the client's.
	const { entries, idSpec, idTarget } = parseMarcConfig(await getToolConfig(TOOL_NAME));
	// THE CONFIG DECIDES HOW AN IDENTIFIER RESOLVES — never the value's shape
	// (audit DATA-08). A config that says "match records by 907$a" but never says
	// WHERE that code is stored cannot be honoured: the only two answers left are
	// "create a duplicate for every record" and "use the control number as a
	// section_id", and the second is the defect this refusal exists to end. So the
	// run stops here, before a single file is read, naming what to author.
	if (idSpec !== undefined && idTarget === undefined) {
		throw invalidRequest(
			`The marc21 config reads the record identifier from ${marcSpecLabel(idSpec)} ` +
				`(main.field_to_section_id) but declares no code component to match it against: ` +
				`add the map entry {"name":"id","ddo_map":[{"section_tipo":"${sectionTipo}","tipo":"<code component>"}]}. ` +
				`An identifier is matched against the section's code component, never used as a record id.`,
		);
	}
	if (idTarget !== undefined && idTarget.sectionTipo !== sectionTipo) {
		throw invalidRequest(
			`The marc21 config's id ddo_map points at section ${idTarget.sectionTipo}, but this import ` +
				`writes into ${sectionTipo}. Resolving an identifier in one section to address a record in ` +
				`another names an unrelated record; fix the ddo_map.`,
		);
	}

	// The Values form, read ONCE before any file is read or any record written: a
	// refused form field (another section) writes nothing at all.
	const formFields = formValueFields(
		clientDdoMap(o.tool_config),
		(Array.isArray(o.components_temp_data) ? o.components_temp_data : []) as TempDataEntry[],
		sectionTipo,
		`${TOOL_NAME}.import_files`,
	);

	// key_dir is TOP-LEVEL and server-sanitized; the dir is rebuilt from the
	// CURRENT user id, so no payload can reach another user's staged uploads.
	const dir = stagingDir(ctx.userId, String(o.key_dir ?? ''));

	const errors: string[] = [];
	const mapped: MarcMappedRecord[] = [];
	for (const file of filesData) {
		// The client URI-encodes the display name (JSON/HTTP safety); decode
		// defensively, since a bare '%' is not a valid escape sequence.
		const rawName = String(file.name ?? '');
		let name: string;
		try {
			name = decodeURIComponent(rawName);
		} catch {
			name = rawName;
		}
		// PHP filter_marc21_files: .mrc (binary ISO 2709) only; other uploads in
		// the same dropzone batch are not MARC21 and are silently passed over.
		if (!name.toLowerCase().endsWith('.mrc')) continue;
		let staged: string | null;
		try {
			// tmp_name is the SERVER-assigned staged name, forwarded per entry by
			// this tool's client. An entry without one falls back to the legacy
			// derivation, which refuses (throws) rather than guess.
			staged = resolveStagedFile(dir, name, file.tmp_name ?? null);
		} catch (error) {
			errors.push(`${name}: ${(error as Error).message}`);
			continue;
		}
		if (staged === null) {
			errors.push(`${name}: invalid file name`);
			continue;
		}
		if (!existsSync(staged)) {
			errors.push(`${name}: staged file not found`);
			continue;
		}
		const bytes = new Uint8Array(await Bun.file(staged).arrayBuffer());
		const { records, errors: parseErrors } = parseMarc(bytes);
		errors.push(...parseErrors.map((e) => `${name}: ${e}`));
		for (const record of records) mapped.push(applyMarcMap(record, entries, idSpec));
	}

	// The identifiers become addresses HERE, once, before anything is written.
	// (import_code_lookup.ts resolveMappedCodes: exact, scoped, a batch duplicate refuses the run.)
	const resolved = await resolveMappedCodes(mapped, sectionTipo, idTarget, ctx.principal);
	const records = withFormValues(resolved, formFields);
	const report = await importMappedRecords(records, sectionTipo, ctx.principal);
	// CONSUME the staging form (WC-079). This tool's client builds a
	// service_tmp_section, so it accumulates scratch rows under its own scope —
	// clearing here is what stops the next batch inheriting this run's values,
	// which `withFormValues` has just APPLIED to every record written.
	// Best effort. Only when something was ACTUALLY created or updated: a run where every
	// record failed still returns result:true, and clearing on that would wipe
	// the form after writing nothing.
	if (report.created + report.updated > 0) {
		try {
			const { clearTemporalScratch } = await import(
				'../../../src/core/section/record/temporal_store.ts'
			);
			await clearTemporalScratch(ctx.userId, 'tool_import_marc21');
		} catch (error) {
			console.warn('[tool_import_marc21] scratch clear failed:', (error as Error).message);
		}
	}
	// A per-file failure never fails the batch: the summary and both failure
	// lists are PAYLOAD.
	return ok(
		{
			summary: `OK. MARC21 import done. Created ${report.created}, updated ${report.updated}${report.failed.length > 0 ? `, ${report.failed.length} failed` : ''}.`,
			errors,
			created: report.created,
			updated: report.updated,
			failed: report.failed,
		},
		{ requestId: toolRequestId(ctx) },
	);
}

/**
 * The Values form APPLIED (PHP v6 :270-310): after a record's mapped fields,
 * every non-empty `input_component` field — so a form value wins over a mapped
 * value of the same component, PHP's order.
 */
function withFormValues(
	records: readonly MappedRecord[],
	formFields: readonly MappedField[],
): MappedRecord[] {
	if (formFields.length === 0) return [...records];
	return records.map((record) => ({ ...record, fields: [...record.fields, ...formFields] }));
}

/**
 * The WRITE TARGETS a MARC21 import can name BEFORE it runs — what the
 * 'targets' gate authorizes (audit CARRY-08 / TOOLS-04): the caller pair, plus
 * every `input_component` row of the client `tool_config.ddo_map` (the Values
 * form, written into each imported record).
 *
 * The FIELD MAP's components are not here: since T1-6 the map is the server's
 * (dd996 / dd1633), read by the handler at run time — this extractor is pure
 * over the options and may not read the database (module.ts `targets`). They
 * are RE-AUTHORIZED IN THE HANDLER: the shared executor asks the write door for
 * every mapped field of every record (import_execute.ts `fieldRefusal` →
 * `authorizeImportField`), so a component the caller may not write is reported
 * IGNORED and never written. The id ddo_map's own section is pinned to the
 * import section by the handler (`idTarget.sectionTipo !== sectionTipo` is
 * refused), and a Values field of another section is refused before any write.
 */
export function importMarc21Targets(options: Record<string, unknown>): WriteTarget[] {
	const formTargets = clientDdoMap(options.tool_config)
		.filter((ddo) => ddo?.role === 'input_component')
		.map((ddo) => ({ section_tipo: ddo.section_tipo, tipo: ddo.tipo }));
	return [{ section_tipo: options.section_tipo, tipo: options.tipo }, ...formTargets];
}

export const tool: ToolServerModule = {
	name: 'tool_import_marc21',
	apiActions: {
		import_files: {
			permission: 'targets',
			minLevel: 2,
			targets: importMarc21Targets,
			handler: importFiles,
		},
	},
	backgroundRunnable: ['import_files'],
	// A bulk import — operator work (PERF-11 lane declaration).
	backgroundLanes: { import_files: 'maintenance' },
};
