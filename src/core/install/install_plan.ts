/**
 * THE INSTALL PLAN — the ONE place an install's answers become a configuration
 * and a step list (installer unification A1, 2026-10-08). Every front end is a
 * front end of THIS: the browser wizard (persist_config → config_persist.ts),
 * the headless CLI (scripts/install.ts) and install.sh (which drives the CLI).
 *
 * WHY. Before this module each front end carried its own copy of the answers →
 * .env mapping and its own defaults, and they had drifted: the CLI defaulted
 * the database host to `/tmp` (Debian/RHEL sockets do not live there), wrote an
 * empty entity label, installed NO optional thesaurus while the wizard
 * pre-ticked three, silently ignored unknown flags (`--yes`), and no front end
 * wrote ONTOLOGY_SERVERS / CODE_SERVERS — so every fresh install's update panels
 * answered "No master servers are configured".
 *
 * WHAT IT OWNS:
 *  - the DEFAULTS (here and nowhere else — the CLI parser maps provided flags
 *    only, the wizard posts what the operator typed);
 *  - the .env sections, their order and their comments (config_persist renders
 *    them verbatim);
 *  - the step list, whose ids ARE the wizard router's action names
 *    (engine.ts INSTALL_ROUTER_ACTIONS — gated: every plan step is routable);
 *  - the update-server choice (A3): the official master by default, `[]` only
 *    on an explicit air-gapped answer;
 *  - the optional-thesaurus choice (A7): the shared default is
 *    defaultOptionalHierarchies(); a CORE tld (`lg`) is dropped with a note —
 *    the seed restore always activates it;
 *  - the domain-ontology choice (A4/A5/A6, 2026-10-09): `ontologies` (>= 1,
 *    default `oh`), the SOURCE the non-vendored ones come from (the first
 *    configured ontology server — official by default — or `ontology_source`, a
 *    local directory/archive), the install ORDER (the closure over the source's
 *    DECLARED dependencies, deps first — ontology_choice.ts) and the
 *    ACTIVE_ONTOLOGY_TLDS it writes (core + that order). A catalog beyond the
 *    vendored `oh` is resolved by the CALLER (ontology_catalog.ts — it may reach
 *    the network) and handed in; the plan itself never fetches.
 *  - the DECLARED THESAURUS dependencies (hierarchy60 `main: 'hierarchy1'`,
 *    2026-10-10): the thesauri the installed ontologies (and the vendored core)
 *    declare join the thesaurus set — a MANDATORY one always (a mandatory one
 *    that is not vendored refuses the plan), an OPTIONAL one unless the
 *    operator declines it (`declined_dependencies`, which also declines
 *    optional ONTOLOGY dependencies).
 *
 * WHAT IT NEVER CONTAINS: DEDALO_SUPERVISED. Supervision is declared by the
 * process manager that restarts the server (systemd unit, compose service,
 * the supervised package scripts), never by ../private/.env, which every launch
 * method reads alike (src/core/update/supervision.ts). The plan's key set is a
 * closed list; no answer can add a key to it.
 *
 * PURE AND CONFIG-FREE: imports only lang_catalog.ts, hierarchy_meta.ts,
 * ontology_choice.ts and src/config/pg_transport.ts (each config-free; the
 * vendored files they read are the only I/O). The
 * CLI builds the plan BEFORE it seeds the process environment that
 * src/config/config.ts freezes at import, so importing config (or the error
 * registry, or the db) from here would freeze the wrong configuration.
 * Gate: test/unit/install_plan_parity_tripwire.test.ts (CLI ≡ wizard).
 */

import { resolve } from 'node:path';
import { pgSocketProblem } from '../../config/pg_transport.ts';
import {
	defaultOptionalHierarchies,
	isCoreHierarchyTld,
	offeredHierarchies,
} from './hierarchy_meta.ts';
import { deriveLangConfig } from './lang_catalog.ts';
import {
	activeOntologyTldsOf,
	closeOntologyChoice,
	collectHierarchyDependencies,
	declarersOf,
	declinePolicy,
	type HierarchyDependency,
	hierarchyDependencyPlan,
	mergeOntologyCatalogs,
	normalizeDeclinedDependencies,
	normalizeOntologyChoice,
	type OntologyCatalog,
	type OntologyInstallRequest,
	type OntologySource,
	type OntologySourceView,
	ontologyCatalogNeeded,
	ontologyInstallRequest,
	ontologySourceLabel,
	ontologySourceView,
	vendoredCoreDeclarers,
	vendoredOntologyCatalog,
} from './ontology_choice.ts';

/** One master server entry, as ONTOLOGY_SERVERS / CODE_SERVERS carry it. */
export interface MasterServerEntry {
	readonly name: string;
	readonly url: string;
	readonly code: string;
}

/** The official master's JSON API endpoint (both ontology and code). */
export const OFFICIAL_MASTER_URL = 'https://v7.master.dedalo.dev/dedalo/core/api/v1/json/';

/**
 * The official entries — byte-equal to the catalog examples
 * (src/config/catalog/maintenance.ts, rendered into install/sample.env); the
 * parity gate parses those examples and holds them equal, so there is one truth.
 */
