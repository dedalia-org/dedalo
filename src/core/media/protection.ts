/**
 * MEDIA PROTECTION — Rule A (back-office auth) + the generated web-server rules.
 * Native TS port of the PHP oracle `core/media_protection/class.media_protection.php`
 * (frozen tree), which the cutover left behind: PHP minted the auth cookie, wrote the
 * `auth/` markers and generated `media/.htaccess`, and PHP is gone. Closes audit
 * MEDIA-01 / SECURITY_DECISIONS DECISION 1 option (B). Definition of the whole
 * subsystem: engineering/MEDIA_PROTECTION.md.
 *
 * ONE media tree serves two audiences at the same URLs, with no file duplication:
 *
 *  - Rule A (work system): a logged-in user carries the FIXED-NAME cookie
 *    `dedalo_media_auth`, whose per-session value must exist as a zero-byte marker
 *    in <media>/.publication/auth/{value}. Grants unrestricted media access.
 *  - Rule B (publication): an anonymous user may read only files of PUBLISHED records,
 *    and only inside the configured public quality folders. The web server stats
 *    <media>/.publication/pub/{section_tipo}_{section_id}, with the record identity
 *    parsed out of the media FILE NAME. Those markers are written by the diffusion
 *    engine (diffusion/targets/mediastore/media_index.ts) — never here.
 *
 * THE WEB SERVER ENFORCES, NOT THIS PROCESS. Authorization is one stat() per request,
 * performed by Apache/nginx itself, so multi-GB files keep native sendfile/Range and
 * the H.264 / nginx-mp4 `?start=` clipping handlers. No Bun process ever sits in the
 * media-serving path — the gate can never break streaming. This module only MAINTAINS
 * the artifacts the web server reads: the auth markers and the two rule files.
 *
 * FAIL CLOSED, AND AS 404 — never 403: the existence of unpublished media is not
 * disclosed. Every failure path (missing marker, malformed cookie, non-grammar
 * filename) denies. Rule A markers are engine-owned and independent of publication
 * state, so a diffusion failure can never lock editors out.
 *
 * MARKER-STORE OWNERSHIP IS EXCLUSIVE. Under <media>/.publication/:
 *   auth/{cookie_value}   ← THIS module, and only this module
 *   pub/{key}, dbs/…      ← media_index.ts, and only media_index.ts
 */

import { createHash, randomBytes } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config/config.ts';
import { privateDir, readEnv } from '../../config/env.ts';
import { getServerState } from '../resolve/server_state.ts';
import {
	imageEnvelopePcre,
	MEDIA_ACTIVE_DOCUMENT_EXTENSIONS,
	MEDIA_NOSNIFF,
	SVG_ENVELOPE_CSP,
	SVG_QUARANTINE_CSP,
	SVG_QUARANTINE_DISPOSITION,
	SVG_QUARANTINE_EXTENSIONS,
	svgQuarantinePcre,
} from './svg_safety.ts';
import { assertTestMediaRoot } from './test_media_root.ts';

/**
 * The auth cookie NAME is fixed; only its VALUE changes (one per session, since
 * 2026-08-24 — `session_media.ts`). This is what lets the generated rules stay static
 * and lets nginx validate without a config reload — the marker file is named by the
 * value, so the rules never mention a value at all.
 * NEVER reintroduce rotating cookie NAMES (the pre-v7 design; it forced a reload).
 */
export const MEDIA_AUTH_COOKIE = 'dedalo_media_auth';

/**
 * Bump whenever a rule TEMPLATE below changes. It is folded into the config hash, so
 * bumping it is the ONLY thing that makes an existing install regenerate rule files
 * whose inputs are otherwise unchanged. Forget it and installs keep the old rules
 * forever.
 */
/** SEC-088: script extensions never served or executed under the media root. ONE list
 * for the Apache FilesMatch (htaccessHardeningBlock) and nginx (nginxHardeningLocations). */
export const MEDIA_SCRIPT_DENY_PATTERN = 'phps?|phtml|phar|pht|cgi|pl|py|rb|sh|lua|asp|aspx|jsp';

// 4 (F2): the working-file deny reached nginx (both profiles — it was Apache-only, so a
// published record's .tmp/.csv was served by nginx) and became a case-insensitive 404
// rewrite on Apache (was a case-SENSITIVE 403 FilesMatch: `.TMP` on APFS/SMB was served).
// (F3, same unreleased series, no second bump): the Apache script deny is a 404 rewrite
// too (was an unconditional 403 FilesMatch); the FilesMatch is now the no-mod_rewrite fallback.
export const TEMPLATE_VERSION = 4;

/** The effective access mode. 'off' is a GENERATOR-only value — never returned here. */
export type MediaAccessMode = 'private' | 'publication' | false;
/** What the rule generators accept ('off' = write the hardening block, no gate). */
export type RuleMode = 'off' | 'private' | 'publication';

/** A cookie value is a sha512 hex digest. It becomes a literal FILENAME in auth/, so
 * this pattern is the path-traversal guard — nothing else may ever reach the disk. */
const COOKIE_VALUE_REGEX = /^[a-f0-9]{128}$/;

/**
 * Permissions for the auth marker directory. The FILENAMES in it are live media
 * credentials, so other local users must not be able to list it — 0750, never 0755.
 * Named once because two writers create the directory (a login lays one marker, a
 * reconcile lays the live set), and two mode literals are two chances to drift.
 */
const AUTH_MARKER_DIR_MODE = 0o750;

/** Quality folder names an admin may configure. Deliberately strict (these land in a
 * regex alternation inside a web-server config). */
const QUALITY_REGEX = /^[A-Za-z0-9_./-]+$/;

/**
 * The filename→record grammar. LOAD-BEARING, and stated in THREE places that must stay
 * in lockstep: this constant (which both generated rule files interpolate) and
 * `KEY_REGEX` in diffusion/targets/mediastore/media_index.ts. The lockstep is enforced
 * mechanically by test/unit/media_protection_tripwire.test.ts.
 *
 *   ...{component_tipo}_{section_tipo}_{section_id}[_lg-xxx].{ext}
 *
 * The GREEDY prefix (`[^/]*_`) pins the capture groups to the LAST TWO underscore
 * tokens, so a component tipo — which also contains underscores — can never be
 * mistaken for the section tipo. Files that do NOT parse (e.g. images renamed through
 * `properties.image_id` or an external_source) stay login-only BY DESIGN: they simply
 * never match rule B. Do not "fix" them by loosening this — that hands anonymous
 * users every unparseable file in a public quality folder.
 */
export const MEDIA_FILENAME_GRAMMAR =
	'[^/]*_([a-z0-9]+)_([0-9]+)(?:_lg-[a-zA-Z0-9-]{2,12})?\\.[A-Za-z0-9]+$';

/**
 * WORKING-FILE suffixes under the media root — soft-deleted, temp, import and CSV
 * files the hardening denies to EVERYONE, logged in or not, as a case-insensitive 404
 * (htaccessHardeningBlock AND nginxHardeningLocations, so both profiles of both
 * servers). ONE definition: the generated rules interpolate it, and any engine door
 * that hands out a media file without the web server in the byte path (tool_export's
 * media ZIP) refuses the same names.
 */
export const MEDIA_WORKING_FILE_EXTENSIONS = ['deleted', 'temp', 'tmp', 'import', 'csv'] as const;

/**
 * Test seam. Redirects BOTH filesystem homes (the media root and the auth store) at a
 * scratch dir. Guarded to temp paths exactly like `overrideMediaIndexBaseForTests` —
 * a test must never be able to point these writers at a real media tree or at the real
 * <private>/ dir. null restores the configured resolution.
 */
let pathOverridesForTests: { mediaRoot: string; authStorePath: string } | null = null;
export function overrideMediaProtectionPathsForTests(
	overrides: { mediaRoot: string; authStorePath: string } | null,
): void {
	if (overrides !== null) {
		for (const path of [overrides.mediaRoot, overrides.authStorePath]) {
			if (!/\/(tmp|T)\//.test(path) && !path.startsWith('/tmp')) {
				throw new Error('overrideMediaProtectionPathsForTests only accepts temp-dir paths');
			}
		}
	}
	pathOverridesForTests = overrides;
}

/**
 * The media root, or null when unset (feature off — every function no-ops).
 *
 * A ROOT RESOLVER, so the test-media guard sits here too: this module WRITES
 * inside the media tree (the `.publication` marker store, the auth marker dir,
 * the generated web-server rule files), and it reaches the root without going
 * through `path.ts`. Inert outside the test seam (core/media/test_media_root.ts);
 * armed, it refuses an unmarked root — the tmp-only test override included, so a
 * scratch tree is a DECLARED scratch tree.
 */
