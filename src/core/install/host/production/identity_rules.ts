/**
 * THE SERVICE ACCOUNT AND INSTALL FOLDER RULES (owner decisions 2026-10-12) —
 * ONE pure verdict over the answers and the host's facts (account_facts.ts,
 * instances.ts, the web sites): what is REFUSED, what is TOLD, and what the
 * installer CREATES vs USES AS IS. The identity probe (the screen that asks)
 * and host_preflight (authoritative, frozen) both call it, so the sentences
 * cannot drift; host_identity computes its commands from the same verdict.
 *
 *  - ACCOUNT: never uid 0, never a package's account (postgres, the web
 *    server's — PACKAGE_ACCOUNTS: one absent now appears at host_packages); an
 *    existing account is used as it is only when it
 *    is a REGULAR one (login.defs' UID range) and holds no privileged group
 *    (systemd's User= calls initgroups: every group of the account is the
 *    running service's); a new one is created only under useradd's default
 *    NAME_REGEX (no dot).
 *  - GROUP: never gid 0, never a system group (the web server joins it),
 *    never the web server's own nor a package's; a defaulted group named like
 *    a user that does not exist is a leftover — never reused by default.
 *  - ONE PER INSTANCE: the user, the group and the folder of every other
 *    instance (instances.ts) are refused, folders component-wise; so is an
 *    account that is a MEMBER of another instance's group. ONE clause per
 *    problem and instance, naming every file that says so; a clause derived
 *    from the install-folder one (the default backup folder inside it, the
 *    other instance's own backup folder) is not repeated (campaign 3 C3-35).
 *  - FOLDER: never a symlinked path; an existing one is used as it is when it
 *    is the user's (and not group/other-writable), ADOPTED when it is ROOT's,
 *    empty, every parent is root's and it lies inside /home, /srv, /data, /mnt
 *    or /media (owner and mode restored on --abort; never an OS directory such
 *    as /var/mail), else refused; it never holds an install's remains; every existing parent is
 *    root's or the user's, not group/other-writable, and searchable by the
 *    user WITH THE SERVICE GROUP ALONE (the install steps run `runuser -g`,
 *    which sets that one group — see searchable). A missing folder is created by ROOT only under root-owned parents,
 *    else by the user itself (root never works by path in a tree another
 *    account controls — critique B1).
 *  - WEB: no folder inside a directory a web site serves.
 */

import { isAbsolute, normalize } from 'node:path';
import type { InstallAnswers } from '../../install_plan.ts';
import { pathsOverlap, sameOrInside } from '../../install_validation.ts';
import type { SiteTuple } from '../web/clash.ts';
import type { AccountFacts, PathFact } from './account_facts.ts';
import type { OtherInstance } from './instances.ts';
import { grants, names, readerOf, TRAVERSE } from './ontology_source_access.ts';

/** How the install folder comes to be the service user's. */
export type FolderPlan =
	| { kind: 'create'; by: 'root' | 'user'; ancestors: string[] }
	| { kind: 'adopt'; owner: string; group: string; mode: number }
	| { kind: 'owned'; empty: boolean };

export interface IdentityVerdict {
	problems: string[];
	told: string[];
	user: { name: string; create: boolean; uid: number | null; shell: string | null };
	group: {
		name: string;
		create: boolean;
		/** Created by `useradd --user-group` together with the new user. */
		withUser: boolean;
		/** The existing user whose PRIMARY group it is (null: its own group). */
		primaryOf: string | null;
	};
	folder: FolderPlan;
	/** The folder's nearest existing ancestor. */
	parent: string;
}

export interface IdentityInput {
	answers: InstallAnswers;
	account: AccountFacts;
	instances: readonly OtherInstance[];
	/** The web server's user (it joins the service group). */
	webUser: string;
	sites: readonly SiteTuple[];
	/**
	 * The records of an instance ALREADY INSTALLED under this name
	 * (instances.ts sameNameRecords — campaign 3d C3d-F1). Non-empty: the
	 * verdict is that ONE refusal; the account and the folder are that
	 * instance's, never judged as leftovers.
	 */
	taken?: readonly OtherInstance[];
}

