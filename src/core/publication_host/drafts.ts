/**
 * PUBLICATION-HOST DRAFTS — what the maintenance panel's "New publication host" form makes
 * (engineering/PUBLICATION_HOST_SPEC.md §9.14): a `provision init` DRAFT for one instance, kept
 * on the work system until the publication host is installed from its kit and paired.
 *
 * WHAT A DRAFT IS. Exactly the agent's draft format (publication/host_agent/src/provision/init/
 * draft.ts DraftDeclaration) restricted to the fields the panel asks — instance, layout, apis,
 * listen, the accounts, the v2 unit and port, web.server, site.domain, media — and nothing else:
 * whatever discovery fills on the publication host (the web unit, the PHP-FPM install, the vhost,
 * the OS family, nginx's map mode) is left to `provision init`, which shows each value with its
 * source before it changes anything. The draft carries NO secret, ever (owner decision D6: the
 * database passwords are typed on the publication host; the token is minted there).
 *
 * ONE RULE SET (owner decision D1). A draft is judged by the agent's OWN zero-dependency modules,
 * imported in-process: layout.ts derive() (every field rule of a declaration) and siblings.ts
 * siblingRefusals() (what two instances on one machine may never share), on a STAND-IN
 * declaration — the draft plus the defaults init proposes (draft.ts DEFAULTS, layout.ts
 * layoutPaths) and neutral values for the discovered fields derive() needs (a stand-in PHP-FPM
 * install at the v1 floor, a Debian-family web unit). The stand-ins are never written into the
 * draft; their honest limit is that a discovered value is judged on the publication host, by
 * init, not here. The kit builder then judges the draft file once more with the agent's zod
 * parseDraft, inside the kit's own copy (kit_build.ts).
 *
 * MULTI-INSTANCE. Two drafts are on the same machine when both listen on a socket (one machine:
 * the work system's) or both on TLS at the same address — an IPv4, or a private IPv6 compared in
 * its RFC 5952 form (layout.ts sameListenHost), so `FD00:0::1` and `fd00::1` are one machine.
 * Siblings are the other drafts on
 * that machine — awaiting installation, or paired and still in the registry — and the registry's
 * hosts at that address (their instance and listener: the registry knows no more of them).
 *
 * THE STORE. `<private>/publication_host_drafts.json` (publicationHostsBase(): the test seam
 * redirects it with the registry), mode 0600, through the atomic JSON kernel the registry uses
 * (core/files/atomic_json.ts: bounded fd reads, temp → fsync → rename, flock). NOT the
 * registry: a draft dials nothing and holds no credential. A corrupt store is LOUD (never "no
 * drafts"). Root only: every action that reads or writes it is root's (the widget checks first).
 *
 * A DRAFT'S STATE is derived, never stored: `paired` while the registry holds a host whose
 * instance is the draft's (and, on TLS, at the draft's address), `awaiting` otherwise.
 *
 * ONE MACHINE IS THE DEFAULT (spec §1.1): the public website as another vhost of this server.
 * propose_draft proposes it unless told otherwise, and a one-machine draft is installed with
 * ONE block run here as root (oneMachineInstall: the draft file, the agent's dependencies when
 * missing, install.sh --source <this release tree>) — init pairs it itself; the kit and the
 * sealed package are the two-machine path.
 */

import { join } from 'node:path';
import {
	DEFAULTS,
	type DraftDeclaration,
	draftServesV1,
} from '../../../publication/host_agent/src/provision/init/draft.ts';
import {
	type AgentLayout,
	cleanAbsolute,
	comparableHost,
	DOMAIN_PATTERN,
	derive,
	FORBIDDEN_HOMES,
	type HostDeclaration,
	INSTANCE_PATTERN,
	LayoutError,
	layoutPaths,
	listenHostProblem,
	sameListenHost,
	V1_PHP_FLOOR,
} from '../../../publication/host_agent/src/provision/layout.ts';
import {
	type Sibling,
	siblingRefusals,
} from '../../../publication/host_agent/src/provision/siblings.ts';
import {
	JsonFileError,
	readPrivateJsonTextSync,
	withJsonFileLock,
	writeJsonFileAtomic,
} from '../files/atomic_json.ts';
import {
	HOST_NAME,
	type PublicationHostRecord,
	publicationHostsBase,
	RESERVED_HOST_PREFIX,
	type RegistryFile,
} from './registry.ts';

export const DRAFTS_FILE = 'publication_host_drafts.json';
export const DRAFTS_VERSION = 1;
/** A few hundred bytes a draft; a thousand of them fit. */
export const DRAFTS_MAX_BYTES = 1024 * 1024;
/** The proposed TLS port of an agent (the guide's example); the next free one on that address. */
export const DEFAULT_TLS_PORT = 8471;