export function mediaRoot(): string | null {
	const root =
		pathOverridesForTests !== null ? pathOverridesForTests.mediaRoot : config.media.rootPath;
	if (root === null) return null;
	return assertTestMediaRoot(root, 'media_protection.mediaRoot');
}

/** The marker store base. Shared with media_index.ts, which owns pub/ and dbs/. */
export function markerStoreBase(): string | null {
	const root = mediaRoot();
	return root === null ? null : join(root, '.publication');
}

/** The auth marker dir — the ONE directory this module writes inside the media tree. */
export function authMarkerDir(): string | null {
	const base = markerStoreBase();
	return base === null ? null : join(base, 'auth');
}

/**
 * Is the media tree actually THERE? Returns the reason it is not, or null when it is.
 *
 * A MEDIA ROOT THAT CANNOT BE REACHED IS NOT AN UNPROTECTED MEDIA ROOT. The fail-loud
 * posture of this module rests on one premise: if the gate artifacts cannot be written,
 * the web server serves the tree WITHOUT them. That premise holds only while there is a
 * tree to serve. When the root itself is missing — an external volume that is not
 * mounted (`/Volumes/…`), a network share that dropped, a path typed wrong — the web
 * server resolves every media URL to nothing and answers 404. There is no exposure to
 * fail loud about, and refusing to mint a media credential must never become refusing
 * to LOG IN: media availability is not an authorization input for the archive's records.
 *
 * The distinction drawn here is EXISTENCE, never writability. A root that exists but
 * whose `.publication` store cannot be created (read-only mount, wrong owner) IS being
 * served unprotected, so that failure still throws exactly as before.
 *
 * WHICH IS WHY THE ERRNO LIST IS CLOSED AND SHORT. "Any stat failure" would be exactly
 * the conflation this function exists to prevent: `MEDIA_PATH=/srv/media` under a `/srv`
 * this process may not traverse answers EACCES — while the web server's own user
 * traverses it perfectly well and serves every file in the tree. Degrading there hides a
 * world-readable media tree behind a console line. Only ENOENT (nothing at that path),
 * ENOTDIR (a path component is a file) and ESTALE (an NFS handle whose export went away)
 * mean ABSENT; every other errno falls through to the writer, which throws as it always
 * did.
 *
 * (!) NOT A CURE FOR EVERY UNMOUNTED VOLUME. macOS removes `/Volumes/<name>` when the
 * disk goes, so the probe sees ENOENT — the reported case. A Linux mount point is a
 * directory that SURVIVES the unmount, usually root-owned: the probe correctly says
 * "reachable" (the web server serves that empty directory), and a login on such a box
 * still throws on the unwritable root. That is the right answer for the wrong-feeling
 * case: the tree IS being served, it is merely empty.
 */
export function mediaTreeUnreachableReason(): string | null {
	// The RAW root, deliberately not `mediaRoot()`: this is a read-only existence probe,
	// not a write door, and it has to be answerable while the test-media guard is armed
	// (a root that is gone cannot carry the `.dedalo_test_media` marker, so asking the
	// guard first would turn "the disk is unplugged" into a refusal — the very confusion
	// this function exists to separate). Every caller still goes through `mediaRoot()`
	// for the paths it actually writes.
	const root =
		pathOverridesForTests !== null ? pathOverridesForTests.mediaRoot : config.media.rootPath;
	if (root === null) return null; // unset is a different condition, handled by callers
	try {
		if (!statSync(root).isDirectory()) return `${root} exists but is not a directory`;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== undefined && ABSENT_ROOT_ERRNOS.has(code)) {
			return `${root} cannot be reached (${code})`;
		}
		// EACCES, EPERM, ELOOP, EIO… — the path may well be there and served. Say
		// nothing: the caller's write will throw, which is the correct, loud outcome.
		return null;
	}
	return null;
}

/**
 * The errnos that mean THERE IS NOTHING AT THAT PATH — see the closed-list paragraph in
 * `mediaTreeUnreachableReason`. Anything not listed is a root that may exist and be
 * served, and must reach the throwing path.
 */
const ABSENT_ROOT_ERRNOS: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ESTALE']);

/**
 * The RETIRED day-global auth store, kept addressable for exactly one reason: a
 * migrating install has one on disk and it must be got rid of.
 *
 * It held today's and yesterday's install-wide cookie values so a second login the same
 * day recycled them instead of invalidating everyone's cookie — which is also why a
 * stolen cookie could not be revoked by anything a user or an admin could do. Since
 * 2026-08-24 the credential is per SESSION and lives on the session row, so there is no
 * shared value to persist and this file is only ever DELETED (see retireLegacyAuthStore).
 *
 * It lived in <private>/, NOT in the media tree: its contents were valid media
 * credentials, and a fetchable store would have handed any anonymous visitor a working
 * cookie for up to 48 hours, leaving no trace.
 */
export function authStorePath(): string {
	if (pathOverridesForTests !== null) return pathOverridesForTests.authStorePath;
	return join(privateDir, 'media_auth.json');
}

