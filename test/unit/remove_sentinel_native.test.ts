/**
 * THE REMOVE SENTINEL (DATA-06 / P0-8, 2026-08-30) —
 * `engineering/wire_contract/WC-2026-08-30-remove-requires-item-id.md`.
 *
 * Until this change, `{action:'remove'}` with no item id DELETED EVERY ITEM of
 * the component IN EVERY LANGUAGE and answered `ok:true` — while one branch
 * below, a remove naming an id the component does NOT hold failed the whole
 * save. That asymmetry is the defect: naming a wrong id was refused, naming NO
 * id destroyed everything and reported success.
 *
 * Null is not a caller saying "all". It is every caller's UNKNOWN-ID SENTINEL:
 * an unsaved row, the `item.id || null` idiom that collapses 0 and '', an
 * omitted MCP `item_id`. The census at the bottom of this file DERIVES those
 * sites across `client/`, `tools/` and `src/` — 32 of them on 2026-08-30, 19 in
 * shipped code and 13 in the client-suite fixtures. So the worst outcome this engine
 * can produce — silent destruction of curated values, in languages nobody was
 * editing — was one delete button away.
 *
 * The contract now: **a remove NAMES the item it removes; emptying the
 * component is the separate, explicit `clear` action.**
 *
 * WHAT THIS GATE PROVES, on a scratch twin whose situation it BUILDS:
 *
 *   A  an id-less remove is REFUSED (`record.remove_without_id`) and writes
 *      NOTHING — data column, item-id counter and Time Machine history all
 *      byte-unchanged. Three shapes: bare, carrying a `key` (the
 *      input_text/email `_do_remove` shape — a POSITION, which no branch of the
 *      write engine resolves to an item), and an id `JSON.stringify` dropped.
 *   B  the near-misses destroy nothing either: `''` takes the sentinel refusal,
 *      `0` is a real id nothing holds and takes the ordinary unknown-id refusal.
 *   C  ANTI-VACUITY — the legitimate path is untouched: a remove naming a real
 *      id removes EXACTLY that item, in every language it has, and leaves every
 *      OTHER item's languages byte-identical. A refusal that fires on the
 *      legitimate path would be an outage, not a guard.
 *   D  `clear` — the explicit wipe — still empties every language, and is
 *      audited (the Time Machine can undo it).
 *   E  the MCP door refuses a remove with no `item_id` BEFORE permissions, and
 *      its schema requires `item_id` for remove and offers `clear`.
 *   F  the TEMPORAL door refuses the same shape (WC-059 instances are not
 *      persisted, but the client applies the delta locally and the echo would
 *      report the wipe as done).
 *   G  the CLIENT MODEL door refuses it, proved by EXECUTING the real
 *      `component_common.prototype.update_data_value` out of the shipped file —
 *      and its refusal set is compared shape by shape against the server
 *      predicate's, because a shape only ONE door refuses is either an invisible
 *      failure at the wire or an outage in the browser.
 *   H  the DOOR CENSUS: the four doors, enumerated with a verdict, plus a
 *      DERIVED bypass scan — no module may call the applier without the
 *      predicate.
 *   I  the CALLER CENSUS: derived and TOTAL over `client/`, `tools/`, `src/` —
 *      every site that builds a `remove` whose id can be null is classified,
 *      and the set is SHRINK-ONLY.
 *
 * Generic `test` TLD, situation-built (AGENTS.md hard rules): section `zzrmv1`
 * on matrix_test (via the test24 relation) with one translatable
 * component_input_text (→ `string` column). Cleaned before and after.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { saveComponentValue } from '../../src/ai/mcp/tools/records_write.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { type DedaloError, isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import {
	saveComponentData,
	unnamedRemoveRefusal,
} from '../../src/core/section/record/save_component.ts';
import { resolveTemporalSave } from '../../src/core/section/record/temporal.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

const ROOT = resolve(import.meta.dir, '../..');
const TABLE = 'matrix_test';
const SECTION_TIPO = 'zzrmv1';
/** component_input_text, translatable → 'string' column. */
const COMPONENT = 'zzrmv2';
const RECORD_ID = 900810;
/** dropSituation scopes its sweep to the sections the situation declares records for. */
const ANCHOR_ID = 900811;

const SITUATION = situation({
	tld: 'zzrmv',
	name: 'remove_sentinel',
	nodes: [
		{
			tipo: SECTION_TIPO,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Centinela de borrado', 'lg-eng': 'Remove sentinel' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: COMPONENT,
			parent: SECTION_TIPO,
			model: 'component_input_text',
			is_translatable: true,
			term: { 'lg-spa': 'Texto', 'lg-eng': 'Text' },
		},
	],
	records: [{ section_tipo: SECTION_TIPO, section_id: ANCHOR_ID }],
});

/**
 * THE CURATED VALUE the defect destroyed: item id 1 in four languages (the
 * Spanish curator edits `lg-spa`; the other three are somebody else's work),
 * plus item id 2 so a legitimate single-item remove has something to leave
 * behind — and so C can prove the removal does not reach past its target.
 */
const SEED_STRING = {
	[COMPONENT]: [
		{ id: 1, lang: 'lg-spa', value: 'título' },
		{ id: 1, lang: 'lg-eng', value: 'title' },
		{ id: 1, lang: 'lg-fra', value: 'titre' },
		{ id: 1, lang: 'lg-ita', value: 'titolo' },
		{ id: 2, lang: 'lg-spa', value: 'segundo' },
		{ id: 2, lang: 'lg-eng', value: 'second' },
	],
};
const SEED_COLUMNS = { string: SEED_STRING, meta: { [COMPONENT]: [{ count: 2 }] } };

async function reseed(): Promise<void> {
	await cleanScratchRecord(SECTION_TIPO, RECORD_ID, TABLE);
	await createScratchRecord(SECTION_TIPO, RECORD_ID, SEED_COLUMNS, { table: TABLE });
}

async function refusalOf(run: Promise<unknown>): Promise<DedaloError> {
	try {
		await run;
	} catch (error) {
		if (isDedaloError(error)) return error;
		throw error;
	}
	throw new Error('expected a DedaloError, but the call succeeded');
}

async function tmRowCount(): Promise<number> {
	const rows = (await sql`
		SELECT count(*)::int AS n FROM matrix_time_machine
		WHERE section_tipo = ${SECTION_TIPO} AND section_id = ${RECORD_ID}
	`) as { n: number }[];
	return rows[0]?.n ?? 0;
}

