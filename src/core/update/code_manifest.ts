/**
 * Code-update DISCOVERY (UPDATE_PROCESS Phase 4) — the master-side release
 * manifest (PHP update_code::get_code_update_info) and the client-side linear
 * upgrade-path check (PHP update_code.js supported_code_version).
 *
 * The manifest advertises ONLY release archives that (a) sit on the linear
 * upgrade path from the caller's RELEASE IDENTITY (never its data version —
 * audit U-06) and (b) actually exist on disk. The
 * TS UPDATE_CATALOG is EMPTY for 7.x, so a stock 7.0.0 master advertises no
 * releases — correct: there is no next version to build yet.
 *
 * RELEASE NOTES (2026-10-09, WC-2026-10-09-code-manifest-release-notes). A
 * PUBLISHED item carries `notes` when the master's own
 * `changes/<version>/release.json` froze them at the release cut
 * (`bun run changelog release`, scripts/lib/change_log.ts deriveReleaseNotes):
 * the operator reads what a release changes before choosing it. The engine
 * reads that JSON only — never the markdown fragments — and any failure (no
 * snapshot, a beta snapshot without notes, a malformed file) leaves the field
 * absent. Developer items never carry notes: a branch build has no release.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { projectRoot } from '../../config/env.ts';
import { UPDATE_CATALOG } from './catalog.ts';
import type { InstallChannel } from './install_stamp.ts';
import {
	compareReleaseIdentities,
	parseReleaseVersion,
	RELEASE_VERSION_RE,
} from './release_identity.ts';
import { type WireReleasePlan, wirePlansAbove } from './release_plans_wire.ts';
import { compareVersionArrays } from './version.ts';
import { identityWalkRefusal, newestOfRung, nextRungKind } from './version_walk.ts';

/**
 * One advertised release (PHP file_item).
 *
 * `sha256` is SNAKE-adjacent wire spelling because the client forwards the
 * whole item back as `options.file` (`file.sha256`). `force_update_mode` LEFT
 * the wire with the clean-only pipeline
 * (WC-2026-08-23-update-mode-clean-only): clean is the only install mode, so
 * the manifest advertises nothing to branch on.
 */
export interface CodeReleaseItem {
	version: string;
	url: string;
	date: string;
	/** sha256 of the archive, from the `<file>.zip.sha256` sidecar (WC-024). */
	sha256?: string;
	/**
	 * Present ONLY on a developer-channel item ('dev', 2026-08-24) or a
	 * prerelease item ('prerelease', RELEASE_IDENTITY_DESIGN §2.8). A published
	 * release carries no `channel` at all, so the release manifest is
	 * byte-unchanged by either feature. The consumer forwards the whole item
	 * back as `options.file`, and `code_update.ts` reads this to know which
	 * channel the archive was offered on.
	 */
	channel?: 'dev' | 'prerelease';
	/**
	 * The RELEASE IDENTITY a prerelease item is (`7.0.1-beta.2`) — present only
	 * on a prerelease item. `version` stays the DATA triple (the URL's dir
	 * segment, and the one shape every consumer's update door parses — an older
	 * engine refuses `7.0.1-beta.2` as a malformed version), so the identity
	 * rides beside it, never in its place.
	 */
	release?: string;
	/** The release's notes (published items only; absent when the master froze none). */
	notes?: CodeReleaseNotes;
}

/** One change of a release, as the update panel lists it. */
export interface CodeReleaseNoteEntry {
	type: string;
	audience: string;
	title: string;
}

/**
 * The master's own frozen release notes: `changes/<version>/release.json` in the
 * SHIPPED tree (release content — read-only, replaced with the tree).
 */
export const RELEASE_NOTES_DIR: string = join(projectRoot, 'changes');

/** `changes/<version>/release.json` `notes`, plus the release's date. */
export interface CodeReleaseNotes {
	date: string;
	action_needed: string[];
	entries: CodeReleaseNoteEntry[];
}