export const OFFICIAL_ONTOLOGY_SERVER: MasterServerEntry = Object.freeze({
	name: 'Official Dédalo Ontology server',
	url: OFFICIAL_MASTER_URL,
	code: 'x3a0B4Y020Eg9w',
});
export const OFFICIAL_CODE_SERVER: MasterServerEntry = Object.freeze({
	name: 'Official Dédalo code server',
	url: OFFICIAL_MASTER_URL,
	code: 'x3a0B4Y020Eg9w',
});

/** `official` = the official master (default); `none` = air-gapped, `[]` written. */
export type UpdateServersChoice = 'official' | 'none';

/** Every install step, in run order. Each id IS a wizard router action name. */
export const INSTALL_STEP_IDS = [
	'test_db_connection',
	'test_diffusion_connection',
	'test_mailer_connection',
	'persist_config',
	'check_directories',
	'stage_ontologies',
	'install_db_from_default_file',
	'install_ontologies',
	'set_root_pw',
	'install_hierarchies',
	'register_tools',
	'install_finish',
] as const;
export type InstallStepId = (typeof INSTALL_STEP_IDS)[number];

/** The normalized answers — the SAME key names the wizard posts. */
export interface InstallAnswers {
	db_hostname: string;
	db_port: string;
	db_socket: string;
	db_database: string;
	db_username: string;
	db_password: string;
	entity: string;
	entity_label: string;
	information: string;
	info_key: string;
	timezone: string;
	locale: string;
	langs: string[] | undefined;
	app_lang_default: string | undefined;
	data_lang_default: string | undefined;
	diffusion: boolean;
	mysql_hostname: string;
	mysql_port: string;
	mysql_socket: string;
	mysql_database: string;
	mysql_username: string;
	mysql_password: string;
	mailer: boolean;
	smtp_host: string;
	smtp_port: string;
	smtp_secure: string;
	smtp_user: string;
	smtp_pass: string;
	smtp_from: string;
	smtp_from_name: string;
	/** '' = not provided (the key is then not written, and a prior value survives). */
	media_path: string;
	unix_socket: string;
	media_access_mode: string;
	update_servers: UpdateServersChoice;
	/** OPTIONAL thesauri only — core tlds are removed (with a note). */
	hierarchies: string[];
	register_tools: boolean;
	/** The chosen DOMAIN ontologies (core removed, with a note); >= 1. */
	ontologies: string[];
	/**
	 * The OPTIONAL declared dependencies the operator declines (a TLD, or
	 * `<tld>:ontology35|hierarchy1`); [] = every optional dependency installed.
	 */
	declined_dependencies: string[];
	/**
	 * A local ontology source (dir or archive); '' = none. CLI-ONLY, enforced at
	 * the wizard door (config_persist.ts refuseWizardOnlyCliAnswers): it is a
	 * server filesystem path.
	 */
	ontology_source: string;
}

/** One .env assignment. `raw` = written verbatim (JSON), never envQuote'd. */
export interface EnvEntry {
	readonly key: string;
	readonly value: string;
	readonly raw: boolean;
}
export interface EnvSection {
	readonly comment: string;
	readonly entries: readonly EnvEntry[];
}

export interface InstallPlan {
	readonly answers: InstallAnswers;
	readonly langConfig: ReturnType<typeof deriveLangConfig>;
	/** The .env body sections, in file order. */
	readonly env: readonly EnvSection[];
	/** Every key the plan OWNS, in file order (DEDALO_SALT_STRING included). */
	readonly envKeys: readonly string[];
	readonly steps: readonly InstallStepId[];
	/**
	 * The thesauri install_hierarchies imports: the answer's, then every
	 * installable declared thesaurus dependency not already in it.
	 */
	readonly hierarchies: readonly string[];
	/** The thesauri the installed ontologies declare (mandatory ones cannot be declined). */
	readonly hierarchyDependencies: readonly HierarchyDependency[];
	/** The chosen domain ontologies (before their dependency closure). */
	readonly ontologies: readonly string[];
	/** Where the non-vendored ontologies come from (never the access code). */
	readonly ontologySource: OntologySourceView;
	/** What stage_ontologies stages, deps first; null when the plan has errors. */
	readonly ontologyRequest: OntologyInstallRequest | null;
	/** The ACTIVE_ONTOLOGY_TLDS this plan writes: core + the install order. */
	readonly activeOntologyTlds: readonly string[];
	readonly notes: readonly string[];
	/** Non-blocking (e.g. an ontology whose dependencies the source does not declare). */
	readonly warnings: readonly string[];
	/** Empty = valid. */
	readonly errors: readonly string[];
}

type RawAnswers = Readonly<Record<string, unknown>>;

// ── normalization ────────────────────────────────────────────────────────────

/** A posted value as text; absent (undefined/null) is ''. */
function text(raw: RawAnswers, key: string): string {
	const value = raw[key];
	return value === undefined || value === null ? '' : String(value);
}

/** A posted value as text, with the plan's default when absent or empty. */
function textOr(raw: RawAnswers, key: string, fallback: string): string {
	const value = text(raw, key);
	return value === '' ? fallback : value;
}

/** An optional value: absent stays undefined (deriveLangConfig picks its own default). */
function optionalText(raw: RawAnswers, key: string): string | undefined {
	const value = raw[key];
	return value === undefined || value === null ? undefined : String(value);
}