function save(changedData: { action: string; id?: unknown; key?: number; value: unknown }[]) {
	return saveComponentData({
		componentTipo: COMPONENT,
		sectionTipo: SECTION_TIPO,
		sectionId: RECORD_ID,
		lang: 'lg-spa',
		changedData: changedData as never,
		userId: -1,
	});
}

type StoredItem = { id?: number; lang?: string; value?: string };

async function storedItems(): Promise<StoredItem[]> {
	const record = await readMatrixRecord(TABLE, SECTION_TIPO, RECORD_ID);
	const column = record?.columns.string as Record<string, unknown[]> | null;
	return (column?.[COMPONENT] ?? []) as StoredItem[];
}

/** The (lang → value) map of ONE item id, so C can compare an item that was not the target. */
async function itemLangs(id: number): Promise<Record<string, string | undefined>> {
	const map: Record<string, string | undefined> = {};
	for (const item of await storedItems()) {
		if (Number(item.id) === id) map[String(item.lang)] = item.value;
	}
	return map;
}

describe('the remove sentinel — an id-less remove destroys nothing', () => {
	beforeAll(async () => {
		await ensureSituation(SITUATION);
		expect(await getMatrixTableFromTipo(SECTION_TIPO)).toBe(TABLE);
		await reseed();
	});
	afterAll(async () => {
		await cleanScratchRecord(SECTION_TIPO, RECORD_ID, TABLE);
		expect(await dropSituation(SITUATION)).toBe(0);
	});

	test('the predicate is pure and total over the shapes the clients actually send', () => {
		// It answers on the CHANGE SET, so one bad change in a batch refuses the batch.
		expect(unnamedRemoveRefusal([{ action: 'remove', id: 7, value: null }])).toBeNull();
		expect(unnamedRemoveRefusal([{ action: 'remove', id: '7', value: null }])).toBeNull();
		expect(unnamedRemoveRefusal([{ action: 'remove', id: 0, value: null }])).toBeNull();
		expect(unnamedRemoveRefusal([{ action: 'clear', value: null }])).toBeNull();
		expect(unnamedRemoveRefusal([{ action: 'insert', id: null, value: {} }])).toBeNull();
		for (const id of [null, undefined, '']) {
			expect(unnamedRemoveRefusal([{ action: 'remove', id, value: null }])).toContain(
				'must name the item id',
			);
		}
		// A key is a POSITION; it never stands in for the id, and the refusal says so.
		expect(unnamedRemoveRefusal([{ action: 'remove', id: null, key: 3, value: null }])).toContain(
			'key 3',
		);
		expect(
			unnamedRemoveRefusal([
				{ action: 'update', id: 1, value: {} },
				{ action: 'remove', id: null, value: null },
			]),
		).not.toBeNull();
	});

	test('A. an id-less remove is refused and writes NOTHING (bare, with a key, and omitted)', async () => {
		await reseed();
		for (const change of [
			{ action: 'remove', id: null, value: null },
			// The component_input_text / component_email `_do_remove` shape: an
			// unsaved row's null id plus the render index. THE AUDIT'S NAMED CASE.
			{ action: 'remove', id: null, key: 0, value: null },
			{ action: 'remove', value: null }, // an id JSON.stringify dropped
		]) {
			const before = await readMatrixRecord(TABLE, SECTION_TIPO, RECORD_ID);
			const tmBefore = await tmRowCount();

			const error = await refusalOf(save([change]));
			expect(error.code).toBe('record.remove_without_id');

			const after = await readMatrixRecord(TABLE, SECTION_TIPO, RECORD_ID);
			// Byte-identical: all four languages of item 1 are still there.
			expect(after?.rawText.string).toBe(before?.rawText.string);
			expect(after?.rawText.meta ?? null).toBe(before?.rawText.meta ?? null);
			expect(await tmRowCount()).toBe(tmBefore);
		}
		expect((await storedItems()).length).toBe(6);
	});

	test('B. the near-misses of a null id destroy nothing either', async () => {
		await reseed();
		// '' is "no id" (the client's `|| null` idiom and an empty form field both
		// produce it): the sentinel refusal.
		const empty = await refusalOf(save([{ action: 'remove', id: '', value: null }]));
		expect(empty.code).toBe('record.remove_without_id');

		// 0 is an ID, not an absence — the engine allocates from 1, so nothing holds
		// it, and the answer is the ordinary unknown-id refusal. Asserted because the
		// destructive shape must have no back door: whichever branch a 0 takes, the
		// component must still be whole afterwards.
		const zero = await save([{ action: 'remove', id: 0, value: null }]);
		expect(zero.ok).toBe(false);
		expect(zero.message).toContain('no item with id 0');

		expect((await storedItems()).length).toBe(6);
	});

	test('C. ANTI-VACUITY: a remove naming a real id removes exactly it, and nothing else', async () => {
		await reseed();
		const otherBefore = await itemLangs(2);
		expect(otherBefore).toEqual({ 'lg-spa': 'segundo', 'lg-eng': 'second' });

		// Item id 1 exists in four languages; removing it removes the ITEM, which is
		// all four rows — that is the engine's contract, and it is what the curator
		// asked for when they named id 1.
		const removed = await save([{ action: 'remove', id: 1, value: null }]);
		expect(removed.ok).toBe(true);
		expect(await itemLangs(1)).toEqual({});

		// …and item 2 is untouched IN EVERY LANGUAGE. This is the half that the
		// destructive branch failed: the old wipe took the other items' languages
		// with it, which is the data loss nobody noticed.
		expect(await itemLangs(2)).toEqual(otherBefore);
		expect((await storedItems()).length).toBe(2);

		// An id the component does not hold still fails cleanly, changing nothing.
		const missing = await save([{ action: 'remove', id: 424242, value: null }]);
		expect(missing.ok).toBe(false);
		expect(missing.message).toContain('no item with id');
		expect(await itemLangs(2)).toEqual(otherBefore);
	});

	test('D. `clear` is the explicit wipe: every language goes, and it is audited', async () => {
		await reseed();
		const tmBefore = await tmRowCount();
		const cleared = await save([{ action: 'clear', value: null }]);
		expect(cleared.ok).toBe(true);
		expect(await storedItems()).toEqual([]);
		// A wipe is a change like any other: the Time Machine can undo it — one
		// row per language it emptied (two lanes: one row is one language,
		// WC-2026-09-27-bulk-revert-undo-log) — each preceded by its save-before
		// row, the reseed being RAW with no history (re-pinned 2026-11-12, T1-21).
		expect(await tmRowCount()).toBe(tmBefore + 8);
	});

	test('E. the MCP door refuses a remove with no item_id, before permissions or the engine', async () => {
		await reseed();
		// A principal with NO grants: if the refusal did not come first, this call
		// would fail on permissions instead — so the assertion doubles as proof of
		// the ORDER (the door must not need a writable record to say what is wrong).
		const nobody = { userId: -999, isGlobalAdmin: false, isDeveloper: false };
		const error = await refusalOf(
			saveComponentValue(nobody as never, {
				section_tipo: SECTION_TIPO,
				tipo: COMPONENT,
				section_id: RECORD_ID,
				action: 'remove',
			}),
		);
		expect(error.code).toBe('record.remove_without_id');
		expect(error.publicMessage).toContain('item_id');
		expect(error.publicMessage).toContain("'clear'");
		// It refused BEFORE the engine, so the record is whole.
		expect((await storedItems()).length).toBe(6);
	});

	test("E2. the MCP schema requires item_id for remove and offers 'clear'", async () => {
		const { RECORDS_WRITE_SPECS } = await import('../../src/ai/mcp/tools/records_write.ts');
		const spec = RECORDS_WRITE_SPECS.find((one) => one.name === 'dedalo_save_component');
		expect(spec).toBeDefined();
		const shape = spec?.inputShape as Record<
			string,
			{ options?: unknown[]; description?: string; _def?: { description?: string } }
		>;
		// The enum OPTIONS, not a substring of a serialized schema: `clear` has to be
		// a value the agent can actually send, or the refusal above names a door that
		// does not exist and every agent remove becomes unfixable.
		const actionOptions = (shape.action as unknown as { options?: unknown[] }).options ?? [];
		expect(actionOptions).toContain('clear');
		expect(actionOptions).toContain('remove');
		// The description IS the door's documentation — it is the only place the agent
		// learns that item_id is conditionally required (zod validates one field at a
		// time, so the requirement itself lives in the handler, proved by E above).
		const itemIdDescription = shape.item_id?.description ?? shape.item_id?._def?.description ?? '';
		expect(itemIdDescription).toContain('REQUIRED for remove');
		// A door that can empty a component must not advertise itself as additive.
		expect(spec?.annotations.destructiveHint).toBe(true);
	});

	test('F. the TEMPORAL door refuses the same shape (one law, both doors)', async () => {
		// WC-059 temporal instances persist no matrix record, but the client has
		// ALREADY applied the delta to the entries it ships: a shape this door
		// accepted would be echoed back as a completed wipe.
		const principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
		const error = await refusalOf(
			resolveTemporalSave(
				{
					source: { tipo: COMPONENT, section_tipo: SECTION_TIPO, lang: 'lg-spa' },
					data: { changed_data: [{ action: 'remove', id: null, value: null }] },
				} as never,
				principal as never,
			),
		);
		expect(error.code).toBe('record.remove_without_id');
	});
});

