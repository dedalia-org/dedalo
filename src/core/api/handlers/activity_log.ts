/**
 * Activity log rows (PHP logger::$obj['activity'] → matrix_activity, section
 * dd542): every state-changing API action appends an audit row —
 *
 *   relation.dd543 = the acting user's locator (dd128, no item id)
 *   relation.dd545 = the WHAT code locator (dd42 — see WHAT_CODES below)
 *   string.dd544   = the client host, string.dd546 = the WHERE tipo
 *   date.dd547     = the virtual-calendar instant (no id/lang)
 *   misc.dd551     = [{lang:'lg-nolan', value: <action payload>}]
 *
 * (!) PHP also writes relation.dd550 = the actor's PROJECTS locators
 * (filter::get_user_projects, re-stamped to from_component_tipo dd550). We do
 * NOT — see the WIRE_CONTRACT entry. Every TS-written row lacks that dimension.
 *
 * The section_id comes from the matrix_activity_section_id_seq POSTGRES
 * SEQUENCE (PHP inserts without section_id — the dd542 matrix_counter lags
 * and is NOT the allocator here). Failures are logged and swallowed (an
 * audit write must never fail the user action — PHP posture).
 */

import { serializedSizeExceeds } from '../../concepts/scalar_bounds.ts';
import { TM_EXCLUDED_SECTIONS } from '../../concepts/section.ts';
import { canonicalizeStoredSectionId } from '../../concepts/section_id.ts';
import { insertMatrixRowSequenceId } from '../../db/matrix_write.ts';
import { virtualDateNow } from '../../section/record/create_record.ts';

/**
 * PHP WHAT message → dd42 code (logger_backend_activity::$what). Keys are the
 * EXACT PHP message strings — 'LOAD EDIT'/'LOAD LIST' are distinct codes (6/7),
 * NOT a single 'LOAD'. Unmapped messages are skipped, never guessed.
 *
 * The map mirrors dd42 in FULL (all 16 codes) because the READ side already
 * does: area_maintenance/user_stats.ts WHAT_ACTIONS maps 1-16 → action keys
 * (login…new_file_version, labelled by the labels engine) for the
 * user_activity widget. Four codes have no emitter — here or in PHP:
 *
 *   SEARCH 8, UPLOAD 9, STATS 15  — defined in PHP's $what but never passed to
 *       log_message() anywhere in v6 or the frozen v7. Never implemented.
 *   DOWNLOAD 10 — a v5-era event ('download file by tool av / image / pdf')
 *       LOST IN THE v6 MIGRATION. matrix_activity still holds code-10 rows from
 *       2019-2020 and none after, and the v5→v6 upgrade map
 *       (class.activity_v5_to_v6.php) still translates it — so the code must
 *       stay readable even while nothing writes it.
 *
 * They are mapped, not omitted: an emitter added later needs only its call
 * site, and the map stays a faithful mirror of the ontology section. None is
 * ruled out permanently — reinstating DOWNLOAD in particular is an open
 * question, not a closed one.
 */
const WHAT_CODES: Record<string, string> = {
	'LOG IN': '1', // login
	'LOG OUT': '2', // logout
	NEW: '3', // new
	DELETE: '4', // delete
	SAVE: '5', // save
	'LOAD EDIT': '6', // edit
	'LOAD LIST': '7', // list
	SEARCH: '8', // search — no emitter (never implemented)
	UPLOAD: '9', // upload — no emitter (never implemented; see UPLOAD COMPLETE)
	DOWNLOAD: '10', // download — no emitter (v5-era, lost in the v6 migration)
	'UPLOAD COMPLETE': '11', // upload_complete
	'DELETE FILE': '12', // delete_file
	'RECOVER SECTION': '13', // recover_section
	'RECOVER COMPONENT': '14', // recover_component
	STATS: '15', // statistics — no emitter (never implemented)
	'NEW VERSION': '16', // new_file_version
};