/** A comma string or an array → trimmed, non-empty entries. */
function listOf(value: unknown): string[] {
	const items = Array.isArray(value) ? value : String(value).split(',');
	return items.map((item) => String(item).trim()).filter((item) => item !== '');
}

/** langs: absent → undefined (the default working languages); otherwise the listed codes. */
function parseLangs(value: unknown): string[] | undefined {
	return value === undefined || value === null ? undefined : listOf(value);
}

/** update_servers: absent/true/'official' → official; false/'none' → none. */
function parseUpdateServers(value: unknown, errors: string[]): UpdateServersChoice {
	if (value === undefined || value === true || value === 'official') return 'official';
	if (value === false || value === 'none') return 'none';
	errors.push('update_servers must be official|none');
	return 'official';
}

/** The requested thesauri before the core/vendored filter. */
function requestedHierarchies(value: unknown): string[] {
	if (value === undefined || value === null || value === 'default') {
		return defaultOptionalHierarchies();
	}
	if (value === 'none') return [];
	return listOf(value).map((tld) => tld.toLowerCase());
}

/** Drop core tlds (noted) and refuse unvendored ones; de-duplicated, order kept. */
function parseHierarchies(value: unknown, notes: string[], errors: string[]): string[] {
	const offered = new Set(offeredHierarchies().map((meta) => meta.tld));
	const picked: string[] = [];
	for (const tld of requestedHierarchies(value)) {
		if (isCoreHierarchyTld(tld)) {
			notes.push(`${tld} is a core hierarchy (always activated) — dropped from the list`);
		} else if (!offered.has(tld)) {
			errors.push(`unknown hierarchy '${tld}' (not vendored)`);
		} else if (!picked.includes(tld)) {
			picked.push(tld);
		}
	}
	return picked;
}

/**
 * The thesaurus answer ALONE, normalized exactly as buildInstallPlan does —
 * lowercased, de-duplicated, a core tld dropped with a note, an unvendored one
 * an error. The wizard's install_hierarchies step posts its own ticked list
 * AFTER persist_config (engine.ts), so it runs this on that post: the same answer
 * reaches the same thesauri through the CLI and the wizard.
 */
export function normalizeHierarchyChoice(value: unknown): {
	hierarchies: string[];
	notes: string[];
	errors: string[];
} {
	const notes: string[] = [];
	const errors: string[] = [];
	const hierarchies = parseHierarchies(value, notes, errors);
	return { hierarchies, notes, errors };
}

/** The required answers: empty → "<key> is required". */
function requireAnswers(answers: InstallAnswers, errors: string[]): void {
	for (const key of ['db_database', 'db_username', 'entity'] as const) {
		if (answers[key] === '') errors.push(`${key} is required`);
	}
	// An empty host would persist a DISABLED mailer — refuse the contradiction.
	if (answers.mailer && answers.smtp_host === '') errors.push('mailer requires smtp_host');
	// A relative socket would refuse the boot (config.ts) — refuse it here first.
	const socketProblem = pgSocketProblem(answers.db_socket);
	if (socketProblem !== null) errors.push(`db_socket: ${socketProblem}`);
}

/** Database + entity + locale answers (the plan's defaults live here). */
function coreAnswers(raw: RawAnswers) {
	const entity = text(raw, 'entity');
	return {
		db_hostname: textOr(raw, 'db_hostname', 'localhost'),
		db_port: textOr(raw, 'db_port', '5432'),
		db_socket: text(raw, 'db_socket'),
		db_database: text(raw, 'db_database'),
		db_username: text(raw, 'db_username'),
		db_password: text(raw, 'db_password'),
		entity,
		entity_label: textOr(raw, 'entity_label', entity),
		information: textOr(raw, 'information', 'ts-install'),
		info_key: textOr(raw, 'info_key', 'ts'),
		timezone: textOr(raw, 'timezone', 'Europe/Madrid'),
		locale: textOr(raw, 'locale', 'es-ES'),
		langs: parseLangs(raw.langs),
		app_lang_default: optionalText(raw, 'app_lang_default'),
		data_lang_default: optionalText(raw, 'data_lang_default'),
	};
}

/** The optional services: diffusion (MariaDB), mailer (SMTP), serving/media. */
function serviceAnswers(raw: RawAnswers) {
	return {
		diffusion: raw.diffusion === true,
		mysql_hostname: textOr(raw, 'mysql_hostname', 'localhost'),
		mysql_port: textOr(raw, 'mysql_port', '3306'),
		mysql_socket: text(raw, 'mysql_socket'),
		mysql_database: text(raw, 'mysql_database'),
		mysql_username: text(raw, 'mysql_username'),
		mysql_password: text(raw, 'mysql_password'),
		mailer: raw.mailer === true,
		smtp_host: text(raw, 'smtp_host'),
		smtp_port: textOr(raw, 'smtp_port', '587'),
		smtp_secure: textOr(raw, 'smtp_secure', 'tls'),
		smtp_user: text(raw, 'smtp_user'),
		smtp_pass: text(raw, 'smtp_pass'),
		smtp_from: text(raw, 'smtp_from'),
		smtp_from_name: text(raw, 'smtp_from_name'),
		media_path: text(raw, 'media_path'),
		unix_socket: text(raw, 'unix_socket'),
		media_access_mode: text(raw, 'media_access_mode'),
	};
}