/**
 * G — THE CLIENT MODEL DOOR, EXECUTED.
 *
 * `bun test` runs no browser, and nothing else in this repo gates `client/`
 * BEHAVIOUR — which is exactly why the wildcard lived in this function for
 * years. So the gate lifts the REAL `update_data_value` out of the shipped file
 * and runs it. Not a substring check on the source (GATE-24: an integrity
 * decision may not rest on grep) — the actual function body, with the same
 * arguments the renderers pass it.
 *
 * WHY HERE AND NOT ONLY IN THE CLIENT SUITE: the client suite's fixture
 * (`client/dedalo/test/client/js/test_component_common_changed_data.js`) used to
 * drive a HAND-COPIED mock of this function — it stayed green whatever the
 * shipped file did, and it pinned the pre-2026-08-30 wipe as the expected
 * behaviour. It now imports `component_common` and drives the shipped prototype
 * method, so the two agree; but that suite needs a browser and a server and is
 * NOT run by `bun test`, so this block keeps the law inside the default gate.
 */
const COMPONENT_COMMON = 'client/dedalo/core/component_common/js/component_common.js';

/** Slice the shipped function body out between its assignment and its `end` marker. */
function loadUpdateDataValue(): (this: unknown, item: unknown) => unknown {
	const source = readFileSync(join(ROOT, COMPONENT_COMMON), 'utf8');
	const open = 'component_common.prototype.update_data_value = function(changed_data_item) {';
	const close = '}//end update_data_value';
	const start = source.indexOf(open);
	const end = source.indexOf(close, start);
	if (start === -1 || end === -1) {
		throw new Error(
			`${COMPONENT_COMMON}: could not find update_data_value between its assignment and '${close}'. ` +
				'If the function was renamed or the marker removed, THIS GATE must be repointed — not deleted: ' +
				'it is the only thing executing the client half of the remove sentinel.',
		);
	}
	const body = source.slice(start + open.length, end);
	// The body's only free identifiers besides `console`: SHOW_DEBUG, clone, alert.
	const factory = new Function(
		'SHOW_DEBUG',
		'clone',
		'alert',
		`return function(changed_data_item) {${body}}`,
	);
	return factory(
		false,
		(value: unknown) => value,
		(message: string) => {
			alerts.push(message);
		},
	);
}

const alerts: string[] = [];

function instance(
	entries: unknown[],
	mode = 'edit',
): { data: { entries: unknown[] }; [key: string]: unknown } {
	return {
		data: { entries },
		// EXPLICIT: the guard branches on the instance's own mode — a SEARCH
		// instance is a transient filter model with no save path, and emptying it
		// is not a delete (see the door-agreement test).
		mode,
		model: 'component_input_text',
		tipo: COMPONENT,
		section_tipo: SECTION_TIPO,
		section_id: RECORD_ID,
		label: 'Text',
		id: 'zzrmv2_test',
	};
}

