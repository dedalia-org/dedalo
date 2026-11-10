/**
 * TAGS_INFO — the RESOLVED tag payload of one transcription (PHP
 * dd_component_text_area_api::get_tags_info, which delegated to
 * component_text_area::get_tags_data_as_terms / get_annotations /
 * get_tags_persons).
 *
 * A transcription's text carries only tag MARKS — `[index-n-58-…]`,
 * `[note-a-3-data:{'section_tipo':'rsc326',…}:data]`. What each mark MEANS
 * (which thesaurus term the index points at, what the note says) lives in
 * other records, so any consumer that must display tags asks this feed once
 * and resolves every mark locally instead of one request per mark. Its only
 * caller today is `tool_tr_print` (the print/read layout).
 *
 * WHERE each type comes from is declared in the text_area's ontology
 * `properties` — a missing property means "this install does not use that tag
 * type", and the key is simply ABSENT from the result (PHP `isset` gating):
 *
 *   tags_index     {tipo:'rsc860', …}  the portal holding the index locators
 *   tags_reference {tipo:'rsc1368', …} same shape, reference tags
 *   tags_notes     {<section_tipo>:[{id,type,component_tipo}]} note ddo_map
 *   tags_persons   see tags_persons.ts (shared with the EDIT emit feed)
 *
 * Wire law (WC-2026-08-10-section-id-int-canonical, repealing the STRING half
 * of WC-077/WC-065 for record addresses): every `section_id` in the PAYLOAD is
 * emitted in canonical form — a stored numeric string becomes an int, while an
 * external remote id ('001338683', 'Q42') survives verbatim.
 *
 * `tag_id` STAYS A STRING and is NOT part of that repeal: tool_tr_print matches
 * it with strict `===` against a group captured out of the text by regex
 * (render_tool_tr_print.js `el.data.tag_id === tag_id`), so it is a text token,
 * not a record address. The note lookup on the same page already compares
 * addresses with `parseInt()` on both sides, so int ids match there.
 *
 * READ DOOR (WC-2026-11-10-tags-info-read-door). The HOST door (section >= 1,
 * the text_area's pair grant, the record scope) is the API handler's; every
 * HOP this feed takes into OTHER data is gated here, with the principal THREADED
 * IN as a parameter (never ambient), through the read door's own helpers
 * (security/read_door.ts doorComponentAllowed — the loud refusal recorder):
 *   - a NOTE record: each `tags_notes` ddo's (note section, component) pair
 *     grant + the note record's scope. A refused note is DROPPED and its id
 *     named in `withheld_notes` (owner OD-2 (a));
 *   - index / reference: the HOST tag-source component (`tags_<type>.tipo`)
 *     needs its own pair grant on the host section; refused → the type's key
 *     is absent and the refusal recorded. Term LABELS pass "as displayed"
 *     (owner OD-3 (a), the D4 export precedent) — no per-term section grant;
 *   - persons: the inverse related search runs SCOPED to the principal.
 * `principal` undefined = an INTERNAL read (the read door's convention): no gate.
 *
 * (!) The IN-TEXT tag MARKERS (`[note-a-3-data:{'section_id':'12'}:data]`) keep
 * their historical string serialization — those bytes live inside stored text
 * scalars and publication v1 LIKE-probes them. Only the resolved payload built
 * here is canonicalized.
 */

import type { Locator, StoredSectionId } from '../../concepts/locator.ts';
import { compareLocators } from '../../concepts/locator.ts';
import { canonicalizeStoredSectionId } from '../../concepts/section_id.ts';
import type { MatrixRecord } from '../../db/matrix.ts';
import { readMatrixRecord } from '../../db/matrix.ts';
import { getEffectivePropertiesByTipo } from '../../ontology/alias.ts';
import {
	getMatrixTableFromTipo,
	getModelByTipo,
	getTranslatableByTipo,
} from '../../ontology/resolver.ts';
import { filterItemsByLang, readComponentItems } from '../../resolve/component_data.ts';
import { currentDataLang } from '../../resolve/request_lang.ts';
import { NOTE_PATTERN } from '../../resolve/tr_marks.ts';
import { noteFrontierRefusal } from '../../security/frontier_scope.ts';
import type { Principal } from '../../security/permissions.ts';
import { doorComponentAllowed, type ReadDoorScope } from '../../security/read_door.ts';
import { principalCanAccessRecord } from '../../security/record_scope.ts';
import { getTermByLocator } from '../../ts_object/term_resolver.ts';
import type { PersonTagElement } from './tags_persons.ts';

