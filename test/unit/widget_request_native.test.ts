/**
 * Maintenance widget_request — TS-NATIVE half, the DEC-14b survival twin of
 * test/parity/widget_request_differential.test.ts (that gate's PHP-vs-TS
 * comparisons die with the oracle; the contracts it pinned equal to live PHP
 * survive HERE, asserted against the TS engine alone, through the same
 * dispatchRqo door).
 *
 * Re-expressed contracts:
 *  - dispatch gates — non-admin 'unauthorized', unknown widget ('Invalid
 *    widget name'), unregistered method ('unauthorized_method'), and the
 *    database_info.get_value allowlist denial (widget_request must NOT reach
 *    a panel-only getValue) — the differential's envelope pins verbatim;
 *  - counters_status.get_value — envelope msg + the datalist item shape
 *    {section_tipo,label,counter_value,last_section_id}. The differential
 *    byte-compared the FULL list against PHP over the SHARED mutable
 *    matrix_counter, so the native half asserts the pinned per-item shape and
 *    per-row consistency with the live counter/MAX instead of full bytes.
 *    The non-section counter row error message is pinned from PHP source
 *    (core/common/class.counter.php:415) on a synthetic test52 counter row;
 *  - database_info get_widget_value (compute) — the tables/indexes catalog
 *    read shape: pg_indexes row anatomy {schemaname,tablename,indexname,
 *    index_size,indexdef}, membership anchors, pg_size_pretty format +
 *    size-DESC ordering, and the differential-pinned engine-native
 *    info.server containing 'PostgreSQL';
 *  - counters_status.modify_counter — the CURRENT contract
 *    (WC-2026-08-30-section-id-counter-is-a-high-water-mark, P0-14; the PHP
 *    path is a pinned live defect there: every well-formed request dies on
 *    'empty mandatory section_tipo'): `fix` RAISES a counter that lags its
 *    data and leaves a counter ahead of its data untouched (drift is injected
 *    DOWNWARD so the raise is observable, then UPWARD to prove the refusal to
 *    lower; the counter state is restored UNCONDITIONALLY in afterAll), and
 *    `reset` is REFUSED with the counter row left standing (synthetic zztc2
 *    row, removed in finally, fail-loud). Until 2026-08-30 these asserted the
 *    PHP semantics — consolidate-DOWN and delete — which is precisely how a
 *    deleted record's section_id came to be re-minted;
 *  - database_info.rebuild_user_stats — the differential's exact synthetic
 *    provisioning (user 424252 here, 2 days of activity incl. a dd1223
 *    publish event and a skipped dd271 'where'). The dd1521 aggregate rows
 *    were byte-compared PHP↔TS there, so their content HERE is pinned from
 *    the PHP algorithm (class.diffusion_section_stats.php: the what-code→term
 *    map, the where-skip set, dd1223→publish routing, the hour histogram,
 *    save_user_activity's row anatomy incl. the virtual-calendar `time`).
 *
 * SOFTENED / TS-side notes (never oracle-pinned by the differential):
 *  - ontology term labels (counters datalist `label`, stats what-item
 *    `label`) are shared MUTABLE ontology values — asserted AS the term for
 *    that tipo via termByTipo, never as literal strings;
 *  - datalist ordering (DB collation vs JS string order) is not re-asserted;
 *  - the refreshed datalist modify_counter attaches comes from PHP source
 *    (class.counters_status.php:150-160 — PHP's own modify_counter dies
 *    before reaching it); the reset REFUSAL is TS-only by construction;
 *  - the database_info panel envelope msg is the TS widget's (the
 *    differential only compared result.tables/indexes/info).
 *
 * NOT re-expressed here (owned elsewhere / oracle-only): make_backup
 * (ops_backup.test.ts), register_tools (register_tools_widget.test.ts),
 * error_reports (error_reports_widget.test.ts), dataframe_control run_fix
 * (ws_a_write_path.test.ts §S2-06 + the sibling dataframe gates),
 * analyze_db / consolidate_tables / optimize_tables / rebuild_db_* /
 * unit_test / export_hierarchy / update_data_version / move_* / media panels
 * (shared-DB byte parity or covered by their own native gates).
 *
 * Scratch hygiene: one fresh test3 record (counter materialization), one
 * synthetic test52 + one zztc2 matrix_counter row, synthetic matrix_activity
 * rows + the dd1521 aggregates they produce — all swept fail-loud.
 *
 * @twin-of      test/parity/widget_request_differential.test.ts
 * @twin-status  retired
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). Install tipos
// were replaced by their twins from src/core/test_data/test_tld_tipo_map.json.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { virtualDateSeconds } from '../../src/core/area_maintenance/user_stats.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { termByTipo } from '../../src/core/ontology/labels.ts';
import { currentApplicationLang } from '../../src/core/resolve/request_lang.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const WIDGET_RQO = {
	action: 'widget_request',
	dd_api: 'dd_area_maintenance_api',
	prevent_lock: true,
	options: {},
	source: { typo: 'source', model: 'counters_status', action: 'get_value' },
};

/** The differential's tsCall — the SAME dispatchRqo door, root or non-admin. */
async function tsCall(
	rqo: Record<string, unknown>,
	admin = true,
): Promise<Record<string, unknown>> {
	const token = admin ? createSession(-1, 'root', true) : createSession(999999, 'nobody', false);
	const session = getSession(token);
	const principal = await resolvePrincipal(admin ? -1 : 999999);
	const result = await dispatchRqo(
		structuredClone(rqo) as never,
		{
			requestId: 'widget_native_test',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal,
		} as never,
	);
	return result.body;
}