/** Raw answers (wizard post or CLI flags) → normalized answers + notes + errors. */
export function normalizeInstallAnswers(raw: RawAnswers): {
	answers: InstallAnswers;
	notes: string[];
	errors: string[];
} {
	const notes: string[] = [];
	const errors: string[] = [];
	const ontologyChoice = normalizeOntologyChoice(raw.ontologies);
	const declinedChoice = normalizeDeclinedDependencies(raw.declined_dependencies);
	const answers: InstallAnswers = {
		...coreAnswers(raw),
		...serviceAnswers(raw),
		update_servers: parseUpdateServers(raw.update_servers, errors),
		hierarchies: parseHierarchies(raw.hierarchies, notes, errors),
		register_tools: raw.register_tools !== false,
		ontologies: ontologyChoice.ontologies,
		declined_dependencies: declinedChoice.declined,
		ontology_source: text(raw, 'ontology_source'),
	};
	requireAnswers(answers, errors);
	return {
		answers,
		notes: [...notes, ...ontologyChoice.notes],
		errors: [...errors, ...ontologyChoice.errors, ...declinedChoice.errors],
	};
}

// ── the .env sections ───────────────────────────────────────────────────────

const entry = (key: string, value: string, raw = false): EnvEntry => ({ key, value, raw });
type LangConfig = ReturnType<typeof deriveLangConfig>;

/*
 * CANONICAL SPELLINGS ONLY (2026-10-09). The plan writes the typed catalog's own
 * key names (DB_NAME, ENTITY, …), never a PHP_KEY_ALIASES fallback spelling
 * (DEDALO_DATABASE_CONN, DEDALO_ENTITY, …): the alias exists so a .env carried
 * over from the PHP engine keeps working, not as a second name to emit. Writing
 * the alias made a hand-added canonical line silently win over the installer's
 * own answer. config_persist drops a prior .env's alias line for every key the
 * plan writes, so a re-run never leaves one value under both names. Gate:
 * test/unit/install_persist_config.test.ts ('writes canonical key names').
 *
 * The socket answer is DB_SOCKET (2026-10-09). Before that the plan wrote
 * DEDALO_SOCKET_CONN, which the engine read NOWHERE — a socket-only install
 * passed the probe over the socket and then connected to DB_HOST. It is now
 * DB_SOCKET's PHP_KEY_ALIASES fallback spelling, read, never written.
 */
function databaseSection(a: InstallAnswers): EnvSection {
	return {
		comment: '# --- Database (PostgreSQL) ---',
		entries: [
			entry('DB_NAME', a.db_database),
			entry('DB_USER', a.db_username),
			entry('DB_PASSWORD', a.db_password),
			entry('DB_HOST', a.db_hostname),
			entry('DB_PORT', a.db_port),
			entry('DB_SOCKET', a.db_socket),
		],
	};
}

function entitySection(a: InstallAnswers): EnvSection {
	return {
		comment: '# --- Entity / locale ---',
		entries: [
			entry('ENTITY', a.entity),
			entry('DEDALO_ENTITY_LABEL', a.entity_label),
			entry('DEDALO_TIMEZONE', a.timezone),
			entry('DEDALO_LOCALE', a.locale),
		],
	};
}

/**
 * LANGUAGES (mandatory once configured — config.ts requires them whenever
 * INSTALL_MODE is false, so a config without them crash-loops at boot). The
 * map/array keys are RAW compact JSON: parseEnvFile strips surrounding quotes
 * but does not unescape inner \", so an envQuote'd JSON value would not
 * round-trip through JSON.parse.
 */
function langSection(l: LangConfig): EnvSection {
	return {
		comment: '# --- Languages (mandatory: config.ts refuses boot without them) ---',
		entries: [
			entry('DEDALO_APPLICATION_LANGS', JSON.stringify(l.applicationLangs), true),
			entry('PROJECTS_DEFAULT_LANGS', JSON.stringify(l.projectsDefaultLangs), true),
			entry('DEDALO_APPLICATION_LANGS_DEFAULT', l.applicationLangsDefault),
			entry('DEDALO_DATA_LANG_DEFAULT', l.dataLangDefault),
			entry('APPLICATION_LANG', l.applicationLangsDefault),
			entry('DATA_LANG', l.dataLangDefault),
			entry('DEDALO_STRUCTURE_LANG', l.structureLang),
		],
	};
}

function secretSection(salt: string): EnvSection {
	return {
		comment: '# --- Secret (coexistence: written for PHP; TS auth uses Argon2id) ---',
		entries: [entry('DEDALO_SALT_STRING', salt)],
	};
}

/**
 * A prior server list the operator CUSTOMISED: a JSON array with at least one
 * entry (a mirror, an extra master). `[]` is the air-gapped answer an earlier
 * run wrote, and an unparseable value configures nothing — neither is a choice
 * an explicit `official` answer may silently keep.
 */
function isCustomServerList(value: string | undefined): boolean {
	if (value === undefined) return false;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) && parsed.length > 0;
	} catch {
		return false;
	}
}

