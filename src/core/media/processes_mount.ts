/**
 * THE PROCESSES DIR'S MOUNT, VERIFIED (A1-01 third review N1b).
 *
 * The component locks (component_lock.ts) decide exclusion by the SERVER's
 * answer to a mutation — `link()` EEXIST, `rmdir()` ENOTEMPTY — so two
 * instances can never both proceed whatever the client caches. What still
 * READS through the client cache is the STALENESS judgement: a holder's
 * identity and heartbeat (file content + attributes) and the existence checks
 * around a reclaim. On an NFS mount that caches lookups and attributes, a
 * reader can see a heartbeat that is no longer the holder's (or none at all)
 * for up to `acregmax`/`acdirmax`, and reclaim a lock whose holder is alive.
 *
 * So on Linux the processes dir's mount is CHECKED, from
 * `/proc/self/mountinfo`. WHICH mount holds the dir is decided by DEVICE: the
 * `st_dev` of the dir (of its nearest existing ancestor when it does not exist
 * yet — nothing is created to ask) against each mount's `maj:min`, among the
 * mounts whose point is a path prefix of its real path (the deepest; the last
 * of equals, as mounts stack). The device is what the kernel actually resolved,
 * so a mount stacked OVER another at the same point, or a bind mount, cannot
 * be mistaken for the one beneath; only when no prefix mount carries the
 * device (a btrfs subvolume reports its own anonymous device) does the
 * deepest prefix decide alone. On `nfs`/`nfs4` it must carry
 *  - `lookupcache=none` — no cached positive or negative lookup;
 *  - `noac`, or every attribute cache time at 0 (`actimeo=0` is shown by the
 *    kernel as `acregmin=0,acregmax=0,acdirmin=0,acdirmax=0`);
 *  - NOT `nocto` — close-to-open consistency is what makes a re-opened lock
 *    or heartbeat file read the server's bytes.
 * Anything else is refused LOUDLY with a typed `media.not_configured`: at boot
 * (server.ts — the instance does not start; in the updater's pre-swap SMOKE
 * boot too, on the LIVE processes dir the updater names — read only, so a
 * release that would refuse to start is refused before the swap) and at the
 * lock door (MediaJobManager — every component-scoped claim refuses; the
 * verdict is re-read every MOUNT_REVERIFY_MS, so a remount while the instance
 * runs is seen within that bound, never trusted forever). Other filesystem
 * types are not judged here (a local disk is coherent by construction). On a
 * platform without `/proc` (macOS — a development platform) nothing is
 * verified; engineering/PRODUCTION.md §8.1 states the requirement.
 */

import { closeSync, openSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readEnv } from '../../config/env.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { readBoundedSync } from '../files/bounded_read.ts';

/** One line of /proc/self/mountinfo: where, which device, what, and every option (per-mount + superblock). */
export interface MountEntry {
	readonly mountPoint: string;
	/** The mount's `maj:min` (field 3) — what a path's `st_dev` is matched against. */
	readonly device: string;
	readonly fsType: string;
	readonly options: readonly string[];
}

/** Where the verification reads its facts — the real host by default; gates inject them. */
export interface MountProbe {
	readonly platform?: string;
	readonly mountinfo?: () => string;
	/** The `maj:min` of an EXISTING path (default: its `st_dev`, decoded the Linux way). */
	readonly deviceOf?: (path: string) => string;
}

/** How long a verified mount is trusted before the lock door reads the table again. */
export const MOUNT_REVERIFY_MS = 60_000;

/** The kernel escapes space, tab, newline and backslash in mountinfo paths as `\ooo`. */
function unescapeMountPath(field: string): string {
	return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
		String.fromCharCode(Number.parseInt(octal, 8)),
	);
}

/** A whitespace-split mountinfo field, '' when the line is short. */
function fieldAt(fields: readonly string[], index: number): string {
	return fields[index] ?? '';
}

/**
 * Parse one mountinfo line: `id parent maj:min root mountpoint opts [optional…]
 * - fstype source superopts`. Null for a line that does not have that shape.
 */
