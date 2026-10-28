/**
 * THE MEDIA TREE — one declarative description of the directories a Dédalo
 * install must have under the media root, provisioned idempotently with ONE
 * permission mode, plus a verification pass.
 *
 * WHY THIS EXISTS (audit 2026-08_oh1_beta §5.2). PHP provisioned the whole tree
 * at boot (`core/base/dd_init_test.php`, the media block: root → per-type
 * quality folders → posterframe/subtitles → html_files → export → upload tmp →
 * import). The rewrite ported only the media ROOT (`install/directories.ts`), so
 * every sub-folder was minted ad-hoc by whichever writer ran first — with
 * inconsistent modes (`media/atomic.ts`, `media/av_versions.ts` and
 * `media/file_ops.ts` use 0775; `media/protection.ts` and
 * `ontology/ontology_update.ts` use 0750) — and nothing ever verified the tree.
 *
 * The visible casualty was `media/av/subtitles`: NO writer creates it (PHP made
 * it at boot and `build_subtitles_file` assumes it), so tool_transcription's VTT
 * builder refused on every TS-provisioned install and subtitles could not be
 * produced at all.
 *
 * DESIGN
 *
 *  - `mediaTreeEntries()` is the SINGLE description. Every entry carries the
 *    `reason` it must exist and the `consumer` that reads/writes it, so an
 *    omission can never be silent and a future subsystem never has to invent an
 *    ad-hoc `mkdirSync` again. Ancestors are expanded automatically, so no level
 *    of the tree is left to a `recursive:true` side effect at an umask-decided
 *    mode.
 *  - Everything is derived from the typed config (`config.media.*`, the catalog
 *    readers) and the `concepts/media.ts` accessor — never a hardcoded quality or
 *    folder string, never `process.env`. An install that renames a tier gets its
 *    tier, and an install that renames a FOLDER gets its folder: the three names
 *    PHP kept configurable (`DEDALO_IMAGE_WEB_FOLDER`, `DEDALO_HTML_FILES_FOLDER`,
 *    `DEDALO_TOOL_EXPORT_FOLDER_PATH`) were hardcoded here until 2026-08-09 and
 *    now come from `src/config/catalog/media.ts` like everything else. The two
 *    folder names PHP itself wrote as literals in `dd_init_test` (`import`,
 *    `import/history`) are the only ones left, declared once in
 *    `PHP_LEGACY_FOLDERS` below.
 *  - CREATE is idempotent and uses exactly `MEDIA_DIR_MODE`; the mode is forced
 *    with a `chmod` after the `mkdir` so a process umask cannot make one install
 *    differ from the next.
 *  - VERIFY REPORTS, IT DOES NOT REPAIR SURPRISES. A missing directory is
 *    created (that is provisioning); a path that exists but is a FILE, a dangling
 *    symlink, unwritable, or carries a different mode is REPORTED. Silently
 *    chmod-ing a live archive's media tree can break the web server's own access
 *    to it, so an operator decides.
 *  - VERIFY WRITES NOTHING except on the three nodes PHP itself write-probed.
 *    PHP's `system::check_directory` is `is_dir()` + `mkdir()` — it never probed
 *    writability — and only DEDALO_UPLOAD_TMP_DIR and `<media>/import` got the
 *    extra two-level check (a literal `test` SUBDIRECTORY, which PHP then left
 *    behind forever). Probing every node instead would put a probe file AND a
 *    probe directory into ~50 directories of a live archive on every boot, and a
 *    killed process would leave exactly the residue this module exists to end.
 *    The probe is therefore per-entry and declared (`MediaTreeEntry.probe`).
 *
 * BOOT, NOT INSTALL. `provisionMediaTreeAtBoot()` is the production entry point
 * and `src/server.ts` calls it on every start: PHP ran `dd_init_test` on EVERY
 * REQUEST, so a box that was installed before this module existed — i.e. every
 * existing install — would otherwise never get `av/subtitles` at all. It is
 * idempotent, costs one `stat` per declared directory, and NEVER throws: a broken
 * media root must be loud, not a refusal to boot (S1-15).
 *
 * PARITY NOTE — the tree deliberately declares MORE than PHP's, never less:
 * every type gets a `thumb` tier (THUMB_IS_UNIVERSAL — PHP appended one to pdf
 * only, but this engine builds thumbs for all five models), `av/audio_tr` is the
 * TS-native transcription derivative, and `image/svg` is the vector-annotation
 * envelope (`media/svg_overlay.ts`). The PHP-legacy folders with no TS consumer
 * yet (`image/web`, `html_files`, `export/files`, `import`) are kept so an
 * install's shape stays recognisable to an operator and so nothing has to create
 * them ad-hoc later; each says so in its own `consumer: null` + `reason`.
 *
 * THE BOOT BUDGET (`MEDIA_TREE_BOOT_BUDGET_MS`). The pass is ~50 `stat`s and 3
 * write probes — 2.3 ms on local storage, and PHP ran the equivalent on every
 * REQUEST, so this is already strictly cheaper than the oracle. It is not free on
 * NETWORK storage, which is a real heritage deployment: at 200 ms of NFS latency
 * the same walk is ten seconds of a boot that looks hung. `provisionMediaTree`
 * therefore accepts a wall-clock budget, checked before each entry, and the boot
 * pass always passes one: when it runs out the walk STOPS, records a `timed_out`
 * problem naming the entry it stopped at and how many were unchecked, and the
 * server goes on to serve (S1-15 — a slow media volume is not a reason for the
 * archive not to open; the unreached entries are provisioned on the next start).
 *
 * WHY A BUDGET AND NOT ASYNC I/O. Making the walk `fs/promises` + a `Promise.race`
 * would let the boot continue while a look-up is outstanding, and it is the wrong
 * trade twice over. (1) It buys nothing for the case it appears to solve: a hard
 * network mount whose server is down blocks the syscall inside the kernel, so the
 * timer fires while the WORKER THREAD stays parked forever — ~50 of them would
 * exhaust the fs threadpool and spread the hang to every other file consumer in
 * the process, converting one broken mount into a broken server. The honest fix
 * for an unreachable mount is a mount option, and the config doc says so. (2) The
 * pass has to finish before `writeRuleFiles()` (those files are written INTO the
 * media root) and before the first request, or a request can observe a
 * half-provisioned tree. A bounded synchronous pass keeps that ordering by
 * construction; an unawaited async one silently loses it.
 *
 * Ledger: engineering/wire_contract/WC-2026-08-09-media-tree-boot-provisioning.md
 * and WC-2026-08-09-media-tree-configurable-folders-and-boot-budget.md.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { config } from '../../config/config.ts';
import { readNumber, readOptionalString, readString } from '../../config/readers.ts';
import {
	AUDIO_TR_QUALITY,
	hasPosterframe,
	type MediaModel,
	mediaTypeOf,
	thumbQuality,
} from '../concepts/media.ts';
import { assertTestMediaRoot } from '../media/test_media_root.ts';
import { dirIsWritable } from './dir_probe.ts';

/**
 * THE one permission mode of the whole media tree (PHP `dd_init_test`'s
 * `$create_dir_permissions = 0750`, the mode `create_directory` defaults to).
 *
 * Group-readable so the web server (Apache/nginx, in the Dédalo group) can serve
 * published media; never world-readable, because the media root holds unpublished
 * heritage material. Every media writer in the engine should create its
 * data-dependent bucket directories with THIS constant rather than a literal —
 * the 0775 literals the audit found are what made the tree inconsistent.
 */
