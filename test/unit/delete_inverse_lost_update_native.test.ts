/**
 * DATA-02 gate — a record DELETE must not silently destroy a locator another
 * curator committed on the record it rewrites.
 *
 * THE FAILURE CLASS. `removeAllInverseReferences` (delete step 3) is a
 * read-modify-write of ANOTHER record's component key: it reads the OWNING
 * record's relation bag, filters the deleted record's locators out in JS, and
 * writes the WHOLE key back. The delete's transaction locks only the record
 * being DELETED. With an UNLOCKED read of the owner, everything a curator
 * commits on that key between the delete's read and the delete's write is
 * overwritten out of existence — the curator's save answered `ok:true`, no
 * error, no counter, no detection, and the delete's own Time Machine row then
 * canonizes the stale bag as if it were the truth. For a heritage collection
 * that is a silent, un-notified loss of curatorial work.
 *
 * WHY THIS SHAPE OF GATE. Nothing single-threaded can see it: the defect only
 * exists BETWEEN two connections. The three standing concurrency gates model
 * other things entirely — `concurrency_interleave.test.ts` is request-scoped
 * ALS isolation (no row locks at all), and the write-path gates drive one
 * connection. So this one drives TWO, and lets POSTGRES be the clock rather
 * than a sleep:
 *
 *   T2 (the curator) opens a transaction, saves an ordinary new locator onto
 *   the owner's portal through `saveComponentData` — which takes the owner's
 *   `FOR UPDATE` row lock — and is HELD OPEN.
 *   T1 (the admin) then deletes the target record. Whatever it does to the
 *   owner row, locked read or unlocked read + later UPDATE, it must WAIT on
 *   T2's lock, and the gate polls `pg_blocking_pids` until it provably does.
 *   Only then is T2 released to commit, so the curator's locator lands
 *   strictly INSIDE the delete's read→write window — the exact interleave the
 *   audit reproduced, forced rather than hoped for.
 *
 * With the unlocked read, T1's stale bag (which never contained the curator's
 * locator) is written over the committed one and the whole key disappears.
 * With the locked read, T1 queues behind T2 and reads what T2 committed, so
 * the curator's locator survives and only the deleted record's locator goes.
 *
 * The gate therefore reproduces the ORIGINAL RACE — it is not a post-fix
 * invariant restated. Its anti-vacuity floor is explicit: the situation's
 * structure is asserted (section → `matrix_test`, portal → `relation`
 * column), the seeded corpus is asserted non-empty AND discoverable by the
 * very breakdown search the delete uses, and the blocked-on-T2 wait must
 * genuinely have happened — a run where the interleave did not occur is RED,
 * never quietly green.
 *
 * Everything is built through the engine's own write path on a reserved
 * scratch TLD (`zzdlu`) and torn down; nothing here reads whatever the
 * database happens to hold.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	lockMatrixRowsForKeyShare,
	readMatrixKeyForUpdate,
} from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../../src/core/ontology/resolver.ts';
import { findInverseReferenceLocators } from '../../src/core/search/search_related.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	persistAppendedKeyItems,
	persistObserverResaveKeys,
	persistRecordKeys,
	persistRestoredKeys,
	type RecordWriteTarget,
} from '../../src/core/section_record/index.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import {
	boundedRun,
	currentBackendPid,
	type Settled,
	settle,
	waitUntilBlockedBy as waitUntilBlockedByN,
} from '../helpers/lock_wait.ts';
import {
	REPO_ROOT,
	WRITE_PATH_CORPUS_FLOOR,
	writePathSourceFiles,
} from '../helpers/write_path_corpus.ts';

/** Scratch TLD unique to this gate — concurrent gates cannot collide with it. */
const SECTION = 'zzdlu1';
const PORTAL = 'zzdlu2';
/** A second portal on the same section (T1-19 R3: a NEW key onto an owner that already references the target). */
const PORTAL2 = 'zzdlu3';
/** T1-19 B (C28): a section born LINKED to the anchor through a `dato_default` portal. */
const DEFAULTED_SECTION = 'zzdlu4';
const DEFAULTED_PORTAL = 'zzdlu5';
/** The situation's anchor record — the dato_default target; deleted by the B3 case. */
const ANCHOR_ID = 900801;
const TABLE = 'matrix_test';
const USER_ID = -1; // root, as every other delete gate

/**
 * Section + one portal, nothing else. The portal declares NO
 * `source.request_config`, so the relation-insert validation has no target
 * constraint to apply — this gate is about the delete's write protocol, not
 * about the picker gates, which have their own.
 */