/** The rule files this module generates and the web server reads. */
export interface RuleFileStatus {
	/** Absolute path, or null when the media root is unset. */
	path: string | null;
	exists: boolean;
	/** true when the embedded config-hash matches the current config; null when the
	 * mode is off (there is no expected content to compare against). */
	up_to_date: boolean | null;
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

/**
 * The effective access mode. Precedence:
 *
 *  1. ts_state.json `media_access_mode` — the runtime override the media_control widget
 *     writes (root-only). The TS-native equivalent of PHP's DEDALO_MEDIA_ACCESS_MODE_CUSTOM;
 *     `../private/.env` is append-only, so a UI-settable mode CANNOT live there.
 *     `null`/absent = no override.
 *  2. .env DEDALO_MEDIA_ACCESS_MODE (via the typed catalog).
 *  3. the legacy DEDALO_PROTECT_MEDIA_FILES=true, honored as 'private' (also step 2's job).
 *
 * Nothing set resolves to 'publication' (fail-closed default since 2026-08-24,
 * `readMediaAccessMode`); only an explicit opt-out resolves to false (protection off).
 * getServerState() re-reads the state file per call, so a mode change from the widget
 * takes effect immediately — no restart.
 */
export function resolveMediaAccessMode(): MediaAccessMode {
	return resolveMediaAccessModeDetail().mode;
}

/**
 * Where the effective mode CAME FROM, alongside the mode itself.
 *
 * The source is not cosmetic. Since the default became fail-closed (2026-08-24) there
 * are two very different states that both answer 'publication':
 *
 *  - an operator CONFIGURED it. Then a media root that cannot be written is a
 *    misconfiguration the operator must see, and the engine's own media fallback route
 *    must stand down because the generated web-server rules are authoritative.
 *  - NOBODY configured anything and the safe default applied. Then the same two
 *    situations must degrade instead: a login may not fail because MEDIA_PATH is unset,
 *    and an install with no web server in front of its media (the documented
 *    dev_quickstart flow) must still show its editors their images — otherwise a
 *    security default silently breaks every fresh install, and the first thing every
 *    operator learns is how to turn it off.
 *
 * Collapsing the two is how a fail-closed default turns into a fail-closed PRODUCT.
 */
export function resolveMediaAccessModeDetail(): {
	mode: MediaAccessMode;
	source: 'state' | 'env' | 'legacy' | 'default';
} {
	if (hasStateOverride()) {
		const override = getServerState().media_access_mode;
		const mode = override === 'private' || override === 'publication' ? override : false;
		return { mode, source: 'state' };
	}
	// The catalog already folds DEDALO_MEDIA_ACCESS_MODE + the legacy flag into one value;
	// only the SOURCE has to be recovered from the raw keys here.
	const mode = config.features.mediaAccessMode;
	if (getConfigFileMode() !== null) return { mode, source: 'env' };
	if (getLegacyProtectFlag() !== null) return { mode, source: 'legacy' };
	return { mode, source: 'default' };
}

/**
 * Whether ts_state.json carries a media_access_mode OVERRIDE at all. `false` is a real
 * override ("protection explicitly off") and must be distinguished from absent/null
 * ("no opinion — defer to .env"). The state file is hand-editable, so an empty string is
 * tolerated as "absent" rather than trusted as a mode.
 */
function hasStateOverride(): boolean {
	const override: unknown = getServerState().media_access_mode;
	return override !== null && override !== undefined && override !== '';
}

/** The runtime override as stored (null = none). The widget shows it verbatim, so an
 * operator can tell "no override" from an explicit "off". */
export function getStateOverride(): 'private' | 'publication' | false | null {
	if (!hasStateOverride()) return null;
	const override = getServerState().media_access_mode;
	return override === 'private' || override === 'publication' ? override : false;
}

/** The RAW .env mode key (not the catalog value, which has already folded the legacy
 * flag into 'private' — the widget shows the two layers separately). */
export function getConfigFileMode(): string | null {
	const raw = readEnv('DEDALO_MEDIA_ACCESS_MODE');
	return raw === undefined || raw === '' ? null : raw;
}

/** The deprecated DEDALO_PROTECT_MEDIA_FILES flag, or null when unset. */
export function getLegacyProtectFlag(): boolean | null {
	const raw = readEnv('DEDALO_PROTECT_MEDIA_FILES');
	return raw === undefined || raw === '' ? null : raw === 'true';
}

/** Where the effective mode came from — surfaced by the widget so an operator can see
 * WHY the mode is what it is (a stale ts_state override is otherwise invisible). */
export function resolveModeSource(): string {
	if (hasStateOverride()) {
		return 'ts_state.json (media_access_mode, set from this widget)';
	}
	if (getConfigFileMode() !== null) {
		return '../private/.env (DEDALO_MEDIA_ACCESS_MODE)';
	}
	if (getLegacyProtectFlag() === true) {
		return '../private/.env (legacy DEDALO_PROTECT_MEDIA_FILES)';
	}
	return "default — fail-closed ('publication'): logged-in users see everything, anonymous users only published records in the public quality folders. No mode is configured; set DEDALO_MEDIA_ACCESS_MODE to make the choice explicit.";
}

// ---------------------------------------------------------------------------
// Public qualities (rule B's folder allowlist)
// ---------------------------------------------------------------------------

/**
 * The delivery-grade quality folders anonymous users may read when a record is
 * published. DERIVED FROM THE TYPED CATALOG, not hardcoded: an install that renames a
 * quality (DEDALO_IMAGE_QUALITY_DEFAULT, DEDALO_AV_QUALITY_DEFAULT, …) must get rules
 * that match its own folder names, or rule B silently matches nothing.
 *
 * Master/work folders are intentionally ABSENT — see getPublicQualities()'s hard filter.
 */
export function getDefaultPublicQualities(): string[] {
	const media = config.media;
	const folder = (value: string): string => value.replace(/^\/+|\/+$/g, '');
	return [
		`${folder(media.av.folder)}/${media.av.defaultQuality}`,
		`${folder(media.av.folder)}/posterframe`,
		`${folder(media.av.folder)}/${folder(media.avExtras.subtitlesFolder)}`,
		`${folder(media.image.folder)}/${media.image.defaultQuality}`,
		`${folder(media.image.folder)}/${media.thumb.quality}`,
		`${folder(media.pdf.folder)}/${media.pdf.defaultQuality}`,
		`${folder(media.svg.folder)}/${media.svg.defaultQuality}`,
		`${folder(media.threeD.folder)}/${media.threeD.defaultQuality}`,
	];
}

/**
 * The VALIDATED public quality folders: the DEDALO_MEDIA_PUBLIC_QUALITIES override when
 * set, else the derived defaults — each passed through a hard security filter that no
 * configuration can defeat:
 *
 *  - master/work qualities are REFUSED (the per-type `originalQuality`, the retouched
 *    twin, and the literal names 'original'/'modified'). Masters are the source of
 *    truth and multi-GB; they must never be anonymously reachable, whatever an admin
 *    types. This is STRICTER than PHP, which only refused the two literal names — an
 *    install that renamed its original quality could configure it public.
 *  - a bare top-level media folder (`image`/`av`/…) is REFUSED (MEDIA-05): it is the
 *    ANCESTOR of that type's master dir, and rule B descends from an allowed quality
 *    into any subdir, so a bare folder would expose the sibling `original/` master. A
 *    real public quality is a specific quality UNDER a type folder (≥2 segments).
 *  - path traversal ('..') is refused;
 *  - anything outside [A-Za-z0-9_./-] is refused (these strings are interpolated into a
 *    web-server regex alternation).
 *
 * A refused entry is dropped and logged — never silently accepted, never fatal.
 */
export function getPublicQualities(): string[] {
	return filterPublicQualities(config.media.publicQualities ?? getDefaultPublicQualities());
}

/**
 * Every quality name that identifies a MASTER/work copy on this install — the
 * archival originals and the retouched work copies. Installs rename these
 * tiers, so nothing may hardcode 'original'/'modified'.
 *
 * ONE definition, deliberately: the web-serving filter below uses it to decide
 * what may be exposed, and any other subsystem that reads bytes off the media
 * tree (the RAG image source feeding an embedder) uses the same set to decide
 * what it may open. Two copies would drift, and the drift would be silent until
 * something shipped a master.
 */
export function masterQualities(): ReadonlySet<string> {
	return new Set<string>([
		'original',
		'modified',
		config.media.image.originalQuality,
		config.media.av.originalQuality,
		config.media.pdf.originalQuality,
		config.media.svg.originalQuality,
		config.media.threeD.originalQuality,
		config.media.imageQualityRetouched,
	]);
}

/**
 * masterQualities() LOWERCASED — the set every master check compares against.
 * Case-insensitive on purpose: on APFS/SMB/NTFS `image/ORIGINAL/` IS
 * `image/original/`, so a case-sensitive compare let a configured
 * `image/ORIGINAL` through the filter and serve the masters anonymously.
 * Callers lowercase the probed segment too (both sides, never one).
 */
function masterQualitiesFolded(): ReadonlySet<string> {
	return new Set([...masterQualities()].map((quality) => quality.toLowerCase()));
}

/** Whether a BARE quality tier name is an archival master (any letter case). */
export function isMasterQuality(quality: string): boolean {
	return masterQualitiesFolded().has(quality.replace(/^\/+|\/+$/g, '').toLowerCase());
}

/**
 * The hard filter itself, as a PURE function over an arbitrary list — this is the
 * security-critical half of getPublicQualities(), so it is directly callable (and
 * directly testable) rather than reachable only through the frozen config catalog.
 */
export function filterPublicQualities(configured: readonly string[]): string[] {
	const forbidden = masterQualitiesFolded();

	const qualities: string[] = [];
	for (const raw of configured) {
		const quality = String(raw).replace(/^\/+|\/+$/g, '');
		if (quality === '' || quality.includes('..') || !QUALITY_REGEX.test(quality)) {
			console.error(`[media_protection] refused invalid public media quality: ${String(raw)}`);
			continue;
		}
		const segments = quality.split('/');
		if (segments.some((segment) => forbidden.has(segment.toLowerCase()))) {
			console.error(
				`[media_protection] refused MASTER quality folder in the public list: ${quality}`,
			);
			continue;
		}
		// MEDIA-05: refuse a bare TOP-LEVEL media folder (`image`/`av`/`pdf`/…). It
		// has no forbidden segment of its own, but it is the ANCESTOR of that type's
		// master dir, and rule B's `(?:.+/)?` descends from an allowed quality into
		// ANY subdir — so a public `image` matched `image/original/0/…rsc.tif` and
		// served the multi-GB master anonymously. A real public quality is always a
		// specific quality UNDER a type folder (≥2 segments; every default is), which
		// cannot reach a sibling `original/`. Also closes the empty-default trigger
		// (DEDALO_*_QUALITY_DEFAULT="" → `image/` → bare `image`) by failing CLOSED:
		// no public image quality rather than an exposed master.
		if (segments.length < 2) {
			console.error(
				`[media_protection] refused bare/ancestor public media quality (would expose its master subfolder): ${quality}`,
			);
			continue;
		}
		qualities.push(quality);
	}
	return [...new Set(qualities)];
}

/** Raw rewrite lines appended before the final deny (MEDIA_HTACCESS_ADDONS). The
 * operator owns their syntax; we only place them. */
export function getAddonLines(): string[] {
	return [...config.media.htaccessAddons];
}

// ---------------------------------------------------------------------------
// The rule templates (PURE — no filesystem, freely callable for preview/diff)
// ---------------------------------------------------------------------------

/**
 * Stable hash of EVERYTHING that shapes the generated rules. Embedded as
 * `# config-hash: …` in both files and compared before rewriting, so a login is a no-op
 * unless something actually changed. TEMPLATE_VERSION is folded in so bumping it in code
 * forces every install to regenerate.
 */
export function getConfigHash(mode: RuleMode, qualities: string[], addons: string[]): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				version: TEMPLATE_VERSION,
				mode,
				qualities,
				addons,
				media: mediaRoot(),
				media_dir: config.mediaDir,
			}),
		)
		.digest('hex');
}