// Envelope v2 (ERRORS_SPEC §3): the machine channel is `error.code`, and it is
// the ONLY one — the compat mirror (`result`/`msg`/`errors:[code]`) was removed
// on 2026-08-16. Legacy tokens map through LEGACY_TOKEN_MAP (unauthorized →
// perm.denied, unauthorized_method → tool.method_not_allowed); the widget-name
// refusal rides the transitional adapter's status default (request.invalid)
// until the maintenance sweep codes it.
describe('widget_request dispatch gates (envelope v2)', () => {
	test('non-admin is refused with perm.denied', async () => {
		const nonAdmin = await tsCall(WIDGET_RQO, false);
		expect(nonAdmin.ok).toBe(false);
		expect((nonAdmin.error as { code: string }).code).toBe('perm.denied');
		// One machine channel: the retired mirror is not on the failure body.
		expect('result' in nonAdmin).toBe(false);
		expect(nonAdmin.errors).toBeUndefined();
	});

	test('unknown widget id is refused (caller fault)', async () => {
		const badWidget = await tsCall({
			...WIDGET_RQO,
			source: { typo: 'source', model: 'not_a_widget', action: 'get_value' },
		});
		expect(badWidget.ok).toBe(false);
		expect((badWidget.error as { code: string; category: string }).category).toBe('caller');
	});

	test('unregistered method is refused with tool.method_not_allowed', async () => {
		const badMethod = await tsCall({
			...WIDGET_RQO,
			source: { typo: 'source', model: 'counters_status', action: 'drop_everything' },
		});
		expect((badMethod.error as { code: string }).code).toBe('tool.method_not_allowed');
	});

	test('widget_request DENIES database_info.get_value (panel-only allowlist)', async () => {
		const denied = await tsCall({
			...WIDGET_RQO,
			source: { typo: 'source', model: 'database_info', action: 'get_value' },
		});
		expect(denied.ok).toBe(false);
		expect((denied.error as { code: string }).code).toBe('tool.method_not_allowed');
	});
});