const SITUATION = situation({
	tld: 'zzdlu',
	name: 'delete_inverse_lost_update',
	nodes: [
		{
			tipo: SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Pérdida de actualización al borrar', 'lg-eng': 'Delete lost update' },
		},
		{
			tipo: PORTAL,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-spa': 'Relacionados', 'lg-eng': 'Related' },
		},
		{
			tipo: PORTAL2,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-spa': 'Otros relacionados', 'lg-eng': 'Other related' },
		},
		// T1-19 B (C28): a section whose portal is BORN pointing at the anchor
		// record — the create-with-values birth (record_defaults dato_default).
		{
			tipo: DEFAULTED_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Nacido enlazado', 'lg-eng': 'Born linked' },
		},
		{
			tipo: DEFAULTED_PORTAL,
			parent: DEFAULTED_SECTION,
			model: 'component_portal',
			term: { 'lg-spa': 'Enlace por defecto', 'lg-eng': 'Default link' },
			properties: { dato_default: { section_tipo: SECTION, section_id: ANCHOR_ID } },
		},
	],
	// Anchor record: dropSituation sweeps every row of every section the
	// situation declares, so the runtime-created records below go with it.
	records: [{ section_tipo: SECTION, section_id: ANCHOR_ID }],
});

/** The record the admin deletes. */
let targetId = 0;
/** The record the curator links to while the delete runs — the loss victim. */
let siblingId = 0;
/** The record whose portal bag holds BOTH locators — the rewritten owner. */
let ownerId = 0;

/** Did the delete provably WAIT on the curator's row lock? (anti-vacuity) */
let deleteBlockedOnCurator = false;
/** Did the curator's ordinary save answer ok? */
let curatorSaveOk = false;
/** The item id the curator's insert allocated. */
let curatorItemId = 0;
/** Anything the delete threw (a deadlock would surface here, not as a hang). */
let deleteError: unknown = null;
/** The owner's portal bag as stored AFTER both transactions committed. */
let finalBag: Record<string, unknown>[] | null = null;
/** The data of the TM row the delete wrote for the owner's portal. */
let deleteTmData: unknown = null;

/** The owner's stored portal bag, read raw. */
async function readOwnerBag(): Promise<Record<string, unknown>[] | null> {
	const rows = (await sql.unsafe(
		`SELECT relation->$1 AS items FROM "${TABLE}" WHERE section_tipo = $2 AND section_id = $3`,
		[PORTAL, SECTION, ownerId],
	)) as { items: unknown }[];
	const items = rows[0]?.items;
	return Array.isArray(items) ? (items as Record<string, unknown>[]) : null;
}

/**
 * Poll until some backend is waiting on a lock HELD BY `pid`. Identity, not a
 * sleep: `pg_blocking_pids` names the blocker, so a concurrently running gate
 * on the same suite database can neither satisfy nor disturb this wait.
 */