/**
 * The map file's own hash. It is shaped by a DIFFERENT input set than the two rule
 * files — no mode, no qualities, no addons; only the template version and the two
 * config values the MEDIA-03 URI patterns interpolate. Judging it by the rule files'
 * hash would rewrite it on every quality change (noise) and, worse, miss a change to
 * the image folder (a stale envelope pattern = blank edit views).
 *
 * EXPORTED for the publication host's host-wide map (`rules.map`, PUBLICATION_HOST_SPEC):
 * the push sends buildNginxMap() with this hash and the panel compares the agent's
 * contribution hash against it — the one function, never re-derived.
 */
export function nginxMapConfigHash(): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				version: TEMPLATE_VERSION,
				media_dir: config.mediaDir,
				image_folder: config.media.image.folder,
				cookie: MEDIA_AUTH_COOKIE,
			}),
		)
		.digest('hex');
}

/**
 * The always-on hardening block. Emitted in EVERY mode, including 'off' — none of it is
 * part of the access gate, and all of it must hold even when protection is disabled.
 *
 *  - SEC-088 script execution: the media root is full of USER-UPLOADED files, and the web
 *    server must never interpret one as code.
 *  - MEDIA-03 response headers (2026-08-24): SVG is the one image format that is also a
 *    DOCUMENT. Blocking script EXTENSIONS does nothing about it — `.svg` is a legitimate,
 *    accepted media extension (component_svg), and served inline from this origin an
 *    uploaded one is stored XSS against a curator's session. The two populations get
 *    opposite treatment and the rule comes from ONE definition, ./svg_safety.ts, shared
 *    with the Bun media route. See DECISION 2's "MEDIA-03 refined close", whose closing
 *    requirement — that this template mirror the two path-scoped rules — is what this is.
 *  - Active-document extensions no media model accepts (html/swf/hta…) are DENIED, not
 *    quarantined: nothing legitimate under the media root has those names.
 *  - The marker store deny: STRICTER THAN PHP, whose 'off' template omitted it. The
 *    filenames under `.publication/auth/` ARE valid media credentials and the ones under
 *    `pub/` enumerate every published record id. Neither is ever something to serve, in
 *    any mode — and "protection is off today" must not mean "the credentials that work
 *    tomorrow were harvestable yesterday". The gated modes deny it again in the rewrite
 *    stage (rule 0); this is the belt to that pair of braces.
 *
 * (!) HEADERS MAY NOT FAIL OPEN. mod_headers is not guaranteed to be loaded, and an
 * install without it would silently serve every uploaded SVG inline with no CSP — the
 * exact hole this closes, invisible because the rule file LOOKS right. So the
 * `<IfModule !mod_headers.c>` branch DENIES the quarantine population outright (the
 * engine-written envelopes, whose bytes come from a fixed template, stay served). An
 * operator loses the ability to download a curator's raw SVG until they enable
 * mod_headers; they never lose the guarantee.
 */
export function htaccessHardeningBlock(): string {
	const quarantine = SVG_QUARANTINE_EXTENSIONS.join('|');
	const activeDocs = MEDIA_ACTIVE_DOCUMENT_EXTENSIONS.join('|');
	const working = MEDIA_WORKING_FILE_EXTENSIONS.join('|');
	const envelope = imageEnvelopePcre();
	return [
		'# SEC-088: block script execution inside the media root.',
		'<FilesMatch "(?i)\\.(phps?|phtml|phar|pht)$">',
		'\tSetHandler none',
		'</FilesMatch>',
		// F3: the script population is DENIED as 404, never 403 (§2) — a rewrite, for the
		// same measured reason as the active-document deny below (authz answers before the
		// per-dir rewrite, so a `Require all denied` here 403s and confirms the upload).
		// `SetHandler none` above stays: denial and non-execution are separate guarantees.
		'# Script uploads are denied as 404 (a 403 would confirm the file exists).',
		'<IfModule mod_rewrite.c>',
		'RewriteEngine On',
		`RewriteRule (?i)\\.(${MEDIA_SCRIPT_DENY_PATTERN})$ - [R=404,L]`,
		'</IfModule>',
		'# FAIL CLOSED without mod_rewrite: refused (403) rather than served.',
		'<IfModule !mod_rewrite.c>',
		`\t<FilesMatch "(?i)\\.(${MEDIA_SCRIPT_DENY_PATTERN})$">`,
		'\t\tRequire all denied',
		'\t</FilesMatch>',
		'</IfModule>',
		// MEDIA-03: active-document extensions no media model accepts are never served.
		//
		// A REWRITE, not `Require all denied`, and the difference was measured rather
		// than reasoned: in a .htaccess mod_rewrite runs in the FIXUP phase, which is
		// AFTER authorization — so a `Require all denied` alongside this answers first
		// and the client gets 403, which CONFIRMS the file exists. This subsystem denies
		// as 404, never 403 (§2), and the nginx side already did. Verified against
		// Apache 2.4.66 and nginx 1.29: both now answer 404 for the same request.
		//
		// Losing the authz belt costs nothing real: every rule in this file below the
		// hardening block is a RewriteRule, so an install without mod_rewrite has no
		// access gate at all — a belt for one extension list would not save it.
		'<IfModule mod_rewrite.c>',
		'RewriteEngine On',
		`RewriteRule (?i)\\.(${activeDocs})$ - [R=404,L]`,
		'</IfModule>',
		'# MEDIA-03: SVG/XML is a DOCUMENT, not just an image. Uploader-supplied vector',
		'# and XML is handed over as a download inside an opaque origin; the',
		'# server-generated image envelope stays inline (the edit view embeds it through',
		'# <object> and needs same-origin contentDocument access) but can run no script.',
		'# The <If> is merged AFTER <FilesMatch>, so the envelope override wins.',
		'<IfModule mod_headers.c>',
		`\tHeader always set X-Content-Type-Options "${MEDIA_NOSNIFF}"`,
		`\t<FilesMatch "(?i)\\.(${quarantine})$">`,
		`\t\tHeader always set Content-Disposition "${SVG_QUARANTINE_DISPOSITION}"`,
		`\t\tHeader always set Content-Security-Policy "${SVG_QUARANTINE_CSP}"`,
		'\t</FilesMatch>',
		`\t<If "%{REQUEST_URI} =~ m#${envelope}#">`,
		'\t\tHeader always unset Content-Disposition',
		`\t\tHeader always set Content-Security-Policy "${SVG_ENVELOPE_CSP}"`,
		'\t</If>',
		'</IfModule>',
		'# (!) FAIL CLOSED: without mod_headers the CSP above cannot be emitted, so the',
		'# uploader-supplied population is refused rather than served inline unprotected.',
		'<IfModule !mod_headers.c>',
		`\t<FilesMatch "(?i)\\.(${quarantine})$">`,
		'\t\tRequire all denied',
		'\t</FilesMatch>',
		`\t<If "%{REQUEST_URI} =~ m#${envelope}#">`,
		'\t\tRequire all granted',
		'\t</If>',
		'</IfModule>',
		'# Protect working files from prying eyes.',
		'# 404 (never 403) and case-insensitive: on an APFS/SMB mount `.TMP` opens `.tmp`.',
		'<IfModule mod_rewrite.c>',
		'RewriteEngine On',
		`RewriteRule (?i)\\.(${working})$ - [R=404,L]`,
		'</IfModule>',
		'# FAIL CLOSED without mod_rewrite: refused (403) rather than served.',
		'<IfModule !mod_rewrite.c>',
		`\t<FilesMatch "(?i)\\.(${working})$">`,
		'\t\tRequire all denied',
		'\t</FilesMatch>',
		'</IfModule>',
		'# The marker store is NEVER served, in any mode: auth/ filenames are live media',
		'# credentials and pub/ filenames enumerate every published record.',
		'<IfModule mod_rewrite.c>',
		'RewriteEngine On',
		'RewriteRule (^|/)\\.publication(/|$) - [R=404,L]',
		'</IfModule>',
		'Options -Indexes -ExecCGI',
		'AddHandler default-handler .php .phtml .phar .pht',
		'',
	].join('\n');
}

