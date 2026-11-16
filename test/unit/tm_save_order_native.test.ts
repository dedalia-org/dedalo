/**
 * SAVE ORDER, EVERY MAIN KIND, TWO LANES — the time machine of a dataframe main
 * is complete and restorable whatever order the curator saves in (user
 * requirements 2026-09-28; WC-2026-09-27-bulk-revert-undo-log, addendum "two
 * lanes").
 *
 * A dataframe can hang from ANY component: a relation main (a portal, frames
 * activated through the ddo in its request_config) or a literal main (activated
 * with `has_dataframe: true`) — non-translatable (component_number),
 * translatable (component_input_text, two languages, frames paired to each
 * language's items), TRANSLITERABLE (component_input_text with
 * `with_lang_versions`: an lg-nolan base + an lg-ell transliteration written by
 * tool_lang's door), and component_iri with its FIXED dd560 label slot. Every
 * case below runs, identically, over all five.
 *
 * THE CONTRACT (two lanes): every row is stored under the MAIN's tipo, in ONE
 * lane — a LANGUAGE row holds only that language's value (no frame); the
 * lg-nolan row holds the lg-nolan value (none for a translatable main) and ALL
 * the main's frames. The state AT row R: each language = its newest row <= R,
 * the frames = the newest frame-state row <= R (lg-nolan, or a PHP row carrying
 * frames). Per kind:
 *   1. a PHP-shaped FRAMELESS lg-nolan row restores the value and EMPTIES this
 *      main's frames; a frameless LANGUAGE row carries no frame information —
 *      its restore takes the frames as of it;
 *   2. a PHP-shaped COMPOSED row restores its lane AND its frames;
 *   3. SAVE ORDER — (a) main first then frame, (b) frame FIRST (the main key
 *      still absent) then main, (c) interleaved, (d) a frame for an item not held
 *      yet — through the real doors. After EVERY step: one row per lane at most
 *      (no copy per language), each row equal to its live lane, and the NEWEST
 *      row reconstructing to the full live state; then, newest first, every
 *      MIDDLE row previews the frames as of it and applying it leaves exactly
 *      the state at it (its lane from the row, the frames as of it, the rest
 *      live);
 *   4. a BULK run mixing the orders reverts every record to its pre-run state
 *      exactly (and the revert of the revert back to the post-run state).
 * Another main's frames (a shared slot) are asserted untouched every step.
 *
 * SITUATION: a `zztso` scratch section on `test1` (→ matrix_test) — a portal
 * PMAIN naming its slot PSLOT, a portal FMAIN naming PSLOT too (the foreign
 * main of every kind's shared slot), a number NMAIN (has_dataframe) with NSLOT,
 * a translatable input_text LMAIN (has_dataframe) with LSLOT, a transliterable
 * input_text XLMAIN with XLSLOT, and two iris (dd560 is the model's fixed slot,
 * shared by both). Frame targets are runtime records of the section (dd1706
 * label records for the iri). Everything is swept; the situation drop asserts
 * zero residue. assertTestDatabase first.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { canonicalJson } from '../../src/core/concepts/canonical_json.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import {
	historyStamp,
	isFrameEntry,
	recordMainHistory,
	resolveDataframeSlotTipos,
	splitComposed,
} from '../../src/core/relations/dataframe_slots.ts';
import { countTimeMachineData } from '../../src/core/resolve/read_tm.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { readComponentData } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionData } from '../../src/core/section/record/delete_record.ts';
import { recomputeExternalRelation } from '../../src/core/section/record/observers.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { readLaneValueAt } from '../../src/core/tm_record/lane_state.ts';
import { translateAndWrite } from '../../src/core/tools/translation.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { mustGet } from '../helpers/assert.ts';
import { insertLegacyBulkRow } from '../helpers/legacy_bulk_run.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';
import { superuserTranslationGrant } from '../helpers/translation_grant.ts';

const TLD = 'zztso';
const SECTION = `${TLD}1`;
const PMAIN = `${TLD}2`; // portal → PSLOT (request_config ddo)
const PSLOT = `${TLD}3`; // component_dataframe, child of PMAIN
const FMAIN = `${TLD}4`; // portal naming PSLOT too: the FOREIGN main of every shared slot
const NMAIN = `${TLD}5`; // component_number, has_dataframe (NOT translatable)
const NSLOT = `${TLD}6`;
const LMAIN = `${TLD}7`; // component_input_text, translatable, has_dataframe
const LSLOT = `${TLD}8`;
const IMAIN = `${TLD}9`; // component_iri — its slot is the model's FIXED dd560
const IMAIN2 = `${TLD}10`; // a second iri: the foreign main of dd560
const M2 = `${TLD}11`; // a portal with TWO show slots (A, B) and a HIDE-only slot (H)
const M2A = `${TLD}12`;
const M2B = `${TLD}13`;
const M2H = `${TLD}14`; // named only in M2's hide map (not its child) — a slot like any other
const REF = `${TLD}15`; // the referencing section of the observer pair
const INDEXER = `${TLD}16`; // component_autocomplete_hi on REF — the OBSERVED indexer
const OMAIN = `${TLD}17`; // component_autocomplete on SECTION — the set_dato_external OBSERVER
const OSLOT = `${TLD}18`; // the observer's dataframe slot (its child)
const TMAIN = `${TLD}19`; // a portal whose ontology node says translatable — unsliced: its history is lg-nolan only
const TSLOT = `${TLD}20`;
const XMAIN = `${TLD}21`; // component_number, has_dataframe, its slot named ONLY by its request_config ddo
const XSLOT = `${TLD}22`; // … living OUTSIDE the section's subtree (under REF)
const USLOT = `${TLD}23`; // a dataframe NO main declares (under REF): M2's frames land there only by drift
const XLMAIN = `${TLD}24`; // component_input_text, NOT translatable, with_lang_versions, has_dataframe
const XLSLOT = `${TLD}25`;
const IRI_SLOT = 'dd560';
const LABEL_SECTION = 'dd1706'; // dd560's declared target
const TABLE = 'matrix_test';
const USER_ID = -1;
const NOLAN = 'lg-nolan';

type Item = Record<string, unknown>;

const portalConfig = (slot: string) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
				show: { ddo_map: [{ tipo: slot, parent: 'self', section_tipo: SECTION }] },
			},
		],
	},
});

const SITUATION = situation({
	tld: TLD,
	name: 'tm_save_order',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Save order' } },
		{
			tipo: PMAIN,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Portal main' },
			properties: portalConfig(PSLOT),
		},
		{ tipo: PSLOT, parent: PMAIN, model: 'component_dataframe', term: { 'lg-eng': 'P slot' } },
		{
			tipo: FMAIN,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Foreign main' },
			properties: portalConfig(PSLOT),
		},
		{
			tipo: NMAIN,
			parent: SECTION,
			model: 'component_number',
			term: { 'lg-eng': 'Number main' },
			properties: { has_dataframe: true },
		},
		{ tipo: NSLOT, parent: NMAIN, model: 'component_dataframe', term: { 'lg-eng': 'N slot' } },
		{
			tipo: LMAIN,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text main' },
			is_translatable: true,
			properties: { has_dataframe: true },
		},
		{ tipo: LSLOT, parent: LMAIN, model: 'component_dataframe', term: { 'lg-eng': 'L slot' } },
		{ tipo: IMAIN, parent: SECTION, model: 'component_iri', term: { 'lg-eng': 'Iri' } },
		{ tipo: IMAIN2, parent: SECTION, model: 'component_iri', term: { 'lg-eng': 'Iri 2' } },
		{
			tipo: M2,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Two-slot main' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
							show: {
								ddo_map: [
									{ tipo: M2A, parent: 'self', section_tipo: SECTION },
									{ tipo: M2B, parent: 'self', section_tipo: SECTION },
								],
							},
							hide: { ddo_map: [{ tipo: M2H, parent: 'self', section_tipo: SECTION }] },
						},
					],
				},
			},
		},
		{ tipo: M2A, parent: M2, model: 'component_dataframe', term: { 'lg-eng': 'Slot A' } },
		{ tipo: M2B, parent: M2, model: 'component_dataframe', term: { 'lg-eng': 'Slot B' } },
		{ tipo: M2H, parent: SECTION, model: 'component_dataframe', term: { 'lg-eng': 'Slot H' } },
		{ tipo: REF, parent: 'test1', model: 'section', term: { 'lg-eng': 'Save order refs' } },
		{
			tipo: INDEXER,
			parent: REF,
			model: 'component_autocomplete_hi',
			term: { 'lg-eng': 'Indexer' },
			properties: {
				config_relation: { relation_type: 'dd96' },
				observers: [{ section_tipo: SECTION, component_tipo: OMAIN }],
			},
		},
		{
			tipo: OMAIN,
			parent: SECTION,
			model: 'component_autocomplete',
			term: { 'lg-eng': 'Observer main' },
			properties: {
				source: {
					mode: 'external',
					request_config: [
						{
							sqo: { section_tipo: [{ value: [REF], source: 'section' }] },
							show: { sqo_config: { limit: 10 } },
						},
					],
					section_to_search: [REF],
					component_to_search: [INDEXER],
				},
				observe: [
					{
						component_tipo: INDEXER,
						server: {
							config: { use_self_section: false, use_observable_dato: true },
							perform: {
								function: 'set_dato_external',
								params: { save: true, changed: false, current_dato: false, references_limit: 0 },
							},
						},
					},
				],
			},
		},
		{ tipo: OSLOT, parent: OMAIN, model: 'component_dataframe', term: { 'lg-eng': 'O slot' } },
		{
			tipo: TMAIN,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Translatable portal main' },
			is_translatable: true,
			properties: portalConfig(TSLOT),
		},
		{ tipo: TSLOT, parent: TMAIN, model: 'component_dataframe', term: { 'lg-eng': 'T slot' } },
		{
			tipo: XMAIN,
			parent: SECTION,
			model: 'component_number',
			term: { 'lg-eng': 'Config-slot number main' },
			properties: { has_dataframe: true, ...portalConfig(XSLOT) },
		},
		{ tipo: XSLOT, parent: REF, model: 'component_dataframe', term: { 'lg-eng': 'X slot' } },
		{ tipo: USLOT, parent: REF, model: 'component_dataframe', term: { 'lg-eng': 'U slot' } },
		{
			tipo: XLMAIN,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Transliterable main' },
			properties: { has_dataframe: true, with_lang_versions: true },
		},
		{ tipo: XLSLOT, parent: XLMAIN, model: 'component_dataframe', term: { 'lg-eng': 'XL slot' } },
	],
});

/** One main kind the matrix runs over. */
interface Kind {
	name: string;
	main: string;
	slot: string;
	column: string;
	/** lang-sliced (a row is one language) */
	sliced: boolean;
	/** the ontology translatable flag (a translatable main keeps no value in lg-nolan) */
	translatable: boolean;
	/** how the second language is written: a save in it, or a transliteration (tool_lang) */
	otherVia?: 'save' | 'translate';
	/** the tracked language of the main's saves (and of its item values) */
	lang: string;
	/** a translatable kind's SECOND language, set up before each scenario (its item + frame) */
	otherLang: string | null;
	/** the main that owns the foreign frame in the shared slot */
	foreign: string;
	/** the section the frames point at */
	frameTarget: string;
	/** a main item of this kind: `id`, `variant` picks its value */
	item: (id: number, variant: number, lang?: string) => Item;
}

// Frame / portal targets: runtime records, created in beforeAll.
const targets: number[] = [];
const labels: number[] = [];
const target = (n: number): number => mustGet(targets[n], `target ${n}`);
const label = (n: number): number => mustGet(labels[n], `label ${n}`);