export interface CodeUpdateInfo {
	info: {
		version: string;
		date: string;
		entity_id: number | string | null;
		entity: string | null;
		host: string | null;
		/**
		 * EVERY rung this master HONOURED for the ask, in ladder order — always
		 * `master` first, then `prerelease` and/or `dev` (RELEASE_IDENTITY_DESIGN
		 * §2.8 item 2). A SET, not the highest rung: the two master switches are
		 * separate, so a `dev` ask on a master that publishes developer builds but
		 * no prereleases honours `dev` WITHOUT `prerelease`, and a single "highest
		 * rung" would claim the betas too. The consumer compares it with what it
		 * asked to say "this server does not offer prereleases" instead of
		 * silently listing less. ABSENT from an older master's answer, which never
		 * honours `prerelease` (its channel parse is `=== 'dev' ? 'dev' :
		 * 'master'`): the client reads that absence itself (update_code_channel.js).
		 */
		channels?: InstallChannel[];
	};
	files: CodeReleaseItem[];
	/**
	 * The plan of every catalog release above the asker (release_plans_wire.ts):
	 * how the consumer's update run learns the steps of a release its own
	 * catalog does not know yet. Ignored by an older consumer.
	 */
	plans: WireReleasePlan[];
}

/**
 * The versions on the LINEAR upgrade path from `origin` (PHP
 * get_code_update_info walk): the next minor within the current major must be
 * exhausted before the next major boundary (x.0.0) becomes visible. Returns
 * the catalog target triples in ascending order.
 *
 * `origin` is the triple of the asker's RELEASE IDENTITY ({@link
 * codeLadderTargets} — never its data version: audit U-06). Which triple is
 * "the next rung" is THE swap door's own rule (version_walk.ts nextRungKind),
 * so the manifest offers exactly the rungs the door accepts.
 */
export function linearUpgradeTargets(
	origin: readonly number[],
	catalog: typeof UPDATE_CATALOG = UPDATE_CATALOG,
): number[][] {
	const from = normalizedClientTriple(origin);
	const targets: number[][] = [];
	let nextMajor: number[] | null = null;
	let nextMinor: number[] | null = null;
	for (const descriptor of Object.values(catalog)) {
		const triple = [descriptor.versionMajor, descriptor.versionMedium, descriptor.versionMinor];
		const rung = nextRungKind(from, triple);
		if (rung === 'major') nextMajor = triple;
		else if (rung === 'minor') nextMinor = triple;
		else if (rung === 'patch') targets.push(triple);
	}
	appendBoundaryTarget(targets, nextMinor, nextMajor);
	// One dedupe over the WHOLE list (defect D17, fixed 2026-08-09): the same
	// triple can be reached from two catalog keys, not only from the boundary
	// candidate, and a duplicated rung would be advertised twice in the manifest.
	const unique = [...new Map(targets.map((triple) => [triple.join('.'), triple])).values()];
	return unique.sort(compareVersionArrays);
}

/**
 * THE CODE LADDER (audit U-06, 2026-10-29): the catalog rungs above the
 * asker's RELEASE IDENTITY `releaseIdentity` (`X.Y.Z`, `X.Y.Z-beta.N`,
 * `X.Y.Z-dev`) — walked from that identity's triple, the triple the swap door
 * walks from (version_walk.ts identityWalkRefusal → assertLinearUpgrade).
 *
 * WHY NOT THE DATA VERSION: a code-only patch never moves DEDALO_DATA_VERSION,
 * so a `7.0.1` install still reports data `7.0.0`. Walked from the data triple
 * the ladder reached only `7.0.1` — which the asker floor then dropped as its
 * own identity — and `7.0.2` (which the door accepts from `7.0.1`) was never
 * offered. Garbage (not an identity) walks from nothing: no rung.
 */
export function codeLadderTargets(
	releaseIdentity: string,
	catalog: typeof UPDATE_CATALOG = UPDATE_CATALOG,
): number[][] {
	const parsed = parseReleaseVersion(releaseIdentity);
	return parsed === null ? [] : linearUpgradeTargets(parsed.triple, catalog);
}

/** The ONE boundary rung the manifest advertises: the minor candidate
 * OVERRIDES the major one — the next minor within the current major must be
 * exhausted before the x+1.0.0 boundary is visible. */
function appendBoundaryTarget(
	targets: number[][],
	nextMinor: number[] | null,
	nextMajor: number[] | null,
): void {
	const boundary = nextMinor ?? nextMajor;
	if (boundary !== null) targets.push(boundary);
}

/** A version as an exact [major, minor, patch], missing parts = 0. */
function normalizedClientTriple(version: readonly number[]): [number, number, number] {
	return [version[0] ?? 0, version[1] ?? 0, version[2] ?? 0];
}