describe('counters_status.get_value (datalist shape + audit consistency)', () => {
	test('datalist item shape, live consistency, non-section row error', async () => {
		let removed: unknown[] = [];
		// synthetic NON-SECTION counter row: test52 is a component_input_text
		// tipo — the audit must report it in errors and keep it OFF the datalist
		// (message pinned from PHP core/common/class.counter.php:415).
		await sql.unsafe(
			`INSERT INTO matrix_counter (tipo, value, ref) VALUES ('test52', 7, 'synthetic native gate row')`,
			[],
		);
		try {
			// live anchors read independently right before the audit call
			const counterRows = (await sql.unsafe(
				`SELECT value FROM matrix_counter WHERE tipo = 'test3'`,
				[],
			)) as { value: number | string }[];
			const maxRows = (await sql.unsafe(
				`SELECT COALESCE(MAX(section_id), 0) AS max FROM matrix_test WHERE section_tipo = 'test3'`,
				[],
			)) as { max: number | string }[];

			const body = await tsCall(WIDGET_RQO);
			// envelope v2: a plain OK carries no `msg` extension key (the
			// boilerplate sentence is dropped by the P1 sweep).
			expect(body.msg).toBeUndefined();
			const result = body.data as { datalist?: Record<string, unknown>[]; errors?: string[] };

			// every item carries EXACTLY the differential-pinned key set.
			//
			// FOLDED, NOT PER-ROW: this list is the INSTALLATION's counters, so a
			// per-row `expect` makes the file's assertion COUNT a function of how
			// many sections the suite database happens to hold — and the count is
			// the per-file floor the assertion ratchet reads. It moved three times
			// during this audit's closure (3603 → 3579 → 3571 → 3515) with nothing
			// wrong, which is a ratchet measuring the fixture instead of the code.
			// The rule below is the same rule, asserted once over every row, and
			// names the first offender when it breaks.
			expect((result.datalist?.length ?? 0) > 0).toBe(true);
			const EXPECTED_KEYS = [
				'bulk_repair_excluded',
				'counter_value',
				'floor_value',
				'label',
				'last_section_id',
				'section_tipo',
			];
			// `floor_value` is ADDED to the differential-pinned key set
			// (WC-2026-08-30-section-id-counter-is-a-high-water-mark): the client
			// measures drift against the section's high-water mark, not against
			// MAX(live section_id), which reports an already-damaged install as
			// healthy. The floor is never below live MAX — it is live MAX widened
			// by the time-machine witness of deleted records.
			const badRow = (result.datalist ?? []).find(
				(item) =>
					JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(EXPECTED_KEYS) ||
					typeof item.section_tipo !== 'string' ||
					typeof item.counter_value !== 'number' ||
					typeof item.last_section_id !== 'number' ||
					typeof item.floor_value !== 'number' ||
					typeof item.bulk_repair_excluded !== 'boolean' ||
					Number(item.floor_value) < Number(item.last_section_id) ||
					!(item.label === null || typeof item.label === 'string'),
			);
			expect(badRow, `counter audit row breaks the pinned shape: ${JSON.stringify(badRow)}`).toBe(
				undefined,
			);

			// the test3 audit row agrees with the live counter + MAX(section_id)
			const test3 = (result.datalist ?? []).find((item) => item.section_tipo === 'test3');
			expect(test3).toBeDefined();
			if (counterRows.length > 0) {
				expect(test3?.counter_value).toBe(Number(counterRows[0]?.value));
			}
			expect(test3?.last_section_id).toBe(Number(maxRows[0]?.max));
			// label is the shared ontology term (mutable — asserted AS the term)
			expect(test3?.label).toBe((await termByTipo('test3', 'lg-spa')) as never);

			// the synthetic non-section row: pinned error message, off the datalist
			expect(result.errors).toContain(
				"Counter row with tipo: 'test52' is a 'component_input_text' . Only sections can use counters. Fix ASAP",
			);
			expect((result.datalist ?? []).some((item) => item.section_tipo === 'test52')).toBe(false);
			expect(body.errors).toBeUndefined(); // envelope v2: no errors key on success
		} finally {
			removed = (await sql.unsafe(
				`DELETE FROM matrix_counter WHERE tipo = 'test52' RETURNING tipo`,
				[],
			)) as unknown[];
		}
		// fail-loud tracked cleanup (outside finally so it never masks the
		// original assertion error — the DELETE itself already ran)
		expect(removed.length).toBe(1);
	}, 60000);
});

/** pg_size_pretty → bytes (for the size-DESC ordering assertion). */
function prettyToBytes(pretty: string): number {
	const match = /^(\d+(?:\.\d+)?) (bytes|kB|MB|GB|TB|PB)$/.exec(pretty);
	if (match === null) throw new Error(`not a pg_size_pretty value: ${pretty}`);
	const unit = { bytes: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 }[
		match[2] as 'bytes'
	];
	return Number(match[1]) * unit;
}

