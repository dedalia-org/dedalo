/**
 * THE INSTALL PLAN — the ONE place an install's answers become a configuration
 * and a step list (installer unification A1, 2026-10-08). Every front end of the
 * ONE terminal installer is a front end of THIS: the full-screen UI and plain
 * mode (scripts/install.ts), flags, an answers file, and install.sh (which
 * drives it). The browser wizard that was a second front end was removed on
 * 2026-10-12 (WC-2026-10-12-install-surface-removed).
 *
 * WHY. Before this module each front end carried its own copy of the answers →
 * .env mapping and its own defaults, and they had drifted: the CLI defaulted
 * the database host to `/tmp` (Debian/RHEL sockets do not live there), wrote an
 * empty entity label, installed NO optional thesaurus while the (since retired)
 * browser wizard pre-ticked three, silently ignored unknown flags (`--yes`), and
 * no front end wrote ONTOLOGY_SERVERS / CODE_SERVERS — so every fresh install's update panels
 * answered "No master servers are configured".
 *
 * WHAT IT OWNS:
 *  - the DEFAULTS (here and nowhere else — the CLI parser maps provided flags
 *    only, the screens post what the operator typed);
 *  - the .env sections, their order and their comments (config_persist renders
 *    them verbatim);
 *  - the step list, whose ids ARE the rows of the executor's ONE step table
 *    (steps.ts — gated: every plan step has a row);
 *  - the update-server choice (A3): the official master by default, `[]` only
 *    on an explicit air-gapped answer;
 *  - the optional-thesaurus choice (A7; 2026-10-10): the offer is every
 *    non-core entry of the vendored thesaurus manifest (hierarchy.json, read
 *    through hierarchy_meta.ts), with or without data files; the DEFAULT answer
 *    is NO optional thesaurus — what is pre-selected comes only from the
 *    declared dependencies below. A CORE tld (`lg`) is dropped with a note —
 *    the seed restore always activates it. No toponymy is ever a default: a
 *    plan without one carries a SUGGESTION (`suggestions`) to import the
 *    operator's own country;
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
 *    declare join the thesaurus set PRE-TICKED, mandatory and optional alike,
 *    unless the operator declines them (`declined_dependencies`, which also
 *    declines optional ONTOLOGY dependencies). A thesaurus NEVER blocks the
 *    plan (owner decision 2026-10-10): a declined mandatory one, or one with
 *    no hierarchy.json entry, is a WARNING — strongly recommended, installable
 *    later from Maintenance › Install hierarchies.
 *
 *  - the ROUTE (terminal installer phase 2, 2026-10-12): `production` (a named
 *    INSTANCE on a shared host — multi_instance.md), `docker`, `trial` (Docker
 *    without media protection — install.sh's stack) or `developer` (absent = the
 *    engine steps on this host, the behaviour before routes existed). A route
 *    changes answer DEFAULTS only (routeDefaults — the instance-derived names of
 *    a production install, the compose stack's constants); the step list is the
 *    same on every route until the host steps land;
 *  - the FIELD TAGS of every refusal (`fieldErrors`): the same sentences as
 *    `errors`, each with the answer key it is about — what the terminal screen
 *    model (screen_model.ts) shows on each question.
 *
 * WHAT IT NEVER CONTAINS: DEDALO_SUPERVISED. Supervision is declared by the
 * process manager that restarts the server (systemd unit, compose service,
 * the supervised package scripts), never by ../private/.env, which every launch
 * method reads alike (src/core/update/supervision.ts). The plan's key set is a
 * closed list; no answer can add a key to it.
 *
 * PURE AND CONFIG-FREE: imports only lang_catalog.ts, hierarchy_meta.ts,
 * ontology_choice.ts and install_validation.ts (each config-free; the
 * vendored files they read are the only I/O; the validation's public-address
 * rule is the engine's own, src/core/resolve/public_reach_rule.ts, over the
 * SSRF guard's config-free verdict security/address_verdict.ts — gated by
 * no_install_surface_tripwire (c): this closure reaches no config reader). The
 * CLI builds the plan BEFORE it seeds the process environment that
 * src/config/config.ts freezes at import, so importing config (or the error
 * registry, or the db) from here would freeze the wrong configuration.
 * Gate: test/unit/install_plan_parity_tripwire.test.ts (TUI ≡ plain ≡ flags ≡ answers).
 */

import { resolve } from 'node:path';
import { DedaloError } from '../errors/dedalo_error.ts';
import { type DevCertificatePlan, devCertificatePlan } from './dev_certificate.ts';
import { type DevListenerPlan, devListenerPlan, devListenerWarnings } from './dev_listener.ts';
import {
	type HierarchyMeta,
	isCoreHierarchyTld,
	offeredHierarchies,
	TOPONYMY_TYPOLOGY_ID,
} from './hierarchy_meta.ts';
import {
	answerProblems,
	canonicalHostOf,
	canonicalPublicHost,
	DEFAULT_PUBLIC_PROTOCOL,
	ENGINE_DEFAULT_PROTOCOL,
	type FieldError,
	hostLocaleDefaults,
	INSTANCE_PATTERN,
	keptDevListenerProblems,
	NO_PUBLIC_HOST,
	rootPasswordErrors,
} from './install_validation.ts';
import { defaultImageSource } from './installer_identity.ts';
import { deriveLangConfig } from './lang_catalog.ts';
import {
	activeOntologyTldsOf,
	closeOntologyChoice,
	closeThesaurusChoice,
	declinePolicy,
	type HierarchyDependency,
	hierarchyDependencyPlan,
	mergeHierarchyDependencyLists,
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
	type ThesaurusChoiceClosure,
	vendoredCoreDeclarers,
	vendoredOntologyCatalog,
} from './ontology_choice.ts';
import { devTlsDir } from './paths.ts';

/** One master server entry, as ONTOLOGY_SERVERS / CODE_SERVERS carry it. */
export interface MasterServerEntry {
	readonly name: string;
	readonly url: string;
	readonly code: string;
}

/** The official master's JSON API endpoint (both ontology and code). */
export const OFFICIAL_MASTER_URL = 'https://master7.dedalo.dev/dedalo/core/api/v1/json/';

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

/**
 * The install ROUTES (owner decisions 2026-10-11): production (native services,
 * a named instance), docker (the compose stack), trial (Docker WITHOUT media
 * protection — its own route, so it says what it is) and developer (a git
 * checkout; the default when no route is given — the behaviour before routes).
 */
export const INSTALL_ROUTES = ['production', 'docker', 'trial', 'developer'] as const;
export type InstallRoute = (typeof INSTALL_ROUTES)[number];

/** Every install step, in run order. Each id IS a row of the step table (steps.ts). */
export const INSTALL_STEP_IDS = [
	'test_db_connection',
	'test_diffusion_connection',
	'test_mailer_connection',
	// developer route only (TODO-052): the checkout's devDependencies — `bun run dev` needs them
	'install_dev_dependencies',
	// developer route, local_ca only (TODO-055): the ONE generator's certificate, then this machine's trust
	'dev_tls_certificate',
	'dev_trust_ca',
	'persist_config',
	'check_directories',
	'stage_ontologies',
	'install_db_from_default_file',
	'install_ontologies',
	'set_root_pw',
	'install_hierarchies',
	'register_tools',
	'install_finish',
	// developer route only (TODO-053, D4): `bun run dev` started once — /health and a root
	// login over the development listener — then stopped. After the seal: the server boots only then.
	'verify_dev_server',
] as const;
export type InstallStepId = (typeof INSTALL_STEP_IDS)[number];

/**
 * The PRODUCTION route's HOST steps (terminal installer phase 4, 2026-10-12), in
 * run order — what the root process runs (src/core/install/host/host_table.ts);
 * `host_engine` runs the ENGINE steps above in a child, as the instance user.
 * Listed HERE (not under host/) because this module is on the server's import
 * closure and host/** must stay off it: the ids are data, the steps are not.
 * `host_selinux` is planned on every production install and decides itself
 * (RHEL family only); `host_web_http` is the Let's Encrypt challenge site.
 */
export const PRODUCTION_HOST_STEP_IDS = [
	'host_preflight',
	'host_packages',
	'host_identity',
	'host_runtime',
	'host_database',
	'host_engine',
	'host_units',
	'host_selinux',
	'host_first_boot',
	'host_watchdog',
	'host_web_http',
	'host_tls',
	'host_web_site',
	'host_public_probe',
	'host_backup_verify',
] as const;

/** The DOCKER/TRIAL routes' host steps (their table: host/stack/table.ts). */
export const STACK_HOST_STEP_IDS = [
	'stack_preflight',
	'stack_image',
	'stack_tls',
	'stack_files',
	'stack_database',
	'stack_engine',
	'stack_up',
	'stack_health',
] as const;

export type ProductionHostStepId = (typeof PRODUCTION_HOST_STEP_IDS)[number];
export type StackHostStepId = (typeof STACK_HOST_STEP_IDS)[number];
export type HostStepId = ProductionHostStepId | StackHostStepId;
/** Any step the one step loop (step_loop.ts) can run: an engine step or a host step. */
export type StepId = InstallStepId | HostStepId;

/** Every step id, engine and host (the fault seam's vocabulary). */
export const ALL_STEP_IDS: readonly StepId[] = Object.freeze([
	...INSTALL_STEP_IDS,
	...PRODUCTION_HOST_STEP_IDS,
	...STACK_HOST_STEP_IDS,
]);

/** Is `step` an ENGINE step (the executor's table)? */
export function isInstallStepId(step: string): step is InstallStepId {
	return (INSTALL_STEP_IDS as readonly string[]).includes(step);
}

/** The production web servers the host steps render a site file for. */
export const WEB_SERVERS = ['nginx', 'apache'] as const;
/**
 * TLS modes: production and docker letsencrypt|local_ca|files (local_ca on
 * production since 2026-10-16 — an isolated intranet with no public name);
 * trial is none.
 */
export const TLS_MODES = ['letsencrypt', 'files', 'local_ca', 'none'] as const;
/** The production database: created by the installer (peer role), or an existing one probed. */
export const DB_MODES = ['create', 'existing'] as const;
/** Where a docker/trial image comes from. */
export const IMAGE_SOURCES = ['official', 'custom', 'build'] as const;

