/**
 * THE SERVICE ACCOUNT AND THE INSTALL FOLDER, AS THE HOST HAS THEM (owner
 * decisions 2026-10-12) — read-only facts host_preflight freezes and the
 * identity probe shows, gathered from the ANSWERS alone (never from the
 * instance paths: the group the paths carry is decided BY these facts):
 *
 *  - the service user (`getent passwd <u>`: uid, primary gid and its group's
 *    name, home, shell) — absent = the installer creates it;
 *  - the service group (the answer, else the existing user's primary group,
 *    else the user's own name — layout.ts serviceGroupOf) and its members,
 *    the accounts whose PRIMARY group it is (a local `getent passwd` scan), the
 *    same-named group of a new user (a leftover the installer never reuses by
 *    default), and the user's other groups (`id -G` / `id -Gn`: systemd's User=
 *    calls initgroups, so the RUNNING service holds every one of them — the
 *    install-time steps do not: `runuser -g <service group>` sets that one
 *    group only, see identity_rules.ts searchable);
 *  - /etc/login.defs' regular uid/gid ranges;
 *  - the install folder (lstat: never followed; owner, mode, entries) and each
 *    of its ancestors up to `/` (and the backup dir's: it may lie outside).
 *
 * Each lookup is by NAME (getent answers LDAP/sssd accounts too; only the
 * primary-user scan is local-enumeration bound). Nothing is changed. PURE
 * parsers + one gather function through the runner and the HostFs.
 */

import { dirname } from 'node:path';
import type { InstallAnswers } from '../../install_plan.ts';
import type { HostFs, HostStat } from '../fs.ts';
import { serviceGroupOf } from '../layout.ts';
import { binaryOf, type OsRow } from '../os_support.ts';
import type { CommandRunner } from '../runner.ts';

export interface PasswdEntry {
	name: string;
	uid: number;
	gid: number;
	home: string;
	shell: string;
	/** The name of its primary group (null: the gid names no group). */
	primaryGroup: string | null;
}

export interface GroupEntry {
	name: string;
	gid: number;
	members: string[];
}

export interface LoginDefs {
	uidMin: number;
	uidMax: number;
	gidMin: number;
	gidMax: number;
}

/** One path as lstat sees it (never followed). */
export interface PathFact {
	path: string;
	exists: boolean;
	isDirectory: boolean;
	isSymlink: boolean;
	owner: string;
	group: string;
	mode: number;
}

export interface AccountFacts {
	/** The service user's entry (null: absent — the installer creates it). */
	user: PasswdEntry | null;
	/** The service group's resolved name and entry (null: absent — the installer creates it). */
	groupName: string;
	group: GroupEntry | null;
	/** The group named like the user, when the user is absent (a leftover). */
	sameNamedGroup: GroupEntry | null;
	/** Every group the existing user is in (primary included), by `id`. */
	memberOf: { name: string; gid: number }[];
	/** Other accounts whose PRIMARY group is the service group (local scan). */
	primaryUsers: string[];
	loginDefs: LoginDefs;
	/** The install folder; `entries` its names (sorted) when it is a directory. */
	folder: PathFact & { entries: string[] };
	/** The folder's ancestors, its parent first, up to `/`. */
	ancestors: PathFact[];
	/** The backup dir's ancestors (it may lie outside the install folder), its parent first. */
	backupAncestors: PathFact[];
}

/** The defaults useradd/groupadd use when /etc/login.defs says nothing. */
const LOGIN_DEFS_DEFAULT: LoginDefs = Object.freeze({
	uidMin: 1000,
	uidMax: 60000,
	gidMin: 1000,
	gidMax: 60000,
});