describe('database_info compute (get_widget_value catalog read)', () => {
	test('tables + per-table indexes shape; info.server is PostgreSQL', async () => {
		const body = await tsCall({
			action: 'get_widget_value',
			dd_api: 'dd_area_maintenance_api',
			prevent_lock: true,
			options: {},
			source: { typo: 'source', model: 'database_info' },
		});
		const result = body.data as {
			tables?: string[];
			indexes?: Record<string, Record<string, unknown>[]>;
			info?: { server?: unknown; host?: unknown };
			statistics?: {
				status?: string;
				tables?: number;
				never_analyzed?: number;
				counters_reset?: number;
				worst?: unknown;
				detail?: unknown;
			} | null;
		};

		// tables: the public-schema catalog — the shared-install anchors present
		expect(Array.isArray(result.tables)).toBe(true);
		for (const anchor of [
			'matrix',
			'matrix_test',
			'matrix_counter',
			'matrix_activity',
			'matrix_stats',
			'matrix_time_machine',
			'dd_ontology',
		]) {
			expect(result.tables).toContain(anchor);
		}

		// indexes: keyed by table (⊆ tables), each row the pinned pg_indexes
		// anatomy, pg_size_pretty format, size-DESC order within the table
		const indexes = result.indexes ?? {};
		expect(Object.keys(indexes).length > 0).toBe(true);
		expect(indexes.matrix_test).toBeDefined();
		// FOLDED, NOT PER-ROW — same reason as the counter audit above: this walks
		// every index of every table the INSTALLATION has, so a per-row `expect`
		// makes this file's assertion count a property of the database rather than
		// of the code, and the assertion ratchet then measures the fixture. The
		// rule is unchanged and reported with the offending row.
		const indexFault = (() => {
			for (const [table, rows] of Object.entries(indexes)) {
				if (!(result.tables as string[]).includes(table)) return `table not listed: ${table}`;
				if (rows.length === 0) return `no index rows for ${table}`;
				let previousBytes = Number.POSITIVE_INFINITY;
				for (const row of rows) {
					const keys = JSON.stringify(Object.keys(row).sort());
					if (keys !== '["index_size","indexdef","indexname","schemaname","tablename"]') {
						return `row shape ${keys} on ${table}`;
					}
					if (row.schemaname !== 'public') return `schema ${row.schemaname} on ${table}`;
					if (row.tablename !== table) return `row names ${row.tablename} under ${table}`;
					if (typeof row.indexname !== 'string') return `indexname not a string on ${table}`;
					if (!String(row.indexdef).startsWith('CREATE ')) {
						return `indexdef does not CREATE on ${table}: ${row.indexdef}`;
					}
					const bytes = prettyToBytes(String(row.index_size));
					// size-DESC within the table
					if (bytes > previousBytes) return `size order broken on ${table} at ${row.indexname}`;
					previousBytes = bytes;
				}
			}
			return null;
		})();
		expect(indexFault).toBeNull();

		// engine-native by design (differential-pinned assertion, verbatim)
		expect(String(result.info?.server ?? '')).toContain('PostgreSQL');
		expect(typeof result.info?.host).toBe('string');

		// statistics: engine-native, ADDITIVE (WC-073). Asserted for presence and
		// shape only — `status` depends on whether THIS database has been
		// analyzed, so pinning a value here would make the gate a property of
		// the test box rather than of the code. The verdict logic itself is
		// pinned purely in database_statistics_health.test.ts.
		const statistics = result.statistics;
		expect(statistics).not.toBeUndefined();
		if (statistics !== null && statistics !== undefined) {
			expect(['ok', 'degraded']).toContain(String(statistics.status));
			expect(typeof statistics.tables).toBe('number');
			expect(typeof statistics.never_analyzed).toBe('number');
			expect(typeof statistics.counters_reset).toBe('number');
			expect(Array.isArray(statistics.worst)).toBe(true);
			expect(String(statistics.detail).length).toBeGreaterThan(0);
			// the catalog and the stats read must agree about how many tables exist
			expect(statistics.tables).toBeLessThanOrEqual((result.tables ?? []).length);
		}
	}, 120000);
});