const KINDS: Kind[] = [
	{
		name: 'a RELATION main (portal)',
		main: PMAIN,
		slot: PSLOT,
		column: 'relation',
		sliced: false,
		translatable: false,
		lang: NOLAN,
		otherLang: null,
		foreign: FMAIN,
		frameTarget: SECTION,
		item: (id, variant) => ({
			id,
			type: 'dd151',
			section_tipo: SECTION,
			section_id: target(variant),
			from_component_tipo: PMAIN,
		}),
	},
	{
		name: 'a NON-translatable LITERAL main (number, has_dataframe)',
		main: NMAIN,
		slot: NSLOT,
		column: 'number',
		sliced: false,
		translatable: false,
		lang: NOLAN,
		otherLang: null,
		foreign: FMAIN,
		frameTarget: SECTION,
		item: (id, variant) => ({ id, lang: NOLAN, value: 100 + variant }),
	},
	{
		name: 'a TRANSLATABLE LITERAL main (input_text, two languages)',
		main: LMAIN,
		slot: LSLOT,
		column: 'string',
		sliced: true,
		translatable: true,
		otherVia: 'save',
		lang: 'lg-eng',
		otherLang: 'lg-spa',
		foreign: FMAIN,
		frameTarget: SECTION,
		item: (id, variant, lang = 'lg-eng') => ({ id, lang, value: `${lang} text ${variant}` }),
	},
	{
		name: 'component_iri with its fixed dd560 label slot',
		main: IMAIN,
		slot: IRI_SLOT,
		column: 'iri',
		sliced: true,
		translatable: false,
		lang: NOLAN,
		otherLang: null,
		foreign: IMAIN2,
		frameTarget: LABEL_SECTION,
		item: (id, variant) => ({ id, lang: NOLAN, iri: `https://example.org/tso/${variant}` }),
	},
	{
		// with_lang_versions (rsc85 in rsc197): the base value in lg-nolan, its
		// transliteration in lg-ell (Augustus / Αύγουστος) — a language lane of its own.
		name: 'a TRANSLITERABLE LITERAL main (input_text, with_lang_versions: lg-nolan base + lg-ell)',
		main: XLMAIN,
		slot: XLSLOT,
		column: 'string',
		sliced: true,
		translatable: false,
		otherVia: 'translate',
		lang: NOLAN,
		otherLang: 'lg-ell',
		foreign: FMAIN,
		frameTarget: SECTION,
		item: (id, variant, lang = NOLAN) => ({ id, lang, value: `${lang} name ${variant}` }),
	},
];

/** The foreign frame of a kind, seeded into its slot (id 1000 — clear of the slot counter). */
function foreignFrame(kind: Kind): Item {
	return {
		id: 1000,
		type: 'dd490',
		id_key: 1,
		section_tipo: kind.frameTarget,
		section_id: kind.frameTarget === LABEL_SECTION ? label(0) : target(0),
		from_component_tipo: kind.slot,
		main_component_tipo: kind.foreign,
	};
}

/** A frame target of a kind (a section record, or a dd1706 label). */
const frameTargetId = (kind: Kind, n: number): number =>
	kind.frameTarget === LABEL_SECTION ? label(n) : target(n);

const runs: number[] = [];
let bulkTable = '';

// ---------------------------------------------------------------- doors

async function rec(): Promise<number> {
	return createSectionRecord(SECTION, USER_ID);
}

async function stored(sectionId: number, column: string, key: string): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT (${column} ? $3) AS present, ${column}->$3 AS v FROM "${TABLE}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, key],
	)) as { present: boolean | null; v: unknown }[];
	return rows[0]?.present === true ? rows[0]?.v : undefined;
}

async function seedSlot(sectionId: number, slot: string, value: unknown): Promise<void> {
	await sql.unsafe(
		`UPDATE "${TABLE}" SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, slot, JSON.stringify(value)],
	);
}

async function save(
	sectionId: number,
	componentTipo: string,
	lang: string,
	changedData: unknown[],
	extra: { bulk?: number | null; callerDataframe?: unknown } = {},
): Promise<void> {
	const saved = await saveComponentData({
		componentTipo,
		sectionTipo: SECTION,
		sectionId,
		lang,
		changedData: changedData as never,
		userId: USER_ID,
		bulkProcessId: extra.bulk ?? null,
		callerDataframe: extra.callerDataframe as never,
	});
	expect(saved.ok).toBe(true);
}

/** The main's items in `lang` REPLACED (set_data — every other language stays). */
function saveMain(
	kind: Kind,
	sectionId: number,
	items: Item[],
	lang = kind.lang,
	bulk: number | null = null,
) {
	return save(sectionId, kind.main, lang, [{ action: 'set_data', value: items }], { bulk });
}

/** A frame of this main (a dataframe slot save paired by caller_dataframe, lang-less). */
function frameSave(
	kind: Kind,
	sectionId: number,
	idKey: number,
	change: Item,
	bulk: number | null = null,
) {
	return save(sectionId, kind.slot, NOLAN, [change], {
		bulk,
		callerDataframe: { main_component_tipo: kind.main, id_key: idKey },
	});
}

const addFrame = (kind: Kind, id: number, idKey: number, n: number, bulk: number | null = null) =>
	frameSave(
		kind,
		id,
		idKey,
		{
			action: 'insert',
			id: null,
			value: { section_tipo: kind.frameTarget, section_id: String(frameTargetId(kind, n)) },
		},
		bulk,
	);

/** This main's live frame paired to `idKey` (the one the client edits). */
async function ownFrameOf(kind: Kind, id: number, idKey: number): Promise<Item> {
	const slot = (await stored(id, 'relation', kind.slot)) as Item[] | undefined;
	return mustGet(
		(slot ?? []).find((f) => f.main_component_tipo === kind.main && Number(f.id_key) === idKey),
		`${kind.main}'s frame of item ${idKey}`,
	);
}

async function changeFrame(
	kind: Kind,
	id: number,
	idKey: number,
	n: number,
	bulk: number | null = null,
) {
	const frame = await ownFrameOf(kind, id, idKey);
	await frameSave(
		kind,
		id,
		idKey,
		{
			action: 'update',
			id: frame.id,
			value: { ...frame, section_id: String(frameTargetId(kind, n)) },
		},
		bulk,
	);
}

async function removeFrame(kind: Kind, id: number, idKey: number, bulk: number | null = null) {
	const frame = await ownFrameOf(kind, id, idKey);
	await frameSave(kind, id, idKey, { action: 'remove', id: frame.id, value: null }, bulk);
}

async function mint(): Promise<number> {
	const id = await createSectionRecord('dd800', USER_ID);
	runs.push(id);
	return id;
}

interface RevertData {
	counter: number;
	unchanged: number;
	bulk_process_id: number;
	exact: 'full' | 'partial' | 'none';
	skipped: unknown[];
	inexact: unknown[];
}

async function revert(bulk: number): Promise<RevertData> {
	const response = await toolTimeMachineBulkRevert({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options: { bulk_process_id: bulk },
		background: false,
	});
	expect(response.ok).toBe(true);
	const data = response.data as RevertData;
	runs.push(data.bulk_process_id);
	return data;
}

interface TmRow {
	id: number;
	lang: string | null;
	data: unknown;
}