describe('G0. the THREE client doors share ONE predicate (the drift that caused the defect)', () => {
	// WHY THIS EXISTS. The client has three places that must refuse a remove naming
	// no item: `update_data_value` (the model door), `save()` (the wire door, entered
	// directly by save_unsaved_components and any caller that fills changed_data by
	// hand), and `change_value`'s pre-flight. Until 2026-08-30 they were three inline
	// tests and they had ALREADY DRIFTED: the wire door listed `null` and `undefined`
	// but not `''`, so an `id:''` remove passed every client door and died at the wire
	// as a generic failed save — the refusal arriving where the curator could do
	// nothing with it. The fix was one module-scope predicate; this is what keeps it
	// one.
	const source = readFileSync(join(ROOT, COMPONENT_COMMON), 'utf8');

	test('the predicate covers exactly the three no-id spellings, and no real id', () => {
		const match = source.match(/^const is_unresolved_id = (\(id\) =>[^\n]+)$/m);
		expect(
			match,
			'is_unresolved_id is gone or reshaped — the three client doors have nothing left to share',
		).not.toBeNull();
		const predicate = new Function(`return ${match?.[1] as string}`)() as (id: unknown) => boolean;

		// The three spellings the SERVER predicate refuses (unnamedRemoveRefusal).
		for (const spelling of [null, undefined, '']) {
			expect(predicate(spelling), `id ${JSON.stringify(spelling)} must be unresolved`).toBe(true);
		}
		// ...and the ids that are REAL and deletable. `0` is the one a falsiness test
		// would eat, which is why this is a value test.
		for (const real of [0, '0', 1, '1', 42, 'abc']) {
			expect(predicate(real), `id ${JSON.stringify(real)} is a REAL id and must pass`).toBe(false);
		}
	});

	test('every client door uses the shared predicate — none re-inlines a narrower test', () => {
		// The wire door and the pre-flight must both call it. An inline
		// `el.id===null || typeof el.id==='undefined'` is precisely the shape that
		// drifted, so its reappearance anywhere in this file is the failure.
		const uses = source.match(/is_unresolved_id\(/g) ?? [];
		expect(
			uses.length,
			'fewer than two call sites: save() (the wire door) and change_value (the pre-flight) must both use it',
		).toBeGreaterThanOrEqual(2);
		const inlined =
			source.match(/action===.remove.\s*&&\s*\(\s*[\w.]+===null\s*\|\|\s*typeof/g) ?? [];
		expect(
			inlined,
			"a door re-inlined the null/undefined test instead of calling is_unresolved_id — that is the exact drift that let id:'' through every client door",
		).toEqual([]);
	});

	test('change_value PRE-FLIGHTS the whole array before applying any of it', () => {
		// HONEST LIMIT, stated rather than implied: this leg reads SOURCE ORDER. The
		// function is async and closes over the instance, so slicing and executing it
		// the way block G executes update_data_value is not available here.
		//
		// What it guards is real. `update_data_value` could not fail before
		// 2026-08-30 — it always answered true — so change_value applied each item as
		// it went. Now that an unresolved remove is refused, an aborting loop would
		// leave items 0..i-1 already spliced into self.data.entries with save() never
		// reached: local model mutated, nothing persisted, and the alert telling the
		// curator "nothing was deleted" while the screen shows otherwise until the
		// next refresh. Reachable through any multi-item remove — component_portal's
		// unlink_record maps N locators to N removes.
		const start = source.indexOf('component_common.prototype.change_value');
		expect(start, 'change_value is gone or renamed — repoint this leg').toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf('}//end change_value', start));
		const preflight = body.indexOf('is_unresolved_id(');
		const applies = body.indexOf('self.update_data_value(changed_data_item)');
		expect(preflight, 'change_value no longer pre-flights the array').toBeGreaterThan(-1);
		expect(applies, 'change_value no longer applies the items').toBeGreaterThan(-1);
		expect(
			preflight < applies,
			'change_value applies items BEFORE checking them: a refused item mid-array leaves the earlier ones ' +
				'already mutated in the local model with nothing saved',
		).toBe(true);
	});
});

describe('G. the client model door refuses an id-less remove (the shipped function, executed)', () => {
	const updateDataValue = loadUpdateDataValue();

	test('a remove with a null id is refused, the entries survive, and the curator is TOLD', () => {
		alerts.length = 0;
		const self = instance([
			{ id: 1, value: 'a' },
			{ id: 2, value: 'b' },
		]);
		const accepted = updateDataValue.call(self, { action: 'remove', id: null, value: null });
		expect(accepted).toBe(false); // change_value stops on a falsy answer, before save()
		expect(self.data.entries.length).toBe(2);
		// A silent false would leave them believing the row is gone.
		expect(alerts.length).toBe(1);
		expect(alerts[0]).toContain('nothing was deleted');
	});

	test('an OMITTED id is the same refusal (the shape JSON.stringify produces)', () => {
		alerts.length = 0;
		const self = instance([{ id: 1, value: 'a' }]);
		expect(updateDataValue.call(self, { action: 'remove', value: null })).toBe(false);
		expect(self.data.entries.length).toBe(1);
		expect(alerts.length).toBe(1);
	});

	test('a null id WITH a key is refused too — a key is a position, not an item', () => {
		alerts.length = 0;
		const self = instance([
			{ id: 1, value: 'a' },
			{ id: 2, value: 'b' },
		]);
		expect(updateDataValue.call(self, { action: 'remove', id: null, key: 0, value: null })).toBe(
			false,
		);
		expect(self.data.entries.length).toBe(2);
	});

	test('ANTI-VACUITY: id 0 is a target like any other, and a named id removes exactly it', () => {
		alerts.length = 0;
		// 0-safety: the `item.id || null` idiom collapses 0, so the guard must key on
		// null/undefined ONLY. A guard that refused 0 would make item 0 undeletable.
		const zero = instance([
			{ id: 0, value: 'zero' },
			{ id: 1, value: 'one' },
		]);
		expect(updateDataValue.call(zero, { action: 'remove', id: 0, value: null })).toBe(true);
		expect(zero.data.entries).toEqual([{ id: 1, value: 'one' }]);

		const named = instance([
			{ id: 1, value: 'a' },
			{ id: 2, value: 'b' },
		]);
		expect(updateDataValue.call(named, { action: 'remove', id: 2, value: null })).toBe(true);
		expect(named.data.entries).toEqual([{ id: 1, value: 'a' }]);
		expect(alerts.length).toBe(0); // no alert on any legitimate path
	});

	test('`clear` is the deliberate wildcard, and it still wipes', () => {
		alerts.length = 0;
		const self = instance([
			{ id: 1, value: 'a' },
			{ id: 2, value: 'b' },
		]);
		expect(updateDataValue.call(self, { action: 'clear', value: null })).toBe(true);
		expect(self.data.entries).toEqual([]);
		expect(alerts.length).toBe(0);
	});

	test('an unknown id is a local no-op, NOT a wipe — the server owns the whole array', () => {
		// entries can be a paginated slice, so refusing locally would reject valid
		// deletes. The one thing it must never do is fall through to a clear-all.
		const self = instance([{ id: 1, value: 'a' }]);
		expect(updateDataValue.call(self, { action: 'remove', id: 99, value: null })).toBe(true);
		expect(self.data.entries).toEqual([{ id: 1, value: 'a' }]);
	});

	test('DOOR AGREEMENT: the client refuses EXACTLY the shapes the server refuses', () => {
		// Two predicates, one law. A shape the client lets through but the server
		// refuses does not become safe — it becomes INVISIBLE: the delete leaves the
		// browser, dies at the wire as a failed save, and the curator sees a generic
		// failure instead of "the item to remove could not be identified", which is
		// the whole point of guarding in the browser. The reverse — the client
		// refusing what the server would have written — is an outage.
		const OMITTED = Symbol('no id key at all');
		const shapes: { label: string; id: unknown }[] = [
			{ label: 'id: null', id: null },
			{ label: 'id: undefined', id: undefined },
			{ label: "id: '' (an empty form field, and the `|| null` idiom)", id: '' },
			{ label: 'the id key omitted (what JSON.stringify drops)', id: OMITTED },
			{ label: 'id: 0 — a real id, LEGITIMATE', id: 0 },
			{ label: 'id: 7 — LEGITIMATE', id: 7 },
			{ label: "id: '7' — LEGITIMATE (a form value arrives as a string)", id: '7' },
		];

		const disagreements: string[] = [];
		for (const shape of shapes) {
			const change: Record<string, unknown> = { action: 'remove', value: null };
			if (shape.id !== OMITTED) change.id = shape.id;

			const serverRefuses = unnamedRemoveRefusal([change as never]) !== null;
			alerts.length = 0;
			// entries hold none of the ids above, so a shape the client ACCEPTS is
			// the local no-op — the answer isolates the guard, not the lookup.
			const self = instance([{ id: 1, value: 'a' }]);
			const clientRefuses = updateDataValue.call(self, change) === false;

			if (clientRefuses !== serverRefuses) {
				disagreements.push(
					`${shape.label}: client ${clientRefuses ? 'refuses' : 'accepts'}, server ${serverRefuses ? 'refuses' : 'accepts'}`,
				);
			}
			// And a refusal is never silent: the curator clicked delete.
			if (clientRefuses) expect(alerts.length).toBe(1);
		}

		expect({
			disagreements,
			hint:
				'One law, two doors: unnamedRemoveRefusal (src/core/section/record/save_component.ts) and the ' +
				"`action==='remove' && changed_id===null` guard in component_common.js update_data_value, whose " +
				"`changed_id` normalises null, undefined and '' to null. If they part, WIDEN THE CLIENT (0-safely: " +
				"0 and '0' are real ids) — never narrow the server.",
		}).toEqual({ disagreements: [], hint: expect.any(String) });
	});

	test('…except in SEARCH mode, where there is no wire and no row to lose', () => {
		// The ONE deliberate divergence, and it is the legitimate-gesture half of the
		// standard: a search instance's `data` is a transient FILTER model with no
		// save path (the shared handlers call update_data_value INSTEAD of
		// change_value when self.mode==='search'), and its entries carry no id at
		// all, so clearing the filter can only ever be spelled as an id-less remove.
		// Refusing it would leave the cleared filter standing in the model and run
		// the search with it — wrong results, not a wasted click.
		alerts.length = 0;
		const search = instance([{ value: 'a' }, { value: 'b' }], 'search');
		expect(updateDataValue.call(search, { action: 'remove', id: null, value: null })).toBe(true);
		expect(search.data.entries).toEqual([]);
		expect(alerts.length).toBe(0); // no alert: nothing was lost

		// The carve-out cannot reopen the defect: it is local, and the server door
		// refuses that same shape in EVERY mode (tests A and B).
		expect(unnamedRemoveRefusal([{ action: 'remove', id: null, value: null }])).not.toBeNull();
	});
});

/**
 * H — THE DOOR CENSUS (enumerated), and why enumerating FOUR doors is total.
 *
 * A remove reaches stored data through exactly one of these. The enumeration is
 * safe because the server half is a STRUCTURAL chokepoint, not a convention:
 * `applySaveComponentData` — the function that actually applies a change set —
 * is module-private, so every one of the ~25 server callers (import executors,
 * the tools' server trees, auth, the maintenance widgets) can only reach it
 * through `saveComponentData`, which runs the predicate as a pre-flight. That
 * is asserted below, because the day it is exported the enumeration silently
 * stops being total.
 */
const DOORS: Record<string, { proof: string; reason: string }> = {
	'src/core/section/record/save_component.ts': {
		proof: 'tests A, B, C, D — behavioural, through the real save door',
		reason:
			'THE CHOKEPOINT. saveComponentData refuses an id-less remove before withTransaction opens (the answer depends only on the incoming changes, so there is nothing to roll back). A THROW, not ok:false, because dd_core_api wraps ok:false in record.save_failed (internal/500, operator disclosure) and the reason would never reach the curator whose delete button did nothing. ONE model is routed AHEAD of it: component_relation_children owns no items (its entries are computed, they carry no id), so its save goes to the write-through (relations/children_write.ts), which accepts a remove only BY LOCATOR and refuses one naming no record (request.invalid_data, never a wipe — relation_children_write_through_native).',
	},
	'src/ai/mcp/tools/records_write.ts': {
		proof: 'tests E, E2 — behavioural, with a principal holding no grants',
		reason:
			'THE AGENT DOOR, and the one where the defect was CONFIRMED empirically: item_id is optional in the schema (zod validates one field at a time), and an omitted item_id mapped straight onto id:null — so an agent asked to "remove the English title" wiped every other language and was told ok:true. The conditional requirement lives in the handler, ahead of the permission probe. ONE model is let past it, by the engine\'s own test (the data tipo\'s model, after the alias hop): component_relation_children, whose child is removed BY LOCATOR in value (user decision 2026-09-27, plan item 2) and which the engine routes to the write-through ahead of its sentinel; every other model is still refused here (relation_children_write_through_native: the MCP remove-by-locator unlinks exactly that child with its TM row; the same shape on input_text / relation_parent refuses at the door, before permissions).',
	},
	'client/dedalo/core/component_common/js/component_common.js': {
		proof: 'the G block — the shipped update_data_value, executed',
		reason:
			'THE CLIENT MODEL DOOR. It held the same wildcard locally (remove + null id + null value = wipe self.data.entries), so the browser agreed with the server about the destruction and the UI showed it as done. Refusing here also means the curator is TOLD, which a server 400 alone does not guarantee.',
	},
	'src/core/section/record/temporal.ts': {
		proof: 'test F — behavioural, through resolveTemporalSave',
		reason:
			'THE TEMPORAL PEER (WC-059). It applies the delta in memory and echoes it; an in-memory instance must not answer where the persisted one refuses, or the echo reports a wipe as completed and a durable instance then stores the wiped set.',
	},
};

describe('H. the door census — every door that can carry a remove', () => {
	test('each enumerated door exists and its reason is recorded', () => {
		for (const [path, row] of Object.entries(DOORS)) {
			expect(statSync(join(ROOT, path)).isFile()).toBe(true);
			expect(row.reason.length).toBeGreaterThan(80);
			expect(row.proof.length).toBeGreaterThan(10);
		}
		expect(Object.keys(DOORS).length).toBe(4);
	});

	test('the applier is MODULE-PRIVATE, which is what makes four doors total', () => {
		// If applySaveComponentData is ever exported, a caller can apply a change
		// set without the pre-flight and the census above is no longer complete.
		const source = readFileSync(join(ROOT, 'src/core/section/record/save_component.ts'), 'utf8');
		expect(source).toContain('async function applySaveComponentData(');
		expect(source).not.toContain('export async function applySaveComponentData');
		// …and no module outside the engine imports it.
		const importers: string[] = [];
		for (const file of scanFiles(['src', 'tools'])) {
			if (file === 'src/core/section/record/save_component.ts') continue;
			const text = readFileSync(join(ROOT, file), 'utf8');
			// An IMPORT of the symbol, not a prose mention of it in a comment.
			if (/import[^;]*\bapplySaveComponentData\b/s.test(text)) importers.push(file);
		}
		expect(importers).toEqual([]);
	});

	test('the predicate is SHARED where it can be, and BACKED where it is re-stated', async () => {
		// Two copies of "what counts as no id" drift into two contracts, and the
		// looser one is the one that destroys a record. So each door is checked for
		// what it actually does — not for what would be tidy.
		for (const path of [
			'src/core/section/record/temporal.ts',
			'src/ai/mcp/tools/records_write.ts',
		]) {
			expect(readFileSync(join(ROOT, path), 'utf8')).toContain('DATA-06');
		}

		// THE TEMPORAL DOOR IMPORTS THE PREDICATE. Nothing to drift.
		expect(readFileSync(join(ROOT, 'src/core/section/record/temporal.ts'), 'utf8')).toContain(
			'unnamedRemoveRefusal',
		);

		// THE MCP DOOR RE-STATES IT INLINE, deliberately: the refusal has to happen
		// ahead of the permission probe, where the shared predicate's change-set
		// shape does not exist yet (the change set is built after the lang lookup).
		// A re-statement is only safe if it can be STRICTER but never looser, which
		// is what the next two assertions establish.
		const mcp = readFileSync(join(ROOT, 'src/ai/mcp/tools/records_write.ts'), 'utf8');
		// Asserted as the PROPERTY, not as one spelling of it: the door refuses a
		// remove that names no item, wherever that test physically lives. An earlier
		// version pinned the inline expression and went red the day the check was
		// extracted into a named helper for the complexity ratchet — a gate failing
		// on a refactor that changed no behaviour teaches people to edit the gate.
		expect(
			/action !== 'remove'|action === 'remove'/.test(mcp),
			'the MCP door no longer branches on a remove at all',
		).toBe(true);
		expect(mcp, 'the MCP door no longer refuses an id-less remove with the typed code').toContain(
			'record.remove_without_id',
		);
		// (1) BACKED: whatever it lets past still goes through the chokepoint, which
		// runs the real predicate — so the inline check can only refuse EARLIER.
		expect(mcp).toContain('await saveComponentData({');
		// (2) TOTAL FOR ITS OWN INPUT: the shared predicate also refuses '', which
		// this door does not name — and does not need to, because item_id is typed
		// z.number().optional(), so '' never reaches the handler. That is a SCHEMA
		// guarantee, so it is asserted against the schema, not assumed.
		const { RECORDS_WRITE_SPECS } = await import('../../src/ai/mcp/tools/records_write.ts');
		type Parser = { safeParse: (value: unknown) => { success: boolean } };
		const shape = RECORDS_WRITE_SPECS.find((one) => one.name === 'dedalo_save_component')
			?.inputShape as unknown as Record<string, Parser | undefined>;
		const itemId = shape.item_id;
		if (itemId === undefined) throw new Error('dedalo_save_component lost its item_id field');
		expect(itemId.safeParse('').success).toBe(false);
		expect(itemId.safeParse('7').success).toBe(false);
		expect(itemId.safeParse(7).success).toBe(true);
		expect(itemId.safeParse(undefined).success).toBe(true);
	});
});

/**
 * I — THE CALLER CENSUS: derived, and TOTAL over `client/`, `tools/`, `src/`.
 *
 * THE SCAN. Every object literal that carries an `action` and an `id` key is
 * matched; a site counts when the action CAN be a remove (the literal, a
 * ternary containing it, or a bare identifier passed in from the caller — the
 * `action : action` idiom the renderers use) AND the id expression can be null:
 *
 *   DIRECT          the id is built in place with `|| null` / `?? null` / null.
 *   INDIRECT-local  the id is a local const assigned such an expression.
 *   INDIRECT-param  the id is a parameter of the enclosing function — the
 *                   `_do_remove(id, key, …)` shape, whose caller supplies
 *                   `entries[key]?.id || null`.
 *   UNPROVEN        a bare identifier that resolves to neither: it cannot be
 *                   shown non-null in this file, so it must be classified.
 *
 * WHY THE SET IS PINNED RATHER THAN FORBIDDEN. Refusing the idiom outright is
 * not possible today — every one of these sites is a real widget whose id
 * genuinely IS unknown for an unsaved row. What the fix removes is the
 * DESTRUCTION, at the doors (H). What this census removes is the SILENCE: the
 * population may only shrink, so a new widget that reaches for the same idiom
 * fails this gate and its author has to decide, in this file, which it is.
 *
 * A row is NOT an excuse, it is a ledger entry. `clear-pending` and
 * `unresolved-id` rows are live residuals of DATA-06.
 */
type Verdict =
	| 'guarded-door'
	| 'clear-pending'
	| 'unresolved-id'
	| 'search-local'
	| 'locator-named'
	| 'suite-fixture';

interface CensusRow {
	sites: number;
	verdict: Verdict;
	reason: string;
}

/**
 * VERDICTS
 *
 *   guarded-door   the site is itself a door from H; the refusal runs before
 *                  this construction is ever applied.
 *   clear-pending  a DELIBERATE clear-all button that borrows remove + null id
 *                  — the legitimate gesture the `clear` action exists for,
 *                  reached by the shape that also spells an accidental delete.
 *                  NO SITE HOLDS THIS VERDICT TODAY (all four were ported on
 *                  2026-08-30); the verdict stays defined because the next
 *                  reset button written the old way lands on it.
 *   unresolved-id  an ACCIDENTAL single-row delete: the id is null whenever the
 *                  row is unsaved or absent from the loaded (possibly
 *                  paginated) entries. This is the shape that destroyed
 *                  records. Refused at the doors now; the site should resolve
 *                  a real id. SHRINK-ONLY.
 *   search-local   a SEARCH-mode builder. It calls update_data_value only and
 *                  never reaches the wire, so it never destroyed stored data.
 *                  The model door CARVES THESE OUT by the instance's own
 *                  `mode`: a search instance is a transient filter with no save
 *                  path, and emptying it is not a delete. So clearing one of
 *                  these fields works exactly as it always did.
 *                  (For a few hours on 2026-08-30 it did NOT: the first version
 *                  of the guard refused these too, which stopped five search
 *                  widgets from clearing a filter and — worse — let the search
 *                  then run WITH the filter the curator had just cleared. The
 *                  carve-out is that repair. Recorded because a guard that
 *                  breaks a daily gesture is how a data-loss fix gets reverted
 *                  wholesale.)
 *                  Migrating them to `clear` is tidiness, not a fix. SHRINK-ONLY.
 *   locator-named  a model whose entries carry NO item id (`removes_by_locator`:
 *                  component_relation_children, computed entries) names the
 *                  record to remove by the LOCATOR in `value`, with `id:null`.
 *                  Not the wildcard: the client doors accept it only with a full
 *                  locator on such a model (component_common
 *                  names_record_locator), and the server write-through refuses a
 *                  remove naming no record (request.invalid_data —
 *                  relation_children_write_through_native).
 *   suite-fixture  a client-suite fixture, derived by path (see below).
 */
const CENSUS: Record<string, CensusRow> = {
	// --- guarded-door -----------------------------------------------------
	'src/ai/mcp/tools/records_write.ts': {
		sites: 1,
		verdict: 'guarded-door',
		reason:
			'`id: input.item_id ?? null` is the construction the agent door still uses for update/insert; the remove case is refused above it, before the permission probe (test E) — except on a component_relation_children field, where the null id is the shape the write-through expects (removal BY LOCATOR in value; an id-less remove naming no record refuses there, request.invalid_data).',
	},

	// --- clear-pending: EMPTY on 2026-08-30. Every deliberate wipe was ported
	// to {action:'clear'}: the check_box and filter "All" reset buttons, the
	// portal search clear, and component_select's replace-clear. A row landing
	// here again means a wipe went back to borrowing a null id.
	'client/dedalo/core/component_select/js/component_select.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason:
			'build_changed_data_item(select, id=null): picking the EMPTY option builds a remove carrying the caller-supplied id, which defaults to null when the component had no prior value. The deliberate single-value replace-clear that shared this file was ported to {action:"clear"} on 2026-08-30, which is why this row dropped from 2 sites to 1.',
	},

	// --- unresolved-id (the accidental single-row deletes) -----------------
	'client/dedalo/core/component_check_box/js/component_check_box.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason: 'uncheck ONE box: `locator?.id || null` — null when the locator is not in entries.',
	},
	'client/dedalo/core/component_publication/js/component_publication.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason: 'alt-click remove: `entries[index]?.id || null`.',
	},
	'client/dedalo/core/component_filter/js/component_filter.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason: 'remove one filter locator: `locator?.id || null`.',
	},
	'client/dedalo/core/component_filter_records/js/component_filter_records.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason:
			'UNPROVEN id: entry_id stays null when the tipo is absent from the entries handed in. Clearing ONE section’s filter dropped that user’s filters for ALL sections — which WIDENS what the account can read, so this one is a read-scope defect as well as data loss.',
	},
	'client/dedalo/core/component_number/js/render_edit_component_number.js': {
		sites: 2,
		verdict: 'unresolved-id',
		reason:
			'the renderer writes `id: item.id || null` and _do_remove takes that id as a parameter — the two halves of one unsaved-row delete.',
	},
	'client/dedalo/core/component_email/js/render_edit_component_email.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason: '_do_remove(id, key): its docblock says the id is "null for unsaved rows".',
	},
	'client/dedalo/core/component_input_text/js/render_edit_component_input_text.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason: '_do_remove(id, key): its docblock says the id is "null for unsaved entries".',
	},
	'client/dedalo/core/component_date/js/render_edit_component_date.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason:
			'build_date_changed_data_item(data_value, id) — the ONE remove builder (the remove button and an emptied input both call it); it returns null for an id-less slot, which this lexical scan cannot see.',
	},
	'client/dedalo/core/component_password/js/component_password.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason: 'change handler: a null parsed value becomes a remove, with a caller-supplied id.',
	},
	'client/dedalo/core/component_radio_button/js/component_radio_button.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason: 'change handler: a null parsed value becomes a remove, with a caller-supplied id.',
	},
	'client/dedalo/core/component_radio_button/js/render_edit_component_radio_button.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason:
			'the reset button reads `self.data.entries?.[0]?.id ?? null` — deliberate in intent, but it addresses ONE row, so it is the unresolved shape, not a clear.',
	},
	'client/dedalo/core/component_portal/js/component_portal.js': {
		sites: 1,
		verdict: 'unresolved-id',
		reason: 'unlink one locator with an entry_id resolved from the loaded (paginated) page.',
	},

	// --- locator-named (no item ids exist; the locator IS the name) --------
	'client/dedalo/core/component_relation_children/js/component_relation_children.js': {
		sites: 1,
		verdict: 'locator-named',
		reason:
			'get_unlink_changed_data: `{action:"remove", id:null, value:{section_tipo, section_id}}` — the computed children carry no item id, so the child record is named by its locator (user decision 2026-09-27); the server removes exactly that child (WC-2026-10-02-relation-children-write-through).',
	},

	// --- search-local (never reaches the wire; carved out by mode) ---------
	'client/dedalo/core/component_email/js/render_search_component_email.js': {
		sites: 1,
		verdict: 'search-local',
		reason: 'clearing the search field builds remove + null id + key i.',
	},
	'client/dedalo/core/component_input_text/js/render_search_component_input_text.js': {
		sites: 1,
		verdict: 'search-local',
		reason: 'clearing the search field builds remove + null id + key i.',
	},
	'client/dedalo/core/component_iri/js/render_search_component_iri.js': {
		sites: 1,
		verdict: 'search-local',
		reason: 'clearing the search field builds remove + null id + key i.',
	},
	'client/dedalo/core/component_section_id/js/render_search_component_section_id.js': {
		sites: 1,
		verdict: 'search-local',
		reason: 'clearing the search field builds remove + null id + key i.',
	},
};

