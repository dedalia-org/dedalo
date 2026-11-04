/**
 * TAGS_PERSONS + RELATED_SECTIONS GATE (the v6 transcription helpers feed,
 * ported 2026-07-29 — PHP component_text_area::get_tags_persons /
 * get_related_sections, emitted on EDIT data when the text_area's ontology
 * declares `properties.tags_persons`).
 *
 * The v7 client kept the whole person/note/lang tag UI
 * (view_default_edit_text_area.js render_persons_list, Ctrl+<n> inserts,
 * tool_tr_print's header) but the TS server never produced its feed, so the
 * Person button silently opened nothing. These tests pin:
 *
 *   - the WC-065 wire law: sections item ALWAYS present (`value`, not
 *     `entries`; empty array on zero hits), every section_id a STRING,
 *     component entries `value: string[]`, section context entry FIRST;
 *   - the PHP tag semantics: initials (3+2+2), '-'→'_' label sanitize, the
 *     exact `[person-…-data:{'…'}:data]` bytes, per-config-key dedup, self
 *     entries overwrite stale ontology section_ids;
 *   - the emit gating: EDIT items of a tags_persons text_area carry both
 *     keys; LIST items and plain text_areas never do;
 *   - toolbar_buttons: server-gated from the tag properties (WC-066 note
 *     gating), absent outside edit mode.
 *
 * Uses the REAL suite-DB ontology (rsc36 carries the shipped tags_persons
 * config; the interview section's relation_list declares two columns); all matrix rows are
 * scratch (created and deleted here) — the matrix_relation_index_sync trigger
 * indexes the scratch relations, so the inverse scan is live.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule: a test uses the
// generic `test` TLD and BUILDS the situation it tests). A rename could not work: the
// subject IS `properties.tags_persons` — a map from an interview section to the
// components that name its people — plus that section's relation_list columns, and no
// shipped `test` node declares either. Both are built as a reserved `zztp` scratch
// ontology, copied field for field from the shipped rsc36 declaration (state 'a' = the
// interview's own portal, state 'b' = the host record's autocompletes).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseTagId } from '../../src/core/components/component_text_area/tag_grammar.ts';
import {
	buildTagPerson,
	buildTagsPersons,
	getTagPersonLabel,
} from '../../src/core/components/component_text_area/tags_persons.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { ElementNodeRegistry } from '../../src/core/relations/element_registry.ts';
import { buildRelatedSections } from '../../src/core/resolve/related_sections.ts';
import { buildGetDataContext, readSection } from '../../src/core/section/read.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

const PERSONS = 'zztp1'; // the people thesaurus
const PERSON_NAME = 'zztp2';
const PERSON_SURNAME = 'zztp3';
const PERSON_MAP = 'zztp13'; // its section_map: term = [surname, name]
const HOST_SECTION = 'zztp4'; // the record the text_area lives on
const TEXT_AREA = 'zztp5';
const INTERVIEWER = 'zztp6'; // state 'b' — an autocomplete on the HOST
const OH_SECTION = 'zztp7'; // the interview section
const INFORMANTS = 'zztp8'; // state 'a' — a portal on the INTERVIEW
const OH_HOST_LINK = 'zztp9'; // the interview → host link
const OH_TITLE = 'zztp10'; // relation_list column 1
const OH_CODE = 'zztp11'; // relation_list column 2
const OH_LIST = 'zztp12'; // the relation_list declaring those two columns
const OH_MAIN = 'zztp14'; // a tag-less text_area on the interview (the contrast case)
const HOST_LIST = 'zztp15'; // the host's section_list (the LIST-mode leg)

/** Resolved after the situation exists — each section owns its `matrix_table`. */
let TABLE = 'matrix_test';

