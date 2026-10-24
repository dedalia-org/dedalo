/**
 * MEDIA TREE PROVISIONER — the TS-native gate for the ported PHP boot-time
 * media-tree provisioner (`core/base/dd_init_test.php`, the media block).
 *
 * The audit (2026-08_oh1_beta §5.2) found the provisioner unported: only the
 * media ROOT was created, every sub-folder was minted ad-hoc by whichever writer
 * ran first with an inconsistent mode (0775 here, 0750 there), nothing ever
 * verified the tree — and `media/av/subtitles` was therefore NEVER created, so
 * `build_subtitles_file` refused on every TS-provisioned install and VTT
 * subtitles could not be produced at all.
 *
 * This file is that invariant's mechanical gate. Everything runs against a
 * TEMPORARY root under the OS temp dir — never the real media root.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Glob } from 'bun';
import { config } from '../../src/config/config.ts';
import { readNumber } from '../../src/config/readers.ts';
import { dirIsWritable, removeProbe } from '../../src/core/install/dir_probe.ts';
import { checkDirectories } from '../../src/core/install/directories.ts';
import {
	assertTreeSegment,
	MEDIA_DIR_MODE,
	mediaTreeEntries,
	provisionMediaTree,
	provisionMediaTreeAtBoot,
	summarizeMediaTreeReport,
	verifyMediaTree,
} from '../../src/core/install/media_tree.ts';
import { subtitlesPath, subtitlesRelativePath } from '../../src/core/media/path.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { absentScratchPath } from '../helpers/scratch_dir.ts';
import { TEST_MEDIA_MARKER } from '../helpers/test_media_root.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

function scratchRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'dedalo_media_tree_'));
	// mkdtemp always makes 0700; a real media root is created by
	// install/directories.ts at the tree mode. Match it so the scaffolding does
	// not masquerade as a finding.
	chmodSync(root, MEDIA_DIR_MODE);
	// DECLARE it: provisionMediaTree refuses an unmarked root under the test-media
	// seam (src/core/media/test_media_root.ts).
	return markMediaRoot(root);
}

function withScratchRoot(run: (root: string) => void): void {
	const root = scratchRoot();
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * A root used for PATH MATH only — never created, never written to.
 *
 * `mediaTreeEntries` takes its root as an argument (one entry, the export folder,
 * is only classifiable as inside-the-tree or on-another-volume relative to a
 * root), so the descriptor assertions need one. A synthetic path keeps them pure:
 * nothing here touches the filesystem, and nothing can reach the configured root.
 */
// Under a path that cannot exist, not the shared temp dir: synthetic means nobody can plant it.
const DESCRIPTOR_ROOT = join('/', 'nonexistent_dedalo_synthetic', 'media_tree_descriptor_root');

/** Every relative path the descriptor declares (the media root is ''). */
function entryPaths(root: string = DESCRIPTOR_ROOT): string[] {
	return mediaTreeEntries(root).map((entry) => entry.path);
}

/** Every path under `root`, relative and sorted — the residue detector. */
function listTree(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		for (const name of readdirSync(dir).sort()) {
			// The scratch root's own `.dedalo_test_media` declaration is HARNESS, not
			// tree: it is planted by `scratchRoot()` so the media doors will write here
			// at all (src/core/media/test_media_root.ts). Counting it would make every
			// "the tree is exactly this" and "verify left NO residue" assertion read as
			// a finding about scaffolding.
			if (prefix === '' && name === TEST_MEDIA_MARKER) continue;
			const rel = prefix === '' ? name : `${prefix}/${name}`;
			out.push(rel);
			if (statSync(join(dir, name)).isDirectory()) walk(join(dir, name), rel);
		}
	};
	walk(root, '');
	return out.sort();
}

/**
 * `checkDirectories({create:true})` also creates the PRIVATE tree (config dir,
 * sessions). Redirect it, exactly as install_persist_config.test.ts does: a gate
 * writes to scratch surfaces only — the media root is not the only live one.
 */
let privateScratch: string;
beforeEach(() => {
	privateScratch = mkdtempSync(join(tmpdir(), 'dedalo_media_tree_priv_'));
	process.env.DEDALO_INSTALL_PRIVATE_DIR = privateScratch;
});
afterEach(() => {
	delete process.env.DEDALO_INSTALL_PRIVATE_DIR;
	rmSync(privateScratch, { recursive: true, force: true });
});