/**
 * Rule B as Apache lines: the publication-marker RewriteCond and the RewriteRule it
 * belongs to. Shared by the work profile (buildHtaccess) and the publication-host
 * profile (publication_host_rules.ts), so the pattern the two gates stat can never drift.
 *
 * (!) $1_$2, NOT %1_%2 — the captures of the RewriteRule that FOLLOWS the condition.
 * The two lines must stay adjacent.
 */
export function ruleBApacheLines(root: string, qualities: readonly string[]): string[] {
	const alternation = qualities.map(escapeRegexLiteral).join('|');
	return [
		'',
		'# 2. Rule B: public quality folders, gated by the publication marker the',
		'#    diffusion engine maintains. The file name identifies the record:',
		'#    ...{component_tipo}_{section_tipo}_{section_id}[_lg-xxx].ext',
		`RewriteCond "${root}/.publication/pub/$1_$2" -f`,
		`RewriteRule ^(?:${alternation})/(?:.+/)?${MEDIA_FILENAME_GRAMMAR} - [L]`,
	];
}

/**
 * The Apache gate: the full text of <media>/.htaccess. PURE.
 *
 * Stage order is the whole design:
 *   0. the marker store itself is never served;
 *   1. rule A — a valid auth cookie whose value exists as a marker → allow everything;
 *   2. rule B — (publication mode) a public quality folder AND a pub/ marker for the
 *      record the FILENAME identifies → allow;
 *   3. default deny, as 404.
 *
 * (!) The rewrite substitution is ALWAYS '-' and the query string is never touched, so
 * Range requests and the H.264 `?start=` clipping handler keep working.
 *
 * (!) Rule B's RewriteCond uses `$1_$2` — the captures of the RewriteRule that FOLLOWS
 * it — not `%1`, which would reference rule A's last RewriteCond capture. This was a
 * real, shipped bug. The RewriteRule must stay immediately after its RewriteCond.
 */
export function buildHtaccess(
	mode: RuleMode,
	qualities: string[] = [],
	addons: string[] = [],
): string {
	const root = (mediaRoot() ?? '').replace(/\/+$/, '');
	const hash = getConfigHash(mode, qualities, addons);

	const lines: string[] = [
		'# Dédalo media access control — GENERATED by src/core/media/protection.ts.',
		'# Do not edit: this file is overwritten whenever the configuration changes.',
		`# config-hash: ${hash}`,
		'',
		htaccessHardeningBlock(),
	];

	// 'off': hardening only. Used when an admin disables protection, so the previously
	// generated deny rules do not linger and keep denying.
	if (mode === 'off') {
		return `${lines.join('\n')}`;
	}

	lines.push(
		'<IfModule mod_rewrite.c>',
		'RewriteEngine On',
		'',
		'# 0. The marker store itself is never served.',
		'RewriteRule (^|/)\\.publication(/|$) - [R=404,L]',
		'',
		'# 1. Rule A: logged-in Dédalo users. Fixed cookie name; the per-session value',
		'#    must exist as an auth marker (laid at login, unlinked when the session ends).',
		`RewriteCond %{HTTP_COOKIE} (?:^|;\\s*)${MEDIA_AUTH_COOKIE}=([a-f0-9]{128}) [NC]`,
		`RewriteCond "${root}/.publication/auth/%1" -f`,
		'RewriteRule ^ - [L]',
	);

	if (mode === 'publication' && qualities.length > 0) {
		lines.push(...ruleBApacheLines(root, qualities));
	}

	if (addons.length > 0) {
		lines.push('', '# MEDIA_HTACCESS_ADDONS (from config)', ...addons);
	}

	lines.push(
		'',
		'# 3. Default deny: 404 hides the existence of unpublished media.',
		'RewriteRule ^ - [R=404,L]',
		'</IfModule>',
		'',
	);

	return lines.join('\n');
}

/**
 * The nginx gate: an include-able server{}-context block. PURE.
 *
 * (!) THE TS URL/ROOT SPLIT. PHP hardcoded `/media/` and `$document_root/media/…`.
 * Here the media URL is `/dedalo/<mediaDir>` (config.mediaDir; see
 * resolve/environment.ts DEDALO_MEDIA_URL) and the filesystem root is MEDIA_PATH,
 * which is INDEPENDENT of it. A block copied from the PHP sample would match nothing
 * and enforce nothing while looking perfectly correct — so both are interpolated here.
 *
 * (!) The rule-A location is a PLAIN PREFIX, deliberately. Adding `^~` would make nginx
 * stop before ever consulting the rule-B regex location, and every anonymous
 * public-quality request would 404. Classic pitfall; keep it plain.
 *
 * The `map` that sanitizes the cookie to hex-only belongs in the http{} context, so it
 * cannot live inside this server{} block: it is emitted as a separate file by
 * writeRuleFiles() and must be included in http{}. Without it $dedalo_auth_key is empty
 * and rule A fails closed for everyone.
 */
export function buildNginxConf(mode: RuleMode, qualities: string[] = []): string {
	const root = (mediaRoot() ?? '').replace(/\/+$/, '');
	const url = `/dedalo/${config.mediaDir}`;
	const hash = getConfigHash(mode, qualities, []);

	const lines: string[] = [
		'# Dédalo media access control — GENERATED by src/core/media/protection.ts.',
		'# Do not edit: this file is overwritten whenever the configuration changes.',
		`# config-hash: ${hash}`,
		'#',
		'# WIRING (two includes — nginx requires it, a `map` is http{}-only):',
		'#   http   { include <media>/dedalo_media_protection_map.nginx.conf; }',
		'#   server { include <media>/dedalo_media_protection.nginx.conf;     }',
		'# Omit the map and nginx REFUSES TO START ("unknown $dedalo_auth_key") — loud,',
		'# which is the intent: a half-wired gate must never boot half-open.',
		'#',
		'# (!) RELOAD REQUIRED. Unlike the Apache .htaccess (read per request), nginx reads',
		'# this at reload: after a mode change, run `nginx -t && nginx -s reload` or the OLD',
		"# rules keep serving. A new session's cookie VALUE needs no reload — that is exactly",
		'# why the cookie NAME is fixed and only its value changes.',
		'#',
		'# Operational notes:',
		'#  - Do NOT enable open_file_cache on these locations (or keep open_file_cache_valid',
		'#    <= 2s): it caches stat() results and delays an unpublish taking effect.',
		'#  - On NFS/shared storage the marker stat() honors the attribute cache, so an',
		'#    unpublish can lag a few seconds across web-farm hosts.',
		'#  - Behind a CDN, PURGE the record media paths on unpublish (especially .vtt',
		'#    subtitles): the origin denies immediately, downstream caches do not.',
		'',
		...nginxHardeningLocations(url),
	];

	if (mode === 'off') {
		lines.push(
			'# Protection is OFF: no ACCESS gate is generated. The hardening above and the',
			'# MEDIA-03 response headers below still apply — "off" means no per-record',
			'# authorization, never "serve uploaded documents inline with no CSP". Apache',
			'# gets the same treatment through htaccessHardeningBlock(), which is emitted',
			'# in every mode; nginx needs a location to hang the headers on, so here it is.',
			`location ${url}/ {`,
			...nginxSvgHeaderLines(),
			"\tmp4;   # '?start='/'?end=' clipping",
			'}',
			'',
		);
		return lines.join('\n');
	}

	if (mode === 'publication' && qualities.length > 0) {
		const alternation = qualities.map(escapeRegexLiteral).join('|');
		lines.push(
			'# 2. Rule B: public quality folders. Allowed when the publication marker exists',
			'#    OR the logged-in auth cookie is valid. The file name identifies the record.',
			// The regex MUST be double-quoted. nginx's CONFIG lexer (not its regex engine)
			// treats `{` and `}` as block delimiters, so an unquoted pattern containing the
			// grammar's `{2,12}` repetition quantifier is truncated mid-token and nginx
			// REFUSES TO START ("pcre2_compile() failed: missing closing parenthesis").
			// Verified against nginx 1.31.2 — publication mode was unusable without this.
			`location ~ "^${escapeRegexLiteral(url)}/(?:${alternation})/(?:.+/)?${nginxNamedGrammar()}" {`,
			'\tset $dd_pass 0;',
			`\tif (-f ${root}/.publication/auth/$dedalo_auth_key) { set $dd_pass 1; }`,
			`\tif (-f ${root}/.publication/pub/\${dd_s}_\${dd_i})   { set $dd_pass 1; }`,
			'\tif ($dd_pass = 0) { return 404; }',
			...nginxSvgHeaderLines(),
			"\tmp4;   # ngx_http_mp4_module: '?start='/'?end=' clipping (no-op for non-mp4)",
			'}',
			'',
		);
	}

	lines.push(
		'# 1. Rule A: everything else under the media tree is for logged-in users only.',
		'#    PLAIN PREFIX on purpose — a `^~` here would make nginx stop before ever',
		'#    consulting the rule-B regex location above, and every anonymous request for',
		'#    published media would 404. Classic pitfall; keep it plain.',
		`location ${url}/ {`,
		`\tif (!-f ${root}/.publication/auth/$dedalo_auth_key) { return 404; }`,
		...nginxSvgHeaderLines(),
		"\tmp4;   # '?start='/'?end=' clipping for logged-in users too",
		'}',
		'',
	);

	return lines.join('\n');
}