/**
 * The client suite's own fixtures, DERIVED by path rather than enumerated: they
 * drive component code against fixture records, never a curated one, so no row
 * of theirs can destroy production data. The total is pinned so a change is
 * still visible — it moved 11 -> 13 on 2026-08-30 when
 * test_component_common_changed_data.js was rewritten to FENCE the id-less
 * remove (a refusal case, a key case and the search carve-out) instead of
 * asserting the wipe it used to bless; 13 -> 14 on 2026-10-02 when
 * test_component_relation_children.js pinned the by-locator unlink shape.
 */
const FIXTURE_TREE = 'client/dedalo/test/';
const FIXTURE_SITES = 14;

/** Walk the three trees; the same file set the scan below reports on. */
function scanFiles(trees: readonly string[]): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (/\.(js|ts)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(relative(ROOT, full));
		}
	};
	for (const tree of trees) walk(join(ROOT, tree));
	return out.sort();
}

/** An object literal carrying an `action` and, within two keys, an `id`. */
const ITEM_LITERAL =
	/action\s*:\s*([^,\n]+),\s*(?:\/\/[^\n]*\n\s*)?(?:[a-z_]+\s*:\s*[^,\n]+,\s*){0,2}?id\s*:\s*([^,\n]+)/g;
const NULLABLE = /\|\|\s*null|\?\?\s*null|:\s*null|^null$|^undefined$/;