export const MEDIA_DIR_MODE = 0o750;

/**
 * How hard this node's writability is proven.
 *
 *  - `none`  — existence only. PHP's `system::check_directory` did exactly this
 *              (`is_dir()` else `mkdir()`), so it is the parity default AND the
 *              only choice that keeps a verification pass free of side effects.
 *  - `write` — a file is created and removed (PHP `dir_is_writable`'s guarantee).
 *  - `deep`  — additionally a SUBDIRECTORY is created and removed. PHP applied
 *              this two-level check to DEDALO_UPLOAD_TMP_DIR and `<media>/import`
 *              only, because those are the two directories the engine itself
 *              mkdirs into at runtime.
 */
export type MediaTreeProbe = 'none' | 'write' | 'deep';

/**
 * Where an entry's `path` is anchored.
 *
 *  - `media`    — relative to the media root; the whole tree, and the only kind
 *                 whose ancestors are expanded (they are ours to create).
 *  - `external` — an ABSOLUTE path on another volume. Exactly one setting can
 *                 produce one (`DEDALO_TOOL_EXPORT_FOLDER_PATH`), and PHP treated
 *                 it the same way: `dd_init_test` checked the export folder in its
 *                 OWN block, separately from the media loop, "because it may be
 *                 configured on a different volume or mount point". Its ancestors
 *                 are NOT expanded — see `provisionMediaTree`.
 */
export type MediaTreeBase = 'media' | 'external';