/** The VISIBLE rows of the main above a watermark, id ASC. */
async function mainRows(kind: Kind, sectionId: number, afterId = 0): Promise<TmRow[]> {
	const rows = (await sql.unsafe(
		`SELECT id, lang, data FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND id > $4 AND tm_role IS NULL
		  ORDER BY id ASC`,
		[SECTION, sectionId, kind.main, afterId],
	)) as TmRow[];
	return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

/** No row is ever written under the slot's own tipo. */
async function slotRowCount(kind: Kind, sectionId: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
		[SECTION, sectionId, kind.slot],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

async function watermark(): Promise<number> {
	const rows = (await sql.unsafe('SELECT COALESCE(MAX(id), 0) AS m FROM matrix_time_machine')) as {
		m: number;
	}[];
	return Number(rows[0]?.m ?? 0);
}

async function applyValue(kind: Kind, sectionId: number, row: TmRow): Promise<void> {
	const response = await toolTimeMachineApplyValue({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options: {
			section_tipo: SECTION,
			section_id: sectionId,
			tipo: kind.main,
			lang: row.lang ?? NOLAN,
			matrix_id: row.id,
		},
		background: false,
	});
	expect(response.ok).toBe(true);
}

// ---------------------------------------------------------------- the state (two lanes)

const asList = (value: unknown): Item[] => (Array.isArray(value) ? (value as Item[]) : []);
const frameSet = (frames: readonly Item[]): string[] => frames.map(canonicalJson).sort();

/** This main's frames of a slot value / a frame-lane image. */
const ownFrames = (kind: Kind, entries: readonly unknown[]): Item[] =>
	entries.filter(
		(entry): entry is Item => isFrameEntry(entry) && entry.main_component_tipo === kind.main,
	);

/** Everything in the slot that is not this main's frame (the foreign main's frames). */
const foreignOf = (kind: Kind, slot: unknown): string[] =>
	frameSet(asList(slot).filter((entry) => entry.main_component_tipo !== kind.main));

interface Live {
	main: Item[];
	slot: unknown;
}

async function live(kind: Kind, sectionId: number): Promise<Live> {
	return {
		main: asList(await stored(sectionId, kind.column, kind.main)),
		slot: await stored(sectionId, 'relation', kind.slot),
	};
}

/**
 * Whether lane `lane` carries a VALUE of the kind's main (relations/main_lanes.ts
 * laneHoldsValue): lg-nolan only for a non-translatable main; a language lane
 * for a sliced or a translatable main.
 */
const holdsValue = (kind: Kind, lane: string): boolean =>
	lane === NOLAN ? kind.sliced || !kind.translatable : kind.sliced || kind.translatable;

/** Whether applying a row of `lane` restores a value (a translatable main's lg-nolan row: its frames only). */
const restoresValue = (kind: Kind, lane: string): boolean =>
	holdsValue(kind, lane) && !(lane === NOLAN && kind.translatable);

/** A lane's value out of a main part (a sliced main: the lane's items; unsliced: the whole main). */
const laneItems = (kind: Kind, main: unknown, lane: string): string =>
	canonicalJson(kind.sliced ? asList(main).filter((item) => item.lang === lane) : asList(main));

/**
 * THE FULL STATE of a main in the gate's own terms (never through the engine's
 * reader): every value lane's items, and this main's frames — as a comparable
 * value. `lanes` lists the value lanes to compare.
 */
interface FullState {
	lanes: Record<string, string>;
	frames: string[];
}

/** The live full state over `lanes`. */
function liveState(kind: Kind, state: Live, lanes: readonly string[]): FullState {
	const out: Record<string, string> = {};
	for (const lane of lanes) {
		// an unsliced main holds ONE value: every lane that holds it shows it whole
		out[lane] = laneItems(kind, state.main, lane);
	}
	return { lanes: out, frames: frameSet(ownFrames(kind, asList(state.slot))) };
}

/** A FRAME-STATE row: the lg-nolan lane, or a row carrying a frame (PHP-era). */
const isFrameStateRow = (row: TmRow): boolean =>
	(row.lang ?? NOLAN) === NOLAN || splitComposed(row.data).frames.length > 0;

/**
 * THE STATE AT ROW R reconstructed from the visible history (the contract, in
 * the gate's own words): lane X = the newest lane-X row with id <= R (none:
 * empty then); the frames = the newest frame-state row with id <= R (none:
 * empty).
 */
function stateAt(
	kind: Kind,
	rows: readonly TmRow[],
	rowId: number,
	lanes: readonly string[],
): FullState {
	const upTo = rows.filter((row) => row.id <= rowId);
	const out: Record<string, string> = {};
	for (const lane of lanes) {
		const newest = upTo.filter((row) => (row.lang ?? NOLAN) === lane).at(-1);
		out[lane] = laneItems(kind, newest === undefined ? [] : splitComposed(newest.data).main, lane);
	}
	const frameRow = upTo.filter(isFrameStateRow).at(-1);
	const frames = frameRow === undefined ? [] : ownFrames(kind, splitComposed(frameRow.data).frames);
	return { lanes: out, frames: frameSet(frames) };
}

/** The value lanes a kind's timeline speaks (its own lane, its second language, lg-nolan when it holds a value). */
function valueLanes(kind: Kind): string[] {
	const lanes = [kind.lang, ...(kind.otherLang === null ? [] : [kind.otherLang]), NOLAN];
	return [...new Set(lanes)].filter((lane) => holdsValue(kind, lane));
}

/**
 * Every row a step wrote is ONE lane: at most one row per lane (no duplication
 * across languages); a language row carries only its value (no frame) equal to
 * the live lane; the lg-nolan row carries the live lg-nolan value and ALL the
 * main's live frames. And the NEWEST row reconstructs to the live full state.
 */
async function expectStepRowsAreState(
	kind: Kind,
	sectionId: number,
	mark: number,
): Promise<TmRow[]> {
	const rows = await mainRows(kind, sectionId, mark);
	expect(rows.length).toBeGreaterThan(0); // every step changed something: it is recorded
	const lanesWritten = rows.map((row) => row.lang ?? NOLAN);
	expect(new Set(lanesWritten).size).toBe(lanesWritten.length);
	const state = await live(kind, sectionId);
	for (const row of rows) {
		const lane = row.lang ?? NOLAN;
		const { main, frames } = splitComposed(row.data);
		if (lane !== NOLAN) {
			expect(frames).toEqual([]);
			expect(laneItems(kind, main, lane)).toBe(laneItems(kind, state.main, lane));
			continue;
		}
		expect(frameSet(ownFrames(kind, frames))).toEqual(
			frameSet(ownFrames(kind, asList(state.slot))),
		);
		if (holdsValue(kind, NOLAN))
			expect(laneItems(kind, main, NOLAN)).toBe(laneItems(kind, state.main, NOLAN));
	}
	const all = await mainRows(kind, sectionId);
	const newest = mustGet(rows.at(-1), 'the newest row');
	expect(stateAt(kind, all, newest.id, valueLanes(kind))).toEqual(
		liveState(kind, state, valueLanes(kind)),
	);
	expect(await slotRowCount(kind, sectionId)).toBe(0);
	return rows;
}

/**
 * What applying row R leaves (the contract): its OWN lane from the row (a
 * translatable main's lg-nolan row restores no value), the frames AS OF R,
 * every other lane as it was live before the apply.
 */
function expectedAfterApply(
	kind: Kind,
	rows: readonly TmRow[],
	row: TmRow,
	before: Live,
): FullState {
	const lanes = valueLanes(kind);
	const at = stateAt(kind, rows, row.id, lanes);
	const out = liveState(kind, before, lanes);
	const own = row.lang ?? NOLAN;
	if (restoresValue(kind, own)) {
		for (const lane of lanes)
			if (lane === own || !kind.sliced) out.lanes[lane] = at.lanes[own] as string;
	}
	return { lanes: out.lanes, frames: at.frames };
}

/** The FULL state (every language, this main's frames, the foreign frames) — the bulk revert's yardstick. */
async function fullState(kind: Kind, sectionId: number): Promise<string> {
	const state = await live(kind, sectionId);
	return canonicalJson({
		// the LANGUAGES of one key in any order: a region revert puts a lane back
		// where the live lane stands (lang_region.ts spliceRegion), and the save
		// path writes a lane after the others — the order is no state
		main: frameSet(state.main),
		frames: frameSet(ownFrames(kind, asList(state.slot))),
		foreign: foreignOf(kind, state.slot),
	});
}

/** A state's frames paired with an item of the view language or of the lg-nolan value. */
function shownFrames(kind: Kind, state: FullState): string[] {
	const ids = new Set(
		[kind.lang, NOLAN].flatMap((lane) =>
			asList(JSON.parse(state.lanes[lane] ?? '[]')).map((item) => String(item.id)),
		),
	);
	return state.frames.filter((frame) => ids.has(String(JSON.parse(frame).id_key)));
}

/** The frames a preview shows for the kind's slot. */
function previewFrames(kind: Kind, preview: unknown): string[] {
	const items = (Array.isArray(preview) ? preview : []) as { tipo?: string; entries?: Item[] }[];
	return frameSet(
		ownFrames(
			kind,
			items
				.filter((item) => item.tipo === kind.slot)
				.flatMap((item) => item.entries ?? [])
				.map(({ paginated_key: _page, ...frame }) => frame),
		),
	);
}

// ---------------------------------------------------------------- scenarios

type Step = (kind: Kind, id: number, bulk: number | null) => Promise<void>;

/** The save orders (item ids 1 and 2: the frames pair to them). */
const ORDERS: Record<'a' | 'b' | 'c' | 'd', { title: string; steps: Step[] }> = {
	a: {
		title: '(a) MAIN first, then its frame',
		steps: [
			(k, id, b) => saveMain(k, id, [k.item(1, 1)], k.lang, b),
			(k, id, b) => addFrame(k, id, 1, 1, b),
		],
	},
	b: {
		title: '(b) FRAME first (the main key still absent), then the main',
		steps: [
			(k, id, b) => addFrame(k, id, 1, 1, b),
			(k, id, b) => saveMain(k, id, [k.item(1, 1)], k.lang, b),
		],
	},
	c: {
		title:
			'(c) INTERLEAVED: main, frame add, frame change, main change, frame remove, frame add, main change',
		steps: [
			(k, id, b) => saveMain(k, id, [k.item(1, 1)], k.lang, b),
			(k, id, b) => addFrame(k, id, 1, 1, b),
			(k, id, b) => changeFrame(k, id, 1, 2, b),
			(k, id, b) => saveMain(k, id, [k.item(1, 2)], k.lang, b),
			(k, id, b) => removeFrame(k, id, 1, b),
			(k, id, b) => addFrame(k, id, 1, 3, b),
			(k, id, b) => saveMain(k, id, [k.item(1, 3)], k.lang, b),
		],
	},
	d: {
		title:
			'(d) a frame saved for an item the main does not hold YET (other items present), then that item',
		steps: [
			(k, id, b) => saveMain(k, id, [k.item(1, 1)], k.lang, b),
			(k, id, b) => addFrame(k, id, 2, 2, b),
			(k, id, b) => saveMain(k, id, [k.item(1, 1), k.item(2, 3)], k.lang, b),
			(k, id, b) => addFrame(k, id, 1, 4, b),
		],
	},
};

/**
 * A fresh record for a kind: the foreign main's frame in the shared slot and —
 * a kind with a second language — that language's value, written through the
 * real doors: a translatable kind's item (id 50) saved in it, with its own
 * frame; a transliterable kind's TRANSLITERATION (tool_lang's door,
 * translateAndWrite) of its lg-nolan base, which the scenarios then replace.
 */
async function freshRecord(kind: Kind): Promise<number> {
	const id = await rec();
	await seedSlot(id, kind.slot, [foreignFrame(kind)]);
	if (kind.otherVia === 'save' && kind.otherLang !== null) {
		await saveMain(kind, id, [kind.item(50, 9, kind.otherLang)], kind.otherLang);
		await addFrame(kind, id, 50, 4);
		// FLOOR: the other language's item keeps id 50 and holds its own frame
		const state = await live(kind, id);
		expect(state.main.map((item) => [item.id, item.lang])).toEqual([[50, kind.otherLang]]);
		expect(ownFrames(kind, asList(state.slot)).map((f) => Number(f.id_key))).toEqual([50]);
	}
	if (kind.otherVia === 'translate' && kind.otherLang !== null) {
		await saveMain(kind, id, [kind.item(50, 9)]);
		await transliterate(kind, id, kind.otherLang);
		// FLOOR: the transliteration lives beside its base, in its own language
		const state = await live(kind, id);
		expect(state.main.map((item) => item.lang)).toEqual([NOLAN, kind.otherLang]);
	}
	return id;
}

/** tool_lang's door (translateAndWrite) with a scripted provider: `<lang>:` + the source text. */
async function transliterate(kind: Kind, id: number, targetLang: string): Promise<void> {
	const outcome = await translateAndWrite(await superuserTranslationGrant(SECTION, kind.main, id), {
		model: 'component_input_text',
		sourceLang: NOLAN,
		targetLang,
		provider: async (req) => ({ ok: true, text: `${req.targetLang}:${req.text}`, msg: 'ok' }),
		uri: 'test://transliterate',
		key: '',
	});
	expect(outcome.ok).toBe(true);
}

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
	await assertTestDatabase('tm_save_order_native');
	await ensureSituation(SITUATION);
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	// STRUCTURE FLOOR: every kind's slot is its declared slot.
	for (const kind of KINDS) {
		expect(await resolveDataframeSlotTipos(kind.main)).toEqual([kind.slot]);
	}
	for (let n = 0; n < 6; n++) targets.push(await rec());
	for (let n = 0; n < 6; n++) labels.push(await createSectionRecord(LABEL_SECTION, USER_ID));
	bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
}, 60_000);