/** Everything `buildCodeUpdateInfo` needs to answer one consumer's ask. */
export interface CodeUpdateInfoOptions {
	/**
	 * The asker's DATA version (the wire `options.version`, a bare `X.Y.Z` —
	 * the one shape every master, older ones included, parses). NOT the walk
	 * origin (audit U-06): it only bounds which release claim is believed
	 * ({@link askerIdentity}) and, when no claim is believed, stands in for
	 * the identity (an asker that predates `options.release` — before the
	 * release identity existed its identity WAS its data triple, so the walk
	 * from it is exact for that asker).
	 */
	clientVersion: readonly number[];
	serverVersion: readonly number[];
	codeFilesDir: string | undefined;
	publicBaseUrl: string;
	info: Omit<CodeUpdateInfo['info'], 'version'>;
	catalog?: typeof UPDATE_CATALOG;
	/** What the CONSUMER asked for (its panel choice). Default: releases only. */
	channel?: InstallChannel;
	/**
	 * The consumer's RELEASE IDENTITY (`options.release`, e.g. `7.0.1`,
	 * `7.0.0-beta.6`) — THE ORIGIN OF THE CODE LADDER ({@link codeLadderTargets})
	 * and what decides which prereleases and same-triple releases sit ABOVE it.
	 * Untrusted wire text: used only when it parses AND ranks at or above the
	 * asker's data triple; otherwise the asker is placed at its bare data triple
	 * (the stable release of it) — see {@link askerIdentity}.
	 */
	clientRelease?: unknown;
	/** Whether THIS master publishes developer builds (DEDALO_CODE_SERVER_DEV_CHANNEL). */
	devChannelEnabled?: boolean;
	/** Whether THIS master publishes prereleases (DEDALO_CODE_SERVER_PRERELEASE_CHANNEL). */
	prereleaseChannelEnabled?: boolean;
	/** The master's `changes/` dir — where each release's frozen notes live. Absent ⇒ no notes. */
	changesDir?: string;
}

/**
 * Build the release manifest (PHP get_code_update_info). Advertises a release
 * only when its `<major.minor.patch>.zip` exists under `codeFilesDir`. The
 * rungs are walked from the asker's RELEASE identity, never its data version
 * (audit U-06; {@link codeLadderTargets}).
 */
export function buildCodeUpdateInfo(options: CodeUpdateInfoOptions): CodeUpdateInfo {
	const targets = codeLadderTargets(askerIdentity(options), options.catalog ?? UPDATE_CATALOG);
	const exposure = channelExposure(options);
	return {
		info: {
			version: options.serverVersion.join('.'),
			...options.info,
			channels: honouredChannels(exposure),
		},
		files: manifestFiles(options, targets, exposure),
		plans: wirePlansAbove(parseReleaseVersion(askerIdentity(options))?.triple ?? []),
	};
}

/** What one ask is shown, after BOTH halves of each switch are read. */
interface ChannelExposure {
	dev: boolean;
	prerelease: boolean;
}

/**
 * THE LADDER (owner Q8: `master ⊂ prerelease ⊂ dev`), each rung needing BOTH
 * switches — the consumer's ask and this master's own opt-in, never one
 * alone:
 *  - developer builds: a `dev` ask on a master with
 *    DEDALO_CODE_SERVER_DEV_CHANNEL;
 *  - prereleases: a `prerelease` OR `dev` ask (a developer also tests the
 *    betas) on a master with DEDALO_CODE_SERVER_PRERELEASE_CHANNEL.
 * The two master switches stay SEPARATE (same reasoning as codeReleasePath's
 * note on the dev switch): publishing immutable betas must not expose branch
 * builds, nor the other way round. A master that opted into neither answers
 * every ask exactly as it answers a release one — nothing is enumerable.
 */
function channelExposure(options: CodeUpdateInfoOptions): ChannelExposure {
	const asked = options.channel ?? 'master';
	return {
		dev: asked === 'dev' && options.devChannelEnabled === true,
		prerelease: asked !== 'master' && options.prereleaseChannelEnabled === true,
	};
}

/** Every rung the exposure reached, in ladder order — what `info.channels` reports back. */
function honouredChannels(exposure: ChannelExposure): InstallChannel[] {
	const rungs: InstallChannel[] = ['master'];
	if (exposure.prerelease) rungs.push('prerelease');
	if (exposure.dev) rungs.push('dev');
	return rungs;
}