/** One directory of the media tree. */
export interface MediaTreeEntry {
	/**
	 * `base:'media'` — path RELATIVE to the media root, POSIX separators, no
	 * leading slash; the empty string is the media root itself.
	 * `base:'external'` — the resolved ABSOLUTE path.
	 */
	readonly path: string;
	/** Which root `path` hangs off. */
	readonly base: MediaTreeBase;
	/** Why this directory must exist. Never empty — an unexplained entry is a future deletion. */
	readonly reason: string;
	/**
	 * The module that reads/writes it, or `null` for a PHP-legacy folder that no
	 * TS subsystem consumes yet (kept for install-shape parity — see the header).
	 */
	readonly consumer: string | null;
	/** Writability proof for this node (see MediaTreeProbe). Defaults to 'none'. */
	readonly probe: MediaTreeProbe;
}

/** What is wrong with one declared directory. */
export type MediaTreeProblemKind =
	| 'missing'
	| 'not_a_directory'
	| 'not_writable'
	| 'mode_differs'
	| 'create_failed'
	/** The pass ran out of its wall-clock budget; the rest of the tree is UNCHECKED. */
	| 'timed_out';

export interface MediaTreeProblem {
	/** The entry's media-root-relative path (matches MediaTreeEntry.path). */
	readonly path: string;
	/** Absolute filesystem path, for the operator-facing message. */
	readonly absolute: string;
	readonly kind: MediaTreeProblemKind;
	/**
	 * `error` fails the pass (the tree cannot be used as declared); `warning`
	 * records a deviation an operator must decide about — today only a mode that
	 * differs from MEDIA_DIR_MODE on a directory that is nonetheless writable.
	 */
	readonly severity: 'error' | 'warning';
	readonly detail: string;
}

export interface MediaTreeReport {
	/** The absolute media root the pass ran against. */
	readonly root: string;
	/** Whether directories were created (false = verification pass). */
	readonly created: readonly string[];
	readonly problems: readonly MediaTreeProblem[];
	/** True when no `error`-severity problem was found. */
	readonly result: boolean;
}

/**
 * A single path SEGMENT of the tree (a folder name or a quality tier).
 *
 * The media quality charset (`concepts/media.ts` QUALITY_CHARSET) admits `.`,
 * so a configured tier literally spelled `..` would pass every quality gate and
 * resolve into the media root's PARENT. Folder names come from config too. This
 * refuses loudly rather than narrowing to "skip the odd one" — a provisioner
 * that quietly drops a folder is exactly the failure this module exists to end.
 */
export function assertTreeSegment(segment: string): string {
	if (!/^[A-Za-z0-9_\-.]+$/.test(segment) || segment === '.' || segment === '..') {
		throw new Error(
			`Invalid media tree path segment '${segment}': folder and quality names must match [A-Za-z0-9_-.] and may not be '.' or '..'`,
		);
	}
	return segment;
}

/** Join already-validated segments into a media-root-relative path. */
function treePath(...segments: string[]): string {
	return segments.map(assertTreeSegment).join('/');
}

/** Strip the leading slash the DEDALO_*_FOLDER config values carry ('/av' → 'av'). */
function folderName(configuredFolder: string): string {
	return assertTreeSegment(configuredFolder.replace(/^\/+/, ''));
}

/** Split a configured multi-segment relative subdir (DEDALO_UPLOAD_TMP_SUBDIR). */
function relativeSubdir(configured: string): string {
	const segments = configured.split('/').filter((part) => part !== '');
	if (segments.length === 0) {
		throw new Error('Invalid media tree subdir: empty path');
	}
	return treePath(...segments);
}

/** The five media models, in the order the tree is laid out. */
const TREE_MODELS: readonly MediaModel[] = [
	'component_image',
	'component_av',
	'component_pdf',
	'component_svg',
	'component_3d',
];

/**
 * The only folder names left with no config key of their own — because PHP had
 * none either: `dd_init_test` wrote them as literals, never as constants.
 * Declared ONCE, here, rather than inlined at the use site, so "never a hardcoded
 * folder string" keeps a single, auditable exception with its PHP origin next to
 * it.
 *
 * The three that PHP DID keep configurable (`DEDALO_IMAGE_WEB_FOLDER`,
 * `DEDALO_HTML_FILES_FOLDER`, `DEDALO_TOOL_EXPORT_FOLDER_PATH`) lived here as
 * pinned literals until 2026-08-09. They now have catalog entries and are read
 * through the typed readers below: a migrated install keeps the folder names its
 * files are actually in, and a relocated export volume is expressible again.
 */