afterAll(async () => {
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [SECTION]);
	await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [REF]);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [REF]);
	const labelTable = (await getMatrixTableFromTipo(LABEL_SECTION)) as string;
	for (const labelId of labels) await cleanScratchRecord(LABEL_SECTION, labelId, labelTable);
	for (const id of runs) {
		await sql.unsafe(
			`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
	for (const tipo of [SECTION, REF]) {
		await sql.unsafe(`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1`, [tipo]);
	}
	expect(await dropSituation(SITUATION)).toBe(0);
}, 60_000);

// ---------------------------------------------------------------- the matrix

for (const kind of KINDS) {
	describe(`${kind.name}`, () => {
		/** A PHP-shaped row of the main (raw — read exactly like an engine row). */
		async function phpRow(id: number, data: unknown[]): Promise<TmRow> {
			const rowId = await insertLegacyBulkRow({
				sectionTipo: SECTION,
				sectionId: id,
				tipo: kind.main,
				lang: kind.lang,
				bulkId: null,
				data,
				timestamp: '2020-01-01 10:00:00',
			});
			return { id: rowId, lang: kind.lang, data };
		}

		/** A record whose main holds item 1 (variant 2) with its frame, all through the doors. */
		async function framedRecord(): Promise<number> {
			const id = await freshRecord(kind);
			await saveMain(kind, id, [kind.item(1, 2)]);
			await addFrame(kind, id, 1, 2);
			// FLOOR: the explicit item id is kept, and the frame pairs to it
			const state = await live(kind, id);
			expect(
				state.main.filter((item) => item.lang !== kind.otherLang).map((i) => Number(i.id)),
			).toEqual([1]);
			expect(ownFrames(kind, asList(state.slot)).map((f) => Number(f.id_key))).toContain(1);
			return id;
		}

		/** Apply `row` and assert the contract: its own lane back, the frames AS OF it, the rest live. */
		async function applyAndExpect(id: number, row: TmRow): Promise<Live> {
			const before = await live(kind, id);
			const history = await mainRows(kind, id);
			await applyValue(kind, id, row);
			const after = await live(kind, id);
			expect(liveState(kind, after, valueLanes(kind))).toEqual(
				expectedAfterApply(kind, history, row, before),
			);
			// the foreign main's frame in the shared slot is never rewound
			expect(foreignOf(kind, after.slot)).toEqual(foreignOf(kind, before.slot));
			return after;
		}

		if (kind.lang === NOLAN) {
			test('a PHP-shaped FRAMELESS lg-nolan row restores the value and EMPTIES this main’s frames (no refusal)', async () => {
				const id = await framedRecord();
				expect(ownFrames(kind, asList((await live(kind, id)).slot)).length).toBeGreaterThan(0); // FLOOR
				const after = await applyAndExpect(id, await phpRow(id, [kind.item(1, 1)]));
				expect(ownFrames(kind, asList(after.slot))).toEqual([]);
			});
		} else {
			test('a FRAMELESS language row carries no frame information: the value comes back, the frames are the lg-nolan lane’s as of it', async () => {
				const id = await framedRecord();
				const frames = frameSet(ownFrames(kind, asList((await live(kind, id)).slot)));
				expect(frames.length).toBeGreaterThan(0); // FLOOR
				const after = await applyAndExpect(id, await phpRow(id, [kind.item(1, 1)]));
				expect(frameSet(ownFrames(kind, asList(after.slot)))).toEqual(frames);
			});
		}

		test('a PHP-shaped COMPOSED row restores its lane AND its frames', async () => {
			const id = await framedRecord();
			const recorded = {
				id: 7,
				type: 'dd490',
				id_key: 1,
				section_tipo: kind.frameTarget,
				section_id: frameTargetId(kind, 5),
				from_component_tipo: kind.slot,
				main_component_tipo: kind.main,
			};
			// PHP stored the FULL slot: the foreign main's frame (at an older target) too
			const staleForeign = { ...foreignFrame(kind), section_id: frameTargetId(kind, 4) };
			const after = await applyAndExpect(
				id,
				await phpRow(id, [kind.item(1, 1), recorded, staleForeign]),
			);
			expect(ownFrames(kind, asList(after.slot)).map((f) => Number(f.section_id))).toContain(
				frameTargetId(kind, 5),
			);
		});

		for (const order of Object.values(ORDERS)) {
			test(`${order.title}: every row is one lane, the newest is the full state, and previewing / applying ANY row returns exactly the state at it`, async () => {
				const id = await freshRecord(kind);
				const start = await watermark();
				const foreign = foreignOf(kind, (await live(kind, id)).slot);
				for (const step of order.steps) {
					const mark = await watermark();
					await step(kind, id, null);
					await expectStepRowsAreState(kind, id, mark);
					expect(foreignOf(kind, (await live(kind, id)).slot)).toEqual(foreign);
				}
				const rows = await mainRows(kind, id, start);
				expect(rows.length).toBeGreaterThanOrEqual(order.steps.length); // FLOOR
				// MIDDLE STATES: each row, newest first — its preview shows the frames
				// as of it, and applying it leaves exactly the state at it.
				for (const row of [...rows].reverse()) {
					const history = await mainRows(kind, id);
					const at = stateAt(kind, history, row.id, valueLanes(kind));
					// the read pairs a frame with a SHOWN item of the view (the paired
					// get_data graft), so the preview is the state's frames of those items
					// (a literal main's read shows a frame-first frame too): between the two
					const shown = previewFrames(kind, await previewOf(kind.main, id, row.id, kind.lang));
					expect(shown.filter((frame) => !at.frames.includes(frame))).toEqual([]);
					expect(shownFrames(kind, at).filter((frame) => !shown.includes(frame))).toEqual([]);
					await applyAndExpect(id, row);
				}
			}, 60_000);
		}

		/** This main's frames' id_keys, the second language's (50) left out. */
		const ownKeys = (state: Live): number[] =>
			ownFrames(kind, asList(state.slot))
				.map((frame) => Number(frame.id_key))
				.filter((key) => key !== 50)
				.sort();

		test('removing a MAIN item strips its frames (every main kind), the row carries the stripped slot, and a bulk revert brings both back', async () => {
			const id = await freshRecord(kind);
			await saveMain(kind, id, [kind.item(1, 1), kind.item(2, 2)]);
			await addFrame(kind, id, 1, 1);
			await addFrame(kind, id, 2, 2);
			expect(ownKeys(await live(kind, id))).toEqual([1, 2]); // FLOOR: both items framed
			const pre = await fullState(kind, id);
			const run = await mint();
			const mark = await watermark();
			await save(id, kind.main, kind.lang, [{ action: 'remove', id: 1, value: null }], {
				bulk: run,
			});
			const after = await live(kind, id);
			expect(after.main.some((item) => Number(item.id) === 1)).toBe(false);
			expect(ownKeys(after)).toEqual([2]); // item 1's frame went with it
			await expectStepRowsAreState(kind, id, mark); // the composed row is the stripped state
			const data = await revert(run);
			expect(data.skipped).toEqual([]);
			expect(data.exact).toBe('full');
			expect(await fullState(kind, id)).toEqual(pre);
		}, 60_000);

		test('a BULK run over a FRAME-FIRST pre-run state (a frame whose item does not exist yet) reverts exactly', async () => {
			const records = [await freshRecord(kind), await freshRecord(kind)];
			for (const id of records) {
				await saveMain(kind, id, [kind.item(1, 1)]);
				await addFrame(kind, id, 2, 2); // item 2 is never saved
			}
			const pre = await Promise.all(records.map((id) => fullState(kind, id)));
			const run = await mint();
			await changeFrame(kind, records[0] as number, 2, 3, run);
			await removeFrame(kind, records[1] as number, 2, run);
			expect(await Promise.all(records.map((id) => fullState(kind, id)))).not.toEqual(pre); // FLOOR
			const data = await revert(run);
			expect(data.skipped).toEqual([]);
			expect(data.exact).toBe('full');
			expect(await Promise.all(records.map((id) => fullState(kind, id)))).toEqual(pre);
		}, 60_000);

		if (kind.otherVia === 'save' && kind.otherLang !== null) {
			const other = kind.otherLang;
			test('restoring one language’s row after ANOTHER language’s item was removed writes back no orphan frame', async () => {
				const id = await freshRecord(kind); // item 50 (other language) + its frame
				await saveMain(kind, id, [kind.item(1, 1)]);
				await addFrame(kind, id, 1, 1);
				const row = mustGet(
					(await mainRows(kind, id)).filter((r) => r.lang === kind.lang).at(-1),
					'the newest row of the tracked language',
				);
				// FLOOR: the frame state AS OF the row (the lg-nolan lane) holds the
				// other language's frame too; the language row itself holds none
				expect(splitComposed(row.data).frames).toEqual([]);
				const at = stateAt(kind, await mainRows(kind, id), row.id, valueLanes(kind));
				expect(at.frames.some((frame) => frame.includes('"id_key":50'))).toBe(true);
				await save(id, kind.main, other, [{ action: 'remove', id: 50, value: null }]);
				expect(ownKeys(await live(kind, id))).toEqual([1]); // FLOOR: the cascade stripped 50's frame
				await saveMain(kind, id, [kind.item(1, 2)]); // something to restore
				await applyValue(kind, id, row);
				const state = await live(kind, id);
				const held = new Set(state.main.map((item) => String(item.id)));
				expect(
					ownFrames(kind, asList(state.slot)).filter((frame) => !held.has(String(frame.id_key))),
				).toEqual([]);
				// … and the row's own state is back: its lane, and the frames as of it but 50's
				expect(laneItems(kind, state.main, kind.lang)).toBe(
					laneItems(kind, splitComposed(row.data).main, kind.lang),
				);
				expect(frameSet(ownFrames(kind, asList(state.slot)))).toEqual(
					at.frames.filter((frame) => !frame.includes('"id_key":50')),
				);
			}, 60_000);
		}

		if (kind.otherVia === 'translate' && kind.otherLang !== null) {
			const other = kind.otherLang;
			test('a TRANSLITERATION is its own lane: restoring its row keeps the lg-nolan base and takes the frames as of it; an lg-nolan row previews the transliteration as it stood', async () => {
				const id = await freshRecord(kind); // base item 50 + its lg-ell transliteration
				await saveMain(kind, id, [kind.item(1, 1)]); // the base replaced (the transliteration stays)
				await addFrame(kind, id, 1, 1);
				const ellRow = mustGet(
					(await mainRows(kind, id)).filter((r) => r.lang === other).at(-1),
					'the transliteration row',
				);
				expect(splitComposed(ellRow.data).frames).toEqual([]); // a language row: its value only
				const baseRow = mustGet((await mainRows(kind, id)).at(-1), 'the frame row');
				expect(baseRow.lang).toBe(NOLAN); // FLOOR: the frame save wrote the lg-nolan lane
				await transliterate(kind, id, other); // a second transliteration (of the new base)
				await changeFrame(kind, id, 1, 2);
				// the lg-nolan row previews its base (the value of the row) and — the
				// preview's own reader — the transliteration AS IT STOOD then
				const preview = JSON.stringify(await previewOf(kind.main, id, baseRow.id, NOLAN));
				expect(preview).toContain(`${NOLAN} name 1`);
				const coords = { sectionTipo: SECTION, sectionId: id, componentTipo: kind.main };
				const law = { sliced: true, translatable: false };
				const asOf = await readLaneValueAt(coords, other, baseRow.id, law);
				expect(asList(asOf.value).map((item) => [item.lang, item.value])).toEqual([
					[other, `${other}:${NOLAN} name 9`],
				]);
				// restoring the transliteration row: that lane back, the base live, the frames as of it
				await applyAndExpect(id, ellRow);
				const state = await live(kind, id);
				expect(state.main.filter((item) => item.lang === NOLAN)).toEqual([kind.item(1, 1)]);
			}, 60_000);
		}

		test('a BULK run mixing the four orders reverts every record exactly (and its revert is exact too)', async () => {
			const records = [
				await freshRecord(kind),
				await freshRecord(kind),
				await freshRecord(kind),
				await freshRecord(kind),
			];
			const pre = await Promise.all(records.map((id) => fullState(kind, id)));
			const run = await mint();
			const orders = [ORDERS.a, ORDERS.b, ORDERS.c, ORDERS.d];
			// interleave the four records' steps: one run, orders mixed
			const longest = Math.max(...orders.map((order) => order.steps.length));
			for (let step = 0; step < longest; step++) {
				for (const [n, order] of orders.entries()) {
					const next = order.steps[step];
					if (next !== undefined) await next(kind, records[n] as number, run);
				}
			}
			const post = await Promise.all(records.map((id) => fullState(kind, id)));
			expect(post).not.toEqual(pre); // FLOOR: the run changed every record
			for (const id of records) expect(await slotRowCount(kind, id)).toBe(0);
			const data = await revert(run);
			expect(data.skipped).toEqual([]);
			expect(data.exact).toBe('full');
			expect(await Promise.all(records.map((id) => fullState(kind, id)))).toEqual(pre);
			const again = await revert(data.bulk_process_id);
			expect(again.skipped).toEqual([]);
			expect(await Promise.all(records.map((id) => fullState(kind, id)))).toEqual(post);
		}, 60_000);
	});
}

// ---------------------------------------------------------------- one reading rule: the row is the full state

/** A frame of `main` in `slot`, paired to item `idKey`, at frame target `n`. */
function frameOf(main: string, slot: string, frameId: number, idKey: number, n: number): Item {
	return {
		id: frameId,
		type: 'dd490',
		id_key: idKey,
		section_tipo: SECTION,
		section_id: target(n),
		from_component_tipo: slot,
		main_component_tipo: main,
	};
}

/** M2's portal item 1. */
const m2Item = (): Item => ({
	id: 1,
	type: 'dd151',
	section_tipo: SECTION,
	section_id: target(1),
	from_component_tipo: M2,
});

/** M2's three slots, as stored. */
async function m2Slots(id: number): Promise<Record<string, unknown>> {
	return {
		a: await stored(id, 'relation', M2A),
		b: await stored(id, 'relation', M2B),
		h: await stored(id, 'relation', M2H),
	};
}

async function applyRow(tipo: string, sectionId: number, rowId: number, lang = NOLAN) {
	const response = await toolTimeMachineApplyValue({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options: { section_tipo: SECTION, section_id: sectionId, tipo, lang, matrix_id: rowId },
		background: false,
	});
	expect(response.ok).toBe(true);
}

/** The TM preview of `tipo` from row `matrixId` (the tool's preview pane request). */
async function previewOf(tipo: string, sectionId: number, matrixId: number, lang: string) {
	return runWithRequestLangs(
		{ applicationLang: 'lg-eng', dataLang: lang === NOLAN ? 'lg-eng' : lang },
		() =>
			readComponentData({
				source: {
					tipo,
					section_tipo: SECTION,
					section_id: sectionId,
					lang,
					mode: 'edit',
					data_source: 'tm',
					matrix_id: matrixId,
				},
			} as never),
	);
}

describe('ONE reading rule: a row is the full state — a slot it is silent about was EMPTY (two show slots + a hide-only slot)', () => {
	/** A record whose M2 holds item 1 with a live frame in EVERY slot. */
	async function m2Record(): Promise<number> {
		const id = await rec();
		await seedSlot(id, M2A, [frameOf(M2, M2A, 1, 1, 1)]);
		await seedSlot(id, M2B, [frameOf(M2, M2B, 1, 1, 2)]);
		await seedSlot(id, M2H, [frameOf(M2, M2H, 1, 1, 3)]);
		await save(id, M2, NOLAN, [{ action: 'set_data', value: [m2Item()] }]);
		return id;
	}

	const phpRow = (id: number, data: unknown[], bulkId: number | null = null) =>
		insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: M2,
			lang: NOLAN,
			bulkId,
			data,
		});

	/** The composed image of M2 (item 1 + the given slot frames). */
	const image = (...frames: unknown[]): unknown[] => [m2Item(), ...frames];

	test('the slot set is the union (A, B show; H hide-only)', async () => {
		expect([...(await resolveDataframeSlotTipos(M2))].sort()).toEqual([M2A, M2B, M2H].sort());
	});

	test('a row naming slot B only (a PHP slot-save shape) restores B and EMPTIES A and H', async () => {
		const id = await m2Record();
		const recordedB = frameOf(M2, M2B, 7, 1, 4);
		await applyRow(M2, id, await phpRow(id, image(recordedB)));
		expect(await m2Slots(id)).toEqual({ a: undefined, b: [recordedB], h: undefined });
	});

	test('a row naming A and B restores both and EMPTIES the hide-only slot', async () => {
		const id = await m2Record();
		const recordedA = frameOf(M2, M2A, 8, 1, 5);
		const recordedB = frameOf(M2, M2B, 9, 1, 4);
		await applyRow(M2, id, await phpRow(id, image(recordedA, recordedB)));
		expect(await m2Slots(id)).toEqual({ a: [recordedA], b: [recordedB], h: undefined });
	});

	test('a FRAMELESS row of a multi-slot main empties EVERY slot', async () => {
		const id = await m2Record();
		await applyRow(M2, id, await phpRow(id, image()));
		expect(await m2Slots(id)).toEqual({ a: undefined, b: undefined, h: undefined });
	});

	test('an engine-written row reads the same: every slot it is silent about is emptied', async () => {
		const id = await rec();
		await save(id, M2, NOLAN, [{ action: 'set_data', value: [m2Item()] }]);
		const row = mustGet(
			(await mainRows({ ...(KINDS[0] as Kind), main: M2 }, id)).at(-1),
			'the composed row',
		);
		await seedSlot(id, M2A, [frameOf(M2, M2A, 1, 1, 1)]);
		await seedSlot(id, M2H, [frameOf(M2, M2H, 1, 1, 3)]);
		await applyRow(M2, id, row.id);
		expect(await m2Slots(id)).toEqual({ a: undefined, b: undefined, h: undefined });
	});

	test('the preview reads the same rule: a slot the row is silent about previews empty', async () => {
		const id = await m2Record();
		const recordedB = frameOf(M2, M2B, 7, 1, 4);
		const r = await phpRow(id, image(recordedB));
		const preview = (await previewOf(M2, id, r, NOLAN)) as { tipo: string; entries?: Item[] }[];
		const entriesOf = (slot: string) =>
			preview
				.filter((item) => item.tipo === slot)
				.flatMap((item) => item.entries ?? [])
				.map((frame) => Number(frame.id));
		// live frames exist in every slot; the preview shows the ROW's state
		expect([entriesOf(M2A), entriesOf(M2B), entriesOf(M2H)]).toEqual([[], [7], []]);
	});

	test('a LEGACY run reverts EVERY slot to the pre-run full state (a slot the pre-run row is silent about is emptied)', async () => {
		const id = await m2Record();
		const live0 = await m2Slots(id);
		const a0 = live0.a as Item[];
		const b0 = live0.b as Item[];
		const h0 = live0.h as Item[];
		await phpRow(id, image(...a0, ...b0)); // pre-run: H empty
		const run = await mint();
		const runB = frameOf(M2, M2B, 2, 1, 5);
		await phpRow(id, image(...a0, runB, ...h0), run); // after the run: B changed, H filled
		await seedSlot(id, M2B, [runB]);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(data.counter).toBeGreaterThan(0);
		expect(await m2Slots(id)).toEqual({ a: a0, b: b0, h: undefined });
	}, 60_000);

	test('a LEGACY run filling slot B the pre-run row is silent about empties B (never "unchanged", never refused)', async () => {
		const id = await m2Record();
		const live0 = await m2Slots(id);
		const a0 = live0.a as Item[];
		const h0 = live0.h as Item[];
		await phpRow(id, image(...a0, ...h0)); // pre-run: B empty
		const run = await mint();
		const runB = frameOf(M2, M2B, 2, 1, 5);
		await phpRow(id, image(...a0, runB, ...h0), run);
		await seedSlot(id, M2B, [runB]);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(data.counter).toBeGreaterThan(0);
		expect(await m2Slots(id)).toEqual({ a: a0, b: undefined, h: h0 });
	}, 60_000);

	// The conflict check covers EVERY slot the plan writes, against the run's LAST row.
	// AN UNDECLARED LIVE SLOT (USLOT: no main declares it, but it holds M2's
	// frames — ontology drift, a caller_dataframe outside M2's config). The
	// capture composes it (readMainSlots discovery), so every reading door
	// counts it: a row silent about it says it was EMPTY.
	describe('an UNDECLARED live slot holding the main’s frames is one of its slots', () => {
		const uFrame = () => frameOf(M2, USLOT, 11, 1, 2);
		async function withUndeclared(): Promise<number> {
			const id = await m2Record();
			await seedSlot(id, USLOT, [uFrame()]);
			expect(await resolveDataframeSlotTipos(M2)).not.toContain(USLOT); // FLOOR: undeclared
			return id;
		}

		test('apply_value of a row silent about it EMPTIES it', async () => {
			const id = await withUndeclared();
			await applyRow(M2, id, await phpRow(id, image(frameOf(M2, M2B, 7, 1, 4))));
			expect(await stored(id, 'relation', USLOT)).toBeUndefined();
		});

		test('the preview of a row silent about it shows it EMPTY', async () => {
			const id = await withUndeclared();
			const r = await phpRow(id, image(frameOf(M2, M2B, 7, 1, 4)));
			const text = JSON.stringify(await previewOf(USLOT, id, r, NOLAN));
			const live = JSON.stringify(
				await readComponentData({
					source: { tipo: USLOT, section_tipo: SECTION, section_id: id, lang: NOLAN, mode: 'edit' },
				} as never),
			);
			expect(live).toContain(`"section_id":${target(2)}`); // FLOOR: the live read shows it
			expect(text).not.toContain(`"section_id":${target(2)}`);
		});

		test('a LEGACY run whose rows are silent about it: a frame there after the run refuses (changed_since_run)', async () => {
			const id = await m2Record();
			const live0 = await m2Slots(id);
			const a0 = live0.a as Item[];
			const h0 = live0.h as Item[];
			await phpRow(id, image(...a0, ...(live0.b as Item[]), ...h0));
			const run = await mint();
			const runB = frameOf(M2, M2B, 2, 1, 5);
			await phpRow(id, image(...a0, runB, ...h0), run);
			await seedSlot(id, M2B, [runB]);
			await seedSlot(id, USLOT, [uFrame()]); // after the run
			const data = await revert(run);
			expect(data.skipped).toEqual([
				expect.objectContaining({ reason: 'changed_since_run', tipo: M2, section_id: id }),
			]);
			expect(await stored(id, 'relation', USLOT)).toEqual([uFrame()]);
			expect(await stored(id, 'relation', M2B)).toEqual([runB]);
		}, 60_000);
	});

	test('a LEGACY run on B: slot A edited after the run refuses (changed_since_run), A kept', async () => {
		const id = await m2Record();
		const live0 = await m2Slots(id);
		const a0 = live0.a as Item[];
		const b0 = live0.b as Item[];
		const h0 = live0.h as Item[];
		await phpRow(id, image(...a0, ...b0, ...h0));
		const run = await mint();
		const runB = frameOf(M2, M2B, 2, 1, 5);
		await phpRow(id, image(...a0, runB, ...h0), run);
		await seedSlot(id, M2B, [runB]);
		const curatorA = frameOf(M2, M2A, 3, 1, 4);
		await seedSlot(id, M2A, [curatorA]); // after the run
		const data = await revert(run);
		expect(data.skipped).toEqual([
			expect.objectContaining({ reason: 'changed_since_run', tipo: M2, section_id: id }),
		]);
		expect(await m2Slots(id)).toEqual({ a: [curatorA], b: [runB], h: h0 });
	}, 60_000);

	test('a LEGACY run on a slot its last row is silent about: a frame added there after the run refuses', async () => {
		const id = await m2Record();
		const live0 = await m2Slots(id);
		const a0 = live0.a as Item[];
		const b0 = live0.b as Item[];
		await seedSlot(id, M2H, []);
		await phpRow(id, image(...a0, ...b0));
		const run = await mint();
		const runB = frameOf(M2, M2B, 2, 1, 5);
		await phpRow(id, image(...a0, runB), run); // the LAST row: H empty after the run
		await seedSlot(id, M2B, [runB]);
		const curatorH = frameOf(M2, M2H, 3, 1, 4);
		await seedSlot(id, M2H, [curatorH]);
		const data = await revert(run);
		expect(data.skipped).toEqual([
			expect.objectContaining({ reason: 'changed_since_run', tipo: M2, section_id: id }),
		]);
		expect(await m2Slots(id)).toEqual({ a: a0, b: [runB], h: [curatorH] });
	}, 60_000);

	test('the same run on a record BORN in it: B edited after the run refuses, never blanked', async () => {
		const run = await mint();
		const id = await rec();
		const runB = frameOf(M2, M2B, 2, 1, 5);
		const runA = frameOf(M2, M2A, 2, 1, 5);
		await phpRow(id, image(runB), run);
		await phpRow(id, image(runA, runB), run);
		await seedSlot(id, M2, [m2Item()]);
		await seedSlot(id, M2A, [runA]);
		const curatorB = frameOf(M2, M2B, 3, 1, 4);
		await seedSlot(id, M2B, [curatorB]);
		const data = await revert(run);
		expect(data.skipped).toEqual([
			expect.objectContaining({ reason: 'changed_since_run', tipo: M2, section_id: id }),
		]);
		expect(await m2Slots(id)).toEqual({ a: [runA], b: [curatorB], h: undefined });
		// FLOOR: untouched after the run, the same record blanks (born in the run)
		await seedSlot(id, M2B, [runB]);
		const clean = await revert(run);
		expect(clean.skipped).toEqual([]);
		expect(await m2Slots(id)).toEqual({ a: undefined, b: undefined, h: undefined });
	}, 60_000);
});

describe('a LEGACY run of v6 slot-save rows under a TRANSLATABLE literal main (tagged lg-nolan, every language)', () => {
	const kind = KINDS[2] as Kind; // LMAIN, input_text, two languages
	test('reverts the frames the run changed (never "unchanged")', async () => {
		const id = await freshRecord(kind); // lg-spa item 50 + its frame
		await saveMain(kind, id, [kind.item(1, 1)]);
		await addFrame(kind, id, 1, 1);
		const state = await live(kind, id);
		const frames = ownFrames(kind, asList(state.slot));
		const foreign = asList(state.slot).filter((entry) => entry.main_component_tipo !== kind.main);
		// pre-run: the v6 slot save — the main in EVERY language + the slot, tagged lg-nolan
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: kind.main,
			lang: NOLAN,
			bulkId: null,
			data: [...state.main, ...asList(state.slot)],
		});
		const pre = await fullState(kind, id);
		// the run: the same shape, item 1's frame re-pointed, and the record as it left it
		const run = await mint();
		const moved = frames.map((frame) =>
			Number(frame.id_key) === 1 ? { ...frame, section_id: frameTargetId(kind, 3) } : frame,
		);
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: kind.main,
			lang: NOLAN,
			bulkId: run,
			data: [...state.main, ...foreign, ...moved],
		});
		await seedSlot(id, kind.slot, [...foreign, ...moved]);
		expect(await fullState(kind, id)).not.toEqual(pre); // FLOOR: the run changed a frame
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(data.counter).toBeGreaterThan(0);
		expect(await fullState(kind, id)).toEqual(pre);
	}, 60_000);
});

describe('a LEGACY run of v6 slot-save rows whose main part is ONE language tagged lg-nolan (the migrated shape)', () => {
	const kind = KINDS[2] as Kind; // LMAIN, input_text
	test('reverts the frames and leaves the main live — no lg-nolan item merged in', async () => {
		const id = await rec();
		const eng: Item = { id: 1, lang: 'lg-eng', value: 'eng live' };
		const spa: Item = { id: 50, lang: 'lg-spa', value: 'spa live' };
		await sql.unsafe(
			`UPDATE "${TABLE}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id, LMAIN, JSON.stringify([eng, spa])],
		);
		const v6Main: Item = { id: 1, lang: NOLAN, value: 'eng v6' };
		const fA = (n: number) => frameOf(LMAIN, LSLOT, 1, 1, n);
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: LMAIN,
			lang: NOLAN,
			bulkId: null,
			data: [v6Main, fA(1)], // THE PRE-RUN ROW
		});
		const run = await mint();
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: LMAIN,
			lang: NOLAN,
			bulkId: run,
			data: [v6Main, fA(2)],
		});
		await seedSlot(id, LSLOT, [fA(2)]);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(asList(await stored(id, kind.column, LMAIN))).toEqual([eng, spa]);
		expect(asList(await stored(id, 'relation', LSLOT))).toEqual([fA(1)]);
	}, 60_000);
});