/**
 * Every item this manifest advertises, in this order: the dev rows (both dev
 * switches on), then — ascending by release identity — the archives of the
 * asker's OWN triple that sit above its identity, then one item per upgrade
 * rung.
 */
function manifestFiles(
	options: CodeUpdateInfoOptions,
	targets: readonly number[][],
	exposure: ChannelExposure,
): CodeReleaseItem[] {
	if (options.codeFilesDir === undefined || !existsSync(options.codeFilesDir)) return [];
	const running = askerIdentity(options);
	const dev = exposure.dev ? devItemsFor(options.codeFilesDir, options.publicBaseUrl, running) : [];
	// One archive, one row: the same-triple list (the asker's identity triple)
	// and the rung list (the rungs ABOVE that triple) are disjoint by
	// construction since the ladder walks from the identity (U-06); the dedupe
	// stays as the guard that one archive is never listed twice.
	const published = uniqueByUrl([
		...sameTripleItemsFor(options, exposure),
		...rungItemsFor(options.codeFilesDir, options.publicBaseUrl, targets, exposure),
	]);
	// The rung's newest is the rung's maximum, so a rung below the asker drops
	// whole here; nothing at or below the asker's identity leaves the manifest.
	return [...dev, ...published.map((item) => withReleaseNotes(item, options.changesDir))].filter(
		(item) => outranksAsker(item, running),
	);
}

/** The first item of each archive URL, in order. */
function uniqueByUrl(items: CodeReleaseItem[]): CodeReleaseItem[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		if (seen.has(item.url)) return false;
		seen.add(item.url);
		return true;
	});
}

/**
 * Where the asker stands in the release sequence — the origin of the code
 * ladder AND the floor every item must outrank: its `clientRelease` when
 * that is an identity it may hold, else the bare data triple. The bare triple
 * is the conservative reading — an asker that did not say (an older client) or
 * said something else is treated as running the stable release of its triple,
 * so nothing of that triple is offered to it, and its ladder starts there.
 *
 * AN OLDER CONSUMER (asks with `version` only, no `release`): it predates the
 * release identity (WC-2026-10-15-release-identity-from-tag), so its code IS
 * its data triple and the walk from that triple is its exact ladder. The
 * fallback never offers a downgrade: every item offered sits on a rung above
 * the bare triple or is a newer identity of it.
 *
 * Which identities it may hold: a stable or prerelease identity at or ABOVE the
 * data triple is the asker's own identity (a code-only patch tag over data
 * 7.0.0 is `7.0.1`, release_identity.ts resolveReleaseIdentity — the code runs
 * ahead of the data between data-changing releases). A claim BELOW the data
 * triple is no claim about this asker and falls back to the bare triple. A
 * developer identity is the same: `7.0.0-dev` over data 7.0.1 is a claim
 * below the data triple, so it falls back to the bare `7.0.1` (no 7.0.0 is
 * offered). A developer claim at or above the data triple is honoured.
 * Nothing a claim reaches is offered unless it outranks it
 * ({@link outranksAsker}). An accepted claim also MOVES the ladder (U-06) —
 * that is the point: a `7.0.1` over data 7.0.0 is offered `7.0.2`. A false
 * claim gains nothing a client could not fetch anyway (the archives are
 * public, the ask is authenticated by its code): the swap door re-judges every
 * move with the tree's OWN identity, so an offer the claim alone justified is
 * refused there.
 * A legacy `X.Y.Z.dev` claim reads as `X.Y.Z-dev`: unparsed it falls back to
 * stable `X.Y.Z`, above which its own nightly ranks as a downgrade — so
 * every pre-grammar dev install could never be offered a nightly.
 */
function askerIdentity(options: CodeUpdateInfoOptions): string {
	const dataTriple = normalizedClientTriple(options.clientVersion);
	const raw = typeof options.clientRelease === 'string' ? options.clientRelease : '';
	// builds before d803117865 (2026-10-26) spell a dev identity 'X.Y.Z.dev'
	const claimed = raw.replace(/^(\d+\.\d+\.\d+)\.dev$/, '$1-dev');
	const parsed = parseReleaseVersion(claimed);
	if (parsed === null) return dataTriple.join('.');
	const atOrAboveData = compareVersionArrays(parsed.triple, dataTriple) >= 0;
	return atOrAboveData ? claimed : dataTriple.join('.');
}