/** PHP DEDALO_DATA_NOLAN — the lang of a non-translatable component. */
const NOLAN = 'lg-nolan';
/** component_publication 'yes' term (dd64/1) — a `type:'bool'` note ddo is true. */
const PUBLICATION_YES_ID = '1';

/** `properties.tags_index` / `properties.tags_reference`. */
interface TagsPointerConfig {
	/** The component holding the tag locators (a portal / autocomplete_hi). */
	tipo?: string;
}

/** One entry of `properties.tags_notes[<section_tipo>]`. */
interface NoteDdo {
	/** Output key on the note object ('title', 'body', 'publishable', …). */
	id?: string;
	/** 'text' → raw values; 'bool' → publication-state boolean. */
	type?: string;
	component_tipo?: string;
	section_tipo?: string;
}

interface TextAreaTagProperties {
	tags_index?: TagsPointerConfig;
	tags_reference?: TagsPointerConfig;
	tags_notes?: Record<string, NoteDdo[]>;
	tags_persons?: Record<string, import('./tags_persons.ts').TagsPersonsConfigEntry[]>;
}

/** A stored tag locator, normalized to canonical ids (see the module wire law). */
export interface TagLocator {
	section_tipo: string;
	/** Canonical int for a matrix address; verbatim string for a remote id. */
	section_id: StoredSectionId;
	component_tipo?: string;
	tag_id?: string;
	type?: string;
	[key: string]: unknown;
}

/** One resolved index/reference tag: the stored locator + its term label. */
export interface TagTermElement {
	data: TagLocator;
	label: string | null;
}

/** One resolved annotation: the note locator + one key per note ddo. */
export interface NoteElement {
	data: TagLocator;
	[ddoId: string]: unknown;
}

export interface TagsInfo {
	tags_index?: TagTermElement[];
	tags_reference?: TagTermElement[];
	tags_notes?: NoteElement[];
	tags_persons?: PersonTagElement[];
}

/** The record coordinates a tags_info build runs against. */
export interface TagsInfoHost {
	/** The text_area component tipo (whose properties declare the tag config). */
	tipo: string;
	section_tipo: string;
	/**
	 * The HOST is always a matrix record, so its address is an int
	 * (WC-2026-08-10-section-id-int-canonical): the one caller —
	 * dd_component_text_area_api.get_tags_info — coerces at the door.
	 */
	section_id: number;
}

/** The door name every hop refusal of this feed is logged under. */
const TAGS_INFO_DOOR = 'dd_component_text_area_api.get_tags_info';

/**
 * Every well-formed ddo's (note section, component) pair is readable — the
 * read door records each refusal itself.
 */
async function noteDdosGranted(
	scope: ReadDoorScope,
	locator: TagLocator,
	ddoMap: readonly NoteDdo[],
): Promise<boolean> {
	for (const ddo of ddoMap) {
		if (!isNoteDdo(ddo)) continue;
		const allowed = await doorComponentAllowed(scope, {
			sectionTipo: locator.section_tipo,
			componentTipo: ddo.component_tipo,
			sectionId: locator.section_id,
		});
		if (!allowed) return false;
	}
	return true;
}

/** A ddo that names both its output key and its component. */
function isNoteDdo(
	ddo: NoteDdo | undefined,
): ddo is NoteDdo & { id: string; component_tipo: string } {
	return typeof ddo?.id === 'string' && typeof ddo.component_tipo === 'string';
}

/**
 * May the caller read this NOTE record through its ddo map? Every ddo's
 * (note section, component) pair (section >= 1 + the component's own grant)
 * AND the record scope. Internal reads (no principal) gate nothing.
 */
async function noteReadable(
	scope: ReadDoorScope,
	locator: TagLocator,
	ddoMap: readonly NoteDdo[],
): Promise<boolean> {
	const principal = scope.principal;
	if (principal === undefined) return true;
	if (!(await noteDdosGranted(scope, locator, ddoMap))) return false;
	const id = Number(locator.section_id);
	if (
		Number.isInteger(id) &&
		(await principalCanAccessRecord(locator.section_tipo, id, principal))
	) {
		return true;
	}
	noteFrontierRefusal(
		{ principal, surface: 'door', door: scope.door },
		{
			surface: 'door',
			door: scope.door,
			sectionTipo: locator.section_tipo,
			sectionId: locator.section_id,
			key: 'record',
		},
	);
	return false;
}