/** A `name:x:uid:gid:gecos:home:shell` line → its entry (null: not one). */
export function parsePasswd(line: string): Omit<PasswdEntry, 'primaryGroup'> | null {
	const cols = line.trim().split(':');
	if (cols.length < 7 || !/^\d+$/.test(cols[2] ?? '') || !/^\d+$/.test(cols[3] ?? '')) return null;
	return {
		name: cols[0] as string,
		uid: Number(cols[2]),
		gid: Number(cols[3]),
		home: cols[5] as string,
		shell: cols[6] as string,
	};
}

/** A `name:x:gid:members` line → its entry (null: not one). */
export function parseGroup(line: string): GroupEntry | null {
	const cols = line.trim().split(':');
	if (cols.length < 3 || !/^\d+$/.test(cols[2] ?? '')) return null;
	return {
		name: cols[0] as string,
		gid: Number(cols[2]),
		members: (cols[3] ?? '').split(',').filter((member) => member !== ''),
	};
}

/** One numeric login.defs key (the default when absent or malformed). */
function loginDef(text: string, key: string, fallback: number): number {
	const value = new RegExp(`^\\s*${key}\\s+(\\d+)\\s*$`, 'm').exec(text)?.[1];
	return value === undefined ? fallback : Number(value);
}

/** /etc/login.defs' regular uid/gid ranges. */
export function parseLoginDefs(text: string): LoginDefs {
	return {
		uidMin: loginDef(text, 'UID_MIN', LOGIN_DEFS_DEFAULT.uidMin),
		uidMax: loginDef(text, 'UID_MAX', LOGIN_DEFS_DEFAULT.uidMax),
		gidMin: loginDef(text, 'GID_MIN', LOGIN_DEFS_DEFAULT.gidMin),
		gidMax: loginDef(text, 'GID_MAX', LOGIN_DEFS_DEFAULT.gidMax),
	};
}

/** `id -G` + `id -Gn` → (name, gid) pairs (empty when they disagree in length). */
export function parseIdGroups(gids: string, names: string): { name: string; gid: number }[] {
	const ids = gids
		.trim()
		.split(/\s+/)
		.filter((item) => /^\d+$/.test(item));
	const words = names
		.trim()
		.split(/\s+/)
		.filter((item) => item !== '');
	if (ids.length !== words.length) return [];
	return ids.map((gid, index) => ({ name: words[index] as string, gid: Number(gid) }));
}

/** A path as a fact (absent: every flag false). */
export function pathFact(path: string, stat: HostStat | null): PathFact {
	return {
		path,
		exists: stat !== null,
		isDirectory: stat?.isDirectory === true,
		isSymlink: stat?.isSymlink === true,
		owner: stat?.owner ?? '',
		group: stat?.group ?? '',
		mode: stat?.mode ?? 0,
	};
}

/** Every ancestor of an absolute path, its parent first, `/` last ([] for `/` or a relative path). */
export function ancestorsOf(path: string): string[] {
	const list: string[] = [];
	if (!path.startsWith('/')) return list;
	for (let dir = dirname(path); dir !== path && list.at(-1) !== '/'; dir = dirname(dir)) {
		list.push(dir);
	}
	return list;
}

/** A read-only lookup's stdout ('' when it failed — a missing binary included). */
async function lookup(runner: CommandRunner, argv: string[]): Promise<string> {
	try {
		const result = await runner.run({ argv, timeoutMs: 60_000 });
		return result.exitCode === 0 ? result.stdout : '';
	} catch {
		return '';
	}
}

/** `getent <database> <key>` → the first line parsed by `parse`. */
async function getent<T>(
	runner: CommandRunner,
	row: OsRow,
	database: 'passwd' | 'group',
	key: string,
	parse: (line: string) => T | null,
): Promise<T | null> {
	if (key === '') return null;
	const line = (await lookup(runner, [binaryOf(row, 'getent'), database, key])).split('\n')[0];
	return parse(line ?? '');
}

/** The user, with its primary group's name. */
async function userFacts(
	runner: CommandRunner,
	row: OsRow,
	name: string,
): Promise<PasswdEntry | null> {
	const entry = await getent(runner, row, 'passwd', name, parsePasswd);
	if (entry === null || entry.name !== name) return null;
	const primary = await getent(runner, row, 'group', String(entry.gid), parseGroup);
	return { ...entry, primaryGroup: primary?.name ?? null };
}