/** The names the installer CREATES (useradd's default NAME_REGEX — no dot). */
export const CREATE_NAME_PATTERN = /^[a-z_][a-z0-9_-]*$/;

/** Groups that make an account root-equivalent or log-reading, whatever their gid. */
const PRIVILEGED_GROUPS: readonly string[] = Object.freeze(['wheel', 'sudo', 'docker', 'lxd']);

/** The common default group every account may be in; it grants nothing. */
const HARMLESS_GROUPS: readonly string[] = Object.freeze(['users']);

/** What an install leaves inside its folder (one there = an install, or its remains). */
const INSTALL_ENTRIES: readonly string[] = Object.freeze([
	'dedalo',
	'private',
	'backups',
	'master_dedalo',
]);

/**
 * The accounts the installer's own PACKAGES create or run as (PostgreSQL, the
 * web server on either family): never a service user or group — one absent at
 * the System check appears when host_packages installs them, and would then
 * be taken for the installer's own.
 */
export const PACKAGE_ACCOUNTS: readonly string[] = Object.freeze([
	'postgres',
	'www-data',
	'nginx',
	'apache',
]);

/**
 * Where an EMPTY folder that is not the user's may be ADOPTED (strictly
 * inside): the operator's own places and mount points — never an OS
 * directory (/var/mail, /var/spool/…, /var/local, /var/opt, /var/empty …).
 */
const ADOPT_ROOTS: readonly string[] = Object.freeze(['/home', '/srv', '/data', '/mnt', '/media']);

/** Shells that log nobody in. */
const NO_LOGIN = /(?:^|\/)(?:nologin|false)$/;

/** The refusal of a name an installed instance holds (its records' files named). */
export function instanceTakenSentence(instance: string, sources: readonly string[]): string {
	return `instance ${instance} is already installed on this host (${[...new Set(sources)].join(', ')}) — choose another instance name: an install never takes over an installed instance, its account, folder or database`;
}

// ── the account ──────────────────────────────────────────────────────────────

function userRules(input: IdentityInput): string[] {
	const u = input.answers.service_user;
	if (packageAccount(input, u)) {
		return [
			`service user ${u} is an account of the installer's packages (PostgreSQL or the web server) — refused: the service runs as an account of its own`,
		];
	}
	return accountRules(input);
}

/** The account's own refusals: a name to create, uid 0, a system account, its groups. */
function accountRules(input: IdentityInput): string[] {
	const { account, answers } = input;
	const u = answers.service_user;
	const user = account.user;
	if (user === null) {
		return CREATE_NAME_PATTERN.test(u) ? [] : [createOnly(u, 'account')];
	}
	if (user.uid === 0)
		return [`service user ${u} (uid 0) is refused — the service never runs as root`];
	const { uidMin, uidMax } = account.loginDefs;
	if (user.uid >= uidMin && user.uid <= uidMax) return membershipRules(input);
	return systemAccountRules(input, user.uid);
}

/**
 * An existing SYSTEM account: never reused — an earlier install's leftover,
 * unless an instance record names it: then its clash names that instance and
 * no removal is ever advised (campaign 3d C3d-F1 — `userdel` of a running
 * instance's account).
 */
function systemAccountRules(input: IdentityInput, uid: number): string[] {
	const u = input.answers.service_user;
	if (instanceAccount(input, 'user', u)) return [];
	const { uidMin, uidMax } = input.account.loginDefs;
	return [
		`account ${u} is a system account (uid ${uid}) — the installer uses only a regular account as it is (uid ${uidMin}-${uidMax}); a system account it did not create in this run is never reused (an earlier install's leftover: remove it with userdel, or choose another name)`,
	];
}

/** Does an instance record (another one, or this name's installed one) name `name` as its user / group? */
function instanceAccount(input: IdentityInput, what: 'user' | 'group', name: string): boolean {
	return [...input.instances, ...(input.taken ?? [])].some((record) => record[what] === name);
}

/** Is `name` the web server's or PostgreSQL's account (this host's web user included)? */
function packageAccount(input: IdentityInput, name: string): boolean {
	return name === input.webUser || PACKAGE_ACCOUNTS.includes(name);
}