function scanNullableRemoveSites(): Map<string, number> {
	const found = new Map<string, number>();
	for (const file of scanFiles(['client', 'tools', 'src'])) {
		const source = readFileSync(join(ROOT, file), 'utf8');
		for (const match of source.matchAll(ITEM_LITERAL)) {
			const action = (match[1] ?? '').trim();
			const id = (match[2] ?? '').trim();
			// A remove is possible when the action names it, or when it is a bare
			// identifier the CALLER supplies (the `action : action` renderer idiom).
			if (!(/remove/.test(action) || /^[A-Za-z_$][\w$.?]*$/.test(action))) continue;
			let nullable = NULLABLE.test(id);
			if (!nullable && /^[A-Za-z_$][\w$]*$/.test(id)) {
				const assignment = new RegExp(`(?:const|let|var)\\s+${id}\\s*=([^\\n]*)`).exec(source);
				// INDIRECT-local, INDIRECT-param and UNPROVEN alike: a bare identifier
				// cannot be shown non-null here, so the site is classified, not assumed.
				nullable = assignment ? NULLABLE.test(assignment[1] ?? '') : true;
				if (!nullable) nullable = new RegExp(`\\([^)]*\\b${id}\\b[^)]*\\)`).test(source);
			}
			if (nullable) found.set(file, (found.get(file) ?? 0) + 1);
		}
	}
	return found;
}

