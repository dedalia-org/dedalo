/**
 * check_config widget — TS-NATIVE: reports THIS server's config sources
 * (.env, ts_state.json, the session store) and DB status in the PHP panel's
 * shape; the PHP widget reports the PHP install's files, which this server
 * must not misreport as its own. State flags (maintenance/recovery/
 * notification) persist in the TS server-state store.
 *
 * It also carries the ONE cross-subsystem coherence row the dashboard needs:
 * `diffusion_langs` compares the publication language POLICY against the langs
 * actually present in the MariaDB publication targets. That belongs to a
 * config-health panel and nowhere else — it is the only way an install broken
 * by the v6→v7 DEDALO_DIFFUSION_LANGS migration can be FOUND, because after
 * the fix its config parses cleanly and no boot check can see the damage.
 * That read is the ONE core→diffusion dependency here: it goes through the
 * diffusion/api/ FACADE, lazily, from a single function, and this file is
 * REGISTERED for it in diffusion_boundaries.test.ts's DIFFUSION_IMPORT_SEAMS —
 * a deliberate, named widening of the boundary, not an ambient permission.
 */

import { isDiffusionLangCode } from '../../../config/lang_code.ts';
import { describePgTransport, resolvePgTransport } from '../../../config/pg_transport.ts';
import { sql } from '../../db/postgres.ts';
import { probeSchemaHealth } from '../../db/schema_probe.ts';
import {
	refuseAction,
	type WidgetHandler,
	type WidgetModule,
	type WidgetResponse,
} from './support.ts';

/** One catalog credential placeholder rule, as `CATALOG_PLACEHOLDERS` carries it. */
export interface CredentialPlaceholder {
	key: string;
	value: string;
	emptyIsValid: boolean;
}

/**
 * The db_status credential fold — PURE, taking the LIVE values as a parameter.
 *
 * The injection is a precondition, not a style choice: closing over `readEnv`
 * would make every assertion here a statement about THIS machine's
 * ../private/.env — green locally, undefined on a clone.
 *
 * Two arms the dashboard header depends on:
 *  - `emptyIsValid` (DB_PASSWORD): an EMPTY password is legitimate under
 *    peer/trust auth, so only the literal sample value fails. Invert it and
 *    every peer-auth install reports config_pw_check=false and a red header on
 *    a perfectly healthy database (GAP-3).
 *  - `global_status` is the AND of the folded credential checks, the
 *    connection probe and the write probe. Turn it into an OR and a broken
 *    database paints the header green.
 *
 * Key order is the client's wire shape (render_check_config.js reads each
 * `db_status.*_check` by name) — keep it.
 */
export function evaluateCredentialChecks(
	live: Record<string, string>,
	placeholders: readonly CredentialPlaceholder[],
	probes: { connection: boolean; writable: boolean },
): Record<string, boolean> {
	const stillOnSample = (key: string): boolean => {
		const rule = placeholders.find((entry) => entry.key === key);
		if (rule === undefined) return false;
		const value = live[key] ?? '';
		if (value === rule.value) return true;
		return value === '' && !rule.emptyIsValid;
	};
	const configDbNameCheck = !stillOnSample('DB_NAME');
	const configUserNameCheck = !stillOnSample('DB_USER');
	const configPwCheck = !stillOnSample('DB_PASSWORD');
	const configInformationCheck = !stillOnSample('DEDALO_ENTITY_LABEL');
	const configInfoKeyCheck = !stillOnSample('ENTITY');
	const configCheck =
		configDbNameCheck &&
		configUserNameCheck &&
		configPwCheck &&
		configInformationCheck &&
		configInfoKeyCheck;
	return {
		config_db_name_check: configDbNameCheck,
		config_user_name_check: configUserNameCheck,
		config_pw_check: configPwCheck,
		config_information_check: configInformationCheck,
		config_info_key_check: configInfoKeyCheck,
		config_check: configCheck,
		db_connection_check: probes.connection,
		db_writable_check: probes.writable,
		// PHP ANDs every field on the object (config_check already folds the five
		// credential checks, so this is: all credential checks && connection && writable).
		global_status: configCheck && probes.connection && probes.writable,
	};
}

