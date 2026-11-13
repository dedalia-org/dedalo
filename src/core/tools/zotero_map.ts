/**
 * The Zotero field map — the tool_import_zotero config (Tools configuration
 * dd996 over the register default dd1633, resolved by `getToolConfig`) and the
 * mapping of one CSL-JSON item (csl_json.ts) onto a section's components. PURE:
 * the server resolves every target's model kind first and passes it in
 * (`ZoteroMapContext.kindOf`); nothing here reads the database.
 *
 * The config (PHP tool_import_zotero register, dd1633):
 *
 *   map:   [{name: <CSL variable>, ddo_map: [{tipo, section_tipo}, …]}]
 *          — `id` names the CODE component a re-import matches on; an entry
 *          whose second ddo is a child of its first (`parent`) is a LINK: the
 *          text is the name of a record of the second ddo's section (found,
 *          else created) and the first ddo stores the locator (container-title →
 *          Series).
 *   main:  [{name, tipo} | {name: 'field_to_section_id', value}] — `section`,
 *          `pdf`, `identifying_image`, `field_standard_number`, and the CSL
 *          variable (default `call-number`) whose value is the item's
 *          IDENTIFIER in the component the map binds it to (owner C18): a
 *          re-import finds the record holding it exactly, else creates one;
 *          the door refuses the ITEM when two records hold it. Never a
 *          section_id (PHP cast it to one — audit DATA-08).
 *   typology / standard_type: [{name, value: [locator…]}] — the CSL `type` and
 *          the ISBN/ISSN kind as list locators.
 *
 * Every value is emitted in the component's STORED JSON shape (`[{value}]`,
 * `[{iri}]`, `[{start, end?}]`, locator arrays), so the shared executor's
 * conform round-trips it (import_data.ts JSON branch) and never parses text.
 * WC-2026-11-12-zotero-csl-json-import.
 */

import { DedaloError } from '../errors/index.ts';
import {
	CSL_DATE_VARIABLES,
	CSL_NAME_VARIABLES,
	type CslItem,
	cslDate,
	cslDoiIri,
	cslNames,
	cslScalar,
	cslZoteroKey,
} from './csl_json.ts';
import { type ImportCodeTarget, textAsParagraph } from './import_code_lookup.ts';
import type { LinkField, MappedField } from './import_execute.ts';

/** Where an admin fixes the config — named by every config refusal. */
const CONFIG_HOME = 'the Tools configuration (dd996) / register default (dd1633)';

/** One `map` entry, validated. */
export interface ZoteroMapEntry {
	/** The CSL variable name ('title', 'author', 'container-title' …). */
	name: string;
	/** The component written (ddo_map[0].tipo). */
	tipo: string;
	/** Its section (ddo_map[0].section_tipo) — must be the imported section. */
	sectionTipo: string;
	/** A LINK entry's target: the named record's section + its name component. */
	link?: ImportCodeTarget;
}

/** The effective tool_import_zotero config. */
export interface ZoteroConfig {
	entries: ZoteroMapEntry[];
	/** The code component (the `id` entry) a re-import matches on. */
	idTarget?: ImportCodeTarget;
	typology: ReadonlyMap<string, unknown[]>;
	standardType: ReadonlyMap<string, unknown[]>;
	/** main.field_standard_number — the ISBN/ISSN kind (locators). */
	standardNumberTipo?: string;
	/** main.field_to_section_id — the CSL variable whose value is a second identifier (C18). */
	fieldToSectionId?: string;
	/**
	 * WHERE that identifier is looked up: the component the map binds
	 * `fieldToSectionId` to (its entry's first ddo). Set exactly when
	 * `fieldToSectionId` names a mapped variable other than `id`.
	 */
	identifierTarget?: ImportCodeTarget;
	/** main.section — must be the imported section. */
	mainSectionTipo?: string;
	/** main.pdf — the component_pdf the `archive` attachment goes to. */
	pdfTipo?: string;
	/** main.identifying_image — the component_image the PDF cover goes to. */
	imageTipo?: string;
}