/** The refusal of a name the installer would have to create but may not. */
function createOnly(name: string, what: 'account' | 'group'): string {
	return `the installer creates only names matching ^[a-z_][a-z0-9_-]*$ (useradd's default NAME_REGEX): ${name} does not exist on this host — create the ${what} yourself or choose another name`;
}

/** Is a supplementary group one the service must not hold? */
function privileged(group: { name: string; gid: number }, minGid: number): boolean {
	if (HARMLESS_GROUPS.includes(group.name)) return false;
	return group.gid < minGid || PRIVILEGED_GROUPS.includes(group.name);
}

/** The existing account's other groups (B5): a privileged one is refused. */
function membershipRules(input: IdentityInput): string[] {
	const { account, answers } = input;
	const own = new Set([account.user?.gid, account.group?.gid]);
	return account.memberOf
		.filter((group) => !own.has(group.gid) && privileged(group, account.loginDefs.gidMin))
		.map(
			(group) =>
				`account ${answers.service_user} is a member of ${group.name} (gid ${group.gid}) — the service would hold that group's rights; choose an account without it`,
		);
}

// ── the group ────────────────────────────────────────────────────────────────

function groupRules(input: IdentityInput): string[] {
	const refused = groupGuard(input);
	if (refused !== null) return [refused];
	return input.account.group === null ? absentGroupRules(input) : existingGroupRules(input);
}

/** The group refusals that hold whether the group exists or not (the web server's own, a leftover). */
function groupGuard(input: IdentityInput): string | null {
	const g = input.account.groupName;
	if (g === input.webUser) return `group ${g} is the web server's own group — refused`;
	if (packageAccount(input, g)) {
		return `group ${g} is a group of the installer's packages (PostgreSQL or the web server) — refused: the service group is one of its own`;
	}
	return leftoverGroup(input) ? leftoverSentence(input) : null;
}

/** An existing group: never gid 0, only a regular one. */
function existingGroupRules(input: IdentityInput): string[] {
	const { account } = input;
	const g = account.groupName;
	const gid = (account.group as NonNullable<AccountFacts['group']>).gid;
	if (gid === 0) return [`service group ${g} is gid 0 — refused`];
	const { gidMin, gidMax } = account.loginDefs;
	if (gid >= gidMin && gid <= gidMax) return [];
	return [
		`group ${g} is a system group (gid ${gid}) — the web server joins the service group, so only a regular group (gid ${gidMin}-${gidMax}) or one the installer creates is accepted`,
	];
}

/**
 * A DEFAULTED group named like a user that does not exist yet: an earlier
 * install's leftover (the user is created with its own group, so the group
 * existing means someone else made it) — never reused unless typed.
 */
function leftoverGroup(input: IdentityInput): boolean {
	const { account, answers } = input;
	return (
		answers.service_group === '' &&
		account.user === null &&
		account.sameNamedGroup !== null &&
		// Another instance's group: its clash names that instance (C3d-F1).
		!instanceAccount(input, 'group', account.groupName)
	);
}

function leftoverSentence(input: IdentityInput): string {
	const g = input.account.groupName;
	return `group ${g} already exists but user ${input.answers.service_user} does not — the installer never creates a user into a leftover group by default: remove the group, or use it as is with --service-group ${g}`;
}

/** A group to be created: a name the installer may create. */
function absentGroupRules(input: IdentityInput): string[] {
	const g = input.account.groupName;
	return CREATE_NAME_PATTERN.test(g) ? [] : [createOnly(g, 'group')];
}

// ── one per instance ─────────────────────────────────────────────────────────

/** How `mine` and `theirs` overlap, in words. */
function overlapWords(mine: string, theirs: string): string {
	if (mine === theirs) return 'the same folder';
	return sameOrInside(mine, theirs) ? 'inside it' : 'contains it';
}

/** The refusal of a record whose account (or group) cannot be told. */
function unknownSentence(other: OtherInstance): string {
	const head = `${other.source} names instance ${other.instance} but`;
	if (other.user === null) {
		return `${head} sets no User= — the installer cannot tell which account it runs as (one user per instance): give it its User= or remove it`;
	}
	return `${head} ${other.unknown} — the installer cannot tell which group it runs as (one group per instance): give it its Group= or remove it`;
}