function parseMountLine(line: string): MountEntry | null {
	const fields = line.split(' ');
	const separator = fields.indexOf('-', 6);
	if (separator < 0 || fields.length < separator + 2) return null;
	return {
		mountPoint: unescapeMountPath(fieldAt(fields, 4)),
		device: fieldAt(fields, 2),
		fsType: fieldAt(fields, separator + 1),
		options: [
			...fieldAt(fields, 5).split(','),
			...fieldAt(fields, separator + 3).split(','),
		].filter((option) => option !== ''),
	};
}

/** Every mount of a mountinfo text, in kernel order. */
export function parseMountInfo(text: string): MountEntry[] {
	return text
		.split('\n')
		.map(parseMountLine)
		.filter((entry): entry is MountEntry => entry !== null);
}

/** Is `mountPoint` the path itself or a whole-segment prefix of it? */
function holdsPath(mountPoint: string, path: string): boolean {
	if (mountPoint === '/' || mountPoint === path) return true;
	return path.startsWith(`${mountPoint}/`);
}

/** The deepest mount point over `path` among `entries`, the LAST of equals (stacked mounts). */
function deepestHolder(path: string, entries: readonly MountEntry[]): MountEntry | null {
	let found: MountEntry | null = null;
	for (const entry of entries) {
		if (!holdsPath(entry.mountPoint, path)) continue;
		if (found === null || entry.mountPoint.length >= found.mountPoint.length) found = entry;
	}
	return found;
}

/**
 * The mount holding `path` (a real path) whose device is `device`: the deepest
 * such prefix mount — the device is what the kernel resolved, so an over-mount
 * or a bind cannot pass for the mount beneath. No prefix mount with that device
 * (or no device known): the deepest prefix mount, the last of equals.
 */
export function mountOf(
	path: string,
	entries: readonly MountEntry[],
	device?: string,
): MountEntry | null {
	const sameDevice = entries.filter((entry) => entry.device === device);
	return deepestHolder(path, sameDevice) ?? deepestHolder(path, entries);
}

/** The attribute-cache times `actimeo=0` sets — all four must read 0 when `noac` is absent. */
const ATTRIBUTE_CACHE_TIMES = ['acregmin', 'acregmax', 'acdirmin', 'acdirmax'];

/** Does the mount cache no attributes? (`noac`, or every cache time at 0.) */
function cachesNoAttributes(options: readonly string[]): boolean {
	if (options.includes('noac')) return true;
	return ATTRIBUTE_CACHE_TIMES.every((name) => options.includes(`${name}=0`));
}

/**
 * Why an NFS mount cannot carry the component locks' staleness judgement —
 * empty when it can, and for every filesystem that is not NFS.
 */
export function nfsCoherenceProblems(entry: MountEntry): string[] {
	if (entry.fsType !== 'nfs' && entry.fsType !== 'nfs4') return [];
	const problems: string[] = [];
	if (!entry.options.includes('lookupcache=none')) {
		problems.push('lookupcache=none is not set (a cached lookup can be trusted for seconds)');
	}
	if (!cachesNoAttributes(entry.options)) {
		problems.push('attributes are cached (set actimeo=0 or noac)');
	}
	if (entry.options.includes('nocto')) {
		problems.push('nocto is set (close-to-open consistency is required)');
	}
	return problems;
}

/** The `maj:min` of an existing path, from its `st_dev`. */
export function linuxDeviceOf(path: string): string {
	return decodeLinuxDevice(statSync(path, { bigint: true }).dev);
}

/** `st_dev` as mountinfo's `maj:min` (glibc's encoding: 12+20-bit major, 8+24-bit minor). */
export function decodeLinuxDevice(dev: bigint): string {
	const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
	const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
	return `${major}:${minor}`;
}

/** Where a dir lives: its real path and device, read from its NEAREST EXISTING ancestor (nothing is created). */
interface DirLocation {
	readonly realPath: string;
	readonly device: string | undefined;
}

/**
 * Locate `dir` without creating anything: climb to the nearest ancestor that
 * exists, resolve THAT (mountinfo names canonical paths) and re-append the
 * missing tail — a dir not made yet will be made on its ancestor's mount. Only
 * a MISSING path is climbed past; one that cannot be read (EACCES, EIO) is
 * refused typed — a mount that cannot be located is not trusted.
 */
function locate(dir: string, deviceOf: (path: string) => string): DirLocation {
	let existing = resolve(dir);
	let tail = '';
	for (;;) {
		try {
			return { realPath: join(realpathSync(existing), tail), device: deviceOf(existing) };
		} catch (error) {
			if (!isMissing(error) || existing === dirname(existing)) {
				throw unverifiable(dir, 'cannot be located', error);
			}
			tail = join(basename(existing), tail);
			existing = dirname(existing);
		}
	}
}