/**
 * The always-on nginx hardening locations: rule 0 (marker store), SEC-088 (scripts),
 * MEDIA-03 (active documents), working files. ONE builder for BOTH profiles — the work conf
 * (buildNginxConf) and the publication-host include (publication_host_rules.ts) — so an
 * extension added here reaches both; the tripwire pins both outputs to this function.
 * Regex locations match in order, so these must precede every byte-serving location.
 */
export function nginxHardeningLocations(url: string): string[] {
	const escaped = escapeRegexLiteral(url);
	return [
		'# 0. The marker store itself is never served. `^~` beats every regex below.',
		`location ^~ ${url}/.publication/ { deny all; return 404; }`,
		'',
		// SEC-088. Emitted in EVERY mode, including 'off' — this is NOT part of the access
		// gate. The media root is full of user-uploaded files; a server with PHP-FPM wired
		// would otherwise happily execute an uploaded .php. Regex locations match in order,
		// so this must precede rule B.
		'# SEC-088: never serve or execute scripts under the media root (uploaded files!).',
		`location ~* ^${escaped}/.+\\.(${MEDIA_SCRIPT_DENY_PATTERN})$ {`,
		'\tdeny all;',
		'\treturn 404;',
		'}',
		'',
		// The Apache twin of this lives in htaccessHardeningBlock(); the three-surface
		// lockstep gate compares them, so a deny added to one and forgotten in the other
		// is red rather than a quiet asymmetry between two installs of the same version.
		'# MEDIA-03: active-document extensions no media model accepts are never served.',
		`location ~* ^${escaped}/.+\\.(${MEDIA_ACTIVE_DOCUMENT_EXTENSIONS.join('|')})$ {`,
		'\tdeny all;',
		'\treturn 404;',
		'}',
		'',
		// Apache twin: the working-file rewrite in htaccessHardeningBlock(). Without it a
		// published record's grammar-valid `.tmp`/`.csv` passed Rule B and was served.
		'# Working files (soft-deleted, temp, import, CSV) are never served, to anyone.',
		`location ~* ^${escaped}/.+\\.(${MEDIA_WORKING_FILE_EXTENSIONS.join('|')})$ {`,
		'\tdeny all;',
		'\treturn 404;',
		'}',
		'',
	];
}

/**
 * The filename grammar with NAMED captures, for nginx.
 *
 * Named captures are MANDATORY here, not cosmetic: the `if (-f …)` directives inside the
 * location run their own regex, which resets nginx's numeric captures ($1…$9). A rule
 * built on $1/$2 would silently stat `pub/_` for every request and deny everything.
 * Derived from the ONE grammar constant so the two can never drift.
 */
export function nginxNamedGrammar(): string {
	return MEDIA_FILENAME_GRAMMAR.replace('([a-z0-9]+)', '(?<dd_s>[a-z0-9]+)').replace(
		'([0-9]+)',
		'(?<dd_i>[0-9]+)',
	);
}

/**
 * The http{}-context companion. Two jobs, both of which a `map` can do and a `server{}`
 * block cannot:
 *
 *  1. sanitize the auth cookie to hex-only BEFORE it is ever used in a filesystem path;
 *  2. MEDIA-03: classify the request URI into one of the three SVG populations, so the
 *     byte-serving locations can emit the right headers with ONE `add_header` line each
 *     instead of a new regex location — a new location would shadow rule B and take the
 *     publication marker gate with it. An empty map value makes nginx omit the header.
 *
 * (!) NOT STATIC ANY MORE. Until 2026-08-24 this file was written only when ABSENT (it
 * carried no config hash, because the cookie name never changes). Adding variables here
 * while the server block starts referencing them would mean every EXISTING install keeps
 * its old map, and nginx then refuses to reload with `unknown "dd_svg_csp" variable` —
 * the media gate down, on upgrade, everywhere. So it now carries its own `# config-hash:`
 * and is rewritten on drift like the other two artifacts. Bump TEMPLATE_VERSION when its
 * text changes, or installs whose other inputs are unchanged never regenerate it.
 */
export function buildNginxMap(): string {
	const hash = nginxMapConfigHash();
	return [
		'# Dédalo media access control — GENERATED by src/core/media/protection.ts.',
		'# Include this in the http{} context (a map cannot live inside server{}).',
		`# config-hash: ${hash}`,
		'# It sanitizes the auth cookie to hex-only before it is used in a file path,',
		'# and classifies the URI for the MEDIA-03 response headers.',
		`map $cookie_${MEDIA_AUTH_COOKIE} $dedalo_auth_key {`,
		'\t"~^(?<h>[a-f0-9]{128})$"  $h;',
		'\tdefault                   "_invalid_";',
		'}',
		'',
		'# MEDIA-03: the ENVELOPE pattern must come FIRST — nginx map regexes are tested in',
		'# order and an envelope is also an `.svg`. Getting this order wrong sends every',
		'# server-generated envelope down the attachment branch and blanks the edit view.',
		'map $uri $dedalo_svg_disposition {',
		`\t"~${imageEnvelopePcre()}"  "";`,
		`\t"~${svgQuarantinePcre()}"  "${SVG_QUARANTINE_DISPOSITION}";`,
		'\tdefault                    "";',
		'}',
		'',
		'map $uri $dedalo_svg_csp {',
		`\t"~${imageEnvelopePcre()}"  "${SVG_ENVELOPE_CSP}";`,
		`\t"~${svgQuarantinePcre()}"  "${SVG_QUARANTINE_CSP}";`,
		'\tdefault                    "";',
		'}',
		'',
	].join('\n');
}

/**
 * The MEDIA-03 response headers, for one nginx location. Emitted in EVERY byte-serving
 * location and in every mode — `add_header` does NOT inherit into a location that
 * declares any add_header of its own, so there is no server-level shortcut here; each
 * location must carry the full set or it silently serves bare.
 */
export function nginxSvgHeaderLines(): string[] {
	return [
		`\tadd_header X-Content-Type-Options "${MEDIA_NOSNIFF}" always;`,
		'\tadd_header Content-Disposition $dedalo_svg_disposition always;',
		'\tadd_header Content-Security-Policy $dedalo_svg_csp always;',
	];
}

/** Escape a literal for embedding in an Apache/nginx regex (quality folders carry '.'
 * and '/', e.g. 'image/1.5MB' — an unescaped '.' would match any character). */
export function escapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// The generated artifacts on disk
// ---------------------------------------------------------------------------

/** Absolute paths of the three generated files (null when the media root is unset). */
export function ruleFilePaths(): { htaccess: string; nginx: string; nginxMap: string } | null {
	const root = mediaRoot();
	if (root === null) return null;
	return {
		htaccess: join(root, '.htaccess'),
		nginx: join(root, 'dedalo_media_protection.nginx.conf'),
		nginxMap: join(root, 'dedalo_media_protection_map.nginx.conf'),
	};
}

/**
 * Write the rule files when missing or when their embedded config-hash no longer matches
 * the current configuration. Idempotent: on a normal login this compares two hashes and
 * writes nothing.
 *
 * `modeOverride` is REQUIRED by the widget: after changing the mode, the caller cannot
 * re-resolve it, because `config` is a frozen module-level const evaluated once at import
 * (the .env layer is stale for the life of the process). Pass the new mode explicitly.
 * Omitting it resolves the effective mode, and a resolved `false` leaves any existing
 * file alone (login never calls this with protection off).
 *
 * Throws on write failure: a mode is configured but the gate cannot be written is a
 * misconfiguration the operator MUST see (CONVENTIONS §1 — the default is fail-loud).
 */