/**
 * How a target component stores a value — what the mapper emits for it:
 * `text` `[{value}]`, `html` `[{value:'<p>…</p>'}]`, `iri` `[{iri}]`, `date` /
 * `date_range` `[{start, end?}]` (the end kept only for a range), `relation`
 * locators, `other` (none of these: a date of mode period/time, a number …).
 */
export type TargetKind = 'text' | 'html' | 'iri' | 'date' | 'date_range' | 'relation' | 'other';

export interface ZoteroMapContext {
	kindOf: ReadonlyMap<string, TargetKind>;
}

/** One CSL item mapped. */
export interface ZoteroMappedRecord {
	/** The Zotero item key (the `id` URI's last segment), or null without an `id`. */
	code: string | null;
	/** The raw `id` URI when it is not the key itself (the full-URL match leg). */
	url: string | null;
	/**
	 * The `field_to_section_id` variable's value (trimmed), or null without one —
	 * the item's identifier in `ZoteroConfig.identifierTarget`, resolved by the
	 * door through the code lookup (C18). Also written into that component.
	 */
	identifier: string | null;
	fields: MappedField[];
	links: LinkField[];
	/** The `archive` file name (a PDF staged in the same upload), or null. */
	archive: string | null;
	/** What this item lost on the way (a dropped range end, a season …). */
	notices: string[];
	/** CSL variables the map does not name — reported once per run. */
	unmapped: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configRefusal(where: string, why: string): DedaloError {
	const sentence = `Zotero config ${where} (${CONFIG_HOME}): ${why}`;
	return new DedaloError('request.invalid_options', { message: sentence, publicMessage: sentence });
}

/** One ddo row → `{tipo, section_tipo, parent?}`, or a refusal. */
function ddoOf(
	raw: unknown,
	where: string,
): { tipo: string; section_tipo: string; parent?: string } {
	if (!isPlainObject(raw) || typeof raw.tipo !== 'string' || typeof raw.section_tipo !== 'string') {
		throw configRefusal(where, `every ddo_map row needs 'tipo' and 'section_tipo'`);
	}
	return {
		tipo: raw.tipo,
		section_tipo: raw.section_tipo,
		...(typeof raw.parent === 'string' ? { parent: raw.parent } : {}),
	};
}

/** The entry's CSL name and its ddo rows, or a refusal naming the entry. */
function entryHead(raw: unknown, where: string): { name: string; ddoMap: unknown[] } {
	if (!isPlainObject(raw) || typeof raw.name !== 'string' || raw.name === '') {
		throw configRefusal(where, `an entry needs 'name' (the CSL variable)`);
	}
	if (!Array.isArray(raw.ddo_map) || raw.ddo_map.length === 0) {
		throw configRefusal(`${where} ('${raw.name}')`, `'ddo_map' must be a non-empty list`);
	}
	return { name: raw.name, ddoMap: raw.ddo_map };
}

/** A LINK's target: the second ddo, when it is a child of the first. */
function linkOf(
	first: { tipo: string },
	second: { tipo: string; section_tipo: string; parent?: string } | undefined,
): ImportCodeTarget | undefined {
	if (second === undefined || second.parent !== first.tipo) return undefined;
	return { sectionTipo: second.section_tipo, componentTipo: second.tipo };
}

/** One `map` entry → validated, or a refusal naming it. */
function parseMapEntry(raw: unknown, index: number): ZoteroMapEntry {
	const where = `map entry #${index}`;
	const { name, ddoMap } = entryHead(raw, where);
	const ddos = ddoMap.map((ddo) => ddoOf(ddo, `${where} ('${name}')`));
	const first = ddos[0] as { tipo: string; section_tipo: string };
	const link = linkOf(first, ddos[1]);
	return {
		name,
		tipo: first.tipo,
		sectionTipo: first.section_tipo,
		...(link === undefined ? {} : { link }),
	};
}

/** A `{name, value: [...]}` list entry. */
function isNamedList(entry: unknown): entry is { name: string; value: unknown[] } {
	return isPlainObject(entry) && typeof entry.name === 'string' && Array.isArray(entry.value);
}

/** `[{name, value:[…]}]` → name → value list. */
function parseNamedLists(raw: unknown, key: string): Map<string, unknown[]> {
	const lists = new Map<string, unknown[]>();
	if (raw === undefined) return lists;
	if (!Array.isArray(raw)) throw configRefusal(`'${key}'`, 'must be a list');
	for (const entry of raw) {
		if (!isNamedList(entry)) {
			throw configRefusal(`'${key}'`, `every entry must be {"name": …, "value": [locators]}`);
		}
		lists.set(entry.name, entry.value);
	}
	return lists;
}

/** One `main` entry's setting: its `tipo`, else its `value` (field_to_section_id); null for none. */
function mainEntrySetting(entry: unknown): { name: string; setting: string | null } {
	if (!isPlainObject(entry) || typeof entry.name !== 'string') {
		throw configRefusal(`'main'`, `every entry needs a 'name'`);
	}
	const setting = entry.tipo ?? entry.value;
	return { name: entry.name, setting: typeof setting === 'string' ? setting : null };
}

/** `main` → name → its `tipo` (or `value` for field_to_section_id). */
function parseMain(raw: unknown): Map<string, string> {
	const main = new Map<string, string>();
	if (raw === undefined) return main;
	if (!Array.isArray(raw)) throw configRefusal(`'main'`, 'must be a list');
	for (const entry of raw) {
		const { name, setting } = mainEntrySetting(entry);
		if (setting !== null) main.set(name, setting);
	}
	return main;
}

/** Copy `key` from `main` into `field` when set. */
function mainSetting<K extends keyof ZoteroConfig>(
	main: ReadonlyMap<string, string>,
	key: string,
	field: K,
): Partial<ZoteroConfig> {
	const value = main.get(key);
	return value === undefined ? {} : ({ [field]: value } as Partial<ZoteroConfig>);
}

/**
 * The Zotero config as the SERVER resolves it (`getToolConfig`, flat). REFUSES
 * (request.invalid_options, naming the entry and where the config lives) a
 * missing/empty `map`, a malformed entry or list, and a map without an `id`
 * entry: without a code component an import cannot recognise a record it
 * imported before, so every run would duplicate the library (PHP fataled on the
 * missing entry).
 */
export function readZoteroConfig(raw: Record<string, unknown>): ZoteroConfig {
	if (!Array.isArray(raw.map) || raw.map.length === 0) {
		throw configRefusal(
			`'map'`,
			'declares no CSL → component bindings for the Zotero import — author them there',
		);
	}
	const entries = raw.map.map(parseMapEntry);
	const id = entries.find((entry) => entry.name === 'id');
	if (id === undefined) {
		throw configRefusal(
			`'map'`,
			`no 'id' entry: the code component that stores the Zotero item key is what lets a re-import update the records it created instead of duplicating them`,
		);
	}
	const main = parseMain(raw.main);
	return {
		entries,
		idTarget: { sectionTipo: id.sectionTipo, componentTipo: id.tipo },
		typology: parseNamedLists(raw.typology, 'typology'),
		standardType: parseNamedLists(raw.standard_type, 'standard_type'),
		...mainSetting(main, 'field_standard_number', 'standardNumberTipo'),
		...mainSetting(main, 'field_to_section_id', 'fieldToSectionId'),
		...identifierTargetOf(entries, main.get('field_to_section_id')),
		...mainSetting(main, 'section', 'mainSectionTipo'),
		...mainSetting(main, 'pdf', 'pdfTipo'),
		...mainSetting(main, 'identifying_image', 'imageTipo'),
	};
}

/**
 * The component `main.field_to_section_id` is looked up in (C18): the map entry
 * of that variable. REFUSES a variable the map does not bind (there is no
 * component to search, so the identifier could only have been cast to an
 * address — the DATA-08 defect) or binds as a LINK (a name, not a code). `id`
 * itself is the key's own law; naming it here adds nothing.
 */
function identifierTargetOf(
	entries: readonly ZoteroMapEntry[],
	variable: string | undefined,
): Partial<ZoteroConfig> {
	if (variable === undefined || variable === 'id') return {};
	const entry = entries.find((candidate) => candidate.name === variable);
	if (entry === undefined) {
		throw configRefusal(
			`'main' field_to_section_id`,
			`names the CSL variable '${variable}', but the 'map' has no entry for it: add the entry whose component the identifier is looked up in`,
		);
	}
	if (entry.link !== undefined) {
		throw configRefusal(
			`'main' field_to_section_id`,
			`names '${variable}', a LINK entry — an identifier is looked up in a code component, not in a linked record's name`,
		);
	}
	return { identifierTarget: { sectionTipo: entry.sectionTipo, componentTipo: entry.tipo } };
}

/**
 * Every config section must be the IMPORTED one (`sectionTipo`): an entry's
 * component, `main.section`. A link's TARGET section may differ — that is what
 * a link is. Refused BEFORE any file is read: PHP wrote an entry's component on
 * a record id of the imported section, i.e. an unrelated record of another one.
 */
export function assertConfigSection(cfg: ZoteroConfig, sectionTipo: string): void {
	const foreign = cfg.entries.filter((entry) => entry.sectionTipo !== sectionTipo);
	if (cfg.mainSectionTipo !== undefined && cfg.mainSectionTipo !== sectionTipo) {
		throw configRefusal(
			`'main' section`,
			`names section ${cfg.mainSectionTipo}, but this import writes into ${sectionTipo}`,
		);
	}
	if (foreign.length > 0) {
		const names = foreign.map((entry) => `'${entry.name}' (${entry.sectionTipo})`).join(', ');
		throw configRefusal(
			`'map'`,
			`${names} write a component of another section than ${sectionTipo}, the one this import writes into — fix the ddo_map`,
		);
	}
}

/** The record's mapped fields, accumulated per component in item order. */
class FieldSet {
	private readonly byTipo = new Map<string, MappedField>();
	readonly refused: MappedField[] = [];