/** Read one record, tolerating a section whose matrix table cannot be resolved. */
async function readRecord(sectionTipo: string, sectionId: StoredSectionId) {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return null;
	return readMatrixRecord(table, sectionTipo, Number(sectionId));
}

/**
 * One component's stored items for a lang (PHP component get_dato: the lang
 * slice for a translatable component, the full array otherwise). NO fallback
 * chain — PHP's get_dato has none either, and a note resolved from another
 * lang's text would be a silent lie about what the transcription says.
 */
async function readItems(
	record: MatrixRecord,
	componentTipo: string,
	lang: string,
): Promise<unknown[]> {
	const model = await getModelByTipo(componentTipo);
	if (model === null) return [];
	const items = readComponentItems(record, componentTipo, model) ?? [];
	if (!(await getTranslatableByTipo(componentTipo))) return items;
	return filterItemsByLang(items, lang);
}

/** Normalize a stored locator to the canonical wire shape. */
function normalizeLocator(stored: Record<string, unknown>): TagLocator | null {
	const sectionTipo = stored.section_tipo;
	if (typeof sectionTipo !== 'string' || stored.section_id === undefined) return null;
	const locator: TagLocator = {
		...stored,
		section_tipo: sectionTipo,
		// Stored data is still mixed (pre-sweep '12' next to post-sweep 12), so
		// canonicalize on the way out instead of echoing whichever form the row
		// happens to hold — a padded/opaque remote id stays untouched.
		section_id: canonicalizeStoredSectionId(stored.section_id) as StoredSectionId,
	};
	// tag_id is a TEXT token, not an address: it is matched with strict `===`
	// against a regex capture from the transcription text. Keep it a string.
	if (stored.tag_id !== undefined && stored.tag_id !== null) {
		locator.tag_id = String(stored.tag_id);
	}
	return locator;
}

/**
 * The raw tag locators of one tag type (PHP get_component_tags_data): the data
 * of the component named by `properties.tags_<type>.tipo`, read on the HOST
 * record. The config's own `section_tipo`/`section_id` are ignored — they are
 * the literal string 'self' on the shipped ontology, and PHP ignored them too.
 */
async function readTagLocators(
	config: TagsPointerConfig | undefined,
	_host: TagsInfoHost,
	hostRecord: MatrixRecord | null,
): Promise<TagLocator[]> {
	const componentTipo = config?.tipo;
	if (typeof componentTipo !== 'string' || componentTipo === '') return [];
	if (hostRecord === null) return [];
	// The tag portal is structural, never translated (PHP reads it in NOLAN).
	const items = await readItems(hostRecord, componentTipo, NOLAN);
	const locators: TagLocator[] = [];
	for (const item of items) {
		if (item === null || typeof item !== 'object') continue;
		const locator = normalizeLocator(item as Record<string, unknown>);
		if (locator !== null) locators.push(locator);
	}
	return locators;
}

/**
 * Index/reference tags resolved to their thesaurus term (PHP
 * get_tags_data_as_terms, 'array' format). The term resolves through the
 * shared resolver every relation list uses, so a tag shows the same label as
 * the record does everywhere else.
 */
async function buildTagsAsTerms(
	config: TagsPointerConfig | undefined,
	host: TagsInfoHost,
	hostRecord: MatrixRecord | null,
	lang: string,
): Promise<TagTermElement[]> {
	const locators = await readTagLocators(config, host, hostRecord);
	const elements: TagTermElement[] = [];
	for (const locator of locators) {
		const label = await getTermByLocator(
			{
				section_tipo: locator.section_tipo,
				section_id: locator.section_id,
				// PHP set the locator's component_tipo from from_component_tipo.
				component_tipo:
					typeof locator.from_component_tipo === 'string'
						? locator.from_component_tipo
						: locator.component_tipo,
			},
			lang,
			true,
		);
		elements.push({ data: locator, label });
	}
	return elements;
}

/**
 * The annotations of a transcription (PHP get_annotations): scan the text for
 * `[note-…-data:<locator>:data]` marks and resolve each note RECORD through
 * the `tags_notes` ddo_map.
 *
 * The mark payload is JSON with `"` written as `'` (the tag lives in an HTML5
 * data- attribute on the client, so it cannot carry double quotes) — swap them
 * back before parsing, exactly as the client does.
 *
 * A note whose mark is malformed is SKIPPED (PHP logged and continued); the
 * client additionally filters null holes out of this array.
 */