/**
 * One collision with another instance: its KEY (the problem and the instance,
 * never the file that says so) and its sentence over the sources. The same
 * instance is read from up to three files (the registry, the drop-in, its run
 * record): grouped by key, each problem is ONE clause naming every file
 * (campaign 3 C3-35 — it was repeated once per file).
 */
interface Clash {
	key: string;
	sentence: (sources: string) => string;
	/** A folder overlap: whose folder, and which (install or backup) — what derived clauses are told from. */
	folder?: {
		what: 'install folder' | 'backup folder';
		mine: string;
		their: string;
		theirs: 'install' | 'backup';
	};
}

/** One other instance's clashes with this install (keyed — see Clash). */
function clashRules(input: IdentityInput, other: OtherInstance): Clash[] {
	const { answers, account } = input;
	const j = other.instance;
	if (other.unknown) {
		const text = unknownSentence(other);
		return [{ key: `unknown|${other.source}`, sentence: () => text }];
	}
	return [
		...(other.user === answers.service_user
			? [
					{
						key: `user|${j}`,
						sentence: (sources: string) =>
							`service user ${answers.service_user} is already the service user of instance ${j} (${sources}) — one user per instance: choose another --service-user`,
					},
				]
			: []),
		...(other.group === account.groupName
			? [
					{
						key: `group|${j}`,
						sentence: (sources: string) =>
							`service group ${account.groupName} is already the service group of instance ${j} (${sources}) — one group per instance: choose another --service-group`,
					},
				]
			: []),
		...memberClash(input, other),
		...folderClashes(input, other),
	];
}

/**
 * The existing account HOLDS another instance's group (a supplementary or
 * primary membership: systemd's User= calls initgroups) — the running service
 * would read that instance's tree, media and backups.
 */
function memberClash(input: IdentityInput, other: OtherInstance): Clash[] {
	const { account, answers } = input;
	const theirs = other.group;
	if (theirs === null || theirs === account.groupName) return [];
	if (!account.memberOf.some((group) => group.name === theirs)) return [];
	return [
		{
			key: `member|${other.instance}|${theirs}`,
			sentence: (sources) =>
				`account ${answers.service_user} is a member of ${theirs}, the service group of instance ${other.instance} (${sources}) — one group per instance: the service would hold that instance's group; choose an account without it`,
		},
	];
}

/** A path compared component-wise (normalized; no trailing /). */
function plainPath(path: string): string {
	const normal = normalize(path);
	return normal.length > 1 && normal.endsWith('/') ? normal.slice(0, -1) : normal;
}

/** Another instance's folders, each with which one it is. */
function theirFolders(other: OtherInstance): { dir: string; theirs: 'install' | 'backup' }[] {
	const folders: [string | null, 'install' | 'backup'][] = [
		[other.installDir, 'install'],
		[other.backupDir, 'backup'],
	];
	return folders
		.filter(
			(item): item is [string, 'install' | 'backup'] => item[0] !== null && isAbsolute(item[0]),
		)
		.map(([dir, theirs]) => ({ dir: plainPath(dir), theirs }));
}

/** This install's folders against another instance's folders. */
function folderClashes(input: IdentityInput, other: OtherInstance): Clash[] {
	const mine: ['install folder' | 'backup folder', string][] = [
		['install folder', input.answers.install_dir],
		['backup folder', input.answers.backup_dir],
	];
	return mine.flatMap(([what, dir]) =>
		theirFolders(other)
			.filter((their) => pathsOverlap(dir, their.dir))
			.map((their) => ({
				key: `folder|${other.instance}|${what}|${their.dir}`,
				folder: { what, mine: dir, their: their.dir, theirs: their.theirs },
				sentence: () =>
					`${what} ${dir} overlaps instance ${other.instance}'s folder ${their.dir} (${overlapWords(dir, their.dir)}) — choose a folder of its own`,
			})),
	);
}

/** The install-folder-over-install-folder overlaps (the clause every derived one repeats). */
function primaryFolderClashes(clashes: readonly Clash[]): Clash[] {
	return clashes.filter(
		(clash) => clash.folder?.what === 'install folder' && clash.folder.theirs === 'install',
	);
}