describe('a LEGACY language-sliced run keeps a frame edit a PRE-RUN v6 slot save (tagged lg-nolan) recorded', () => {
	test('spa row (frame A), v6 lg-nolan slot save (frame B), spa legacy run: the revert keeps B', async () => {
		const id = await rec();
		const spa = (value: string): Item => ({ id: 1, lang: 'lg-spa', value });
		const f = (n: number) => frameOf(LMAIN, LSLOT, 1, 1, n);
		const php = (lang: string, data: unknown[], bulkId: number | null = null) =>
			insertLegacyBulkRow({ sectionTipo: SECTION, sectionId: id, tipo: LMAIN, lang, bulkId, data });
		await php('lg-spa', [spa('v1'), f(1)]); // R1: frame A
		await php(NOLAN, [{ id: 1, lang: NOLAN, value: 'v1' }, f(2)]); // R2: the curator's frame edit → B
		const run = await mint();
		await php('lg-spa', [spa('v2'), f(2)], run); // R3: the run changed the text only
		await sql.unsafe(
			`UPDATE "${TABLE}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id, LMAIN, JSON.stringify([spa('v2')])],
		);
		await seedSlot(id, LSLOT, [f(2)]);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(asList(await stored(id, 'string', LMAIN))).toEqual([spa('v1')]);
		expect(asList(await stored(id, 'relation', LSLOT))).toEqual([f(2)]);
	}, 60_000);

	test('a TWO-language run: the frame half never reads the run’s own row of the other language', async () => {
		const id = await rec();
		const item = (lang: string, value: string): Item => ({
			id: lang === 'lg-spa' ? 1 : 2,
			lang,
			value,
		});
		const fs = (n: number) => frameOf(LMAIN, LSLOT, 1, 1, n);
		const fe = (n: number) => frameOf(LMAIN, LSLOT, 2, 2, n);
		const php = (lang: string, data: unknown[], bulkId: number | null = null) =>
			insertLegacyBulkRow({ sectionTipo: SECTION, sectionId: id, tipo: LMAIN, lang, bulkId, data });
		await php('lg-spa', [item('lg-spa', 'v1'), fs(1)]); // pre-run, spa
		await php('lg-eng', [item('lg-eng', 'e1'), fs(1), fe(1)]); // pre-run, eng (newest: the full frames)
		const run = await mint();
		const after = [item('lg-spa', 'v2'), item('lg-eng', 'e2'), fs(3), fe(3)];
		await php('lg-eng', [item('lg-eng', 'e2'), fs(3), fe(3)], run); // the run's EARLIER row
		await php('lg-spa', [item('lg-spa', 'v2'), fs(3), fe(3)], run);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id, LMAIN, JSON.stringify(after.slice(0, 2))],
		);
		await seedSlot(id, LSLOT, [fs(3), fe(3)]);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(frameSet(asList(await stored(id, 'string', LMAIN)))).toEqual(
			frameSet([item('lg-spa', 'v1'), item('lg-eng', 'e1')]),
		);
		expect(frameSet(asList(await stored(id, 'relation', LSLOT)))).toEqual(frameSet([fs(1), fe(1)]));
	}, 60_000);
});

describe('a LEGACY run: the frame half is ONE per main, whatever tags the run wrote', () => {
	test('a v6 slot save (lg-nolan) changing a spa-item AND an eng-item frame, then a spa main save: exact, nothing skipped', async () => {
		const id = await rec();
		const spa = (value: string): Item => ({ id: 1, lang: 'lg-spa', value });
		const eng: Item = { id: 2, lang: 'lg-eng', value: 'e1' };
		const fs = (n: number) => frameOf(LMAIN, LSLOT, 1, 1, n);
		const fe = (n: number) => frameOf(LMAIN, LSLOT, 2, 2, n);
		const php = (lang: string, data: unknown[], bulkId: number | null = null) =>
			insertLegacyBulkRow({ sectionTipo: SECTION, sectionId: id, tipo: LMAIN, lang, bulkId, data });
		await php('lg-spa', [spa('v1'), fs(1), fe(1)]); // pre-run, spa
		await php('lg-eng', [eng, fs(1), fe(1)]); // pre-run, eng (newest: the full frames)
		const run = await mint();
		// r2: the v6 slot save — the main in one language, tagged lg-nolan, both frames moved
		await php(NOLAN, [{ id: 1, lang: NOLAN, value: 'v1' }, fs(3), fe(3)], run);
		// r3: the spa main save — a full-state row, so it carries r2's frames
		await php('lg-spa', [spa('v2'), fs(3), fe(3)], run);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id, LMAIN, JSON.stringify([spa('v2'), eng])],
		);
		await seedSlot(id, LSLOT, [fs(3), fe(3)]);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(frameSet(asList(await stored(id, 'string', LMAIN)))).toEqual(frameSet([spa('v1'), eng]));
		expect(frameSet(asList(await stored(id, 'relation', LSLOT)))).toEqual(frameSet([fs(1), fe(1)]));
	}, 60_000);
});

// ---------------------------------------------------------------- the observer door

describe('the set_dato_external observer door composes its rows like every main door', () => {
	/** Point (or unpoint) a REF record's indexer at the host. */
	async function index(referencer: number, host: number | null): Promise<void> {
		const value =
			host === null
				? []
				: [
						{
							id: 1,
							type: 'dd96',
							section_tipo: SECTION,
							section_id: host,
							from_component_tipo: INDEXER,
						},
					];
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[REF, referencer, INDEXER, JSON.stringify(value)],
		);
	}
	const recompute = (host: number) =>
		recomputeExternalRelation(OMAIN, SECTION, host, USER_ID, new Date(), {});
	const observerKind = { ...(KINDS[0] as Kind), main: OMAIN, slot: OSLOT };

	test('its rows carry the frames, restoring one keeps them, and a dropped locator takes its frame', async () => {
		const host = await rec();
		const [r1, r2] = [
			await createSectionRecord(REF, USER_ID),
			await createSectionRecord(REF, USER_ID),
		];
		await index(r1, host);
		expect((await recompute(host)).wrote).toBe(true);
		const first = mustGet(asList(await stored(host, 'relation', OMAIN))[0], 'the mirrored locator');
		await save(
			host,
			OSLOT,
			NOLAN,
			[
				{
					action: 'insert',
					id: null,
					value: { section_tipo: SECTION, section_id: String(target(1)) },
				},
			],
			{ callerDataframe: { main_component_tipo: OMAIN, id_key: Number(first.id) } },
		);
		const framed = asList(await stored(host, 'relation', OSLOT));
		expect(framed.length).toBe(1); // FLOOR

		// GROW: the recompute's row is composed — the frame is in it …
		await index(r2, host);
		const mark = await watermark();
		expect((await recompute(host)).wrote).toBe(true);
		const grown = mustGet((await mainRows(observerKind, host, mark)).at(-1), 'the recompute row');
		expect(frameSet(ownFrames(observerKind, splitComposed(grown.data).frames))).toEqual(
			frameSet(framed),
		);
		// … so restoring it keeps the frame (a frameless row would empty it)
		await applyRow(OMAIN, host, grown.id);
		expect(asList(await stored(host, 'relation', OSLOT))).toEqual(framed);

		// DROP: r1 stops referencing the host — its locator's frame goes with it
		await index(r1, null);
		const dropMark = await watermark();
		expect((await recompute(host)).wrote).toBe(true);
		expect(asList(await stored(host, 'relation', OSLOT))).toEqual([]);
		const dropped = mustGet((await mainRows(observerKind, host, dropMark)).at(-1), 'the drop row');
		expect(splitComposed(dropped.data).frames).toEqual([]);
		expect(asList(splitComposed(dropped.data).main).map((item) => Number(item.section_id))).toEqual(
			[r2],
		);
	}, 60_000);
});

// ---------------------------------------------------------------- the main's own timeline

/** How many rows the TM tool lists for a main in `lang` (its filter_by_locators query). */
async function toolListed(tipo: string, sectionId: number, lang: string): Promise<number> {
	const sqo = {
		filter_by_locators: [{ section_tipo: SECTION, section_id: sectionId, tipo, lang }],
		limit: 50,
		offset: 0,
	};
	return countTimeMachineData({ sqo } as never);
}

/** Run with the page's data lang in scope, as a request does. */
const inDataLang = <T>(dataLang: string, fn: () => Promise<T>): Promise<T> =>
	runWithRequestLangs({ applicationLang: 'lg-eng', dataLang }, fn);

describe('a slot save writes ONE lg-nolan row; the timeline of a language lists both lanes', () => {
	const tKind: Kind = {
		...(KINDS[0] as Kind),
		main: TMAIN,
		slot: TSLOT,
		translatable: true,
		lang: 'lg-spa',
		item: (id, variant) => ({
			id,
			type: 'dd151',
			section_tipo: SECTION,
			section_id: target(variant),
			from_component_tipo: TMAIN,
		}),
	};

	test('a TRANSLATABLE-flagged RELATION main is UNSLICED: every save is ONE lg-nolan row (value + frames), listed in every language timeline; a frame row restores value and frames', async () => {
		await inDataLang('lg-spa', async () => {
			const id = await rec();
			await saveMain(tKind, id, [tKind.item(1, 1)]);
			await addFrame(tKind, id, 1, 1);
			const first = await ownFrameOf(tKind, id, 1);
			await changeFrame(tKind, id, 1, 2);
			const rows = await mainRows(tKind, id);
			// decision 2026-09-29: the lane follows the DATA SHAPE — never the ontology flag
			expect(rows.map((row) => row.lang)).toEqual([NOLAN, NOLAN, NOLAN]);
			const value = asList(await stored(id, 'relation', TMAIN)); // (the save stamps its request lang on the locator: save-path data, not a lane)
			for (const row of rows) {
				expect(splitComposed(row.data).main).toEqual(value); // the whole value, every row
			}
			expect(await toolListed(TMAIN, id, 'lg-spa')).toBe(rows.length);
			expect(await toolListed(TMAIN, id, 'lg-eng')).toBe(rows.length);
			const frameRow = mustGet(rows[1], 'the frame-add row');
			expect(ownFrames(tKind, splitComposed(frameRow.data).frames)).toEqual([first]);
			await applyValue(tKind, id, frameRow);
			expect(ownFrames(tKind, asList(await stored(id, 'relation', TSLOT)))).toEqual([first]);
			expect(asList(await stored(id, 'relation', TMAIN)).map((item) => item.id)).toEqual([1]);
			// the restore's own row is lg-nolan too
			const after = await mainRows(tKind, id, (rows.at(-1) as TmRow).id);
			expect(after.map((row) => row.lang)).toEqual([NOLAN]);
		});
	}, 60_000);

	test('a FRAME-FIRST save on a translatable literal main holding no language is ONE lg-nolan row, listed in the language timeline; restoring it brings the frames back and leaves the value', async () => {
		const kind = KINDS[2] as Kind; // LMAIN
		await inDataLang(kind.lang, async () => {
			const id = await rec();
			await addFrame(kind, id, 1, 1); // the main key is still absent in every language
			const frame = await ownFrameOf(kind, id, 1);
			const [frameFirst] = await mainRows(kind, id);
			expect(frameFirst?.lang).toBe(NOLAN);
			expect(await toolListed(kind.main, id, kind.lang)).toBe(1);
			await saveMain(kind, id, [kind.item(1, 1)]);
			await changeFrame(kind, id, 1, 2);
			await applyValue(kind, id, mustGet(frameFirst, 'the frame-first row'));
			// an lg-nolan row of a translatable main holds no value: the language stays
			expect(asList(await stored(id, kind.column, kind.main))).toEqual([kind.item(1, 1)]);
			expect(ownFrames(kind, asList(await stored(id, 'relation', kind.slot)))).toEqual([frame]);
		});
	}, 60_000);

	test('two languages and a frame save: exactly one lg-nolan row, never a copy per language', async () => {
		const kind = KINDS[2] as Kind; // LMAIN
		const id = await freshRecord(kind); // spa item 50 + its frame
		await saveMain(kind, id, [kind.item(1, 1)]);
		const mark = await watermark();
		await addFrame(kind, id, 1, 1);
		expect((await mainRows(kind, id, mark)).map((row) => row.lang)).toEqual([NOLAN]);
		// a value save that strips no frame writes its language row only
		const valueMark = await watermark();
		await saveMain(kind, id, [kind.item(1, 2)]);
		expect((await mainRows(kind, id, valueMark)).map((row) => row.lang)).toEqual([kind.lang]);
	}, 60_000);

	/** The revert run's VISIBLE rows of the main (its after-rows), id ASC. */
	async function runRows(sectionId: number, bulk: number): Promise<TmRow[]> {
		const rows = (await sql.unsafe(
			`SELECT id, lang, data FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3
			    AND bulk_process_id = $4 AND tm_role IS NULL
			  ORDER BY id ASC`,
			[SECTION, sectionId, TMAIN, bulk],
		)) as TmRow[];
		return rows.map((row) => ({ ...row, id: Number(row.id) }));
	}

	test('a BULK run over a TRANSLATABLE-flagged RELATION main (main save, then a slot save): lg-nolan pairs only; the revert — from another data lang — is exact, and so is its revert', async () => {
		const id = await inDataLang('lg-spa', async () => {
			const created = await rec();
			await saveMain(tKind, created, [tKind.item(1, 1)]);
			await addFrame(tKind, created, 1, 1);
			return created;
		});
		const pre = await live(tKind, id);
		const run = await mint();
		await inDataLang('lg-spa', async () => {
			await saveMain(tKind, id, [tKind.item(1, 2)], 'lg-spa', run);
			await changeFrame(tKind, id, 1, 2, run);
		});
		const post = await live(tKind, id);
		expect(canonicalJson(post)).not.toBe(canonicalJson(pre)); // FLOOR: the run changed both
		const runLangs = (await sql.unsafe(
			`SELECT DISTINCT lang FROM matrix_time_machine WHERE bulk_process_id = $1 AND tipo = $2`,
			[run, TMAIN],
		)) as { lang: string }[];
		expect(runLangs.map((row) => row.lang)).toEqual([NOLAN]);
		const back = await inDataLang('lg-eng', () => revert(run));
		expect(back.skipped).toEqual([]);
		expect(back.exact).toBe('full');
		expect(await live(tKind, id)).toEqual(pre);
		const rows = await runRows(id, back.bulk_process_id);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((row) => row.lang === NOLAN)).toBe(true);
		expect(splitComposed((rows.at(-1) as TmRow).data).main).toEqual(pre.main);
		const again = await inDataLang('lg-eng', () => revert(back.bulk_process_id));
		expect(again.skipped).toEqual([]);
		expect(again.exact).toBe('full');
		expect(await live(tKind, id)).toEqual(post);
	}, 60_000);

	test('a door handing a LANGUAGE lane (and the ontology flag) for an UNSLICED main records it in lg-nolan: value + frames, one row', async () => {
		const id = await rec();
		const target = { table: TABLE, sectionTipo: SECTION, sectionId: id };
		const slots = { slots: [TSLOT], images: {} };
		const mark = await watermark();
		await inDataLang('lg-spa', () =>
			recordMainHistory(
				target,
				{ tipo: TMAIN, lang: 'lg-spa', sliced: false, translatable: true },
				{
					before: { value: [tKind.item(1, 1)], slots },
					after: { value: [tKind.item(1, 2)], slots },
				},
				historyStamp(USER_ID, null),
			),
		);
		// Re-pinned 2026-11-12 (T1-21): the before (item 1 v1) has no history at
		// this record, so the writer's save-before backfills it first — in the
		// same lg-nolan lane, which is what this case pins.
		const rows = await mainRows(tKind, id, mark);
		expect(rows.map((row) => row.lang)).toEqual([NOLAN, NOLAN]);
		expect(splitComposed(mustGet(rows[0], 'the backfill row').data).main).toEqual([
			tKind.item(1, 1),
		]);
		expect(splitComposed(mustGet(rows[1], 'the lg-nolan row').data).main).toEqual([
			tKind.item(1, 2),
		]);
	}, 60_000);
});

// ---------------------------------------------------------------- legacy revert: the pairing law

describe('a LEGACY (v6) run never writes back the frame of another language item deleted since', () => {
	const kind = KINDS[2] as Kind; // LMAIN, input_text: eng is the run's language, spa the sibling
	const eng = (value: string): Item => ({ id: 1, lang: 'lg-eng', value });
	const spa: Item = { id: 50, lang: 'lg-spa', value: 'spa item' };
	const fA = () => frameOf(LMAIN, LSLOT, 1, 1, 1);
	const fX = () => frameOf(LMAIN, LSLOT, 2, 50, 2);
	const php = (id: number, lang: string, data: unknown[], bulkId: number | null = null) =>
		insertLegacyBulkRow({ sectionTipo: SECTION, sectionId: id, tipo: LMAIN, lang, bulkId, data });

	/** The record as the run left it: eng item `value`, the slot `slot`. */
	async function leave(id: number, value: string, slot: Item[]): Promise<void> {
		await sql.unsafe(
			`UPDATE "${TABLE}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id, LMAIN, JSON.stringify([eng(value)])],
		);
		await seedSlot(id, LSLOT, slot);
	}

	test('a language-sliced run (tagged eng)', async () => {
		const id = await rec();
		await php(id, 'lg-spa', [spa, fA(), fX()]); // spa X and its frame
		await php(id, 'lg-eng', [eng('before'), fA(), fX()]); // THE PRE-RUN ROW
		await php(id, 'lg-spa', [fA()]); // X deleted in spa: its frame stripped
		const run = await mint();
		await php(id, 'lg-eng', [eng('run'), fA()], run);
		await leave(id, 'run', [fA()]);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(asList(await stored(id, kind.column, LMAIN))).toEqual([eng('before')]);
		expect(asList(await stored(id, 'relation', LSLOT))).toEqual([fA()]); // no orphan fX
	}, 60_000);

	test('an all-language slot-save run (tagged lg-nolan) — and its own history row restores', async () => {
		const id = await rec();
		await php(id, 'lg-spa', [spa, fA(), fX()]);
		await php(id, NOLAN, [eng('same'), spa, fA(), fX()]); // THE PRE-RUN ROW (all languages)
		// X deleted with the time machine off: no row (a spa row would itself be
		// the all-language pre-run state, every row of a main being composed).
		const run = await mint();
		const moved = { ...fA(), section_id: target(3) };
		await php(id, NOLAN, [eng('same'), moved], run);
		await leave(id, 'same', [moved]);
		const mark = await watermark();
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(data.counter).toBeGreaterThan(0);
		expect(asList(await stored(id, 'relation', LSLOT))).toEqual([fA()]); // no orphan fX
		// THE REVERT'S OWN VISIBLE ROW is ONE lg-nolan row (the frame lane — listed in
		// every language timeline of the main), and restores the frames.
		const own = (await mainRows(kind, id)).filter((row) => row.id > mark);
		expect(own.map((row) => row.lang)).toEqual([NOLAN]);
		const lg = mustGet(own[0], 'the revert row');
		expect(ownFrames(kind, splitComposed(lg.data).frames)).toEqual([fA()]);
		expect(splitComposed(lg.data).main).toEqual([]); // a translatable main: no lg-nolan value
		expect(await toolListed(LMAIN, id, 'lg-eng')).toBeGreaterThan(0);
		await seedSlot(id, LSLOT, [moved]);
		await applyRow(LMAIN, id, lg.id, NOLAN);
		expect(asList(await stored(id, 'relation', LSLOT))).toEqual([fA()]);
	}, 60_000);

	// An eng item imported with the time machine off (no row), named first by an
	// eng row ABOVE the restored spa row, then deleted: its frame is stale.
	const f9 = () => frameOf(LMAIN, LSLOT, 3, 9, 3);
	const fS = () => frameOf(LMAIN, LSLOT, 2, 50, 2);
	async function importedThenDeleted(id: number): Promise<void> {
		await php(id, 'lg-eng', [{ id: 9, lang: 'lg-eng', value: 'imported' }, fS(), f9()]); // E1
		await php(id, 'lg-eng', [fS()]); // E2: item 9 removed, its frame stripped
	}

	test('apply_value: an other-language item known only ABOVE the restored row leaves no orphan frame', async () => {
		const id = await rec();
		const r = await php(id, 'lg-spa', [spa, fS(), f9()]); // R: PHP composed the full slot
		await importedThenDeleted(id);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id, LMAIN, JSON.stringify([{ ...spa, value: 'spa edited' }])],
		);
		await seedSlot(id, LSLOT, [fS()]);
		await applyRow(LMAIN, id, r, 'lg-spa');
		expect(asList(await stored(id, kind.column, LMAIN))).toEqual([spa]);
		expect(asList(await stored(id, 'relation', LSLOT))).toEqual([fS()]); // no orphan f9
	}, 60_000);

	test('apply_value of a FRAMELESS PHP language row that dropped the only framed item: the frame state below it holds that frame, which is never written back', async () => {
		const id = await rec();
		const item7: Item = { id: 7, lang: 'lg-spa', value: 'framed' };
		const item8: Item = { id: 8, lang: 'lg-spa', value: 'kept' };
		const f7 = frameOf(LMAIN, LSLOT, 4, 7, 4);
		await php(id, 'lg-spa', [item7, f7]); // R1: item 7 and its frame (PHP composed the slot)
		const r2 = await php(id, 'lg-spa', [item8]); // R2: item 7 removed — no frame left, so none carried
		await sql.unsafe(
			`UPDATE "${TABLE}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id, LMAIN, JSON.stringify([{ ...item8, value: 'edited' }])],
		);
		await applyRow(LMAIN, id, r2, 'lg-spa');
		expect(asList(await stored(id, kind.column, LMAIN))).toEqual([item8]);
		expect(ownFrames(kind, asList(await stored(id, 'relation', LSLOT)))).toEqual([]); // no orphan f7
	}, 60_000);

	test('a legacy run: the same item known only ABOVE the pre-run row leaves no orphan frame', async () => {
		const id = await rec();
		await php(id, 'lg-spa', [spa, fS(), f9()]); // THE PRE-RUN ROW (spa)
		await importedThenDeleted(id);
		const run = await mint();
		const spaRun = { ...spa, value: 'spa run' };
		await php(id, 'lg-spa', [spaRun, fS()], run);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id, LMAIN, JSON.stringify([spaRun])],
		);
		await seedSlot(id, LSLOT, [fS()]);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(asList(await stored(id, kind.column, LMAIN))).toEqual([spa]);
		expect(asList(await stored(id, 'relation', LSLOT))).toEqual([fS()]); // no orphan f9
	}, 60_000);
});

// ---------------------------------------------------------------- delete_data: a wiped main's frames leave with it

describe('delete_data empties a wiped main’s frames in EVERY declared slot — in the section subtree or not', () => {
	const xKind: Kind = {
		...(KINDS[1] as Kind),
		name: 'a LITERAL main whose slot only its request_config names (outside the subtree)',
		main: XMAIN,
		slot: XSLOT,
	};
	/** Kinds whose slot is NOT a component of the section (the subtree walk never reaches it). */
	const outside = new Set([IRI_SLOT, XSLOT]);
	/**
	 * The foreign main's frames in a slot outside the subtree: a main that does
	 * not declare the slot (FMAIN in XSLOT) keeps them — not this wipe's to
	 * take; IMAIN2 declares dd560 (the model's fixed slot) and is a field of the
	 * same record, so its frames leave with it (every field's frames go).
	 */
	const expectForeign = (kind: Kind, before: unknown, after: unknown): void => {
		if (!outside.has(kind.slot)) return;
		expect(foreignOf(kind, before).length).toBeGreaterThan(0); // FLOOR
		expect(foreignOf(kind, after)).toEqual(kind.slot === IRI_SLOT ? [] : foreignOf(kind, before));
	};

	for (const kind of [...KINDS, xKind]) {
		test(`${kind.name}: no frame of the main survives, and the wipe row carries none`, async () => {
			const id = await freshRecord(kind);
			await saveMain(kind, id, [kind.item(1, 1)]);
			const own = {
				id: 20,
				type: 'dd490',
				id_key: 1,
				section_tipo: kind.frameTarget,
				section_id: frameTargetId(kind, 2),
				from_component_tipo: kind.slot,
				main_component_tipo: kind.main,
			};
			await seedSlot(id, kind.slot, [...asList(await stored(id, 'relation', kind.slot)), own]);
			const before = await live(kind, id);
			expect(ownFrames(kind, asList(before.slot)).length).toBeGreaterThan(0); // FLOOR
			await deleteSectionData(SECTION, id, USER_ID);
			const after = await live(kind, id);
			expect(after.main).toEqual([]);
			expect(ownFrames(kind, asList(after.slot))).toEqual([]);
			expectForeign(kind, before.slot, after.slot);
			const wipe = mustGet((await mainRows(kind, id)).at(-1), 'the wipe row');
			expect(asList(splitComposed(wipe.data).main)).toEqual([]);
			expect(ownFrames(kind, splitComposed(wipe.data).frames)).toEqual([]);
		}, 60_000);

		test(`${kind.name}: an EMPTY main's frames (saved before its item) leave too, under a composed wipe row`, async () => {
			const id = await rec();
			const own = {
				id: 21,
				type: 'dd490',
				id_key: 1,
				section_tipo: kind.frameTarget,
				section_id: frameTargetId(kind, 3),
				from_component_tipo: kind.slot,
				main_component_tipo: kind.main,
			};
			await seedSlot(id, kind.slot, [foreignFrame(kind), own]);
			const before = await live(kind, id);
			expect(before.main).toEqual([]); // FLOOR: the main holds no value
			const mark = await watermark();
			await deleteSectionData(SECTION, id, USER_ID);
			const after = await live(kind, id);
			expect(ownFrames(kind, asList(after.slot))).toEqual([]);
			expectForeign(kind, before.slot, after.slot);
			// the main's history: the backfill (its frame as it stood), then the wipe (none)
			const rows = await mainRows(kind, id, mark);
			expect(ownFrames(kind, splitComposed(rows[0]?.data).frames)).toEqual([own]);
			const wipe = mustGet(rows.at(-1), 'the wipe row');
			expect(rows.length).toBeGreaterThan(1);
			expect(ownFrames(kind, splitComposed(wipe.data).frames)).toEqual([]);
		}, 60_000);
	}

	test('an UNSTAMPED frame (no main named) in dd560 of empty iris leaves, recorded under the iri that stripped it', async () => {
		const kind = KINDS[3] as Kind; // IMAIN, dd560: no declaring parent to attribute to
		const id = await rec();
		const { main_component_tipo: _main, ...unstamped } = {
			id: 22,
			type: 'dd490',
			id_key: 1,
			section_tipo: LABEL_SECTION,
			section_id: label(4),
			from_component_tipo: IRI_SLOT,
			main_component_tipo: kind.main,
		};
		await seedSlot(id, IRI_SLOT, [unstamped]);
		const mark = await watermark();
		await deleteSectionData(SECTION, id, USER_ID);
		expect(await stored(id, 'relation', IRI_SLOT)).toBeUndefined();
		// An unstamped frame is OWN to every main declaring the slot (isOwnFrame):
		// exactly one of the two iris strips it, and that one's history records it.
		const rows = [
			...(await mainRows(kind, id, mark)),
			...(await mainRows({ ...kind, main: IMAIN2 }, id, mark)),
		];
		expect(rows.map((row) => splitComposed(row.data).frames)).toEqual([[unstamped], []]);
	}, 60_000);
});