const PHP_LEGACY_FOLDERS = Object.freeze({
	/** PHP `DEDALO_MEDIA_PATH.'/import'` — a literal in dd_init_test, never a constant. */
	IMPORT: 'import',
	/** PHP `DEDALO_MEDIA_PATH.'/import/history'` — likewise a literal. */
	IMPORT_HISTORY: 'history',
});

/** The default location of the export bundles, RELATIVE to the media root. */
const DEFAULT_EXPORT_SEGMENTS = ['export', 'files'] as const;

/**
 * The export-bundle directory, the one entry that may sit OUTSIDE the media root.
 *
 * UNSET is not the same as "the default spelled out". The catalog default is
 * documented as `<media directory>/export/files`, but resolving it to a literal
 * absolute path here would anchor it to `config.media.rootPath` — so a pass run
 * against a DIFFERENT root (the installer's `mediaRoot` seam, every test's
 * scratch root) would provision `export/files` back into the configured install's
 * real media tree. Unset therefore stays RELATIVE and follows whatever root the
 * pass is given; only an explicitly configured absolute path is honoured as one.
 *
 * A relative configured value is REFUSED, not resolved against some root of our
 * choosing: `<media>/exports` and `<cwd>/exports` are both plausible readings of
 * `exports`, and guessing between them would put an institution's export bundles
 * somewhere it did not ask for.
 */
function exportEntry(root: string): MediaTreeEntry {
	const configured = (readOptionalString('DEDALO_TOOL_EXPORT_FOLDER_PATH') ?? '').trim();
	const consumer = null;
	if (configured === '') {
		return {
			path: treePath(...DEFAULT_EXPORT_SEGMENTS),
			base: 'media',
			reason:
				'tool_export output bundles, at their default location inside the media root (PHP DEDALO_TOOL_EXPORT_FOLDER_PATH, default <media>/export/files); no TS writer yet — kept so it is never created ad-hoc',
			consumer,
			probe: 'none',
		};
	}
	if (!isAbsolute(configured)) {
		throw new Error(
			`Invalid DEDALO_TOOL_EXPORT_FOLDER_PATH '${configured}': it must be an ABSOLUTE path (leave it unset for the default <media root>/${DEFAULT_EXPORT_SEGMENTS.join('/')})`,
		);
	}
	const absolute = resolve(configured);
	const reason =
		'tool_export output bundles at the configured DEDALO_TOOL_EXPORT_FOLDER_PATH; no TS writer yet — kept so it is never created ad-hoc';
	// Inside the media root it is an ordinary tree entry: its ancestors are
	// declared and created like every other level, at the tree mode.
	if (absolute === root || absolute.startsWith(root + sep)) {
		const relative = absolute === root ? '' : absolute.slice(root.length + 1);
		return {
			path: relative === '' ? '' : treePath(...relative.split(sep)),
			base: 'media',
			reason,
			consumer,
			probe: 'none',
		};
	}
	return {
		path: absolute,
		base: 'external',
		reason: `${reason} — configured OUTSIDE the media root (PHP checked this path in its own dd_init_test block for exactly that reason)`,
		consumer,
		probe: 'none',
	};
}

/**
 * The DECLARED entries, before ancestor expansion. Kept separate so the
 * expansion below is provably total.
 */