describe('media tree descriptor', () => {
	test('declares the AV subtitles folder — the audit MAJOR', () => {
		// PHP dd_init_test appends 'subtitles' to the AV quality loop; the port
		// dropped it, which is why tool_transcription could never write a VTT.
		const subtitlesFolder = config.media.avExtras.subtitlesFolder.replace(/^\//, '');
		expect(entryPaths()).toContain(`av/${subtitlesFolder}`);
	});

	test('the declared subtitles folder IS the directory the VTT writer writes into', () => {
		// The blocker was never "a folder is missing" in the abstract: it was that
		// tool_transcription's build_subtitles_file refuses when dirname(vttPath)
		// does not exist. Bind the declaration to the consumer's own path builder,
		// so a rename on either side is red instead of silently reopening the bug.
		const relative = subtitlesRelativePath(
			{ componentTipo: 'test94', sectionTipo: 'test94', sectionId: 1, lang: null },
			'lg-eng',
		);
		const folder = relative.replace(/^\//, '').split('/').slice(0, -1).join('/');
		expect(entryPaths()).toContain(folder);
	});

	test("a provisioned tree makes the VTT writer's target directory exist", () => {
		withScratchRoot((root) => {
			provisionMediaTree({ root, create: true });
			const vtt = subtitlesPath(
				{ componentTipo: 'test94', sectionTipo: 'test94', sectionId: 1, lang: null },
				'lg-eng',
				root,
			);
			// This is the exact existsSync tool_transcription performs before writing.
			expect(existsSync(dirname(vtt))).toBe(true);
		});
	});

	test('declares every quality tier of every media type, plus the shared thumb tier', () => {
		const paths = new Set(entryPaths());
		const thumb = config.media.thumb.quality;
		const types: { folder: string; qualities: readonly string[] }[] = [
			{ folder: 'image', qualities: config.media.image.qualities },
			{ folder: 'av', qualities: config.media.av.qualities },
			{ folder: 'pdf', qualities: config.media.pdf.qualities },
			{ folder: 'svg', qualities: config.media.svg.qualities },
			{ folder: '3d', qualities: config.media.threeD.qualities },
		];
		for (const { folder, qualities } of types) {
			expect(paths).toContain(folder); // the type root itself
			expect(paths).toContain(`${folder}/${thumb}`); // THUMB_IS_UNIVERSAL
			for (const quality of qualities) {
				expect(paths).toContain(`${folder}/${quality}`);
			}
		}
	});

	test('declares the posterframe folders, the svg-overlay folder and the AV transcription tier', () => {
		const paths = new Set(entryPaths());
		expect(paths).toContain('av/posterframe'); // component_av
		expect(paths).toContain('3d/posterframe'); // component_3d (client capture)
		expect(paths).toContain('image/svg'); // svg_overlay.ts annotation envelope
		expect(paths).toContain('av/audio_tr'); // tool_transcription 16 kHz mono wav
	});

	test('declares the non-quality folders PHP dd_init_test provisions', () => {
		const paths = new Set(entryPaths());
		expect(paths).toContain(''); // the media root
		expect(paths).toContain('image/web'); // DEDALO_IMAGE_WEB_FOLDER
		expect(paths).toContain('html_files'); // DEDALO_HTML_FILES_FOLDER
		expect(paths).toContain('export/files'); // DEDALO_TOOL_EXPORT_FOLDER_PATH
		expect(paths).toContain(config.media.upload.tmpSubdir); // DEDALO_UPLOAD_TMP_DIR
		expect(paths).toContain('import');
		expect(paths).toContain('import/history');
	});

	test('every entry carries a reason, is unique, and is confined to the media root', () => {
		const seen = new Set<string>();
		for (const entry of mediaTreeEntries(DESCRIPTOR_ROOT)) {
			expect(entry.reason.length).toBeGreaterThan(0);
			expect(seen.has(entry.path)).toBe(false);
			seen.add(entry.path);
			expect(entry.path.startsWith('/')).toBe(false);
			expect(entry.path.split('/').includes('..')).toBe(false);
		}
	});
});

describe('media tree provisioning', () => {
	test('creates the whole declared tree at a temporary root, with ONE mode', () => {
		withScratchRoot((root) => {
			const report = provisionMediaTree({ root, create: true });
			expect(report.result).toBe(true);
			expect(report.problems).toEqual([]);
			for (const entry of mediaTreeEntries(root)) {
				const abs = entry.path === '' ? root : join(root, entry.path);
				expect(existsSync(abs)).toBe(true);
				expect(statSync(abs).isDirectory()).toBe(true);
				if (entry.path !== '') {
					// ONE consistent permission mode — the audit's 0775-vs-0750 finding.
					expect(statSync(abs).mode & 0o777).toBe(MEDIA_DIR_MODE);
				}
			}
			// Everything but the pre-existing root was created this run.
			expect(report.created.length).toBe(mediaTreeEntries(root).length - 1);
		});
	});

	test('is idempotent — a second run creates nothing and stays green', () => {
		withScratchRoot((root) => {
			provisionMediaTree({ root, create: true });
			const second = provisionMediaTree({ root, create: true });
			expect(second.created).toEqual([]);
			expect(second.result).toBe(true);
			expect(second.problems).toEqual([]);
		});
	});

	test('verify-only reports every missing directory and creates NOTHING', () => {
		withScratchRoot((root) => {
			const report = verifyMediaTree(root);
			expect(report.result).toBe(false);
			const missing = report.problems.filter((p) => p.kind === 'missing');
			// Root exists (mkdtemp made it); everything under it is missing.
			expect(missing.length).toBe(mediaTreeEntries(root).length - 1);
			expect(existsSync(join(root, 'av', 'subtitles'))).toBe(false);
			expect(report.created).toEqual([]);
		});
	});

	test('a FILE where a directory belongs is reported as an error, never overwritten', () => {
		withScratchRoot((root) => {
			mkdirSync(join(root, 'av'), { recursive: true, mode: MEDIA_DIR_MODE });
			writeFileSync(join(root, 'av', 'subtitles'), 'not a directory');
			const report = provisionMediaTree({ root, create: true });
			expect(report.result).toBe(false);
			const problem = report.problems.find((p) => p.path === 'av/subtitles');
			expect(problem?.kind).toBe('not_a_directory');
			expect(problem?.severity).toBe('error');
			// The surprise is REPORTED, not repaired.
			expect(lstatSync(join(root, 'av', 'subtitles')).isFile()).toBe(true);
		});
	});

	test('a pre-existing directory with a different mode is reported, not silently repaired', () => {
		withScratchRoot((root) => {
			// The exact shape the audit found: an ad-hoc 0775 folder from a writer.
			mkdirSync(join(root, 'av', 'posterframe'), { recursive: true });
			chmodSync(join(root, 'av', 'posterframe'), 0o775);
			const report = provisionMediaTree({ root, create: true });
			const problem = report.problems.find((p) => p.path === 'av/posterframe');
			expect(problem?.kind).toBe('mode_differs');
			expect(problem?.severity).toBe('warning');
			// Warnings do not fail the pass: repairing modes on a live archive's
			// media tree can break the web server's access, so an operator decides.
			expect(report.result).toBe(true);
			expect(statSync(join(root, 'av', 'posterframe')).mode & 0o777).toBe(0o775);
		});
	});

	test('refuses a configured folder/quality name that would escape the media root', () => {
		// Folder and quality names come from env config; the media quality charset
		// allows '.', so '..' must be refused LOUDLY rather than resolved into a
		// parent directory. Law: never silently narrow — throw.
		expect(() => assertTreeSegment('..')).toThrow(/media tree/i);
		expect(() => assertTreeSegment('a/b')).toThrow(/media tree/i);
		expect(() => assertTreeSegment('')).toThrow(/media tree/i);
		expect(() => assertTreeSegment('sub titles')).toThrow(/media tree/i);
		expect(assertTreeSegment('1.5MB')).toBe('1.5MB');
		expect(assertTreeSegment('audio_tr')).toBe('audio_tr');
	});

	test('provisioning refuses outright when no media root is configured', () => {
		// Never a silent skip: an unconfigured root means the tree cannot exist.
		expect(() => provisionMediaTree({ root: '', create: false })).toThrow(/MEDIA_PATH/);
	});
});

/**
 * THE FOLDER NAMES PHP KEPT CONFIGURABLE.
 *
 * `DEDALO_IMAGE_WEB_FOLDER`, `DEDALO_HTML_FILES_FOLDER` and
 * `DEDALO_TOOL_EXPORT_FOLDER_PATH` are real settings of a v6 install. The first
 * media-tree pass hardcoded all three, which does two different kinds of damage:
 * an install that renamed a folder gets a SECOND, empty one provisioned beside
 * the one its files are in, and the export path — which PHP allows to be an
 * ABSOLUTE path on another volume, and checks in its own dd_init_test block for
 * exactly that reason — lost the capability outright.
 */
describe('media tree folder names come from the config catalog', () => {
	/** Set env keys for one assertion and put the environment back afterwards. */
	function withEnv(values: Record<string, string | undefined>, run: () => void): void {
		const previous = new Map<string, string | undefined>();
		for (const [key, value] of Object.entries(values)) {
			previous.set(key, process.env[key]);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		try {
			run();
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	test('a renamed image-web / html-files folder is the folder the tree declares', () => {
		withEnv({ DEDALO_IMAGE_WEB_FOLDER: '/web_2', DEDALO_HTML_FILES_FOLDER: 'html_pages' }, () => {
			const paths = new Set(entryPaths());
			// The configured names, and NOT the defaults: provisioning both would
			// leave an empty twin beside the folder the install's files are in.
			expect(paths).toContain('image/web_2');
			expect(paths).toContain('html_pages');
			expect(paths).not.toContain('image/web');
			expect(paths).not.toContain('html_files');
		});
		// ...and the defaults are what an unconfigured install gets.
		expect(new Set(entryPaths())).toContain('image/web');
	});

	test('an export path INSIDE the media root is an ordinary tree entry', () => {
		withScratchRoot((root) => {
			withEnv({ DEDALO_TOOL_EXPORT_FOLDER_PATH: join(root, 'export', 'bundles') }, () => {
				const entry = mediaTreeEntries(root).find((e) => e.path === 'export/bundles');
				expect(entry?.base).toBe('media');
				const report = provisionMediaTree({ root, create: true });
				expect(report.result).toBe(true);
				// Its ancestor is declared and created at the tree mode, exactly like
				// every other level — not left to a `recursive:true` side effect.
				expect(statSync(join(root, 'export')).mode & 0o777).toBe(MEDIA_DIR_MODE);
				expect(statSync(join(root, 'export', 'bundles')).mode & 0o777).toBe(MEDIA_DIR_MODE);
				expect(existsSync(join(root, 'export', 'files'))).toBe(false);
			});
		});
	});

	test('an export path on ANOTHER volume is provisioned there — the capability PHP had', () => {
		withScratchRoot((root) => {
			const volume = mkdtempSync(join(tmpdir(), 'dedalo_export_volume_'));
			const target = join(volume, 'dedalo_bundles');
			try {
				withEnv({ DEDALO_TOOL_EXPORT_FOLDER_PATH: target }, () => {
					const entry = mediaTreeEntries(root).find((e) => e.base === 'external');
					expect(entry?.path).toBe(target);
					const report = provisionMediaTree({ root, create: true });
					expect(report.result).toBe(true);
					expect(statSync(target).isDirectory()).toBe(true);
					expect(statSync(target).mode & 0o777).toBe(MEDIA_DIR_MODE);
					// Nothing named export/* was invented inside the media root: the
					// bundles live where the operator put them, and nowhere else.
					expect(listTree(root).some((p) => p.startsWith('export'))).toBe(false);
				});
			} finally {
				rmSync(volume, { recursive: true, force: true });
			}
		});
	});

	test('an external export path whose PARENT is missing is reported, never invented', () => {
		withScratchRoot((root) => {
			// The volume's mount point: absent, under a random name nobody else can predict.
			const volume = absentScratchPath('absent_volume');
			const absent = join(volume, 'deeper', 'bundles');
			withEnv({ DEDALO_TOOL_EXPORT_FOLDER_PATH: absent }, () => {
				const report = provisionMediaTree({ root, create: true });
				const problem = report.problems.find((p) => p.absolute === absent);
				expect(problem?.kind).toBe('missing');
				expect(problem?.severity).toBe('error');
				expect(problem?.detail).toContain(dirname(absent));
				expect(report.result).toBe(false);
				// Creating the mount point of a volume that has not come up is how an
				// export bundle ends up filling the system disk.
				expect(existsSync(volume)).toBe(false);
				// One broken entry never hides the rest: the media tree is still there.
				expect(existsSync(join(root, 'av', 'subtitles'))).toBe(true);
			});
		});
	});

	test('a RELATIVE export path is REFUSED, never resolved against a guessed root', () => {
		withScratchRoot((root) => {
			withEnv({ DEDALO_TOOL_EXPORT_FOLDER_PATH: 'exports' }, () => {
				// '<media>/exports' and '<cwd>/exports' are both plausible readings;
				// guessing would put an institution's bundles somewhere it never asked
				// for. Law: throw loudly rather than narrow silently.
				expect(() => provisionMediaTree({ root, create: true })).toThrow(
					/DEDALO_TOOL_EXPORT_FOLDER_PATH/,
				);
			});
		});
	});

	test('UNSET follows the root the pass is given, never the configured install', () => {
		// The seam has to be TOTAL. Resolving the documented default
		// (`<media directory>/export/files`) to a literal absolute path would anchor
		// it to config.media.rootPath, so a pass against a scratch root would
		// provision export/files back into the real install's media tree — the exact
		// live-surface leak this workstream is closing.
		withScratchRoot((root) => {
			withEnv({ DEDALO_TOOL_EXPORT_FOLDER_PATH: undefined }, () => {
				expect(mediaTreeEntries(root).some((e) => e.base === 'external')).toBe(false);
				provisionMediaTree({ root, create: true });
				expect(statSync(join(root, 'export', 'files')).isDirectory()).toBe(true);
			});
		});
	});
});

/**
 * THE BOOT BUDGET. The pass is ~50 stats + 3 write probes — 2.3 ms locally, and
 * PHP ran the equivalent on every REQUEST — but it sits between the process
 * starting and the socket being bound, and a heritage install whose media volume
 * is an NFS mount is a real deployment, not a hypothetical: at 200 ms of latency
 * the same walk is ten seconds of a boot that looks hung.
 */
describe('media tree boot budget', () => {
	test('an exhausted budget STOPS the walk, says where, and never refuses the boot', () => {
		withScratchRoot((root) => {
			const report = provisionMediaTree({ root, create: true, budgetMs: 0 });
			const timedOut = report.problems.filter((p) => p.kind === 'timed_out');
			expect(timedOut.length).toBe(1);
			expect(timedOut[0]?.severity).toBe('error');
			// It names the budget and how much of the tree went unchecked — an
			// operator has to be able to tell "slow mount" from "broken mount".
			expect(timedOut[0]?.detail).toContain('MEDIA_TREE_BOOT_BUDGET_MS');
			expect(timedOut[0]?.detail).toContain('0 ms budget');
			expect(report.result).toBe(false);
			// Stopped, not half-repaired: nothing was created past the deadline.
			expect(report.created).toEqual([]);
			expect(listTree(root)).toEqual([]);
		});
	});

	test('the unreached directories are simply retried on the next start', () => {
		withScratchRoot((root) => {
			provisionMediaTree({ root, create: true, budgetMs: 0 });
			const second = provisionMediaTree({ root, create: true });
			expect(second.result).toBe(true);
			expect(existsSync(join(root, 'av', 'subtitles'))).toBe(true);
		});
	});

	test('the boot pass is bounded and stays LOUD, never a throw', () => {
		withScratchRoot((root) => {
			let report: ReturnType<typeof provisionMediaTreeAtBoot> | undefined;
			expect(() => {
				report = provisionMediaTreeAtBoot({ root, budgetMs: 0 });
			}).not.toThrow();
			expect(report?.problems.some((p) => p.kind === 'timed_out')).toBe(true);
			expect(report?.result).toBe(false);
		});
	});

	test('the boot pass takes its default budget from the catalog key', () => {
		const source = readFileSync(join(REPO_ROOT, 'src', 'core', 'install', 'media_tree.ts'), 'utf8');
		const boot = source.slice(source.indexOf('export function provisionMediaTreeAtBoot'));
		expect(boot).toContain("readNumber('MEDIA_TREE_BOOT_BUDGET_MS')");
	});

	test('the budget can never be set below one plausible look-up', () => {
		// The catalog clamps it: a budget too small to complete a single directory
		// look-up would turn every start-up into the same error, which is a way of
		// disabling the pass by accident.
		const previous = process.env.MEDIA_TREE_BOOT_BUDGET_MS;
		try {
			process.env.MEDIA_TREE_BOOT_BUDGET_MS = '1';
			expect(readNumber('MEDIA_TREE_BOOT_BUDGET_MS')).toBe(100);
			delete process.env.MEDIA_TREE_BOOT_BUDGET_MS;
			expect(readNumber('MEDIA_TREE_BOOT_BUDGET_MS')).toBe(5000);
		} finally {
			if (previous === undefined) delete process.env.MEDIA_TREE_BOOT_BUDGET_MS;
			else process.env.MEDIA_TREE_BOOT_BUDGET_MS = previous;
		}
	});

	test('the INSTALLER pass is deliberately unbounded', () => {
		// The wizard step is an interactive operation: waiting is correct there, and
		// half a tree behind a "Directories OK" panel is worse than a slow answer.
		withScratchRoot((root) => {
			const report = checkDirectories({ create: true, mediaRoot: root });
			expect(report.mediaTree?.problems.some((p) => p.kind === 'timed_out')).toBe(false);
			expect(report.mediaTree?.created.length).toBe(mediaTreeEntries(root).length - 1);
		});
	});
});

describe('media tree write probes (PHP parity: verify is side-effect free)', () => {
	test('declares a probe on EXACTLY the three nodes PHP probed, and none other', () => {
		// PHP `system::check_directory` is is_dir() + mkdir(): it never probed
		// writability. Only DEDALO_UPLOAD_TMP_DIR and <media>/import got the
		// two-level check (a literal `test` SUBDIRECTORY, which PHP then left behind
		// forever). Probing all ~50 nodes would drop a probe file AND a probe
		// directory into a live archive on every boot.
		const byPath = new Map(
			mediaTreeEntries(DESCRIPTOR_ROOT).map((entry) => [entry.path, entry.probe]),
		);
		expect(byPath.get('')).toBe('write'); // the media root, the one node everything hangs off
		expect(byPath.get(config.media.upload.tmpSubdir)).toBe('deep');
		expect(byPath.get('import')).toBe('deep');
		const probed = mediaTreeEntries(DESCRIPTOR_ROOT)
			.filter((entry) => entry.probe !== 'none')
			.map((entry) => entry.path)
			.sort();
		expect(probed).toEqual(['', 'import', config.media.upload.tmpSubdir].sort());
	});

	test('an unwritable NON-probed directory is not flagged; an unwritable PROBED one is', () => {
		withScratchRoot((root) => {
			provisionMediaTree({ root, create: true });
			const subtitles = join(root, 'av', 'subtitles');
			const importDir = join(root, 'import');
			try {
				// Existence is the whole check for a plain tier (PHP parity).
				chmodSync(subtitles, 0o500);
				const quiet = verifyMediaTree(root);
				expect(
					quiet.problems.some((p) => p.path === 'av/subtitles' && p.kind === 'not_writable'),
				).toBe(false);
				chmodSync(subtitles, MEDIA_DIR_MODE);

				// The import landing zone IS probed: the engine mkdirs into it at
				// runtime, so a read-only remount must be one loud boot error, not a
				// thousand quiet per-import failures.
				chmodSync(importDir, 0o500);
				const loud = verifyMediaTree(root);
				expect(loud.problems.some((p) => p.path === 'import' && p.kind === 'not_writable')).toBe(
					true,
				);
				expect(loud.result).toBe(false);
			} finally {
				chmodSync(subtitles, MEDIA_DIR_MODE);
				chmodSync(importDir, MEDIA_DIR_MODE);
			}
		});
	});

	test('a verification pass leaves NO residue anywhere in the tree', () => {
		// PHP's probe left `media/import/test` on every v6 install forever. Ours
		// must leave nothing, and a killed process must have as little to leave
		// behind as possible — hence three probed nodes, not fifty.
		withScratchRoot((root) => {
			provisionMediaTree({ root, create: true });
			const before = listTree(root);
			verifyMediaTree(root);
			verifyMediaTree(root);
			expect(listTree(root)).toEqual(before);
			expect(before.some((p) => p.includes('.dedalo_'))).toBe(false);
		});
	});
});

/**
 * THE PROBE'S NON-THROWING CONTRACT.
 *
 * `dirIsWritable` documents itself as non-throwing — "the caller reports the
 * failure, it is never an exception path" — and every caller depends on that:
 * `checkDirectories` turns a false into an operator-facing row, and
 * `provisionMediaTree` turns it into ONE problem among fifty so a single bad
 * directory never hides the rest. An exception instead aborts the whole pass.
 *
 * The documentation was NOT true: the probe removal sat in a bare `finally`, and
 * `rmSync(force:true)` swallows ENOENT and nothing else. An EACCES/EPERM/EROFS
 * unlink — a read-only remount between the write and the unlink, an NFS server
 * that revoked the delegation, a directory whose write bit was taken away
 * mid-probe — escaped the `finally` and REPLACED the return value with a throw.
 */
describe('dirIsWritable — the documented non-throwing contract', () => {
	const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

	test('a removal that FAILS never escapes — the probe reports, it never raises', () => {
		// A directory we may not unlink from: mode 0500 leaves the entry readable
		// and traversable while denying the unlink (EACCES for a non-root owner).
		// This is the exact syscall shape a read-only remount produces.
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_probe_rm_'));
		const stuck = join(dir, 'probe_file');
		const stuckDir = join(dir, 'probe_dir');
		try {
			writeFileSync(stuck, '');
			mkdirSync(stuckDir);
			chmodSync(dir, 0o500);
			expect(() => removeProbe(stuck)).not.toThrow();
			expect(() => removeProbe(stuckDir, { recursive: true })).not.toThrow();
			// The residue is NOT silently accepted: it is exactly what this module
			// exists to avoid, so the caller is told the path to delete by hand.
			if (!isRoot) expect(existsSync(stuck)).toBe(true);
		} finally {
			chmodSync(dir, 0o700);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('every removal in dir_probe.ts goes through removeProbe', () => {
		// The invariant is "the probe never raises", not "one rmSync was wrapped".
		// A second, bare removal added later would re-open exactly the same hole, so
		// the gate is on the module's removals as a SET: `removeProbe` is the only
		// place `rmSync` may be called.
		const source = readFileSync(join(REPO_ROOT, 'src', 'core', 'install', 'dir_probe.ts'), 'utf8');
		const removeProbeBody = source.slice(source.indexOf('export function removeProbe'));
		const callsEverywhere = [...source.matchAll(/\brmSync\s*\(/g)].length;
		const callsInsideRemoveProbe = [...removeProbeBody.matchAll(/\brmSync\s*\(/g)].length;
		expect(callsEverywhere).toBeGreaterThan(0);
		expect(callsEverywhere).toBe(callsInsideRemoveProbe);
		// ...and that one call is guarded.
		expect(removeProbeBody).toContain('catch');
	});

	test('the probe still answers truthfully and leaves nothing behind', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_probe_ok_'));
		try {
			expect(dirIsWritable(dir)).toBe(true);
			expect(dirIsWritable(dir, { deep: true })).toBe(true);
			expect(readdirSync(dir)).toEqual([]);
			chmodSync(dir, 0o500);
			// Not writable → false, still not a throw.
			if (!isRoot) expect(dirIsWritable(dir)).toBe(false);
		} finally {
			chmodSync(dir, 0o700);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('installer wiring', () => {
	test('a VERIFY-ONLY check_directories keeps PHP shape and touches no media tree', () => {
		// PHP's installer check_directories never provisioned the tree (dd_init_test
		// did, at boot), so a verify call must report exactly what it always did.
		//
		// THE MEDIA ROOT IS STILL PASSED. `create:false` provisions nothing, but the
		// per-directory report is `exists && dirIsWritable(path)` — and
		// `dirIsWritable` is a WRITE probe, which without the seam lands a probe file
		// in the LIVE media root of whatever install this suite runs on (and answers
		// `writable:false` on any box whose media root belongs to the web-server
		// user, making the row a lie about the test rather than about the install).
		// Verify-only is not read-only.
		withScratchRoot((root) => {
			const report = checkDirectories({ create: false, mediaRoot: root });
			expect(report.mediaTree).toBeNull();
			expect(report.dirs.some((d) => d.label === 'Media tree')).toBe(false);
			// The Media row is the scratch root, and the probe left nothing in it.
			expect(report.dirs.find((d) => d.label === 'Media')?.path).toBe(root);
			expect(listTree(root)).toEqual([]);
		});
	});

	test('create:true provisions the tree at the GIVEN root, reports one row, and never touches config.media.rootPath', () => {
		withScratchRoot((root) => {
			const report = checkDirectories({ create: true, mediaRoot: root });

			// The media rows point at the override. Without this seam a unit test
			// mkdirs into the live media root — which is exactly what happened.
			expect(report.dirs.find((d) => d.label === 'Media')?.path).toBe(root);
			expect(report.mediaTree?.root).toBe(root);
			expect(report.mediaTree?.root).not.toBe(config.media.rootPath);

			// ONE row for the whole tree (thirty would drown the installer panel).
			const treeRow = report.dirs.find((d) => d.label === 'Media tree');
			expect(treeRow?.path).toBe(root);
			expect(treeRow?.exists).toBe(true);
			expect(treeRow?.writable).toBe(true);

			// It really provisioned: the audit MAJOR's folder exists at the tree mode.
			expect(existsSync(join(root, 'av', 'subtitles'))).toBe(true);
			expect(statSync(join(root, 'av', 'subtitles')).mode & 0o777).toBe(MEDIA_DIR_MODE);
			expect(report.mediaTree?.created.length).toBe(mediaTreeEntries(root).length - 1);
		});
	});

	test('msg stays a SINGLE line — the client renders it in a one-line flex pill', () => {
		// The installer prints msg as ONE step line (the plain and full-screen UIs; the
		// browser wizard's one-line pill before 2026-10-12); embedded newlines break
		// it, and a legacy install produces one problem line per folder.
		// The per-directory detail travels structured, on mediaTree.problems.
		withScratchRoot((root) => {
			// A legacy-shaped tree: pre-existing folders at the 0775 the audit found.
			mkdirSync(join(root, 'av', 'posterframe'), { recursive: true });
			chmodSync(join(root, 'av', 'posterframe'), 0o775);
			chmodSync(join(root, 'av'), 0o775);
			const report = checkDirectories({ create: true, mediaRoot: root });
			expect(report.mediaTree?.problems.length ?? 0).toBeGreaterThan(1);
			expect(report.msg.includes('\n')).toBe(false);
			expect(report.msg).toContain('media tree:');
			expect(report.msg).toContain('warning(s)');
		});
	});

	test('a refusing configuration becomes a FAILED row, never a silent advance', () => {
		withScratchRoot((root) => {
			// A FILE where the media root's `av` folder belongs: the tree cannot be
			// provisioned, and the installer must show it.
			writeFileSync(join(root, 'av'), 'not a directory');
			const report = checkDirectories({ create: true, mediaRoot: root });
			expect(report.ok).toBe(false);
			expect(report.dirs.find((d) => d.label === 'Media tree')?.exists).toBe(false);
		});
	});
});

describe('boot provisioning — the production entry point', () => {
	/**
	 * THE AUDIT BLOCKER. The installer step only ever runs during an INSTALL, and
	 * every existing oral-history box is years past it, so wiring the tree to the
	 * installer alone leaves `av/subtitles` missing on exactly the machines the
	 * audit was about. PHP ran dd_init_test on EVERY REQUEST; this runs it at boot.
	 */
	test('creates the whole tree on an already-installed box and is idempotent', () => {
		withScratchRoot((root) => {
			// The shape of a legacy install: a media root with content but no
			// subtitles folder — the state every dedalo7_mht-like box is in.
			mkdirSync(join(root, 'av', 'original'), { recursive: true });
			expect(existsSync(join(root, 'av', 'subtitles'))).toBe(false);

			const first = provisionMediaTreeAtBoot({ root });
			expect(first).not.toBeNull();
			expect(first?.result).toBe(true);
			expect(existsSync(join(root, 'av', 'subtitles'))).toBe(true);
			expect(existsSync(join(root, 'av', 'audio_tr'))).toBe(true);

			const second = provisionMediaTreeAtBoot({ root });
			expect(second?.created).toEqual([]);
			expect(second?.result).toBe(true);
		});
	});

	test('a broken media root is LOUD, never a throw (the boot must not be refused)', () => {
		withScratchRoot((root) => {
			// A FILE where a whole tier belongs: unfixable without an operator.
			writeFileSync(join(root, 'image'), 'not a directory');
			let report: ReturnType<typeof provisionMediaTreeAtBoot> | undefined;
			expect(() => {
				report = provisionMediaTreeAtBoot({ root });
			}).not.toThrow();
			expect(report?.result).toBe(false);
			expect(report?.problems.some((p) => p.kind === 'not_a_directory')).toBe(true);
			// ...and everything it COULD provision, it did: one broken tier never
			// hides the rest (av/subtitles is the whole point).
			expect(existsSync(join(root, 'av', 'subtitles'))).toBe(true);
		});
	});

	test('an unconfigured media root returns null instead of throwing', () => {
		expect(provisionMediaTreeAtBoot({ root: '' })).toBeNull();
	});

	test('src/server.ts runs the boot pass before serving and before the media rule files', () => {
		// The wiring itself is the fix: without a boot caller the provisioner never
		// reaches an installed box. Asserted structurally because startServer binds
		// a socket and cannot be invoked from a unit test.
		const src = readFileSync(join(REPO_ROOT, 'src', 'server.ts'), 'utf8');
		const startServer = src.indexOf('export async function startServer');
		const bootCall = src.indexOf('provisionMediaTreeAtBoot()');
		const ruleFiles = src.indexOf('writeRuleFiles();');
		expect(startServer).toBeGreaterThan(-1);
		expect(bootCall, 'src/server.ts must call provisionMediaTreeAtBoot() at boot').toBeGreaterThan(
			startServer,
		);
		// BEFORE the rule files: those are written INTO the media root.
		expect(bootCall).toBeLessThan(ruleFiles);
		// Statically imported, not a dynamic import inside a fire-and-forget IIFE:
		// a request must never observe a half-provisioned tree.
		expect(src).toContain(
			"import { provisionMediaTreeAtBoot } from './core/install/media_tree.ts'",
		);
	});

	test('summarizeMediaTreeReport is one line and names the counts', () => {
		withScratchRoot((root) => {
			const report = provisionMediaTree({ root, create: true });
			const line = summarizeMediaTreeReport(report);
			expect(line.includes('\n')).toBe(false);
			expect(line).toContain(`${report.created.length} created`);
		});
	});
});

/**
 * THE LIVE-MEDIA-ROOT GATE — the mechanical half of "a test never touches the
 * configured media root".
 *
 * It has been broken twice. `install_persist_config.test.ts` called the create
 * pass without a root and mkdir'd `html_files`, `export` and `upload` into the
 * developer's real media tree; this file then called the VERIFY pass without one
 * and write-probed it. Both were invisible because the default is AMBIENT: omit
 * the argument and you silently get `config.media.rootPath`.
 *
 * The ambient default cannot be removed — `provisionMediaTreeAtBoot()` in
 * `src/server.ts` and `checkDirectories` in `scripts/install.ts` are exactly the
 * production callers that must resolve the configured root themselves. So the
 * invariant is stated where it is true: EVERY call from a TEST names its own
 * root, at every door into the media root.
 *
 * The gate is on the doors as a SET, not on one spelling: the register below
 * lists every entry point that resolves a media root and what an explicit root
 * looks like in its argument list, and the file register makes a NEW test file
 * reaching for one a deliberate act rather than a silent one.
 */
const MEDIA_ROOT_DOORS: Readonly<Record<string, RegExp>> = Object.freeze({
	// door → the shape of an explicit root in its arguments
	// `[:,}]` so an object SHORTHAND counts as explicit — `{ root, create: true }`
	// and `{ create: true, mediaRoot }` name the root exactly as loudly as the long
	// form, and a gate that only accepted one spelling would teach the next author
	// to reach for the other rather than for a scratch root.
	checkDirectories: /\bmediaRoot\s*[:,}]/,
	provisionMediaTree: /\broot\s*[:,}]/,
	provisionMediaTreeAtBoot: /\broot\s*[:,}]/,
	verifyMediaTree: /\S/, // one positional argument: the root
	mediaTreeEntries: /\S/, // the declared tree OF a root (the export path is root-relative)
});

/** The test files allowed to open one of those doors at all. */
const MEDIA_ROOT_DOOR_FILES: readonly string[] = [
	'test/unit/install_persist_config.test.ts',
	'test/unit/media_tree_provision_native.test.ts',
	// The test-media-root tripwire PROVES `provisionMediaTree` refuses an unmarked
	// root and writes into a marked one — it cannot do that without opening the
	// door, and both roots it opens are mkdtemp'd and removed in the same test.
	'test/unit/test_media_root_tripwire.test.ts',
];

/**
 * Blank out comments and string/template literals.
 *
 * Without it the gate reads its own prose and this file's source-level
 * assertions about `src/server.ts` (which quote a call verbatim, inside a
 * string) as real call sites — a false red that would teach the next author to
 * weaken the scanner.
 */
function stripLiteralsAndComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/\/\/[^\n]*/g, ' ')
		.replace(/`(?:\\.|[^`\\])*`/g, "''")
		.replace(/'(?:\\.|[^'\\\n])*'/g, "''")
		.replace(/"(?:\\.|[^"\\\n])*"/g, "''");
}

/** The argument text of every call to `name(` in `source`, parens balanced. */
function callArguments(source: string, name: string): string[] {
	const calls: string[] = [];
	const opener = new RegExp(`\\b${name}\\s*\\(`, 'g');
	for (const match of source.matchAll(opener)) {
		let depth = 0;
		let index = match.index + match[0].length - 1;
		const start = index + 1;
		for (; index < source.length; index++) {
			const char = source[index];
			if (char === '(') depth++;
			else if (char === ')') {
				depth--;
				if (depth === 0) break;
			}
		}
		calls.push(source.slice(start, index));
	}
	return calls;
}

describe('no test may reach the CONFIGURED media root', () => {
	const testFiles = [...new Glob('**/*.ts').scanSync({ cwd: join(REPO_ROOT, 'test') })]
		.map((rel) => `test/${rel}`)
		.sort();

	test('only the registered test files open a media-root door', () => {
		const openers = testFiles.filter((file) => {
			const source = stripLiteralsAndComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
			return Object.keys(MEDIA_ROOT_DOORS).some((door) => callArguments(source, door).length > 0);
		});
		// A new file here is not forbidden — it is DECLARED, so the reviewer of that
		// change is the one who checks it passes a scratch root.
		expect(openers).toEqual([...MEDIA_ROOT_DOOR_FILES].sort());
	});

	test('every call from a test names its own root — no ambient default anywhere', () => {
		const offenders: string[] = [];
		for (const file of testFiles) {
			const source = stripLiteralsAndComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
			for (const [door, explicitRoot] of Object.entries(MEDIA_ROOT_DOORS)) {
				for (const args of callArguments(source, door)) {
					if (!explicitRoot.test(args)) offenders.push(`${file}: ${door}(${args.trim()})`);
				}
			}
		}
		// Each of these would run against config.media.rootPath — the developer's or
		// the CI box's REAL media tree, created into and write-probed.
		expect(offenders).toEqual([]);
	});
});

/**
 * THE PERMISSION-MODE CENSUS — the mechanical gate for the invariant
 * `MEDIA_DIR_MODE`'s docblock states ("every media writer creates its
 * data-dependent bucket directories with THIS constant rather than a literal").
 *
 * The audit's §5.2 finding has two halves. The tree provisioner fixes the first
 * (the static tree exists, at one mode). The second — "inconsistent permission
 * modes 0775 vs 0750" — is about the DATA-DEPENDENT bucket directories
 * (`media/av/original/0/`, …) that writers mkdir with `recursive:true` as they
 * store a file. Those are not declarable in the tree, so the only possible gate
 * is a source census.
 *
 * THE RULE: no `mkdir`/`mkdirSync` anywhere in the engine may carry a NUMERIC
 * mode literal unless this register says so, with a reason. That is deliberately
 * wider than "ban 0o775": a literal 0o750 is the same defect one refactor later,
 * because it restates a value that must be able to change in ONE place.
 *
 * Each row is classified:
 *   - `not_media` — a directory outside the media root with its own, deliberate
 *      posture (owner-only secrets). Permanent; it must NOT become MEDIA_DIR_MODE.
 *   - `media_debt` — a directory under the media root that must import
 *      MEDIA_DIR_MODE. OPEN, and owned by another workstream's files: this
 *      register is the ratchet that stops the set growing while they land.
 *
 * The census is asserted EXACTLY equal to the register in both directions, so a
 * new literal is red and a fixed one must have its row deleted.
 */
interface DirModeRow {
	readonly modes: readonly string[];
	readonly kind: 'not_media' | 'media_debt';
	readonly reason: string;
}

const DIR_MODE_REGISTER: Readonly<Record<string, DirModeRow>> = Object.freeze({
	// ---- not_media: deliberately NOT the media tree's mode -------------------
	'src/core/install/dev_tls.ts': {
		modes: ['0o700'],
		kind: 'not_media',
		reason:
			'<private>/tls — the developer certificate directory (the issuing CA key and the site key); owner-only by design',
	},
	'src/core/install/config_persist.ts': {
		modes: ['0o700'],
		kind: 'not_media',
		reason: '../private config dir — holds .env (DB password, salt); owner-only by design',
	},
	'src/core/install/ontology_install.ts': {
		modes: ['0o700', '0o700', '0o700'],
		kind: 'not_media',
		reason:
			'the installer ontology staging, incoming (fetched, not yet verified — cross-ops:r2) and unpack dirs under <private>/install/ontology_staging — domain-ontology files awaiting import; engine-only, owner-only by design',
	},
	'src/core/install/run_files_core.ts': {
		modes: ['0o700'],
		kind: 'not_media',
		reason:
			'the terminal installer run dir — <private>/install (engine) or /var/lib/dedalo-install/<i> (host route): plan, state, lock — install metadata; owner-only by design (forced on an existing dir too)',
	},
	'src/core/install/ontology_archive.ts': {
		modes: ['0o700', '0o700'],
		kind: 'not_media',
		reason:
			'the extraction + work dirs of a local ontology archive the installer reads (staging, outside the media root); engine-only, owner-only by design',
	},
	'src/core/security/session_store.ts': {
		modes: ['0o700'],
		kind: 'not_media',
		reason: 'session SQLite dir — session ids are bearer credentials; owner-only by design',
	},
	'src/diffusion/targets/mediastore/media_copy.ts': {
		modes: ['0o700'],
		kind: 'not_media',
		reason:
			'publication-host copy: the <private>/media_copy sha-cache dir (paths of published media + digests), engine-only state outside the served tree, owner-only by design',
	},
	'src/core/area_maintenance/backup.ts': {
		modes: ['0o700'],
		kind: 'not_media',
		reason: 'DB dump dir — a full database copy; owner-only by design',
	},
	'scripts/migrate_v6_config.ts': {
		modes: ['0o700'],
		kind: 'not_media',
		reason: 'writes the migrated ../private/.env; owner-only by design',
	},
	'scripts/lib/publication_host_agent_drill_kit.ts': {
		modes: ['0o700', '0o700'],
		kind: 'not_media',
		reason:
			"publication-host drill kit: the stand-ins' dir and the drill CA's dir (private keys) in the drill's scratch dir, NOT under the media root",
	},
	'scripts/lib/publication_host_agent_scene.ts': {
		modes: ['0o700', '0o750', '0o750', '0o755'],
		kind: 'not_media',
		reason:
			"publication-host drill scene: the agent's credentials dir (0700), its state root and the host locks dir (0750, the provisioner's layout: layout.ts MODES hostLocks) and the host-map renderer's identities dir (0755) in the drill's scratch HOST_BASE, NOT under the media root",
	},
	'scripts/lib/publication_host_engine_drill_kit.ts': {
		modes: ['0o700'],
		kind: 'not_media',
		reason: "engine drill: the engine bundle's dir (holds a client key) in the drill's scratch dir",
	},
	'scripts/publication_host_agent_drill.ts': {
		modes: ['0o700'],
		kind: 'not_media',
		reason:
			"agent drill copy pass: the engine children's scratch private dir, in the drill's scratch dir, NOT under the media root",
	},
	'scripts/publication_host_engine_drill.ts': {
		modes: ['0o700', '0o700', '0o700'],
		kind: 'not_media',
		reason:
			"engine drill: the engine's scratch private dir, the pairing-fragment dir (carries tokens) and the lockstep pass's scratch backup root, NOT under the media root",
	},
	'src/core/media/jobs.ts': {
		modes: ['0o750'],
		kind: 'not_media',
		reason: '../private/processes — the TS media-process tree, NOT under the media root',
	},
	'src/core/ontology/ontology_update.ts': {
		modes: ['0o750'],
		kind: 'not_media',
		reason: 'ontology schema-change log under ../private, NOT under the media root',
	},
	// ---- media_debt: under the media root, must import MEDIA_DIR_MODE --------
	'src/core/media/atomic.ts': {
		modes: ['0o775'],
		kind: 'media_debt',
		reason: 'bucket dir for the atomic media write',
	},
	'src/core/media/file_ops.ts': {
		modes: ['0o775', '0o775', '0o775'],
		kind: 'media_debt',
		reason: 'the `deleted` bucket, the move target dir and the restore target dir',
	},
	'src/core/media/ingest/add_file.ts': {
		modes: ['0o775'],
		kind: 'media_debt',
		reason: 'ingest target bucket dir',
	},
	'src/core/media/ingest/staged_thumbnail.ts': {
		modes: ['0o750'],
		kind: 'media_debt',
		reason: 'staged-thumbnail dir — right value, still a literal',
	},
	'src/core/media/ingest/upload.ts': {
		modes: ['0o700', '0o700', '0o750'],
		kind: 'media_debt',
		reason:
			'upload staging dir (0750, right value, still a literal) + the two per-upload chunk scratch dirs (0700, deliberately tighter: transient artefacts the web server must never serve) — the 0700 pair needs its OWN named constant, not MEDIA_DIR_MODE',
	},
	'src/core/media/tools/posterframe.ts': {
		modes: ['0o750', '0o775'],
		kind: 'media_debt',
		reason: 'posterframe bucket dirs — and the two disagree with each other',
	},
	'src/core/media/tools/transcription.ts': {
		modes: ['0o775', '0o775'],
		kind: 'media_debt',
		reason: 'audio_tr derivative bucket dirs',
	},
	'tools/tool_import_dedalo_csv/server/index.ts': {
		modes: ['0o775', '0o775'],
		kind: 'media_debt',
		reason: 'import target + deleted bucket dirs under the media root',
	},
});

/** Files whose mode literals are still open debt (kept as a shrink-only ratchet). */
const OPEN_MEDIA_DIR_MODE_DEBT = 10;

/** file → sorted numeric mkdir mode literals, scanned from the tracked sources. */
function dirModeCensus(): Record<string, string[]> {
	const found: Record<string, string[]> = {};
	// Single-line match: `mode:` inside one mkdir call, never across statements.
	const pattern = /\bmkdir(?:Sync)?\s*\([^;\n]*?\bmode:\s*(0o[0-7]+|[0-9]+)/g;
	for (const dir of ['src', 'tools', 'scripts']) {
		const glob = new Glob('**/*.ts');
		for (const rel of glob.scanSync({ cwd: join(REPO_ROOT, dir) })) {
			const relPath = `${dir}/${rel}`;
			const modes = [...readFileSync(join(REPO_ROOT, relPath), 'utf8').matchAll(pattern)]
				.map((match) => match[1] as string)
				.sort();
			if (modes.length > 0) found[relPath] = modes;
		}
	}
	return found;
}

describe('MEDIA_DIR_MODE census (the "no mode literals" invariant)', () => {
	test('the media tree itself uses the constant, never a literal', () => {
		expect(MEDIA_DIR_MODE).toBe(0o750);
		for (const file of ['src/core/install/media_tree.ts', 'src/core/install/directories.ts']) {
			expect(Object.keys(DIR_MODE_REGISTER)).not.toContain(file);
			expect(readFileSync(join(REPO_ROOT, file), 'utf8')).toContain('MEDIA_DIR_MODE');
		}
	});

	test('every mkdir mode literal in the engine is registered, with the same modes', () => {
		const census = dirModeCensus();
		// Compare as sorted JSON so a diff names the file AND the modes.
		const asRows = (source: Record<string, readonly string[]>) =>
			Object.keys(source)
				.sort()
				.map((file) => `${file}: ${[...source[file]!].join(',')}`);
		const registered: Record<string, readonly string[]> = {};
		for (const [file, row] of Object.entries(DIR_MODE_REGISTER)) registered[file] = row.modes;
		// A row in the census but not the register = a NEW mode literal: import
		// MEDIA_DIR_MODE instead. A row in the register but not the census = the
		// fix landed: DELETE the row (a dead register entry is debris, and it
		// would hide the next regression in that file).
		expect(asRows(census)).toEqual(asRows(registered));
	});

	test('the media-root debt only ever SHRINKS', () => {
		const debt = Object.entries(DIR_MODE_REGISTER).filter(([, row]) => row.kind === 'media_debt');
		// Every one of these creates a directory UNDER the media root and must
		// import MEDIA_DIR_MODE (or, for the 0700 upload scratch pair, its own
		// named constant). Lowering this number is the fix landing; raising it is
		// the audit finding being reintroduced.
		expect(debt.length).toBeLessThanOrEqual(OPEN_MEDIA_DIR_MODE_DEBT);
		for (const [, row] of debt) expect(row.reason.length).toBeGreaterThan(0);
	});

	test('no registered media_debt file may introduce a NEW distinct mode value', () => {
		// The audit found 0775 and 0750 in the wild; 0700 is the upload scratch
		// pair. A FOURTH value would be a new permission posture invented in a
		// corner of the media tree, which is how this finding was born.
		const known = new Set(['0o700', '0o750', '0o775']);
		for (const [file, row] of Object.entries(DIR_MODE_REGISTER)) {
			if (row.kind !== 'media_debt') continue;
			for (const mode of row.modes) {
				expect(known.has(mode), `${file}: unexpected media directory mode ${mode}`).toBe(true);
			}
		}
	});
});