describe('counters_status.modify_counter (fix + reset, scratch-only)', () => {
	let scratchId = 0;
	let counterSnapshot: number | null = null;

	beforeAll(async () => {
		const rows = (await sql.unsafe(
			`SELECT value FROM matrix_counter WHERE tipo = 'test3'`,
			[],
		)) as {
			value: number | string;
		}[];
		counterSnapshot = rows.length > 0 ? Number(rows[0]?.value) : null;
		// materializes the test3 counter row and gives fix a known newest id
		scratchId = await createSectionRecord('test3', -1);
	});

	afterAll(async () => {
		const leaked: string[] = [];
		if (scratchId > 0) {
			const deleted = (await sql.unsafe(
				`DELETE FROM matrix_test WHERE section_tipo = 'test3' AND section_id = $1 RETURNING id`,
				[scratchId],
			)) as unknown[];
			if (deleted.length === 0) leaked.push(`test3/${scratchId}`);
			await sql.unsafe(
				`DELETE FROM matrix_time_machine WHERE section_tipo = 'test3' AND section_id = $1`,
				[scratchId],
			);
		}
		// UNCONDITIONAL counter restore: never below the pre-test value, the
		// issued scratch id, or the surviving MAX(section_id) — a failed
		// assertion must not leave the injected drift (or a rewound counter
		// that would re-issue live ids) behind.
		await sql.unsafe(
			`UPDATE matrix_counter
			 SET value = GREATEST($1::bigint, (SELECT COALESCE(MAX(section_id), 0) FROM matrix_test WHERE section_tipo = 'test3'))
			 WHERE tipo = 'test3'`,
			[Math.max(counterSnapshot ?? 0, scratchId)],
		);
		// defensive sweep of the reset fixture (its test cleans up fail-loud)
		await sql.unsafe(`DELETE FROM matrix_counter WHERE tipo = 'zztc2'`, []);
		if (leaked.length > 0) {
			throw new Error(`cleanup leaked scratch rows: ${leaked.join(', ')}`);
		}
	});

	test('fix RAISES a lagging counter and refuses to lower one ahead of the data', async () => {
		const maxRows = (await sql.unsafe(
			`SELECT section_id FROM matrix_test WHERE section_tipo = 'test3' ORDER BY section_id DESC LIMIT 1`,
			[],
		)) as { section_id: number }[];
		const liveMax = Number(maxRows[0]?.section_id);

		// (a) DOWNWARD drift — a counter BEHIND its data is the one genuine defect
		// 'fix' exists to repair, so the raise is observable here.
		await sql.unsafe(`UPDATE matrix_counter SET value = 1 WHERE tipo = 'test3'`, []);
		const fixed = (await tsCall({
			...WIDGET_RQO,
			options: { section_tipo: 'test3', counter_action: 'fix' },
			source: { typo: 'source', model: 'counters_status', action: 'modify_counter' },
		})) as { data?: unknown; msg?: string; datalist?: Record<string, unknown>[] };
		expect(fixed.data).toBe(true);
		expect(fixed.msg).toBe('OK. fix counter successfully test3');

		const raised = (await sql.unsafe(
			`SELECT value FROM matrix_counter WHERE tipo = 'test3'`,
			[],
		)) as { value: number }[];
		// At LEAST the live max — the floor also counts the time-machine witness,
		// so a section whose tail was deleted lands ABOVE live max, never below.
		expect(Number(raised[0]?.value)).toBeGreaterThanOrEqual(liveMax);

		// PHP re-runs check_counters and attaches the refreshed audit datalist
		// (PHP source class.counters_status.php:150-160; PHP's own path dies
		// earlier, so this is source-derived, not differential-compared).
		const audited = (fixed.datalist ?? []).find((item) => item.section_tipo === 'test3');
		expect(Number(audited?.counter_value)).toBeGreaterThanOrEqual(liveMax);
		expect(audited?.last_section_id).toBe(liveMax);

		// (b) UPWARD drift — a counter AHEAD of its data is the NORMAL state after
		// any tail delete. 'fix' must leave it exactly where it stands; lowering it
		// here is what re-minted deleted records' ids.
		await sql.unsafe(`UPDATE matrix_counter SET value = $1 WHERE tipo = 'test3'`, [liveMax + 500]);
		await tsCall({
			...WIDGET_RQO,
			options: { section_tipo: 'test3', counter_action: 'fix' },
			source: { typo: 'source', model: 'counters_status', action: 'modify_counter' },
		});
		const kept = (await sql.unsafe(
			`SELECT value FROM matrix_counter WHERE tipo = 'test3'`,
			[],
		)) as { value: number }[];
		// NOT `toBe(liveMax + 500)`. The floor 'fix' raises to is
		// GREATEST(live MAX, time-machine MAX) — so on a section whose TAIL RECORDS
		// WERE DELETED (the normal state, and the whole reason the counter is a
		// high-water mark) the floor legitimately exceeds live MAX and the counter
		// lands ABOVE the injected drift. The invariant is that it did not go DOWN.
		expect(Number(kept[0]?.value)).toBeGreaterThanOrEqual(liveMax + 500);
	}, 60000);

	test('reset is REFUSED and the counter row survives (synthetic zztc2)', async () => {
		await sql.unsafe(
			`INSERT INTO matrix_counter (tipo, value, ref) VALUES ('zztc2', 999, 'synthetic native gate row')`,
			[],
		);
		try {
			const reset = (await tsCall({
				...WIDGET_RQO,
				options: { section_tipo: 'zztc2', counter_action: 'reset' },
				source: { typo: 'source', model: 'counters_status', action: 'modify_counter' },
			})) as { ok?: boolean; error?: { code?: string } };
			// The action is refused through the normal envelope, not performed.
			expect(reset.ok).toBe(false);
			expect(reset.error?.code).toBe('maintenance.action_refused');

			// AND — the point of the whole change — the high-water mark stands.
			const left = (await sql.unsafe(
				`SELECT value FROM matrix_counter WHERE tipo = 'zztc2'`,
				[],
			)) as { value: number }[];
			expect(left.length).toBe(1);
			expect(Number(left[0]?.value)).toBe(999);
		} finally {
			// a failed assertion must still remove the synthetic row
			await sql.unsafe(`DELETE FROM matrix_counter WHERE tipo = 'zztc2'`, []);
		}
	}, 60000);
});

