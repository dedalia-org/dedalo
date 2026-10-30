/**
 * THE BOOT FACTS WHERE THEY ARE SERVED — /health through the REAL route
 * (server.ts handleRequest), not the pure builder (update audit 2026-10-29,
 * U-01 / U-04).
 *
 * health_payload_native pins buildHealthPayload with facts it is handed. What
 * it cannot see is the WIRING: the route reading boot_state (bootSchemaStateName /
 * bootSchemaMoved / dataVersionState) and turning a red payload into a 503. Drop
 * any of those lines in server.ts and a failed migration run, or a database newer
 * than the code, serves a green probe — the watchdog confirms the update and
 * disarms every rollback. Each case below reds on exactly one such deletion.
 *
 * Reads only: the route's DB ping against the suite database. The boot state is
 * process-global by design, so every case resets it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { BootSchemaVerdict } from '../../install/db/migrate.ts';
import {
	recordBootSchemaVerdict,
	recordUpdateRunFacts,
	refreshDataVersionState,
	resetBootStateForTest,
} from '../../src/core/update/boot_state.ts';
import { DEDALO_ENGINE_VERSION } from '../../src/core/update/build_stamp.ts';
import { DEDALO_DATA_VERSION } from '../../src/core/update/version.ts';
import { createRequestContext, handleRequest } from '../../src/server.ts';

const OK_VERDICT: BootSchemaVerdict = {
	state: 'ok',
	applied: [],
	deferred: [],
	schemaMoved: false,
	error: null,
};

async function health(): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await handleRequest(
		new Request('http://localhost/health'),
		createRequestContext(),
	);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A data version strictly BELOW the code's (the "Update data is due" state). */
function pendingVersion(): number[] {
	const [major = 0, minor = 0, patch = 0] = DEDALO_DATA_VERSION;
	if (patch > 0) return [major, minor, patch - 1];
	if (minor > 0) return [major, minor - 1, 99];
	return [major - 1, 99, 99];
}

afterEach(() => {
	resetBootStateForTest();
});

describe('/health serves the boot facts (U-01 / U-04)', () => {
	test('control: an ok schema verdict and a current data version → 200 ok', async () => {
		recordBootSchemaVerdict(OK_VERDICT);
		await refreshDataVersionState(async () => [...DEDALO_DATA_VERSION]);
		const { status, body } = await health();
		expect(status).toBe(200);
		expect(body.result).toBe('ok');
		expect(body.boot_schema).toBe('ok');
		expect('boot_schema_moved' in body).toBe(false);
		expect((body.data_version as { state: string }).state).toBe('ok');
	});

	test('a FAILED boot schema run → 503, boot_schema failed, boot_schema_moved served', async () => {
		recordBootSchemaVerdict({
			state: 'failed',
			applied: [],
			deferred: [],
			schemaMoved: true,
			error: 'x',
		});
		const { status, body } = await health();
		expect(status).toBe(503);
		expect(body.result).toBe('error');
		expect(body.boot_schema).toBe('failed');
		expect(body.boot_schema_moved).toBe(true);
	});

	test('a database AHEAD of the code → 503, data_version.state ahead', async () => {
		recordBootSchemaVerdict(OK_VERDICT);
		await refreshDataVersionState(async () => [99, 0, 0]);
		const { status, body } = await health();
		expect(status).toBe(503);
		expect(body.result).toBe('error');
		expect(body.boot_schema).toBe('ok');
		// The anonymous wire carries the STATE only (the watchdog's `ahead`); the
		// version pair is the operator's (`bun run update status`), not a caller's.
		expect(body.data_version).toEqual({ state: 'ahead' });
	});

	test('a PENDING data update is reported, not red → 200, data_version.state pending', async () => {
		recordBootSchemaVerdict(OK_VERDICT);
		await refreshDataVersionState(async () => pendingVersion());
		const { status, body } = await health();
		expect(status).toBe(200);
		expect(body.result).toBe('ok');
		expect(body.data_version).toEqual({ state: 'pending' });
	});

	test('no boot run recorded (smoke boot / reset) → boot_schema skipped, no data_version key', async () => {
		const { status, body } = await health();
		expect(status).toBe(200);
		expect(body.boot_schema).toBe('skipped');
		expect('data_version' in body).toBe(false);
	});
});

describe('/health serves the update run (design §3.5)', () => {
	const run = (state: string, onTarget: boolean) => ({
		run_id: 'r1',
		state,
		target: DEDALO_ENGINE_VERSION,
		owns_boot: true,
		on_target: onTarget,
	});

	test('a run applying the schema: boot_schema skipped + data pending is NOT red, update_run served', async () => {
		recordUpdateRunFacts(run('CODE_SWAPPED', true));
		await refreshDataVersionState(async () => pendingVersion());
		const { status, body } = await health();
		expect(status).toBe(200);
		expect(body.boot_schema).toBe('skipped');
		// The state only — the panel's run_progress reads nothing else; run id,
		// target and owns_boot/on_target stay off the anonymous wire (review #17).
		expect(body.update_run).toEqual({ state: 'CODE_SWAPPED' });
	});

	test('an ORDERED code rollback on the target tree is red — the supervisor puts the old tree back', async () => {
		recordUpdateRunFacts(run('ROLLED_BACK_CODE', true));
		const { status, body } = await health();
		expect(status).toBe(503);
		expect(body.result).toBe('error');
	});

	test('…and green again once the previous tree runs (not on the target tree)', async () => {
		recordUpdateRunFacts(run('ROLLED_BACK_CODE', false));
		expect((await health()).status).toBe(200);
	});
});