async function waitUntilBlockedBy(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM pg_stat_activity
			 WHERE wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))`,
			[String(pid)],
		)) as { n: number }[];
		if ((rows[0]?.n ?? 0) > 0) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

beforeAll(async () => {
	await ensureSituation(SITUATION);

	// --- structure floor: the situation resolved to what this gate asserts on.
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	const portalModel = await getModelByTipo(PORTAL);
	expect(portalModel).toBe('component_portal');
	expect(getColumnNameByModel(portalModel as string)).toBe('relation');

	targetId = await createSectionRecord(SECTION, USER_ID);
	siblingId = await createSectionRecord(SECTION, USER_ID);
	ownerId = await createSectionRecord(SECTION, USER_ID);
	expect(targetId).toBeGreaterThan(0);
	expect(siblingId).toBeGreaterThan(0);
	expect(ownerId).toBeGreaterThan(0);

	// The pre-existing reference, written through the engine's own save door.
	const seeded = await saveComponentData({
		componentTipo: PORTAL,
		sectionTipo: SECTION,
		sectionId: ownerId,
		lang: 'lg-nolan',
		changedData: [
			{ action: 'insert', value: { section_tipo: SECTION, section_id: String(targetId) } },
		],
		userId: USER_ID,
	});
	expect(seeded.ok).toBe(true);

	// --- corpus floor: the bag is non-empty AND the delete's own discovery
	// half can see it. A moved index or a shrunken fixture reddens HERE
	// instead of making the survival assertion below trivially true.
	const seededBag = await readOwnerBag();
	expect(seededBag?.length).toBe(1);
	const hits = await findInverseReferenceLocators([
		{ section_tipo: SECTION, section_id: targetId },
	]);
	expect(hits.length).toBeGreaterThan(0);

	// ---------------- THE INTERLEAVE ----------------
	let releaseCurator: () => void = () => {};
	const curatorHold = new Promise<void>((resolve) => {
		releaseCurator = resolve;
	});
	let curatorCommitted: () => void = () => {};
	const curatorWrote = new Promise<void>((resolve) => {
		curatorCommitted = resolve;
	});
	let curatorPid = 0;

	// T2 — an ORDINARY curator save on the owner's portal, held open on its own
	// connection so the delete meets a real, live row lock.
	const curator = withTransaction(async () => {
		const pidRows = (await sql.unsafe('SELECT pg_backend_pid() AS pid')) as { pid: number }[];
		curatorPid = Number(pidRows[0]?.pid ?? 0);
		const saved = await saveComponentData({
			componentTipo: PORTAL,
			sectionTipo: SECTION,
			sectionId: ownerId,
			lang: 'lg-nolan',
			changedData: [
				{ action: 'insert', value: { section_tipo: SECTION, section_id: String(siblingId) } },
			],
			userId: USER_ID,
		});
		curatorSaveOk = saved.ok;
		const items = (saved.data ?? []) as { id?: number; section_id?: number | string }[];
		curatorItemId = Number(items.find((item) => Number(item.section_id) === siblingId)?.id ?? 0);
		curatorCommitted();
		await curatorHold; // the write is done; the transaction is NOT
	});
	await curatorWrote;
	expect(curatorPid).toBeGreaterThan(0);

	// T1 — the admin's delete. It must reach the owner rewrite and WAIT there.
	const deletion = deleteSectionRecord(SECTION, targetId, USER_ID).catch((error: unknown) => {
		deleteError = error;
		return null;
	});
	deleteBlockedOnCurator = await waitUntilBlockedBy(curatorPid, 15_000);

	// Only now does the curator's locator become visible to anyone else — i.e.
	// strictly inside the delete's read→write window.
	releaseCurator();
	await curator;
	await deletion;

	finalBag = await readOwnerBag();
	const tmRows = (await sql.unsafe(
		`SELECT data FROM matrix_time_machine
		 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3
		 ORDER BY id DESC LIMIT 1`,
		[SECTION, ownerId, PORTAL],
	)) as { data: unknown }[];
	deleteTmData = tmRows[0]?.data ?? null;
}, 60000);

afterAll(async () => {
	expect(await dropSituation(SITUATION)).toBe(0);
});

describe('delete_record inverse rewrite vs a concurrent save (DATA-02)', () => {
	test('the interleave actually happened: the delete waited on the curator lock', () => {
		// Anti-vacuity. Without this, a delete that finished BEFORE the curator's
		// save became visible would satisfy every assertion below while proving
		// nothing at all about the window.
		expect(deleteError).toBeNull();
		expect(curatorSaveOk).toBe(true);
		expect(curatorItemId).toBeGreaterThan(0);
		expect(deleteBlockedOnCurator).toBe(true);
	});

	test("the curator's locator SURVIVES the delete's owner rewrite", () => {
		// THE DEFECT. Unlocked, the delete re-persists a bag read before the
		// curator's commit: the key is written back without the new locator (here,
		// emptied and removed outright), destroying committed curatorial work with
		// no error anywhere.
		expect(finalBag).not.toBeNull();
		const survivor = (finalBag ?? []).find((item) => Number(item.section_id) === siblingId);
		expect(survivor).toBeDefined();
		expect(survivor?.id).toBe(curatorItemId);
		expect(survivor?.from_component_tipo).toBe(PORTAL);
	});

	test("the deleted record's locator IS stripped, and the target row is gone", async () => {
		// The other half of non-vacuity: the delete must genuinely have rewritten
		// THIS owner. A gate where the rewrite never ran would "preserve" the
		// curator's locator for the wrong reason.
		expect((finalBag ?? []).some((item) => Number(item.section_id) === targetId)).toBe(false);
		const rows = (await sql.unsafe(
			`SELECT 1 FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, targetId],
		)) as unknown[];
		expect(rows.length).toBe(0);
	});

	test("the delete's Time Machine row canonizes the SURVIVING bag, not the stale one", () => {
		// The audit half of the finding: the TM row the delete writes for the
		// owner is the record's history. Written from a stale read it records a
		// bag that never existed, so even the history hides the loss.
		expect(Array.isArray(deleteTmData)).toBe(true);
		const tmItems = (deleteTmData ?? []) as Record<string, unknown>[];
		expect(tmItems.some((item) => Number(item.section_id) === siblingId)).toBe(true);
		expect(tmItems.some((item) => Number(item.section_id) === targetId)).toBe(false);
	});
});

// ===========================================================================
// T1-19 / D01 — a LINK to a record must not be left dangling by a concurrent
// DELETE of that record (WC-2026-11-12-locator-target-deleted-refused).
//
// THE RACE. The delete strips only the locators its ONE inverse search finds.
// Before the protocol, a save adding a locator to the record being deleted
// locked only its OWNER row, so it never met the delete: whichever order they
// ran in, the save answered ok:true and its locator outlived the target forever.
// THE PROTOCOL. The save takes FOR KEY SHARE on the target (before the owner,
// held to COMMIT); the delete's FOR UPDATE on the target conflicts. Save first →
// the delete waits and then strips the new locator; delete first → the save
// waits and is REFUSED (owner ruling 2026-11-11: refuse, never drop).
// Postgres is the clock (pg_blocking_pids), never a sleep; every wait is asserted.
// ===========================================================================