/**
 * The last word on every offered item: it must rank ABOVE the asker's identity
 * (compareReleaseIdentities), so no downgrade and no older prerelease is ever
 * listed. The one equal case is a developer build reinstalled over itself on
 * the dev channel (the nightly is rebuilt in place, no version bump) — the same
 * exception the identity walk makes (version_walk.ts sameTripleRefusal).
 */
function outranksAsker(item: CodeReleaseItem, running: string): boolean {
	const identity = item.channel === 'dev' ? `${item.version}-dev` : (item.release ?? item.version);
	const order = compareReleaseIdentities(identity, running);
	if (order > 0) return true;
	return order === 0 && item.channel === 'dev';
}

/**
 * The archives of the asker's OWN identity triple above its identity — how a
 * prerelease install moves on without a version bump (`7.0.0-beta.6` →
 * `7.0.0-beta.7` → `7.0.0`; RELEASE_IDENTITY_DESIGN §2.8 item 3). The stable
 * release of the triple is offered to ANY asker below it (a stable release is
 * no exposure), its prereleases only when the prerelease rung is exposed. An
 * asker at the stable release (or at its bare triple) is offered nothing here.
 *
 * The identity triple is the asker's own triple for a stable or prerelease
 * install (identity = data triple there). For a developer build it is the next
 * triple the build is named after, so a tree whose data is 7.0.0 and whose
 * identity is `7.0.0-dev` sees the stable `7.0.0` through ordinary ordering:
 * `7.0.0-dev < 7.0.0`. Nothing special is granted to a developer identity here:
 * the ORDER decides, and dev sorts above every prerelease of its triple
 * (`7.0.0-beta.7 < 7.0.0-dev`), so a developer build is offered no prerelease of
 * its own triple.
 *
 * An install that reports its bare triple (`7.0.0-beta.6` reports `7.0.0`) is
 * offered no prerelease of that triple here: its way onto a developer build is
 * its dev row ({@link devItemsFor}), and from that build the order above is
 * the whole story (`7.0.0-beta.7` is below `7.0.0-dev` and is not offered).
 */
function sameTripleItemsFor(
	options: CodeUpdateInfoOptions,
	exposure: ChannelExposure,
): CodeReleaseItem[] {
	const running = askerIdentity(options);
	const triple = identityTripleOf(running);
	return archivesOfTriple(options.codeFilesDir as string, triple)
		.filter((name) => name.kind === 'stable' || exposure.prerelease)
		.filter((name) => compareReleaseIdentities(name.identity as string, running) > 0)
		.sort((a, b) => compareReleaseIdentities(a.identity as string, b.identity as string))
		.map((name) => identityItemFor(options.codeFilesDir as string, options.publicBaseUrl, name))
		.filter((item): item is CodeReleaseItem => item !== null);
}

/** The triple an identity names, as the `[major, minor, patch]` the archive dirs are keyed by. */
function identityTripleOf(identity: string): number[] {
	const parsed = parseReleaseVersion(identity);
	return parsed === null ? [] : [...parsed.triple];
}

/**
 * ONE item per upgrade rung: the NEWEST identity of that triple the asker may
 * see — the stable `<v>.zip` when it exists (a release outranks every
 * prerelease of its triple), else, on an exposed prerelease rung, the newest
 * prerelease. A stable asker is therefore never offered a prerelease, even
 * when a prerelease is the newest thing this master holds. The choice is THE
 * walk's own (version_walk.ts newestOfRung — the identity walk's
 * `not_newest_of_rung` clause asks the same function), so what is offered and
 * what the walk calls the rung's target cannot drift.
 */
function rungItemsFor(
	codeFilesDir: string,
	publicBaseUrl: string,
	targets: readonly number[][],
	exposure: ChannelExposure,
): CodeReleaseItem[] {
	const items: CodeReleaseItem[] = [];
	const channel = exposure.prerelease ? 'prerelease' : 'master';
	for (const triple of targets) {
		const archives = archivesOfTriple(codeFilesDir, triple);
		const newest = newestOfRung(
			archives.map((name) => name.identity as string),
			triple,
			channel,
		);
		const name = archives.find((archive) => archive.identity === newest);
		const item = name === undefined ? null : identityItemFor(codeFilesDir, publicBaseUrl, name);
		if (item !== null) items.push(item);
	}
	return items;
}