function declaredEntries(root: string): MediaTreeEntry[] {
	const entries: MediaTreeEntry[] = [
		{
			path: '',
			base: 'media',
			reason: 'the media root itself (PHP DEDALO_MEDIA_PATH)',
			consumer: 'core/media/path.ts requireMediaRoot',
			// The one node whose writability the installer and the boot pass both
			// care about: everything else in the tree lives under it.
			probe: 'write',
		},
	];

	const thumb = assertTreeSegment(thumbQuality());

	for (const model of TREE_MODELS) {
		const spec = mediaTypeOf(model);
		if (spec === null) {
			// Unreachable through TREE_MODELS, and a narrowing if it ever were.
			throw new Error(`Media tree: no media type spec for '${model}'`);
		}
		const folder = folderName(spec.folder);
		entries.push({
			path: folder,
			base: 'media',
			reason: `${model}'s type folder (PHP DEDALO_${spec.typeFolder.toUpperCase()}_FOLDER)`,
			consumer: 'core/media/path.ts buildMediaLocation',
			probe: 'none',
		});
		for (const quality of spec.qualities) {
			entries.push({
				path: treePath(folder, quality),
				base: 'media',
				reason: `${model} quality tier '${quality}' (PHP DEDALO_*_AR_QUALITY)`,
				consumer: 'core/media/path.ts buildMediaLocation',
				probe: 'none',
			});
		}
		entries.push({
			path: treePath(folder, thumb),
			base: 'media',
			reason: `${model} thumbnail tier — every type builds one (concepts/media.ts THUMB_IS_UNIVERSAL); PHP appended it to pdf only`,
			consumer: 'core/media/processing.ts buildThumbVersion',
			probe: 'none',
		});
		if (hasPosterframe(model)) {
			entries.push({
				path: treePath(folder, 'posterframe'),
				base: 'media',
				reason: `${model} posterframe segment (PHP dd_init_test appends 'posterframe' to the av/3d quality loop)`,
				consumer: 'core/media/path.ts posterframeLocation',
				probe: 'none',
			});
		}
	}

	const avFolder = folderName(config.media.av.folder);
	const imageFolder = folderName(config.media.image.folder);

	// THE AUDIT MAJOR: nothing else creates this, and build_subtitles_file
	// requires it to already exist (PHP dd_init_test appends 'subtitles' to the
	// AV quality loop).
	entries.push({
		path: treePath(avFolder, folderName(config.media.avExtras.subtitlesFolder)),
		base: 'media',
		reason:
			'AV subtitles (VTT) folder — without it tool_transcription cannot write a single subtitle file (PHP DEDALO_SUBTITLES_FOLDER)',
		consumer: 'core/media/path.ts subtitlesPath / tool_transcription build_subtitles_file',
		probe: 'none',
	});
	entries.push({
		path: treePath(avFolder, AUDIO_TR_QUALITY),
		base: 'media',
		reason:
			'off-ladder 16 kHz mono WAV derivative built on demand for transcription (TS-native; no PHP twin)',
		consumer: 'core/media/av_versions.ts / tool_transcription',
		probe: 'none',
	});
	entries.push({
		path: treePath(imageFolder, 'svg'),
		base: 'media',
		reason:
			"component_image's vector-annotation envelope, stored beside the raster tiers (PHP dd_init_test appends 'svg' to the image quality loop)",
		consumer: 'core/media/svg_overlay.ts svgOverlayLocation',
		probe: 'none',
	});
	entries.push({
		path: treePath(imageFolder, folderName(readString('DEDALO_IMAGE_WEB_FOLDER'))),
		base: 'media',
		reason:
			'images inserted into rich text from the editor (DEDALO_IMAGE_WEB_FOLDER, default /web)',
		consumer: 'core/media/ingest/upload.ts publishWebImage',
		probe: 'none',
	});
	entries.push({
		path: treePath(folderName(readString('DEDALO_HTML_FILES_FOLDER'))),
		base: 'media',
		reason:
			'self-contained HTML export artefacts (DEDALO_HTML_FILES_FOLDER, default /html_files); no TS writer yet — kept so it is never created ad-hoc',
		consumer: null,
		probe: 'none',
	});
	entries.push(exportEntry(root));
	entries.push({
		path: relativeSubdir(config.media.upload.tmpSubdir),
		base: 'media',
		reason:
			'upload staging: chunks are assembled here before the file is moved into its media folder (PHP DEDALO_UPLOAD_TMP_DIR)',
		consumer: 'core/media/ingest/add_file.ts stagingDir',
		// PHP's two-level check: dd_init_test created DEDALO_UPLOAD_TMP_DIR.'/test'.
		// The engine mkdirs per-upload subdirectories here at runtime, so an
		// inode-only check would pass on a read-only remount and every upload
		// would then fail one by one instead of once, loudly, at boot.
		probe: 'deep',
	});
	entries.push({
		path: treePath(PHP_LEGACY_FOLDERS.IMPORT),
		base: 'media',
		reason:
			'import landing zone (PHP DEDALO_MEDIA_PATH/import); the TS import tools read from the upload staging — kept so it is never created ad-hoc',
		consumer: null,
		// PHP's other two-level check: dd_init_test created <media>/import/test.
		probe: 'deep',
	});
	entries.push({
		path: treePath(PHP_LEGACY_FOLDERS.IMPORT, PHP_LEGACY_FOLDERS.IMPORT_HISTORY),
		base: 'media',
		reason:
			'completed import logs and source files, for audit and replay (PHP DEDALO_MEDIA_PATH/import/history)',
		consumer: null,
		probe: 'none',
	});

	return entries;
}

/**
 * The FULL tree OF A GIVEN ROOT — ancestors included, parents before children,
 * de-duplicated.
 *
 * The root is a REQUIRED argument, not a default read from config. One entry
 * (the export folder) is only classifiable as inside-the-tree or on-another-
 * volume relative to the root the pass will actually run against, and an ambient
 * default here would silently answer that question about the CONFIGURED install
 * while the caller was pointing at a scratch root.
 *
 * Ancestors are expanded rather than left to `mkdir -p`: an intermediate level
 * created as a side effect would take whatever the process umask allowed, which
 * is precisely the inconsistency this module ends. `external` entries get no
 * ancestor expansion — the directories above a foreign mount point are not ours
 * to invent.
 */
