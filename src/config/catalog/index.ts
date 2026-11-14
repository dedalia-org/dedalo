/**
 * CONFIG CATALOG — the merged key census.
 *
 * One file per domain; this merges them and fixes the ORDER the generated artifacts use
 * (install/sample.env sections and the settings-reference pages both follow DOMAINS).
 *
 * See `../catalog_types.ts` for what an entry means and why this exists at all.
 * IMPORT RULE: never import `config.ts` from here (it throws on a half-configured box).
 */

import type { CatalogEntry, ConfigScope } from '../catalog_types.ts';
import { AI_KEYS } from './ai.ts';
import { DB_KEYS } from './db.ts';
import { DEFAULTS_KEYS } from './defaults.ts';
import { DIFFUSION_KEYS } from './diffusion.ts';
import { ENTITY_KEYS } from './entity.ts';
import { ERROR_REPORT_KEYS } from './error_report.ts';
import { EXTERNAL_KEYS } from './external.ts';
import { INSTALL_KEYS } from './install.ts';
import { LANGS_KEYS } from './langs.ts';
import { LOCALE_KEYS } from './locale.ts';
import { MAILER_KEYS } from './mailer.ts';
import { MAINTENANCE_KEYS } from './maintenance.ts';
import { MEDIA_KEYS } from './media.ts';
import { MENU_KEYS } from './menu.ts';
import { OPS_KEYS } from './ops.ts';
import { PATHS_KEYS } from './paths.ts';
import { SECURITY_KEYS } from './security.ts';
import { SERVER_KEYS } from './server.ts';
import { SITEBUILDER_KEYS } from './sitebuilder.ts';
import { TOOLS_KEYS } from './tools.ts';

/** Section metadata. `id` is the STABLE anchor — never a number, which would shift. */
export interface ConfigDomain {
	readonly id: string;
	/** Which generated reference page the domain's keys land on. */
	readonly page: 'config' | 'config_db';
	readonly title: string;
	/** Narrative rendered BEFORE the domain's keys. Markdown. PHP-free (it lands in docs/). */
	readonly intro: string;
	/**
	 * Narrative rendered AFTER the domain's keys — worked examples, caveats that only make
	 * sense once the keys are known. Without it, the hand-written tail of a section would be
	 * swallowed the first time the generator ran. PHP-free.
	 */
	readonly outro?: string;
}

/** Emission order for BOTH generated artifacts. */
export const DOMAINS: readonly ConfigDomain[] = [
	{ id: 'paths', page: 'config', title: '**Main variables:** Paths', intro: '' },
	{ id: 'locale', page: 'config', title: 'Locale', intro: '' },
	{ id: 'entity', page: 'config', title: 'Entity', intro: '' },
	{ id: 'langs', page: 'config', title: 'Languages', intro: '' },
	{ id: 'defaults', page: 'config', title: 'Default variables', intro: '' },
	{ id: 'media', page: 'config', title: 'Media variables', intro: '' },
	{ id: 'menu', page: 'config', title: 'Menu variables', intro: '' },
	{ id: 'security', page: 'config', title: 'Security variables', intro: '' },
	{ id: 'server', page: 'config', title: 'Server and runtime', intro: '' },
	{
		id: 'mailer',
		page: 'config',
		title: 'Outbound email and password recovery',
		intro:
			"Dédalo relays outbound email (password-recovery codes) through an existing mailbox over SMTP — it never runs its own mail server. Leaving `DEDALO_SMTP_HOST` empty disables sending entirely, which also disables the login screen's password-recovery emails.",
	},
	{ id: 'ops', page: 'config', title: 'Logs, backups and diagnostics', intro: '' },
	{ id: 'error_report', page: 'config', title: 'Error reporting', intro: '' },
	{ id: 'ai', page: 'config', title: 'AI assistant, agent and semantic search', intro: '' },
	{
		id: 'external',
		page: 'config',
		title: 'External record services',
		intro:
			'Some ontology nodes resolve their values from a service outside Dédalo (a bibliographic catalogue, an authority file) rather than from the records stored here. These settings govern that outbound side: whether it runs at all, which hosts it may reach — nowhere, until you say so — and the ceilings that keep a slow or hostile service from becoming a slow or broken Dédalo.',
	},
	{ id: 'tools', page: 'config', title: 'Tools', intro: '' },
	{ id: 'sitebuilder', page: 'config', title: 'Site builder', intro: '' },
	{ id: 'install', page: 'config', title: 'Install', intro: '' },
	{ id: 'maintenance', page: 'config', title: 'Maintenance variables', intro: '' },
	{ id: 'diffusion', page: 'config', title: 'Diffusion variables', intro: '' },
	{ id: 'db', page: 'config_db', title: 'Work system database variables', intro: '' },
	{
		id: 'diffusion_db',
		page: 'config_db',
		title: 'Diffusion system database (MariaDB)',
		intro: [
			'The diffusion system database is the external, flat (publication) copy of the data, stored in MariaDB/MySQL: only public data is exported, relationships are pre-resolved, and the result is standard SQL tables/rows/columns.',
			'',
			'Every MariaDB operation — publish, delete, backup — is performed by the [diffusion engine](../../diffusion/native_engine.md) built into the work server.',
		].join('\n'),
		outro: [
			'The target database names come from the diffusion ontology (`database` node labels), and the databases must be **pre-created** — a missing database is a loud configuration error, never an auto-create. Create the database and its user with full privileges, e.g.:',
			'',
			'```sql',
			"CREATE USER 'username'@'localhost' IDENTIFIED BY 'password';",
			'GRANT ALL PRIVILEGES ON `web_dedalo`.* TO ' + "'username'@'localhost';",
			'```',
			'',
			'See [the diffusion engine → Configuration](../../diffusion/native_engine.md#configuration) for the full key set (resolve levels, output languages, runner concurrency).',
			'',
			'> The standalone **publication server** (`publication/server_api/`) is a separate, legacy deployable with its **own** read-only database config — see [server_config_api](../../diffusion/publication_api/server_config_api.md). That is independent of this work install’s database settings.',
		].join('\n'),
	},
];