describe('database_info.rebuild_user_stats (dd1521 aggregate anatomy)', () => {
	// distinct synthetic user — the differential owns 424242
	const UID = 424252;
	const dayA = new Date(Date.now() - 2 * 86400000);
	const dayB = new Date(Date.now() - 1 * 86400000);
	const isoDay = (date: Date): string =>
		`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
			date.getDate(),
		).padStart(2, '0')}`;

	const activityIds: number[] = [];
	let body: Record<string, unknown> = {};
	let statsRows: Record<string, unknown>[] = [];
	const labels: Record<string, string | null> = {};

	// int-canonical actor locator (WC-2026-08-10-section-id-int-canonical): the
	// writer mints an INT section_id now; the string twin still matches rows
	// written before that sweep. Both probe AND sweep must OR the two forms —
	// a single-form filter is what made this file red and self-leaking.
	const USER_FILTER = JSON.stringify({
		dd1522: [{ section_tipo: 'dd128', section_id: UID }],
	});
	const USER_FILTER_LEGACY = JSON.stringify({
		dd1522: [{ section_tipo: 'dd128', section_id: String(UID) }],
	});
	const ACTIVITY_FILTER = JSON.stringify({
		dd543: [{ section_tipo: 'dd128', section_id: UID }],
	});
	const ACTIVITY_FILTER_LEGACY = JSON.stringify({
		dd543: [{ section_tipo: 'dd128', section_id: String(UID) }],
	});

	/** The differential's exact synthetic activity row (direct SQL — dd542 is consultation-only). */
	const insertActivity = async (
		date: Date,
		hour: number,
		code: number,
		where: string,
		dataMessage: Record<string, unknown> | null = null,
	): Promise<void> => {
		const timestamp = `${isoDay(date)} ${String(hour).padStart(2, '0')}:15:00`;
		const rows = (await sql.unsafe(
			`INSERT INTO matrix_activity (section_tipo, relation, string, date, misc, timestamp)
			 VALUES ('dd542', $1::text::jsonb, $2::text::jsonb, $3::text::jsonb, $4::text::jsonb, $5)
			 RETURNING id`,
			[
				JSON.stringify({
					dd543: [
						{
							id: 1,
							type: 'dd151',
							section_id: String(UID),
							section_tipo: 'dd128',
							from_component_tipo: 'dd543',
						},
					],
					dd545: [
						{
							id: 1,
							type: 'dd151',
							section_id: String(code),
							section_tipo: 'dd552',
							from_component_tipo: 'dd545',
						},
					],
				}),
				JSON.stringify({ dd546: [{ id: 1, lang: 'lg-nolan', value: where }] }),
				JSON.stringify({
					dd547: [
						{
							id: 1,
							start: {
								year: date.getFullYear(),
								month: date.getMonth() + 1,
								day: date.getDate(),
								hour,
								minute: 15,
								second: 0,
							},
						},
					],
				}),
				JSON.stringify(
					dataMessage ? { dd551: [{ id: 1, lang: 'lg-nolan', value: dataMessage }] } : {},
				),
				timestamp,
			],
		)) as { id: number }[];
		activityIds.push(Number(rows[0]?.id));
	};

	const readStatsRows = async (): Promise<Record<string, unknown>[]> =>
		(await sql.unsafe(
			`SELECT relation->'dd1522' AS u, string->'dd1531' AS t, date->'dd1530' AS d,
			        misc->'dd1523' AS totals, meta
			 FROM matrix_stats
			 WHERE section_tipo = 'dd1521'
			   AND (relation @> $1::text::jsonb OR relation @> $2::text::jsonb)
			 ORDER BY id`,
			[USER_FILTER, USER_FILTER_LEGACY],
		)) as Record<string, unknown>[];

	beforeAll(async () => {
		// defensive sweep of any leftovers from an earlier aborted run (both
		// locator forms; may legitimately match 0 rows on a clean database, so
		// this one is NOT fail-loud — the afterAll sweep is)
		const staleStats = (await sql.unsafe(
			`DELETE FROM matrix_stats
			 WHERE section_tipo = 'dd1521'
			   AND (relation @> $1::text::jsonb OR relation @> $2::text::jsonb)
			 RETURNING section_id`,
			[USER_FILTER, USER_FILTER_LEGACY],
		)) as { section_id: number }[];
		for (const row of staleStats) {
			await sql.unsafe(
				`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd1521' AND section_id = $1`,
				[row.section_id],
			);
		}
		await sql.unsafe(
			`DELETE FROM matrix_activity
			 WHERE section_tipo = 'dd542'
			   AND (relation @> $1::text::jsonb OR relation @> $2::text::jsonb)`,
			[ACTIVITY_FILTER, ACTIVITY_FILTER_LEGACY],
		);

		// the differential's exact 2-day provisioning
		await insertActivity(dayA, 9, 1, 'dd542'); // login
		await insertActivity(dayA, 9, 5, 'test6099'); // save
		await insertActivity(dayA, 10, 5, 'test6099'); // save
		await insertActivity(dayA, 10, 6, 'test6100'); // edit
		await insertActivity(dayA, 11, 5, 'dd1223', { top_tipo: 'testmint1' }); // publish
		await insertActivity(dayB, 14, 7, 'test6099'); // list
		await insertActivity(dayB, 14, 8, 'dd271'); // where SKIPPED

		body = await tsCall({
			...WIDGET_RQO,
			options: { users: [UID] },
			source: { typo: 'source', model: 'database_info', action: 'rebuild_user_stats' },
		});
		statsRows = await readStatsRows();

		// what-labels are mutable shared ontology terms — resolve, never pin
		for (const tipo of ['dd696', 'dd700', 'dd694', 'dd693', 'dd699']) {
			labels[tipo] = await termByTipo(tipo, currentApplicationLang());
		}
	}, 60000);

	afterAll(async () => {
		const leaked: string[] = [];
		// fail-loud: the provisioning above ALWAYS produces dd1521 aggregates for
		// this user, so a 0-row delete means the filter no longer matches what the
		// writer mints — the exact bug (stale string-only locator) this repairs.
		const statsIds = (await sql.unsafe(
			`DELETE FROM matrix_stats
			 WHERE section_tipo = 'dd1521'
			   AND (relation @> $1::text::jsonb OR relation @> $2::text::jsonb)
			 RETURNING section_id`,
			[USER_FILTER, USER_FILTER_LEGACY],
		)) as { section_id: number }[];
		if (statsIds.length === 0) {
			leaked.push(`matrix_stats dd1521 sweep for user ${UID} deleted 0 rows (stale filter?)`);
		}
		for (const row of statsIds) {
			await sql.unsafe(
				`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd1521' AND section_id = $1`,
				[row.section_id],
			);
		}
		for (const id of activityIds) {
			const deleted = (await sql.unsafe(
				`DELETE FROM matrix_activity WHERE section_tipo = 'dd542' AND id = $1 RETURNING id`,
				[id],
			)) as unknown[];
			if (deleted.length === 0) leaked.push(`matrix_activity id ${id}`);
		}
		if (leaked.length > 0) {
			throw new Error(`cleanup leaked tracked rows: ${leaked.join(', ')}`);
		}
	});

	test('envelope: data true, OK msg, one updated-days batch per user', () => {
		expect(body.data).toBe(true);
		expect(body.msg).toBe('OK. Request done.');
		expect(body.errors).toBeUndefined(); // envelope v2: no errors key on success
		expect(body.updated_days).toEqual([
			[
				{ user: UID, date: isoDay(dayA) },
				{ user: UID, date: isoDay(dayB) },
			],
		]);
	});

	test('one dd1521 aggregate row per provisioned day, PHP-algorithm content', () => {
		expect(statsRows.length).toBe(2);

		// int-canonical section_id (WC-2026-08-10-section-id-int-canonical) — the
		// stale String(UID) pin here is half of what made this file red.
		const userLocator = [
			{
				id: 1,
				type: 'dd151',
				section_id: UID,
				section_tipo: 'dd128',
				from_component_tipo: 'dd1522',
			},
		];
		const dayItem = [{ value: 'day', lang: 'lg-nolan', id: 1 }];
		const meta = {
			dd1522: [{ count: 1 }],
			dd1523: [{ count: 1 }],
			dd1530: [{ count: 1 }],
			dd1531: [{ count: 1 }],
		};
		const startOf = (date: Date) => ({
			year: date.getFullYear(),
			month: date.getMonth() + 1,
			day: date.getDate(),
			time: virtualDateSeconds(date.getFullYear(), date.getMonth() + 1, date.getDate()),
		});

		// day A: login + 3 saves (incl. the publish event's code 5) + 1 edit;
		// where dd542/test6099×2/test6100 (dd1223 routed to publish);
		// hours 9×2, 10×2, 11; one testmint1 publish
		const dayATotals = [
			{ type: 'what', tipo: 'dd696', value: 1, label: labels.dd696 },
			{ type: 'what', tipo: 'dd700', value: 3, label: labels.dd700 },
			{ type: 'what', tipo: 'dd694', value: 1, label: labels.dd694 },
			{ type: 'where', tipo: 'dd542', value: 1 },
			{ type: 'where', tipo: 'test6099', value: 2 },
			{ type: 'where', tipo: 'test6100', value: 1 },
			{ type: 'when', hour: 9, value: 2 },
			{ type: 'when', hour: 10, value: 2 },
			{ type: 'when', hour: 11, value: 1 },
			{ type: 'publish', tipo: 'testmint1', value: 1 },
		];
		// day B: list + search; the dd271 'where' is SKIPPED; hour 14×2
		const dayBTotals = [
			{ type: 'what', tipo: 'dd693', value: 1, label: labels.dd693 },
			{ type: 'what', tipo: 'dd699', value: 1, label: labels.dd699 },
			{ type: 'where', tipo: 'test6099', value: 1 },
			{ type: 'when', hour: 14, value: 2 },
		];

		const expected = [
			{ day: dayA, totals: dayATotals },
			{ day: dayB, totals: dayBTotals },
		];
		for (let index = 0; index < expected.length; index++) {
			const row = statsRows[index] as Record<string, unknown>;
			const entry = expected[index] as { day: Date; totals: unknown[] };
			expect(row.u).toEqual(userLocator as never);
			expect(row.t).toEqual(dayItem as never);
			expect(row.d).toEqual([{ id: 1, start: startOf(entry.day) }] as never);
			expect(row.totals).toEqual([{ id: 1, lang: 'lg-nolan', value: entry.totals }] as never);
			expect(row.meta).toEqual(meta as never);
		}
	});
});