export function mediaTreeEntries(root: string): readonly MediaTreeEntry[] {
	const resolvedRoot = resolve(root);
	const byPath = new Map<string, MediaTreeEntry>();
	const add = (entry: MediaTreeEntry): void => {
		if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
	};
	for (const entry of declaredEntries(resolvedRoot)) {
		if (entry.base === 'media') {
			const segments = entry.path === '' ? [] : entry.path.split('/');
			for (let i = 1; i < segments.length; i++) {
				const ancestor = segments.slice(0, i).join('/');
				add({
					path: ancestor,
					base: 'media',
					reason: `parent directory of '${entry.path}'`,
					consumer: null,
					probe: 'none',
				});
			}
		}
		add(entry);
	}
	// Parents before children: sort by depth, then insertion is already stable
	// within a depth because Map preserves it. An external entry has no declared
	// ancestors, so its depth is irrelevant — it sorts last.
	const depth = (entry: MediaTreeEntry): number => {
		if (entry.base === 'external') return Number.MAX_SAFE_INTEGER;
		return entry.path === '' ? 0 : entry.path.split('/').length;
	};
	const ordered = [...byPath.values()].sort((a, b) => depth(a) - depth(b));
	return Object.freeze(ordered);
}

/** Resolve an entry to an absolute path and prove it stays where it claims to be. */
function absoluteEntryPath(root: string, entry: MediaTreeEntry): string {
	if (entry.base === 'external') return entry.path;
	const absolute = entry.path === '' ? root : resolve(root, entry.path);
	if (absolute !== root && !absolute.startsWith(root + sep)) {
		throw new Error(`Media tree path '${entry.path}' escapes the media root`);
	}
	return absolute;
}

export interface ProvisionMediaTreeOptions {
	/** Media root override (tests, scratch roots). Defaults to `config.media.rootPath`. */
	readonly root?: string;
	/** Create missing directories (default true). False = verification only. */
	readonly create?: boolean;
	/**
	 * Wall-clock budget in MILLISECONDS for the whole pass, checked before each
	 * entry. Undefined (the default) means unbounded, which is what the INSTALLER
	 * wants: the installer step is an interactive operation where waiting is correct
	 * and half a tree is worse than a slow answer. The BOOT pass always passes one
	 * — see `provisionMediaTreeAtBoot` and the header's "THE BOOT BUDGET".
	 */
	readonly budgetMs?: number;
}

/**
 * Provision (and always verify) the media tree.
 *
 * Throws only on a configuration that cannot be provisioned at all — no media
 * root, or a folder/quality name that escapes the root. Every per-directory
 * failure is REPORTED, so one broken folder never hides the rest.
 */