export function writeRuleFiles(modeOverride?: RuleMode): boolean {
	// THE MODE FIRST, then the tree, then the paths. Order matters twice over: an install
	// that turned protection OFF must not get a boot-time error line about an absent tree
	// whose files it never wanted written (`true` there means "nothing to do"), and the
	// tree has to be judged before `ruleFilePaths()` resolves anything under it.
	let mode: RuleMode;
	if (modeOverride !== undefined) {
		mode = modeOverride;
	} else {
		const resolved = resolveMediaAccessMode();
		if (resolved === false) return true; // protection off: leave existing files alone
		mode = resolved;
	}

	// Nothing to write into — and nothing being served out of it either, so the absent
	// rules gate nothing. Reported as "not written", never as a throw.
	const unreachable = mediaTreeUnreachableReason();
	if (unreachable !== null) {
		console.error(`[media_protection] media rule files not written: ${unreachable}.`);
		return false;
	}

	const paths = ruleFilePaths();
	if (paths === null) return false; // media root unset — feature off

	const qualities = mode === 'publication' ? getPublicQualities() : [];
	const addons = getAddonLines();

	// EACH ARTIFACT CARRIES ITS OWN HASH, because they are not shaped by the same
	// inputs: MEDIA_HTACCESS_ADDONS is Apache syntax and reaches the .htaccess
	// only — buildNginxConf never sees it, and embeds `getConfigHash(mode,
	// qualities, [])` accordingly.
	//
	// Comparing both files against the addons-inclusive hash (which this did until
	// 2026-07-28) means that the moment an install configures ANY addon, the nginx
	// file can never match: it is rewritten on every login, and the media_control
	// widget reports it permanently "out of date" — a false alarm of exactly the
	// kind that teaches operators to ignore the widget.
	const artifacts: Array<{ path: string; text: string; hash: string }> = [
		{
			path: paths.htaccess,
			text: buildHtaccess(mode, qualities, addons),
			hash: getConfigHash(mode, qualities, addons),
		},
		{
			path: paths.nginx,
			text: buildNginxConf(mode, qualities),
			hash: getConfigHash(mode, qualities, []),
		},
		// The map file carries its OWN hash and is rewritten on drift like the others.
		// It used to be written only when absent, on the reasoning that it was static.
		// It is not static any more (MEDIA-03 put two $uri classification maps in it),
		// and "written only when absent" would mean every existing install keeps a map
		// with no $dedalo_svg_csp while the server block references it — nginx then
		// refuses to reload, and the media gate goes down on upgrade.
		{ path: paths.nginxMap, text: buildNginxMap(), hash: nginxMapConfigHash() },
	];

	writeRuleArtifacts(artifacts);

	return true;
}

/**
 * Write each generated artifact unless the one on disk already carries its hash.
 *
 * Split out of writeRuleFiles (2026-09-21) for the complexity ratchet, and it is
 * the right seam anyway: this is the only part of the generator that touches the
 * filesystem, and it holds ONE rule — the idempotency guard below.
 */
function writeRuleArtifacts(
	artifacts: ReadonlyArray<{ path: string; text: string; hash: string }>,
): void {
	for (const artifact of artifacts) {
		// Idempotency guard: compare the EMBEDDED hash comment rather than the whole body,
		// so incidental whitespace drift never forces a rewrite.
		if (existsSync(artifact.path)) {
			const current = readFileSync(artifact.path, 'utf8');
			if (current.includes(`# config-hash: ${artifact.hash}`)) continue;
		}
		writeFileSync(artifact.path, artifact.text);
	}
}

/** Read-only inspection of the generated files against the current config, for the
 * media_control widget. Never writes. */
export function getRulesStatus(): {
	htaccess: RuleFileStatus;
	nginx: RuleFileStatus;
	nginx_map: RuleFileStatus;
} {
	const paths = ruleFilePaths();
	const mode = resolveMediaAccessMode();

	// Same per-artifact rule as writeRuleFiles: the .htaccess is shaped by
	// MEDIA_HTACCESS_ADDONS, the nginx conf is not. Judging both by the
	// addons-inclusive hash reported the nginx file as out of date forever on any
	// install that configured an addon.
	const statusOf = (path: string | null, withAddons: boolean): RuleFileStatus => {
		const exists = path !== null && existsSync(path);
		if (mode === false || path === null) {
			return { path, exists, up_to_date: null };
		}
		const qualities = mode === 'publication' ? getPublicQualities() : [];
		const hash = getConfigHash(mode, qualities, withAddons ? getAddonLines() : []);
		return {
			path,
			exists,
			up_to_date: exists && readFileSync(path, 'utf8').includes(`# config-hash: ${hash}`),
		};
	};

	// The map is judged by its OWN hash — and, unlike the two rule files, its
	// staleness is not cosmetic: the server block references variables that only a
	// current map defines, so an out-of-date map means `nginx -t` FAILS. The widget
	// has to be able to say so.
	const mapStatus = (): RuleFileStatus => {
		const path = paths?.nginxMap ?? null;
		const exists = path !== null && existsSync(path);
		if (path === null) return { path, exists, up_to_date: null };
		return {
			path,
			exists,
			up_to_date:
				exists && readFileSync(path, 'utf8').includes(`# config-hash: ${nginxMapConfigHash()}`),
		};
	};

	return {
		htaccess: statusOf(paths?.htaccess ?? null, true),
		nginx: statusOf(paths?.nginx ?? null, false),
		nginx_map: mapStatus(),
	};
}

// ---------------------------------------------------------------------------
// Rule A: the auth cookie and its markers
// ---------------------------------------------------------------------------

/** A fresh cookie value: 128 lowercase hex chars (sha512 of CSPRNG bytes). */
export function mintAuthCookieValue(): string {
	return createHash('sha512').update(randomBytes(64)).digest('hex');
}

/**
 * Delete the retired day-global auth store, once, on the way past.
 *
 * A migrating install has `<private>/media_auth.json` on disk holding two INSTALL-WIDE
 * cookie values. Their markers are gone the moment the marker set becomes a projection
 * of the sessions table, so the file is dead — but a file full of credentials that is
 * dead and still on disk is exactly the kind of thing that gets restored from a backup
 * or copied to a new host years later. Renamed rather than unlinked (`.migrated`) so an
 * operator debugging an upgrade can still see what was there; best-effort, never fatal.
 */
export function retireLegacyAuthStore(): void {
	const path = authStorePath();
	if (!existsSync(path)) return;
	try {
		renameSync(path, `${path}.migrated`);
		console.warn(
			`[media_protection] the day-global media auth store is retired — the media credential is now per SESSION, so logout and password reset actually revoke it. Moved ${path} to ${path}.migrated; holders of the old cookie are re-issued on their next authenticated request.`,
		);
	} catch (error) {
		console.error(`[media_protection] could not retire the legacy auth store ${path}:`, error);
	}
}

/**
 * Mirror the valid cookie values (the live sessions' keys) as zero-byte marker files: the
 * web server authorizes rule A with `-f auth/{cookie_value}`. Any OTHER file in the dir
 * is removed — that is what expires the credential of a session that has ended.
 *
 * Called by `reconcileAuthMarkers` (login and the hourly session sweeper), so the store
 * self-heals after a redeploy or a wiped media dir without anyone having to notice.
 *
 * The marker files hold no content: THE FILENAME IS THE CREDENTIAL. Values are therefore
 * validated as strict sha512 hex before they can reach the disk (path traversal).
 */
export function syncAuthMarkers(values: string[], reapGraceMs = 0): void {
	// Same as layAuthMarker: an absent tree is not an unprotected tree, and this runs from
	// the hourly session sweeper — which must not start throwing because a disk was
	// unplugged.
	const unreachable = mediaTreeUnreachableReason();
	if (unreachable !== null) {
		console.error(`[media_protection] auth markers not reconciled: ${unreachable}.`);
		return;
	}
	const dir = authMarkerDir();
	if (dir === null) return; // media root unset — feature off

	mkdirSync(dir, { recursive: true, mode: AUTH_MARKER_DIR_MODE });
	const youngerThan = Date.now() - reapGraceMs;

	const keep = layValidMarkers(dir, values);

	// Rotation: drop markers for values that are no longer valid.
	for (const entry of readdirSync(dir)) {
		if (keep.has(entry)) continue;
		dropRotatedMarker(join(dir, entry), youngerThan, reapGraceMs);
	}
}

/**
 * Lay a marker for every VALID value and answer the set that must survive the
 * rotation below.
 *
 * Split out of syncAuthMarkers (2026-09-21) for the complexity ratchet. It is also
 * where the shape check belongs: a value that is not sha512 hex never becomes a
 * filename, and it never enters `keep` either — so a malformed value cannot
 * protect a marker from rotation by being passed in.
 */