/**
 * The activity section's own components. Logging an action WHOSE TARGET is one
 * of these would append a row describing the appending of a row — PHP's
 * log_message_defer guards with the same list (logger_backend_activity::
 * $ar_elements_activity_tipo) and this is the port of that guard.
 */
const ACTIVITY_OWN_TIPOS: ReadonlySet<string> = new Set([
	'dd542', // the Activity section itself
	'dd543', // WHO
	'dd544', // IP
	'dd545', // WHAT
	'dd546', // WHERE
	'dd547', // WHEN
	'dd550', // PROJECTS
	'dd551', // DATA
]);

/**
 * Sections whose actions append NO activity row: exactly the sections that keep
 * no Time Machine history (concepts/section.ts TM_EXCLUDED_SECTIONS — the same
 * constant, never a copy). PHP log_message_defer skipped the same three
 * (dd655 / dd15 / dd1521). Keyed on the action's SECTION (activitySectionOf).
 */
const ACTIVITY_EXCLUDED_SECTIONS: ReadonlySet<string> = TM_EXCLUDED_SECTIONS;

/**
 * PHP's WHO fallback when nothing is authenticated (log_message_defer:
 * `$user_id ?? logged_user_id() ?? '-666'`). Load-bearing rather than
 * decorative: a DENIED login has no principal, and without this sentinel the
 * row could not name an actor at all.
 */
export const ANONYMOUS_USER_ID = -666;

/**
 * The dd544 (IP) value. Loopback resolves to the literal 'localhost' — PHP
 * normalizes '::1' the same way, and the existing rows depend on it.
 */
export function hostFromClientIp(clientIp: string | null | undefined): string {
	if (clientIp === '127.0.0.1' || clientIp === '::1') return 'localhost';
	return clientIp ?? 'unknown';
}

export interface ActivityEntry {
	what: keyof typeof WHAT_CODES | string;
	/** The WHERE tipo (component tipo for saves, section tipo for deletes). */
	tipo: string;
	userId: number;
	/** Client host (PHP stores the resolved host, e.g. 'localhost'). */
	host: string;
	/** The dd551 payload (msg + action-specific fields). */
	data: Record<string, unknown>;
}

/**
 * THE CEILING ON ONE AUDIT ROW (audit 2026-08-26 SEC-21).
 *
 * An activity row is a NOTE ABOUT an action, never a copy of its payload. Before
 * this it was whatever the emitter handed over: the login emitter passes the
 * attempted username straight through, and a single unauthenticated POST with a
 * 32 MiB username measured 67,109,061 bytes durably written here in 3.16 s —
 * inside the database every backup copies.
 *
 * The schema now refuses an oversize request at the parse door
 * (concepts/scalar_bounds.ts), so this is the SECOND wall, and it belongs here
 * rather than at each emitter: it is the property of the STORE, and it must hold
 * for an emitter written next year by someone who never read SEC-21.
 *
 * TRUNCATE, DO NOT DROP. Unlike a request — which is refused whole, so nothing
 * is silently shortened — an audit row that fails to write is an action nobody
 * can see afterwards. So an oversize field is stored SHORTENED AND MARKED: the
 * row keeps its who/what/when, and the marker says the value was cut and by how
 * much, which is itself the fact an operator wants.
 */
export const ACTIVITY_FIELD_MAX_CHARS = 512;
export const ACTIVITY_DATA_MAX_BYTES = 8 * 1024;

/** Shorten one over-long string, saying what was done. */
function truncateField(value: string): string {
	if (value.length <= ACTIVITY_FIELD_MAX_CHARS) return value;
	return `${value.slice(0, ACTIVITY_FIELD_MAX_CHARS)}…[truncated, ${value.length} chars]`;
}

/**
 * Bound a dd551 payload: every string shortened to ACTIVITY_FIELD_MAX_CHARS,
 * and — if the result is STILL over ACTIVITY_DATA_MAX_BYTES, which only a
 * pathological structure can manage — replaced by a note naming its keys.
 */