/**
 * UPDATE SERVERS (A3). Official by default; `none` (air-gapped) always writes
 * `[]` — an explicit answer the plan owns. PRESERVE RULE: with `official`, a key
 * whose prior .env value is a NON-EMPTY list is not re-emitted, so persist_config
 * carries the operator's line verbatim (mirrors they added survive a re-run). A
 * prior `[]` is NOT preserved: it is an earlier air-gapped answer, and keeping it
 * under an `official` answer would leave the install cut off from updates while
 * the front end showed the official server (the wizard re-save it invites).
 */
function updateServersSection(
	a: InstallAnswers,
	prior: Readonly<Record<string, string>>,
): EnvSection {
	const official = a.update_servers === 'official';
	const servers: [string, MasterServerEntry][] = [
		['ONTOLOGY_SERVERS', OFFICIAL_ONTOLOGY_SERVER],
		['CODE_SERVERS', OFFICIAL_CODE_SERVER],
	];
	return {
		comment:
			'# --- Update servers (ontology + code masters; [] = air-gapped, no updates offered) ---',
		entries: servers
			.filter(([key]) => !(official && isCustomServerList(prior[key])))
			.map(([key, server]) => entry(key, JSON.stringify(official ? [server] : []), true)),
	};
}

/** A JSON server list → its well-formed {name,url,code} entries ([] when it is not one). */
function serverEntries(value: string | undefined): MasterServerEntry[] {
	if (!isCustomServerList(value)) return [];
	return (JSON.parse(value as string) as unknown[]).filter(
		(item): item is MasterServerEntry =>
			typeof (item as MasterServerEntry | null)?.name === 'string' &&
			typeof (item as MasterServerEntry).url === 'string' &&
			typeof (item as MasterServerEntry).code === 'string',
	);
}

/**
 * The ontology servers the install will have configured — the allowlist a
 * manifest fetch is held to: none when air-gapped; else a prior CUSTOM list
 * (the same preserve rule updateServersSection applies), else the official one.
 */
export function ontologyServersFor(
	answers: Pick<InstallAnswers, 'update_servers'>,
	priorEnv: Readonly<Record<string, string>>,
): MasterServerEntry[] {
	if (answers.update_servers === 'none') return [];
	const custom = serverEntries(priorEnv.ONTOLOGY_SERVERS);
	return custom.length > 0 ? custom : [OFFICIAL_ONTOLOGY_SERVER];
}

/**
 * Where the non-vendored ontologies come from: a local `ontology_source`
 * (resolved to an absolute path), else the FIRST configured ontology server,
 * else none (air-gapped — only the vendored `oh`).
 */
export function ontologySourceFor(
	answers: Pick<InstallAnswers, 'update_servers' | 'ontology_source'>,
	priorEnv: Readonly<Record<string, string>>,
): OntologySource {
	if (answers.ontology_source !== '') {
		return { kind: 'local', path: resolve(answers.ontology_source) };
	}
	const server = ontologyServersFor(answers, priorEnv)[0];
	return server === undefined ? { kind: 'none' } : { kind: 'server', server: { ...server } };
}

/**
 * ONTOLOGIES: the TLDs this installation carries — core, then its domains in
 * install order (deps first). OWNED: rewritten on every run; the maintenance
 * update panel refreshes exactly these.
 */
function ontologiesSection(activeOntologyTlds: readonly string[]): EnvSection {
	return {
		comment:
			"# --- Ontologies (core + this installation's domains + their declared dependencies; the update panel refreshes exactly these) ---",
		entries: [entry('ACTIVE_ONTOLOGY_TLDS', JSON.stringify(activeOntologyTlds), true)],
	};
}

/**
 * Serving / media: written ONLY when provided, so a re-save that does not carry
 * them preserves a prior value instead of clobbering it. SERVER_UNIX_SOCKET is
 * the load-bearing one: its default mismatches a systemd + reverse-proxy deploy.
 */
function servingSection(a: InstallAnswers): EnvSection {
	const candidates = [
		entry('MEDIA_PATH', a.media_path),
		entry('SERVER_UNIX_SOCKET', a.unix_socket),
		entry('DEDALO_MEDIA_ACCESS_MODE', a.media_access_mode),
	];
	return {
		comment: '# --- Serving / media ---',
		entries: candidates.filter((candidate) => candidate.value !== ''),
	};
}

function diffusionSection(a: InstallAnswers): EnvSection {
	if (!a.diffusion) return { comment: '', entries: [] };
	return {
		comment: '# --- Diffusion (native TS engine, MariaDB target) ---',
		entries: [
			entry('DEDALO_DIFFUSION_NATIVE', 'true'),
			entry('DEDALO_DIFFUSION_DB_HOST', a.mysql_hostname),
			entry('DEDALO_DIFFUSION_DB_PORT', a.mysql_port),
			entry('DEDALO_DIFFUSION_DB_SOCKET', a.mysql_socket),
			entry('DEDALO_DIFFUSION_DB_USER', a.mysql_username),
			entry('DEDALO_DIFFUSION_DB_PASSWORD', a.mysql_password),
			entry('DEDALO_DIFFUSION_DB_NAME', a.mysql_database),
		],
	};
}

