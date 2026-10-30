/**
 * EVERY MAINTENANCE DOOR DECLARES ITS PRECONDITION CLASS, AND THE DESTRUCTIVE
 * ONES REFUSE BEFORE THEY ACT (update audit 2026-10-29, design §3.4, Phase 2.8;
 * U-15, U-42) — src/core/update/door_class.ts, enforced by the widget
 * dispatcher (area_maintenance/widgets/registry.ts).
 *
 *  1. TOTALITY: the class table equals every registrable door (ALL_WIDGET_MODULES,
 *     the conditional ones included) — a new door
 *     without a class is red here (and refused at runtime), a stale entry too.
 *  2. OUTCOME through the real dispatcher: every destructive_shared door (as an
 *     execute, not a dry run) refuses a global admin who is not the superuser,
 *     and refuses the superuser outside maintenance mode — the refusal NAMES THE
 *     DOOR (coordinates.door), so it provably came from the dispatcher's gate and
 *     not from a handler's own check; an update_run door refuses a non-superuser
 *     there too, before the run fetches, locks or journals anything.
 *     A dry run of a move_* door is NOT refused for want of maintenance.
 *  3. The destructive rules' remaining legs through seams: an update run in
 *     flight, the backup (or its logged waiver), the lock held while the door
 *     runs and released after, a job door's lock left to its job.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ALL_WIDGET_MODULES,
	dispatchWidgetRequest,
} from '../../src/core/area_maintenance/widgets/registry.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getServerState, setServerState } from '../../src/core/resolve/server_state.ts';
import { type Principal, SUPERUSER_ID } from '../../src/core/security/permissions.ts';
import {
	DOOR_CLASSES,
	doorClassOf,
	enterDestructiveDoor,
	enterDoor,
	holdUpdateRunLock,
} from '../../src/core/update/door_class.ts';
import { createRunJournal, writeRunJournal } from '../../src/core/update/run/journal.ts';

const ADMIN = { userId: 4242, isGlobalAdmin: true, isDeveloper: false } as Principal;
const SUPERUSER = { userId: SUPERUSER_ID, isGlobalAdmin: true, isDeveloper: true } as Principal;

const roots: string[] = [];
let maintenanceBefore = false;
beforeAll(() => {
	maintenanceBefore = getServerState().maintenance_mode === true;
});
afterAll(() => {
	setServerState({ maintenance_mode: maintenanceBefore });
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Every door ANY install can expose (serve_code / error_reports register only where they act). */
function liveDoors(): string[] {
	return ALL_WIDGET_MODULES.flatMap((module) =>
		Object.keys(module.apiActions ?? {}).map((action) => `${module.spec.id}.${action}`),
	).sort();
}

/** The refusal's code AND the door it names — proof it came from the dispatcher's gate, not a handler's own check. */
async function refusalOf(promise: Promise<unknown>): Promise<string | null> {
	try {
		await promise;
	} catch (error) {
		if (!isDedaloError(error)) return String(error);
		return `${error.code} @ ${String(error.coordinates?.door ?? '(no door)')}`;
	}
	return null;
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
	try {
		await promise;
	} catch (error) {
		return isDedaloError(error) ? error.code : String(error);
	}
	return null;
}

const destructive = Object.entries(DOOR_CLASSES)
	.filter(([, declared]) => declared.class === 'destructive_shared')
	.map(([what]) => what);

/** The request that makes a door an EXECUTE (a move_* door is a dry run unless told). */
const executeOf = (what: string) =>
	DOOR_CLASSES[what]?.dryRun === undefined
		? {}
		: { [DOOR_CLASSES[what]?.dryRun?.option as string]: false };

describe('1. totality', () => {
	test('the class table equals the live registry, both ways', () => {
		expect(Object.keys(DOOR_CLASSES).sort()).toEqual(liveDoors());
	});

	test('the design’s destructive doors are destructive_shared (§3.4)', () => {
		expect(destructive.length).toBeGreaterThanOrEqual(8);
		for (const what of [
			'move_tld.move_tld',
			'add_hierarchy.reset_hierarchies',
			'update_data_version.update_data_version',
			'update_code.restore_code',
		]) {
			expect(DOOR_CLASSES[what]?.class).toBe('destructive_shared');
		}
		for (const what of ['update_code.update_code', 'update_ontology.update_ontology']) {
			expect(DOOR_CLASSES[what]?.class).toBe('update_run');
		}
	});

	test('a release build is the superuser’s alone (U-25), in or out of maintenance', async () => {
		expect(DOOR_CLASSES['serve_code.build_version_from_git_master']?.class).toBe('release_build');
		expect(await codeOf(enterDoor('serve_code.build_version_from_git_master', ADMIN, {}))).toBe(
			'perm.superuser_required',
		);
		setServerState({ maintenance_mode: false });
		const release = await enterDoor('serve_code.build_version_from_git_master', SUPERUSER, {});
		await release();
	});

	test('a door that starts an update run refuses a non-superuser AT THE DOOR — before any manifest fetch, lock or journal', async () => {
		const runDoors = Object.entries(DOOR_CLASSES)
			.filter(([, declared]) => declared.class === 'update_run')
			.map(([what]) => what);
		expect(runDoors.length).toBeGreaterThanOrEqual(2);
		for (const what of runDoors) {
			const [model, action] = what.split('.') as [string, string];
			expect(await refusalOf(dispatchWidgetRequest(ADMIN, { model, action }, {}))).toBe(
				`perm.superuser_required @ ${what}`,
			);
		}
	});

	test('an unclassified door is refused at runtime', async () => {
		expect(await codeOf(enterDoor('nowhere.nothing', SUPERUSER, {}))).toBe('internal.invariant');
	});
});