async function buildAnnotations(
	config: Record<string, NoteDdo[]>,
	rawValues: string[],
	lang: string,
	scope: ReadDoorScope,
): Promise<{ notes: NoteElement[]; withheld: StoredSectionId[] }> {
	const annotations: NoteElement[] = [];
	const withheld: StoredSectionId[] = [];
	for (const rawValue of rawValues) {
		if (typeof rawValue !== 'string' || rawValue === '') continue;
		NOTE_PATTERN.lastIndex = 0;
		let match = NOTE_PATTERN.exec(rawValue);
		while (match !== null) {
			const payload = match[6] ?? '';
			match = NOTE_PATTERN.exec(rawValue);
			if (payload === '') continue;
			let stored: Record<string, unknown>;
			try {
				stored = JSON.parse(payload.replace(/'/g, '"')) as Record<string, unknown>;
			} catch {
				continue; // malformed mark payload — not a reason to fail the view
			}
			const locator = normalizeLocator(stored);
			if (locator === null) continue;

			const ddoMap = config[locator.section_tipo];
			if (!Array.isArray(ddoMap)) continue;

			// THE NOTE HOP: a note the caller may not read is dropped and NAMED.
			if (!(await noteReadable(scope, locator, ddoMap))) {
				withheld.push(locator.section_id);
				continue;
			}

			annotations.push(await resolveNote(locator, ddoMap, lang));
		}
	}
	return { notes: annotations, withheld };
}

/** The value of a ddo when the note record does not exist (PHP defaults). */
function emptyNoteValue(ddo: NoteDdo): boolean | never[] {
	return ddo.type === 'bool' ? false : [];
}

/** One ddo's value out of the note record's stored items. */
function noteValue(ddo: NoteDdo, items: unknown[]): unknown {
	if (ddo.type === 'bool') {
		// component_publication: the 'yes' term is section_id 1 (PHP
		// compared ONLY section_id here, so the reference locator does
		// too — via the locator law's own comparator, which gives the
		// loose-numeric semantics a stored '01' needs).
		const first = items[0] as Locator | undefined;
		return (
			first !== undefined &&
			first !== null &&
			compareLocators(first, { section_tipo: first.section_tipo, section_id: PUBLICATION_YES_ID }, [
				'section_id',
			])
		);
	}
	// WC-077: literal ddos emit STRING values, not stored items — the
	// client renders them directly (`note.title.join(' | ')`).
	return items.map((item) => {
		if (item !== null && typeof item === 'object') {
			const value = (item as { value?: unknown }).value;
			return typeof value === 'string' ? value : (value ?? '');
		}
		return item;
	});
}

/**
 * One AUTHORIZED note record resolved through its `tags_notes` ddo_map — every
 * ddo id becomes a key; an absent record yields the per-type empty defaults.
 */
async function resolveNote(
	locator: TagLocator,
	ddoMap: NoteDdo[],
	lang: string,
): Promise<NoteElement> {
	const note: NoteElement = { data: locator };
	const noteRecord = await readRecord(locator.section_tipo, locator.section_id);
	for (const ddo of ddoMap) {
		if (!isNoteDdo(ddo)) continue;
		note[ddo.id] =
			noteRecord === null
				? emptyNoteValue(ddo)
				: noteValue(ddo, await readItems(noteRecord, ddo.component_tipo, lang));
	}
	return note;
}

/**
 * An index / reference type: ABSENT (undefined) when the install does not
 * configure it (PHP `isset`) or when the host tag-source hop is refused (the
 * read door records the refusal); else its marks resolved to terms.
 */
async function buildPointerTags(
	config: TagsPointerConfig | undefined | null,
	scope: ReadDoorScope,
	host: TagsInfoHost,
	hostRecord: MatrixRecord | null,
	lang: string,
): Promise<TagTermElement[] | undefined> {
	if (config === undefined || config === null) return undefined;
	if (!(await tagSourceReadable(scope, config, host))) return undefined;
	return buildTagsAsTerms(config, host, hostRecord, lang);
}

/**
 * The HOST tag-source hop of an index/reference type: the component named by
 * `tags_<type>.tipo` is a component of the host section and needs its own pair
 * grant. Refused (recorded loudly by the read door) → false, the key is absent.
 */
async function tagSourceReadable(
	scope: ReadDoorScope,
	config: TagsPointerConfig,
	host: TagsInfoHost,
): Promise<boolean> {
	if (scope.principal === undefined) return true;
	if (typeof config.tipo !== 'string' || config.tipo === '') return true; // nothing is read
	return doorComponentAllowed(scope, {
		sectionTipo: host.section_tipo,
		componentTipo: config.tipo,
		sectionId: host.section_id,
	});
}

/**
 * The full tags_info payload for one text_area record.
 *
 * @param types the requested tag types (PHP `options.ar_type`), e.g.
 *   ['index','note','reference']. An unknown type resolves nothing and is
 *   reported back so the caller can say so out loud instead of serving a
 *   silently narrower payload.
 * @param principal the caller every hop is gated for (module header). REQUIRED
 *   positionally so no caller can forget it (the F2 shape); `undefined` is an
 *   explicit internal read.
 */
export async function buildTagsInfo(
	types: readonly string[],
	host: TagsInfoHost,
	lang: string = currentDataLang(),
	principal: Principal | undefined,
): Promise<{ tags_info: TagsInfo; unknown_types: string[]; withheld_notes: StoredSectionId[] }> {
	const scope: ReadDoorScope = { principal, door: TAGS_INFO_DOOR };
	const properties = ((await getEffectivePropertiesByTipo(host.tipo)) ??
		{}) as TextAreaTagProperties;
	const hostRecord = await readRecord(host.section_tipo, host.section_id);
	const tagsInfo: TagsInfo = {};
	const unknownTypes: string[] = [];
	const withheldNotes: StoredSectionId[] = [];

	for (const type of types) {
		switch (type) {
			case 'index': {
				const terms = await buildPointerTags(properties.tags_index, scope, host, hostRecord, lang);
				if (terms !== undefined) tagsInfo.tags_index = terms;
				break;
			}
			case 'reference': {
				const terms = await buildPointerTags(
					properties.tags_reference,
					scope,
					host,
					hostRecord,
					lang,
				);
				if (terms !== undefined) tagsInfo.tags_reference = terms;
				break;
			}
			case 'note':
				if (properties.tags_notes !== undefined && properties.tags_notes !== null) {
					// The notes live in the TEXT of the transcription itself.
					const rawValues =
						hostRecord === null
							? []
							: (await readItems(hostRecord, host.tipo, lang)).map((item) => {
									if (item !== null && typeof item === 'object') {
										const value = (item as { value?: unknown }).value;
										return typeof value === 'string' ? value : '';
									}
									return typeof item === 'string' ? item : '';
								});
					const annotations = await buildAnnotations(properties.tags_notes, rawValues, lang, scope);
					tagsInfo.tags_notes = annotations.notes;
					withheldNotes.push(...annotations.withheld);
				}
				break;
			case 'person':
				if (properties.tags_persons !== undefined && properties.tags_persons !== null) {
					// Same producer as the EDIT emit feed (tags_persons.ts), fed by
					// the record's related-section locators.
					const { buildRelatedSections } = await import('../../resolve/related_sections.ts');
					const { buildTagsPersons } = await import('./tags_persons.ts');
					const related = await buildRelatedSections(
						[
							{
								section_tipo: host.section_tipo,
								// Canonical address in, canonical addresses out — the
								// related locators become the persons-feed grouping keys
								// (the host id is coerced at the API door).
								section_id: host.section_id,
							},
						],
						{
							callerTipo: host.section_tipo,
							lang,
							sectionTipos: 'all',
							limit: false,
							// F2: the inverse search is SCOPED to the caller —
							// an out-of-scope referencing record never feeds the
							// persons list (undefined = internal read).
							principal,
						},
					);
					const sectionsEntry = related.data.find(
						(entry) => (entry as { typo?: string }).typo === 'sections',
					) as { value?: { section_tipo: string; section_id: StoredSectionId }[] } | undefined;
					tagsInfo.tags_persons = await buildTagsPersons(
						properties.tags_persons,
						{ section_tipo: host.section_tipo, section_id: host.section_id },
						hostRecord,
						sectionsEntry?.value ?? [],
						// Each owner's persons component needs its own pair grant.
						scope,
					);
				}
				break;
			default:
				unknownTypes.push(type);
		}
	}

	return { tags_info: tagsInfo, unknown_types: unknownTypes, withheld_notes: withheldNotes };
}