/** The normalized answers — the SAME key names every front end posts. */
export interface InstallAnswers {
	/** The route (absent = developer). */
	route: InstallRoute;
	/** The production instance name ('' on every other route). */
	instance: string;
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
	 * A local ontology source (dir or archive); '' = none. A path on the
	 * installing machine's filesystem.
	 */
	ontology_source: string;
	// ── host steps (phase 4, 2026-10-12) ──
	/** production: 'nginx' | 'apache' | '' (= the one the host has, else nginx — decided at host_preflight). */
	web_server: string;
	/** production/docker: the public address (an FQDN, never localhost or an IP). */
	server_name: string;
	http_port: string;
	https_port: string;
	/**
	 * TLS_MODES, per route (production, docker: letsencrypt|local_ca|files; trial:
	 * none; developer: local_ca|none|files for its development listener — '' =
	 * the plan decides: the prior .env's pair when it has one, else local_ca, D1).
	 */
	tls_mode: string;
	/**
	 * local_ca only: the OTHER addresses staff type (a LAN name or an IPv4
	 * address — install_validation.ts; on the production route an IP must be
	 * this host's and no other instance's: host/production/address_claims.ts) — canonical `a,b` (lowercase, de-duplicated, '' = none). The
	 * leaf names them beside server_name and the authority is constrained to
	 * exactly that list (deploy/dedalo-tls-rotate.sh). See {@link extraTlsNames}.
	 */
	tls_extra_names: string;
	letsencrypt_email: string;
	/** Let's Encrypt's staging CA (a drill / a rate-limit-safe rehearsal). Flags only. */
	letsencrypt_staging: boolean;
	/** The institution's own certificate: absolute paths (fullchain + key), checked before use. */
	tls_cert_path: string;
	tls_key_path: string;
	/**
	 * developer: the development listener's port (SERVER_TCP_PORT) — '' = the
	 * plan decides: the prior .env's value when it has one (PRESERVE), else 3500
	 * (D3). dev_listener.ts.
	 */
	dev_port: string;
	/**
	 * developer: the address it binds (SERVER_TCP_HOST) — '' = the prior .env's,
	 * else 127.0.0.1 (this machine); 0.0.0.0 or one address opens it to the network.
	 */
	dev_host: string;
	/** production: 'create' (the installer creates role + database) | 'existing' (probed only). */
	db_mode: string;
	/**
	 * production: the INSTANCE DIR (owner decisions 2026-10-12 — any absolute
	 * path, default /home/ded_<i>): its code (dedalo/), private settings
	 * (private/) and backups (backups/). Created owned by the service user when
	 * missing; an existing one is used only when empty or already the user's.
	 */
	install_dir: string;
	/** production: the account the instance runs as (default ded_<i>; an existing one is used as is). */
	service_user: string;
	/** production: the group the web server joins ('' = the service user's own/primary group). */
	service_group: string;
	/** production: where the backup units write (default <install_dir>/backups). */
	backup_dir: string;
	/** production: this instance's backup also covers the host's site-builder store. Flags only. */
	backup_site_builder: boolean;
	/** docker/trial: IMAGE_SOURCES. */
	image_source: string;
	image_repository: string;
	/** docker/trial: the image tag ('' = this installer's own version). */
	image_version: string;
	/**
	 * The ENGINE steps only — the delegated child a host route starts (as the
	 * instance user, or inside the container). Flags only; recorded in the plan.
	 */
	engine_only: boolean;
	/**
	 * DEDALO_PG_BIN_PATH ('' = not written): the host's PostgreSQL 18 binaries,
	 * which the production route passes to its engine child from the OS row.
	 */
	pg_bin_path: string;
	// ── the public address (2026-11-07) ──
	/**
	 * DEDALO_HOST: how this installation names itself to other machines — the map
	 * tile proxy and the geo services identify it to OpenStreetMap as
	 * `dedalo/<v> (+<DEDALO_PROTOCOL><DEDALO_HOST>)` when an outside machine could
	 * reach it (resolve/public_reach.ts). `host[:port]`, trimmed and lowercased;
	 * '' = not given and 'none' = a private/intranet install (neither writes
	 * anything: a prior line survives). Asked on developer and trial; DERIVED on
	 * production and docker (server_name, plus `:<https_port>` when not 443), where
	 * an explicit value that differs is refused (one source of truth).
	 */
	public_host: string;
	/** DEDALO_PROTOCOL beside a public host: 'https://' (default) | 'http://'. */
	public_protocol: string;
	/**
	 * Keep a well-formed public host no outside machine reaches (an intranet
	 * name): written, but the engine still sends the shared identity. Without
	 * it such a host is refused (install_validation.ts).
	 */
	public_host_keep_private: boolean;
}

/**
 * EVERY answer key, classified — exhaustive at compile time (a new answer that
 * is not classified here fails to compile). A `secret` answer never leaves
 * memory: the terminal installer's plan file is built from the PLAIN keys only
 * (run_files.ts buildPlanFile — an allow-list, so a secret added later is
 * excluded by default), and an answers file may not carry one
 * (answersFromAnswersFile). The root password is not an answer at all — it is
 * the plan's own input (buildInstallPlan `rootPassword`).
 */
const ANSWER_CLASS: Readonly<Record<keyof InstallAnswers, 'secret' | 'plain'>> = Object.freeze({
	route: 'plain',
	instance: 'plain',
	db_hostname: 'plain',
	db_port: 'plain',
	db_socket: 'plain',
	db_database: 'plain',
	db_username: 'plain',
	db_password: 'secret',
	entity: 'plain',
	entity_label: 'plain',
	information: 'plain',
	info_key: 'plain',
	timezone: 'plain',
	locale: 'plain',
	langs: 'plain',
	app_lang_default: 'plain',
	data_lang_default: 'plain',
	diffusion: 'plain',
	mysql_hostname: 'plain',
	mysql_port: 'plain',
	mysql_socket: 'plain',
	mysql_database: 'plain',
	mysql_username: 'plain',
	mysql_password: 'secret',
	mailer: 'plain',
	smtp_host: 'plain',
	smtp_port: 'plain',
	smtp_secure: 'plain',
	smtp_user: 'plain',
	smtp_pass: 'secret',
	smtp_from: 'plain',
	smtp_from_name: 'plain',
	media_path: 'plain',
	unix_socket: 'plain',
	media_access_mode: 'plain',
	update_servers: 'plain',
	hierarchies: 'plain',
	register_tools: 'plain',
	ontologies: 'plain',
	declined_dependencies: 'plain',
	ontology_source: 'plain',
	web_server: 'plain',
	server_name: 'plain',
	http_port: 'plain',
	https_port: 'plain',
	tls_mode: 'plain',
	tls_extra_names: 'plain',
	letsencrypt_email: 'plain',
	letsencrypt_staging: 'plain',
	tls_cert_path: 'plain',
	tls_key_path: 'plain',
	dev_port: 'plain',
	dev_host: 'plain',
	db_mode: 'plain',
	install_dir: 'plain',
	service_user: 'plain',
	service_group: 'plain',
	backup_dir: 'plain',
	backup_site_builder: 'plain',
	image_source: 'plain',
	image_repository: 'plain',
	image_version: 'plain',
	engine_only: 'plain',
	pg_bin_path: 'plain',
	public_host: 'plain',
	public_protocol: 'plain',
	public_host_keep_private: 'plain',
});

/**
 * The answers that drive the HOST steps only — what the delegated engine child
 * is NOT given (host/production/engine_delegate.ts: engine answers ≡ the host
 * answers minus these, plus engine_only, the host-derived pg_bin_path and, on
 * production, backup_dir — the engine writes DEDALO_BACKUP_DIR from it, C3-55).
 */
export const HOST_ONLY_ANSWER_KEYS: readonly (keyof InstallAnswers)[] = Object.freeze([
	'web_server',
	'server_name',
	'http_port',
	'https_port',
	'tls_mode',
	'tls_extra_names',
	'letsencrypt_email',
	'letsencrypt_staging',
	'tls_cert_path',
	'tls_key_path',
	'db_mode',
	'install_dir',
	'service_user',
	'service_group',
	'backup_dir',
	'backup_site_builder',
	'image_source',
	'image_repository',
	'image_version',
]);

/** Every answer key, in declaration order (the answers file's key set). */
export const INSTALL_ANSWER_KEYS: readonly (keyof InstallAnswers)[] = Object.freeze(
	Object.keys(ANSWER_CLASS) as (keyof InstallAnswers)[],
);

/** The secret answers (derived from ANSWER_CLASS — never listed twice). */
export const SECRET_ANSWER_KEYS: readonly (keyof InstallAnswers)[] = Object.freeze(
	INSTALL_ANSWER_KEYS.filter((key) => ANSWER_CLASS[key] === 'secret'),
);

/** The plain answers — what a plan file may record. */
export const PLAIN_ANSWER_KEYS: readonly (keyof InstallAnswers)[] = Object.freeze(
	INSTALL_ANSWER_KEYS.filter((key) => ANSWER_CLASS[key] === 'plain'),
);

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
	/**
	 * The developer route's development listener (port, address, TLS, the
	 * derived cookie flag, what a re-run keeps); null on every other route.
	 */
	readonly devListener: DevListenerPlan | null;
	/**
	 * The developer listener's local-CA certificate (where, for which names);
	 * null unless it presents the generator's pair (dev_tls.ts).
	 */
	readonly devCertificate: DevCertificatePlan | null;
	/** Every key the plan OWNS, in file order (DEDALO_SALT_STRING included). */
	readonly envKeys: readonly string[];
	readonly steps: readonly StepId[];
	/**
	 * The thesauri install_hierarchies imports: the answer's, then every
	 * installable declared thesaurus dependency not already in it.
	 */
	readonly hierarchies: readonly string[];
	/**
	 * The thesauri the installed ontologies and the chosen thesauri declare and
	 * the answers do not decline (mandatory = strongly recommended, declinable).
	 */
	readonly hierarchyDependencies: readonly HierarchyDependency[];
	/**
	 * The thesauri the ONTOLOGY side declares (the vendored core + the install
	 * order) and the answers do not decline — before the chosen thesauri's own
	 * declarations are merged in. What a front end needs to tell "pre-ticked
	 * because an ontology needs it" from "pre-ticked because a ticked thesaurus
	 * declares it" (screen_model.ts thesaurus mapping).
	 */
	readonly ontologyHierarchyDependencies: readonly HierarchyDependency[];
	/**
	 * Advice shown to the operator, never a choice made for them — today the
	 * toponymy suggestion ({@link TOPONYMY_SUGGESTION}) when the plan installs
	 * no toponymy thesaurus.
	 */
	readonly suggestions: readonly string[];
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
	/**
	 * The root password's refusals (install_validation.ts rootPasswordErrors) —
	 * already merged into `errors`; [] when none was supplied and none required.
	 */
	readonly rootPasswordErrors: readonly string[];
	/** Empty = valid. */
	readonly errors: readonly string[];
	/**
	 * The answer-level refusals TAGGED with their answer key — every message is
	 * also in `errors` (byte-identical). Not tagged (review-level only): the .env
	 * control-character errors, a broken manifest, an unresolved catalog and the
	 * root password's (its own `rootPasswordErrors`).
	 */
	readonly fieldErrors: readonly FieldError[];
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

/**
 * A list of addresses (a comma/space string or an array) → its canonical
 * answer: lowercase, de-duplicated, in the order given, joined by `,`.
 */