function layValidMarkers(dir: string, values: string[]): Set<string> {
	const keep = new Set<string>();
	for (const value of values) {
		if (typeof value !== 'string' || !COOKIE_VALUE_REGEX.test(value)) {
			console.error('[media_protection] refused invalid auth cookie value (expected sha512 hex)');
			continue;
		}
		keep.add(value);
		const marker = join(dir, value);
		// ONE syscall (CodeQL #9503): create-if-absent, never truncate — no window
		// between an existence check and the write.
		writeFileSync(marker, '', { flag: 'a' });
	}
	return keep;
}

/**
 * Unlink ONE rotated-out marker, unless it is a LOGIN IN FLIGHT.
 *
 * `login()` lays this session's marker BEFORE it inserts the session row (protection
 * must fail loud before there is a session to orphan), and between the two it awaits a
 * database round-trip. A reconcile landing in that window sees a marker no live session
 * claims and would unlink it — the user finishes authenticating and every media file
 * 404s until the next login, with nothing in any log to explain it. `reapGraceMs` is
 * that window: a marker younger than it is left alone, and the next pass collects it if
 * it really was an orphan.
 *
 * A REAL revocation never comes through here — it is `dropAuthMarker`, by value, with no
 * age test at all — so the grace can delay collection but can never keep a revoked
 * credential alive.
 */
function dropRotatedMarker(marker: string, youngerThan: number, reapGraceMs: number): void {
	try {
		const stat = statSync(marker);
		if (!stat.isFile()) return;
		if (reapGraceMs > 0 && stat.mtimeMs > youngerThan) return;
		unlinkSync(marker);
	} catch {
		// Raced with another login's rotation — the file is already gone. Benign.
	}
}

/**
 * Bring the marker directory into agreement with the CURRENT set of live sessions.
 *
 * `syncAuthMarkers` already does the work — it lays what it is given and unlinks
 * everything else — so reconciliation is just "give it the live keys". Used when
 * protection is re-enabled from the widget (so editors who already hold a cookie keep
 * media access instead of 404ing until their next login) and to collect orphans: a
 * marker can outlive its row only if the process died between the DELETE and the
 * unlink, or if the session database was replaced underneath it.
 *
 * (!) NOT CALLED AT BOOT, deliberately. The session store is repointable
 * (DEDALO_SESSION_DB_PATH) while the media root is not: the update's smoke boot starts
 * the candidate tree with an EMPTY throwaway session store and the inherited MEDIA_PATH,
 * so a boot-time reconcile would unlink every live editor's marker on the production
 * tree — on every `bun run test:update` and every real update.
 *
 * TWO CALLERS, both holding the real session store: the operator's media_control widget,
 * and the hourly sweeper (`session_media.startExpiredSessionSweeper`, SEC-09) whose first
 * pass is delayed five minutes past boot for the same reason. Both run after a prune.
 *
 * Every reconcile carries `MARKER_REAP_GRACE_MS`, because the hourly one can now land
 * mid-login — see the rotation loop in `syncAuthMarkers` for why a marker younger than
 * the grace is a login in flight rather than an orphan.
 */
export function reconcileAuthMarkers(liveKeys: string[], reapGraceMs = MARKER_REAP_GRACE_MS): void {
	syncAuthMarkers(liveKeys, reapGraceMs);
}

/**
 * How young a marker must be for a reconcile to treat it as a login in flight rather
 * than an orphan. Sixty seconds is generous by three orders of magnitude for the one
 * database round-trip that sits between `layAuthMarker` and the session INSERT, and it
 * costs at most one extra hourly pass before a genuine orphan is collected. A constant,
 * not a config key: `../private/.env` is append-only, and a knob nobody would turn rots.
 */
export const MARKER_REAP_GRACE_MS = 60_000;

/**
 * Lay ONE session's marker without disturbing anyone else's.
 *
 * `syncAuthMarkers` cannot be used for this: it unlinks every marker it was not given,
 * which is correct for a reconcile and catastrophic for a login (it would log every
 * other editor out of the media tree). The value becomes a literal FILENAME, so it is
 * validated against the strict hex grammar first — that check is the path-traversal
 * guard, not a formality.
 */
export function layAuthMarker(value: string): void {
	// The tree is GONE (unmounted volume, dropped share): nothing is served out of it, so
	// no marker can be missing from a gate no request ever reaches. Degrade — a throw here
	// takes down the login door, and this also runs per session on the authenticated hot
	// path (server.ts sessionMediaKeyFor). FIRST, before any path is resolved.
	const unreachable = mediaTreeUnreachableReason();
	if (unreachable !== null) {
		console.error(
			`[media_protection] no media auth marker laid: ${unreachable}. The media tree is not being served, so nothing is exposed; media files 404 until it is back.`,
		);
		return;
	}
	const dir = authMarkerDir();
	if (dir === null) return; // media root unset — feature off
	if (!COOKIE_VALUE_REGEX.test(value)) {
		console.error('[media_protection] refused invalid auth cookie value (expected sha512 hex)');
		return;
	}
	mkdirSync(dir, { recursive: true, mode: AUTH_MARKER_DIR_MODE });
	const marker = join(dir, value);
	// ONE syscall (CodeQL #9413): create-if-absent, never truncate.
	writeFileSync(marker, '', { flag: 'a' });
}

/**
 * Revoke ONE session's media credential. This is the whole point of the per-session
 * design: logout and password reset can now actually take the cookie away, where before
 * the value was install-global and unlinking it would have locked out every other
 * editor — so nothing was unlinked, and a stolen cookie stayed valid for up to ~48h.
 */
export function dropAuthMarker(value: string): void {
	const dir = authMarkerDir();
	if (dir === null) return;
	if (!COOKIE_VALUE_REGEX.test(value)) return; // never build a path from an unvetted value
	try {
		unlinkSync(join(dir, value));
	} catch {
		// Already gone (a concurrent logout, a reconcile). Revocation is idempotent.
	}
}

/**
 * Mint this session's media credential and lay its marker. The login hook.
 *
 * Returns the cookie value the response must set, or null when protection is off or the
 * media root is unset under the fail-closed DEFAULT (a total no-op: no cookie, no
 * marker, no files). Replaces `initMediaAuthCookie`, whose value was one per INSTALL
 * per DAY.
 *
 * Throws on filesystem failure for a CONFIGURED mode (CONVENTIONS §1: fail-loud) — a
 * gate that cannot be written must not degrade into silently unprotected media. It runs
 * BEFORE createSession deliberately, so a throw leaves no orphan session behind.
 *
 * (!) The DEFAULT source degrades instead of throwing. An operator who wrote a mode and
 * no MEDIA_PATH has a misconfiguration and must be stopped; an install that configured
 * nothing and got the safe default has not made a mistake, and a security default that
 * makes login impossible is not a safe default.
 */
export function issueSessionMediaKey(): string | null {
	const { mode, source } = resolveMediaAccessModeDetail();
	if (mode === false) return null;
	// AN ABSENT TREE IS NOT AN UNPROTECTED TREE (mediaTreeUnreachableReason). Return no
	// cookie instead of throwing, because the caller is login() and a media volume that is
	// not mounted must not lock the archive's editors out of their DATA. Loud, so the
	// operator learns the volume is down. Before the `mediaRoot() === null` branch: this
	// is a CONFIGURED root that is merely not there, a different fault from an unset one.
	const treeGone = mediaTreeUnreachableReason();
	if (treeGone !== null) {
		console.error(
			`[media_protection] media protection is '${mode}' but ${treeGone}. No media cookie is issued and no rule files are written: the web server resolves this tree to nothing, so nothing is exposed. LOGIN PROCEEDS — media files 404 until the tree is back.`,
		);
		return null;
	}
	if (mediaRoot() === null) {
		if (source === 'default') {
			console.error(
				`[media_protection] media protection defaults to '${mode}' (fail-closed) but MEDIA_PATH is not configured, so no gate can be written and no media cookie is issued. This process serves no media tree — nothing is exposed. Configure MEDIA_PATH, or set DEDALO_MEDIA_ACCESS_MODE explicitly.`,
			);
			return null;
		}
		throw new Error(
			`[media_protection] DEDALO_MEDIA_ACCESS_MODE is '${mode}' but MEDIA_PATH is not configured — the gate cannot be written and media would be served unprotected.`,
		);
	}

	const value = mintAuthCookieValue();
	layAuthMarker(value);
	// Rule files are refreshed at LOGIN as well as at boot, because a fresh deploy or a
	// wiped media dir must not serve the tree unprotected until someone happens to
	// restart. Config-hash guarded, so this is normally two hash compares.
	writeRuleFiles();
	return value;
}
