/**
 * A local ONTOLOGY SOURCE THE SERVICE USER CAN READ (install campaign C4,
 * 2026-11-07, RHEL10 F1). On the production route the root process validates
 * `--ontology-source` (the plan reads its catalog as root), but the engine
 * steps that STAGE its files run as the service user (engine_delegate.ts). A
 * source under the operator's home — the checkout's own
 * `install/import/ontology/7.0`, the most natural one — sits behind a 0700
 * home on RHEL, Debian and Ubuntu ≥ 21.04: the plan accepted it, and the run
 * failed at host_engine after packages, account, runtime and database were
 * already done. The System check says it first, before any change.
 *
 * The verdict is read from the modes and owners (the classic owner / group /
 * others bits), for the service user and the ONE service group the engine
 * child runs with (see Reader). POSIX ACLs and SELinux labels are not read: a path an ACL opens
 * may be refused here (move the source, as the sentence says), never the
 * reverse. A symlinked component is not judged (the walk stops at it): the
 * engine's own error then names the permission (ontology_catalog.ts).
 */

import { basename, dirname, resolve } from 'node:path';
import type { HostCtx, HostPlanCtx } from '../contract.ts';
import type { HostStat } from '../fs.ts';
import type { AccountFacts } from './account_facts.ts';

/** The permission bits one access needs, at the owner position (r=4, x=1). */
const READ = 4;
const TRAVERSE = 1;

/**
 * Who reads, for a mode check: the service user and its ONE group. The engine
 * child runs as `runuser -u <user> -g <group>` (execute.ts): with -g, runuser
 * sets exactly that group and skips initgroups — the account's other groups do
 * NOT apply (measured on Ubuntu 26.04, 2026-11-08: `id` under `runuser -g`
 * lists one group). Ids are kept beside the names: a stat names an owner from
 * the LOCAL passwd/group files only, so an LDAP/sssd owner reads as its number.
 */
interface Reader {
	user: string;
	uid: string | null;
	group: string;
	gid: string | null;
}

/** The service user as the host will have it (an existing account's ids, or a new one's names). */
function readerOf(user: string, group: string, account: AccountFacts | null | undefined): Reader {
	const existing = account?.user ?? null;
	const groupEntry = account?.group ?? null;
	return {
		user,
		uid: existing === null ? null : String(existing.uid),
		group,
		gid: groupEntry === null ? null : String(groupEntry.gid),
	};
}

/** May `reader` use `bits` (READ|TRAVERSE at the owner position) on `stat`? Exactly one class of bits applies. */
export function grants(stat: HostStat, reader: Reader, bits: number): boolean {
	const owns = stat.owner === reader.user || (reader.uid !== null && stat.owner === reader.uid);
	const inGroup = stat.group === reader.group || (reader.gid !== null && stat.group === reader.gid);
	const shift = owns ? 6 : inGroup ? 3 : 0;
	return ((stat.mode >> shift) & bits) === bits;
}

/** The directories from `/` down to `path`'s parent. */
function ancestorsOf(path: string): string[] {
	const chain: string[] = [];
	for (let dir = dirname(path); ; dir = dirname(dir)) {
		chain.unshift(dir);
		if (dir === dirname(dir)) return chain;
	}
}

/** The files the engine reads from a source directory (its manifest and packages). */
function packageFiles(ctx: Pick<HostCtx, 'fs'>, dir: string): string[] {
	return (
		ctx.fs
			.list(dir)
			// The names the engine's reader takes (data_io_import.ts) — no other file is judged.
			.filter((name) => name === 'ontology.json' || /^[a-z_]{2,}\.copy\.gz$/.test(name))
			.map((name) => `${dir}/${name}`)
	);
}

/** The first path the reader cannot use as the engine needs it, with why; null = readable (or not judged). */
function firstBlocker(ctx: Pick<HostCtx, 'fs'>, source: string, reader: Reader): string | null {
	const describe = (path: string, stat: HostStat, need: string): string =>
		`${path} (${stat.owner}:${stat.group}, mode ${(stat.mode & 0o777).toString(8).padStart(3, '0')}) is not ${need} by ${reader.user}`;
	for (const dir of ancestorsOf(source)) {
		const stat = ctx.fs.stat(dir);
		if (stat === null || stat.isSymlink) return null;
		if (!grants(stat, reader, TRAVERSE)) return describe(dir, stat, 'traversable');
	}
	const stat = ctx.fs.stat(source);
	if (stat === null || stat.isSymlink) return null;
	if (!stat.isDirectory)
		return grants(stat, reader, READ) ? null : describe(source, stat, 'readable');
	if (!grants(stat, reader, READ | TRAVERSE)) return describe(source, stat, 'listable');
	for (const file of packageFiles(ctx, source)) {
		const fileStat = ctx.fs.stat(file);
		if (fileStat === null || fileStat.isSymlink) continue;
		if (!grants(fileStat, reader, READ)) return describe(file, fileStat, 'readable');
	}
	return null;
}

/**
 * The refusal of a local `--ontology-source` the service user cannot read
 * (empty when there is no local source, or it is readable).
 */
export function ontologySourceAccessProblems(ctx: HostPlanCtx & Pick<HostCtx, 'fs'>): string[] {
	if (ctx.answers.ontology_source === '') return [];
	const source = resolve(ctx.answers.ontology_source);
	const reader = readerOf(ctx.paths.user, ctx.paths.group, ctx.facts.account);
	const blocker = firstBlocker(ctx, source, reader);
	if (blocker === null) return [];
	return [
		`--ontology-source ${source}: ${blocker} — the engine steps read the source as the service user ${reader.user}, never as root: copy it where every user can read it (e.g. /srv/${basename(source)}) and pass that path, or open the directory named to others (chmod o+x for a directory on the way, o+r for a file)`,
	];
}