/**
 * The TAG-BUILT archives (stable + prerelease, never `-dev`) in `triple`'s
 * `<X>/<X.Y>/` dir, by their file names — the shared grammar
 * ({@link releaseArchiveNameOf}), so a stray or foreign file is never listed.
 * An unreadable dir lists nothing (the panel reports it; the manifest stays an
 * answer).
 */
function archivesOfTriple(
	codeFilesDir: string,
	triple: readonly number[],
): (ReleaseArchiveName & { fileName: string })[] {
	const dir = join(codeFilesDir, String(triple[0]), `${triple[0]}.${triple[1]}`);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const wanted = triple.join('.');
	const found: (ReleaseArchiveName & { fileName: string })[] = [];
	for (const fileName of entries) {
		const name = releaseArchiveNameOf(fileName);
		if (name !== null && name.kind !== 'dev' && name.triple === wanted) {
			found.push({ ...name, fileName });
		}
	}
	return found;
}

/** A stable or prerelease archive as an item (null when it vanished / is unconfined). */
function identityItemFor(
	codeFilesDir: string,
	publicBaseUrl: string,
	name: ReleaseArchiveName & { fileName: string },
): CodeReleaseItem | null {
	const triple = name.triple.split('.').map(Number);
	if (name.kind === 'stable') return releaseItemFor(codeFilesDir, publicBaseUrl, triple);
	const item = archiveItemFor(codeFilesDir, publicBaseUrl, triple, name.fileName);
	return item === null
		? null
		: { ...item, channel: 'prerelease', release: name.identity as string };
}

/**
 * A published item with its frozen notes, when the master has them — a
 * prerelease's own (`changes/<X.Y.Z-beta.N>/release.json`, the cut every
 * prerelease gets), never its triple's.
 */
function withReleaseNotes(item: CodeReleaseItem, changesDir: string | undefined): CodeReleaseItem {
	const notes =
		changesDir === undefined ? null : readReleaseNotes(changesDir, item.release ?? item.version);
	return notes === null ? item : { ...item, notes };
}