const PERSONS_SITUATION = situation({
	tld: 'zztp',
	name: 'text_area tags_persons',
	nodes: [
		{ tipo: PERSONS, model: 'section', parent: 'dd14' },
		{ tipo: PERSON_NAME, model: 'component_input_text', parent: PERSONS },
		{ tipo: PERSON_SURNAME, model: 'component_input_text', parent: PERSONS },
		{
			tipo: PERSON_MAP,
			model: 'section_map',
			parent: PERSONS,
			properties: {
				thesaurus: { term: [PERSON_SURNAME, PERSON_NAME], fields_separator: ', ' },
			},
		},
		{ tipo: HOST_SECTION, model: 'section', parent: 'dd14' },
		{ tipo: INTERVIEWER, model: 'component_autocomplete', parent: HOST_SECTION },
		{
			tipo: TEXT_AREA,
			model: 'component_text_area',
			parent: HOST_SECTION,
			is_translatable: true,
			properties: {
				// All THREE tag families, as the shipped component declares them: the
				// toolbar gate answers person+note+reference from their presence, so a
				// twin carrying only one would prove a third of the contract.
				tags_index: { tipo: INFORMANTS, section_id: 'self', section_tipo: 'self' },
				tags_reference: { tipo: INTERVIEWER, section_id: 'self', section_tipo: 'self' },
				tags_notes: {
					[PERSONS]: [
						{ id: 'title', type: 'text', section_tipo: PERSONS, component_tipo: PERSON_NAME },
					],
				},
				tags_persons: {
					[OH_SECTION]: [
						{ state: 'a', section_tipo: OH_SECTION, component_tipo: INFORMANTS },
						{ state: 'b', section_tipo: HOST_SECTION, component_tipo: INTERVIEWER },
					],
				},
			},
		},
		{
			// Without a section_list the host emits no column in list mode, and the
			// "LIST never carries the helpers" case would assert on an absent item.
			tipo: HOST_LIST,
			model: 'section_list',
			parent: HOST_SECTION,
			relations: [{ tipo: TEXT_AREA }],
		},
		{ tipo: OH_SECTION, model: 'section', parent: 'dd14' },
		{ tipo: INFORMANTS, model: 'component_portal', parent: OH_SECTION },
		{ tipo: OH_HOST_LINK, model: 'component_autocomplete', parent: OH_SECTION },
		{ tipo: OH_TITLE, model: 'component_input_text', parent: OH_SECTION },
		{ tipo: OH_CODE, model: 'component_input_text', parent: OH_SECTION },
		// A text_area (not an input_text): the contrast case is "a text_area that
		// declares no tag properties", so the model has to be the same one.
		{ tipo: OH_MAIN, model: 'component_text_area', parent: OH_SECTION },
		{
			tipo: OH_LIST,
			model: 'relation_list',
			parent: OH_SECTION,
			relations: [{ tipo: OH_TITLE }, { tipo: OH_CODE }],
		},
	],
});

/** Scratch records. */
let personAId = 0; // Javier Navarro Ortiz → 'Navarro Ortiz, Javier' → NavOrJa
let personBId = 0; // Ana Rey → 'Rey, Ana' → ReyAn
let personCId = 0; // Luc (no surname) → Luc
let hostId = 0; // the host record, interviewer → person C
let ohId = 0; // the interview → host, informants → A, B
let orphanHostId = 0; // rsc167 nobody references — the zero-hit case

function personLocator(sectionId: number, fromComponent: string) {
	return {
		id: 1,
		type: 'dd151',
		section_tipo: PERSONS,
		section_id: String(sectionId),
		from_component_tipo: fromComponent,
	};
}

beforeAll(async () => {
	await ensureSituation(PERSONS_SITUATION);
	TABLE = (await getMatrixTableFromTipo(HOST_SECTION)) ?? 'matrix_test';
	personAId = await insertMatrixRecordWithCounter(TABLE, PERSONS, {
		string: {
			[PERSON_NAME]: [{ id: 1, lang: 'lg-nolan', value: 'Javier' }],
			[PERSON_SURNAME]: [{ id: 1, lang: 'lg-nolan', value: 'Navarro Ortiz' }],
		},
	});
	personBId = await insertMatrixRecordWithCounter(TABLE, PERSONS, {
		string: {
			[PERSON_NAME]: [{ id: 1, lang: 'lg-nolan', value: 'Ana' }],
			[PERSON_SURNAME]: [{ id: 1, lang: 'lg-nolan', value: 'Rey' }],
		},
	});
	personCId = await insertMatrixRecordWithCounter(TABLE, PERSONS, {
		string: { [PERSON_NAME]: [{ id: 1, lang: 'lg-nolan', value: 'Luc' }] },
	});
	hostId = await insertMatrixRecordWithCounter(TABLE, HOST_SECTION, {
		relation: { [INTERVIEWER]: [personLocator(personCId, INTERVIEWER)] },
	});
	orphanHostId = await insertMatrixRecordWithCounter(TABLE, HOST_SECTION, {});
	ohId = await insertMatrixRecordWithCounter(TABLE, OH_SECTION, {
		relation: {
			[OH_HOST_LINK]: [
				{
					id: 1,
					type: 'dd151',
					section_tipo: HOST_SECTION,
					section_id: String(hostId),
					from_component_tipo: OH_HOST_LINK,
				},
			],
			[INFORMANTS]: [
				{ ...personLocator(personAId, INFORMANTS), id: 1 },
				{ ...personLocator(personBId, INFORMANTS), id: 2 },
			],
		},
		string: { [OH_TITLE]: [{ id: 1, lang: 'lg-spa', value: 'OH-T1' }] },
	});
});