function mailerSection(a: InstallAnswers): EnvSection {
	if (!a.mailer) return { comment: '', entries: [] };
	return {
		comment: '# --- Outbound email (SMTP relay — password recovery) ---',
		entries: [
			entry('DEDALO_SMTP_HOST', a.smtp_host),
			entry('DEDALO_SMTP_PORT', a.smtp_port),
			entry('DEDALO_SMTP_SECURE', a.smtp_secure),
			entry('DEDALO_SMTP_USER', a.smtp_user),
			entry('DEDALO_SMTP_PASS', a.smtp_pass),
			entry('DEDALO_SMTP_FROM', a.smtp_from),
			entry('DEDALO_SMTP_FROM_NAME', a.smtp_from_name),
		],
	};
}

/** The .env body sections in file order; an empty section is omitted. */
function envSections(
	a: InstallAnswers,
	l: LangConfig,
	salt: string,
	prior: Readonly<Record<string, string>>,
	activeOntologyTlds: readonly string[],
): EnvSection[] {
	return [
		databaseSection(a),
		entitySection(a),
		langSection(l),
		secretSection(salt),
		updateServersSection(a, prior),
		ontologiesSection(activeOntologyTlds),
		servingSection(a),
		diffusionSection(a),
		mailerSection(a),
	].filter((section) => section.entries.length > 0);
}

/**
 * A .env is LINE-BASED: a CR/LF/NUL inside a value would split it into a second
 * `KEY=value` line (OPS-02 key injection). envQuote refuses it at write time;
 * the plan reports it up front so `--plan` and the wizard refuse BEFORE a write.
 */
function controlCharacterErrors(sections: readonly EnvSection[]): string[] {
	return sections
		.flatMap((section) => section.entries)
		.filter((item) => /[\r\n\0]/.test(item.value))
		.map((item) => `${item.key} contains an illegal control character`);
}

// ── the steps ────────────────────────────────────────────────────────────────

/** The step list: the optional probes and tool registration follow the answers. */
function installSteps(a: InstallAnswers): InstallStepId[] {
	const optional: Partial<Record<InstallStepId, boolean>> = {
		test_diffusion_connection: a.diffusion,
		test_mailer_connection: a.mailer,
		register_tools: a.register_tools,
	};
	return INSTALL_STEP_IDS.filter((step) => optional[step] !== false);
}

// ── the ontologies ───────────────────────────────────────────────────────────

interface PlannedOntologies {
	source: OntologySource;
	request: OntologyInstallRequest | null;
	activeOntologyTlds: string[];
	/** The declared thesauri (core declarers + the install order). */
	hierarchyDependencies: HierarchyDependency[];
	/** The vendored ones among them — what install_hierarchies adds. */
	hierarchyInstall: string[];
	notes: string[];
	warnings: string[];
	errors: string[];
}

/**
 * Whether the answers need a catalog resolved beyond the vendored one (the one
 * decision the CLI, persist_config and the plan share — a declined optional
 * dependency never makes a fetch necessary).
 */
export function planCatalogNeeded(answers: InstallAnswers, source: OntologySource): boolean {
	return ontologyCatalogNeeded(
		answers.ontologies,
		source,
		declinePolicy(answers.declined_dependencies),
	);
}

/**
 * The thesauri the plan declares: the vendored CORE entries' (the seed is
 * compiled from that release, so its core registry rows hold the same
 * declaration) followed by the install order's — ONE collection, so a thesaurus
 * any of them makes mandatory is mandatory.
 */
function plannedHierarchies(
	answers: InstallAnswers,
	order: readonly string[],
	catalog: OntologyCatalog,
	warnings: string[],
): HierarchyDependency[] {
	return collectHierarchyDependencies(
		[...vendoredCoreDeclarers(warnings), ...declarersOf(order, catalog)],
		declinePolicy(answers.declined_dependencies),
	).dependencies;
}

/** The closure of the chosen ontologies over the (merged) catalog. */
function closedOntologies(
	answers: InstallAnswers,
	source: OntologySource,
	catalog: OntologyCatalog,
): PlannedOntologies {
	const closure = closeOntologyChoice(
		answers.ontologies,
		catalog,
		declinePolicy(answers.declined_dependencies),
	);
	const coreWarnings: string[] = [];
	const hierarchyDependencies = plannedHierarchies(answers, closure.order, catalog, coreWarnings);
	const thesauri = hierarchyDependencyPlan(hierarchyDependencies);
	const usable = closure.errors.length === 0 && closure.order.length > 0;
	return {
		source,
		request: usable ? ontologyInstallRequest(closure.order, catalog) : null,
		activeOntologyTlds: activeOntologyTldsOf(closure.order),
		hierarchyDependencies,
		hierarchyInstall: thesauri.install,
		notes: closure.notes,
		warnings: [...catalog.warnings, ...closure.warnings, ...coreWarnings, ...thesauri.warnings],
		errors: [...closure.errors, ...thesauri.errors],
	};
}

/** The front end's programming error: a catalog the choice needs was not handed in. */
function unresolvedCatalog(source: OntologySource): string {
	return `the ontology catalog of ${ontologySourceLabel(source)} was not resolved`;
}

/**
 * The ontology half of the plan. A catalog the choice NEEDS (a local source, or
 * a non-vendored TLD from a server) must be handed in already resolved — its
 * absence is a programming error of the front end, reported, never fetched here.
 */