describe('I. the caller census — derived, total over client/, tools/, src/', () => {
	const found = scanNullableRemoveSites();

	test('every site that can build a remove with a nullable id is CLASSIFIED', () => {
		const unclassified: string[] = [];
		for (const file of found.keys()) {
			if (file.startsWith(FIXTURE_TREE)) continue;
			if (CENSUS[file] === undefined) unclassified.push(file);
		}
		// A new widget reaching for `id: x?.id || null` on a remove lands here.
		expect({
			unclassified,
			hint:
				'A remove must NAME the item it removes. Resolve a real id, or — if the gesture is "empty this component" — send {action:"clear"}. ' +
				'If neither applies, add a row to CENSUS in this file with a verdict and a reason.',
		}).toEqual({ unclassified: [], hint: expect.any(String) });
	});

	test('the census is SHRINK-ONLY: no row may grow, and none may go stale', () => {
		const grown: string[] = [];
		const stale: string[] = [];
		for (const [file, row] of Object.entries(CENSUS)) {
			const actual = found.get(file) ?? 0;
			if (actual > row.sites) grown.push(`${file}: ${row.sites} -> ${actual}`);
			// A row whose sites dropped is a FIX: lower the number (or delete the row)
			// so the ledger records it. Silence would let the count drift back up.
			if (actual < row.sites) stale.push(`${file}: declared ${row.sites}, found ${actual}`);
		}
		expect({ grown, stale }).toEqual({ grown: [], stale: [] });
	});

	test('every row carries a real reason, and the residuals are named as residuals', () => {
		for (const [file, row] of Object.entries(CENSUS)) {
			expect(statSync(join(ROOT, file)).isFile()).toBe(true);
			expect(row.reason.length).toBeGreaterThan(40);
			expect(row.sites).toBeGreaterThan(0);
		}
		// The DATA-06 residuals. The deliberate wipes are DONE — all four now send
		// {action:'clear'} — so what is left is the accidental shape: single-row
		// deletes whose id is still unresolved. Refused at the doors today, and
		// meant to reach zero as each site learns to name its item.
		const residuals = Object.values(CENSUS).filter(
			(row) => row.verdict === 'clear-pending' || row.verdict === 'unresolved-id',
		);
		expect(residuals.length).toBe(13);
	});

	test('the client-suite fixture tree is derived by path, and its total is pinned', () => {
		let sites = 0;
		for (const [file, count] of found) if (file.startsWith(FIXTURE_TREE)) sites += count;
		expect(sites).toBe(FIXTURE_SITES);
	});

	test('the client fixture drives the SHIPPED function, and fences the accidental route', () => {
		// It used to hold a hand-copied mock of update_data_value and assert that
		// {action:'remove', id:null} cleared every entry — the defect, pinned as the
		// expected behaviour, in the suite that is supposed to catch it. Rewritten
		// 2026-08-30: it imports component_common and calls the shipped prototype
		// method, so the copy that could not drift out of date is gone.
		//
		// Asserted here because `bun test` runs no browser: nothing else in the
		// default gate notices if the fixture regresses to a private mock.
		const fixture = readFileSync(
			join(ROOT, FIXTURE_TREE, 'client/js/test_component_common_changed_data.js'),
			'utf8',
		);
		expect(fixture).toContain(
			"import {component_common} from '../../../core/component_common/js/component_common.js'",
		);
		expect(fixture).toContain('component_common.prototype.update_data_value');
		// No second implementation: a mock is what let the defect live here.
		expect(fixture).not.toContain('update_data_value: function');
		// Both halves of the contract are exercised: the refusal and the `clear`.
		expect(fixture).toContain('REFUSE a remove with a null id');
		expect(fixture).toContain("action: 'clear'");
	});
});