/**
 * Is a folder clause DERIVED from a primary one (C3-35)? A backup folder
 * inside this install's own folder, or the other instance's folder that lies
 * inside the install folder already named — the same mistake said again.
 */
function derivedFolder(clash: Clash, primary: readonly Clash[], installDir: string): boolean {
	const folder = clash.folder;
	if (folder === undefined || primary.includes(clash)) return false;
	if (folder.what === 'backup folder' && sameOrInside(folder.mine, installDir)) return true;
	return primary.some((item) => sameOrInside(folder.their, item.folder?.their ?? ''));
}

/** The clashes grouped by problem: one clause per key, naming every source file. */
function groupedClashes(input: IdentityInput): { clauses: string[]; sameFolder: boolean } {
	const found = new Map<string, { clash: Clash; sources: string[] }>();
	for (const other of input.instances) {
		for (const clash of clashRules(input, other)) {
			const entry = found.get(clash.key) ?? { clash, sources: [] };
			if (!entry.sources.includes(other.source)) entry.sources.push(other.source);
			found.set(clash.key, entry);
		}
	}
	const all = [...found.values()];
	const primary = primaryFolderClashes(all.map((entry) => entry.clash));
	return {
		clauses: all
			.filter((entry) => !derivedFolder(entry.clash, primary, input.answers.install_dir))
			.map((entry) => entry.clash.sentence(entry.sources.join(', '))),
		sameFolder: primary.length > 0,
	};
}

// ── the web sites ────────────────────────────────────────────────────────────

/** No folder of the instance inside a directory a web site serves (B7). */
function webRules(input: IdentityInput): string[] {
	const mine: [string, string][] = [
		['install folder', input.answers.install_dir],
		['backup folder', input.answers.backup_dir],
	];
	return input.sites.flatMap((site) =>
		(site.roots ?? []).flatMap((root) =>
			mine
				.filter(([, dir]) => sameOrInside(dir, root))
				.map(
					([what, dir]) =>
						`${what} ${dir} is inside ${root}, which ${site.file} serves to the web — choose a folder outside every site root`,
				),
		),
	);
}

// ── the folder ───────────────────────────────────────────────────────────────

/**
 * Can the user traverse `fact` WITH THE SERVICE GROUP ALONE? Every install-time
 * step of the instance runs as `runuser -u <user> -g <service group>` (execute.ts),
 * and with -g runuser sets exactly that group and skips initgroups (measured on
 * Ubuntu 26.04, 2026-11-08 — campaign C4): the account's other groups do not
 * reach its folder then. ONE rule with the ontology-source check (grants: one
 * class of bits, owner/group matched by name or by id — a non-local account's
 * owner reads as its number).
 */
function searchable(fact: PathFact, input: IdentityInput): boolean {
	const reader = readerOf(input.answers.service_user, input.account.groupName, input.account);
	return grants(fact, reader, TRAVERSE);
}

/** Can an account other than root or the service user write `fact` (owner or group/other bits)? */
function foreignWritable(fact: PathFact, input: IdentityInput): boolean {
	const uid = input.account.user === null ? null : String(input.account.user.uid);
	const owned = fact.owner === 'root' || names(fact.owner, input.answers.service_user, uid);
	return !owned || (fact.mode & 0o022) !== 0;
}

/** One existing ancestor's refusals. */
function ancestorRule(fact: PathFact, input: IdentityInput): string[] {
	const u = input.answers.service_user;
	if (fact.isSymlink) {
		return [
			`install folder path ${input.answers.install_dir} passes through the symbolic link ${fact.path} — give the real path`,
		];
	}
	if (foreignWritable(fact, input)) {
		return [
			`${fact.path} (a parent of the install folder) is writable by an account other than root or ${u} — it could replace the install folder; fix its owner or mode first`,
		];
	}
	return searchable(fact, input)
		? []
		: [`${fact.path} is not searchable by ${u} — the service could not reach its own folder`];
}

/** Every existing ancestor's refusals. */
function ancestorRules(input: IdentityInput): string[] {
	return input.account.ancestors
		.filter((fact) => fact.exists)
		.flatMap((fact) => ancestorRule(fact, input));
}

/** Are all existing ancestors root's (no account but root can replace a component)? */
function rootChain(account: AccountFacts): boolean {
	return account.ancestors.every((fact) => !fact.exists || fact.owner === 'root');
}