describe('2. destructive doors refuse before they act — through the real dispatcher', () => {
	test.each(destructive)(
		'%s: a non-superuser admin is refused; the superuser outside maintenance is refused',
		async (what) => {
			const [model, action] = what.split('.') as [string, string];
			setServerState({ maintenance_mode: false });
			expect(
				await refusalOf(dispatchWidgetRequest(ADMIN, { model, action }, executeOf(what))),
			).toBe(`perm.superuser_required @ ${what}`);
			expect(
				await refusalOf(dispatchWidgetRequest(SUPERUSER, { model, action }, executeOf(what))),
			).toBe(`maintenance.mode_required @ ${what}`);
		},
	);

	test('a dry run of a move_* door is a rehearsal (reversible_admin): no maintenance demanded', () => {
		expect(doorClassOf('move_tld.move_tld', {})).toBe('reversible_admin');
		expect(doorClassOf('move_tld.move_tld', { dry_run: true })).toBe('reversible_admin');
		expect(doorClassOf('move_tld.move_tld', { dry_run: false })).toBe('destructive_shared');
	});
});

describe('3. the remaining legs, through seams', () => {
	const lockSpy = () => {
		const state = { held: false, released: 0 };
		const acquire = async () => {
			if (state.held) return null;
			state.held = true;
			return {
				release: async () => {
					state.held = false;
					state.released++;
				},
			};
		};
		return { state, acquire };
	};
	const scratchRoot = () => {
		const root = mkdtempSync(join(tmpdir(), 'dedalo_door_class_'));
		roots.push(root);
		return root;
	};

	test('an update run in flight refuses; the backup is required unless waived (and the waiver is logged)', async () => {
		setServerState({ maintenance_mode: true });
		const root = scratchRoot();
		await writeRunJournal(
			root,
			createRunJournal({
				from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
				to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
				plan: [],
			}),
		);
		const lock = lockSpy();
		const ok = async () => {};
		expect(
			await codeOf(
				enterDestructiveDoor(
					'add_hierarchy.reset_hierarchies',
					SUPERUSER,
					{},
					{ runsRoot: root, requireBackup: ok, acquire: lock.acquire },
				),
			),
		).toBe('update.refused');
		const clean = scratchRoot();
		const noBackup = async () => {
			throw new Error('planted: no backup');
		};
		expect(
			await codeOf(
				enterDestructiveDoor(
					'add_hierarchy.reset_hierarchies',
					SUPERUSER,
					{},
					{ runsRoot: clean, requireBackup: noBackup, acquire: lock.acquire },
				),
			),
		).toBe('Error: planted: no backup');
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		const release = await enterDestructiveDoor(
			'add_hierarchy.reset_hierarchies',
			SUPERUSER,
			{ waive_backup: true },
			{ runsRoot: clean, requireBackup: noBackup, acquire: lock.acquire },
		);
		expect(warn.mock.calls.flat().join(' ')).toContain(`WAIVED by user ${SUPERUSER_ID}`);
		warn.mockRestore();
		await release();
	});

	test('the lock: held while a door runs, refused to a second door, released after; a job door leaves it to its job', async () => {
		setServerState({ maintenance_mode: true });
		const root = scratchRoot();
		const lock = lockSpy();
		const deps = { runsRoot: root, requireBackup: async () => {}, acquire: lock.acquire };
		const release = await enterDestructiveDoor(
			'add_hierarchy.reset_hierarchies',
			SUPERUSER,
			{},
			deps,
		);
		expect(lock.state.held).toBe(true);
		expect(
			await codeOf(enterDestructiveDoor('add_hierarchy.reset_hierarchies', SUPERUSER, {}, deps)),
		).toBe('update.refused');
		await release();
		expect(lock.state.held).toBe(false);
		await enterDestructiveDoor('move_tld.move_tld', SUPERUSER, { dry_run: false }, deps);
		expect(lock.state.held).toBe(false);
		await enterDestructiveDoor(
			'update_data_version.update_data_version',
			SUPERUSER,
			{ background_running: true },
			deps,
		);
		expect(lock.state.held).toBe(false);
		const syncRung = await enterDestructiveDoor(
			'update_data_version.update_data_version',
			SUPERUSER,
			{},
			deps,
		);
		expect(lock.state.held).toBe(true);
		await syncRung();
	});

	test('a job holds the lock for its life and is refused while another holds it', async () => {
		const lock = lockSpy();
		const root = scratchRoot();
		let inside = false;
		await holdUpdateRunLock(
			'job',
			async () => {
				inside = lock.state.held;
				expect(await codeOf(holdUpdateRunLock('second', async () => {}, lock.acquire, root))).toBe(
					'update.refused',
				);
			},
			lock.acquire,
			root,
		);
		expect(inside).toBe(true);
		expect(lock.state.held).toBe(false);
	});

	test('#9: a job that gets the FREE lock in a run’s restart window is still refused by the journal; the lock is released', async () => {
		const lock = lockSpy();
		const root = scratchRoot();
		await writeRunJournal(
			root,
			createRunJournal({
				from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
				to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
				plan: [],
			}),
		);
		let ran = false;
		const refusal = await holdUpdateRunLock(
			'job',
			async () => {
				ran = true;
			},
			lock.acquire,
			root,
		).catch((error: unknown) => error);
		expect(isDedaloError(refusal) && refusal.coordinates?.rule).toBe('run_in_flight');
		expect(ran).toBe(false);
		expect(lock.state.held).toBe(false);
	});
});