/** An existing user's PRIMARY group name (null: no such user, or its gid names no group). */
export async function primaryGroupName(
	runner: CommandRunner,
	row: OsRow,
	user: string,
): Promise<string | null> {
	return (await userFacts(runner, row, user))?.primaryGroup ?? null;
}

/** The existing user's groups (by `id`; none for an absent user). */
async function memberships(
	runner: CommandRunner,
	row: OsRow,
	user: PasswdEntry | null,
): Promise<{ name: string; gid: number }[]> {
	if (user === null) return [];
	const id = binaryOf(row, 'id');
	return parseIdGroups(
		await lookup(runner, [id, '-G', user.name]),
		await lookup(runner, [id, '-Gn', user.name]),
	);
}

/** The local accounts whose primary group is `group` (the user itself excluded). */
async function primaryUsersOf(
	runner: CommandRunner,
	row: OsRow,
	group: GroupEntry | null,
	user: string,
): Promise<string[]> {
	if (group === null) return [];
	const all = await lookup(runner, [binaryOf(row, 'getent'), 'passwd']);
	return all
		.split('\n')
		.map(parsePasswd)
		.filter((entry) => entry !== null && entry.gid === group.gid && entry.name !== user)
		.map((entry) => (entry as NonNullable<typeof entry>).name);
}

/** The install folder and its ancestors (lstat — never followed). */
export function folderFacts(fs: HostFs, dir: string): Pick<AccountFacts, 'folder' | 'ancestors'> {
	const folder = pathFact(dir, dir === '' ? null : fs.stat(dir));
	return {
		folder: { ...folder, entries: folder.isDirectory ? fs.list(dir) : [] },
		ancestors: ancestorsOf(dir).map((path) => pathFact(path, fs.stat(path))),
	};
}

/** The group the service runs as, and the user's same-named leftover (see the header). */
async function groupFacts(
	runner: CommandRunner,
	row: OsRow,
	answers: InstallAnswers,
	user: PasswdEntry | null,
): Promise<Pick<AccountFacts, 'groupName' | 'group' | 'sameNamedGroup'>> {
	const groupName = serviceGroupOf(answers, { user });
	const group = await getent(runner, row, 'group', groupName, parseGroup);
	const sameNamed =
		user === null ? await getent(runner, row, 'group', answers.service_user, parseGroup) : null;
	return {
		groupName,
		group: group?.name === groupName ? group : null,
		sameNamedGroup: sameNamed?.name === answers.service_user ? sameNamed : null,
	};
}

/** Gather the facts (see the header) — read-only. */
export async function gatherAccountFacts(
	runner: CommandRunner,
	fs: HostFs,
	row: OsRow,
	answers: InstallAnswers,
): Promise<AccountFacts> {
	const user = await userFacts(runner, row, answers.service_user);
	const groups = await groupFacts(runner, row, answers, user);
	return {
		user,
		...groups,
		memberOf: await memberships(runner, row, user),
		primaryUsers: await primaryUsersOf(runner, row, groups.group, answers.service_user),
		loginDefs: parseLoginDefs(fs.readText('/etc/login.defs') ?? ''),
		...folderFacts(fs, answers.install_dir),
		backupAncestors: folderFacts(fs, answers.backup_dir).ancestors,
	};
}

/** The facts before anything was measured (only host_preflight runs with these). */
export function pendingAccountFacts(): AccountFacts {
	return {
		user: null,
		groupName: '',
		group: null,
		sameNamedGroup: null,
		memberOf: [],
		primaryUsers: [],
		loginDefs: { ...LOGIN_DEFS_DEFAULT },
		folder: { ...pathFact('', null), entries: [] },
		ancestors: [],
		backupAncestors: [],
	};
}