/** Does the user own an existing ancestor (then root never creates below it)? */
function userChain(account: AccountFacts, user: string): boolean {
	return account.ancestors.some((fact) => fact.exists && fact.owner === user);
}

/** The missing ancestors, the topmost first. */
function missingAncestors(account: AccountFacts): string[] {
	return account.ancestors
		.filter((fact) => !fact.exists)
		.map((fact) => fact.path)
		.reverse();
}

/**
 * A missing folder: created by root under root's parents, else by the user —
 * which must then be able to write its nearest existing ancestor.
 */
function createPlan(input: IdentityInput): FolderPlan | string {
	const { account, answers } = input;
	const ancestors = missingAncestors(account);
	// Another account's parent is ancestorRules' refusal; the plan is root's then.
	if (!userChain(account, answers.service_user)) return { kind: 'create', by: 'root', ancestors };
	const parent = account.ancestors.find((fact) => fact.exists);
	if (parent?.owner === answers.service_user && (parent.mode & 0o200) !== 0) {
		return { kind: 'create', by: 'user', ancestors };
	}
	return `${parent?.path ?? '/'} is not writable by ${answers.service_user}, and one of its parents is ${answers.service_user}'s — create ${answers.install_dir} owned by ${answers.service_user} yourself`;
}

/** An existing directory's plan, or its refusal. */
function existingPlan(input: IdentityInput): FolderPlan | string {
	const { account, answers } = input;
	const folder = account.folder;
	const d = answers.install_dir;
	const held = INSTALL_ENTRIES.find((entry) => folder.entries.includes(entry));
	if (held !== undefined) {
		return `install folder ${d} already holds ${held} — an install (or its remains) is there; the installer never takes one over (remove it or choose another folder)`;
	}
	if (folder.owner === answers.service_user) return ownedPlan(folder, d);
	return foreignPlan(input);
}

/** The user's own folder: used as it is unless others may write it. */
function ownedPlan(folder: AccountFacts['folder'], d: string): FolderPlan | string {
	if ((folder.mode & 0o022) === 0) return { kind: 'owned', empty: folder.entries.length === 0 };
	return `install folder ${d} is writable by group or others (mode ${folder.mode.toString(8).padStart(4, '0')}) — another account could replace the code the service runs; chmod go-w it first`;
}

/**
 * Another account's folder: ADOPTED only when it is root's, empty, under
 * root-owned parents and inside an operator's place (ADOPT_ROOTS) — never
 * another account's folder, never an OS directory.
 */
function foreignPlan(input: IdentityInput): FolderPlan | string {
	const { account, answers } = input;
	const { folder } = account;
	const d = answers.install_dir;
	const u = answers.service_user;
	if (folder.entries.length > 0) {
		return `install folder ${d} is not empty and is not owned by ${u} — the installer uses an existing folder as it is only when it is empty, or already owned by the service user`;
	}
	const refused = adoptRefusal(input);
	if (refused !== null) return refused;
	return { kind: 'adopt', owner: folder.owner, group: folder.group, mode: folder.mode };
}

/** Why an EMPTY folder not the user's is not adopted (null: it is). */
function adoptRefusal(input: IdentityInput): string | null {
	const { account, answers } = input;
	const d = answers.install_dir;
	const u = answers.service_user;
	if (account.folder.owner !== 'root') {
		return `install folder ${d} is empty but owned by ${account.folder.owner}, another account — the installer never takes over another account's folder: chown it to ${u} first, or choose another folder`;
	}
	if (!rootChain(account)) {
		return `install folder ${d} is empty but not owned by ${u}, and one of its parents is not root's — chown it to ${u} first`;
	}
	if (ADOPT_ROOTS.some((root) => d !== root && sameOrInside(d, root))) return null;
	return `install folder ${d} is an existing directory of root outside ${ADOPT_ROOTS.join(', ')} — the installer adopts an empty folder only there (an OS directory such as /var/mail is never taken over): chown it to ${u} first, or choose a folder that does not exist yet`;
}