export function provisionMediaTree(options: ProvisionMediaTreeOptions = {}): MediaTreeReport {
	const configured = options.root ?? config.media.rootPath;
	if (configured === null || configured === undefined || configured === '') {
		throw new Error(
			'Cannot provision the media tree: MEDIA_PATH is not configured (config.media.rootPath is null)',
		);
	}
	// A DIRECTORY-CREATING door on the media root: guarded like every other root
	// resolver (inert outside the test seam — core/media/test_media_root.ts).
	const root = assertTestMediaRoot(resolve(configured), 'provisionMediaTree');
	const create = options.create !== false;
	const created: string[] = [];
	const problems: MediaTreeProblem[] = [];

	const entries = mediaTreeEntries(root);
	const { budgetMs } = options;
	const startedAt = Date.now();

	for (const [index, entry] of entries.entries()) {
		// THE BUDGET, checked BEFORE the entry's syscalls: a walk that has already
		// spent its allowance must stop, not do one more look-up that could cost as
		// much again. Bounding the pass this way is what keeps a slow network media
		// volume from turning into a boot that appears to hang (see the header).
		if (budgetMs !== undefined && Date.now() - startedAt >= budgetMs) {
			problems.push({
				path: entry.path,
				absolute: absoluteEntryPath(root, entry),
				kind: 'timed_out',
				severity: 'error',
				detail: `the media tree pass ran out of its ${budgetMs} ms budget here; ${entries.length - index} of ${entries.length} directories were NOT checked or created (they are retried on the next start). A media volume this slow is usually a network mount — raise MEDIA_TREE_BOOT_BUDGET_MS if it is healthy, and check the mount if it is not`,
			});
			break;
		}

		const absolute = absoluteEntryPath(root, entry);

		let stats: ReturnType<typeof statSync> | null = null;
		try {
			stats = statSync(absolute);
		} catch {
			stats = null;
		}

		if (stats === null) {
			// A dangling symlink is NOT "missing" — creating over it would either
			// fail or silently write through to wherever it points once the target
			// reappears. Report the surprise.
			let dangling = false;
			try {
				lstatSync(absolute);
				dangling = true;
			} catch {
				dangling = false;
			}
			if (dangling) {
				problems.push({
					path: entry.path,
					absolute,
					kind: 'not_a_directory',
					severity: 'error',
					detail: `dangling symlink where a directory is required (${entry.reason})`,
				});
				continue;
			}
			if (!create) {
				problems.push({
					path: entry.path,
					absolute,
					kind: 'missing',
					severity: 'error',
					detail: `missing (${entry.reason})`,
				});
				continue;
			}
			// AN EXTERNAL ENTRY IS CREATED, ITS VOLUME IS NOT. Every `media` entry's
			// ancestors are declared, so its parent exists by construction; an
			// absolute path on another volume has no declared ancestors, and creating
			// them would mean minting the mount point of a volume that simply has not
			// come up — which is how an export bundle lands on the system disk and
			// fills it. Report the parent instead; an operator decides.
			if (entry.base === 'external' && !existsSync(dirname(absolute))) {
				problems.push({
					path: entry.path,
					absolute,
					kind: 'missing',
					severity: 'error',
					detail: `missing, and its parent directory '${dirname(absolute)}' does not exist either — Dédalo creates the directory but never the volume above it (${entry.reason})`,
				});
				continue;
			}
			try {
				mkdirSync(absolute, { mode: MEDIA_DIR_MODE });
				// Force the exact mode: mkdir's is masked by the process umask, and
				// "one consistent mode" must not depend on how the server was started.
				chmodSync(absolute, MEDIA_DIR_MODE);
				created.push(entry.path);
			} catch (error) {
				problems.push({
					path: entry.path,
					absolute,
					kind: 'create_failed',
					severity: 'error',
					detail: `could not be created (${entry.reason}): ${(error as Error).message}`,
				});
				continue;
			}
			continue;
		}

		if (!stats.isDirectory()) {
			problems.push({
				path: entry.path,
				absolute,
				kind: 'not_a_directory',
				severity: 'error',
				detail: `exists but is not a directory (${entry.reason})`,
			});
			continue;
		}

		// WRITABILITY, ONLY WHERE THE ENTRY DECLARES IT. PHP checked existence and
		// nothing else for the tree at large, and probed two nodes deeply; probing
		// all ~50 would write a probe file AND a probe directory into a live
		// archive on every boot (and leave residue if the process is killed
		// mid-probe), which is the failure mode this module exists to end.
		if (entry.probe !== 'none') {
			if (!dirIsWritable(absolute, { deep: entry.probe === 'deep' })) {
				problems.push({
					path: entry.path,
					absolute,
					kind: 'not_writable',
					severity: 'error',
					detail: `exists but is not writable by this process (${entry.reason})`,
				});
				continue;
			}
		}

		const mode = stats.mode & 0o777;
		if (mode !== MEDIA_DIR_MODE) {
			problems.push({
				path: entry.path,
				absolute,
				kind: 'mode_differs',
				severity: 'warning',
				detail: `mode ${mode.toString(8).padStart(4, '0')} differs from the tree mode ${MEDIA_DIR_MODE.toString(8).padStart(4, '0')} — NOT repaired automatically (chmod-ing a live media tree can break the web server's access; fix it deliberately)`,
			});
		}
	}

	return Object.freeze({
		root,
		created: Object.freeze(created),
		problems: Object.freeze(problems),
		result: !problems.some((problem) => problem.severity === 'error'),
	});
}

/** Verify the tree WITHOUT creating anything (the reporting half). */
export function verifyMediaTree(root?: string): MediaTreeReport {
	return provisionMediaTree({ root, create: false });
}

/**
 * Operator-facing one-line-per-problem rendering (the boot log; also what an
 * operator tool would print). `severity` may narrow the set — the boot pass
 * prints every ERROR in full and summarises the mode warnings, because N
 * identical warning lines on every start is how a log stops being read.
 */
export function formatMediaTreeProblems(
	report: MediaTreeReport,
	severity?: MediaTreeProblem['severity'],
): string[] {
	return report.problems
		.filter((problem) => severity === undefined || problem.severity === severity)
		.map(
			(problem) =>
				`[media tree] ${problem.severity.toUpperCase()} ${problem.kind}: ${problem.absolute} — ${problem.detail}`,
		);
}

