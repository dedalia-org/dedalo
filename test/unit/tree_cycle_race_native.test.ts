/**
 * ONT-5 (tree half) — no door can STORE a cycle in a hierarchy, alone or racing.
 *
 * THE FAILURE CLASS. A parent link X→Q closes a cycle exactly when X is already
 * an ancestor of Q. The tree move checked that with an UNLOCKED ancestor walk
 * BEFORE its transaction, so two moves that are each harmless — A under C while
 * B goes under D, in a tree where C descends from B and D from A — both pass
 * their check, both commit, and A→C→B→D→A is stored. Every other door that
 * writes a `component_relation_parent` key (add_child, the save engine, the core
 * API save, MCP, CSV import, propagate, the Time Machine restores, the bulk
 * revert, the archive restore, the record duplicate) performed no check at all. A stored cycle breaks every ancestor walk (the
 * recursion records 'Loop detected' and the tree renders a node under itself).
 *
 *   C1  two disjoint moves that TOGETHER close a cycle      → one refused tree.cycle
 *   (C2, the save engine inserting a descendant as a parent, is the census
 *       case C6 `save_engine` — one probe, one KNOWN_OPEN switch)
 *   C3  a move racing a curator's parent-field replace      → exactly one lands, no loop
 *   C3b the OTHER order: a curator door (the save engine, the children door)
 *       writing while a move holds its written link UNCOMMITTED → exactly one
 *       lands, no loop (the record_write hook's locked check)
 *   C4  LOOP REPAIR: a pre-existing loop can still be cut, and links that do not
 *       touch it still land (guards the "check only the ADDED links" law and the
 *       walk's termination — green before the fix by design, see below)
 *   C5  the tree transaction retries a deadlock victim (40P01) and nothing
 *       else, within a BOUNDED budget (the delays list), then rethrows the 40P01
 *   C6  DOOR CENSUS: every door that writes a parent key answers tree.cycle to a
 *       cycle-forming payload and stores nothing. `KNOWN_OPEN` is a shrink-only
 *       {door: reason} map (C6 doors and `race.*` C3b doors); a listed door that
 *       no longer stores the cycle is RED too (delete its entry).
 *   C7  the chokepoint entry (assertParentLinkKeysAcyclic) on its own — every
 *       write shape, and ONLY a component_relation_parent key is a parent link
 *       (a related-term key naming a narrower term passes)
 *   C8  the chokepoint's transaction-less fast path: a parent key written with
 *       no ambient transaction (no observed, no indexed key) must still be
 *       checked — a harmless link lands, a cyclic one answers tree.cycle, never
 *       internal.invariant (the hook opens the transaction there)
 *   C9  the census is COMPLETE by derivation: every unit that writes the matrix
 *       (a matrix_write DML primitive call, a psql seed) is classified —
 *       probed by a C6/C3b/C8 door, unable to add a parent link (with why), or
 *       `unchecked` (said out loud, count pinned) — so a new writer is red
 *       until it is placed
 *
 * C4 IS GREEN BEFORE THE FIX, deliberately: the old unlocked check walked the
 * prospective parent's ancestors with a loop-tolerant recursion and never
 * re-checked existing links, so loop repair worked. It is here to pin that the
 * locked design KEEPS it (mutations M7/M8: a check of every link in the after
 * set refuses the repair; a walk without a visited set never terminates).
 *
 * SITUATION: scratch TLDs `zztcy` (every case) and `zztca` (the archive probe,
 * whose extract takes EVERY record of a section) — test/helpers/
 * tree_lock_situation.ts; records created at runtime and swept with the TLD,
 * dd800 runs swept by id.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setField } from '../../src/ai/mcp/tools/fields_write.ts';
import { config } from '../../src/config/config.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { extractArchive } from '../../src/core/archive/extract.ts';
import { restoreArchive } from '../../src/core/archive/restore.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { readMatrixKeyForUpdate } from '../../src/core/db/matrix_write.ts';
import { sql, sqlStateOf, withTransaction } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { ERROR_REGISTRY } from '../../src/core/errors/registry.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { getParentTipo } from '../../src/core/relations/children.ts';
import {
	addParent,
	assertParentLinkKeysAcyclic,
	getParentsRecursive,
} from '../../src/core/relations/parent.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { persistRecordKeys, persistRestoredKeys } from '../../src/core/section_record/index.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { addChild, updateParentData } from '../../src/core/ts_object/ts_api.ts';
import { tool as csvTool } from '../../tools/tool_import_dedalo_csv/server/index.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import {
	boundedRun,
	currentBackendPid,
	holdRows,
	type Settled,
	settle,
	waitForLockWaiters,
	waitUntilBlockedBy,
} from '../helpers/lock_wait.ts';
import { buildWriterClosure, MATRIX_WRITE, rawCallsIn } from '../helpers/matrix_writer_closure.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import {
	dropTreeSituation,
	ensureTreeSituation,
	newNodes,
	PARENT_LINK_TYPE,
	parentIds,
	ROOT_USER_ID,
	seedLinks,
	storedLinks,
	succeeded,
	type TreeSection,
	treeSituation,
} from '../helpers/tree_lock_situation.ts';
import { REPO_ROOT, writePathSourceFiles } from '../helpers/write_path_corpus.ts';

registerSessionCleanup();

const TREE = treeSituation('zztcy');
const ORDERED = TREE.ordered;
const PLAIN = TREE.plain;
/** The archive probe's own TLD: its ORDERED section holds exactly one record. */
const ARCHIVE_TREE = treeSituation('zztca');
const SUPERUSER: Principal = { userId: ROOT_USER_ID, isGlobalAdmin: true, isDeveloper: true };
const WAIT_MS = 15_000;
/** The registry's own sentence for the code — how a per-row door reports it. */
const CYCLE_MESSAGE = ERROR_REGISTRY['tree.cycle'].message;

/** dd800 runs minted by the doors below (swept by id). */
const runs: number[] = [];
let bulkTable = '';
let csvPath: string | null = null;
let archiveDir: string | null = null;

beforeAll(async () => {
	await ensureTreeSituation(TREE);
	await ensureTreeSituation(ARCHIVE_TREE);
	for (const s of [ORDERED, PLAIN, ARCHIVE_TREE.ordered, ARCHIVE_TREE.plain]) {
		expect(await getMatrixTableFromTipo(s.section)).toBe(s.table);
		expect(await getParentTipo(s.section)).toBe(s.parent);
	}
	bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
}, 60_000);

afterAll(async () => {
	if (csvPath !== null) rmSync(csvPath, { force: true });
	if (archiveDir !== null) rmSync(archiveDir, { recursive: true, force: true });
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
	expect(await dropTreeSituation(ARCHIVE_TREE)).toBe(0);
	expect(await dropTreeSituation(TREE)).toBe(0);
}, 60_000);

function rememberRun(id: unknown): void {
	const run = Number(id);
	if (Number.isInteger(run) && run > 0) runs.push(run);
}

function moveRqo(s: TreeSection, child: number, from: number, to: number) {
	return {
		source: {
			section_tipo: s.section,
			section_id: child,
			old_parent_section_tipo: s.section,
			old_parent_section_id: from,
			new_parent_section_tipo: s.section,
			new_parent_section_id: to,
		},
	} as never;
}

function linkTo(s: TreeSection, parent: number) {
	return {
		section_tipo: s.section,
		section_id: parent,
		from_component_tipo: s.parent,
		type: PARENT_LINK_TYPE,
	};
}

/** The machine-readable code an outcome carries, wherever the door puts it. */
function cycleCodeIn(outcome: Settled<unknown>): boolean {
	if (outcome.status === 'rejected') {
		const reason = outcome.reason;
		if (isDedaloError(reason)) return reason.code === 'tree.cycle';
		return String((reason as Error)?.message ?? reason).includes(CYCLE_MESSAGE);
	}
	const text = JSON.stringify(outcome.value ?? null);
	return text.includes('"tree.cycle"') || text.includes(CYCLE_MESSAGE);
}

/** True when an ancestor walk from (s, id) meets a loop. */
async function loopsFrom(s: TreeSection, id: number): Promise<boolean> {
	return (await getParentsRecursive(id, s.section)).errors.length > 0;
}