function isText(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

function isNoteEntry(value: unknown): value is CodeReleaseNoteEntry {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as Record<string, unknown>;
	return isText(entry.type) && isText(entry.audience) && isText(entry.title);
}

function isListOf<T>(value: unknown, item: (entry: unknown) => entry is T): value is T[] {
	return Array.isArray(value) && value.every(item);
}

/** `{action_needed: string[], entries: [{type, audience, title}]}`, or null. */
function notesShape(notes: unknown): Omit<CodeReleaseNotes, 'date'> | null {
	if (typeof notes !== 'object' || notes === null) return null;
	const { action_needed, entries } = notes as Record<string, unknown>;
	if (!isListOf(action_needed, isText) || !isListOf(entries, isNoteEntry)) return null;
	return {
		action_needed: [...action_needed],
		entries: entries.map(({ type, audience, title }) => ({ type, audience, title })),
	};
}

/**
 * The notes `changes/<version>/release.json` froze, with its date — or null
 * (no snapshot, no notes in it, anything malformed). Never throws.
 */
export function readReleaseNotes(changesDir: string, version: string): CodeReleaseNotes | null {
	// THE shared grammar (a stable or prerelease identity): it is joined into a
	// path, and nothing it accepts holds a separator or `..`.
	if (!RELEASE_VERSION_RE.test(version)) return null;
	try {
		const snapshot = JSON.parse(readFileSync(join(changesDir, version, 'release.json'), 'utf8'));
		const notes = notesShape(snapshot?.notes);
		return notes === null || !isText(snapshot.date) ? null : { date: snapshot.date, ...notes };
	} catch {
		return null;
	}
}

/**
 * The public URL of one published archive — the ONE builder.
 *
 * Both the manifest (`releaseItemFor`) and the code-server panel
 * (status.ts `collectReleaseDir`) hand a consumer a release URL, and they drifted:
 * the panel appended the `/dedalo/install/code` prefix to a base that already
 * carried it, emitting a path `resolveCodeReleaseFile` refuses. `base` is
 * always the prefix WITHOUT a trailing slash.
 */
export function codeReleaseUrl(base: string, version: string, fileName: string): string {
	return `${base}/${version}/${fileName}`;
}

/**
 * The developer-channel items, listed BEFORE the published ones: a consumer
 * that flipped its dev switch means it, and the client pre-selects the first
 * row. The asker's OWN identity triple leads the list — a branch build carries
 * no version bump, so "install the same identity again" IS the feature; the
 * next triples follow, so an operator can still reach a branch build of the
 * next release from the same panel.
 *
 * A developer row is listed ONLY when the identity walk admits it for this
 * asker on the dev channel (version_walk.ts identityWalkRefusal, the same
 * function the swap door runs): what the panel offers and what the door will
 * accept are one answer, never two. The candidate triples are the asker's own
 * and the rung above each of them (the walk admits a developer build of the
 * next triple, and nothing further), read from the identity so that the catalog's
 * data triples never gate a developer build.
 */
function devItemsFor(
	codeFilesDir: string,
	publicBaseUrl: string,
	running: string,
): CodeReleaseItem[] {
	const items: CodeReleaseItem[] = [];
	for (const triple of devCandidateTriples(identityTripleOf(running))) {
		const item = releaseItemFor(codeFilesDir, publicBaseUrl, triple, 'dev');
		if (item === null) continue;
		const admitted = identityWalkRefusal(running, `${triple.join('.')}-dev`, 'dev') === null;
		if (admitted) items.push(item);
	}
	return items;
}

/**
 * The triples a developer build can be named after from `identity`: its own,
 * then the next patch, the next minor and the next major (the rungs the walk's
 * data step admits — version_walk.ts nextRungKind). Deduplicated, own first.
 */
function devCandidateTriples(identity: readonly number[]): number[][] {
	const [major = 0, minor = 0, patch = 0] = identity;
	const candidates = [
		[major, minor, patch],
		[major, minor, patch + 1],
		[major, minor + 1, 0],
		[major + 1, 0, 0],
	];
	return [...new Map(candidates.map((triple) => [triple.join('.'), triple])).values()];
}

/** One advertised release item, or null when its archive does not exist on disk. */
function releaseItemFor(
	codeFilesDir: string,
	publicBaseUrl: string,
	triple: readonly number[],
	channel: 'master' | 'dev' = 'master',
): CodeReleaseItem | null {
	const versionString = triple.join('.');
	const fileName = channel === 'dev' ? `${versionString}-dev.zip` : `${versionString}.zip`;
	const item = archiveItemFor(codeFilesDir, publicBaseUrl, triple, fileName);
	if (item === null) return null;
	return channel === 'dev' ? { ...item, channel: 'dev' as const } : item;
}

/** The channel-less facts of one archive file of `triple` (null when absent or unconfined). */
function archiveItemFor(
	codeFilesDir: string,
	publicBaseUrl: string,
	triple: readonly number[],
	fileName: string,
): CodeReleaseItem | null {
	const versionString = triple.join('.');
	const filePath = codeReleasePath(codeFilesDir, triple, fileName);
	if (filePath === null || !existsSync(filePath)) return null;
	const sha256 = readShaSidecar(filePath);
	return {
		version: versionString,
		url: codeReleaseUrl(publicBaseUrl, versionString, fileName),
		date: new Date(statSync(filePath).mtimeMs).toISOString(),
		...(sha256 === null ? {} : { sha256 }),
	};
}

/**
 * The digest from the `<archive>.sha256` sidecar `code_build.ts` writes next to
 * every built release (`<64 hex>  <name>.zip\n`), or null when there is no
 * sidecar / it is not a plain 64-hex digest. Advertising it is what makes the
 * consumer's verification possible at all: `updateCode` REFUSES any release
 * whose request carries no 64-hex digest, so an unsigned archive is simply not
 * installable (WC-024's 2026-08-15 addendum). A master that answers with no
 * `sha256` is therefore advertising a release nobody can install — which is the
 * intended, loud outcome of a build whose sidecar was lost.
 */
function readShaSidecar(archivePath: string): string | null {
	const sidecar = `${archivePath}.sha256`;
	if (!existsSync(sidecar)) return null;
	const digest = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] ?? '';
	return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}

/** What a release archive's FILE NAME says (code_build_plan.ts releaseFileName). */
export interface ReleaseArchiveName {
	/** The data triple ('7.0.1') — the `<X>/<X.Y>/` directory it lives in. */
	triple: string;
	/** `stable` = `<X.Y.Z>.zip`, `prerelease` = `<X.Y.Z-beta.N>.zip`, `dev` = `<X.Y.Z>-dev.zip`. */
	kind: 'stable' | 'prerelease' | 'dev';
	/**
	 * The release identity the archive is named after: `X.Y.Z`, `X.Y.Z-beta.N`,
	 * or `X.Y.Z-dev` for a developer build (the same triple as {@link triple}).
	 */
	identity: string;
}