/** The form's fields — declaration paths, so a refusal names the input it is about. */
export const DRAFT_FIELDS = Object.freeze([
	'name',
	'instance',
	'site.domain',
	'site.home',
	'listen.kind',
	'listen.host',
	'listen.port',
	'web.server',
	'apis',
	'v1.user',
	'media.mode',
	'media.root',
	'layout',
	'agent_user',
	'engine_group',
	'v2.user',
	'v2.unit',
	'v2.port',
] as const);
export type DraftField = (typeof DRAFT_FIELDS)[number];

export interface DraftIssue {
	field: DraftField;
	message: string;
}

/** Every reason a draft was refused, field by field (the widget: publication_host.draft_invalid). */
export class DraftInvalid extends Error {
	readonly issues: readonly DraftIssue[];
	constructor(issues: readonly DraftIssue[]) {
		super(
			`publication-host draft refused: ${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`,
		);
		this.name = 'DraftInvalid';
		this.issues = Object.freeze([...issues]);
	}
}

export type DraftsErrorReason = 'unreadable' | 'invalid' | 'locked';

/** The store could not be read or written. Never "no drafts". */
export class DraftsStoreError extends Error {
	readonly reason: DraftsErrorReason;
	constructor(reason: DraftsErrorReason, detail: string) {
		super(`publication-host drafts (${reason}): ${detail}`);
		this.name = 'DraftsStoreError';
		this.reason = reason;
	}
}

/** The panel's draft: the agent draft format, restricted (see the header). */
export interface PanelDraft {
	instance: string;
	layout: 'home' | 'system';
	apis: 'v2_only' | 'v1_and_v2';
	listen: { kind: 'unix' } | { kind: 'tls'; host: string; port: number };
	agent_user: string;
	engine_group?: string;
	web: { server: 'apache' | 'nginx' };
	/** `home`: the site's own directory (home layout only); absent = init's `/home/<domain>`. */
	site: { domain: string; home?: string };
	v1?: { user: string };
	media: { mode: 'shared' | 'copy' | 'none'; root?: string };
	v2: { unit: string; user: string; port: number };
}

export interface StoredDraft {
	/** The registry name the host will be paired as (HOST_NAME). Unique across drafts. */
	name: string;
	created_at: string;
	/** The dd128 user id that saved it (root). */
	created_by: number;
	draft: PanelDraft;
}

export interface DraftsFile {
	version: 1;
	drafts: StoredDraft[];
}

// ------------------------------------------------------------------------- input parsing

const DRAFT_KEYS = [
	'instance',
	'layout',
	'apis',
	'listen',
	'agent_user',
	'engine_group',
	'web',
	'site',
	'v1',
	'media',
	'v2',
];

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collects issues while reading one untrusted object, field by field. */
class Reader {
	readonly issues: DraftIssue[] = [];
	refuse(field: DraftField, message: string): void {
		if (!this.issues.some((issue) => issue.field === field)) this.issues.push({ field, message });
	}
	text(field: DraftField, value: unknown, pattern: RegExp, what: string): string {
		if (typeof value === 'string' && pattern.test(value)) return value;
		this.refuse(field, `must be ${what}`);
		return '';
	}
	choice<T extends string>(field: DraftField, value: unknown, options: readonly T[]): T {
		if (typeof value === 'string' && (options as readonly string[]).includes(value))
			return value as T;
		this.refuse(field, `must be one of ${options.join(', ')}`);
		return options[0] as T;
	}
	port(field: DraftField, value: unknown): number {
		if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535)
			return value;
		this.refuse(field, 'must be an integer port 1-65535');
		return 0;
	}
	object(field: DraftField, value: unknown, keys: readonly string[]): Record<string, unknown> {
		if (!isObject(value)) {
			this.refuse(field, 'is missing');
			return {};
		}
		const extra = Object.keys(value).filter((key) => !keys.includes(key));
		if (extra.length > 0) this.refuse(field, `takes no ${extra.join(', ')}`);
		return value;
	}
}

const UNIX_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ABSOLUTE = /^\/[A-Za-z0-9._/-]{0,1023}$/;

function readListen(r: Reader, value: unknown): PanelDraft['listen'] {
	const listen = r.object('listen.kind', value, ['kind', 'host', 'port']);
	const kind = r.choice('listen.kind', listen.kind, ['unix', 'tls'] as const);
	if (kind === 'unix') {
		if (listen.host !== undefined)
			r.refuse('listen.host', 'one machine listens on a socket: no address');
		if (listen.port !== undefined)
			r.refuse('listen.port', 'one machine listens on a socket: no port');
		return { kind: 'unix' };
	}
	return {
		kind: 'tls',
		host: readListenHost(r, listen.host),
		port: r.port('listen.port', listen.port),
	};
}