describe('add_hierarchy (panel value + import/reset routing)', () => {
	test('get_widget_value: real panel shape; installed marker = term data, not the registry', async () => {
		const body = await tsCall({
			action: 'get_widget_value',
			dd_api: 'dd_area_maintenance_api',
			prevent_lock: true,
			options: {},
			source: { typo: 'source', model: 'add_hierarchy' },
		});
		const result = body.data as {
			hierarchies?: { tld: string }[];
			installed_hierarchies?: { tld: string }[];
			hierarchy_typologies?: unknown[];
			hierarchy_files_dir_path?: string;
		};

		// The widget no longer returns the empty coexistence stub: the offered list is
		// the vendored files, and the dir path is real.
		expect(Array.isArray(result.hierarchies)).toBe(true);
		expect((result.hierarchies?.length ?? 0) > 0).toBe(true);
		expect(Array.isArray(result.hierarchy_typologies)).toBe(true);
		// THE client view of hierarchy.json (hierarchy_meta.ts hierarchyChoiceView).
		for (const item of result.hierarchies ?? []) {
			expect(Object.keys(item).sort()).toEqual([
				'dependencies',
				'has_data',
				'label',
				'tld',
				'typology',
			]);
			// the declared THESAURI only (pre-ticked by the client, never locked)
			const declared = (item as { dependencies?: unknown }).dependencies;
			expect(Array.isArray(declared)).toBe(true);
			for (const dependency of declared as Record<string, unknown>[]) {
				expect(Object.keys(dependency).sort()).toEqual(['mandatory', 'tld']);
			}
		}
		expect(String(result.hierarchy_files_dir_path ?? '').replaceAll('\\', '/')).toContain(
			'install/import/hierarchy',
		);

		// The marker is renamed AND re-sourced: no stale active_hierarchies key, and the
		// installed set EQUALS the tlds with actual `<tld>1` term rows in matrix_hierarchy
		// (the reported bug marked ~all declared hierarchies because it read the registry).
		// The empty-by-design half (an active row of a manifest entry with no data files)
		// adds nothing while the vendored manifest lists none — its rule is pinned
		// purely by installed_tld_native (mergeInstalledTlds).
		expect('active_hierarchies' in result).toBe(false);
		expect(Array.isArray(result.installed_hierarchies)).toBe(true);
		const widgetTlds = (result.installed_hierarchies ?? []).map((h) => h.tld).sort();
		const dbTlds = (
			(await sql.unsafe(
				`SELECT DISTINCT substring(section_tipo from '^([a-z]+)1$') AS tld
				 FROM matrix_hierarchy WHERE section_tipo ~ '^[a-z]+1$'`,
				[],
			)) as { tld: string | null }[]
		)
			.map((r) => r.tld)
			.filter((tld): tld is string => Boolean(tld))
			.sort();
		expect(widgetTlds).toEqual(dbTlds);
	}, 60000);

	test('install_hierarchies routes and is a no-op for an empty selection', async () => {
		const body = await tsCall({
			...WIDGET_RQO,
			options: { hierarchies: [] },
			source: { typo: 'source', model: 'add_hierarchy', action: 'install_hierarchies' },
		});
		expect(body.data).toBe(true);
		// an empty selection imports nothing: lg is core, activated by the install (98424957ee)
		expect(String(body.msg)).toBe(
			'No optional hierarchies selected — Languages (lg) is always active',
		);
		expect(body.errors).toBeUndefined(); // envelope v2: no errors key on success
	});

	test('reset_hierarchies routes (replace verb) and is a no-op for an empty selection', async () => {
		const body = await tsCall({
			...WIDGET_RQO,
			options: { hierarchies: [] },
			source: { typo: 'source', model: 'add_hierarchy', action: 'reset_hierarchies' },
		});
		expect(body.data).toBe(true);
		// an empty selection imports nothing: lg is core, activated by the install (98424957ee)
		expect(String(body.msg)).toBe(
			'No optional hierarchies selected — Languages (lg) is always active',
		);
		expect(body.errors).toBeUndefined(); // envelope v2: no errors key on success
	});
});