// ---------------------------------------------------------------- an item a restore drops leaves no orphan frame

describe('an item a restore drops leaves no orphan frame in any slot (the row is the full state)', () => {
	const item2 = (): Item => ({ ...m2Item(), id: 2, section_id: target(2) });
	const phpRow = (id: number, data: unknown[], bulkId: number | null = null) =>
		insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: M2,
			lang: NOLAN,
			bulkId,
			data,
		});
	const itemFrames = (key: number) => [
		frameOf(M2, M2A, key, key, key),
		frameOf(M2, M2B, key, key, key),
		frameOf(M2, M2H, key, key, key),
	];

	/** M2 holds items 1 and 2, each with a frame in every slot (A, B, H). */
	async function twoItemRecord(): Promise<number> {
		const id = await rec();
		await save(id, M2, NOLAN, [{ action: 'set_data', value: [m2Item(), item2()] }]);
		await seedSlot(id, M2A, [frameOf(M2, M2A, 1, 1, 1), frameOf(M2, M2A, 2, 2, 2)]);
		await seedSlot(id, M2B, [frameOf(M2, M2B, 1, 1, 1), frameOf(M2, M2B, 2, 2, 2)]);
		await seedSlot(id, M2H, [frameOf(M2, M2H, 1, 1, 1), frameOf(M2, M2H, 2, 2, 2)]);
		return id;
	}
	const keysOf = (value: unknown) => asList(value).map((frame) => Number(frame.id_key));

	test('apply_value of a row holding item 1 and its frames: item 2 and its frames gone from every slot', async () => {
		const id = await twoItemRecord();
		await applyRow(M2, id, await phpRow(id, [m2Item(), ...itemFrames(1)]));
		expect(asList(await stored(id, 'relation', M2)).map((item) => Number(item.id))).toEqual([1]);
		const slots = await m2Slots(id);
		expect([keysOf(slots.a), keysOf(slots.b), keysOf(slots.h)]).toEqual([[1], [1], [1]]);
	});

	test('a LEGACY bulk revert that drops item 2 takes its frames out of every slot', async () => {
		const id = await twoItemRecord();
		const live0 = await m2Slots(id);
		await phpRow(id, [m2Item(), ...itemFrames(1)]); // pre-run: item 1 + its frames
		const run = await mint();
		await phpRow(id, [m2Item(), item2(), ...itemFrames(1), ...itemFrames(2)], run); // the run added item 2
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(asList(await stored(id, 'relation', M2)).map((item) => Number(item.id))).toEqual([1]);
		const slots = await m2Slots(id);
		expect([keysOf(slots.a), keysOf(slots.b), keysOf(slots.h)]).toEqual([[1], [1], [1]]);
		expect(keysOf(live0.a)).toEqual([1, 2]); // FLOOR: there was an item-2 frame to drop
	}, 60_000);
});