/**
 * The C1/C3 tree: R → pA → {A, sA}, A → D; R → pB → {B, sB}, B → C. Orders put
 * A and B FIRST under their parents, so moving them out renumbers sA / sB.
 */
async function raceTree() {
	const [r, pA, pB, a, sA, d, b, sB, c] = await newNodes(ORDERED, 9);
	await seedLinks(ORDERED, pA, [{ parent: r, itemId: 1, order: 1 }]);
	await seedLinks(ORDERED, pB, [{ parent: r, itemId: 1, order: 2 }]);
	await seedLinks(ORDERED, a, [{ parent: pA, itemId: 1, order: 1 }]);
	await seedLinks(ORDERED, sA, [{ parent: pA, itemId: 1, order: 2 }]);
	await seedLinks(ORDERED, d, [{ parent: a, itemId: 1, order: 1 }]);
	await seedLinks(ORDERED, b, [{ parent: pB, itemId: 1, order: 1 }]);
	await seedLinks(ORDERED, sB, [{ parent: pB, itemId: 1, order: 2 }]);
	await seedLinks(ORDERED, c, [{ parent: b, itemId: 1, order: 1 }]);
	return { r, pA, pB, a, sA, d, b, sB, c };
}

// ---------------------------------------------------------------------------
// C1-C3 — the races
// ---------------------------------------------------------------------------

describe('ONT-5: a cycle can never be stored', () => {
	test('C1 two disjoint moves that TOGETHER close a cycle: exactly one is refused tree.cycle', async () => {
		const t = await raceTree();
		const holder = await holdRows([
			{ table: ORDERED.table, sectionTipo: ORDERED.section, sectionId: t.sA },
			{ table: ORDERED.table, sectionTipo: ORDERED.section, sectionId: t.sB },
		]);
		const moveA = settle(updateParentData(moveRqo(ORDERED, t.a, t.pA, t.c), SUPERUSER));
		const moveB = settle(updateParentData(moveRqo(ORDERED, t.b, t.pB, t.d), SUPERUSER));
		const bothInFlight = await waitForLockWaiters(2, [holder.pid], WAIT_MS);
		await holder.release();
		const outcomes = await Promise.all([moveA, moveB]);

		expect(bothInFlight, 'the interleave did not happen: both moves must be in flight').toBe(true);
		const fulfilled = outcomes.filter((o) => o.status === 'fulfilled').length;
		// THE DEFECT: each move's pre-transaction ancestor walk saw the OTHER's
		// old position, so both committed.
		expect(fulfilled, 'both moves committed: the pair closed a cycle').toBe(1);
		const refused = outcomes.find((o) => o.status === 'rejected');
		expect(refused !== undefined && cycleCodeIn(refused)).toBe(true);
		for (const id of [t.a, t.b, t.c, t.d]) {
			expect(await loopsFrom(ORDERED, id), `a loop is stored above node ${id}`).toBe(false);
		}
		const ancestorsOfA = (await getParentsRecursive(t.a, ORDERED.section)).ancestors.map((p) =>
			Number(p.section_id),
		);
		expect(ancestorsOfA).not.toContain(t.a);
	}, 60_000);

	test("C3 a move racing a curator's parent-field replace: exactly one lands, no loop is stored", async () => {
		const t = await raceTree();
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let wrote: (value: { pid: number; ok: boolean }) => void = () => {};
		const written = new Promise<{ pid: number; ok: boolean }>((resolve) => {
			wrote = resolve;
		});
		// The curator replaces B's parent pB with D — harmless on the tree it sees.
		const curator = settle(
			withTransaction(async () => {
				const pid = await currentBackendPid();
				const saved = await saveComponentData({
					componentTipo: ORDERED.parent,
					sectionTipo: ORDERED.section,
					sectionId: t.b,
					lang: 'lg-nolan',
					changedData: [
						{
							action: 'set_data',
							id: null,
							value: [{ section_tipo: ORDERED.section, section_id: t.d }],
						},
					] as never,
					userId: ROOT_USER_ID,
				});
				wrote({ pid, ok: saved.ok });
				await gate;
				return saved;
			}),
		);
		const curatorWrite = await written;
		expect(curatorWrite.ok).toBe(true);

		// The move puts A under C — harmless on the COMMITTED tree it sees.
		const move = settle(updateParentData(moveRqo(ORDERED, t.a, t.pA, t.c), SUPERUSER));
		// Either the move waits on the curator's row (locked design) or it runs
		// straight through (unlocked) — both are bounded, never a hang.
		await Promise.race([move, waitUntilBlockedBy(curatorWrite.pid, 1, WAIT_MS)]);
		releaseGate();
		const [curatorOutcome, moveOutcome] = await Promise.all([curator, move]);

		// The save answers {ok}; the tree action answers its outcome or throws.
		const curatorLanded = curatorOutcome.status === 'fulfilled' && succeeded(curatorOutcome.value);
		const moveLanded = moveOutcome.status === 'fulfilled';
		const landed = Number(curatorLanded) + Number(moveLanded);
		// THE DEFECT: both landed — B→D (curator) + A→C (move) = A→C→B→D→A.
		expect(landed, 'both writes landed: the race stored a cycle').toBe(1);
		for (const id of [t.a, t.b, t.c, t.d]) {
			expect(await loopsFrom(ORDERED, id), `a loop is stored above node ${id}`).toBe(false);
		}
	}, 60_000);
});

// ---------------------------------------------------------------------------
// C3b — a curator door racing a move whose link is written but NOT committed
// ---------------------------------------------------------------------------

type RaceTree = Awaited<ReturnType<typeof raceTree>>;

/**
 * The curator writes that close the cycle against the move A→C: B→D, through
 * the save engine (B's parent field) and through the children door (D's
 * children field gains B — children_write writes D into B's parents; its own
 * pre-check is an UNLOCKED memoized isAncestor, which sees the move's old tree).
 */
const RACE_DOORS: Record<string, (t: RaceTree) => Promise<unknown>> = {
	save_engine: (t) =>
		saveComponentData({
			componentTipo: ORDERED.parent,
			sectionTipo: ORDERED.section,
			sectionId: t.b,
			lang: 'lg-nolan',
			changedData: [
				{ action: 'insert', id: null, value: { section_tipo: ORDERED.section, section_id: t.d } },
			],
			userId: ROOT_USER_ID,
		}),
	children_write: (t) =>
		saveComponentData({
			componentTipo: ORDERED.children,
			sectionTipo: ORDERED.section,
			sectionId: t.d,
			lang: 'lg-nolan',
			changedData: [
				{ action: 'insert', id: null, value: { section_tipo: ORDERED.section, section_id: t.b } },
			],
			userId: ROOT_USER_ID,
			principal: SUPERUSER,
		}),
};

describe('ONT-5: a curator door cannot close a cycle against an uncommitted move', () => {
	for (const [door, write] of Object.entries(RACE_DOORS)) {
		test(`C3b ${door} writing while a move holds A→C uncommitted: exactly one lands, no loop`, async () => {
			const t = await raceTree();
			// The move writes A→C, then stalls on the sibling batch under pA (sA held).
			const holder = await holdRows([
				{ table: ORDERED.table, sectionTipo: ORDERED.section, sectionId: t.sA },
			]);
			const move = settle(updateParentData(moveRqo(ORDERED, t.a, t.pA, t.c), SUPERUSER));
			const moveStalled = await waitUntilBlockedBy(holder.pid, 1, WAIT_MS);
			// B→D is harmless on the COMMITTED tree (A is still under pA there).
			const curator = settle(write(t));
			// The interleave witness: the curator is in flight behind the move (the
			// move's cycle walk holds B FOR SHARE), the move behind the holder.
			const bothWaiting = await waitForLockWaiters(2, [holder.pid], WAIT_MS);
			await holder.release();
			const [moveOutcome, curatorOutcome] = await Promise.all([move, curator]);

			expect(moveStalled, 'the move never stalled with its link written').toBe(true);
			expect(bothWaiting, 'the interleave did not happen: the curator must be in flight').toBe(
				true,
			);
			let loopStored = false;
			for (const id of [t.a, t.b, t.c, t.d]) loopStored ||= await loopsFrom(ORDERED, id);
			const reason = KNOWN_OPEN[`race.${door}`];
			if (reason !== undefined) {
				// Open BY DECLARATION — and the race really stores the cycle (else the
				// entry is stale or the probe vacuous).
				expect(
					loopStored,
					`race.${door} is listed KNOWN_OPEN (${reason}) but no longer stores the cycle — delete its entry`,
				).toBe(true);
				return;
			}
			// The move came first and is harmless: it lands. The curator, checking
			// inside its own transaction AFTER the move's commit, meets A→C→B.
			expect(moveOutcome.status).toBe('fulfilled');
			const curatorLanded =
				curatorOutcome.status === 'fulfilled' && succeeded(curatorOutcome.value);
			expect(curatorLanded, `${door} landed: the race stored a cycle`).toBe(false);
			expect(cycleCodeIn(curatorOutcome), `${door} was not refused as tree.cycle`).toBe(true);
			expect(loopStored, 'a loop is stored').toBe(false);
		}, 60_000);
	}
});