/**
 * `listen.host`: the private address the agent binds — the agent's ONE grammar (layout.ts
 * listenHostProblem: a canonical IPv4, or a unique local / loopback IPv6). What an operator
 * TYPES is canonicalized first (`FD00:0::1` → `fd00::1`, RFC 5952): the draft file then carries
 * the one spelling the agent's own schema demands and every comparison downstream reads. A
 * refusal says why (a link-local needs a zone id the channel cannot carry, a global address is
 * not private, a hostname is never one).
 */
function readListenHost(r: Reader, value: unknown): string {
	const host = typeof value === 'string' ? comparableHost(value.trim()) : value;
	const problem = listenHostProblem(host);
	if (problem === null) return host as string;
	r.refuse(
		'listen.host',
		`must be the private address the agent binds — an IPv4 (e.g. 10.20.0.2) or a unique local IPv6 (e.g. fd00:20::2): ${problem}`,
	);
	return '';
}

/** `site.home`: empty/absent = the default; else a clean absolute path no site-sharing directory. */
function readSiteHome(r: Reader, value: unknown, layout: PanelDraft['layout']): string | undefined {
	if (value === undefined || value === '') return undefined;
	if (layout === 'system') {
		r.refuse('site.home', 'only the home layout has a site home');
		return undefined;
	}
	return checkedSiteHome(r, value);
}

/** A non-empty `site.home` on a home layout: a clean absolute path that is not a shared directory. */
function checkedSiteHome(r: Reader, value: unknown): string | undefined {
	try {
		const home = cleanAbsolute('site.home', value);
		if (!FORBIDDEN_HOMES.includes(home)) return home;
		r.refuse('site.home', `'${home}' holds other sites; a site home is its own directory`);
		return undefined;
	} catch (error) {
		if (!(error instanceof LayoutError)) throw error;
		r.refuse('site.home', error.reason);
		return undefined;
	}
}

function readMedia(r: Reader, value: unknown): PanelDraft['media'] {
	const media = r.object('media.mode', value, ['mode', 'root']);
	const mode = r.choice('media.mode', media.mode, ['shared', 'copy', 'none'] as const);
	if (mode === 'none') {
		if (media.root !== undefined)
			r.refuse('media.root', "takes no root when the media mode is 'none'");
		return { mode };
	}
	return { mode, root: r.text('media.root', media.root, ABSOLUTE, 'an absolute directory path') };
}

/**
 * The panel's draft from an untrusted options object: exactly the keys the form sends, each of
 * the right type, collected field by field (every shape issue at once). Grammar only — derive()
 * and the siblings judge the meaning (validateDraft).
 */
export function readPanelDraft(value: unknown): PanelDraft {
	const r = new Reader();
	const raw = r.object('instance', value, DRAFT_KEYS);
	const apis = r.choice('apis', raw.apis, ['v2_only', 'v1_and_v2'] as const);
	const web = r.object('web.server', raw.web, ['server']);
	const site = r.object('site.domain', raw.site, ['domain', 'home']);
	const v2 = r.object('v2.unit', raw.v2, ['unit', 'user', 'port']);
	const draft: PanelDraft = {
		instance: r.text(
			'instance',
			raw.instance,
			INSTANCE_PATTERN,
			`a name matching ${INSTANCE_PATTERN.source}`,
		),
		layout: r.choice('layout', raw.layout, ['home', 'system'] as const),
		apis,
		listen: readListen(r, raw.listen),
		agent_user: r.text('agent_user', raw.agent_user, UNIX_NAME, 'a system account name'),
		web: { server: r.choice('web.server', web.server, ['apache', 'nginx'] as const) },
		site: {
			domain: r.text(
				'site.domain',
				site.domain,
				DOMAIN_PATTERN,
				'a lower-case DNS name (museum.org)',
			),
		},
		media: readMedia(r, raw.media),
		v2: {
			unit: r.text('v2.unit', v2.unit, UNIT_NAME, 'a systemd unit name (without .service)'),
			user: r.text('v2.user', v2.user, UNIX_NAME, 'a system account name'),
			port: r.port('v2.port', v2.port),
		},
	};
	const home = readSiteHome(r, site.home, draft.layout);
	if (home !== undefined) draft.site.home = home;
	const engineGroup = readEngineGroup(r, raw.engine_group, draft.listen.kind);
	if (engineGroup !== undefined) draft.engine_group = engineGroup;
	const v1 = readV1(r, raw.v1, apis);
	if (v1 !== undefined) draft.v1 = v1;
	if (r.issues.length > 0) throw new DraftInvalid(r.issues);
	return draft;
}

/** `engine_group`: required on one machine (unix listen), refused over mTLS. */
function readEngineGroup(
	r: Reader,
	value: unknown,
	listenKind: PanelDraft['listen']['kind'],
): string | undefined {
	if (listenKind === 'unix') {
		return r.text(
			'engine_group',
			value,
			UNIX_NAME,
			'the group of the account that runs Dédalo (one machine)',
		);
	}
	if (value !== undefined) {
		r.refuse(
			'engine_group',
			'only one machine has an engine group; over mTLS the work system is its client certificate',
		);
	}
	return undefined;
}