// ---------------------------------------------------------------- v6 shapes of a literal main's row

describe('a v6 SLOT-SAVE row of a TRANSLATABLE literal main (tagged lg-nolan) restores the frames only', () => {
	const kind = KINDS[2] as Kind; // LMAIN, input_text: eng item 1, spa item 50
	const eng: Item = { id: 1, lang: 'lg-eng', value: 'eng live' };
	const spa: Item = { id: 50, lang: 'lg-spa', value: 'spa live' };
	const fA = (n: number) => frameOf(LMAIN, LSLOT, 1, 1, n);
	const fX = (n: number) => frameOf(LMAIN, LSLOT, 2, 50, n);
	// v6 get_main_component_data read the main in ONE language; the v6→v7
	// reformat tagged its items with the row's lg-nolan (the WC-corrected shape),
	// or — the all-language image the legacy path also knows — every language.
	const SHAPES: { title: string; main: Item[] }[] = [
		{
			title: 'one language, items tagged lg-nolan',
			main: [{ id: 1, lang: NOLAN, value: 'eng v6' }],
		},
		{ title: 'every language, items tagged with theirs', main: [{ ...eng, value: 'v6' }, spa] },
	];

	for (const shape of SHAPES) {
		test(`${shape.title}: the main stays live, the frames come back, its own history is ONE lg-nolan row that restores them`, async () => {
			const id = await rec();
			await sql.unsafe(
				`UPDATE "${TABLE}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
				 WHERE section_tipo = $1 AND section_id = $2`,
				[SECTION, id, LMAIN, JSON.stringify([eng, spa])],
			);
			await seedSlot(id, LSLOT, [fA(3), fX(3)]);
			const r = await insertLegacyBulkRow({
				sectionTipo: SECTION,
				sectionId: id,
				tipo: LMAIN,
				lang: NOLAN,
				bulkId: null,
				data: [...shape.main, fA(1), fX(1)],
			});
			const mark = await watermark();
			await applyRow(LMAIN, id, r, NOLAN);
			// the main is untouched: no lg-nolan copy beside the real languages
			expect(asList(await stored(id, kind.column, LMAIN))).toEqual([eng, spa]);
			expect(asList(await stored(id, 'relation', LSLOT))).toEqual([fA(1), fX(1)]);
			// the restore's history: ONE lg-nolan row — the frame lane, no value (translatable)
			const rows = await mainRows(kind, id, mark);
			expect(rows.map((row) => row.lang)).toEqual([NOLAN]);
			for (const row of rows) {
				const { main, frames } = splitComposed(row.data);
				expect(main).toEqual([]);
				expect(frames).toEqual([fA(1), fX(1)]);
			}
			// the curator changes the frames; restoring the fresh row brings them back
			await seedSlot(id, LSLOT, [fA(4), fX(4)]);
			for (const row of rows) await applyRow(LMAIN, id, row.id, row.lang ?? NOLAN);
			expect(asList(await stored(id, kind.column, LMAIN))).toEqual([eng, spa]);
			expect(frameSet(asList(await stored(id, 'relation', LSLOT)))).toEqual(
				frameSet([fA(1), fX(1)]),
			);
		}, 60_000);
	}

	test('the preview of such a row shows the language AS IT STOOD at the row (its lane before it), never the row’s lg-nolan copy', async () => {
		const id = await rec();
		await sql.unsafe(
			`UPDATE "${TABLE}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id, LMAIN, JSON.stringify([eng, spa])],
		);
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: LMAIN,
			lang: 'lg-eng',
			bulkId: null,
			data: [{ ...eng, value: 'eng then' }],
		});
		const r = await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: LMAIN,
			lang: NOLAN,
			bulkId: null,
			data: [{ id: 1, lang: NOLAN, value: 'eng v6' }, fA(1)],
		});
		const text = JSON.stringify(await previewOf(LMAIN, id, r, 'lg-eng'));
		expect(text).toContain('eng then');
		expect(text).not.toContain('eng live');
		expect(text).not.toContain('eng v6');
	}, 60_000);
});

describe('a v6 LITERAL main row whose frames the v6→v7 reformat WRAPPED as {value:{frame},id,lang}', () => {
	/** A v6 legacy frame (section_id_key), as the reformat wrapped it. */
	const wrapped = (main: string, slot: string, key: number, n: number, lang: string): Item => ({
		value: {
			type: 'dd151',
			section_tipo: SECTION,
			section_id: String(target(n)),
			section_id_key: key,
			from_component_tipo: slot,
			main_component_tipo: main,
		},
		id: 7,
		lang,
	});
	/** The same frame after the dd490 migration (what a restore writes). */
	const migrated = (main: string, slot: string, key: number, n: number): Item => ({
		type: 'dd490',
		section_tipo: SECTION,
		section_id: target(n),
		from_component_tipo: slot,
		main_component_tipo: main,
		id_key: key,
	});
	const CASES = [
		{ kind: KINDS[1] as Kind, item: { id: 1, lang: NOLAN, value: 101 } }, // number
		{ kind: KINDS[2] as Kind, item: { id: 1, lang: 'lg-eng', value: 'eng v6' } }, // input_text
	];

	test('a wrapped frame is no ITEM: its wrapper id/lang never makes a frame-first frame stale', async () => {
		const id = await rec();
		const spa: Item = { id: 50, lang: 'lg-spa', value: 'spa' };
		const f7 = frameOf(LMAIN, LSLOT, 3, 7, 3); // frame-first: no item 7 ever existed
		const r = await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: LMAIN,
			lang: 'lg-spa',
			bulkId: null,
			data: [spa, f7],
		});
		// a later eng row whose wrapped frame's WRAPPER is { id: 7, lang: lg-eng }
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: LMAIN,
			lang: 'lg-eng',
			bulkId: null,
			data: [{ id: 1, lang: 'lg-eng', value: 'eng' }, wrapped(LMAIN, LSLOT, 1, 2, 'lg-eng')],
		});
		await applyRow(LMAIN, id, r, 'lg-spa');
		expect(asList(await stored(id, 'relation', LSLOT))).toEqual([f7]);
	}, 60_000);

	for (const { kind, item } of CASES) {
		test(`${kind.name}: restored and previewed, the frame is a frame — never text in the literal`, async () => {
			const id = await rec();
			await seedSlot(id, kind.slot, [frameOf(kind.main, kind.slot, 1, 1, 4)]);
			const lang = item.lang;
			const r = await insertLegacyBulkRow({
				sectionTipo: SECTION,
				sectionId: id,
				tipo: kind.main,
				lang,
				bulkId: null,
				data: [item, wrapped(kind.main, kind.slot, 1, 2, lang)],
			});
			const text = JSON.stringify(await previewOf(kind.main, id, r, lang));
			expect(text).not.toContain('section_id_key');
			await applyRow(kind.main, id, r, lang);
			expect(asList(await stored(id, kind.column, kind.main))).toEqual([item]);
			const slot = asList(await stored(id, 'relation', kind.slot));
			// the frame as the dd490 migration writes it (its section_id int-canonical)
			expect(slot.map(({ id: _id, ...frame }) => frame)).toEqual([
				migrated(kind.main, kind.slot, 1, 2),
			]);
		}, 60_000);
	}
});

describe('a TRANSLITERABLE main saved through the COMPONENT SAVE DOOR keeps the request lang (with_lang_versions — PHP component_common :666-678)', () => {
	const kind = mustGet(
		KINDS.find((k) => k.main === XLMAIN),
		'the transliterable kind',
	);

	test('an lg-ell set_data writes the lg-ell transliteration beside the lg-nolan base: ONE row, in the lg-ell lane', async () => {
		const id = await rec();
		await saveMain(kind, id, [kind.item(1, 1)]); // the base (Augustus)
		const mark = await watermark();
		await save(id, XLMAIN, 'lg-ell', [
			{ action: 'set_data', value: [{ id: 1, value: 'Αύγουστος' }] },
		]);
		const items = asList(await stored(id, 'string', XLMAIN));
		expect(items.map((item) => [item.lang, item.value])).toEqual([
			[NOLAN, `${NOLAN} name 1`], // the base is KEPT
			['lg-ell', 'Αύγουστος'],
		]);
		const rows = await mainRows(kind, id, mark);
		expect(rows.map((row) => [row.lang, row.data])).toEqual([
			['lg-ell', [{ id: 1, lang: 'lg-ell', value: 'Αύγουστος' }]],
		]);
	}, 60_000);

	test('a bulk run re-saving each stored language group unchanged (the update_cache regroup) writes NO row and moves nothing', async () => {
		const id = await rec();
		await saveMain(kind, id, [kind.item(1, 1)]);
		await save(id, XLMAIN, 'lg-ell', [
			{ action: 'set_data', value: [{ id: 1, value: 'Αύγουστος' }] },
		]);
		const before = await stored(id, 'string', XLMAIN);
		const mark = await watermark();
		const bulk = await mint();
		for (const lang of ['lg-ell', NOLAN]) {
			const group = asList(before).filter((item) => item.lang === lang);
			await save(id, XLMAIN, lang, [{ action: 'set_data', value: group }], { bulk });
		}
		const [{ n } = { n: -1 }] = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM matrix_time_machine WHERE id > $1 AND section_tipo = $2 AND section_id = $3',
			[mark, SECTION, id],
		)) as { n: number }[];
		expect(n).toBe(0); // no pair, no visible row, whatever role
		// the languages of one key in any order (a lane save writes its slice last — no state)
		expect(frameSet(asList(await stored(id, 'string', XLMAIN)))).toEqual(frameSet(asList(before)));
		expect(await mainRows(kind, id, mark)).toEqual([]);
	}, 60_000);
});