afterAll(async () => {
	if (ohId > 0) await deleteMatrixRecord(TABLE, OH_SECTION, ohId);
	if (hostId > 0) await deleteMatrixRecord(TABLE, HOST_SECTION, hostId);
	if (orphanHostId > 0) await deleteMatrixRecord(TABLE, HOST_SECTION, orphanHostId);
	if (personAId > 0) await deleteMatrixRecord(TABLE, PERSONS, personAId);
	if (personBId > 0) await deleteMatrixRecord(TABLE, PERSONS, personBId);
	if (personCId > 0) await deleteMatrixRecord(TABLE, PERSONS, personCId);
	// Residue asserted, not trusted — the scratch ontology goes with the records.
	expect(await dropSituation(PERSONS_SITUATION)).toBe(0);
});

describe('buildRelatedSections (WC-065 wire law)', () => {
	test('sections item first, int ids, section context entry before its columns', async () => {
		const related = await buildRelatedSections(
			[{ section_tipo: HOST_SECTION, section_id: hostId }],
			{ callerTipo: HOST_SECTION, lang: 'lg-spa' },
		);
		// data[0] is the sections item. WC-2026-08-10-section-id-int-canonical:
		// the emitted locators carry INT addresses (was String()).
		const sections = related.data[0] as { typo?: string; tipo?: string; value?: unknown[] };
		expect(sections.typo).toBe('sections');
		expect(sections.tipo).toBe(HOST_SECTION);
		expect(sections.value).toEqual([{ section_tipo: OH_SECTION, section_id: ohId }]);
		// context: the SECTION entry first (the client `find`s by section_tipo
		// and expects the section label), then the relation_list columns.
		const ohEntries = related.context.filter((entry) => entry.section_tipo === OH_SECTION);
		expect(ohEntries[0]?.model).toBe('section');
		expect(ohEntries.slice(1).map((entry) => entry.tipo)).toEqual([OH_TITLE, OH_CODE]);
		for (const entry of ohEntries) {
			expect(typeof entry.label).toBe('string');
		}
		// Component entries: INT section_id (WC-2026-08-10-section-id-int-canonical),
		// value as string[].
		const codeCell = related.data.find(
			(entry) => entry.tipo === OH_TITLE && entry.section_id === ohId,
		) as { value?: unknown } | undefined;
		expect(codeCell).toBeDefined();
		expect(codeCell?.value).toEqual(['OH-T1']);
		const titleCell = related.data.find(
			(entry) => entry.tipo === OH_CODE && entry.section_id === ohId,
		) as { value?: unknown } | undefined;
		expect(titleCell?.value).toEqual([]); // empty cell = [], never null
	});

	test('zero hits still emit the sections item (self-persons must render)', async () => {
		const related = await buildRelatedSections(
			[{ section_tipo: HOST_SECTION, section_id: orphanHostId }],
			{ callerTipo: HOST_SECTION, lang: 'lg-spa' },
		);
		expect(related.data).toEqual([
			{ typo: 'sections', tipo: HOST_SECTION, section_tipo: [], value: [] },
		]);
		expect(related.context).toEqual([]);
	});
});