/** `v1`: required when the draft serves Publication API v1, refused when it serves v2 only. */
function readV1(r: Reader, value: unknown, apis: PanelDraft['apis']): PanelDraft['v1'] {
	if (apis === 'v1_and_v2') {
		const v1 = r.object('v1.user', value, ['user']);
		return {
			user: r.text('v1.user', v1.user, UNIX_NAME, 'a system account name (the v1 pool user)'),
		};
	}
	if (value !== undefined) {
		r.refuse('v1.user', 'is a Publication API v1 field, and the draft serves v2 only');
	}
	return undefined;
}

// ------------------------------------------------------------------- the agent's rule set

/** The site's home a `home` layout uses: the draft's, else init's default `/home/<domain>`. */
function siteHome(draft: PanelDraft): string {
	return draft.site.home ?? join('/home', draft.site.domain);
}

/**
 * The stand-in declaration derive() judges (see the header): the draft, init's proposals for
 * what the panel leaves out, and neutral values for what only discovery can know.
 */
export function standInDeclaration(draft: PanelDraft): HostDeclaration {
	const servesV1 = draftServesV1(draft as DraftDeclaration);
	const paths = layoutPaths(
		draft.layout,
		draft.instance,
		draft.layout === 'home' ? siteHome(draft) : null,
	);
	return {
		instance: draft.instance,
		listen: draft.listen,
		agent_user: draft.agent_user,
		...(draft.engine_group === undefined ? {} : { engine_group: draft.engine_group }),
		agent_dir: paths.agent_dir,
		web: standInWeb(draft),
		...standInApis(draft, servesV1),
		state_root: paths.state_root,
		media: draft.media,
		bun_bin: paths.bun_bin,
		v2: {
			unit: draft.v2.unit,
			user: draft.v2.user,
			group: draft.v2.user,
			port: draft.v2.port,
			health_url: `http://127.0.0.1:${draft.v2.port}/health`,
		},
	};
}

/** The stand-in's web server: the draft's choice with init's default unit for it. */
function standInWeb(draft: PanelDraft): HostDeclaration['web'] {
	return {
		server: draft.web.server,
		unit: draft.web.server === 'apache' ? DEFAULTS.webUnit.apache.debian : DEFAULTS.webUnit.nginx,
	};
}

/** The stand-in's `site` (+ `v1` and `php_bin` when the draft serves v1). */
function standInApis(
	draft: PanelDraft,
	servesV1: boolean,
): Pick<HostDeclaration, 'site' | 'v1' | 'php_bin'> {
	const base = {
		domain: draft.site.domain,
		...(draft.site.home === undefined ? {} : { home: draft.site.home }),
	};
	if (!servesV1) return { site: { ...base, os_family: 'debian' } };
	return {
		site: { ...base, fpm: { flavor: 'debian', version: V1_PHP_FLOOR } },
		v1: { user: draft.v1?.user ?? '' },
		php_bin: DEFAULTS.phpBin,
	};
}

/**
 * derive()/siblings field prefixes → the form field they are about, FIRST MATCH WINS (the
 * order is load-bearing: `site.fpm` is `apis` before `site.` is `site.domain`).
 */
const FORM_FIELD_RULES: readonly (readonly [RegExp, DraftField])[] = [
	[/^site\.home/, 'site.home'],
	[/^(state_root|agent_dir|bun_bin)/, 'layout'],
	[/^v2\.group/, 'v2.user'],
	[/^v2\.health_url/, 'v2.port'],
	[/^web\./, 'web.server'],
	[/^media\./, 'media.root'],
	[/^listen/, 'listen.port'],
	[/^(site\.fpm|php_bin|site\.os_family|site\.api_paths)/, 'apis'],
	[/^site\./, 'site.domain'],
];

/** A derive() / siblings field → the form field it is about (layout paths → `layout`). */
export function formFieldOf(field: string): DraftField {
	if ((DRAFT_FIELDS as readonly string[]).includes(field)) return field as DraftField;
	return FORM_FIELD_RULES.find(([pattern]) => pattern.test(field))?.[1] ?? 'instance';
}