export function boundActivityData(data: Record<string, unknown>): Record<string, unknown> {
	const bounded = shortenValue(data, 0) as Record<string, unknown>;
	if (!serializedSizeExceeds(bounded, ACTIVITY_DATA_MAX_BYTES)) return bounded;
	return {
		msg: typeof bounded.msg === 'string' ? bounded.msg : 'activity payload dropped (too large)',
		truncated: true,
		keys: Object.keys(bounded).slice(0, 64),
	};
}

/** Every string in `value` shortened, to a bounded depth and breadth. */
function shortenValue(value: unknown, depth: number): unknown {
	if (typeof value === 'string') return truncateField(value);
	if (depth >= 6 || value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.slice(0, 256).map((item) => shortenValue(item, depth + 1));
	return shortenEntries(value as Record<string, unknown>, depth);
}

/** One object level: bounded keys, bounded values. */
function shortenEntries(value: Record<string, unknown>, depth: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[truncateField(key)] = shortenValue(item, depth + 1);
	}
	return out;
}

/**
 * THE ACTION'S SECTION — one derivation for every emitter: the payload's
 * `data.section_tipo` when it names one (a SAVE's WHERE is the COMPONENT tipo,
 * so its section rides in the payload), else the WHERE tipo itself (NEW,
 * DELETE, LOAD, RECOVER: the WHERE is the section).
 */
export function activitySectionOf(entry: Pick<ActivityEntry, 'tipo' | 'data'>): string {
	const declared = entry.data.section_tipo;
	return typeof declared === 'string' && declared !== '' ? declared : entry.tipo;
}

/** Append one activity row. Never throws (audit must not break the action). */
export async function logActivity(entry: ActivityEntry, now: Date = new Date()): Promise<void> {
	try {
		const code = WHAT_CODES[entry.what];
		if (code === undefined) return; // unmapped actions are skipped, not guessed
		// PHP log_message_defer's three skips, ported here (not at the call sites) so
		// that every current and future emitter inherits them:
		if (entry.tipo.length === 0) return; // no WHERE → the row would be meaningless
		if (ACTIVITY_OWN_TIPOS.has(entry.tipo)) return; // audit-of-the-audit loop
		// The third PHP skip (T2 O16-01): an action on a section that keeps no
		// history — the same three TM_EXCLUDED_SECTIONS (dd655 preset, dd15 TM,
		// dd1521 aggregate), ONE constant for both logs.
		if (ACTIVITY_EXCLUDED_SECTIONS.has(activitySectionOf(entry))) return;
		const relation = {
			dd543: [
				{
					type: 'dd151',
					// WC-2026-08-10-section-id-int-canonical: the actor's dd128 address is
					// an int and entry.userId already IS it.
					section_id: entry.userId,
					section_tipo: 'dd128',
					from_component_tipo: 'dd543',
				},
			],
			dd545: [
				{
					type: 'dd151',
					// WC-2026-08-10-section-id-int-canonical: the WHAT code IS the dd42
					// record address, so it is stored as an int like any other.
					section_id: canonicalizeStoredSectionId(code),
					section_tipo: 'dd42',
					from_component_tipo: 'dd545',
				},
			],
		};
		// EVERY stored string is bounded, not only the dd551 payload: dd544 is the
		// client host, which comes from a proxy header hop, and dd546 is a tipo.
		// A field a caller can influence at all is a field that carries a ceiling.
		const stringColumn = {
			dd544: [{ lang: 'lg-nolan', value: truncateField(entry.host) }],
			dd546: [{ lang: 'lg-nolan', value: truncateField(entry.tipo) }],
		};
		const dateColumn = { dd547: [{ start: virtualDateNow(now) }] };
		const miscColumn = { dd551: [{ lang: 'lg-nolan', value: boundActivityData(entry.data) }] };
		// The table allocates section_id from its own sequence; the INSERT lives in
		// matrix_write.ts (T2) — this handler issues no DML of its own.
		await insertMatrixRowSequenceId('matrix_activity', 'dd542', {
			relation,
			string: stringColumn,
			date: dateColumn,
			misc: miscColumn,
		});
	} catch (error) {
		console.error('activity log write failed (swallowed):', error);
	}
}