	/** One more stored-shape JSON value for `tipo` (several accumulate: ISBN + ISSN). */
	add(tipo: string, items: unknown[]): void {
		const json = JSON.stringify(items);
		const field = this.byTipo.get(tipo);
		if (field === undefined) this.byTipo.set(tipo, { component_tipo: tipo, values: [json] });
		else field.values.push(json);
	}

	refuse(tipo: string, raw: unknown, why: string): void {
		this.refused.push({ component_tipo: tipo, values: [JSON.stringify(raw)], refusal: why });
	}

	all(): MappedField[] {
		return [...this.byTipo.values(), ...this.refused];
	}
}

/** What the per-variable handlers share for one item. */
interface ItemScope {
	cfg: ZoteroConfig;
	ctx: ZoteroMapContext;
	fields: FieldSet;
	record: ZoteroMappedRecord;
}

/** Texts in the target's stored shape, or the refusal when the target holds no text. */
function textItems(kind: TargetKind | undefined, texts: readonly string[]): unknown[] | string {
	if (kind === 'iri') return texts.map((iri) => ({ iri }));
	if (kind === 'html') return texts.map((text) => ({ value: textAsParagraph(text) }));
	if (kind === 'text') return texts.map((value) => ({ value }));
	return `a text value cannot be stored in this component (${kind ?? 'unknown model'})`;
}

/** Write `texts` into `tipo` in its stored shape, or refuse the field. */
function addTexts(scope: ItemScope, tipo: string, texts: readonly string[], raw: unknown): void {
	const items = textItems(scope.ctx.kindOf.get(tipo), texts);
	if (typeof items === 'string') scope.fields.refuse(tipo, raw, items);
	else scope.fields.add(tipo, items);
}

/** Locators into a relation component, or refuse the field. */
function addLocators(scope: ItemScope, tipo: string, locators: unknown[], raw: unknown): void {
	if (scope.ctx.kindOf.get(tipo) !== 'relation') {
		scope.fields.refuse(tipo, raw, 'a list value needs a relation component');
		return;
	}
	scope.fields.add(tipo, locators);
}

/** `id` → the code (key) into the code component, and the record's match keys. */
function mapId(scope: ItemScope, entry: ZoteroMapEntry, value: unknown): void {
	const id = cslScalar(value);
	if (id === null || id.trim() === '') {
		scope.fields.refuse(entry.tipo, value, 'the item id is not a text');
		return;
	}
	const key = cslZoteroKey(id);
	scope.record.code = key;
	scope.record.url = id.trim() === key ? null : id.trim();
	addTexts(scope, entry.tipo, [key], value);
}

/** `type` → the configured typology locators (v6: the locators, never their text). */
function mapType(scope: ItemScope, entry: ZoteroMapEntry, value: unknown): void {
	const locators = scope.cfg.typology.get(String(value));
	if (locators === undefined) {
		scope.fields.refuse(
			entry.tipo,
			value,
			`the CSL type '${String(value)}' has no entry in the config 'typology'`,
		);
		return;
	}
	addLocators(scope, entry.tipo, locators, value);
}

/** ISBN / ISSN → the number, and the number's kind into main.field_standard_number. */
function mapStandardNumber(scope: ItemScope, entry: ZoteroMapEntry, value: unknown): void {
	mapScalar(scope, entry, value);
	const tipo = scope.cfg.standardNumberTipo;
	if (tipo === undefined) {
		scope.record.notices.push(
			`${entry.name}: the number kind was not recorded — the config 'main' names no field_standard_number`,
		);
		return;
	}
	const locators = scope.cfg.standardType.get(entry.name);
	if (locators === undefined) {
		scope.fields.refuse(
			tipo,
			entry.name,
			`the config 'standard_type' has no entry '${entry.name}'`,
		);
		return;
	}
	addLocators(scope, tipo, locators, entry.name);
}

/** A link entry → the named record's link (resolved by the executor, inside the record tx). */
function mapLink(scope: ItemScope, entry: ZoteroMapEntry, value: unknown): void {
	const text = cslScalar(value);
	if (entry.link === undefined || text === null) {
		scope.fields.refuse(entry.tipo, value, 'a link value must be the linked record name (a text)');
		return;
	}
	if (text.trim() === '') return;
	scope.record.links.push({ component_tipo: entry.tipo, target: entry.link, text: text.trim() });
}

/** A CSL name variable → one item per name. */
function mapNames(scope: ItemScope, entry: ZoteroMapEntry, value: unknown): void {
	const names = cslNames(value);
	if ('refusal' in names) scope.fields.refuse(entry.tipo, value, names.refusal);
	else if (names.length > 0) addTexts(scope, entry.tipo, names, value);
}

/** A CSL date variable → the date component's stored item. */
function mapDate(scope: ItemScope, entry: ZoteroMapEntry, value: unknown): void {
	const kind = scope.ctx.kindOf.get(entry.tipo);
	if (kind !== 'date' && kind !== 'date_range') {
		scope.fields.refuse(
			entry.tipo,
			value,
			'a CSL date needs a component_date of mode date or range',
		);
		return;
	}
	const date = cslDate(value, kind === 'date_range');
	if ('refusal' in date) {
		scope.fields.refuse(entry.tipo, value, date.refusal);
		return;
	}
	scope.record.notices.push(...date.notices.map((notice) => `${entry.name}: ${notice}`));
	scope.fields.add(entry.tipo, [date.item]);
}

/** Any other variable: a scalar text (DOI as its IRI). */
function mapScalar(scope: ItemScope, entry: ZoteroMapEntry, value: unknown): void {
	const text = cslScalar(value);
	if (text === null) {
		scope.fields.refuse(entry.tipo, value, `'${entry.name}' is not a text value`);
		return;
	}
	if (text.trim() === '') return;
	addTexts(scope, entry.tipo, [entry.name === 'DOI' ? cslDoiIri(text) : text], value);
}

/** How one mapped variable is written. */
type VariableHandler = (scope: ItemScope, entry: ZoteroMapEntry, value: unknown) => void;

/** The variables with a ROLE of their own (PHP's switch cases). */
const ROLE_HANDLERS: ReadonlyMap<string, VariableHandler> = new Map([
	['id', mapId],
	['type', mapType],
	['ISBN', mapStandardNumber],
	['ISSN', mapStandardNumber],
]);

/** One mapped variable's handler: by its role, then link, then its CSL kind. */
function handlerFor(entry: ZoteroMapEntry): VariableHandler {
	const role = ROLE_HANDLERS.get(entry.name);
	if (role !== undefined) return role;
	if (entry.link !== undefined) return mapLink;
	if (CSL_NAME_VARIABLES.has(entry.name)) return mapNames;
	return CSL_DATE_VARIABLES.has(entry.name) ? mapDate : mapScalar;
}

/**
 * The `field_to_section_id` variable (default `call-number`) — PHP's record
 * ADDRESS, cast to a section_id. Owner C18 (2026-11-13): its value is an
 * IDENTIFIER. It is written, TRIMMED ONLY, into the component the map binds it
 * to (`identifierTarget` — the same value the lookup searches, as the MARC `id`
 * entry), and carried as `record.identifier` for the door to resolve through
 * `findSectionIdByCode`. Never a section_id. Answers true when `name` is that
 * variable (and not `id`, whose own handler owns the key).
 */
function mapIdentifierVariable(
	scope: ItemScope,
	entry: ZoteroMapEntry,
	name: string,
	value: unknown,
): boolean {
	if (name !== scope.cfg.fieldToSectionId || name === 'id') return false;
	const text = cslScalar(value);
	if (text === null) {
		scope.fields.refuse(entry.tipo, value, `'${name}' (the record identifier) is not a text value`);
		return true;
	}
	const identifier = text.trim();
	if (identifier === '') return true;
	scope.record.identifier = identifier;
	addTexts(scope, entry.tipo, [identifier], value);
	return true;
}

/** `archive` is the PDF attachment, imported after the record commits — never a field. */
function mapArchive(scope: ItemScope, value: unknown): void {
	const file = cslScalar(value);
	if (file !== null && file.trim() !== '') scope.record.archive = file.trim();
}

/** Map one CSL item onto the configured components (variables in item order). */
export function mapCslItem(
	item: CslItem,
	cfg: ZoteroConfig,
	ctx: ZoteroMapContext,
): ZoteroMappedRecord {
	const record: ZoteroMappedRecord = {
		code: null,
		url: null,
		identifier: null,
		fields: [],
		links: [],
		archive: null,
		notices: [],
		unmapped: [],
	};
	const scope: ItemScope = { cfg, ctx, fields: new FieldSet(), record };
	const byName = new Map(cfg.entries.map((entry) => [entry.name, entry]));
	for (const [name, value] of Object.entries(item)) {
		const entry = byName.get(name);
		if (entry === undefined) record.unmapped.push(name);
		else if (mapIdentifierVariable(scope, entry, name, value)) continue;
		else if (name === 'archive') mapArchive(scope, value);
		else handlerFor(entry)(scope, entry, value);
	}
	record.fields = scope.fields.all();
	return record;
}
