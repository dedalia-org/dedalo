/**
 * DISK SPACE for a code update — the gate that was missing on 2026-08-25, when
 * a remote install failed at the `deps` phase with
 *
 *   NoSpaceLeft: failed opening node_modules/… for package @turf/clusters
 *   FileNotFound: failed copying files from cache to destination
 *
 * i.e. the filesystem filled up in the middle of the quarantine's
 * `bun install`. Everything before it (download, verify, extract) had already
 * spent minutes and disk, and the operator was told only "bun install failed".
 *
 * WHAT AN UPDATE ACTUALLY COSTS. The staging dir holds, at peak, the release
 * ZIP + the extracted tree + that tree's OWN node_modules (a full production
 * install — sharp/onnxruntime alone are hundreds of MB). The swap itself is
 * two renames on the same filesystem, so it adds nothing: the backup dir is
 * the old tree, already on disk.
 *
 * So the requirement is the live tree MINUS what the swap never copies:
 * `PRESERVE_ROOT_ENTRIES` (`.git`) is MOVED into the new tree by
 * `carryPreservedEntries`, never staged. Counting it would over-state the
 * requirement by the size of the repository history — measured on a developer
 * checkout, 2.05 GB of a 3.58 GB tree — and a gate that refuses an update
 * that would have succeeded is worse than no gate. node_modules IS counted:
 * the quarantine installs its own. The subtrahend is derived FROM
 * `PRESERVE_ROOT_ENTRIES` itself, never a second list that could drift.
 *
 * `du -sx` (one filesystem, no crossing into mounts) is the measure. It walks
 * ~10^5 inodes, so the UPDATE path measures fresh (it is slow and rare), and
 * the readiness panel reads the SAME verdict through a shared background
 * measurement with a bounded wait (`checkUpdateSpaceWithin`, status.ts).
 */

import { execFile } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Headroom over the measured requirement: a release grows, and a filesystem
 * at 100% is a broken machine, not a tight fit. */
export const SPACE_MARGIN = 1.15;

/**
 * Bytes AVAILABLE to this (unprivileged) process at `path` — never the
 * root-reserved `bfree`.
 *
 * The path may NOT EXIST YET: the code backup root is created by the first
 * update, and the panel asks about it before that. A missing dir is not a
 * missing filesystem, so walk up to the nearest existing ancestor (same
 * device, same answer) rather than reporting "unmeasurable" on exactly the
 * fresh install most likely to be mis-sized.
 */
export function availableBytesAt(path: string): number | null {
	let probe = path;
	for (;;) {
		if (existsSync(probe)) {
			try {
				const stat = statfsSync(probe);
				return Number(stat.bavail) * Number(stat.bsize);
			} catch {
				return null; // statfs itself is unsupported here
			}
		}
		const parent = dirname(probe);
		if (parent === probe) return null;
		probe = parent;
	}
}

/**
 * Bytes used by `dir`, same filesystem only (`du -skx`), or null if du cannot
 * answer (missing binary, unreadable tree, timeout).
 *
 * A null DISARMS the space gate, so it is REPORTED (CONVENTIONS §2): a silent
 * catch here is how the operator gets the 2026-08-25 wall of NoSpaceLeft a
 * second time with nothing saying the pre-flight check never ran.
 */
export async function treeBytes(dir: string): Promise<number | null> {
	try {
		const { stdout } = await execFileAsync('du', ['-skx', dir], { timeout: 120000 });
		const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
		return Number.isFinite(kb) ? kb * 1024 : null;
	} catch (error) {
		console.warn(
			`[code update] could not measure ${dir} (du) — the pre-flight disk-space gate is disarmed`,
			error,
		);
		return null;
	}
}

export interface UpdateSpaceVerdict {
	/** Available bytes on the staging filesystem, null when unmeasurable. */
	available: number | null;
	/** Bytes the update needs there (staged tree × margin), null when unmeasurable. */
	required: number | null;
	/** false ONLY on a measured shortfall — an unmeasurable side never blocks. */
	sufficient: boolean;
}