/**
 * The MariaDB connection keys live in `diffusion.ts` beside the rest of the diffusion
 * family (that is where a developer looks for them), but they are DOCUMENTED on the
 * database page, where an administrator looks. Split by prefix rather than by moving the
 * code, so the two audiences each get the grouping they expect from one declaration.
 */
// The prefix is hoisted into a const on purpose. config_census_tripwire scans raw source
// for ANY call whose first argument is an uppercase string literal — comments included —
// so passing the prefix straight to startsWith would look exactly like an env read and be
// reported as an unclassified key. Keeping it out of call position keeps that gate honest.
const DIFFUSION_DB_PREFIX = 'DEDALO_DIFFUSION_DB_';
const isDiffusionDbKey = (key: string): boolean => key.startsWith(DIFFUSION_DB_PREFIX);

const pick = (
	source: Record<string, CatalogEntry>,
	keep: (key: string) => boolean,
): Record<string, CatalogEntry> =>
	Object.fromEntries(Object.entries(source).filter(([key]) => keep(key)));

const DOMAIN_KEYS: Record<string, Record<string, CatalogEntry>> = {
	paths: PATHS_KEYS,
	locale: LOCALE_KEYS,
	entity: ENTITY_KEYS,
	langs: LANGS_KEYS,
	defaults: DEFAULTS_KEYS,
	media: MEDIA_KEYS,
	menu: MENU_KEYS,
	security: SECURITY_KEYS,
	server: SERVER_KEYS,
	mailer: MAILER_KEYS,
	ops: OPS_KEYS,
	error_report: ERROR_REPORT_KEYS,
	ai: AI_KEYS,
	external: EXTERNAL_KEYS,
	tools: TOOLS_KEYS,
	sitebuilder: SITEBUILDER_KEYS,
	install: INSTALL_KEYS,
	maintenance: MAINTENANCE_KEYS,
	diffusion: pick(DIFFUSION_KEYS, (key) => !isDiffusionDbKey(key)),
	db: DB_KEYS,
	diffusion_db: pick(DIFFUSION_KEYS, isDiffusionDbKey),
};

/** key → entry, for every env key the engine reads. */
export const CONFIG_CATALOG: Readonly<Record<string, CatalogEntry>> = Object.freeze(
	Object.fromEntries(
		DOMAINS.flatMap((domain) =>
			Object.entries(DOMAIN_KEYS[domain.id] ?? {}).map(([key, entry]) => [key, entry]),
		),
	),
);

/** key → its domain id. */
export const KEY_DOMAIN: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(
		DOMAINS.flatMap((domain) =>
			Object.keys(DOMAIN_KEYS[domain.id] ?? {}).map((key) => [key, domain.id]),
		),
	),
);

/** The keys an administrator actually sets — the only ones the artifacts document. */
const OPERATOR_SCOPES: readonly ConfigScope[] = ['operator', 'secret'];
export const isOperatorFacing = (entry: CatalogEntry): boolean =>
	OPERATOR_SCOPES.includes(entry.scope);

/** Look up an entry, or throw — a typo in a key name must be loud, not `undefined`. */
export function catalogEntry(key: string): CatalogEntry {
	const entry = CONFIG_CATALOG[key];
	if (entry === undefined) {
		throw new Error(
			`Config key '${key}' is not in the catalog (src/config/catalog/). Every key the engine reads must be declared there — that is what keeps install/sample.env and the settings reference complete.`,
		);
	}
	return entry;
}

/** The credential placeholders a shipped template carries; check_config reads these. */
export const CATALOG_PLACEHOLDERS: readonly {
	key: string;
	value: string;
	emptyIsValid: boolean;
}[] = Object.entries(CONFIG_CATALOG)
	.filter(([, entry]) => entry.placeholder !== undefined)
	.map(([key, entry]) => ({
		key,
		value: (entry.placeholder as { value: string }).value,
		emptyIsValid: (entry.placeholder as { emptyIsValid?: boolean }).emptyIsValid === true,
	}));