/**
 * The `diffusion_langs` coherence row (see the file header). Flattened from the
 * diffusion subsystem's own report into the shape a status row renders:
 * `applicable:false` + a one-line `reason` is the ANSWER for the installs that
 * publish to no MariaDB target — the common case, and a healthy one.
 */
export interface DiffusionLangCoherence {
	applicable: boolean;
	reason: string | null;
	/** The publication policy (config.diffusion.langs), order preserved. */
	policy: string[];
	/** Every lang value actually present in the target tables, deduplicated. */
	published: string[];
	/** Published langs the policy does not name — the phantom set to repair. */
	phantom: string[];
	phantom_rows: number;
	/** false ⇒ the scan budget ran out; the phantom set may be incomplete. */
	complete: boolean;
	/**
	 * Tables the audit deliberately did NOT look at: they carry a `lang` column
	 * but are not positively identified as diffusion-created, so the sweep owns
	 * nothing in them. Reported so the narrowing is visible instead of silent.
	 */
	unmarked_tables: number;
	errors: string[];
}

/**
 * The nested shape of the diffusion report this widget flattens, stated
 * STRUCTURALLY on purpose: `import type` from src/diffusion would be erased at
 * runtime and legal under rule (c) of diffusion_boundaries, but the widget has
 * no business naming the subsystem's types — it consumes a report, and this is
 * exactly the part of it the flattener walks. The one runtime door stays the
 * lazy facade import in auditDiffusionLangCoherence().
 */
interface PublishedLangReport {
	applicable: boolean;
	reason: string | null;
	policy: readonly string[];
	databases: readonly { tables: readonly { published: readonly { lang: string }[] }[] }[];
	phantom_langs: readonly string[];
	phantom_rows: number;
	complete: boolean;
	unmarked_tables: number;
	errors: readonly string[];
}

/**
 * PURE — flatten the diffusion subsystem's nested coherence report into the one
 * status row the dashboard renders. Extracted from computeCheckConfig so it is
 * reachable by a gate without a MariaDB target (extract-AND-rewire, the CRAP
 * program's law): the parent is an unexecutable I/O shell, this is not.
 * Gate: test/unit/check_config_diffusion_langs_native.test.ts.
 */
export function flattenLangCoherence(report: PublishedLangReport): DiffusionLangCoherence {
	// Deduplicated in FIRST-SEEN order — the audit walks database → table → lang,
	// so the order an operator reads is the order the targets were scanned.
	const published: string[] = [];
	for (const database of report.databases) {
		for (const table of database.tables) {
			for (const entry of table.published) {
				if (!published.includes(entry.lang)) published.push(entry.lang);
			}
		}
	}
	return {
		applicable: report.applicable,
		reason: report.reason,
		policy: [...report.policy],
		published,
		phantom: [...report.phantom_langs],
		phantom_rows: report.phantom_rows,
		complete: report.complete,
		unmarked_tables: report.unmarked_tables,
		errors: [...report.errors],
	};
}

/**
 * PURE — the card-level error line for a coherence row, as a 0-or-1 element
 * list so the caller appends without a branch of its own. A phantom lang is
 * PUBLISHED GARBAGE being served right now, so it colours the dashboard card
 * like any other failed check: the operator must not have to open the panel to
 * learn about it. The advice names a REGISTERED action
 * (dd_diffusion_api::sweep_published_langs, src/core/api/handlers/
 * dd_diffusion_api.ts) — a widget must never point at an action that does not
 * exist. Gate: test/unit/check_config_diffusion_langs_native.test.ts.
 */