/**
 * Parse a release archive file name, or null when it is none: the identity
 * part is THE shared grammar (release_identity.ts RELEASE_VERSION_RE —
 * canonical numbers, `alpha|beta|rc` only), the developer suffix the fixed
 * `-dev` token. Every character this accepts is `[0-9a-z.-]`, never a
 * separator — which is what lets the name be joined into a path below.
 */
export function releaseArchiveNameOf(fileName: string): ReleaseArchiveName | null {
	if (!fileName.endsWith('.zip')) return null;
	const stem = fileName.slice(0, -'.zip'.length);
	return stem.endsWith('-dev') ? devArchiveNameOf(stem) : identityArchiveNameOf(stem);
}

/**
 * `<X.Y.Z>-dev` — the developer build's fixed token after a bare triple. Its
 * identity is the same stem: the grammar and the identity it names are one
 * spelling (release_identity.ts DEV_VERSION_RE), so the triple read here is the
 * triple the walk compares.
 */
function devArchiveNameOf(stem: string): ReleaseArchiveName | null {
	// The canonical dev identity only (release_identity.ts DEV_VERSION_RE): no
	// leading zeros, so `07.0.1-dev.zip` is refused (null), never named `07.0.1`.
	const parsed = parseReleaseVersion(stem);
	if (parsed === null || !parsed.dev) return null;
	return { triple: parsed.triple.join('.'), kind: 'dev', identity: stem };
}

/** `<X.Y.Z>` or `<X.Y.Z-(alpha|beta|rc).N>` — a release identity in the shared grammar. */
function identityArchiveNameOf(stem: string): ReleaseArchiveName | null {
	const parsed = RELEASE_VERSION_RE.test(stem) ? parseReleaseVersion(stem) : null;
	if (parsed === null) return null;
	return {
		triple: parsed.triple.join('.'),
		kind: parsed.prerelease === null ? 'stable' : 'prerelease',
		identity: stem,
	};
}

/**
 * Release archive path: <codeFilesDir>/<major>/<major.minor>/<file>. Confined.
 *
 * THREE names resolve: the published `<v>.zip`, the prerelease
 * `<X.Y.Z-(alpha|beta|rc).N>.zip` (RELEASE_IDENTITY_DESIGN §2.8 item 1) and the
 * developer `<v>-dev.zip` (code_build_plan.ts releaseFileName), all servable
 * through code_serving.ts. Which of them a manifest ADVERTISES, and to whom, is
 * code_manifest's channel rule, not this grammar's.
 *
 * A dev build is advertised ONLY when the consumer explicitly asked for the dev
 * channel AND this master opted in (2026-08-24). The property to preserve is
 * NOT "the manifest never says -dev" — it is that a dev build is never offered
 * to a consumer that did not ask for one, and never by a master that did not
 * publish one. Do not collapse those two switches into one.
 */
export function codeReleasePath(
	codeFilesDir: string,
	triple: readonly number[],
	fileName: string,
): string | null {
	if (releaseArchiveNameOf(fileName) === null) return null;
	const dir = join(codeFilesDir, String(triple[0]), `${triple[0]}.${triple[1]}`);
	const resolved = resolve(join(dir, fileName));
	if (!resolved.startsWith(`${resolve(codeFilesDir)}${sep}`)) return null;
	return resolved;
}

/** Which built-release version subdirs exist (server-side build-panel listing). */
export function existingReleaseVersions(codeFilesDir: string | undefined): string[] {
	if (codeFilesDir === undefined || !existsSync(codeFilesDir)) return [];
	const versions: string[] = [];
	for (const majorDir of subdirsOf(codeFilesDir)) {
		for (const minorDir of subdirsOf(majorDir)) {
			versions.push(...zipVersionsIn(minorDir));
		}
	}
	return versions.sort();
}

/** The version strings of the `<v>.zip` files directly inside a dir. */
function zipVersionsIn(dir: string): string[] {
	const versions: string[] = [];
	for (const file of readdirSync(dir)) {
		if (file.endsWith('.zip')) versions.push(file.replace(/\.zip$/, ''));
	}
	return versions;
}

/** Absolute paths of a directory's immediate subdirectories. */
function subdirsOf(dir: string): string[] {
	const dirs: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) dirs.push(full);
	}
	return dirs;
}