function planOntologies(
	answers: InstallAnswers,
	prior: Readonly<Record<string, string>>,
	given: OntologyCatalog | undefined,
): PlannedOntologies {
	const source = ontologySourceFor(answers, prior);
	if (given === undefined && planCatalogNeeded(answers, source)) {
		return {
			...closedOntologies(answers, source, vendoredOntologyCatalog()),
			request: null,
			errors: [unresolvedCatalog(source)],
		};
	}
	return closedOntologies(answers, source, mergeOntologyCatalogs(given, vendoredOntologyCatalog()));
}

/**
 * Answers → the whole plan. `salt` defaults to '' (the CLI's `--plan` has none);
 * `ontologyCatalog` is the resolved source catalog when the choice needs one
 * (ontology_catalog.ts resolveOntologyCatalog / resolvePlanCatalog).
 */
export function buildInstallPlan(
	raw: RawAnswers,
	context: {
		salt?: string;
		priorEnv?: Readonly<Record<string, string>>;
		ontologyCatalog?: OntologyCatalog;
	} = {},
): InstallPlan {
	const { answers, notes, errors } = normalizeInstallAnswers(raw);
	const prior = context.priorEnv ?? {};
	const langConfig = deriveLangConfig({
		langs: answers.langs,
		appLangDefault: answers.app_lang_default,
		dataLangDefault: answers.data_lang_default,
	});
	const ontologies = planOntologies(answers, prior, context.ontologyCatalog);
	const env = envSections(
		answers,
		langConfig,
		context.salt ?? '',
		prior,
		ontologies.activeOntologyTlds,
	);
	return {
		answers,
		langConfig,
		env,
		envKeys: env.flatMap((section) => section.entries.map((item) => item.key)),
		steps: installSteps(answers),
		hierarchies: [
			...answers.hierarchies,
			...ontologies.hierarchyInstall.filter((tld) => !answers.hierarchies.includes(tld)),
		],
		hierarchyDependencies: ontologies.hierarchyDependencies,
		ontologies: answers.ontologies,
		ontologySource: ontologySourceView(ontologies.source),
		ontologyRequest: ontologies.request,
		activeOntologyTlds: ontologies.activeOntologyTlds,
		notes: [...notes, ...ontologies.notes],
		warnings: ontologies.warnings,
		errors: [
			...errors,
			...ontologies.errors,
			...langConfig.errors.map((error) => `languages: ${error}`),
			...controlCharacterErrors(env),
		],
	};
}

/**
 * The process environment the CLI must hold BEFORE it imports config.ts: the
 * engine then resolves the REAL configuration (not install mode), the pool
 * targets the install database, and the four mandatory lang keys are present
 * (config.ts throws at import without them once ENTITY/DB are set).
 */
export function cliBootEnv(plan: InstallPlan): Record<string, string> {
	const a = plan.answers;
	const l = plan.langConfig;
	return {
		ENTITY: a.entity,
		DB_NAME: a.db_database,
		DB_HOST: a.db_hostname,
		DB_PORT: a.db_port,
		// The socket answer too: without it the CLI's pool would reach DB_HOST
		// while the probe and every psql step went through the socket.
		DB_SOCKET: a.db_socket,
		DB_USER: a.db_username,
		DB_PASSWORD: a.db_password,
		// The directory step's write-probe reads config.media.rootPath.
		...(a.media_path === '' ? {} : { MEDIA_PATH: a.media_path }),
		DEDALO_INSTALL_NO_RESTART: 'true', // the CLI never self-restarts
		DEDALO_APPLICATION_LANGS: JSON.stringify(l.applicationLangs),
		PROJECTS_DEFAULT_LANGS: JSON.stringify(l.projectsDefaultLangs),
		DEDALO_APPLICATION_LANGS_DEFAULT: l.applicationLangsDefault,
		DEDALO_DATA_LANG_DEFAULT: l.dataLangDefault,
		APPLICATION_LANG: l.applicationLangsDefault,
		DATA_LANG: l.dataLangDefault,
		DEDALO_STRUCTURE_LANG: l.structureLang,
	};
}

// ── the CLI front end's argv mapping ────────────────────────────────────────

/**
 * Every flag the CLI accepts. `key` is the answer it sets (null = a front-end
 * flag: --root-password, --plan, --list-ontologies). A bool flag sets `true`, except the negating
 * `--no-*` / `--skip-*` ones, which set `false`. NO DEFAULTS here — a flag that
 * is not given leaves its answer absent, and the plan's default applies.
 */