export function phantomLangCardErrors(row: DiffusionLangCoherence): string[] {
	if (row.phantom.length === 0) return [];

	// A phantom lang has TWO very different causes, and only one of them is
	// repaired by deleting rows:
	//
	//  - DEBRIS (`["lg-cat"`): a shredded config value published codes that were
	//    never languages. Nothing legitimate is stored under them, so sweeping is
	//    the repair.
	//  - POLICY DRIFT (`lg-cat`): a WELL-FORMED code that the policy no longer
	//    names. The usual cause is a LOST DEDALO_DIFFUSION_LANGS — unset, the key
	//    derives from the project languages, which may be narrower than what was
	//    published. Those rows are real translations. Sweeping them DESTROYS
	//    them; the repair is to restore the policy.
	//
	// Steering the operator at the destructive action for both is a data-loss
	// trap, so the two are reported separately and only debris names the sweep.
	const debris = row.phantom.filter((lang) => !isDiffusionLangCode(lang));
	const drift = row.phantom.filter((lang) => isDiffusionLangCode(lang));
	const errors: string[] = [];

	if (debris.length > 0) {
		errors.push(
			`Published languages that are not language codes: ${debris.join(', ')} ` +
				`(of ${row.phantom_rows} phantom row(s)) — malformed values reached the ` +
				`publication target; run dd_diffusion_api sweep_published_langs to remove them`,
		);
	}
	if (drift.length > 0) {
		errors.push(
			`Published languages outside the diffusion policy: ${drift.join(', ')} ` +
				`(of ${row.phantom_rows} phantom row(s)) — these are well-formed codes, so ` +
				`check DEDALO_DIFFUSION_LANGS / DEDALO_PROJECTS_DEFAULT_LANGS FIRST: if the ` +
				`policy is wrong, restore it, because sweeping deletes real translations`,
		);
	}
	return errors;
}

/**
 * The `diffusion_langs` probe: the ONE core→diffusion read this widget makes.
 *
 * Read through the diffusion FACADE (src/diffusion/api/), lazily — the file is
 * registered in diffusion_boundaries.test.ts's DIFFUSION_IMPORT_SEAMS for
 * exactly this call, and boundary_seam_tripwire allows a core→diffusion pair
 * only when it targets the facade.
 *
 * The dashboard budget is deliberately the TIGHT one: `lang` is the second
 * column of the published tables' composite primary key, so counting the langs
 * is an index scan, and a panel read must never sit on one. An install with no
 * MariaDB target — the common case — costs a single cached ontology lookup and
 * answers `applicable:false`.
 *
 * Fail-soft like every other probe in this widget: a diffusion-side failure
 * leaves the row null (the client omits it) and never blanks the dashboard.
 */
async function auditDiffusionLangCoherence(): Promise<{
	row: DiffusionLangCoherence | null;
	errors: string[];
}> {
	try {
		// ONE-LINE `await import(...)` ON PURPOSE: diffusion_boundaries.test.ts
		// scans rule (c) line by line, so a formatter-wrapped specifier would slip
		// past the very gate that must see this file and record it as a seam.
		const diffusionFacade = await import('../../../diffusion/api/actions.ts');
		const report = await diffusionFacade.auditPublishedLangs(diffusionFacade.WIDGET_AUDIT_BUDGET);
		const row = flattenLangCoherence(report);
		return { row, errors: phantomLangCardErrors(row) };
	} catch (error) {
		// Never silent: the row is absent AND the reason is in the log.
		console.warn('[check_config] diffusion lang coherence audit failed', error);
		return { row: null, errors: [] };
	}
}

/**
 * computeCheckConfig — config-source health + live DB probes. Returns the INNER
 * result payload the client stores as `self.value` (db_status + config_sources +
 * state) plus the soft errors that colour the envelope msg. Shared by getValue
 * (panel open) AND eagerValue (catalog pre-load), so the FOLDED dashboard card
 * and the OPENED panel paint from byte-identical data.
 */
/*
 * COVERAGE-EXEMPT for execution, this probe shell (coverage plan §5.1; reason
 * registered in engineering/crap_coverage_exempt.json): every remaining branch is
 * a FAIL-SOFT I/O probe (`SELECT 1`, a TEMP-table write, `existsSync`,
 * `probeSchemaHealth`) whose only decision is null-vs-value on its OWN result.
 * The one real decision, the credential-placeholder fold, is extracted to
 * `evaluateCredentialChecks` above — and this exemption is valid ONLY because
 * that extraction TAKES `live` AS A PARAMETER: without the injection its gate
 * would assert against this machine's ../private/.env and be undefined on a clone.
 */