/** ENOENT / ENOTDIR: the path is not there (yet) — climb to its parent. */
function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The ceiling of the mount-table read: the lock door is synchronous, so the read
 * is capped (bounded_read.ts), never sized by the file. A few KB on a host, a few
 * hundred on a busy container host; 4 MiB is ~25 000 mounts.
 */
const MOUNTINFO_MAX_BYTES = 4 * 1024 * 1024;

/** A mount table that cannot be read whole is a mount that cannot be judged — refused, typed. */
function unverifiable(path: string, why: string, cause?: unknown): DedaloError {
	return new DedaloError('media.not_configured', {
		message: `${path} ${why} — the media processes dir's mount cannot be verified (engineering/PRODUCTION.md §8.1)`,
		cause,
	});
}

/**
 * A mount table (the real host's by default), read with a byte CEILING
 * (bounded_read.ts — the lock door is synchronous). A table that cannot be
 * opened, or is past the ceiling, is refused typed: a mount that cannot be
 * judged is not trusted.
 */
export function readMountTable(
	path = '/proc/self/mountinfo',
	maxBytes = MOUNTINFO_MAX_BYTES,
): string {
	let fd: number;
	try {
		fd = openSync(path, 'r');
	} catch (error) {
		throw unverifiable(path, 'cannot be opened', error);
	}
	try {
		const bytes = readBoundedSync(fd, maxBytes);
		if (bytes === null) throw unverifiable(path, `is larger than ${maxBytes} bytes`);
		return bytes.toString('utf8');
	} finally {
		closeSync(fd);
	}
}

/** The mount holding `dir` and what it lacks — null when it lacks nothing (or is not NFS). */
function incoherentMountOf(
	location: DirLocation,
	mountinfo: string,
): { entry: MountEntry; problems: string[] } | null {
	const entry = mountOf(location.realPath, parseMountInfo(mountinfo), location.device);
	if (entry === null) return null;
	const problems = nfsCoherenceProblems(entry);
	return problems.length === 0 ? null : { entry, problems };
}

/**
 * REFUSE a processes dir whose mount cannot carry the component locks (see the
 * header) — typed `media.not_configured`, naming the mount and every missing
 * option. A no-op off Linux and for a mount that is not NFS.
 */
export function assertProcessesMountCoherent(dir: string, probe: MountProbe = {}): void {
	if ((probe.platform ?? process.platform) !== 'linux') return;
	const location = locate(dir, probe.deviceOf ?? linuxDeviceOf);
	const found = incoherentMountOf(location, (probe.mountinfo ?? readMountTable)());
	if (found === null) return;
	const { entry, problems } = found;
	throw new DedaloError('media.not_configured', {
		message: `the media processes dir ${dir} is on ${entry.fsType} at ${entry.mountPoint}, mounted without the coherence the component locks need: ${problems.join('; ')}. Remount it with lookupcache=none,actimeo=0 (or noac), or keep it on local disk — engineering/PRODUCTION.md §8.1`,
		coordinates: { dir, mount_point: entry.mountPoint, fs_type: entry.fsType },
	});
}

/**
 * THE SMOKE BOOT'S CHECK (the updater's pre-swap boot of a new release): the
 * mount of the LIVE processes dir the updater names (`DEDALO_SMOKE_PROCESSES_DIR`
 * — the child's own private dir is a throwaway under the staging dir), judged
 * READ ONLY: nothing is created, the nearest existing ancestor is resolved. A
 * mount the new release would refuse at its real boot refuses here, so the
 * update is refused before the swap. An updater that names no dir (one older
 * than this check) is said loudly; nothing is judged.
 */
export function verifySmokeProcessesDirMount(probe: MountProbe = {}): void {
	const dir = readEnv('DEDALO_SMOKE_PROCESSES_DIR');
	if (dir === undefined || dir === '') {
		console.warn(
			'[smoke boot] the updater named no DEDALO_SMOKE_PROCESSES_DIR — the processes dir mount is NOT verified before the swap (the real boot still verifies it)',
		);
		return;
	}
	assertProcessesMountCoherent(dir, probe);
}