/** A plain portal locator, as the save door stores it. */
function locatorTo(sectionId: number | string, from = PORTAL): Record<string, unknown> {
	return { type: 'dd151', section_tipo: SECTION, section_id: sectionId, from_component_tipo: from };
}

/** An ordinary portal insert through the engine's save door. */
function insertLink(ownerSectionId: number, targetSectionId: number | string, portal = PORTAL) {
	return saveComponentData({
		componentTipo: portal,
		sectionTipo: SECTION,
		sectionId: ownerSectionId,
		lang: 'lg-nolan',
		changedData: [
			{ action: 'insert', value: { section_tipo: SECTION, section_id: String(targetSectionId) } },
		],
		userId: USER_ID,
	});
}

/** One portal key of a record, read raw (no lock). */
async function bagOf(sectionId: number, portal = PORTAL): Promise<Record<string, unknown>[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$1 AS items FROM "${TABLE}" WHERE section_tipo = $2 AND section_id = $3`,
		[portal, SECTION, sectionId],
	)) as { items: unknown }[];
	const items = rows[0]?.items;
	return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

/** Whether a bag points at `sectionId`. */
function references(bag: readonly Record<string, unknown>[], sectionId: number): boolean {
	return bag.some((item) => Number(item.section_id) === sectionId);
}

/** The error code of a rejected settle (null when it did not reject with a coded error). */
function codeOf(settled: Settled<unknown> | { status: 'timeout' }): string | null {
	if (settled.status !== 'rejected') return null;
	const reason = settled.reason as { code?: unknown };
	return typeof reason?.code === 'string' ? reason.code : null;
}

/**
 * Run `work` in a transaction on its own connection and HOLD it open after the
 * work settled, until release(): `ready` answers the backend pid + the work's
 * outcome; a rejected work rolls its transaction back.
 */
function holdTransaction<T>(work: () => Promise<T>): {
	ready: Promise<{ pid: number; outcome: Settled<T> }>;
	release: () => void;
	done: Promise<unknown>;
} {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let signal: (value: { pid: number; outcome: Settled<T> }) => void = () => {};
	const ready = new Promise<{ pid: number; outcome: Settled<T> }>((resolve) => {
		signal = resolve;
	});
	const done = settle(
		withTransaction(async () => {
			const pid = await currentBackendPid();
			const outcome = await settle(work());
			signal({ pid, outcome });
			if (outcome.status === 'rejected') throw outcome.reason;
			await gate;
		}),
	);
	return { ready, release: () => release(), done };
}

/** A fresh record of the gate's section. */
function newRecord(): Promise<number> {
	return createSectionRecord(SECTION, USER_ID);
}

/** The chokepoint target of a record of the gate's section. */
function ownerTarget(sectionId: number): RecordWriteTarget {
	return { table: TABLE, sectionTipo: SECTION, sectionId };
}

/**
 * A delete of `target` paused right after its FOR UPDATE on the target row
 * (the precondition hook): `entered` once the lock is held, `release()` lets it
 * strip the owners and COMMIT; `done` settles the delete.
 */
function deletionHeldAfterTargetLock(target: number): {
	entered: Promise<void>;
	release: () => void;
	done: Promise<Settled<unknown>>;
} {
	let entered: () => void = () => {};
	const inDelete = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const done = settle(
		deleteSectionRecord(SECTION, target, USER_ID, new Date(), {
			precondition: async () => {
				entered();
				await gate;
				return null;
			},
		}),
	);
	return { entered: inDelete, release: () => release(), done };
}

describe('T1-19 locator target vs a concurrent delete (D01)', () => {
	test('R1 delete first: the link save WAITS on the delete, then is REFUSED — nothing dangles', async () => {
		const target = await newRecord();
		const owner = await newRecord();
		const deletion = holdTransaction(() => deleteSectionRecord(SECTION, target, USER_ID));
		const { pid, outcome: deleted } = await deletion.ready;
		expect(deleted.status).toBe('fulfilled');
		const save = settle(insertLink(owner, target));
		// The save must meet the delete: blocked by ITS backend (identity, not timing).
		const blocked = await waitUntilBlockedByN(pid, 1, 5_000);
		deletion.release();
		await deletion.done;
		const saved = await save;
		expect(blocked).toBe(true);
		expect(codeOf(saved)).toBe('relation.target_deleted');
		expect(references(await bagOf(owner), target)).toBe(false);
		expect(
			await findInverseReferenceLocators([{ section_tipo: SECTION, section_id: target }]),
		).toEqual([]);
	}, 30_000);

	test('R2 save first: the delete WAITS for the save, then strips the new link', async () => {
		const target = await newRecord();
		const owner = await newRecord();
		const save = holdTransaction(() => insertLink(owner, target));
		const { pid, outcome: saved } = await save.ready;
		expect(saved.status === 'fulfilled' && saved.value.ok).toBe(true);
		const deletion = settle(deleteSectionRecord(SECTION, target, USER_ID));
		const blocked = await waitUntilBlockedByN(pid, 1, 5_000);
		save.release();
		await save.done;
		const deleted = await deletion;
		expect(blocked).toBe(true);
		expect(deleted.status === 'fulfilled' && deleted.value.removed).toBe(true);
		// Non-vacuity: the link DID land (the save committed) — and the delete took it out.
		expect(references(await bagOf(owner), target)).toBe(false);
		expect(
			await findInverseReferenceLocators([{ section_tipo: SECTION, section_id: target }]),
		).toEqual([]);
	}, 30_000);

	test('R3 lock order: an owner that already links the target waits on the TARGET, not holding itself — no deadlock', async () => {
		const target = await newRecord();
		const owner = await newRecord();
		const seeded = await insertLink(owner, target);
		expect(seeded.ok).toBe(true);
		let deleterPid = 0;
		let entered: () => void = () => {};
		const inDelete = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The precondition runs right after the delete's FOR UPDATE on the target.
		const deletion = settle(
			deleteSectionRecord(SECTION, target, USER_ID, new Date(), {
				precondition: async () => {
					deleterPid = await currentBackendPid();
					entered();
					await gate;
					return null;
				},
			}),
		);
		await inDelete;
		const save = settle(insertLink(owner, target, PORTAL2));
		const blocked = await waitUntilBlockedByN(deleterPid, 1, 5_000);
		// The waiting save must NOT hold the owner row: the delete still has to rewrite it.
		const ownerFree = await withTransaction(async () => {
			try {
				await sql.unsafe(
					`SELECT section_id FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2 FOR NO KEY UPDATE NOWAIT`,
					[SECTION, owner],
				);
				return true;
			} catch {
				return false;
			}
		});
		release();
		const deleted = await deletion;
		const saved = await save;
		expect(blocked).toBe(true);
		expect(ownerFree).toBe(true);
		expect(deleted.status).toBe('fulfilled'); // never the 40P01 victim
		expect(codeOf(saved)).toBe('relation.target_deleted');
		expect(references(await bagOf(owner), target)).toBe(false);
		expect(references(await bagOf(owner, PORTAL2), target)).toBe(false);
	}, 30_000);

	test('R5 KEPT target: removing ANOTHER item while the kept target is being deleted never waits on it (save door, no 40P01)', async () => {
		const target = await newRecord();
		const other = await newRecord();
		const owner = await newRecord();
		expect((await insertLink(owner, target)).ok).toBe(true);
		expect((await insertLink(owner, other)).ok).toBe(true);
		const otherItemId = (await bagOf(owner)).find((item) => Number(item.section_id) === other)?.id;
		expect(typeof otherItemId).toBe('number');
		const deletion = deletionHeldAfterTargetLock(target);
		await deletion.entered;
		// The curator removes `other` — the full-array write keeps ->target. It must
		// NOT KEY SHARE-lock the kept target after its owner lock: the held delete
		// owns target FOR UPDATE and still has to rewrite the owner.
		const removal = await boundedRun(
			saveComponentData({
				componentTipo: PORTAL,
				sectionTipo: SECTION,
				sectionId: owner,
				lang: 'lg-nolan',
				changedData: [{ action: 'remove', id: otherItemId as number, value: null }],
				userId: USER_ID,
			}),
			5_000,
		);
		deletion.release();
		const deleted = await deletion.done;
		expect(removal.status).toBe('fulfilled'); // completed while the delete held target
		expect(removal.status === 'fulfilled' && removal.value.ok).toBe(true);
		expect(deleted.status).toBe('fulfilled'); // never the 40P01 victim
		const bag = await bagOf(owner);
		expect(references(bag, other)).toBe(false); // the curator's removal landed
		expect(references(bag, target)).toBe(false); // the delete stripped the kept link
	}, 30_000);

	test('R6 KEPT target under an owner-held ambient tx (observer re-save shape) never waits on it', async () => {
		const target = await newRecord();
		const owner = await newRecord();
		expect((await insertLink(owner, target)).ok).toBe(true);
		const stored = await bagOf(owner);
		expect(references(stored, target)).toBe(true);
		const deletion = deletionHeldAfterTargetLock(target);
		await deletion.entered;
		// resaveObserverThroughSaveRules' shape: the host row locked first, then the
		// cascade-owned re-save of a value that ADDS nothing.
		const resave = await boundedRun(
			withTransaction(async () => {
				await readMatrixKeyForUpdate(TABLE, SECTION, owner, 'relation', PORTAL);
				await persistObserverResaveKeys(
					ownerTarget(owner),
					[{ column: 'relation', key: PORTAL, value: stored }],
					false,
					{ actor: USER_ID },
				);
			}),
			5_000,
		);
		deletion.release();
		const deleted = await deletion.done;
		expect(resave.status).toBe('fulfilled');
		expect(deleted.status).toBe('fulfilled');
		expect(references(await bagOf(owner), target)).toBe(false);
	}, 30_000);

	test('R4 the chokepoint itself refuses a link to a deleted record (key write AND atomic append)', async () => {
		const target = await newRecord();
		const owner = await newRecord();
		const removed = await deleteSectionRecord(SECTION, target, USER_ID);
		expect(removed.removed).toBe(true);
		const keyWrite = await settle(
			persistRecordKeys(
				ownerTarget(owner),
				[{ column: 'relation', key: PORTAL, value: [locatorTo(target)] }],
				false,
				{ actor: USER_ID },
			),
		);
		expect(codeOf(keyWrite)).toBe('relation.target_deleted');
		const append = await settle(
			persistAppendedKeyItems(ownerTarget(owner), 'relation', PORTAL, [locatorTo(target)], false, {
				actor: USER_ID,
			}),
		);
		expect(codeOf(append)).toBe('relation.target_deleted');
		expect(await bagOf(owner)).toEqual([]);
	}, 30_000);

	test('G1 lock-mode law: a save on a record another save is LINKING TO never waits (mutual links)', async () => {
		const first = await newRecord();
		const second = await newRecord();
		const held = holdTransaction(() => insertLink(first, second));
		const { outcome } = await held.ready;
		expect(outcome.status === 'fulfilled' && outcome.value.ok).toBe(true);
		// first→second is held open; second→first must complete meanwhile.
		const mutual = await boundedRun(insertLink(second, first), 5_000);
		held.release();
		await held.done;
		expect(mutual.status).toBe('fulfilled');
		expect(mutual.status === 'fulfilled' && mutual.value.ok).toBe(true);
		expect(references(await bagOf(first), second)).toBe(true);
		expect(references(await bagOf(second), first)).toBe(true);
	}, 30_000);

	test('G3 a KEPT link to a deleted record is never re-judged: the record stays editable', async () => {
		const gone = await newRecord();
		const live = await newRecord();
		const owner = await newRecord();
		expect((await deleteSectionRecord(SECTION, gone, USER_ID)).removed).toBe(true);
		// Pre-protocol residue, written through the exempt RESTORE entry.
		await persistRestoredKeys(
			ownerTarget(owner),
			[{ column: 'relation', key: PORTAL, value: [{ ...locatorTo(gone), id: 1 }] }],
			false,
			{ actor: USER_ID },
		);
		expect(references(await bagOf(owner), gone)).toBe(true);
		const saved = await insertLink(owner, live);
		expect(saved.ok).toBe(true);
		const bag = await bagOf(owner);
		expect(references(bag, gone)).toBe(true);
		expect(references(bag, live)).toBe(true);
	}, 30_000);

	test('G4 never-existed addresses and non-address ids are NOT judged (owner decision A open)', async () => {
		const owner = await newRecord();
		const forward = await insertLink(owner, 2_000_000_001);
		expect(forward.ok).toBe(true);
		const remote = await persistRecordKeys(
			ownerTarget(owner),
			[{ column: 'relation', key: PORTAL2, value: [locatorTo('001338683', PORTAL2)] }],
			false,
			{ actor: USER_ID },
		).then(
			() => 'ok',
			(error: unknown) => String((error as { code?: unknown }).code ?? error),
		);
		expect(remote).toBe('ok');
		// Verbatim: a remote id is never cast to an address.
		expect((await bagOf(owner, PORTAL2))[0]?.section_id).toBe('001338683');
	}, 30_000);

	test('K7 the KEY SHARE door refuses outside a transaction (no lock would outlive the statement)', async () => {
		const refused = await settle(
			lockMatrixRowsForKeyShare([{ table: TABLE, sectionTipo: SECTION, sectionId: 1 }]),
		);
		expect(codeOf(refused)).toBe('internal.invariant');
	});
});

// ===========================================================================
// T1-19 B / C28 (owner ruling 2026-11-13: a) — BIRTHS under the same law. The
// two INSERT doors that bypass the chokepoint (duplicate_record.ts, the
// create-with-values of create_record.ts) used to store a born row's locators
// UNJUDGED: a duplicate of a record carrying a locator to a record being deleted
// (or a legacy locator to a deleted one) was born dangling. Now every relation
// key of the born row is judged inside the insert's transaction
// (record_write.ts assertBirthLocatorTargetsLive): the targets' KEY SHARE waits
// on a running delete, and a deleted target REFUSES the birth — row and counter
// rolled back, nothing inserted.
// ===========================================================================

/** Live rows of a section (the "nothing inserted" witness). */
async function rowCount(sectionTipo: string): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${TABLE}" WHERE section_tipo = $1`,
		[sectionTipo],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

describe('T1-19 B / C28: births are judged under the locator-target law', () => {
	test('B1 duplicate: a source carrying a legacy locator to a DELETED record is refused — nothing inserted', async () => {
		const gone = await newRecord();
		const source = await newRecord();
		expect((await deleteSectionRecord(SECTION, gone, USER_ID)).removed).toBe(true);
		// Pre-protocol residue on the source (the exempt RESTORE entry writes it).
		await persistRestoredKeys(
			ownerTarget(source),
			[{ column: 'relation', key: PORTAL, value: [{ ...locatorTo(gone), id: 1 }] }],
			false,
			{ actor: USER_ID },
		);
		expect(references(await bagOf(source), gone)).toBe(true);
		const before = await rowCount(SECTION);
		const duplicated = await settle(duplicateSectionRecord(SECTION, source, USER_ID));
		expect(codeOf(duplicated)).toBe('relation.target_deleted');
		expect(await rowCount(SECTION)).toBe(before);
		// The source itself stays as it was (editable residue, G3).
		expect(references(await bagOf(source), gone)).toBe(true);
	}, 30_000);

	test('B2 duplicate vs a CONCURRENT delete of a linked record: the birth WAITS on the delete, then is refused', async () => {
		const target = await newRecord();
		const source = await newRecord();
		expect((await insertLink(source, target)).ok).toBe(true);
		let deleterPid = 0;
		let entered: () => void = () => {};
		const inDelete = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const deletion = settle(
			deleteSectionRecord(SECTION, target, USER_ID, new Date(), {
				precondition: async () => {
					deleterPid = await currentBackendPid();
					entered();
					await gate;
					return null;
				},
			}),
		);
		await inDelete;
		const before = await rowCount(SECTION);
		const duplicated = settle(duplicateSectionRecord(SECTION, source, USER_ID));
		// Identity, not timing: the birth's KEY SHARE must be blocked by the deleter.
		const blocked = await waitUntilBlockedByN(deleterPid, 1, 5_000);
		release();
		const deleted = await deletion;
		const outcome = await duplicated;
		expect(blocked).toBe(true);
		expect(deleted.status).toBe('fulfilled'); // never the 40P01 victim
		expect(codeOf(outcome)).toBe('relation.target_deleted');
		// The target is gone, the source's link stripped by the delete, no clone born.
		expect(await rowCount(SECTION)).toBe(before - 1);
		expect(references(await bagOf(source), target)).toBe(false);
		expect(
			await findInverseReferenceLocators([{ section_tipo: SECTION, section_id: target }]),
		).toEqual([]);
	}, 30_000);

	test('B3 create-with-values: a dato_default pointing at a DELETED record refuses the birth; it was born linked before', async () => {
		expect(await getMatrixTableFromTipo(DEFAULTED_SECTION)).toBe(TABLE);
		// Control (non-vacuity): the default DOES link a born record to the anchor.
		const linked = await createSectionRecord(DEFAULTED_SECTION, USER_ID);
		const bornBag = (await sql.unsafe(
			`SELECT relation->$1 AS items FROM "${TABLE}" WHERE section_tipo = $2 AND section_id = $3`,
			[DEFAULTED_PORTAL, DEFAULTED_SECTION, linked],
		)) as { items: unknown }[];
		expect(references((bornBag[0]?.items ?? []) as Record<string, unknown>[], ANCHOR_ID)).toBe(
			true,
		);
		// The anchor is deleted (with its Time Machine row) — the default now names a deleted record.
		expect((await deleteSectionRecord(SECTION, ANCHOR_ID, USER_ID)).removed).toBe(true);
		const before = await rowCount(DEFAULTED_SECTION);
		const birth = await settle(createSectionRecord(DEFAULTED_SECTION, USER_ID));
		expect(codeOf(birth)).toBe('relation.target_deleted');
		expect(await rowCount(DEFAULTED_SECTION)).toBe(before);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// G5 — THE LOCK-MODE CENSUS (over the write-path corpus: src/, tools/, scripts/). A writer's `FOR UPDATE` on a matrix row conflicts
// with the `FOR KEY SHARE` of every save linking to that row: mutual links
// deadlock and a link to a hot record blocks every edit of it. So `FOR UPDATE`
// is legal ONLY where the transaction DELETES the row it locks (or on a row that
// is never a locator target), each named here with its reason — exact counts,
// shrink-only. Every other writer lock is `FOR NO KEY UPDATE`.
// ---------------------------------------------------------------------------

const DELETING_ROW_LOCKS: Readonly<Record<string, { count: number; reason: string }>> = {
	'src/core/section/record/delete_record.ts': {
		count: 1,
		reason:
			"lockRecordSnapshot: the record delete's own target, DELETED in the same transaction — the " +
			'conflicting half of the locator-target protocol (T1-19)',
	},
	'src/core/ontology/hierarchy_state.ts': {
		count: 2,
		reason: 'lockTeardownRows: the <tld>0 records and the ontology35 row the teardown DELETES',
	},
	'src/diffusion/jobs/queue.ts': {
		count: 2,
		reason:
			'diffusion job-queue claim (FOR UPDATE SKIP LOCKED): a queue row, never a locator target',
	},
};

/** The `FOR UPDATE` (not `FOR NO KEY UPDATE`) occurrences on non-comment lines of a source. */
function forUpdateCount(source: string): number {
	let count = 0;
	for (const line of source.split('\n')) {
		const trimmed = line.trim();
		if (/^(\*|\/\/|\/\*|--)/.test(trimmed)) continue;
		count += (line.match(/(?<!NO KEY )\bFOR UPDATE\b/g) ?? []).length;
	}
	return count;
}

describe('T1-19 G5: the lock-mode census', () => {
	test('every FOR UPDATE row lock is a named DELETING lock (exact counts)', () => {
		const corpus = writePathSourceFiles();
		expect(corpus.length).toBeGreaterThan(WRITE_PATH_CORPUS_FLOOR);
		const found: Record<string, number> = {};
		for (const file of corpus) {
			const count = forUpdateCount(readFileSync(join(REPO_ROOT, file), 'utf-8'));
			if (count > 0) found[file] = count;
		}
		const expected = Object.fromEntries(
			Object.entries(DELETING_ROW_LOCKS).map(([file, entry]) => [file, entry.count]),
		);
		expect(found).toEqual(expected);
	});

	test('positive control: the scanner counts a planted writer FOR UPDATE and spares the others', () => {
		expect(forUpdateCount('\tconst r = await sql`SELECT 1 FROM t FOR UPDATE`;')).toBe(1);
		expect(forUpdateCount('\tconst r = await sql`SELECT 1 FROM t FOR NO KEY UPDATE`;')).toBe(0);
		expect(forUpdateCount(' * a comment naming FOR UPDATE')).toBe(0);
		expect(forUpdateCount('\t\t -- FOR UPDATE SKIP LOCKED')).toBe(0);
	});

	test('the lock-mode law headers name gates that EXIST (a header rule points at its real gate)', () => {
		// A header stating the law must name the census that enforces it; a name
		// with no file sends the next maintainer to a gate that is not there.
		const sites = [
			'src/core/db/matrix_write.ts',
			'src/core/section_record/locator_targets.ts',
			'src/core/section_record/record_write.ts',
			'engineering/wire_contract/WC-2026-11-12-locator-target-deleted-refused.md',
		];
		const named = new Set<string>();
		for (const site of sites) {
			const source = readFileSync(join(REPO_ROOT, site), 'utf-8');
			for (const match of source.matchAll(/\b([a-z][a-z0-9_]*_native)\b/g))
				named.add(match[1] ?? '');
		}
		expect(named.has('delete_inverse_lost_update_native')).toBe(true); // non-vacuity
		const missing = [...named].filter(
			(gate) => !existsSync(join(REPO_ROOT, 'test/unit', `${gate}.test.ts`)),
		);
		expect(missing).toEqual([]);
	});

	test('every record-write KEY ENTRY declares its locator-target law (verify / exempt + reason)', () => {
		const source = readFileSync(
			join(REPO_ROOT, 'src/core/section_record/record_write.ts'),
			'utf-8',
		);
		const entries = [...source.matchAll(/door: '(persist\w+)',\n\s*law:([\s\S]*?)\n\t*\}\);/g)];
		expect(entries.length).toBeGreaterThanOrEqual(6); // the five key entries + the append
		for (const [, door, body] of entries) {
			expect(
				/targets: ('verify'|\{\s*exempt:)/.test(body ?? ''),
				`${door} declares no targets`,
			).toBe(true);
		}
		const verified = entries
			.filter(([, , body]) => /targets: 'verify'/.test(body ?? ''))
			.map(([, door]) => door)
			.sort();
		expect(verified).toEqual([
			'persistAppendedKeyItems',
			'persistObserverResaveKeys',
			'persistRecordKeys',
		]);
	});
});