describe('person tag semantics (section_map label + TR::build_tag bytes)', () => {
	test('the label IS the target section_map term — the section defines its own label', async () => {
		// the people section_map resolves term [surname, name] in the
		// suite DB (thesaurus scope via the standard fallback walk; a live
		// install's `default` scope wins when declared) → surname-first, the
		// SAME label every relation list shows for this record. The initials
		// rule (first word 3 chars + next two words 2 chars each) follows the
		// section's own word order.
		const label = await getTagPersonLabel({
			section_tipo: PERSONS,
			section_id: String(personAId),
			component_tipo: INFORMANTS,
		});
		expect(label.full_name).toBe('Navarro Ortiz, Javier');
		expect(label.initials).toBe('NavOrJa');
		expect(label.role.length).toBeGreaterThan(0); // the portal's ontology label
	});

	test('a single term value composes alone (no separator, no phantom words)', async () => {
		const label = await getTagPersonLabel({
			section_tipo: PERSONS,
			section_id: String(personCId),
			component_tipo: INTERVIEWER,
		});
		expect(label.initials).toBe('Luc');
		expect(label.full_name).toBe('Luc');
	});

	test('the exact tag bytes, and the label sanitize (- is the field separator)', () => {
		const locator = { section_tipo: PERSONS, section_id: '2', component_tipo: INFORMANTS };
		expect(buildTagPerson('a', 1, 'JavNa', locator)).toBe(
			`[person-a-1-JavNa-data:{'section_tipo':'${PERSONS}','section_id':'2','component_tipo':'${INFORMANTS}'}:data]`,
		);
		// A '-' in a label would break every tag regex; '_' replaces it.
		expect(buildTagPerson('b', 2, 'Al-Andalus of Cordoba city', locator)).toContain(
			'-2-Al_Andalus of Cordoba -', // '-'→'_', then capped at 22 chars
		);
	});

	test('the emitted short form parses in the v7 tag grammar (badge endpoint)', () => {
		const parsed = parseTagId('[person-a-1-JavNaOr]');
		expect(parsed).toMatchObject({ kind: 'sprite', type: 'person', state: 'a' });
	});
});

describe('buildTagsPersons (PHP get_tags_persons)', () => {
	const CONFIG = {
		[OH_SECTION]: [
			{ state: 'a', section_tipo: OH_SECTION, component_tipo: INFORMANTS },
			// stale ontology section_id (the shipped rsc36 carries 11) — the SELF
			// entry must resolve against the CURRENT record, not it.
			{ state: 'b', section_tipo: HOST_SECTION, component_tipo: INTERVIEWER, section_id: 11 },
		],
	};

	async function build() {
		return buildTagsPersons(CONFIG, { section_tipo: HOST_SECTION, section_id: hostId }, null, [
			{ section_tipo: OH_SECTION, section_id: String(ohId) },
		]);
	}

	test('informants group under the RELATED record; crew under the host (stale id ignored)', async () => {
		const persons = await build();
		expect(persons.map((person) => person.full_name)).toEqual([
			'Navarro Ortiz, Javier',
			'Rey, Ana',
			'Luc',
		]);
		const [a, b, c] = persons;
		// Grouping key = the OWNING record. WC-2026-08-10-section-id-int-canonical:
		// the emitted addresses are INTs — the `tag` MARK below keeps its quoted
		// string form (mark grammar, not an address field).
		expect(a).toMatchObject({
			section_tipo: OH_SECTION,
			section_id: ohId,
			state: 'a',
			tag_id: 1,
			label: 'NavOrJa',
			data: { section_tipo: PERSONS, section_id: personAId, component_tipo: INFORMANTS },
		});
		expect(a?.tag).toBe(
			`[person-a-1-NavOrJa-data:{'section_tipo':'${PERSONS}','section_id':'${personAId}','component_tipo':'${INFORMANTS}'}:data]`,
		);
		expect(b?.section_id).toBe(ohId);
		// Self entry: owner is the CURRENT host record — never ontology id 11.
		expect(c).toMatchObject({
			section_tipo: HOST_SECTION,
			section_id: hostId,
			state: 'b',
			data: { section_tipo: PERSONS, section_id: personCId, component_tipo: INTERVIEWER },
		});
	});

	test('dedup is scoped per config key: the same person listed twice resolves once', async () => {
		const persons = await buildTagsPersons(
			{
				[OH_SECTION]: [
					{ state: 'a', section_tipo: OH_SECTION, component_tipo: INFORMANTS },
					// person A again through a second entry pointing at the same portal
					{ state: 'b', section_tipo: OH_SECTION, component_tipo: INFORMANTS },
				],
			},
			{ section_tipo: HOST_SECTION, section_id: hostId },
			null,
			[{ section_tipo: OH_SECTION, section_id: String(ohId) }],
		);
		// First entry wins; the duplicate contributes nothing.
		// WC-2026-08-10-section-id-int-canonical: int addresses.
		expect(persons.map((person) => person.data.section_id)).toEqual([personAId, personBId]);
		expect(persons.every((person) => person.state === 'a')).toBe(true);
	});
});