export const INSTALL_CLI_FLAGS: readonly {
	flag: string;
	key: string | null;
	kind: 'value' | 'bool';
}[] = Object.freeze([
	{ flag: '--db-host', key: 'db_hostname', kind: 'value' },
	{ flag: '--db-port', key: 'db_port', kind: 'value' },
	{ flag: '--db-socket', key: 'db_socket', kind: 'value' },
	{ flag: '--db-name', key: 'db_database', kind: 'value' },
	{ flag: '--db-user', key: 'db_username', kind: 'value' },
	{ flag: '--db-password', key: 'db_password', kind: 'value' },
	{ flag: '--entity', key: 'entity', kind: 'value' },
	{ flag: '--entity-label', key: 'entity_label', kind: 'value' },
	{ flag: '--information', key: 'information', kind: 'value' },
	{ flag: '--info-key', key: 'info_key', kind: 'value' },
	{ flag: '--timezone', key: 'timezone', kind: 'value' },
	{ flag: '--locale', key: 'locale', kind: 'value' },
	{ flag: '--langs', key: 'langs', kind: 'value' },
	{ flag: '--app-lang', key: 'app_lang_default', kind: 'value' },
	{ flag: '--data-lang', key: 'data_lang_default', kind: 'value' },
	{ flag: '--mysql-host', key: 'mysql_hostname', kind: 'value' },
	{ flag: '--mysql-port', key: 'mysql_port', kind: 'value' },
	{ flag: '--mysql-socket', key: 'mysql_socket', kind: 'value' },
	{ flag: '--mysql-name', key: 'mysql_database', kind: 'value' },
	{ flag: '--mysql-user', key: 'mysql_username', kind: 'value' },
	{ flag: '--mysql-password', key: 'mysql_password', kind: 'value' },
	{ flag: '--smtp-host', key: 'smtp_host', kind: 'value' },
	{ flag: '--smtp-port', key: 'smtp_port', kind: 'value' },
	{ flag: '--smtp-secure', key: 'smtp_secure', kind: 'value' },
	{ flag: '--smtp-user', key: 'smtp_user', kind: 'value' },
	{ flag: '--smtp-password', key: 'smtp_pass', kind: 'value' },
	{ flag: '--smtp-from', key: 'smtp_from', kind: 'value' },
	{ flag: '--smtp-from-name', key: 'smtp_from_name', kind: 'value' },
	{ flag: '--media-path', key: 'media_path', kind: 'value' },
	{ flag: '--socket', key: 'unix_socket', kind: 'value' },
	{ flag: '--media-access-mode', key: 'media_access_mode', kind: 'value' },
	{ flag: '--hierarchies', key: 'hierarchies', kind: 'value' },
	{ flag: '--ontologies', key: 'ontologies', kind: 'value' },
	{ flag: '--ontology-source', key: 'ontology_source', kind: 'value' },
	{ flag: '--decline-dependencies', key: 'declined_dependencies', kind: 'value' },
	{ flag: '--root-password', key: null, kind: 'value' },
	{ flag: '--diffusion', key: 'diffusion', kind: 'bool' },
	{ flag: '--mailer', key: 'mailer', kind: 'bool' },
	{ flag: '--no-update-servers', key: 'update_servers', kind: 'bool' },
	{ flag: '--skip-tools', key: 'register_tools', kind: 'bool' },
	{ flag: '--plan', key: null, kind: 'bool' },
	{ flag: '--list-ontologies', key: null, kind: 'bool' },
]);

const FLAGS_BY_NAME: ReadonlyMap<string, (typeof INSTALL_CLI_FLAGS)[number]> = new Map(
	INSTALL_CLI_FLAGS.map((spec) => [spec.flag, spec]),
);

export interface CliInstallInvocation {
	raw: Record<string, unknown>;
	rootPassword: string | undefined;
	planOnly: boolean;
	/** --list-ontologies: print the catalog view and exit (wins over --plan). */
	listOntologies: boolean;
	errors: string[];
}

/** A value flag's value, or the error that it has none. */
function flagValue(argv: readonly string[], index: number, flag: string, errors: string[]) {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith('--')) {
		errors.push(`${flag} needs a value`);
		return undefined;
	}
	return value;
}

/** Apply one parsed flag to the invocation. */
function applyFlag(
	invocation: CliInstallInvocation,
	spec: { flag: string; key: string | null; kind: 'value' | 'bool' },
	value: string | undefined,
): void {
	if (spec.flag === '--root-password') invocation.rootPassword = value;
	else if (spec.flag === '--plan') invocation.planOnly = true;
	else if (spec.flag === '--list-ontologies') invocation.listOntologies = true;
	else if (spec.kind === 'value') invocation.raw[spec.key as string] = value;
	else invocation.raw[spec.key as string] = !/^--(no|skip)-/.test(spec.flag);
}

/**
 * Consume the flag at `index` (and its value, for a value flag); answers how
 * many tokens it took. An unparseable token is recorded as an error and skipped.
 */
function consumeToken(
	argv: readonly string[],
	index: number,
	invocation: CliInstallInvocation,
): number {
	const token = argv[index] as string;
	const spec = FLAGS_BY_NAME.get(token);
	if (spec === undefined) {
		invocation.errors.push(
			token.startsWith('--') ? `unknown flag ${token}` : `unexpected argument '${token}'`,
		);
		return 1;
	}
	if (spec.kind === 'bool') {
		applyFlag(invocation, spec, undefined);
		return 1;
	}
	const value = flagValue(argv, index, token, invocation.errors);
	if (value === undefined) return 1;
	applyFlag(invocation, spec, value);
	return 2;
}

/**
 * argv → the raw answers the plan normalizes. Maps PROVIDED flags only (no
 * defaults); an unknown flag or a value flag without its value is an ERROR —
 * the old parser silently ignored both (`--yes` was accepted and meant nothing).
 */
export function answersFromCliArgs(argv: readonly string[]): CliInstallInvocation {
	const invocation: CliInstallInvocation = {
		raw: {},
		rootPassword: undefined,
		planOnly: false,
		listOntologies: false,
		errors: [],
	};
	for (let index = 0; index < argv.length; ) {
		index += consumeToken(argv, index, invocation);
	}
	return invocation;
}