function canonicalNameList(value: unknown): string {
	if (value === undefined || value === null) return '';
	const items = Array.isArray(value) ? value.map(String) : String(value).split(/[\s,]+/);
	const names = items.map((item) => item.trim().toLowerCase()).filter((item) => item !== '');
	return [...new Set(names)].join(',');
}

/** The extra local-CA addresses of the answers, as a list (the canonical answer split). */
export function extraTlsNames(answers: Pick<InstallAnswers, 'tls_extra_names'>): string[] {
	return answers.tls_extra_names === '' ? [] : answers.tls_extra_names.split(',');
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

/** route: absent/'' → developer (the behaviour before routes); else one of INSTALL_ROUTES. */
function parseRoute(value: unknown, problems: FieldError[]): InstallRoute {
	if (value === undefined || value === null || value === '') return 'developer';
	const route = String(value);
	if ((INSTALL_ROUTES as readonly string[]).includes(route)) return route as InstallRoute;
	problems.push({ key: 'route', message: `route must be ${INSTALL_ROUTES.join('|')}` });
	return 'developer';
}

/**
 * The answer defaults a ROUTE changes (D6). Everything else defaults alike on
 * every route.
 *  - production: the instance's own names (docs/install/multi_instance.md) —
 *    database `dedalo_<i>` owned by the PEER role `ded_<i>` (the instance's own
 *    unix user, over the local socket `/var/run/postgresql`: no database
 *    password exists at rest — phase 4, owner question Q2), media
 *    `/srv/dedalo/<i>/dedalo/media` (THE ROOT RULE: the site file's
 *    `root /srv/dedalo/<i>` + `/dedalo/media` must equal MEDIA_PATH — the
 *    pre-phase-4 `/srv/dedalo/<i>/media` could satisfy no root), socket
 *    `/run/dedalo-<i>/dedalo_ts.sock` (systemd RuntimeDirectory), the install
 *    folder `/home/ded_<i>` and the service user `ded_<i>` (LEVEL 1 — owner
 *    decisions 2026-10-12), then (LEVEL 2, derived from level 1) backups
 *    `<install_dir>/backups` (the code updater's `<tree>/../backups`) and the
 *    PEER role = the service user, publication database `web_<i>`, Let's
 *    Encrypt, a created database; '' while the instance is missing or
 *    malformed (its own error says so);
 *  - docker / trial: the compose stack's constants (install.sh passes the
 *    SAME values as explicit flags — an older pulled image does not know
 *    `--route`; gate: install_screen_model_tripwire); trial has no TLS;
 *  - developer: no database name or user (asked), media not written; its
 *    development listener (port, address, TLS mode) AND its socket (the
 *    entity's `/tmp/dedalo_ts_<entity>.sock`) are decided over the prior .env
 *    by dev_listener.ts — '' answers here, never a route default, so a re-run
 *    keeps what the operator already has (the PRESERVE rule).
 *  - DEDALO_MEDIA_ACCESS_MODE: `publication` on production (written, so the
 *    first boot never reports an unconfigured mode — C3-44); '' elsewhere.
 */
export interface RouteDefaults {
	readonly db_hostname: string;
	readonly db_socket: string;
	readonly db_database: string;
	readonly db_username: string;
	readonly media_path: string;
	readonly unix_socket: string;
	readonly mysql_database: string;
	readonly tls_mode: string;
	readonly db_mode: string;
	readonly install_dir: string;
	readonly service_user: string;
	readonly backup_dir: string;
	readonly image_source: string;
	/** DEDALO_MEDIA_ACCESS_MODE: production writes `publication` explicitly; elsewhere '' (not written). */
	readonly media_access_mode: string;
}

/** The level-1 answers the level-2 defaults (backup_dir, db_username) derive from. */
export interface IdentityLevel {
	readonly install_dir: string;
	readonly service_user: string;
}

const STACK_DEFAULTS: RouteDefaults = Object.freeze({
	db_hostname: 'postgres',
	db_socket: '',
	db_database: 'dedalo',
	db_username: 'dedalo',
	media_path: '/srv/dedalo/media',
	unix_socket: '/run/dedalo/dedalo_ts.sock',
	mysql_database: 'web_dedalo',
	tls_mode: 'letsencrypt',
	db_mode: '',
	install_dir: '',
	service_user: '',
	backup_dir: '',
	// The image source is the installer's identity's (stackDefaults): Official, or Build for a dev build.
	image_source: '',
	media_access_mode: '',
});

/**
 * The docker/trial defaults: the Image screen PRESELECTS Official for a stable
 * or prerelease installer and Build for a development build — no official image
 * is an untagged commit's code (installer_identity.ts, owner Q6). Read per call:
 * the identity is a process fact a gate may pin.
 */
function stackDefaults(): RouteDefaults {
	return { ...STACK_DEFAULTS, image_source: defaultImageSource() };
}

/** The local PostgreSQL socket directory a created (peer) production database is reached through. */
export const LOCAL_PG_SOCKET_DIR = '/var/run/postgresql';

/** The level-1 defaults of a production instance ('' while the instance is not valid). */
export function productionIdentityDefaults(instance: string): IdentityLevel {
	const named = INSTANCE_PATTERN.test(instance) ? instance : '';
	return named === ''
		? { install_dir: '', service_user: '' }
		: { install_dir: `/home/ded_${named}`, service_user: `ded_${named}` };
}

/**
 * A production instance's defaults (see RouteDefaults); '' names while the
 * instance is not valid. `level` = the level-1 answers as given (the backup
 * dir and the role derive from them, not from the instance).
 */
function productionDefaults(instance: string, level: IdentityLevel | null): RouteDefaults {
	const named = INSTANCE_PATTERN.test(instance) ? instance : '';
	const derive = (shape: (name: string) => string): string => (named === '' ? '' : shape(named));
	const identity = productionIdentityDefaults(instance);
	return {
		db_hostname: 'localhost',
		db_socket: LOCAL_PG_SOCKET_DIR,
		db_database: derive((name) => `dedalo_${name}`),
		media_path: derive((name) => `/srv/dedalo/${name}/dedalo/media`),
		unix_socket: derive((name) => `/run/dedalo-${name}/dedalo_ts.sock`),
		mysql_database: named === '' ? 'web_dedalo' : `web_${named}`,
		tls_mode: 'letsencrypt',
		db_mode: 'create',
		install_dir: identity.install_dir,
		service_user: identity.service_user,
		...levelTwoDefaults(named, level ?? identity),
		image_source: '',
		// Written, never left to the engine's fail-closed default: the same key
		// the host route and an `--engine-only` run both write (C3-44).
		media_access_mode: 'publication',
	};
}

/** The level-2 production defaults: the role and the backup dir follow the level-1 answers. */
function levelTwoDefaults(
	named: string,
	level: IdentityLevel,
): Pick<RouteDefaults, 'db_username' | 'backup_dir'> {
	if (named === '') return { db_username: '', backup_dir: '' };
	return {
		db_username: level.service_user,
		backup_dir: level.install_dir === '' ? '' : `${level.install_dir}/backups`,
	};
}

const DEVELOPER_DEFAULTS: RouteDefaults = Object.freeze({
	db_hostname: 'localhost',
	db_socket: '',
	db_database: '',
	db_username: '',
	media_path: '',
	unix_socket: '',
	mysql_database: 'web_dedalo',
	tls_mode: '',
	db_mode: '',
	install_dir: '',
	service_user: '',
	backup_dir: '',
	image_source: '',
	media_access_mode: '',
});

/**
 * The route's defaults. LEVELLED (owner decisions 2026-10-12): `level` — the
 * level-1 answers (install_dir, service_user) as the operator gave them — is
 * what the level-2 production defaults (backup_dir, db_username) derive from;
 * absent = the level-1 defaults themselves.
 */
export function routeDefaults(
	route: InstallRoute,
	instance: string,
	level: IdentityLevel | null = null,
): RouteDefaults {
	if (route === 'docker') return stackDefaults();
	if (route === 'trial') return { ...stackDefaults(), tls_mode: 'none' };
	if (route === 'production') return productionDefaults(instance, level);
	return DEVELOPER_DEFAULTS;
}

/**
 * The vendored thesaurus offer (every non-core hierarchy.json entry), or `[]`
 * plus the reader's refusal sentence in `errors` — the plan REPORTS a missing
 * or invalid manifest (the CLI prints it, --plan exits 1) instead of throwing
 * out of a pure function.
 */
export function offeredThesauri(errors: string[]): HierarchyMeta[] {
	try {
		return offeredHierarchies();
	} catch (error) {
		if (!(error instanceof DedaloError)) throw error;
		const sentence = error.publicMessage ?? error.message;
		if (!errors.includes(sentence)) errors.push(sentence);
		return [];
	}
}

/**
 * The requested thesauri before the core/offered filter. Absent or `default`
 * = NONE (2026-10-10): the only pre-selection is the declared dependencies,
 * which the plan adds itself (buildInstallPlan `hierarchies`). `none` = none.
 */
function requestedHierarchies(value: unknown): string[] {
	if (value === undefined || value === null || value === 'default' || value === 'none') {
		return [];
	}
	return listOf(value).map((tld) => tld.toLowerCase());
}

/** Drop core tlds (noted) and refuse ones hierarchy.json does not list; de-duplicated, order kept. */
function parseHierarchies(
	value: unknown,
	notes: string[],
	errors: string[],
	problems: FieldError[] = [],
): string[] {
	const requested = requestedHierarchies(value);
	if (requested.length === 0) return [];
	const offered = new Set(offeredThesauri(errors).map((meta) => meta.tld));
	const picked: string[] = [];
	for (const tld of requested) {
		if (isCoreHierarchyTld(tld)) {
			notes.push(`${tld} is a core hierarchy (always activated) — dropped from the list`);
		} else if (!offered.has(tld)) {
			const message = `unknown hierarchy '${tld}' (no entry in hierarchy.json)`;
			errors.push(message);
			problems.push({ key: 'hierarchies', message });
		} else if (!picked.includes(tld)) {
			picked.push(tld);
		}
	}
	return picked;
}

/**
 * THE toponymy suggestion — advice, never a default (owner decision
 * 2026-10-10: no country is ever pre-selected). The installer prints this
 * sentence.
 */
export const TOPONYMY_SUGGESTION =
	"No toponymy thesaurus is selected (none is ever pre-selected): consider importing your own country's toponymy — e.g. --hierarchies np for an install in Nepal. --list-hierarchies lists the codes.";

/**
 * The same advice for an INTERACTIVE run — its operator answers screens, not
 * flags (campaign 3 C3-64): the Thesauri step now, Maintenance after.
 */
export const TOPONYMY_SUGGESTION_INTERACTIVE =
	"No country toponymy is selected (none is ever pre-selected): consider your own country's — type its code on the Thesauri step (e.g. np), or install it after the install from Maintenance › Install hierarchies.";

/** A plan suggestion as an interactive run words it (the CLI flags' advice → the screens'). */
export function interactiveSuggestion(text: string): string {
	return text === TOPONYMY_SUGGESTION ? TOPONYMY_SUGGESTION_INTERACTIVE : text;
}

/**
 * Does `hierarchies` lack a COUNTRY toponymy? A country toponymy is a
 * typology-2 entry that SHIPS TERMS (data files). Thesauri ship empty by design
 * — only country toponymies and `lg` carry data — so a typology-2 entry WITHOUT
 * data files (`htoponymy`, the toponymy DEFINITION) is not one: counting it
 * would suppress the own-country suggestion for a plan that installs no place
 * at all (install test campaign finding L31). False when the offer has no
 * country toponymy (nothing to suggest).
 */
export function toponymyMissing(hierarchies: readonly string[], errors: string[]): boolean {
	const countries = new Set(
		offeredThesauri(errors)
			.filter((meta) => meta.typology_id === TOPONYMY_TYPOLOGY_ID && meta.data_files.length > 0)
			.map((meta) => meta.tld),
	);
	if (countries.size === 0) return false;
	return !hierarchies.some((tld) => countries.has(tld));
}

/** The suggestion when `hierarchies` holds no country toponymy of the offer; else none. */
function thesaurusSuggestions(hierarchies: readonly string[], errors: string[]): string[] {
	return toponymyMissing(hierarchies, errors) ? [TOPONYMY_SUGGESTION] : [];
}

/**
 * The socket answer: given, or the route's — production's local socket only
 * while the installer CREATES the database (an existing one is reached as the
 * operator says).
 */
function dbSocketOf(raw: RawAnswers, d: RouteDefaults): string {
	if (Object.hasOwn(raw, 'db_socket')) return text(raw, 'db_socket');
	return textOr(raw, 'db_mode', d.db_mode) === 'create' ? d.db_socket : '';
}

/** timezone/locale: given, else the host's own (read only when one is missing). */
function hostIdentityAnswers(raw: RawAnswers): { timezone: string; locale: string } {
	const given = { timezone: text(raw, 'timezone'), locale: text(raw, 'locale') };
	if (given.timezone !== '' && given.locale !== '') return given;
	const host = hostLocaleDefaults();
	return {
		timezone: given.timezone === '' ? host.timezone : given.timezone,
		locale: given.locale === '' ? host.locale : given.locale,
	};
}

/** Database + entity + locale answers (the plan's defaults live here; the route's in `d`). */
function coreAnswers(raw: RawAnswers, d: RouteDefaults) {
	const entity = text(raw, 'entity');
	return {
		db_hostname: textOr(raw, 'db_hostname', d.db_hostname),
		db_port: textOr(raw, 'db_port', '5432'),
		db_socket: dbSocketOf(raw, d),
		db_database: textOr(raw, 'db_database', d.db_database),
		db_username: textOr(raw, 'db_username', d.db_username),
		db_password: text(raw, 'db_password'),
		entity,
		entity_label: textOr(raw, 'entity_label', entity),
		information: textOr(raw, 'information', 'ts-install'),
		info_key: textOr(raw, 'info_key', 'ts'),
		// THIS machine's, never one institution's (C3-21): install_validation.ts.
		...hostIdentityAnswers(raw),
		langs: parseLangs(raw.langs),
		app_lang_default: optionalText(raw, 'app_lang_default'),
		data_lang_default: optionalText(raw, 'data_lang_default'),
	};
}

/** The optional services: diffusion (MariaDB), mailer (SMTP), serving/media. */
function serviceAnswers(raw: RawAnswers, d: RouteDefaults) {
	return {
		diffusion: raw.diffusion === true,
		mysql_hostname: textOr(raw, 'mysql_hostname', 'localhost'),
		mysql_port: textOr(raw, 'mysql_port', '3306'),
		mysql_socket: text(raw, 'mysql_socket'),
		mysql_database: textOr(raw, 'mysql_database', d.mysql_database),
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
		media_path: textOr(raw, 'media_path', d.media_path),
		unix_socket: textOr(raw, 'unix_socket', d.unix_socket),
		media_access_mode: textOr(raw, 'media_access_mode', d.media_access_mode),
	};
}

/** A posted bool: exactly `true` (a flag, a JSON true) — anything else is false. */
function flag(raw: RawAnswers, key: string): boolean {
	return raw[key] === true;
}

/**
 * The host-step answers (phase 4): web, TLS, database mode, backups, image.
 * Defaults by route (RouteDefaults); the ports are the web server's standard ones.
 */
function hostAnswers(raw: RawAnswers, d: RouteDefaults) {
	return {
		web_server: text(raw, 'web_server'),
		server_name: text(raw, 'server_name').toLowerCase(),
		http_port: textOr(raw, 'http_port', '80'),
		https_port: textOr(raw, 'https_port', '443'),
		tls_mode: textOr(raw, 'tls_mode', d.tls_mode),
		tls_extra_names: canonicalNameList(raw.tls_extra_names),
		letsencrypt_email: text(raw, 'letsencrypt_email'),
		letsencrypt_staging: flag(raw, 'letsencrypt_staging'),
		tls_cert_path: text(raw, 'tls_cert_path'),
		tls_key_path: text(raw, 'tls_key_path'),
		// '' = the plan decides (dev_listener.ts: the prior .env's, else the route default).
		dev_port: text(raw, 'dev_port').trim(),
		dev_host: text(raw, 'dev_host').trim(),
		db_mode: textOr(raw, 'db_mode', d.db_mode),
		install_dir: textOr(raw, 'install_dir', d.install_dir),
		service_user: textOr(raw, 'service_user', d.service_user),
		service_group: text(raw, 'service_group'),
		backup_dir: textOr(raw, 'backup_dir', d.backup_dir),
		backup_site_builder: flag(raw, 'backup_site_builder'),
		image_source: textOr(raw, 'image_source', d.image_source),
		image_repository: text(raw, 'image_repository'),
		image_version: text(raw, 'image_version'),
		engine_only: flag(raw, 'engine_only'),
		pg_bin_path: text(raw, 'pg_bin_path'),
	};
}

/** The routes whose public address is DERIVED from their web site (server_name), never asked. */
export function publicAddressDerived(route: InstallRoute): boolean {
	return route === 'production' || route === 'docker';
}

/**
 * The address a production or docker install serves: `server_name`, plus
 * `:<https_port>` when it is not 443 ('' while server_name is '' — the delegated
 * engine child is not given it, and takes the host's derived answer as given).
 */
export function derivedPublicHost(a: Pick<InstallAnswers, 'server_name' | 'https_port'>): string {
	if (a.server_name === '') return '';
	// CANONICAL, as the engine reads it: `0443` is 443 (no port), `08443` is 8443.
	const spelled = `${a.server_name}:${a.https_port}`;
	return canonicalHostOf(DEFAULT_PUBLIC_PROTOCOL, spelled) ?? spelled;
}

/** The public-address answers as given (the host canonical, the protocol defaulted). */
function givenPublicAddress(raw: RawAnswers) {
	return {
		public_host: canonicalPublicHost(raw.public_host),
		public_protocol: textOr(raw, 'public_protocol', DEFAULT_PUBLIC_PROTOCOL).trim(),
		public_host_keep_private: flag(raw, 'public_host_keep_private'),
	};
}

/**
 * Does an EXPLICIT host name the derived address? Compared as the engine reads both
 * (canonical, over https://), so `server:443` IS `server`.
 */
function namesDerivedHost(given: string, derived: string): boolean {
	return given === '' || canonicalHostOf(DEFAULT_PUBLIC_PROTOCOL, given) === derived;
}

/** The refusal of an explicit host on a deriving route ('' and the derived one are fine). */
function derivedHostConflict(given: string, derived: string, route: InstallRoute): string | null {
	if (given === NO_PUBLIC_HOST) {
		return `public_host none is not an answer on the ${route} route: its public address is the site's own (server_name and https_port: ${derived}) — leave public_host out`;
	}
	if (namesDerivedHost(given, derived)) return null;
	return `public_host ${JSON.stringify(given)} differs from the address the ${route} route derives from server_name and https_port (${derived}): leave it out — it is derived — or change server_name / https_port`;
}

/**
 * The refusals of an EXPLICIT public address on a route that derives it: `none`,
 * a host other than the derived one, a protocol other than https://.
 */
function derivedAddressConflicts(
	given: ReturnType<typeof givenPublicAddress>,
	derived: string,
	route: InstallRoute,
): FieldError[] {
	const conflicts: FieldError[] = [];
	const hostConflict = derivedHostConflict(given.public_host, derived, route);
	if (hostConflict !== null) conflicts.push({ key: 'public_host', message: hostConflict });
	if (given.public_protocol !== DEFAULT_PUBLIC_PROTOCOL) {
		conflicts.push({
			key: 'public_protocol',
			message: `public_protocol ${JSON.stringify(given.public_protocol)} differs from the ${route} route's ${DEFAULT_PUBLIC_PROTOCOL} (its web site serves HTTPS): leave it out — it is derived`,
		});
	}
	return conflicts;
}

/**
 * The public-address answers: as given on developer and trial (validated by
 * install_validation.ts); on production and docker the address their web site
 * serves (derivedPublicHost, over https://), an explicit differing one pushed to
 * `problems`. The derived value is written even when no outside machine
 * reaches it (a local-CA intranet): the Review says the engine then sends the
 * shared identity.
 */
function publicAddressAnswers(
	raw: RawAnswers,
	route: InstallRoute,
	hosting: Pick<InstallAnswers, 'server_name' | 'https_port'>,
	problems: FieldError[],
) {
	const given = givenPublicAddress(raw);
	const derived = publicAddressDerived(route) ? derivedPublicHost(hosting) : '';
	if (derived === '') return given;
	problems.push(...derivedAddressConflicts(given, derived, route));
	return { ...given, public_host: derived, public_protocol: DEFAULT_PUBLIC_PROTOCOL };
}

/**
 * Raw answers (screens, CLI flags or an answers file) → normalized answers + notes + errors
 * (+ the same refusals tagged by answer key, `fieldErrors`).
 */
export function normalizeInstallAnswers(raw: RawAnswers): {
	answers: InstallAnswers;
	notes: string[];
	errors: string[];
	fieldErrors: FieldError[];
} {
	const notes: string[] = [];
	const errors: string[] = [];
	const problems: FieldError[] = [];
	const route = parseRoute(raw.route, problems);
	const instance = text(raw, 'instance');
	// Level 1 first (the instance's own defaults), then every default derived from it.
	const identity = routeDefaults(route, instance);
	const defaults = routeDefaults(route, instance, {
		install_dir: textOr(raw, 'install_dir', identity.install_dir),
		service_user: textOr(raw, 'service_user', identity.service_user),
	});
	const ontologyChoice = normalizeOntologyChoice(raw.ontologies);
	const declinedChoice = normalizeDeclinedDependencies(raw.declined_dependencies);
	const serversErrors: string[] = [];
	const update_servers = parseUpdateServers(raw.update_servers, serversErrors);
	for (const message of serversErrors) problems.push({ key: 'update_servers', message });
	const hosting = hostAnswers(raw, defaults);
	const publicAddress = publicAddressAnswers(raw, route, hosting, problems);
	errors.push(...problems.map((item) => item.message));
	const answers: InstallAnswers = {
		route,
		instance,
		...coreAnswers(raw, defaults),
		...serviceAnswers(raw, defaults),
		update_servers,
		hierarchies: parseHierarchies(raw.hierarchies, notes, errors, problems),
		register_tools: raw.register_tools !== false,
		ontologies: ontologyChoice.ontologies,
		declined_dependencies: declinedChoice.declined,
		// Absolute HERE, against the operator's cwd: the production engine child runs in the
		// instance's tree and would resolve a relative path elsewhere (campaign C4 review).
		ontology_source: absoluteOrEmpty(text(raw, 'ontology_source')),
		...hosting,
		...publicAddress,
	};
	// Every answer-only refusal (install_validation.ts): raised HERE, before any
	// front end writes anything — the CLI argv, an answers file and the screens
	// all pass through this one call.
	const validation = answerProblems(answers);
	errors.push(...validation.map((item) => item.message));
	return {
		answers,
		notes: [...notes, ...ontologyChoice.notes],
		errors: [...errors, ...ontologyChoice.errors, ...declinedChoice.errors],
		fieldErrors: [
			...problems,
			...validation,
			...ontologyChoice.errors.map((message) => ({ key: 'ontologies', message })),
			...declinedChoice.errors.map((message) => ({ key: 'declined_dependencies', message })),
		],
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
 * LANGUAGES (mandatory once configured — config.ts requires them on every
 * configured box, so a config without them crash-loops at boot). The
 * map/array keys are RAW compact JSON, written verbatim: readable as-is by any
 * .env reader (parseEnvFile unescapes envQuote's \" since 2026-10-11, but a
 * shell or a container env-file does not).
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
		// No PHP-era wording in a TS install's .env (C3-60). The value is generated
		// once and preserved on every re-run, never rotated.
		comment: '# --- Install secret (generated once, kept on every re-run; never rotate it) ---',
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
 * the front end showed the official server (the re-run it invites).
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

/** A path answer made absolute against the current directory ('' stays '': not given). */
function absoluteOrEmpty(value: string): string {
	return value === '' ? '' : resolve(value);
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
 * the load-bearing one: its default mismatches a systemd + reverse-proxy deploy,
 * and on the developer route two checkouts on one machine would share it — so
 * there the listener plan decides it (dev_listener.ts: answered, kept or the
 * entity's own) and it is written unless kept.
 */
function servingSection(a: InstallAnswers, listener: DevListenerPlan | null): EnvSection {
	const socket =
		listener === null
			? [entry('SERVER_UNIX_SOCKET', a.unix_socket)]
			: listener.serving.map((item) => entry(item.key, item.value));
	const candidates = [
		entry('MEDIA_PATH', a.media_path),
		...socket,
		entry('DEDALO_MEDIA_ACCESS_MODE', a.media_access_mode),
		entry('DEDALO_PG_BIN_PATH', a.pg_bin_path),
		// The units' database-backup dir (production): the running server's
		// Maintenance backups and its directory check use the SAME directory the
		// backup units write, never a second <private>/backups/db (C3-55).
		entry('DEDALO_BACKUP_DIR', backupDbDir(a)),
	];
	return {
		comment: '# --- Serving / media ---',
		entries: candidates.filter((candidate) => candidate.value !== ''),
	};
}

/**
 * DEDALO_BACKUP_DIR of `a` ('' = not written): the units' backup dir + `/db`.
 * ONE spelling for the .env entry AND the CLI's boot environment (cliBootEnv),
 * so the directory the engine checks is the directory the .env records.
 */
export function backupDbDir(a: Pick<InstallAnswers, 'backup_dir'>): string {
	return a.backup_dir === '' ? '' : `${a.backup_dir}/db`;
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

/**
 * DEVELOPMENT ONLY (TODO-054): the developer route's listener and mode
 * (dev_listener.ts decides; null on every other route — production writes none
 * of these, the catalog says "unset in production"). The header says why the
 * keys exist to whoever reads the .env later.
 */
function devSection(listener: DevListenerPlan | null): EnvSection {
	if (listener === null) return { comment: '', entries: [] };
	return {
		comment:
			'# --- Development only (the developer route: `bun run dev` serves the browser here; never in production) ---',
		entries: listener.entries.map((item) => entry(item.key, item.value)),
	};
}

/**
 * THE PUBLIC ADDRESS (DEDALO_HOST + DEDALO_PROTOCOL): written when the answers
 * give a host (developer/trial) or derive one (production/docker); '' and
 * 'none' write NOTHING, so a prior line survives untouched (config_persist
 * carries every key the plan does not emit). PRESERVE RULE, per key: a prior
 * value EQUAL to the answer is not re-emitted, so the operator's line
 * round-trips byte for byte (its quoting included) — the protocol compared
 * with the prior literal, so a prior .env with no DEDALO_PROTOCOL (engine
 * default http://) gets the answer's written beside its kept DEDALO_HOST.
 * Nothing here ever writes a fallback: a host is written only as answered or
 * derived (never the `localhost` publicOrigin falls back to).
 */
function publicHostSection(a: InstallAnswers, prior: Readonly<Record<string, string>>): EnvSection {
	if (a.public_host === '' || a.public_host === NO_PUBLIC_HOST) return { comment: '', entries: [] };
	const entries = [
		...onlyIf(prior.DEDALO_HOST !== a.public_host, entry('DEDALO_HOST', a.public_host)),
		...onlyIf(
			effectivePriorProtocol(prior) !== a.public_protocol,
			entry('DEDALO_PROTOCOL', a.public_protocol),
		),
	];
	return {
		comment:
			'# --- Public address (how this installation names itself to other machines and to map/geo providers) ---',
		entries,
	};
}

/**
 * The protocol a prior .env already serves: its DEDALO_PROTOCOL literal; beside a
 * prior DEDALO_HOST with none, the ENGINE's default (the catalog's http://), which is
 * what that install runs on — so keeping it writes nothing; with no prior host at all,
 * undefined (a fresh public address always writes its protocol, explicit).
 */
function effectivePriorProtocol(prior: Readonly<Record<string, string>>): string | undefined {
	if (prior.DEDALO_PROTOCOL !== undefined) return prior.DEDALO_PROTOCOL;
	return prior.DEDALO_HOST === undefined ? undefined : ENGINE_DEFAULT_PROTOCOL;
}

/** `[item]` when `condition` holds, else `[]` (a conditional list entry). */
function onlyIf<T>(condition: boolean, item: T): T[] {
	return condition ? [item] : [];
}

/** The .env body sections in file order; an empty section is omitted. */
function envSections(
	a: InstallAnswers,
	l: LangConfig,
	salt: string,
	prior: Readonly<Record<string, string>>,
	activeOntologyTlds: readonly string[],
	listener: DevListenerPlan | null,
): EnvSection[] {
	return [
		databaseSection(a),
		entitySection(a),
		langSection(l),
		secretSection(salt),
		updateServersSection(a, prior),
		ontologiesSection(activeOntologyTlds),
		servingSection(a, listener),
		publicHostSection(a, prior),
		diffusionSection(a),
		mailerSection(a),
		devSection(listener),
	].filter((section) => section.entries.length > 0);
}

/**
 * A .env is LINE-BASED: a CR/LF/NUL inside a value would split it into a second
 * `KEY=value` line (OPS-02 key injection). envQuote refuses it at write time;
 * the plan reports it up front so `--plan` and every front end refuse BEFORE a write.
 */
function controlCharacterErrors(sections: readonly EnvSection[]): string[] {
	return sections
		.flatMap((section) => section.entries)
		.filter((item) => hasIllegalControlCharacter(item.value))
		.map((item) => `${item.key} contains an illegal control character`);
}

/**
 * THE .env line rule (CR/LF/NUL split a line — OPS-02): exported so a terminal
 * front end refuses a typed SECRET at the prompt, before the Review — the plan
 * only sees a secret when the run starts.
 */
export function hasIllegalControlCharacter(value: string): boolean {
	return /[\r\n\0]/.test(value);
}

// ── the steps ────────────────────────────────────────────────────────────────

/**
 * The ENGINE step list: the optional probes and tool registration follow the
 * answers; the development dependencies are the developer route's alone — a
 * host route's delegated engine child keeps its route's name (engine_only), and
 * production / docker / trial keep the bootstrap's `--production` tree.
 */
export function engineSteps(
	a: InstallAnswers,
	devCertificate: DevCertificatePlan | null = null,
): InstallStepId[] {
	const developer = a.route === 'developer' && !a.engine_only;
	const optional: Partial<Record<InstallStepId, boolean>> = {
		test_diffusion_connection: a.diffusion,
		test_mailer_connection: a.mailer,
		install_dev_dependencies: developer,
		// The local CA's certificate and this machine's trust in it (D1/D2): only
		// when the listener presents the generator's pair.
		dev_tls_certificate: developer && devCertificate !== null,
		dev_trust_ca: developer && devCertificate !== null,
		register_tools: a.register_tools,
		verify_dev_server: developer,
	};
	return INSTALL_STEP_IDS.filter((step) => optional[step] !== false);
}

/** The production host steps: the challenge site only for Let's Encrypt. */
function productionSteps(a: InstallAnswers): ProductionHostStepId[] {
	return PRODUCTION_HOST_STEP_IDS.filter(
		(step) => step !== 'host_web_http' || a.tls_mode === 'letsencrypt',
	);
}

/** The docker/trial host steps: no TLS step without TLS (trial). */
function stackSteps(a: InstallAnswers): StackHostStepId[] {
	return STACK_HOST_STEP_IDS.filter((step) => step !== 'stack_tls' || a.tls_mode !== 'none');
}

/**
 * THE step list (phase 4): a host route that is not the delegated engine child
 * runs its HOST steps (the engine steps run inside `host_engine` /
 * `stack_engine`, in a child); the developer route and every `engine_only`
 * child run the engine steps here.
 */
export function installSteps(
	a: InstallAnswers,
	devCertificate: DevCertificatePlan | null = null,
): StepId[] {
	if (a.engine_only) return engineSteps(a);
	if (a.route === 'production') return productionSteps(a);
	if (a.route === 'docker' || a.route === 'trial') return stackSteps(a);
	return engineSteps(a, devCertificate);
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
	/** The closure's refusals (an unknown chosen ontology, an unoffered mandatory one), tagged `ontologies`. */
	fieldErrors: FieldError[];
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

/** The closure of the chosen ontologies over the (merged) catalog. */
function closedOntologies(
	answers: InstallAnswers,
	source: OntologySource,
	catalog: OntologyCatalog,
): PlannedOntologies {
	// The thesauri the plan declares: the vendored CORE entries' (the seed is
	// compiled from that release, so its core registry rows hold the same
	// declaration) followed by the install order's — ONE collection, so a
	// thesaurus any of them makes mandatory is mandatory.
	const coreWarnings: string[] = [];
	const closure = closeOntologyChoice(
		answers.ontologies,
		catalog,
		declinePolicy(answers.declined_dependencies),
		{ coreDeclarers: vendoredCoreDeclarers(coreWarnings), chosenThesauri: answers.hierarchies },
	);
	const hierarchyDependencies = closure.hierarchies;
	// The offer is read only when something is declared (an empty declaration
	// never touches the manifest); a broken manifest is reported, not thrown.
	const manifestErrors: string[] = [];
	const offered =
		hierarchyDependencies.length === 0
			? new Set<string>()
			: new Set(offeredThesauri(manifestErrors).map((meta) => meta.tld));
	const thesauri = hierarchyDependencyPlan(hierarchyDependencies, offered);
	const usable = closure.errors.length === 0 && closure.order.length > 0;
	return {
		source,
		request: usable ? ontologyInstallRequest(closure.order, catalog) : null,
		activeOntologyTlds: activeOntologyTldsOf(closure.order),
		hierarchyDependencies,
		hierarchyInstall: thesauri.install,
		notes: closure.notes,
		warnings: [...catalog.warnings, ...closure.warnings, ...coreWarnings, ...thesauri.warnings],
		errors: [...closure.errors, ...manifestErrors],
		fieldErrors: closure.errors.map((message) => ({ key: 'ontologies', message })),
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
			fieldErrors: [],
		};
	}
	return closedOntologies(answers, source, mergeOntologyCatalogs(given, vendoredOntologyCatalog()));
}

/**
 * The thesaurus set closed over the CHOSEN thesauri's own declarations
 * (hierarchy.json entry.dependencies — ontology_choice.ts closeThesaurusChoice):
 * a declared thesaurus is added pre-ticked unless the answers decline it (a
 * declined mandatory one is a warning, never an error), a declared ontology
 * must be in the install. The manifest is read only when there is a choice to
 * close.
 */
function closedThesauri(
	chosen: readonly string[],
	answers: InstallAnswers,
	activeOntologyTlds: readonly string[],
): ThesaurusChoiceClosure & { choiceErrors: string[] } {
	if (chosen.length === 0) {
		return {
			hierarchies: [],
			dependencies: [],
			notes: [],
			warnings: [],
			errors: [],
			choiceErrors: [],
		};
	}
	const manifestErrors: string[] = [];
	const declarers = offeredThesauri(manifestErrors).map((meta) => ({
		tld: meta.tld,
		dependencies: meta.dependencies ?? null,
	}));
	const closure = closeThesaurusChoice(
		chosen,
		declarers,
		new Set(activeOntologyTlds),
		declinePolicy(answers.declined_dependencies),
	);
	// `choiceErrors`: the choice's own refusals (tagged `hierarchies`); a broken
	// manifest is review-level.
	return {
		...closure,
		errors: [...manifestErrors, ...closure.errors],
		choiceErrors: closure.errors,
	};
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
		/** The root password the run will set (never an answer — see ANSWER_CLASS). */
		rootPassword?: string;
		/** A fresh terminal install sets it, so it must be supplied. */
		requireRootPassword?: boolean;
		/** Where the developer route's local-CA material lives (default: paths.ts devTlsDir). */
		devTlsDir?: string;
		/** This machine's IPv4 network addresses (default: dev_tls.ts machineIpv4Addresses). */
		lanAddresses?: () => readonly string[];
	} = {},
): InstallPlan {
	const { answers, notes, errors, fieldErrors: answerFieldErrors } = normalizeInstallAnswers(raw);
	const passwordErrors = rootPasswordErrors(
		context.rootPassword,
		context.requireRootPassword === true,
	);
	const prior = context.priorEnv ?? {};
	const langConfig = deriveLangConfig({
		langs: answers.langs,
		appLangDefault: answers.app_lang_default,
		dataLangDefault: answers.data_lang_default,
	});
	const ontologies = planOntologies(answers, prior, context.ontologyCatalog);
	const tlsDir = context.devTlsDir ?? devTlsDir();
	const devListener = devListenerPlan(answers, prior, tlsDir);
	const devCertificate = devCertificatePlan(devListener, tlsDir, context.lanAddresses);
	const keptListenerErrors = [
		...keptDevListenerProblems(devListener),
		...(devCertificate?.errors ?? []),
	];
	const env = envSections(
		answers,
		langConfig,
		context.salt ?? '',
		prior,
		ontologies.activeOntologyTlds,
		devListener,
	);
	const thesauri = closedThesauri(
		[
			...answers.hierarchies,
			...ontologies.hierarchyInstall.filter((tld) => !answers.hierarchies.includes(tld)),
		],
		answers,
		ontologies.activeOntologyTlds,
	);
	const hierarchies = thesauri.hierarchies;
	const suggestionErrors: string[] = [];
	const suggestions = thesaurusSuggestions(hierarchies, suggestionErrors);
	return {
		answers,
		langConfig,
		env,
		devListener,
		devCertificate,
		envKeys: env.flatMap((section) => section.entries.map((item) => item.key)),
		steps: installSteps(answers, devCertificate),
		hierarchies,
		hierarchyDependencies: mergeHierarchyDependencyLists(
			ontologies.hierarchyDependencies,
			thesauri.dependencies,
		),
		ontologyHierarchyDependencies: ontologies.hierarchyDependencies,
		suggestions,
		ontologies: answers.ontologies,
		ontologySource: ontologySourceView(ontologies.source),
		ontologyRequest: ontologies.request,
		activeOntologyTlds: ontologies.activeOntologyTlds,
		notes: [...notes, ...ontologies.notes, ...thesauri.notes, ...(devCertificate?.notes ?? [])],
		warnings: [...ontologies.warnings, ...thesauri.warnings, ...devListenerWarnings(devListener)],
		rootPasswordErrors: passwordErrors,
		errors: [
			...new Set([
				...errors,
				...keptListenerErrors.map((item) => item.message),
				...ontologies.errors,
				...thesauri.errors,
				...suggestionErrors,
			]),
			...langConfig.errors.map((error) => `languages: ${error}`),
			...controlCharacterErrors(env),
			...passwordErrors,
		],
		fieldErrors: [
			...answerFieldErrors,
			...keptListenerErrors,
			...ontologies.fieldErrors,
			// A chosen thesaurus whose declared ontology is not installed (closeThesaurusChoice).
			...thesauri.choiceErrors.map((message) => ({ key: 'hierarchies', message })),
			...langConfig.fieldErrors.map((item) => ({
				key: item.key,
				message: `languages: ${item.message}`,
			})),
		],
	};
}

/**
 * The process environment the CLI must hold BEFORE it imports config.ts: the
 * engine then resolves the REAL configuration (not the unconfigured sentinels), the pool
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
		// …and config.ops.backupDir: the SAME directory persist_config writes as
		// DEDALO_BACKUP_DIR, from the first run on (C3-55 / campaign 3b N4: a fresh
		// `--engine-only` run checked and created <private>/backups/db, then its
		// --resume, booted from the written .env, found <backup_dir>/db missing).
		...(backupDbDir(a) === '' ? {} : { DEDALO_BACKUP_DIR: backupDbDir(a) }),
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
 * flag: --root-password, --plan, --list-ontologies, --answers, --resume, …). A
 * bool flag sets `true`, except the negating `--no-*` / `--skip-*` ones, which
 * set `false`. NO DEFAULTS here — a flag that is not given leaves its answer
 * absent, and the plan's default applies.
 */
export const INSTALL_CLI_FLAGS: readonly {
	flag: string;
	key: string | null;
	kind: 'value' | 'bool';
}[] = Object.freeze([
	{ flag: '--route', key: 'route', kind: 'value' },
	{ flag: '--instance', key: 'instance', kind: 'value' },
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
	// The host steps (phase 4, 2026-10-12).
	{ flag: '--web-server', key: 'web_server', kind: 'value' },
	{ flag: '--server-name', key: 'server_name', kind: 'value' },
	{ flag: '--http-port', key: 'http_port', kind: 'value' },
	{ flag: '--https-port', key: 'https_port', kind: 'value' },
	{ flag: '--tls', key: 'tls_mode', kind: 'value' },
	{ flag: '--tls-extra-names', key: 'tls_extra_names', kind: 'value' },
	{ flag: '--letsencrypt-email', key: 'letsencrypt_email', kind: 'value' },
	{ flag: '--tls-cert', key: 'tls_cert_path', kind: 'value' },
	{ flag: '--tls-key', key: 'tls_key_path', kind: 'value' },
	// The public address (DEDALO_HOST + DEDALO_PROTOCOL): developer and trial; derived elsewhere.
	{ flag: '--public-host', key: 'public_host', kind: 'value' },
	{ flag: '--public-protocol', key: 'public_protocol', kind: 'value' },
	// The developer route's development listener (DEV_ROUTE_SERVE §1.1).
	{ flag: '--dev-port', key: 'dev_port', kind: 'value' },
	{ flag: '--dev-host', key: 'dev_host', kind: 'value' },
	{ flag: '--db-mode', key: 'db_mode', kind: 'value' },
	{ flag: '--install-dir', key: 'install_dir', kind: 'value' },
	{ flag: '--service-user', key: 'service_user', kind: 'value' },
	{ flag: '--service-group', key: 'service_group', kind: 'value' },
	{ flag: '--backup-dir', key: 'backup_dir', kind: 'value' },
	{ flag: '--image-source', key: 'image_source', kind: 'value' },
	{ flag: '--image-repository', key: 'image_repository', kind: 'value' },
	{ flag: '--image-version', key: 'image_version', kind: 'value' },
	{ flag: '--pg-bin-path', key: 'pg_bin_path', kind: 'value' },
	{ flag: '--root-password', key: null, kind: 'value' },
	{ flag: '--diffusion', key: 'diffusion', kind: 'bool' },
	{ flag: '--mailer', key: 'mailer', kind: 'bool' },
	{ flag: '--no-update-servers', key: 'update_servers', kind: 'bool' },
	{ flag: '--skip-tools', key: 'register_tools', kind: 'bool' },
	{ flag: '--letsencrypt-staging', key: 'letsencrypt_staging', kind: 'bool' },
	{ flag: '--backup-site-builder', key: 'backup_site_builder', kind: 'bool' },
	{ flag: '--engine-only', key: 'engine_only', kind: 'bool' },
	{ flag: '--public-host-keep-private', key: 'public_host_keep_private', kind: 'bool' },
	{ flag: '--plan', key: null, kind: 'bool' },
	{ flag: '--list-ontologies', key: null, kind: 'bool' },
	{ flag: '--list-hierarchies', key: null, kind: 'bool' },
	// The terminal installer's run control (2026-10-11 — executor.ts).
	{ flag: '--answers', key: null, kind: 'value' },
	{ flag: '--resume', key: null, kind: 'bool' },
	{ flag: '--abort', key: null, kind: 'bool' },
	{ flag: '--confirm-database', key: null, kind: 'value' },
	{ flag: '--secrets-stdin', key: null, kind: 'bool' },
	{ flag: '--execute', key: null, kind: 'bool' },
	// The interactive front end (phase 2, 2026-10-12 — install_session.ts).
	{ flag: '--plain', key: null, kind: 'bool' },
	{ flag: '--write-answers', key: null, kind: 'value' },
	{ flag: '--list-langs', key: null, kind: 'bool' },
	// The delegated engine child's channels (phase 4 — a host route's parent reads them).
	{ flag: '--status', key: null, kind: 'bool' },
	{ flag: '--json', key: null, kind: 'bool' },
	{ flag: '--events-jsonl', key: null, kind: 'bool' },
	{ flag: '--request-stdin', key: null, kind: 'bool' },
]);

const FLAGS_BY_NAME: ReadonlyMap<string, (typeof INSTALL_CLI_FLAGS)[number]> = new Map(
	INSTALL_CLI_FLAGS.map((spec) => [spec.flag, spec]),
);

/** The flag that sets each answer key (for the answers-file conflict sentence). */
const FLAG_OF_KEY: ReadonlyMap<string, string> = new Map(
	INSTALL_CLI_FLAGS.filter((spec) => spec.key !== null).map((spec) => [
		spec.key as string,
		spec.flag,
	]),
);

/** The argv secret flags — still accepted in phase 1, each with a warning (visible in `ps`). */
export const ARGV_SECRET_FLAGS: readonly string[] = Object.freeze([
	'--db-password',
	'--mysql-password',
	'--smtp-password',
	'--root-password',
]);

export interface CliInstallInvocation {
	raw: Record<string, unknown>;
	rootPassword: string | undefined;
	planOnly: boolean;
	/** --list-ontologies: print the catalog view and exit (wins over --plan). */
	listOntologies: boolean;
	/** --list-hierarchies: print the thesaurus offer and exit (wins over --plan). */
	listHierarchies: boolean;
	/** --answers <file>: an answers file (dedalo.install.answers/1) merged with the flags. */
	answersFile: string | undefined;
	/** --resume: continue the install recorded in <private>/install/. */
	resume: boolean;
	/** --abort: undo the install recorded in <private>/install/. */
	abort: boolean;
	/** --confirm-database <name>: the database --abort may reset (must equal the plan's). */
	confirmDatabase: string | undefined;
	/** --secrets-stdin: read the secrets as ONE JSON object from stdin. */
	secretsStdin: boolean;
	/**
	 * --execute: explicitly headless — never prompts; a missing answer or secret
	 * is refused. Without it, a headless run on a terminal PROMPTS for a missing
	 * root password (fresh) or the secrets a resume still needs (scripts/install.ts).
	 * Recorded on the run (install.state.json runs[].execute).
	 */
	execute: boolean;
	/** --plain: the interactive front end in plain line mode (no full-screen UI, no colour). */
	plain: boolean;
	/** --write-answers <file>: write the reviewed answers as a dedalo.install.answers/1 file. */
	writeAnswersPath: string | undefined;
	/** --list-langs: print the language offer and exit. */
	listLangs: boolean;
	/**
	 * --status: print the saved install record's state and exit (with --json: ONE
	 * JSON line — how a host route's parent verifies its engine child, phase 4).
	 */
	status: boolean;
	json: boolean;
	/** --events-jsonl: the run's step events and its show-once lines as JSON lines on stdout. */
	eventsJsonl: boolean;
	/**
	 * --request-stdin: ONE JSON object on stdin — `{schema: 'dedalo.install.request/1',
	 * answers, secrets}` — how a host route's parent hands its engine child the
	 * answers AND the secrets without a file or an argv (phase 4, critique B10).
	 */
	requestStdin: boolean;
	/** The argv secret flags given (each earns a stderr warning). */
	argvSecretFlags: string[];
	errors: string[];
}

/**
 * A value flag's value, or the error that it has none. `--flag value` treats a
 * following `--…` token as a missing value; `--flag=value` carries ANY value
 * (one starting with `--`, an empty one) — the form cliArgsOf emits.
 */
function flagValue(argv: readonly string[], index: number, flag: string, errors: string[]) {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith('--')) {
		errors.push(`${flag} needs a value`);
		return undefined;
	}
	return value;
}

/** `--flag=value` → [flag, value]; any other token → [token, undefined]. */
function splitInlineValue(token: string): [string, string | undefined] {
	const at = token.indexOf('=');
	return token.startsWith('--') && at > 2
		? [token.slice(0, at), token.slice(at + 1)]
		: [token, undefined];
}

type FrontEndSetter = (invocation: CliInstallInvocation, value: string | undefined) => void;

/** The front-end flags (key: null) — each sets its own invocation field. */
const FRONT_END_SETTERS: ReadonlyMap<string, FrontEndSetter> = new Map<string, FrontEndSetter>([
	['--root-password', (invocation, value) => (invocation.rootPassword = value)],
	['--plan', (invocation) => (invocation.planOnly = true)],
	['--list-ontologies', (invocation) => (invocation.listOntologies = true)],
	['--list-hierarchies', (invocation) => (invocation.listHierarchies = true)],
	['--answers', (invocation, value) => (invocation.answersFile = value)],
	['--resume', (invocation) => (invocation.resume = true)],
	['--abort', (invocation) => (invocation.abort = true)],
	['--confirm-database', (invocation, value) => (invocation.confirmDatabase = value)],
	['--secrets-stdin', (invocation) => (invocation.secretsStdin = true)],
	['--execute', (invocation) => (invocation.execute = true)],
	['--plain', (invocation) => (invocation.plain = true)],
	['--write-answers', (invocation, value) => (invocation.writeAnswersPath = value)],
	['--list-langs', (invocation) => (invocation.listLangs = true)],
	['--status', (invocation) => (invocation.status = true)],
	['--json', (invocation) => (invocation.json = true)],
	['--events-jsonl', (invocation) => (invocation.eventsJsonl = true)],
	['--request-stdin', (invocation) => (invocation.requestStdin = true)],
]);

/** Apply one parsed flag to the invocation. */
function applyFlag(
	invocation: CliInstallInvocation,
	spec: { flag: string; key: string | null; kind: 'value' | 'bool' },
	value: string | undefined,
): void {
	if (ARGV_SECRET_FLAGS.includes(spec.flag)) invocation.argvSecretFlags.push(spec.flag);
	const setter = FRONT_END_SETTERS.get(spec.flag);
	if (setter !== undefined) setter(invocation, value);
	else if (spec.kind === 'value') invocation.raw[spec.key as string] = value;
	else invocation.raw[spec.key as string] = !/^--(no|skip)-/.test(spec.flag);
}

/** A `--flag=value` token: a value flag takes it; a bool flag refuses one. Takes one token. */
function applyInline(
	invocation: CliInstallInvocation,
	spec: (typeof INSTALL_CLI_FLAGS)[number],
	inline: string,
): number {
	if (spec.kind === 'bool') invocation.errors.push(`${spec.flag} takes no value`);
	else applyFlag(invocation, spec, inline);
	return 1;
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
	const [token, inline] = splitInlineValue(argv[index] as string);
	const spec = FLAGS_BY_NAME.get(token);
	if (spec === undefined) {
		invocation.errors.push(
			token.startsWith('--') ? `unknown flag ${token}` : `unexpected argument '${token}'`,
		);
		return 1;
	}
	if (inline !== undefined) return applyInline(invocation, spec, inline);
	if (spec.kind === 'bool') {
		applyFlag(invocation, spec, undefined);
		return 1;
	}
	const value = flagValue(argv, index, token, invocation.errors);
	if (value === undefined) return 1;
	applyFlag(invocation, spec, value);
	return 2;
}

/** Does the invocation continue a saved install (--resume or --abort)? */
const continuing = (invocation: CliInstallInvocation): boolean =>
	invocation.resume || invocation.abort;

/** Does the invocation ask for a listing (--list-*)? */
const listing = (invocation: CliInstallInvocation): boolean =>
	invocation.listOntologies || invocation.listHierarchies || invocation.listLangs;

/**
 * Is the invocation HEADLESS — does it already carry what it is to do? Any
 * answer (a flag that sets one), an answers file, `--plan`, a listing,
 * `--resume`/`--abort`, `--secrets-stdin`, `--execute` or `--root-password`.
 * Anything else (no flag, or only `--plain` / `--write-answers`) starts the
 * interactive front end (front_end.ts selectFrontEnd). Owner decision 4 ("piped
 * stdin without --answers is refused") is read as "without ANY answer source":
 * flags + `--secrets-stdin` piped stay headless — install.sh and the gates run so.
 */
export function isHeadlessInvocation(invocation: CliInstallInvocation): boolean {
	return HEADLESS_SOURCES.some((carries) => carries(invocation));
}

/** What makes an invocation headless (isHeadlessInvocation), one source each. */
const HEADLESS_SOURCES: readonly ((invocation: CliInstallInvocation) => boolean)[] = [
	(invocation) => Object.keys(invocation.raw).length > 0,
	(invocation) => invocation.answersFile !== undefined,
	(invocation) => invocation.planOnly,
	listing,
	continuing,
	(invocation) => invocation.secretsStdin,
	(invocation) => invocation.execute,
	(invocation) => invocation.rootPassword !== undefined,
	(invocation) => invocation.status,
	(invocation) => invocation.eventsJsonl,
	(invocation) => invocation.requestStdin,
];

/** Headless for a reason other than --resume (the one run control --plain may join: it prompts the secrets). */
const headlessBesidesResume = (invocation: CliInstallInvocation): boolean =>
	isHeadlessInvocation({ ...invocation, resume: false });

/**
 * The flags that make an invocation headless, by name — the offenders a --plain
 * refusal names (an answer flag by the key it sets; the run controls by flag).
 */
/** The run-control flags an invocation can set, in the order a refusal names them. */
const RUN_CONTROL_FLAGS: readonly {
	sets: (invocation: CliInstallInvocation) => boolean;
	flag: string;
}[] = [
	{ sets: (invocation) => invocation.answersFile !== undefined, flag: '--answers' },
	{ sets: (invocation) => invocation.planOnly, flag: '--plan' },
	{ sets: (invocation) => invocation.listOntologies, flag: '--list-ontologies' },
	{ sets: (invocation) => invocation.listHierarchies, flag: '--list-hierarchies' },
	{ sets: (invocation) => invocation.listLangs, flag: '--list-langs' },
	{ sets: (invocation) => invocation.secretsStdin, flag: '--secrets-stdin' },
	{ sets: (invocation) => invocation.execute, flag: '--execute' },
	{ sets: (invocation) => invocation.rootPassword !== undefined, flag: '--root-password' },
	{ sets: (invocation) => invocation.status, flag: '--status' },
	{ sets: (invocation) => invocation.eventsJsonl, flag: '--events-jsonl' },
	{ sets: (invocation) => invocation.requestStdin, flag: '--request-stdin' },
];

/** The flag an answer key sets: its registered flag, else the key spelled with dashes. */
const flagOfAnswerKey = (key: string): string =>
	FLAG_OF_KEY.get(key) ?? `--${key.replace(/_/g, '-')}`;

function headlessFlags(invocation: CliInstallInvocation): string[] {
	return [
		...Object.keys(invocation.raw).map(flagOfAnswerKey),
		...RUN_CONTROL_FLAGS.filter(({ sets }) => sets(invocation)).map(({ flag }) => flag),
	];
}

/** The --plain refusal: names the flags, and says where their answers go instead. */
const plainRefusal = (flags: readonly string[]): string =>
	`${flags.join(', ')} cannot be combined with --plain: give the answers on the interactive screens — --plain is the interactive front end and takes no answer flag, --answers, --plan, --list-*, --secrets-stdin, --execute or --root-password`;

/** The run-control combinations that cannot mean anything — each a parser error. */
const COMBINATION_RULES: readonly {
	refuses: (invocation: CliInstallInvocation) => boolean;
	/** A sentence, or one built from the invocation (the refusal names the offending flags). */
	error: string | ((invocation: CliInstallInvocation) => string);
}[] = Object.freeze([
	{
		refuses: (invocation) => invocation.resume && invocation.abort,
		error: '--resume and --abort exclude each other',
	},
	{
		refuses: (invocation) => invocation.planOnly && continuing(invocation),
		error: '--plan cannot be combined with --resume or --abort',
	},
	{
		refuses: (invocation) => listing(invocation) && continuing(invocation),
		error: '--list-* cannot be combined with --resume or --abort',
	},
	{
		refuses: (invocation) => invocation.plain && invocation.abort,
		error: '--plain cannot be combined with --abort',
	},
	{
		refuses: (invocation) =>
			invocation.plain && !invocation.abort && headlessBesidesResume(invocation),
		error: (invocation) => plainRefusal(headlessFlags(invocation)),
	},
	{
		refuses: (invocation) =>
			invocation.writeAnswersPath !== undefined && (continuing(invocation) || listing(invocation)),
		error: '--write-answers cannot be combined with --resume, --abort or --list-*',
	},
	{
		refuses: (invocation) => invocation.confirmDatabase !== undefined && !invocation.abort,
		error: '--confirm-database is only meaningful with --abort',
	},
	{
		refuses: (invocation) =>
			invocation.status && (continuing(invocation) || invocation.planOnly || listing(invocation)),
		error: '--status cannot be combined with --resume, --abort, --plan or --list-*',
	},
	{
		refuses: (invocation) => invocation.json && !invocation.status,
		error: '--json is only meaningful with --status',
	},
	{
		refuses: (invocation) =>
			invocation.requestStdin &&
			(invocation.secretsStdin ||
				invocation.answersFile !== undefined ||
				Object.keys(invocation.raw).length > 0),
		error:
			'--request-stdin carries the answers and the secrets: it takes no answer flag, --answers or --secrets-stdin',
	},
]);

/** The run-control combinations that cannot mean anything, as parser errors. */
function combinationErrors(invocation: CliInstallInvocation): string[] {
	return COMBINATION_RULES.filter((rule) => rule.refuses(invocation)).map((rule) =>
		typeof rule.error === 'string' ? rule.error : rule.error(invocation),
	);
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
		listHierarchies: false,
		answersFile: undefined,
		resume: false,
		abort: false,
		confirmDatabase: undefined,
		secretsStdin: false,
		execute: false,
		plain: false,
		writeAnswersPath: undefined,
		listLangs: false,
		status: false,
		json: false,
		eventsJsonl: false,
		requestStdin: false,
		argvSecretFlags: [],
		errors: [],
	};
	for (let index = 0; index < argv.length; ) {
		index += consumeToken(argv, index, invocation);
	}
	invocation.errors.push(...combinationErrors(invocation));
	return invocation;
}

// ── the answers file (--answers) ─────────────────────────────────────────────

/** The answers file's envelope schema. */
export const ANSWERS_FILE_SCHEMA = 'dedalo.install.answers/1';

/**
 * An answers file (already JSON-parsed) → raw answers + errors. The envelope is
 * `{schema: 'dedalo.install.answers/1', answers: {<the answers shape>}}`;
 * the key set is INSTALL_ANSWER_KEYS. A SECRET key is refused (a file is
 * copied, mailed and committed; secrets come from DEDALO_INSTALL_* or
 * --secrets-stdin), and so is an unknown one — never silently ignored.
 */
export function answersFromAnswersFile(json: unknown): {
	raw: Record<string, unknown>;
	errors: string[];
} {
	const answers = answersOfEnvelope(json);
	if (typeof answers === 'string') return { raw: {}, errors: [answers] };
	const raw: Record<string, unknown> = {};
	const errors: string[] = [];
	for (const [key, value] of Object.entries(answers)) {
		const refusal = answerFileKeyRefusal(key);
		if (refusal === null) raw[key] = value;
		else errors.push(refusal);
	}
	return { raw, errors };
}

/** Is `value` a plain JSON object (not null, not an array)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The envelope's `answers` object, or the refusal sentence. */
function answersOfEnvelope(json: unknown): Record<string, unknown> | string {
	if (!isPlainObject(json) || json.schema !== ANSWERS_FILE_SCHEMA) {
		return `answers file: schema must be ${ANSWERS_FILE_SCHEMA}`;
	}
	return isPlainObject(json.answers) ? json.answers : 'answers file: answers must be an object';
}

/** Why an answers-file key is refused (a secret, an unknown key), or null. */
function answerFileKeyRefusal(key: string): string | null {
	if ((SECRET_ANSWER_KEYS as readonly string[]).includes(key)) {
		return `answers file: '${key}' is a secret and is not accepted in a file — use DEDALO_INSTALL_* or --secrets-stdin`;
	}
	return (INSTALL_ANSWER_KEYS as readonly string[]).includes(key)
		? null
		: `answers file: unknown key '${key}'`;
}

/**
 * The INVERSE of answersFromAnswersFile: normalized answers → the answers-file
 * envelope (the plain keys only — a secret never enters a file; an undefined
 * one is omitted). What `--write-answers` and the interactive Review's `write`
 * produce; read back, it decides the same plan.
 */
export function answersFileOf(answers: InstallAnswers): {
	schema: typeof ANSWERS_FILE_SCHEMA;
	answers: Record<string, unknown>;
} {
	const plain: Record<string, unknown> = {};
	for (const key of PLAIN_ANSWER_KEYS) {
		if (answers[key] !== undefined) plain[key] = answers[key];
	}
	return { schema: ANSWERS_FILE_SCHEMA, answers: plain };
}

/** Two answer values as one comparable text. */
function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Does the answer need its bool flag? --diffusion/--mailer set true;
 * --no-update-servers (none) and --skip-tools (false) set the negation.
 */
function boolFlagSet(key: keyof InstallAnswers, flag: string, value: unknown): boolean {
	if (key === 'update_servers') return value === 'none';
	return /^--(no|skip)-/.test(flag) ? value === false : value === true;
}

/** An answer value as a flag value (a list comma-joined; an empty list `none`). */
function flagText(value: unknown): string {
	if (!Array.isArray(value)) return String(value);
	return value.length === 0 ? 'none' : value.join(',');
}

/** One answer as the argv that sets it (`--flag=value`; a bool flag bare), or [] when no flag can. */
function argvOfAnswer(key: keyof InstallAnswers, value: unknown): string[] {
	const spec = INSTALL_CLI_FLAGS.find((item) => item.key === key);
	if (spec === undefined) return [];
	if (spec.kind === 'bool') return boolFlagSet(key, spec.flag, value) ? [spec.flag] : [];
	return [`${spec.flag}=${flagText(value)}`];
}

/**
 * The INVERSE of answersFromCliArgs: normalized answers → the argv that decides
 * the same plan. Only the answers that differ from the route's own defaults are
 * emitted (a full flag list would bury the operator's choices), always in the
 * `--flag=value` form (a value may start with `--` or contain spaces); a secret
 * answer NEVER (it travels through DEDALO_INSTALL_* or --secrets-stdin).
 */
export function cliArgsOf(answers: InstallAnswers): string[] {
	const argv: string[] = [];
	for (const key of PLAIN_ANSWER_KEYS) {
		const value = answers[key];
		if (value === undefined || sameValue(value, baselineOf(answers, key)[key])) continue;
		if (derivedAnswer(answers, key)) continue;
		argv.push(...argvOfAnswer(key, value));
	}
	return argv;
}

/**
 * An answer the plan DERIVES on this route, so no flag restates it: the public
 * address of a production or docker install (server_name + https_port).
 */
function derivedAnswer(answers: InstallAnswers, key: keyof InstallAnswers): boolean {
	return (
		key.startsWith('public_') && publicAddressDerived(answers.route) && answers.server_name !== ''
	);
}

/** The answers OTHER defaults derive from, by level (see baselineOf). */
const LEVEL_0: readonly string[] = ['route', 'instance', 'entity'];
const LEVEL_1: readonly string[] = ['install_dir', 'service_user', 'service_group'];

/**
 * The defaults `key` is compared with: level 0 (route, instance, entity)
 * against the no-answer defaults; level 1 (the install folder and the service
 * account) against the defaults level 0 derives; every other answer against
 * the defaults levels 0 and 1 derive (the backup dir and the role follow the
 * install folder and the service user).
 */
function baselineOf(answers: InstallAnswers, key: string): InstallAnswers {
	if (LEVEL_0.includes(key)) return normalizeInstallAnswers({}).answers;
	const level0 = { route: answers.route, instance: answers.instance, entity: answers.entity };
	if (LEVEL_1.includes(key)) return normalizeInstallAnswers(level0).answers;
	return normalizeInstallAnswers({
		...level0,
		install_dir: answers.install_dir,
		service_user: answers.service_user,
		service_group: answers.service_group,
	}).answers;
}

/**
 * The flags' raw answers merged with an answers file's. NO PRECEDENCE: a key
 * both set is an error naming both sources, so a scripted install never runs on
 * an answer its author did not see win.
 */
export function mergeAnswerSources(
	flags: Readonly<Record<string, unknown>>,
	file: Readonly<Record<string, unknown>>,
): { raw: Record<string, unknown>; errors: string[] } {
	const errors = Object.keys(file)
		.filter((key) => Object.hasOwn(flags, key))
		.map((key) => `${key} is set by both --answers and ${FLAG_OF_KEY.get(key) ?? key}`);
	return { raw: { ...file, ...flags }, errors };
}