describe('emit gating: EDIT data carries the helpers, LIST never does', () => {
	function sectionRqo(mode: string): Rqo {
		return {
			action: 'read',
			source: { tipo: HOST_SECTION, section_tipo: HOST_SECTION, mode, lang: 'lg-spa' },
			sqo: {
				section_tipo: [HOST_SECTION],
				filter_by_locators: [{ section_tipo: HOST_SECTION, section_id: String(hostId) }],
				limit: 1,
				offset: 0,
			},
		} as unknown as Rqo;
	}

	function textAreaItem(data: unknown[]) {
		return data.find(
			(entry) =>
				(entry as { tipo?: string }).tipo === TEXT_AREA &&
				String((entry as { section_id?: unknown }).section_id) === String(hostId),
		) as
			| {
					tags_persons?: { full_name?: string; section_id?: string }[];
					related_sections?: { data?: { typo?: string; value?: unknown[] }[] };
			  }
			| undefined;
	}

	test('EDIT: the text_area item carries tags_persons + related_sections', async () => {
		const { data } = await readSection(sectionRqo('edit'));
		const item = textAreaItem(data);
		expect(item).toBeDefined();
		// The shipped rsc36 config resolves: informants A,B (via the scratch oh1)
		// + the host's interviewer C (self entry); rsc48/rsc51 hold no values.
		expect(item?.tags_persons?.map((person) => person.full_name)).toEqual([
			'Navarro Ortiz, Javier',
			'Rey, Ana',
			'Luc',
		]);
		const sections = item?.related_sections?.data?.[0];
		expect(sections?.typo).toBe('sections');
		// WC-2026-08-10-section-id-int-canonical: int address.
		expect(sections?.value).toEqual([{ section_tipo: OH_SECTION, section_id: ohId }]);
	});

	test('LIST: both keys are ABSENT (edit-only payload)', async () => {
		const { data } = await readSection(sectionRqo('list'));
		const item = textAreaItem(data);
		expect(item).toBeDefined();
		expect('tags_persons' in (item ?? {})).toBe(false);
		expect('related_sections' in (item ?? {})).toBe(false);
	});
});

describe('toolbar_buttons (server-gated CKEditor extras, WC-066)', () => {
	function editContextRqo(tipo: string, sectionTipo: string, mode: string): Rqo {
		return {
			action: 'read',
			source: {
				action: 'read',
				model: 'component_text_area',
				tipo,
				section_tipo: sectionTipo,
				section_id: hostId,
				mode,
				lang: 'lg-spa',
			},
		} as unknown as Rqo;
	}

	test('a text_area with all three tag families gates person+note+reference', async () => {
		const context = await buildGetDataContext(editContextRqo(TEXT_AREA, HOST_SECTION, 'edit'), {
			items: [],
			nodes: new ElementNodeRegistry(),
		});
		const main = context.find((entry) => entry.tipo === TEXT_AREA);
		expect(main?.toolbar_buttons).toEqual(['button_person', 'button_note', 'reference']);
	});

	test('a text_area without tag properties gets the empty array (PHP shape)', async () => {
		const context = await buildGetDataContext(editContextRqo(OH_MAIN, OH_SECTION, 'edit'), {
			items: [],
			nodes: new ElementNodeRegistry(),
		});
		const main = context.find((entry) => entry.tipo === OH_MAIN);
		expect(main).toBeDefined();
		expect(main?.toolbar_buttons).toEqual([]);
	});

	test('outside edit mode the key is absent', async () => {
		const context = await buildGetDataContext(editContextRqo(TEXT_AREA, HOST_SECTION, 'list'), {
			items: [],
			nodes: new ElementNodeRegistry(),
		});
		const main = context.find((entry) => entry.tipo === TEXT_AREA);
		expect(main).toBeDefined();
		expect('toolbar_buttons' in (main ?? {})).toBe(false);
	});
});