// ---------------------------------------------------------------------------
// C4 — loop repair
// ---------------------------------------------------------------------------

/** A pre-existing E↔F loop, written raw (the state a repair starts from). */
async function loop(): Promise<{ e: number; f: number }> {
	const [e, f] = await newNodes(PLAIN, 2);
	await seedLinks(PLAIN, e, [{ parent: f, itemId: 1 }]);
	await seedLinks(PLAIN, f, [{ parent: e, itemId: 1 }]);
	expect(await loopsFrom(PLAIN, e)).toBe(true);
	return { e, f };
}

describe('ONT-5: a curator can still repair an existing loop', () => {
	test('C4 cutting the loop in the edit form (E’s parent field emptied) succeeds', async () => {
		// The curator's door for removing a link: the save engine (the record-write
		// chokepoint's `replace` check once hooked — nothing is ADDED, so nothing
		// is walked).
		const { e } = await loop();
		await saveParent(e, setParents([]));
		expect(await parentIds(PLAIN, e)).toEqual([]);
		expect(await loopsFrom(PLAIN, e)).toBe(false);
	}, 30_000);

	test('C4 moving a looped node out of the loop to an unrelated G succeeds', async () => {
		// The tree's door for removing a link: the move drops E→F (not checked)
		// and adds E→G (checked: G reaches neither E nor the loop).
		const { e, f } = await loop();
		const [g] = await newNodes(PLAIN, 1);
		const moved = await settle(updateParentData(moveRqo(PLAIN, e, f, g), SUPERUSER));
		expect(moved.status).toBe('fulfilled');
		expect(await parentIds(PLAIN, e)).toEqual([g]);
		expect(await loopsFrom(PLAIN, e)).toBe(false);
	}, 30_000);

	test('C4 an unrelated parent G added to a looped node succeeds (only ADDED links are checked)', async () => {
		const { e, f } = await loop();
		const [g] = await newNodes(PLAIN, 1);
		const added = await withTransaction(() =>
			addParent(PLAIN.section, e, PLAIN.parent, linkTo(PLAIN, g), ROOT_USER_ID),
		);
		expect(succeeded(added)).toBe(true);
		expect(await parentIds(PLAIN, e)).toEqual([f, g].sort((x, y) => x - y));
	}, 30_000);

	test('C4 linking an unrelated X under a looped F terminates and succeeds', async () => {
		const { f } = await loop();
		const [x] = await newNodes(PLAIN, 1);
		const outcome = await boundedRun(
			withTransaction(() =>
				addParent(PLAIN.section, x, PLAIN.parent, linkTo(PLAIN, f), ROOT_USER_ID),
			),
			10_000,
		);
		expect(outcome.status, 'the ancestor walk did not terminate on a looped hierarchy').toBe(
			'fulfilled',
		);
		expect(outcome.status === 'fulfilled' && succeeded(outcome.value)).toBe(true);
		expect(await parentIds(PLAIN, x)).toEqual([f]);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// C5 — the deadlock retry
// ---------------------------------------------------------------------------

/** The tree transaction module (ts_object/tree_locks.ts). */
async function treeLocks(): Promise<{
	withTreeTransaction: <T>(
		work: () => Promise<T>,
		options?: { delaysMs?: readonly number[] },
	) => Promise<T>;
}> {
	return import('../../src/core/ts_object/tree_locks.ts');
}

async function raiseSqlState(state: '40P01' | '23505'): Promise<never> {
	await sql.unsafe(
		`DO $$ BEGIN RAISE EXCEPTION 'synthetic ${state}' USING ERRCODE = '${state}'; END $$`,
	);
	throw new Error(`raiseSqlState(${state}) did not raise`);
}

async function scratchTerm(id: number): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT string->$3 AS v FROM "${PLAIN.table}" WHERE section_tipo = $1 AND section_id = $2`,
		[PLAIN.section, id, PLAIN.term],
	)) as { v: unknown }[];
	return rows[0]?.v ?? null;
}

describe('ONT-5: the tree transaction retries a deadlock victim, and only that', () => {
	test('C5 a 40P01 on attempt 1 is retried: attempt 1 rolled back, attempt 2 answers', async () => {
		const { withTreeTransaction } = await treeLocks();
		const [node] = await newNodes(PLAIN, 1);
		let attempts = 0;
		const result = await withTreeTransaction(
			async () => {
				attempts++;
				if (attempts === 1) {
					await sql.unsafe(
						`UPDATE "${PLAIN.table}" SET string = jsonb_set(COALESCE(string, '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb)
						  WHERE section_tipo = $1 AND section_id = $2`,
						[
							PLAIN.section,
							node,
							PLAIN.term,
							JSON.stringify([{ id: 1, lang: 'lg-nolan', value: 'attempt 1' }]),
						],
					);
					await raiseSqlState('40P01');
				}
				return 'attempt 2';
			},
			{ delaysMs: [1, 1, 1] },
		);
		expect(result).toBe('attempt 2');
		expect(attempts).toBe(2);
		expect(await scratchTerm(node)).toBeNull();
	}, 30_000);

	test('C5 under an AMBIENT transaction the owner decides: no retry', async () => {
		const { withTreeTransaction } = await treeLocks();
		let attempts = 0;
		const outcome = await settle(
			withTransaction(() =>
				withTreeTransaction(
					async () => {
						attempts++;
						return raiseSqlState('40P01');
					},
					{ delaysMs: [1, 1, 1] },
				),
			),
		);
		expect(outcome.status).toBe('rejected');
		expect(attempts).toBe(1);
	}, 30_000);

	test('C5 the retry budget is BOUNDED: delays [1] ⇒ exactly 2 attempts, then the 40P01 propagates', async () => {
		const { withTreeTransaction } = await treeLocks();
		let attempts = 0;
		const outcome = await boundedRun(
			withTreeTransaction(
				async () => {
					attempts++;
					// A permanent victim: stop raising after a generous cap so an
					// unbounded loop ends (and is reported) instead of hanging the suite.
					if (attempts > 50) return 'unbounded';
					return raiseSqlState('40P01');
				},
				{ delaysMs: [1] },
			),
			10_000,
		);
		expect(attempts, 'the retry budget is not the delays list').toBe(2);
		expect(outcome.status).toBe('rejected');
		expect(outcome.status === 'rejected' ? sqlStateOf(outcome.reason) : null).toBe('40P01');
	}, 30_000);

	test('C5 any other failure (23505) is not retried', async () => {
		const { withTreeTransaction } = await treeLocks();
		let attempts = 0;
		const outcome = await settle(
			withTreeTransaction(
				async () => {
					attempts++;
					return raiseSqlState('23505');
				},
				{ delaysMs: [1, 1, 1] },
			),
		);
		expect(outcome.status).toBe('rejected');
		expect(attempts).toBe(1);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// C7 — the chokepoint entry, before any door is hooked to it
// ---------------------------------------------------------------------------

/** The record_write target of a PLAIN node. */
function plainTarget(id: number) {
	return { table: PLAIN.table, sectionTipo: PLAIN.section, sectionId: id };
}

/** A parent-key write of `ids` as the chokepoint carries it. */
function parentKeyWrite(ids: number[], encode = false) {
	const value = ids.map((id) => linkTo(PLAIN, id));
	return {
		column: 'relation' as const,
		key: PLAIN.parent,
		value: encode ? JSON.stringify(value) : value,
	};
}

/** The DedaloError code an outcome rejected with (or its status). */
function codeOf(outcome: Settled<unknown>): string {
	if (outcome.status === 'fulfilled') return 'fulfilled';
	return isDedaloError(outcome.reason) ? outcome.reason.code : String(outcome.reason);
}

describe('ONT-5: the chokepoint entry refuses a cycle in any write shape', () => {
	test('C7 replace, append and pre-encoded writes that close a cycle: tree.cycle', async () => {
		const { a, d } = await chain();
		const before = await storedLinks(PLAIN, a);
		const shapes: [string, ReturnType<typeof parentKeyWrite>, 'replace' | 'append'][] = [
			['replace', parentKeyWrite([d]), 'replace'],
			['append', parentKeyWrite([d]), 'append'],
			['pre-encoded replace', parentKeyWrite([d], true), 'replace'],
		];
		for (const [name, write, mode] of shapes) {
			const outcome = await settle(
				withTransaction(() => assertParentLinkKeysAcyclic(plainTarget(a), [write], mode)),
			);
			expect(codeOf(outcome), `${name} was not refused`).toBe('tree.cycle');
		}
		// The entry answers whether a write may land; it never writes.
		expect(await storedLinks(PLAIN, a)).toEqual(before);
	}, 30_000);

	test('C7 a harmless append passes; a set with no parent key needs no transaction', async () => {
		const { a } = await chain();
		const [g] = await newNodes(PLAIN, 1);
		const harmless = await settle(
			withTransaction(() =>
				assertParentLinkKeysAcyclic(plainTarget(a), [parentKeyWrite([g])], 'append'),
			),
		);
		expect(codeOf(harmless)).toBe('fulfilled');
		const noParentKey = await settle(
			assertParentLinkKeysAcyclic(
				plainTarget(a),
				[{ column: 'string', key: PLAIN.term, value: [{ id: 1, lang: 'lg-nolan', value: 'x' }] }],
				'replace',
			),
		);
		expect(codeOf(noParentKey)).toBe('fulfilled');
	}, 30_000);

	test('C7 birth: a reborn record whose stored link closes a loop through a STALE link is refused', async () => {
		// D still names E as its parent (a stale link to a record that was deleted).
		// E is reborn holding E→D: as a birth every stored link is ADDED, so the
		// check walks D → E and refuses — `replace` would see before = after and
		// check nothing.
		const [e, d] = await newNodes(PLAIN, 2);
		await seedLinks(PLAIN, d, [{ parent: e, itemId: 1 }]);
		await seedLinks(PLAIN, e, [{ parent: d, itemId: 1 }]);
		const reborn = parentKeyWrite([d]);
		const birth = await settle(
			withTransaction(() => assertParentLinkKeysAcyclic(plainTarget(e), [reborn], 'birth')),
		);
		expect(codeOf(birth)).toBe('tree.cycle');
		const replace = await settle(
			withTransaction(() => assertParentLinkKeysAcyclic(plainTarget(e), [reborn], 'replace')),
		);
		expect(codeOf(replace), 'replace re-checks nothing it did not add').toBe('fulfilled');
	}, 30_000);

	test('C7 a NON-parent relation key pointing at a descendant is not a parent link: it passes, with or without a transaction', async () => {
		// The entry runs on EVERY relation write once the chokepoint is hooked: only
		// a component_relation_parent key is a parent link. A related-term style
		// key on A naming A's narrower term D must not be walked as one (it would
		// reach A and answer a false tree.cycle — or internal.invariant on the
		// transaction-less fast path).
		const { a, d } = await chain();
		const related = { column: 'relation' as const, key: PLAIN.children, value: [linkTo(PLAIN, d)] };
		const inTransaction = await settle(
			withTransaction(() => assertParentLinkKeysAcyclic(plainTarget(a), [related], 'replace')),
		);
		expect(codeOf(inTransaction), 'a non-parent relation key was checked as a parent link').toBe(
			'fulfilled',
		);
		const bare = await settle(assertParentLinkKeysAcyclic(plainTarget(a), [related], 'replace'));
		expect(codeOf(bare), 'a non-parent relation key demanded a transaction').toBe('fulfilled');
		// Positive control: the SAME payload under the parent key is the cycle.
		const asParent = await settle(
			withTransaction(() =>
				assertParentLinkKeysAcyclic(plainTarget(a), [{ ...related, key: PLAIN.parent }], 'replace'),
			),
		);
		expect(codeOf(asParent)).toBe('tree.cycle');
	}, 30_000);

	test('C7 a parent key outside a transaction refuses (internal.invariant)', async () => {
		const { a, d } = await chain();
		const outcome = await settle(
			assertParentLinkKeysAcyclic(plainTarget(a), [parentKeyWrite([d])], 'replace'),
		);
		expect(codeOf(outcome)).toBe('internal.invariant');
	}, 30_000);

	test('C7 the entry, in a writer’s transaction AFTER its row lock, refuses against a move holding A→C uncommitted', async () => {
		// The placement every hooked door must have (C3b is the door-level twin):
		// the writer locks its row (B — it waits behind the move's cycle walk,
		// which holds B FOR SHARE), and only then runs the entry, which walks the
		// tree the move COMMITTED: D→A→C→B.
		const t = await raceTree();
		const holder = await holdRows([
			{ table: ORDERED.table, sectionTipo: ORDERED.section, sectionId: t.sA },
		]);
		const move = settle(updateParentData(moveRqo(ORDERED, t.a, t.pA, t.c), SUPERUSER));
		const moveStalled = await waitUntilBlockedBy(holder.pid, 1, WAIT_MS);
		const target = { table: ORDERED.table, sectionTipo: ORDERED.section, sectionId: t.b };
		const writer = settle(
			withTransaction(async () => {
				await readMatrixKeyForUpdate(
					target.table,
					target.sectionTipo,
					t.b,
					'relation',
					ORDERED.parent,
				);
				await assertParentLinkKeysAcyclic(
					target,
					[{ column: 'relation', key: ORDERED.parent, value: [linkTo(ORDERED, t.d)] }],
					'append',
				);
			}),
		);
		const bothWaiting = await waitForLockWaiters(2, [holder.pid], WAIT_MS);
		await holder.release();
		const [moveOutcome, writerOutcome] = await Promise.all([move, writer]);

		expect(moveStalled).toBe(true);
		expect(bothWaiting, 'the interleave did not happen: the writer must be in flight').toBe(true);
		expect(moveOutcome.status).toBe('fulfilled');
		expect(codeOf(writerOutcome)).toBe('tree.cycle');
	}, 60_000);

	test('C7 a replace that KEEPS an existing loop and adds an unrelated parent passes', async () => {
		const { e, f } = await loop();
		const [g] = await newNodes(PLAIN, 1);
		const outcome = await settle(
			withTransaction(() =>
				assertParentLinkKeysAcyclic(plainTarget(e), [parentKeyWrite([f, g])], 'replace'),
			),
		);
		expect(codeOf(outcome)).toBe('fulfilled');
	}, 30_000);
});

// ---------------------------------------------------------------------------
// C6 — the door census
// ---------------------------------------------------------------------------

/**
 * Doors that STILL store a cycle-forming payload, each with its reason.
 * SHRINK-ONLY, mechanically: a listed door must still be open (the probe
 * stores the cycle), so closing a door without deleting its entry is RED; the
 * size is pinned by {@link KNOWN_OPEN_CEILING}; and every door carries ONE
 * declared status — here or in {@link PROVEN_CLOSED} — so re-opening a closed
 * door needs a visible removal there, never a silent line here.
 */
const KNOWN_OPEN: Record<string, string> = {
	'archive.restore':
		'PENDING owner step — archive/restore.ts writeRecordRow writes raw rows (insertMatrixRecordWithExplicitId + updateMatrixRecord) past the chokepoint; it is checked once the ARCHIVE obligation (write_obligations_tripwire PENDING: archive door → persistRecordColumns/persistRecordBirth) routes it through the chokepoint’s birth/replace hook',
};

/**
 * The pinned number of KNOWN_OPEN entries. Lower it with every deleted entry;
 * raising it (a newly found open door) is a second, visible edit that must
 * name the door's reason above.
 */
const KNOWN_OPEN_CEILING = 1;

/**
 * Doors PROVEN closed: their probe answers tree.cycle and stores nothing
 * today. With KNOWN_OPEN they cover every door exactly once, so a door whose
 * entry is deleted above moves HERE, and a door listed here can only re-open
 * by being visibly removed — a swap (one door closed, another re-opened at the
 * same count) cannot pass as an unchanged ceiling.
 */
const PROVEN_CLOSED: readonly string[] = [
	'c8.persistRecordKeys',
	'c8.persistRestoredKeys',
	'children_write',
	'csv_import',
	'dd_core_api.save',
	'dd_ts_api.add_child',
	'dd_ts_api.update_parent_data',
	'duplicate_record',
	'mcp.fields_write',
	'race.children_write',
	'race.save_engine',
	'save_engine',
	'save_engine(set_data)',
	'tm.apply_value',
	'tm.apply_value(section)',
	'tm.bulk_revert',
	'tm.restore_deleted',
	'tool_propagate_component_data',
];

/** What a door did with a cycle-forming payload. */
interface DoorProbe {
	/** The door answered the cycle code (thrown, wire body or per-row message). */
	answeredCycle: boolean;
	/** A loop is reachable from the probed node after the call. */
	cycleStored: boolean;
	/** The probed node's parent key is byte-identical to before. */
	unchanged: boolean;
	/** The door's answer, for the failure message. */
	detail: string;
}

/** The simple fixture: R → A → D (D's parent is A). The payload: D as A's parent. */
async function chain(): Promise<{ r: number; a: number; d: number }> {
	const [r, a, d] = await newNodes(PLAIN, 3);
	await seedLinks(PLAIN, a, [{ parent: r, itemId: 1 }]);
	await seedLinks(PLAIN, d, [{ parent: a, itemId: 1 }]);
	return { r, a, d };
}

/**
 * Drive one door with a cycle-forming payload and report what it did. `a` is
 * the node whose parent key the door writes (in section `s`); a loop is looked
 * for from every one of `loopWitnesses` (a birth door may leave `a` absent).
 */
async function probe(
	a: number,
	run: () => Promise<unknown>,
	loopWitnesses: readonly number[] = [a],
	s: TreeSection = PLAIN,
): Promise<DoorProbe> {
	const before = JSON.stringify(await storedLinks(s, a));
	const outcome = await settle(run());
	const after = JSON.stringify(await storedLinks(s, a));
	const detail =
		outcome.status === 'rejected'
			? `rejected: ${isDedaloError(outcome.reason) ? outcome.reason.code : String(outcome.reason)}`
			: `fulfilled: ${JSON.stringify(outcome.value ?? null).slice(0, 400)}`;
	return {
		answeredCycle: cycleCodeIn(outcome),
		cycleStored: await anyLoop(s, loopWitnesses),
		unchanged: before === after,
		detail,
	};
}

async function anyLoop(s: TreeSection, ids: readonly number[]): Promise<boolean> {
	let found = false;
	for (const id of ids) found ||= await loopsFrom(s, id);
	return found;
}

/** Whole-record Time Machine restore (tipo = the section) of a PLAIN node. */
async function applySection(id: number, matrixId: number) {
	return toolTimeMachineApplyValue({
		principal: await resolvePrincipal(ROOT_USER_ID),
		userId: ROOT_USER_ID,
		options: {
			section_tipo: PLAIN.section,
			section_id: id,
			tipo: PLAIN.section,
			lang: 'lg-nolan',
			matrix_id: matrixId,
		},
		background: false,
	} as never);
}

async function rowExists(s: TreeSection, id: number): Promise<boolean> {
	const rows = (await sql.unsafe(
		`SELECT 1 FROM "${s.table}" WHERE section_tipo = $1 AND section_id = $2`,
		[s.section, id],
	)) as unknown[];
	return rows.length === 1;
}

/** The section_id the next counter-driven create of `s` will mint. */
async function nextSectionId(s: TreeSection): Promise<number> {
	const rows = (await sql.unsafe('SELECT value FROM matrix_counter WHERE tipo = $1', [
		s.section,
	])) as { value: number }[];
	expect(rows.length, `no counter row for ${s.section}`).toBe(1);
	return Number(rows[0]?.value) + 1;
}

/** A raw parent-key value on (s, id): the gate's starting state, not the code under test. */
async function seedRawParents(
	s: TreeSection,
	id: number,
	locators: Record<string, unknown>[],
): Promise<void> {
	await assertTestDatabase('tree_cycle_race seedRawParents');
	await sql.unsafe(
		`UPDATE "${s.table}"
		    SET relation = jsonb_set(COALESCE(relation, '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[s.section, id, s.parent, JSON.stringify(locators)],
	);
}

/** A parent-link locator from a node of `from` to a node of `to` (cross-section). */
function crossLink(from: TreeSection, to: TreeSection, parent: number, itemId: number) {
	return {
		id: itemId,
		type: PARENT_LINK_TYPE,
		section_id: parent,
		section_tipo: to.section,
		from_component_tipo: from.parent,
	};
}

async function saveParent(
	id: number,
	changedData: Record<string, unknown>[],
	bulkProcessId: number | null = null,
): Promise<void> {
	const saved = await saveComponentData({
		componentTipo: PLAIN.parent,
		sectionTipo: PLAIN.section,
		sectionId: id,
		lang: 'lg-nolan',
		changedData: changedData as never,
		userId: ROOT_USER_ID,
		bulkProcessId,
	});
	expect(saved.ok, `fixture save on ${id}`).toBe(true);
}

const setParents = (ids: number[]) => [
	{
		action: 'set_data',
		id: null,
		value: ids.map((id) => ({ section_tipo: PLAIN.section, section_id: id })),
	},
];

/**
 * The history fixture for the Time Machine doors: A's parent was Q, A moved to
 * R, then Q moved under D (D under A). Restoring A's old parent Q now closes
 * A→Q→D→A. Every step is an ordinary, cycle-free save.
 */
async function history(bulkRun: number | null): Promise<{ a: number; tmRowOfQ: number }> {
	const [r, a, d, q] = await newNodes(PLAIN, 4);
	await seedLinks(PLAIN, q, [{ parent: r, itemId: 1 }]);
	await seedLinks(PLAIN, d, [{ parent: a, itemId: 1 }]);
	await saveParent(a, setParents([q]));
	const [row] = (await sql.unsafe(
		`SELECT id FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id DESC LIMIT 1`,
		[PLAIN.section, a, PLAIN.parent],
	)) as { id: number }[];
	await saveParent(a, setParents([r]), bulkRun);
	await saveParent(q, setParents([d]));
	expect(await loopsFrom(PLAIN, a)).toBe(false);
	return { a, tmRowOfQ: Number(row?.id ?? 0) };
}

/** The newest whole-record Time Machine row (tipo = the section) of a PLAIN node. */
async function newestWholeRecordRow(id: number): Promise<number> {
	const [row] = (await sql.unsafe(
		`SELECT id FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $1 ORDER BY id DESC LIMIT 1`,
		[PLAIN.section, id],
	)) as { id: number }[];
	expect(Number(row?.id ?? 0), `no whole-record row for ${id}`).toBeGreaterThan(0);
	return Number(row?.id);
}

let dispatchContext: Record<string, unknown> | null = null;

async function coreApiContext(): Promise<Record<string, unknown>> {
	if (dispatchContext === null) {
		const token = createSession(ROOT_USER_ID, 'root', true);
		const session = getSession(token);
		dispatchContext = {
			requestId: 'tree_cycle_race_native',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal: await resolvePrincipal(ROOT_USER_ID),
		};
	}
	return dispatchContext;
}

const DOORS: Record<string, () => Promise<DoorProbe>> = {
	save_engine: async () => {
		const { a, d } = await chain();
		return probe(a, () =>
			saveComponentData({
				componentTipo: PLAIN.parent,
				sectionTipo: PLAIN.section,
				sectionId: a,
				lang: 'lg-nolan',
				changedData: [
					{ action: 'insert', id: null, value: { section_tipo: PLAIN.section, section_id: d } },
				],
				userId: ROOT_USER_ID,
			}),
		);
	},
	'save_engine(set_data)': async () => {
		// The whole-key replace: rides writeKeys (the insert above rides the
		// append path, persistAppendedKeyItems).
		const { r, a, d } = await chain();
		return probe(a, () =>
			saveComponentData({
				componentTipo: PLAIN.parent,
				sectionTipo: PLAIN.section,
				sectionId: a,
				lang: 'lg-nolan',
				changedData: setParents([r, d]) as never,
				userId: ROOT_USER_ID,
			}),
		);
	},
	'dd_core_api.save': async () => {
		const { a, d } = await chain();
		const context = await coreApiContext();
		return probe(a, async () => {
			const result = await dispatchRqo(
				{
					action: 'save',
					dd_api: 'dd_core_api',
					prevent_lock: true,
					source: {
						typo: 'source',
						type: 'component',
						model: 'component_relation_parent',
						tipo: PLAIN.parent,
						section_tipo: PLAIN.section,
						section_id: String(a),
						mode: 'edit',
						lang: 'lg-nolan',
						action: null,
					},
					data: {
						section_id: String(a),
						section_tipo: PLAIN.section,
						tipo: PLAIN.parent,
						lang: 'lg-nolan',
						from_component_tipo: PLAIN.parent,
						changed_data: [
							{ action: 'insert', id: null, value: { section_tipo: PLAIN.section, section_id: d } },
						],
					},
				} as unknown as Rqo,
				context as never,
			);
			return { status: result.status, body: result.body };
		});
	},
	'mcp.fields_write': async () => {
		const { a, d } = await chain();
		const principal = await resolvePrincipal(ROOT_USER_ID);
		return probe(a, () =>
			setField(principal, {
				section_tipo: PLAIN.section,
				section_id: a,
				field: PLAIN.parent,
				value: { section_tipo: PLAIN.section, section_id: d },
			}),
		);
	},
	csv_import: async () => {
		const { a, d } = await chain();
		const mediaRoot = config.media.rootPath;
		expect(typeof mediaRoot === 'string' && mediaRoot !== '').toBe(true);
		const dir = resolve(mediaRoot ?? '', 'import/files', String(ROOT_USER_ID));
		mkdirSync(dir, { recursive: true });
		const name = 'tree_cycle_race_gate.csv';
		csvPath = join(dir, name);
		const cell = JSON.stringify([{ section_tipo: PLAIN.section, section_id: d }]).replaceAll(
			'"',
			'""',
		);
		writeFileSync(csvPath, `section_id;${PLAIN.parent}\n${a};"${cell}"\n`, 'utf8');
		const handler = csvTool.apiActions.import_files?.handler;
		expect(typeof handler).toBe('function');
		return probe(a, async () => {
			const response = (await handler?.({
				principal: await resolvePrincipal(ROOT_USER_ID),
				userId: ROOT_USER_ID,
				background: false,
				options: {
					files: [
						{
							file: name,
							section_tipo: PLAIN.section,
							bulk_process_label: 'tree_cycle_race gate',
							ar_columns_map: [
								{ model: 'component_section_id', tipo: 'section_id' },
								{
									checked: true,
									tipo: PLAIN.parent,
									map_to: PLAIN.parent,
									model: 'component_relation_parent',
								},
							],
						},
					],
				},
			} as never)) as { data?: { files?: { bulk_process_id?: number | null }[] } };
			rememberRun(response?.data?.files?.[0]?.bulk_process_id);
			return response;
		});
	},
	tool_propagate_component_data: async () => {
		const { a, d } = await chain();
		const loaded = await getLoadedTool('tool_propagate_component_data');
		const action = loaded?.module.apiActions.propagate_component_data;
		expect(action, 'the propagate action is registered').toBeDefined();
		return probe(a, async () => {
			const response = await (action as NonNullable<typeof action>).handler({
				principal: await resolvePrincipal(ROOT_USER_ID),
				userId: ROOT_USER_ID,
				background: false,
				options: {
					section_tipo: PLAIN.section,
					component_tipo: PLAIN.parent,
					action: 'replace',
					lang: 'lg-nolan',
					total: 1,
					propagate_data_value: [
						{
							type: PARENT_LINK_TYPE,
							section_id: String(d),
							section_tipo: PLAIN.section,
							from_component_tipo: PLAIN.parent,
						},
					],
					sqo: {
						section_tipo: [PLAIN.section],
						filter_by_locators: [{ section_tipo: PLAIN.section, section_id: String(a) }],
					},
				},
			} as never);
			rememberRun((response as { data?: { bulk_process_id?: unknown } }).data?.bulk_process_id);
			return response;
		});
	},
	children_write: async () => {
		const { a, d } = await chain();
		// "A becomes a child of D" — the children door writes D into A's parents.
		return probe(a, () =>
			saveComponentData({
				componentTipo: PLAIN.children,
				sectionTipo: PLAIN.section,
				sectionId: d,
				lang: 'lg-nolan',
				changedData: [
					{ action: 'insert', id: null, value: { section_tipo: PLAIN.section, section_id: a } },
				],
				userId: ROOT_USER_ID,
				principal: SUPERUSER,
			}),
		);
	},
	'dd_ts_api.update_parent_data': async () => {
		// The door's UNLOCKED fast pre-check refuses this one before its
		// transaction opens — a FAST-CHECK probe. The locked in-transaction walk
		// (moveParent) is proven by C1 (the race loser) and by
		// tree_obligations_native O4 (a refusal after a write in the transaction).
		const { r, a, d } = await chain();
		return probe(a, () => updateParentData(moveRqo(PLAIN, a, r, d), SUPERUSER));
	},
	duplicate_record: async () => {
		// R → P → X, and R holds a STALE link to the id the duplicate is about
		// to mint (a CSV/MCP save never checks that a link's target exists): the
		// clone N of X keeps X's link to P and closes N→P→R→N. The clone is a
		// BIRTH — every stored link counts as added.
		const [r, p, x] = await newNodes(PLAIN, 3);
		await seedLinks(PLAIN, p, [{ parent: r, itemId: 1 }]);
		await seedLinks(PLAIN, x, [{ parent: p, itemId: 1 }]);
		const next = await nextSectionId(PLAIN);
		await seedLinks(PLAIN, r, [{ parent: next, itemId: 1 }]);
		const result = await probe(next, () => duplicateSectionRecord(PLAIN.section, x, ROOT_USER_ID), [
			p,
			r,
			next,
		]);
		return {
			...result,
			detail: `${result.detail}; clone ${next} exists: ${await rowExists(PLAIN, next)}`,
		};
	},
	'dd_ts_api.add_child': async () => {
		// R → P, and R holds a STALE link to the id add_child is about to mint
		// (a link that outlived its record, or an import that ran ahead of the
		// counter): the new node N under P closes N→P→R→N.
		const [r, p] = await newNodes(PLAIN, 2);
		await seedLinks(PLAIN, p, [{ parent: r, itemId: 1 }]);
		const next = await nextSectionId(PLAIN);
		await seedLinks(PLAIN, r, [{ parent: next, itemId: 1 }]);
		const result = await probe(
			p,
			() =>
				addChild({ source: { section_tipo: PLAIN.section, section_id: p } } as never, SUPERUSER),
			[p, r],
		);
		return {
			...result,
			detail: `${result.detail}; node ${next} exists: ${await rowExists(PLAIN, next)}`,
		};
	},
	'tm.apply_value': async () => {
		const { a, tmRowOfQ } = await history(null);
		expect(tmRowOfQ).toBeGreaterThan(0);
		return probe(a, async () =>
			toolTimeMachineApplyValue({
				principal: await resolvePrincipal(ROOT_USER_ID),
				userId: ROOT_USER_ID,
				options: {
					section_tipo: PLAIN.section,
					section_id: a,
					tipo: PLAIN.parent,
					lang: 'lg-nolan',
					matrix_id: tmRowOfQ,
				},
				background: false,
			} as never),
		);
	},
	'tm.apply_value(section)': async () => {
		// A whole-record row whose parent is Q: A under Q is deleted, then
		// recovered — the recover writes its own whole-record row (A→Q). A then
		// moves to R and Q under D (D under A): restoring that row closes A→Q→D→A.
		const [r, a, d, q] = await newNodes(PLAIN, 4);
		await seedLinks(PLAIN, q, [{ parent: r, itemId: 1 }]);
		await saveParent(a, setParents([q]));
		await deleteSectionRecord(PLAIN.section, a, ROOT_USER_ID);
		await applySection(a, await newestWholeRecordRow(a));
		expect(await parentIds(PLAIN, a)).toEqual([q]);
		const recoverRow = await newestWholeRecordRow(a);
		await seedLinks(PLAIN, d, [{ parent: a, itemId: 1 }]);
		await saveParent(a, setParents([r]));
		await saveParent(q, setParents([d]));
		expect(await loopsFrom(PLAIN, a)).toBe(false);
		return probe(a, () => applySection(a, recoverRow));
	},
	'tm.restore_deleted': async () => {
		// A under Q is deleted (its delete row carries A→Q). A STALE link then
		// names the deleted A as Q's parent: the undelete — a BIRTH — closes
		// A→Q→A. Every stored link of a birth is an added link.
		const [r, a, q] = await newNodes(PLAIN, 3);
		await seedLinks(PLAIN, q, [{ parent: r, itemId: 1 }]);
		await saveParent(a, setParents([q]));
		await deleteSectionRecord(PLAIN.section, a, ROOT_USER_ID);
		expect(await rowExists(PLAIN, a)).toBe(false);
		const deleteRow = await newestWholeRecordRow(a);
		await seedLinks(PLAIN, q, [
			{ parent: r, itemId: 1 },
			{ parent: a, itemId: 2 },
		]);
		return probe(a, () => applySection(a, deleteRow), [a, q]);
	},
	'archive.restore': async () => {
		// A (the ONLY record of zztca1) under Q (zztca10), archived. A is then
		// gone and a STALE link names it as Q's parent: restoring A closes A→Q→A
		// across the two sections.
		const holder = ARCHIVE_TREE.ordered;
		const parents = ARCHIVE_TREE.plain;
		const [r, q] = await newNodes(parents, 2);
		const [a] = await newNodes(holder, 1);
		await seedLinks(parents, q, [{ parent: r, itemId: 1 }]);
		await seedRawParents(holder, a, [crossLink(holder, parents, q, 1)]);
		archiveDir = scratchDir('tree_cycle_archive');
		rmSync(archiveDir, { recursive: true, force: true });
		await extractArchive({ sectionTipos: [holder.section], outDir: archiveDir });
		await assertTestDatabase('tree_cycle_race archive.restore');
		await sql.unsafe(`DELETE FROM "${holder.table}" WHERE section_tipo = $1 AND section_id = $2`, [
			holder.section,
			a,
		]);
		await seedRawParents(parents, q, [
			crossLink(parents, parents, r, 1),
			crossLink(parents, holder, a, 2),
		]);
		const dir = archiveDir;
		return probe(
			a,
			() => restoreArchive({ archiveDir: dir, userId: ROOT_USER_ID, allowExternal: true }),
			[a],
			holder,
		);
	},
	'tm.bulk_revert': async () => {
		const run = await createSectionRecord('dd800', ROOT_USER_ID);
		rememberRun(run);
		const { a } = await history(run);
		return probe(a, async () => {
			const response = await toolTimeMachineBulkRevert({
				principal: await resolvePrincipal(ROOT_USER_ID),
				userId: ROOT_USER_ID,
				options: { bulk_process_id: run },
				background: false,
			} as never);
			rememberRun((response as { data?: { bulk_process_id?: unknown } }).data?.bulk_process_id);
			return response;
		});
	},
};

describe('ONT-5: every door that writes a parent key refuses a cycle (census)', () => {
	const allDoors = (): string[] =>
		[
			...Object.keys(DOORS),
			...Object.keys(RACE_DOORS).map((door) => `race.${door}`),
			...Object.keys(KEY_DOORS).map((door) => `c8.${door}`),
		].sort();

	test('KNOWN_OPEN names only real doors', () => {
		const doors = allDoors();
		for (const door of Object.keys(KNOWN_OPEN)) expect(doors).toContain(door);
	});

	test('KNOWN_OPEN is shrink-only: its size is the pinned ceiling', () => {
		expect(Object.keys(KNOWN_OPEN).length).toBe(KNOWN_OPEN_CEILING);
	});

	test('every door has ONE declared status: KNOWN_OPEN or PROVEN_CLOSED, never both', () => {
		const open = Object.keys(KNOWN_OPEN);
		expect(PROVEN_CLOSED.filter((door) => open.includes(door))).toEqual([]);
		expect([...open, ...PROVEN_CLOSED].sort()).toEqual(allDoors());
	});

	for (const [door, run] of Object.entries(DOORS)) {
		test(`C6 ${door}`, async () => {
			const result = await run();
			const reason = KNOWN_OPEN[door];
			if (reason !== undefined) {
				// Still open BY DECLARATION — and the probe really is a cycle-forming
				// write this door accepts (else the entry is stale or the probe vacuous).
				expect(
					result.cycleStored,
					`${door} is listed KNOWN_OPEN (${reason}) but no longer stores the cycle — delete its entry. ${result.detail}`,
				).toBe(true);
				return;
			}
			expect(result.answeredCycle, `${door} did not answer tree.cycle. ${result.detail}`).toBe(
				true,
			);
			expect(result.cycleStored, `${door} STORED a cycle. ${result.detail}`).toBe(false);
			expect(result.unchanged, `${door} changed the parent key while refusing`).toBe(true);
		}, 60_000);
	}
});

// ---------------------------------------------------------------------------
// C8 — the chokepoint's transaction-less fast path
// ---------------------------------------------------------------------------

/** The two key entries a caller may reach with NO ambient transaction. */
const KEY_DOORS = { persistRecordKeys, persistRestoredKeys } as const;

describe('ONT-5: a parent key is checked on the chokepoint’s fast path too', () => {
	for (const [name, door] of Object.entries(KEY_DOORS)) {
		test(`C8 ${name} with no ambient transaction: a harmless link lands, a cyclic one answers tree.cycle`, async () => {
			const { r, a, d } = await chain();
			const [g] = await newNodes(PLAIN, 1);
			const write = (ids: number[]) =>
				door(
					plainTarget(a),
					[parentKeyWrite(ids)],
					{ userId: ROOT_USER_ID },
					{ actor: ROOT_USER_ID },
				);

			// A parent key on the fast path (no observed, no indexed key) must NOT
			// be refused for wanting a transaction: the chokepoint opens its own.
			const harmless = await settle(write([r, g]));
			expect(codeOf(harmless), 'a harmless parent link was refused').toBe('fulfilled');
			expect(await parentIds(PLAIN, a)).toEqual([r, g].sort((x, y) => x - y));

			const before = await storedLinks(PLAIN, a);
			const cyclic = await settle(write([r, g, d]));
			const loopStored = await loopsFrom(PLAIN, a);
			const reason = KNOWN_OPEN[`c8.${name}`];
			if (reason !== undefined) {
				expect(
					loopStored,
					`c8.${name} is listed KNOWN_OPEN (${reason}) but no longer stores the cycle — delete its entry. ${codeOf(cyclic)}`,
				).toBe(true);
				return;
			}
			expect(loopStored, `${name} stored a cycle`).toBe(false);
			expect(codeOf(cyclic)).toBe('tree.cycle');
			expect(await storedLinks(PLAIN, a)).toEqual(before);
		}, 30_000);
	}
});

// ---------------------------------------------------------------------------
// C9 — the census is COMPLETE by derivation, not by memory
// ---------------------------------------------------------------------------

/** What a raw matrix writer does with a parent link. */
type ParentWriteClass =
	/** Doors of the census (C6 / C3b / C8 keys) that drive a write through it. */
	| { probed: readonly string[] }
	/** Why it cannot ADD a parent link (a removal, another column, another key). */
	| { no_parent_link: string }
	/** It CAN store a parent link past every check — said out loud, counted. */
	| { unchecked: string };

/**
 * EVERY unit that calls a matrix_write DML primitive (rawCallsIn over the
 * write-path corpus) or writes the matrix through psql (the closure's psql
 * seeds) — the set is DERIVED, so a new writer is RED here until it is
 * classified, and a classification of a writer that is gone is red too. With
 * sql_confinement_tripwire (matrix DML lives only in matrix_write.ts) this is
 * every way a parent key reaches the matrix: through a probed chokepoint
 * writer, or past it.
 */
const RAW_WRITERS: Readonly<Record<string, ParentWriteClass>> = {
	'src/core/section_record/record_write.ts#writeKeys': {
		probed: [
			'save_engine(set_data)',
			'dd_core_api.save',
			'mcp.fields_write',
			'csv_import',
			'tool_propagate_component_data',
			'tm.apply_value',
			'tm.bulk_revert',
			'dd_ts_api.add_child',
			'dd_ts_api.update_parent_data',
			'children_write',
			'race.save_engine',
			'race.children_write',
			'c8.persistRecordKeys',
			'c8.persistRestoredKeys',
		],
	},
	'src/core/section_record/record_write.ts#persistAppendedKeyItems': { probed: ['save_engine'] },
	'src/core/section_record/record_write.ts#persistRecordColumns': {
		probed: ['tm.apply_value(section)'],
	},
	'src/core/section_record/record_write.ts#writeBirth': { probed: ['tm.restore_deleted'] },
	'src/core/section/record/duplicate_record.ts#duplicateSectionRecord': {
		probed: ['duplicate_record'],
	},
	'src/core/archive/restore.ts#writeRecordRow': { probed: ['archive.restore'] },
	'src/core/section_record/record_write.ts#persistModifiedStamp': {
		no_parent_link: 'writes the modified stamps (dd197 user locator, dd201 date) only',
	},
	'src/core/section/record/delete_record.ts#deleteSectionRecord': {
		no_parent_link:
			'deletes the row; the holders it rewrites ride persistRecordKeys with links REMOVED — a removal closes no loop',
	},
	'src/core/section/record/record_metadata.ts#setRecordMetadata': {
		no_parent_link: 'writes the `data` metadata column, no component key',
	},
	'src/core/media/tools/files_info_persist.ts#writeItems': {
		no_parent_link: 'writes a media key’s files_info (technical metadata)',
	},
	'src/core/relations/save.ts#removeDataframeDataById': {
		no_parent_link: 'strips dataframe frames of a removed main item — a removal',
	},
	'src/core/relations/dataframe.ts#fixDataframeOrphanEntries': {
		no_parent_link: 'removes orphan dataframe frames — a removal',
	},
	'src/core/tools/register.ts#writeRegistryRecord': {
		no_parent_link: 'writes a tool registry record (dd1324): name, flags, properties',
	},
	'src/core/install/hierarchy_activate.ts#createRegistryRow': {
		no_parent_link:
			'writes the hierarchy registry keys it names (tld, term, typology, lang, sections)',
	},
	'src/core/ontology/hierarchy_state.ts#write': {
		no_parent_link:
			'the HIERARCHY INVARIANT writer: registry keys (active, general term, sections)',
	},
	'src/core/ontology/hierarchy_state.ts#nameRootTerm': {
		no_parent_link: 'writes a root term record’s TERM (string) key',
	},
	'src/core/retention/prune.ts#registerRetentionCatalog': {
		no_parent_link: 'prunes event rows by age — a delete',
	},
	'scripts/repair_geolocation_studio_default.ts#repairUnit': {
		no_parent_link: 'rewrites a geolocation key',
	},
	'src/core/install/root_pw.ts#setRootPassword': {
		no_parent_link: 'writes the root user’s password key',
	},
	'src/core/ontology/data_io_import.ts#consolidateSectionCounter': {
		no_parent_link: 'raises a section counter row',
	},
	'src/core/ontology/data_io_import.ts#normalizeOntologyTld': {
		no_parent_link: 'stamps the ontology7 TLD (string) key',
	},
	'src/core/section/record/create_record.ts#createSectionRecord': {
		unchecked:
			'the birth INSERT stores the ontology’s properties.dato_default unchecked — a dato_default on a component_relation_parent (none is declared, 2026-10-11) would land without a cycle check',
	},
	'src/core/ontology/hierarchy_provision.ts#provisionVirtualSections': {
		unchecked:
			'install-time provisioning writes the `<tld>0` descriptor’s ontology parent link (to its typology grouper) unchecked',
	},
	'src/core/ontology/ontology_write.ts#writeOntologyMainKey': {
		unchecked: 'install-time ontology definition rows (matrix_ontology_main), stored unchecked',
	},
	'src/core/ontology/ontology_write.ts#createParentGrouper': {
		unchecked: 'install-time typology grouper rows with their parent link, stored unchecked',
	},
	'src/core/update/transform/portalize.ts#applyPortalizeRow': {
		unchecked:
			'an update transform copies mapped component data verbatim into a new record — a mapping onto a component_relation_parent is stored unchecked',
	},
	'src/core/install/hierarchy_import.ts#runImportUnit': {
		unchecked: 'a release thesaurus imported by psql \\copy — whole rows, links unchecked',
	},
	'src/core/ontology/data_io_import.ts#importFromCopyFile': {
		unchecked: 'an ontology import by psql \\copy — whole rows, links unchecked',
	},
};

/** The pinned number of `unchecked` writers. Lowering it is the closure of one; raising it needs its reason above. */
const UNCHECKED_CEILING = 7;

/** Suite fixture builders: every one refuses a database without the dedalo_test_marker row. */
const TEST_DATA_PREFIX = 'src/core/test_data/';

describe('ONT-5: the door census is complete by derivation (C9)', () => {
	const derived = (): string[] => {
		const corpusCode = (rel: string): string =>
			stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
		const keys = new Set<string>();
		for (const file of writePathSourceFiles()) {
			if (file === MATRIX_WRITE || file.startsWith(TEST_DATA_PREFIX)) continue;
			for (const call of rawCallsIn(file, corpusCode(file))) keys.add(call.key);
		}
		for (const seed of buildWriterClosure().psqlSeeds) {
			if (!seed.startsWith(TEST_DATA_PREFIX)) keys.add(seed);
		}
		return [...keys].sort();
	};

	test('C9 every raw matrix writer is classified, and every classified writer exists', () => {
		const found = derived();
		const classified = Object.keys(RAW_WRITERS).sort();
		expect(
			found.filter((key) => !classified.includes(key)),
			'a raw matrix writer the census does not classify — probe it in DOORS, or say why it adds no parent link',
		).toEqual([]);
		expect(
			classified.filter((key) => !found.includes(key)),
			'a classified writer that no longer writes the matrix — delete its entry',
		).toEqual([]);
	});

	test('C9 every probed writer names real census doors; the unchecked count is pinned', () => {
		const doors = [
			...Object.keys(DOORS),
			...Object.keys(RACE_DOORS).map((door) => `race.${door}`),
			...Object.keys(KEY_DOORS).map((door) => `c8.${door}`),
		];
		const unchecked: string[] = [];
		for (const [key, entry] of Object.entries(RAW_WRITERS)) {
			if ('probed' in entry) {
				expect(entry.probed.length, `${key}: a probed writer with no door`).toBeGreaterThan(0);
				for (const door of entry.probed) expect(doors, `${key}`).toContain(door);
			}
			if ('unchecked' in entry) unchecked.push(key);
		}
		expect(unchecked.length).toBe(UNCHECKED_CEILING);
		// Every census door is reached through some classified writer.
		const reached = new Set(
			Object.values(RAW_WRITERS).flatMap((entry) => ('probed' in entry ? entry.probed : [])),
		);
		expect(doors.filter((door) => !reached.has(door)).sort()).toEqual([]);
	});
});