/**
 * ONE LINE summarising a pass, for surfaces that cannot render a list — the
 * terminal installer's step event carries a single-line `msg` (plain and TUI
 * progress print it as one line), so a multi-line string there breaks the
 * progress view. The full detail always stays on `report.problems`.
 */
export function summarizeMediaTreeReport(report: MediaTreeReport): string {
	const errors = report.problems.filter((problem) => problem.severity === 'error');
	const warnings = report.problems.filter((problem) => problem.severity === 'warning');
	const parts: string[] = [`media tree: ${report.created.length} created`];
	if (errors.length > 0) {
		parts.push(`${errors.length} ERROR(s) — first: ${errors[0]?.path} ${errors[0]?.kind}`);
	}
	if (warnings.length > 0) {
		parts.push(`${warnings.length} warning(s) — first: ${warnings[0]?.path} ${warnings[0]?.kind}`);
	}
	if (errors.length === 0 && warnings.length === 0) parts.push('complete and verified');
	return parts.join('; ');
}

/**
 * THE PRODUCTION ENTRY POINT — the per-BOOT provisioning pass, called from
 * `src/server.ts` on every start.
 *
 * WHY BOOT AND NOT THE INSTALLER. PHP ran `dd_init_test` on every request, so an
 * install acquired new tree folders the moment the engine declared them. The
 * rewrite's installer step only ever runs during an INSTALL, and every existing
 * oral-history box is long past it — wiring the tree to the installer alone would
 * leave `av/subtitles` missing on exactly the machines the audit was about.
 *
 * NEVER THROWS and never refuses the boot (S1-15 posture): a media root that
 * cannot be provisioned is an operator problem to shout about, not a reason for
 * the archive to stop serving records. Returns null when there is nothing to
 * report against (no media root configured, or the pass itself failed).
 *
 * QUIET WHEN HEALTHY: one `stat` per declared directory plus three write probes,
 * and no output at all when the tree is complete and consistent.
 *
 * BOUNDED: unlike the installer pass, this one always carries a wall-clock budget
 * (`MEDIA_TREE_BOOT_BUDGET_MS`, 5 s by default), because it sits between the
 * process starting and the socket being bound. See the header for why the answer
 * is a budget on a synchronous walk rather than async I/O with a timer.
 */
export function provisionMediaTreeAtBoot(
	options: ProvisionMediaTreeOptions = {},
): MediaTreeReport | null {
	const configured = options.root ?? config.media.rootPath;
	if (configured === null || configured === undefined || configured === '') {
		console.warn(
			'[media tree] MEDIA_PATH is not configured — the media tree was NOT provisioned. ' +
				'Media writes (uploads, transcoding, subtitles) will refuse until it is set.',
		);
		return null;
	}
	const budgetMs = options.budgetMs ?? readNumber('MEDIA_TREE_BOOT_BUDGET_MS');
	let report: MediaTreeReport;
	try {
		report = provisionMediaTree({
			root: configured,
			create: options.create !== false,
			budgetMs,
		});
	} catch (error) {
		console.error(
			'[media tree] boot provisioning FAILED — the media tree is NOT verified. ' +
				'Media writes may refuse (tool_transcription cannot write a VTT without the ' +
				'AV subtitles folder). Cause:',
			error,
		);
		return null;
	}

	if (report.created.length > 0) {
		console.warn(
			`[media tree] created ${report.created.length} missing director${report.created.length === 1 ? 'y' : 'ies'} under ${report.root} at mode ${MEDIA_DIR_MODE.toString(8).padStart(4, '0')}: ${report.created.join(', ')}`,
		);
	}
	// Errors are per-directory and each one is a distinct operator action, so they
	// print in full. Mode deviations are legacy noise on an old install (one per
	// folder a pre-provisioner writer minted at 0775) — one summary line, because
	// N identical lines every boot is how a log stops being read.
	for (const line of formatMediaTreeProblems(report, 'error')) console.error(line);
	const warnings = report.problems.filter((problem) => problem.severity === 'warning');
	if (warnings.length > 0) {
		console.warn(
			`[media tree] ${warnings.length} director${warnings.length === 1 ? 'y' : 'ies'} under ${report.root} deviate from mode ${MEDIA_DIR_MODE.toString(8).padStart(4, '0')} and were NOT repaired (chmod-ing a live media tree can break the web server's access — fix deliberately). First: ${warnings[0]?.path} (${warnings[0]?.kind}).`,
		);
	}
	return report;
}