async function computeCheckConfig(): Promise<{
	payload: {
		db_status: Record<string, boolean>;
		config_sources: { name: string; required: boolean; exists: boolean; readable: boolean }[];
		db_info: {
			identity: string;
			server: string | null;
			schema_ok: boolean | null;
			ontology_rows: number | null;
			matrix_tables: number | null;
			migration_level: number | null;
			migration_latest: string | null;
			pool: { in_use: number; max: number; waiters: number };
		} | null;
		runtime_mode: {
			maintenance: boolean;
			recovery: boolean;
			notification: boolean;
			diffusion_native: boolean;
			dev_mode: boolean;
		};
		diffusion_langs: DiffusionLangCoherence | null;
		state: unknown;
	};
	errors: string[];
}> {
	const { existsSync } = await import('node:fs');
	const { basename, join } = await import('node:path');
	// The ONE private-dir resolution (src/config/env.ts) — it honors
	// DEDALO_PRIVATE_DIR. This used to re-derive it as
	// `dirname(process.cwd()) + '/private'`, which ignored that variable and
	// reported a container's config sources against a directory that does not
	// exist (runtime-path census, 2026-08-23).
	const { privateDir, readEnv } = await import('../../../config/env.ts');
	const { readBool } = await import('../../../config/readers.ts');
	const errors: string[] = [];

	// --- database status (installer::get_db_status() OBJECT shape) ---
	// The client renderer (render_check_config.js) reads db_status as an OBJECT of
	// per-check booleans + global_status and paints every row/the card header from
	// them. A plain string here (the previous shape) reads as `undefined` on every
	// `db_status.*_check`, so the panel showed "Connection: Failed" and a red header
	// even on a healthy DB. Rebuild the PHP shape from THIS server's env-sourced
	// credentials plus a live connection + write probe.
	const dbName = readEnv('DB_NAME') ?? '';
	const dbUser = readEnv('DB_USER') ?? '';
	const dbPassword = readEnv('DB_PASSWORD') ?? '';
	const entityKey = readEnv('ENTITY') ?? '';
	const entityLabel = readEnv('DEDALO_ENTITY_LABEL') ?? entityKey;

	// Credential placeholder checks. "Is this install still on the sample values?" is only
	// an honest question if the shipped template literally CARRIES those values — so both
	// sides read ONE list, the catalog's `placeholder` fields, and the template that the
	// installer drops at ../private/sample.env is rendered from the same source. Before
	// this, these were five literals hardcoded here, next to a comment claiming a
	// sample.env that did not exist shipped them: an unfalsifiable claim.
	//
	// GAP-3 survives as `emptyIsValid` on DB_PASSWORD: an EMPTY password is legitimate
	// under peer/trust auth, so only the literal sample value fails; real auth is decided
	// by the connection probe below.
	const { CATALOG_PLACEHOLDERS } = await import('../../../config/catalog/index.ts');
	const live: Record<string, string> = {
		DB_NAME: dbName,
		DB_USER: dbUser,
		DB_PASSWORD: dbPassword,
		ENTITY: entityKey,
		DEDALO_ENTITY_LABEL: entityLabel,
	};
	// Live connection probe.
	let dbConnectionCheck = true;
	try {
		await sql.unsafe('SELECT 1', []);
	} catch (_error) {
		dbConnectionCheck = false;
		errors.push('Database connection failed');
	}

	// Write probe (PHP's CREATE/INSERT/DROP): a TEMP table is CONNECTION-scoped, so
	// the statements MUST run on one pinned connection — withTransaction reserves a
	// single connection and routes every `sql` through it. `ON COMMIT DROP` means
	// nothing persists. Fail-soft: any error just yields db_writable_check=false.
	let dbWritableCheck = false;
	if (dbConnectionCheck) {
		try {
			const { withTransaction } = await import('../../db/postgres.ts');
			await withTransaction(async () => {
				await sql.unsafe(
					'CREATE TEMP TABLE _dedalo_ts_write_probe (id serial PRIMARY KEY, val text NOT NULL) ON COMMIT DROP',
					[],
				);
				await sql.unsafe("INSERT INTO _dedalo_ts_write_probe (val) VALUES ('write_test')", []);
			});
			dbWritableCheck = true;
		} catch (_error) {
			dbWritableCheck = false;
		}
	}

	const dbStatus = evaluateCredentialChecks(live, CATALOG_PLACEHOLDERS, {
		connection: dbConnectionCheck,
		writable: dbWritableCheck,
	});

	// Config sources this SERVER actually reads, resolved through the SAME accessors
	// the runtime uses — so a DEDALO_TS_STATE_PATH / DEDALO_SESSION_DB_PATH relocation
	// is reported at its real path, not a guess. The session store's real filename is
	// `dedalo_ts_sessions.sqlite` (session_store.ts); the previous hardcoded
	// `sessions.sqlite` never existed, so the store was ALWAYS misreported as absent.
	const { statePath, getServerState } = await import('../../resolve/server_state.ts');
	const { SESSION_DB_PATH } = await import('../../security/session_store.ts');
	const stateFile = statePath();
	const sources = [
		{ name: '.env', path: join(privateDir, '.env'), required: true },
		{ name: basename(stateFile), path: stateFile, required: false },
		{ name: basename(SESSION_DB_PATH), path: SESSION_DB_PATH, required: false },
	];
	const configSources = sources.map((source) => {
		const exists = existsSync(source.path);
		if (source.required && !exists) {
			errors.push(`Required config source missing or unreadable: ${source.name}`);
		}
		return { name: source.name, required: source.required, exists, readable: exists };
	});

	// --- extended DB details (informational; the folded card's "am I on the right
	// database?" answer + engine/schema/migration/pool health). All fail-soft:
	// a probe failure leaves the field null and the client row is simply omitted. ---
	const { config } = await import('../../../config/config.ts');
	const { getPoolStats } = await import('../../db/postgres.ts');
	const poolStats = getPoolStats();
	let dbInfo: {
		identity: string;
		server: string | null;
		schema_ok: boolean | null;
		ontology_rows: number | null;
		matrix_tables: number | null;
		migration_level: number | null;
		migration_latest: string | null;
		pool: { in_use: number; max: number; waiters: number };
	} | null = null;
	{
		// The route the pool actually takes (DB_SOCKET wins), not DB_HOST verbatim.
		const identity = `${config.db.database}@${describePgTransport(resolvePgTransport(config.db))}`;
		let server: string | null = null;
		let schemaOk: boolean | null = null;
		let ontologyRows: number | null = null;
		let matrixTables: number | null = null;
		let migrationLevel: number | null = null;
		let migrationLatest: string | null = null;
		if (dbConnectionCheck) {
			try {
				// One round-trip via db/schema_probe.ts (the raw-SQL home — the T3
				// ratchet forbids direct dd_ontology queries from widget code).
				const row = await probeSchemaHealth();
				if (row) {
					server = row.server;
					ontologyRows = row.onto_rows;
					matrixTables = row.matrix_tables;
					migrationLevel = row.mig_n;
					migrationLatest = row.mig_latest;
					schemaOk = row.onto === true && (row.matrix_tables ?? 0) > 0;
				}
			} catch (_error) {
				// fail-soft: leave the extended fields null (the client omits their rows)
			}
		}
		dbInfo = {
			identity,
			server,
			schema_ok: schemaOk,
			ontology_rows: ontologyRows,
			matrix_tables: matrixTables,
			migration_level: migrationLevel,
			migration_latest: migrationLatest,
			pool: { in_use: poolStats.inUse, max: poolStats.max, waiters: poolStats.waiters },
		};
	}

	// --- runtime mode strip: a read-only "what mode am I in" snapshot for EVERY
	// admin (the root-only forms only TOGGLE maintenance/recovery/notification). ---
	const state = getServerState();
	const runtimeMode = {
		maintenance: state.maintenance_mode === true,
		recovery: state.recovery_mode === true,
		notification:
			state.notification !== false && state.notification !== '' && state.notification != null,
		// readBool, not readEnv==='true': see diffusion_server_control — the
		// catalog default (true) must apply when the key was never written.
		diffusion_native: readBool('DEDALO_DIFFUSION_NATIVE'),
		dev_mode: readEnv('DEDALO_DEV_MODE') === 'true',
	};

	// --- diffusion language coherence: the POLICY vs what is PUBLISHED ---
	// The whole probe (the facade seam, the flattening and the card error) lives
	// in auditDiffusionLangCoherence() above: this parent is a probe SHELL whose
	// complexity is frozen by the ratchet, so a cross-subsystem read enters it as
	// ONE call with no decision of its own.
	const coherence = await auditDiffusionLangCoherence();
	errors.push(...coherence.errors);

	return {
		payload: {
			db_status: dbStatus,
			config_sources: configSources,
			db_info: dbInfo,
			runtime_mode: runtimeMode,
			diffusion_langs: coherence.row,
			state,
		},
		errors,
	};
}