/** The leading field of a siblings.ts refusal sentence (they all start with it). */
function siblingField(refusal: string): DraftField {
	if (/ declares instance '/.test(refusal)) return 'instance';
	if (refusal.startsWith('the v1 pool')) return 'v1.user';
	if (refusal.startsWith('listen ')) return 'listen.port';
	return formFieldOf(/^([a-z0-9_.]+)/.exec(refusal)?.[1] ?? 'instance');
}

/**
 * Are two listeners on the same machine (both sockets: the work system's; both TLS: one address,
 * compared canonically — an IPv6 has many spellings and one RFC 5952 form)?
 */
export function sameMachine(
	a: PanelDraft['listen'],
	b: PublicationHostRecord['address'] | PanelDraft['listen'],
): boolean {
	if (a.kind === 'unix') return b.kind === 'unix';
	return b.kind === 'tls' && sameListenHost(b.host, a.host);
}

/** derive() of a draft's stand-in, or the field it refuses. */
export function deriveDraft(draft: PanelDraft): { layout: AgentLayout } | { issue: DraftIssue } {
	try {
		return { layout: derive(standInDeclaration(draft)) };
	} catch (error) {
		if (error instanceof LayoutError) {
			return {
				issue: { field: formFieldOf(error.field), message: `${error.field}: ${error.reason}` },
			};
		}
		throw error;
	}
}

/** Is this stored draft paired, i.e. does the registry hold its host? */
export function pairedRecord(
	stored: StoredDraft,
	registry: RegistryFile,
): PublicationHostRecord | null {
	const listen = stored.draft.listen;
	return (
		registry.hosts.find(
			(host) =>
				host.instance === stored.draft.instance &&
				(listen.kind === 'unix'
					? host.address.kind === 'unix'
					: host.address.kind === 'tls' &&
						sameListenHost(host.address.host, listen.host) &&
						host.address.port === listen.port),
		) ?? null
	);
}

/** What the new draft is judged against: the stored drafts and the registry (see the header). */
export interface DraftContext {
	drafts: readonly StoredDraft[];
	registry: RegistryFile;
}

/**
 * THE JUDGEMENT of a draft about to be saved as `name`: the registry name, derive() on the
 * stand-in, then the siblings on its machine. Throws DraftInvalid naming every field it can.
 */
export function validateDraft(
	name: unknown,
	draft: PanelDraft,
	context: DraftContext,
): StoredDraft['draft'] {
	const issues: DraftIssue[] = nameIssues(name, context);
	const own = deriveDraft(draft);
	if ('issue' in own) throw new DraftInvalid([...issues, own.issue]);
	for (const refusal of siblingRefusals(own.layout, draftSiblings(name, draft, context))) {
		addOnce(issues, siblingField(refusal), refusal);
	}
	for (const host of undraftedHostsOnMachine(name, draft, context)) {
		registryHostIssues(issues, draft, host);
	}
	if (issues.length > 0) throw new DraftInvalid(issues);
	return draft;
}

/** Add an issue unless its field already has one. */
function addOnce(issues: DraftIssue[], field: DraftField, message: string): void {
	if (!issues.some((issue) => issue.field === field)) issues.push({ field, message });
}

/** The registry name: its shape, then neither a paired host's nor another draft's. */
function nameIssues(name: unknown, context: DraftContext): DraftIssue[] {
	if (typeof name !== 'string' || !HOST_NAME.test(name) || name.startsWith(RESERVED_HOST_PREFIX)) {
		return [
			{
				field: 'name',
				message: `must match ${HOST_NAME.source} and not start with '${RESERVED_HOST_PREFIX}'`,
			},
		];
	}
	if (context.registry.hosts.some((host) => host.name === name)) {
		return [{ field: 'name', message: `a publication host named '${name}' is already paired` }];
	}
	if (context.drafts.some((stored) => stored.name === name)) {
		return [{ field: 'name', message: `a draft named '${name}' already exists: remove it first` }];
	}
	return [];
}

/** The OTHER stored drafts on the draft's machine. */
function otherDraftsOnMachine(
	name: unknown,
	draft: PanelDraft,
	context: DraftContext,
): StoredDraft[] {
	return context.drafts.filter(
		(stored) => stored.name !== name && sameMachine(draft.listen, stored.draft.listen),
	);
}

/** The other drafts on the machine that derive, as siblings.ts reads them. */
function draftSiblings(name: unknown, draft: PanelDraft, context: DraftContext): Sibling[] {
	return otherDraftsOnMachine(name, draft, context).flatMap((stored) => {
		const derived = deriveDraft(stored.draft);
		return 'layout' in derived
			? [{ source: `draft '${stored.name}'`, layout: derived.layout }]
			: [];
	});
}

/**
 * The paired hosts on the machine that no sibling draft stands for: a paired host whose OWN
 * draft is a sibling was judged in full there; every other host on the machine is judged on
 * what the registry knows of it.
 */
function undraftedHostsOnMachine(
	name: unknown,
	draft: PanelDraft,
	context: DraftContext,
): PublicationHostRecord[] {
	const drafted = new Set(
		otherDraftsOnMachine(name, draft, context).flatMap((stored) => {
			const paired = pairedRecord(stored, context.registry);
			return paired === null ? [] : [paired.name];
		}),
	);
	return context.registry.hosts.filter(
		(host) => sameMachine(draft.listen, host.address) && !drafted.has(host.name),
	);
}

/** A paired host on the machine: its instance, and its TLS port, are taken. */
function registryHostIssues(
	issues: DraftIssue[],
	draft: PanelDraft,
	host: PublicationHostRecord,
): void {
	if (host.instance === draft.instance) {
		addOnce(
			issues,
			'instance',
			`instance '${draft.instance}' is already paired on that machine as '${host.name}'`,
		);
	}
	if (sharesTlsPort(draft.listen, host.address)) {
		const listen = draft.listen as { host: string; port: number };
		addOnce(
			issues,
			'listen.port',
			`listen ${listen.host}:${listen.port} is the paired host '${host.name}'s`,
		);
	}
}

/** Both TLS, on the same port. */
function sharesTlsPort(
	listen: PanelDraft['listen'],
	address: PublicationHostRecord['address'],
): boolean {
	return listen.kind === 'tls' && address.kind === 'tls' && address.port === listen.port;
}

// ------------------------------------------------------------------------------ proposals

/** The convention: the domain with '.' and '-' as '_' (museum.org → museum_org), or '' when that is no instance name. */
export function instanceFromDomain(domain: string): string {
	const instance = domain.toLowerCase().replace(/[.-]/g, '_');
	return INSTANCE_PATTERN.test(instance) ? instance : '';
}

function nextFree(from: number, taken: ReadonlySet<number>): number {
	let port = from;
	while (taken.has(port) && port < 65535) port += 1;
	return port;
}

export interface ProposalInput {
	domain: string;
	machines: 'one' | 'two';
	/** two machines: the private address (IPv4 or unique local IPv6) the agent will bind (may be ''). */
	listenHost: string;
	apis: 'v2_only' | 'v1_and_v2';
	/** one machine: the work system's own group (null when it cannot be named). */
	engineGroup: string | null;
	/** one machine, shared mode: the work system's own media root. */
	mediaRoot: string | null;
}

/**
 * The draft the form starts from: init's own proposals (draft.ts DEFAULTS) for this instance,
 * the next free v2 port among the drafts on that machine, the next free TLS port on that
 * address, and the default layout (/home/<domain>). Never stored: the operator edits, then saves.
 */
export function proposeDraft(
	input: ProposalInput,
	context: DraftContext,
): { name: string; draft: PanelDraft } {
	const instance = instanceFromDomain(input.domain);
	const listen: PanelDraft['listen'] =
		input.machines === 'one'
			? { kind: 'unix' }
			: { kind: 'tls', host: proposedListenHost(input.listenHost), port: DEFAULT_TLS_PORT };
	const onMachine = context.drafts.filter((stored) => sameMachine(listen, stored.draft.listen));
	const v2Port = nextFree(
		DEFAULTS.v2Port,
		new Set(onMachine.map((stored) => stored.draft.v2.port)),
	);
	if (listen.kind === 'tls') listen.port = proposedTlsPort(listen.host, onMachine, context, v2Port);
	const draft: PanelDraft = {
		instance,
		layout: 'home',
		apis: input.apis,
		listen,
		agent_user: named(instance, DEFAULTS.agentUser),
		web: { server: 'apache' },
		site: { domain: input.domain },
		media: proposedMedia(input),
		v2: {
			unit: named(instance, DEFAULTS.v2Unit),
			user: named(instance, DEFAULTS.v2User),
			port: v2Port,
		},
	};
	if (listen.kind === 'unix') draft.engine_group = input.engineGroup ?? '';
	if (input.apis === 'v1_and_v2') draft.v1 = { user: named(instance, DEFAULTS.v1User) };
	return { name: instance, draft };
}

/**
 * The address the form was given, in the one spelling the draft keeps (an IPv6 in its RFC 5952
 * form); '' when none was. Not judged here: a proposal is never stored, save_draft judges it.
 */
function proposedListenHost(host: unknown): string {
	return typeof host === 'string' ? comparableHost(host.trim()) : '';
}

/** init's default name for an instance, or '' when the domain gave no instance name. */
function named(instance: string, of: (instance: string) => string): string {
	return instance === '' ? '' : of(instance);
}

/** The next free TLS port on `host`: past the drafts on that machine, its paired hosts, and v2. */
function proposedTlsPort(
	host: string,
	onMachine: readonly StoredDraft[],
	context: DraftContext,
	v2Port: number,
): number {
	const taken = new Set<number>([
		...onMachine.flatMap((stored) =>
			stored.draft.listen.kind === 'tls' ? [stored.draft.listen.port] : [],
		),
		...context.registry.hosts.flatMap((paired) =>
			paired.address.kind === 'tls' && sameListenHost(paired.address.host, host)
				? [paired.address.port]
				: [],
		),
		v2Port,
	]);
	return nextFree(DEFAULT_TLS_PORT, taken);
}

/** One machine shares the work system's media tree (its root when known); two copy. */
function proposedMedia(input: ProposalInput): PanelDraft['media'] {
	if (input.machines === 'one' && input.mediaRoot !== null) {
		return { mode: 'shared', root: input.mediaRoot };
	}
	return { mode: input.machines === 'one' ? 'shared' : 'copy', root: '' };
}

/** The draft file the kit carries (`draft.json`): the panel draft, nothing added. */
export function draftJson(draft: PanelDraft): string {
	return `${JSON.stringify(draft, null, 2)}\n`;
}

// ------------------------------------------------------------- the one-machine install (§1.1)

/**
 * What the one-machine install block is built from: facts of THIS work system, read by the
 * panel (publication_host_setup.ts SetupDeps.installSource), never typed by anyone.
 */
export interface InstallSource {
	/** The installed release tree the engine runs from: install.sh's `--source`. */
	root: string;
	/** The pinned Bun running this engine (its own executable). */
	bun: string;
	/** The account that runs Dédalo, or null when it has no name (a bare uid). */
	user: string | null;
	/** The agent's production dependencies are present in the tree (`hostagent:install` ran). */
	agentDeps: boolean;
}

/** The wire shape of a one-machine draft's install (root only, the draft row's `install`). */
export interface OneMachineInstall {
	/** The release tree given as `--source`. */
	source: string;
	/** Where the block writes the draft: root-only, as install.sh requires of `--draft`. */
	draft_file: string;
	/** The agent's dependencies were found in the tree (false: the block installs them first). */
	agent_deps: boolean;
	/** The block to paste into a root shell on THIS server. */
	command: string;
}

/**
 * The heredoc terminator of the draft in the block. A draft line can never equal it: every
 * line of draftJson() is JSON (indentation, a brace, or a quoted key), and the terminator is
 * a bare upper-case word — asserted anyway (oneMachineInstall), since a match would end the
 * file early and run the rest of the draft as shell.
 */
export const DRAFT_HEREDOC_END = 'DEDALO_PUBLICATION_HOST_DRAFT';

/** The directory the block writes the draft into (root's own: install.sh wants a root-owned file). */
export const ONE_MACHINE_DRAFT_DIR = '/root';

/** A word the shell reads back unchanged: bare when it is plainly safe, else single-quoted. */
export function shellWord(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * THE ONE BLOCK a one-machine draft is installed with (spec §1.1, §9.14): on this server, as
 * root, three steps the operator page's guided install describes, with this installation's own
 * paths filled in —
 *   1. the draft written as a root-only file (install.sh refuses a `--draft` another account
 *      can write: root never runs config a non-root account can change);
 *   2. ONLY when the tree lacks them, the agent's production dependencies, installed in the
 *      release tree as the account that runs Dédalo (`hostagent:install`, by the pinned Bun
 *      named outright, so no PATH decides which Bun runs) — `node_modules` is tolerated by the
 *      publication manifest, so this never drifts the release the kit builder verifies;
 *   3. install.sh from the release tree with `--source` = that tree. It shows the source digest
 *      and asks before any of it runs as root. On one machine provision init then pairs the
 *      host itself (it runs this work system's pairing command): no kit, no package. A draft
 *      whose registry name is not its instance passes `--pair-name`, so the pairing lands
 *      under the name this panel shows.
 * Pure: every value is shell-quoted where it is not plainly safe, and the draft goes through a
 * quoted heredoc (no expansion inside).
 */
export function oneMachineInstall(
	name: string,
	draft: PanelDraft,
	source: InstallSource,
): OneMachineInstall {
	if (draft.listen.kind !== 'unix') {
		throw new Error(`draft '${name}' listens on TLS: two machines install from the kit`);
	}
	const json = draftJson(draft);
	if (json.split('\n').includes(DRAFT_HEREDOC_END)) {
		throw new Error(`draft '${name}' holds the heredoc terminator line`);
	}
	const draftFile = `${ONE_MACHINE_DRAFT_DIR}/${draft.instance}.draft.json`;
	const file = shellWord(draftFile);
	const installSh = shellWord(`${source.root}/publication/host_agent/deploy/install.sh`);
	const pairName = name === draft.instance ? '' : ` -- --pair-name ${shellWord(name)}`;
	const lines = [
		'# On THIS server, as root. One machine: provision init pairs the host itself.',
		'# 1. The draft, as a file only root can write (install.sh refuses any other).',
		`(umask 077 && rm -f ${file} && cat > ${file}) <<'${DRAFT_HEREDOC_END}'`,
		...json.replace(/\n$/, '').split('\n'),
		DRAFT_HEREDOC_END,
		...agentDepsLines(source),
		`# ${source.agentDeps ? 2 : 3}. The guided install from this release tree (it shows the source digest and asks first).`,
		`sh ${installSh} ${shellWord(draft.instance)} --source ${shellWord(source.root)} --draft ${file}${pairName}`,
	];
	return {
		source: source.root,
		draft_file: draftFile,
		agent_deps: source.agentDeps,
		command: `${lines.join('\n')}\n`,
	};
}

/** Step 2 of the block: nothing when the dependencies are there, else their install. */
function agentDepsLines(source: InstallSource): string[] {
	if (source.agentDeps) return [];
	const agentDir = `${source.root}/publication/host_agent`;
	// what `bun run hostagent:install` runs (package.json), with the pinned Bun named outright
	const install = `cd ${shellWord(agentDir)} && exec ${shellWord(source.bun)} install --frozen-lockfile --production`;
	if (source.user === null) {
		return [
			"# 2. The agent's production dependencies are missing from the release tree. Install them",
			'#    as the account that runs Dédalo (this server runs it under a uid with no name):',
			`#    ${install}`,
		];
	}
	return [
		"# 2. The agent's production dependencies, installed in the release tree as the account that runs Dédalo.",
		`su -s /bin/sh ${shellWord(source.user)} -c ${shellWord(install)}`,
	];
}

// --------------------------------------------------------------------------------- the store

export function draftsPath(): string {
	return join(publicationHostsBase(), DRAFTS_FILE);
}

function validateStored(value: unknown, index: number): StoredDraft {
	const where = `drafts[${index}]`;
	if (!isObject(value)) throw new DraftsStoreError('invalid', `${where} must be an object`);
	const keys = Object.keys(value).sort().join(',');
	if (keys !== 'created_at,created_by,draft,name')
		throw new DraftsStoreError('invalid', `${where} has keys [${keys}]`);
	const name = storedField(value.name, isHostName, `${where}.name`);
	const createdAt = storedField(value.created_at, isTimestamp, `${where}.created_at`);
	const createdBy = storedField(value.created_by, isInteger, `${where}.created_by`);
	return { name, created_at: createdAt, created_by: createdBy, draft: storedDraft(value, where) };
}

/** One stored field that must pass `valid`, or the store is invalid at `where`. */
function storedField<T>(value: unknown, valid: (value: unknown) => value is T, where: string): T {
	if (!valid(value)) throw new DraftsStoreError('invalid', where);
	return value;
}

function isInteger(value: unknown): value is number {
	return Number.isInteger(value);
}

function isHostName(value: unknown): value is string {
	return typeof value === 'string' && HOST_NAME.test(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** The stored entry's draft, re-read as the panel reads one (a refusal = an invalid store). */
function storedDraft(value: Record<string, unknown>, where: string): PanelDraft {
	try {
		return readPanelDraft(value.draft);
	} catch (error) {
		if (error instanceof DraftInvalid)
			throw new DraftsStoreError('invalid', `${where}.draft: ${error.message}`);
		throw error;
	}
}

export function validateDraftsFile(value: unknown): DraftsFile {
	if (
		!isObject(value) ||
		value.version !== DRAFTS_VERSION ||
		!Array.isArray(value.drafts) ||
		Object.keys(value).length !== 2
	) {
		throw new DraftsStoreError('invalid', `must be {"version":${DRAFTS_VERSION},"drafts":[…]}`);
	}
	const drafts = value.drafts.map((entry: unknown, index: number) => validateStored(entry, index));
	if (new Set(drafts.map((d) => d.name)).size !== drafts.length)
		throw new DraftsStoreError('invalid', 'a draft name is repeated');
	return { version: DRAFTS_VERSION, drafts };
}

function asStoreError(error: unknown): unknown {
	if (!(error instanceof JsonFileError)) return error;
	return new DraftsStoreError(error.reason === 'locked' ? 'locked' : 'unreadable', error.message);
}

/** Absent file → no drafts; anything else invalid → DraftsStoreError (never an empty list). */
export function loadDrafts(): DraftsFile {
	let text: string | null;
	try {
		text = readPrivateJsonTextSync(draftsPath(), { maxBytes: DRAFTS_MAX_BYTES });
	} catch (error) {
		throw asStoreError(error);
	}
	if (text === null) return { version: DRAFTS_VERSION, drafts: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new DraftsStoreError('invalid', `${draftsPath()} is not valid JSON`);
	}
	return validateDraftsFile(parsed);
}

/** Load + fn + save under one lock hold. A throw from `fn` writes nothing. */
export function updateDrafts(fn: (current: DraftsFile) => DraftsFile): DraftsFile {
	try {
		return withJsonFileLock(draftsPath(), () => {
			const next = validateDraftsFile(JSON.parse(JSON.stringify(fn(loadDrafts()))));
			writeJsonFileAtomic(draftsPath(), next, { maxBytes: DRAFTS_MAX_BYTES });
			return next;
		});
	} catch (error) {
		throw asStoreError(error);
	}
}