/** The folder's plan, or its refusal. */
function folderPlan(input: IdentityInput): FolderPlan | string {
	const folder = input.account.folder;
	const d = input.answers.install_dir;
	if (folder.isSymlink) {
		return `install folder path ${d} passes through the symbolic link ${d} — give the real path`;
	}
	if (!folder.exists) return createPlan(input);
	if (!folder.isDirectory) return `install folder ${d} exists and is not a directory`;
	return existingPlan(input);
}

// ── told ─────────────────────────────────────────────────────────────────────

/** The existing account's notices: a login shell, the web user joining its primary group. */
function accountTold(input: IdentityInput): string[] {
	const { account, answers } = input;
	const user = account.user;
	if (user === null) return [];
	return [
		...(NO_LOGIN.test(user.shell)
			? []
			: [
					`account ${user.name} has a login shell (${user.shell}): whoever logs in as it can change the code the service runs`,
				]),
		...(primaryOf(account) !== null
			? [
					`the web server user ${input.webUser} joins ${account.groupName}, the primary group of ${user.name}: it can then read whatever that group can read — a group of its own is recommended (--service-group ded_${answers.instance})`,
				]
			: []),
	];
}

/** The group's other members (and the accounts whose primary group it is). */
function membersTold(input: IdentityInput): string[] {
	const { account, answers } = input;
	const others = [...new Set([...(account.group?.members ?? []), ...account.primaryUsers])].filter(
		(name) => name !== answers.service_user && name !== input.webUser,
	);
	if (others.length === 0) return [];
	return [
		`group ${account.groupName} has other members (${others.join(', ')}): they can read the instance's files`,
	];
}

/** What the operator is told (never refused): a login shell, a shared group. */
function toldLines(input: IdentityInput): string[] {
	return [...accountTold(input), ...membersTold(input)];
}

// ── the verdict ──────────────────────────────────────────────────────────────

/**
 * The existing user whose PRIMARY group the service group is (by the FACTS —
 * defaulted or typed alike), or null.
 */
function primaryOf(account: AccountFacts): string | null {
	const { user, group } = account;
	return user !== null && group !== null && group.gid === user.gid ? user.name : null;
}

/** The group's create/use decision. */
function groupDecision(input: IdentityInput): IdentityVerdict['group'] {
	const { account, answers } = input;
	const create = account.group === null;
	return {
		name: account.groupName,
		create,
		withUser: create && account.user === null && account.groupName === answers.service_user,
		primaryOf: primaryOf(account),
	};
}

/** Is a folder refusal the "already holds an install" one? */
function heldBy(refusal: string): boolean {
	return refusal.includes('an install (or its remains) is there');
}

/** The folder plan's own refusal, unless a same-folder clash with an instance already said it. */
function folderRefusal(folder: FolderPlan | string, sameFolder: boolean): string[] {
	if (typeof folder !== 'string') return [];
	// The folder already holding an install IS the other instance's folder: said once.
	return sameFolder && heldBy(folder) ? [] : [folder];
}

/** The user's create/use decision. */
function userDecision(input: IdentityInput): IdentityVerdict['user'] {
	const user = input.account.user;
	return {
		name: input.answers.service_user,
		create: user === null,
		uid: user?.uid ?? null,
		shell: user?.shell ?? null,
	};
}

/** THE verdict (see the header). */
export function identityVerdict(input: IdentityInput): IdentityVerdict {
	const folder = folderPlan(input);
	const clashes = groupedClashes(input);
	const taken = input.taken ?? [];
	return {
		// An installed instance of this name: the ONE refusal (its account, group and
		// folder follow from it — campaign 3d C3d-F1: they read as "leftovers" to userdel).
		problems:
			taken.length > 0
				? [
						instanceTakenSentence(
							input.answers.instance,
							taken.map((record) => record.source),
						),
					]
				: [
						...userRules(input),
						...groupRules(input),
						...clashes.clauses,
						...folderRefusal(folder, clashes.sameFolder),
						...ancestorRules(input),
						...webRules(input),
					],
		told: toldLines(input),
		user: userDecision(input),
		group: groupDecision(input),
		folder: typeof folder === 'string' ? { kind: 'owned', empty: false } : folder,
		parent: input.account.ancestors.find((fact) => fact.exists)?.path ?? '/',
	};
}