/** Human bytes for an operator sentence (GB with one decimal). */
export function formatGb(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Measurement seams (tests inject both sides; production passes none). */
export interface SpaceSeams {
	available?: (path: string) => number | null;
	measure?: (dir: string) => Promise<number | null>;
	exists?: (path: string) => boolean;
}

/**
 * Can this filesystem hold the update? Measures what actually lands in staging
 * (the live tree minus the preserved entries) and the space available where
 * staging lives.
 *
 * `preserved` is the caller's own PRESERVE_ROOT_ENTRIES — passed in, never
 * re-declared here: this module is a LEAF (code_update.ts imports it), and a
 * second copy of that set is precisely the drift the pipeline's law forbids.
 *
 * ONE statfs is enough for both sides: staging is `<backupRoot>/.code_staging`
 * and `renameSwap` hard-asserts the backup and the tree are on the same device.
 *
 * UNMEASURABLE NEVER BLOCKS: a platform without statfs, or a du that fails,
 * yields `sufficient: true` with a null side (and a logged warning). Refusing
 * an update because a diagnostic could not run would be the gate earning trust
 * it cannot keep — the real ENOSPC is still caught downstream, now with a
 * sentence that says so.
 */
export async function checkUpdateSpace(
	targetRoot: string,
	stagingParent: string,
	preserved: ReadonlySet<string>,
	seams: SpaceSeams = {},
): Promise<UpdateSpaceVerdict> {
	const { available: availableOf, measure, exists } = resolveSeams(seams);
	const available = availableOf(stagingParent);
	const staged = await stagedBytes(targetRoot, preserved, measure, exists);
	const required = staged === null ? null : Math.round(staged * SPACE_MARGIN);
	return { available, required, sufficient: isSufficient(available, required) };
}

/** A bounded wait that ran out while the tree was still being measured. */
export interface PendingSpace {
	pending: true;
}

/** How long a settled tree measurement answers the PANEL (never the pipeline). */
export const PANEL_SPACE_TTL_MS = 10 * 60 * 1000;

/**
 * The panel's tree measurements: in flight, or settled within the TTL. Keyed
 * on the measured tree + the preserved set; ONE `du` per key at a time, shared
 * by every asker. No request identity.
 */
const panelStagedBytes = new Map<string, PanelEntry>();

/**
 * The SAME verdict as `checkUpdateSpace`, for the readiness PANEL: the free
 * bytes are read live (one statfs), the slow side — the staged tree size — is
 * measured once in the background, shared, and reused for PANEL_SPACE_TTL_MS
 * (a code tree's size moves by MB between updates, not by the GB a verdict
 * turns on). A lost wait reports `pending` and the measurement carries on for
 * the next asker. The pipeline never reads this: it measures fresh
 * (`checkUpdateSpace`) at the moment it spends disk.
 */
export async function checkUpdateSpaceWithin(
	maxWaitMs: number,
	targetRoot: string,
	stagingParent: string,
	preserved: ReadonlySet<string>,
	seams: SpaceSeams = {},
): Promise<UpdateSpaceVerdict | PendingSpace> {
	const { available: availableOf, measure, exists } = resolveSeams(seams);
	const key = [targetRoot, ...[...preserved].sort()].join('\0');
	const entry = panelEntry(
		key,
		() => stagedBytes(targetRoot, preserved, measure, exists),
		targetRoot,
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const lost = new Promise<'lost'>((resolveLost) => {
		timer = setTimeout(() => resolveLost('lost'), maxWaitMs);
	});
	try {
		const staged = await Promise.race([entry.promise, lost]);
		if (staged === 'lost') return { pending: true };
		const available = availableOf(stagingParent);
		const required = staged === null ? null : Math.round(staged * SPACE_MARGIN);
		return { available, required, sufficient: isSufficient(available, required) };
	} finally {
		clearTimeout(timer);
	}
}

type PanelEntry = {
	promise: Promise<number | null>;
	settledAt: number | null;
	bytes: number | null;
};

/** The shared measurement for `key`: the live one, or a fresh one started now (an expired one is dropped). */
function panelEntry(
	key: string,
	measureTree: () => Promise<number | null>,
	targetRoot: string,
): PanelEntry {
	const entry = panelStagedBytes.get(key);
	const expired = entry?.settledAt != null && Date.now() - entry.settledAt > PANEL_SPACE_TTL_MS;
	if (entry !== undefined && !expired) return entry;
	const fresh: PanelEntry = { promise: Promise.resolve(null), settledAt: null, bytes: null };
	fresh.promise = measureTree().then(
		(bytes) => {
			fresh.bytes = bytes;
			fresh.settledAt = Date.now();
			return bytes;
		},
		(error: unknown) => {
			// detached after a lost wait: logged, never an unhandled rejection
			console.error(`[code update] panel tree measurement of '${targetRoot}' failed:`, error);
			panelStagedBytes.delete(key);
			return null;
		},
	);
	panelStagedBytes.set(key, fresh);
	return fresh;
}

/** Forget the panel's measurements (test seam). */
export function resetPanelSpaceMeasurements(): void {
	panelStagedBytes.clear();
}

/** Production measures, unless a test injected its own. */
function resolveSeams(seams: SpaceSeams): Required<SpaceSeams> {
	return {
		available: seams.available ?? availableBytesAt,
		measure: seams.measure ?? treeBytes,
		exists: seams.exists ?? existsSync,
	};
}

/** A null on EITHER side is "the gate could not run" — which never refuses. */
function isSufficient(available: number | null, required: number | null): boolean {
	if (available === null || required === null) return true;
	return available >= required;
}

/**
 * What of the live tree actually LANDS IN STAGING: everything except the
 * preserved entries, which the swap renames into the new tree. Null when any
 * needed measure failed — the caller reads that as "gate disarmed".
 */
async function stagedBytes(
	targetRoot: string,
	preserved: ReadonlySet<string>,
	measure: (dir: string) => Promise<number | null>,
	exists: (path: string) => boolean,
): Promise<number | null> {
	const live = await measure(targetRoot);
	if (live === null) return null;

	let staged = live;
	for (const name of preserved) {
		const path = join(targetRoot, name);
		// ABSENT costs nothing and must not disarm the gate: a RELEASE install
		// has no `.git` at all, and treating that as unmeasurable would switch
		// the check off on every production installation.
		if (!exists(path)) continue;
		const carried = await measure(path);
		// An unmeasurable PRESENT entry must not silently inflate the
		// requirement back to the whole tree: disarm rather than over-count.
		if (carried === null) return null;
		staged -= carried;
	}
	return Math.max(staged, 0);
}

/** Does a failure's output name a full disk? (bun says `NoSpaceLeft`, libc
 * `ENOSPC`, coreutils "No space left on device".) */
export function looksLikeNoSpace(output: string): boolean {
	return /NoSpaceLeft|ENOSPC|No space left on device/i.test(output);
}