/**
 * check_config.get_value — the panel-open probe (dispatched by get_widget_value).
 */
async function checkConfigGetValue(): Promise<WidgetResponse> {
	const { payload, errors } = await computeCheckConfig();
	return {
		data: payload,
		...(errors.length === 0 ? {} : { msg: 'Warning. Request done with errors', errors }),
	};
}

/**
 * check_config eagerValue (WC-027) — the catalog pre-loads THIS payload onto the
 * widget descriptor so the dashboard paints the header with REAL status while the
 * panel is still FOLDED. Before this, a folded card had no value: `db_status` was `{}`,
 * `global_status` read `undefined`, and render_check_config coloured the header
 * danger-red on a perfectly healthy install. Fail-soft: NEVER throw (a throwing
 * eagerValue blanks the whole dashboard read) — null just defers to the on-open
 * get_value fetch (which restores the old folded-red only on a genuine probe
 * failure, an honest "unknown" signal rather than a false alarm).
 */
async function checkConfigEagerValue(): Promise<Record<string, unknown> | null> {
	try {
		const { payload } = await computeCheckConfig();
		return payload as unknown as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** set_maintenance_mode / set_recovery_mode — boolean state flags (PHP contract). */
function checkConfigSetState(flag: 'maintenance_mode' | 'recovery_mode'): WidgetHandler {
	return async (options) => {
		const value = options.value;
		if (typeof value !== 'boolean') {
			refuseAction(`Error. Request failed. ${flag} value is not a boolean`, { flag });
		}
		const { setServerState } = await import('../../resolve/server_state.ts');
		const state = setServerState({ [flag]: value });
		return { data: true, extend: { state } };
	};
}

/** set_notification — a string message or false to disable (PHP contract). */
async function checkConfigSetNotification(
	options: Record<string, unknown>,
): Promise<WidgetResponse> {
	const value = options.value;
	if (typeof value !== 'string' && typeof value !== 'boolean') {
		refuseAction('Error. Request failed. value is not string or bool');
	}
	const { setServerState } = await import('../../resolve/server_state.ts');
	const state = setServerState({ notification: value });
	return { data: true, extend: { state } };
}

export const widget: WidgetModule = {
	spec: {
		id: 'check_config',
		category: 'config',
		class: 'success',
		label: { kind: 'label', key: 'check_config' },
	},
	apiActions: {
		set_maintenance_mode: checkConfigSetState('maintenance_mode'),
		set_recovery_mode: checkConfigSetState('recovery_mode'),
		set_notification: checkConfigSetNotification,
	},
	getValue: checkConfigGetValue,
	eagerValue: checkConfigEagerValue,
};
