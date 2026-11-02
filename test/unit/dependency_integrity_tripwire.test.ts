/**
 * DEPENDENCY INTEGRITY TRIPWIRE (DEC-12) — every third-party byte this engine
 * installs or serves is pinned by a digest, and there is no third way in.
 *
 * WHY THIS EXISTS (P2-5, 2026-08-24). `package.json` declared
 * `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`. A tarball-URL
 * dependency is the one shape bun records WITHOUT integrity: 581 lockfile entries
 * carried `sha512-`, that one carried nothing. It was not an inert dev dependency
 * either — those bytes are served to browsers as `/dedalo/lib/xlsx/xlsx.mjs`
 * (`tools/tool_export/js/tool_export.js`), and a code update re-runs `bun install`
 * in the quarantine, so every update re-fetched unverified third-party client code.
 * One CDN compromise, or one MITM on an installation's network, and the next update
 * writes attacker JavaScript into every export the museum performs.
 *
 * xlsx was then VENDORED (2026-08-24), and removed with its tree (2026-09-24) once
 * tool_export wrote spreadsheets server-side. This gate is what stops the shape coming
 * back — anywhere, in any of the three packages that have their own lockfile.
 *
 * THE TWO HALVES, because closing one alone is a false floor:
 *   1. INSTALLED code — no dependency specifier may be a URL/git/file/link, and no
 *      lockfile tuple may resolve to a non-registry URL or lack a `sha512-`/`sha256-`
 *      integrity. That is the package-manager path.
 *   2. COMMITTED code — `vendor/` has no lockfile at all, so its integrity is the
 *      tree digest in `vendor/vendor_manifest.json`. Dirs and manifest rows must be
 *      exact complements (neither an undeclared tree nor a row with no tree), and
 *      every digest must recompute (`scripts/vendor_verify.ts`).
 *
 * THE COMMITTED ARM IS DERIVED, NOT A DIRECTORY (P2-5-residue: CLI-12, PUB-12,
 * OPS-08, 2026-09-04). "Under vendor/" was the census, so seven third-party files
 * committed elsewhere — a byte-identical @huggingface/transformers dist and two
 * EasyQRCodeJS copies under tools/, client-zip under tools/, lz-string and a dead
 * findAndReplaceDOMText UMD under client/, a 16 MB swagger-ui 4.5.2 under
 * publication/ — sat outside every axis for years with this gate green. Now
 * `scripts/lib/third_party_census.ts` reads EVERY tracked js/mjs/cjs/css/less file
 * under the trees that ship (client, deploy, install, publication, tools, vendor)
 * — and every tracked MODEL ARTIFACT there (.onnx/.safetensors/.wasm/…, a
 * tokenizer/config model-card file): the reviewer's re-run of this row found
 * 20 MB of a TranslateGemma tokenizer committed under tools/tool_lang/**, bytes
 * no code-shaped signature could see — and flags the ones wearing a third-party
 * signature and no first-party marker;
 * each must lie under a manifest row's root (`vendor/<id>` or the row's explicit
 * `root`) or be an ENUMERATED, shrink-only exemption with its reason. And every
 * row now declares a `licence` (closed SPDX set + the licence text inside the
 * tree), because redistribution has a fourth question a digest never asked.
 *
 * The lockfile roots are IMPORTED from `scripts/ci/audit.ts`, which already declares
 * that census for `bun audit`. Re-declaring the list here is how a fourth package
 * would end up audited but unguarded.
 *
 * HONEST LIMITS.
 *   - This proves a digest EXISTS and matches, never that the bytes are benign. A
 *     pinned malicious release stays pinned and malicious; `scripts/ci/audit.ts`
 *     (advisories) and the vendor staleness print are the other axis.
 *   - Distribution side is NOT covered here. `test/unit/release_archive_tripwire.test.ts`
 *     hashes nothing — it only rejects symlinks in the release archive — so what
 *     protects an installation receiving an update is the update's own archive-sha
 *     refusal, not an independent signature over vendor/.
 *   - Transitive integrity is only as good as bun's own lockfile writer: we assert
 *     the field is present and registry-shaped, not that bun verified it on install.
 *   - The third-party census is LEXICAL. A pretty-printed, unbannered, unmapped
 *     file with no copyright line looks like source to it — the shape of a
 *     hand-pasted snippet. The positive control proves the signatures it has, not
 *     that no other shape exists.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PACKAGES } from '../../scripts/ci/audit.ts';
import {
	SCAN_ROOTS as CENSUS_ROOTS,
	firstPartyMarker,
	isScannedPath,
	isUnderRoot,
	THIRD_PARTY_EXEMPTIONS,
	thirdPartyCensus,
	thirdPartySignatures,
} from '../../scripts/lib/third_party_census.ts';
import {
	checkVendorLicencesIn,
	checkVendorRootsIn,
	LICENCE_SPDX_IDS,
	libRootRelative,
	listVendorDirs,
	readManifest,
	treeDigest,
	type VendorManifest,
	type VendorManifestEntry,
	verifyVendorTrees,
} from '../../scripts/vendor_verify.ts';
import {
	lockTupleProblems,
	parseLockPackages,
} from '../../src/core/security/lockfile_provenance.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');

/**
 * A dependency specifier that is NOT a version range — it points at bytes the
 * registry never saw. `https?:` is the tarball-URL case that started this; `git`,
 * `github:`, `file:` and `link:` are the other doors into the same room (a git dep
 * resolves to a moving ref, a file/link dep to whatever is on that machine).
 */
const FORBIDDEN_SPECIFIER = /^(https?:|git|github:|file:|link:)/;

/** The dependency blocks a package manager reads. All of them, not just `dependencies`. */
const DEPENDENCY_BLOCKS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	// bun installs optional deps like any other, so a tarball URL parked here would
	// walk straight past a scan that only knew the three blocks above.
	'optionalDependencies',
	'bundledDependencies',
	'overrides',
	'resolutions',
] as const;

type PackageJson = Record<string, unknown>;

/**
 * Flatten one package.json's dependency blocks to `<block>.<name>` → specifier.
 * `overrides` may nest (`{"pkg": {"dep": "^1"}}`), so it recurses one level rather
 * than silently skipping the nested form — the exact way a scan narrows itself.
 */
function specifiersOf(pkg: PackageJson, label: string): { where: string; value: string }[] {
	const out: { where: string; value: string }[] = [];
	const visit = (node: unknown, path: string): void => {
		if (typeof node === 'string') {
			out.push({ where: `${label} ${path}`, value: node });
			return;
		}
		if (node !== null && typeof node === 'object') {
			for (const [key, value] of Object.entries(node)) visit(value, `${path}.${key}`);
		}
	};
	for (const block of DEPENDENCY_BLOCKS) {
		const node = pkg[block];
		if (node !== undefined) visit(node, block);
	}
	return out;
}

/**
 * The lockfile half is the ONE provenance law (src/core/security/lockfile_provenance.ts),
 * the same predicate every shipped publication bundle and kit is refused by — never a
 * second copy here. A lockfile without a `packages` object is a red, not an empty census.
 */
function parseLockfile(path: string): Record<string, unknown> {
	const read = parseLockPackages(readFileSync(path, 'utf-8'));
	if ('error' in read) throw new Error(`${path}: bun.lock ${read.error}`);
	return read.packages;
}

/** The problems in one lockfile tuple, worded for the offender list. */
function lockProblems(root: string, name: string, tuple: unknown): string[] {
	const resolution = Array.isArray(tuple) && typeof tuple[0] === 'string' ? tuple[0] : '';
	return lockTupleProblems(tuple).map((problem) =>
		problem === 'malformed'
			? `${root} bun.lock: "${name}" is not a lockfile tuple`
			: problem === 'non_registry'
				? `${root} bun.lock: "${name}" resolves to a non-registry source (${resolution})`
				: `${root} bun.lock: "${name}" (${resolution}) carries NO integrity hash`,
	);
}

describe('dependency integrity — installed', () => {
	test('the root census is the one scripts/ci/audit.ts declares (guards a silently empty scan)', () => {
		// Imported, never re-listed. If the import ever yields nothing, this gate would
		// pass by checking zero packages — the failure mode it exists to prevent.
		expect(PACKAGES.length).toBeGreaterThanOrEqual(5);
		for (const root of PACKAGES) {
			expect(existsSync(join(REPO_ROOT, root, 'package.json')), `${root}/package.json`).toBe(true);
			expect(existsSync(join(REPO_ROOT, root, 'bun.lock')), `${root}/bun.lock`).toBe(true);
		}
	});

	test('the census is EVERY locked package in the tree, not a list someone kept', () => {
		// P2-5 / GATE-52. PACKAGES was a literal three-element array while FOUR
		// manifests are tracked, each with its own lockfile. The missing one was
		// `publication/site_builder/templates/basic` — the build toolchain the site
		// scaffolder COPIES INTO EVERY GENERATED PUBLIC MUSEUM SITE — so it was
		// neither audited, nor guarded here, nor updated by Dependabot. And the
		// floor above was `>= 3`: BELOW the corpus, so the absent fourth could
		// never trip it. A floor must sit AT the corpus to notice a missing member.
		const tracked = Bun.spawnSync(['git', 'ls-files', '*package.json', 'package.json'], {
			cwd: REPO_ROOT,
			stdout: 'pipe',
		})
			.stdout.toString()
			.split('\n')
			.filter((line) => line.trim() !== '' && !line.includes('node_modules/'))
			.map((line) => dirname(line))
			.filter((dir) => existsSync(join(REPO_ROOT, dir, 'bun.lock')))
			.map((dir) => (dir === '' ? '.' : dir))
			.sort();

		expect(tracked.length, 'git found no tracked manifests — the census is blind').toBeGreaterThan(
			4,
		);
		expect(
			[...PACKAGES].sort(),
			'A tracked package with its own lockfile that is NOT in PACKAGES is audited by ' +
				'nothing and guarded by nothing. Derive the list; never keep one.',
		).toEqual(tracked);
	});

	test('no dependency specifier points outside the registry', () => {
		const offenders: string[] = [];
		for (const root of PACKAGES) {
			const pkg = JSON.parse(
				readFileSync(join(REPO_ROOT, root, 'package.json'), 'utf-8'),
			) as PackageJson;
			for (const { where, value } of specifiersOf(pkg, `${root}/package.json`)) {
				if (FORBIDDEN_SPECIFIER.test(value)) {
					offenders.push(
						`${where} = "${value}" — a URL/git/file dependency is installed with no integrity. ` +
							'Vendor it under vendor/ with a vendor/vendor_manifest.json row (see scripts/vendor_fetch.ts) or use a registry version.',
					);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test('every lockfile entry resolves to the registry AND carries an integrity hash', () => {
		const offenders: string[] = [];
		let entries = 0;
		for (const root of PACKAGES) {
			for (const [name, tuple] of Object.entries(
				parseLockfile(join(REPO_ROOT, root, 'bun.lock')),
			)) {
				entries++;
				offenders.push(...lockProblems(root, name, tuple));
			}
		}
		// Same anti-empty guard: a lockfile format change that yields no tuples must be
		// a red, not a green over 998 unchecked dependencies.
		expect(entries).toBeGreaterThan(500);
		expect(offenders).toEqual([]);
	});

	test('POSITIVE CONTROL — a synthetic URL specifier and an integrity-less tuple are caught', () => {
		// The scan's own detection, proven on data it cannot have been tuned to pass.
		const synthetic: PackageJson = {
			dependencies: { xlsx: 'https://cdn.example.com/xlsx-0.20.3/xlsx-0.20.3.tgz', zod: '^4.4.3' },
			overrides: { hono: { 'some-dep': 'github:owner/repo#main' } },
			devDependencies: { local: 'file:../thing', linked: 'link:../other' },
		};
		const caught = specifiersOf(synthetic, 'synthetic').filter((s) =>
			FORBIDDEN_SPECIFIER.test(s.value),
		);
		expect(caught.map((c) => c.where).sort()).toEqual(
			[
				'synthetic devDependencies.linked',
				'synthetic devDependencies.local',
				'synthetic overrides.hono.some-dep',
				'synthetic dependencies.xlsx',
			].sort(),
		);

		expect(
			lockProblems('.', 'xlsx', ['xlsx@https://cdn.example.com/xlsx-0.20.3.tgz', { bin: {} }]),
		).toHaveLength(2);
		expect(lockProblems('.', 'zod', ['zod@4.4.3', '', {}])).toEqual([
			'. bun.lock: "zod" (zod@4.4.3) carries NO integrity hash',
		]);
		expect(lockProblems('.', 'zod', ['zod@4.4.3', '', {}, 'sha512-abc'])).toEqual([]);
		// The shapes a deny-list or a last-'@' split missed: userinfo in a URL, a local
		// tarball and a workspace member (each written WITH an integrity), a non-tuple.
		for (const [name, tuple] of [
			['t', ['t@https://user@host/t.tgz', {}, 'sha512-abc']],
			['s', ['s@../ext/s.tgz', {}, 'sha512-abc']],
			['w', ['w@workspace:pkgs/w', {}, 'sha512-abc']],
			['u', 'not a tuple'],
		] as const) {
			expect(lockProblems('.', name, tuple), name).toHaveLength(1);
		}
	});

	test('every locked package turns Bun auto-install OFF (no by-name fetch around bun.lock)', () => {
		// Bun's auto-install resolves a bare import BY NAME from the registry when a
		// command runs in a checkout with no node_modules — ignoring bun.lock, so the
		// lockfile digests above pin nothing on that path. Measured on 1.4.3
		// (2026-10-20, fake registry): default → GET /<name>; `auto = "disable"` →
		// no request. Bun reads the bunfig of the cwd, so EVERY package needs its own.
		const offenders: string[] = [];
		for (const root of PACKAGES) {
			if (Object.hasOwn(AUTO_INSTALL_EXEMPTIONS, root)) continue;
			offenders.push(...autoInstallProblems(root, join(REPO_ROOT, root, 'bunfig.toml')));
		}
		expect(offenders).toEqual([]);
		// Shrink-only, and every entry still names a real package.
		for (const root of Object.keys(AUTO_INSTALL_EXEMPTIONS)) {
			expect(PACKAGES as readonly string[], `stale exemption ${root}`).toContain(root);
		}
		expect(Object.keys(AUTO_INSTALL_EXEMPTIONS).length).toBeLessThanOrEqual(1);
	});

	test('POSITIVE CONTROL — a missing bunfig, a missing key and a non-disable value are caught', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dd_autoinstall_'));
		try {
			const file = join(dir, 'bunfig.toml');
			expect(autoInstallProblems('x', file)).toHaveLength(1);
			writeFileSync(file, '[install]\npeer = false\n');
			expect(autoInstallProblems('x', file)).toHaveLength(1);
			writeFileSync(file, '[install]\nauto = "fallback"\n');
			expect(autoInstallProblems('x', file)).toHaveLength(1);
			writeFileSync(file, '[install]\nauto = "disable"\n');
			expect(autoInstallProblems('x', file)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * Packages whose bunfig is NOT this gate's to require, with the reason. Shrink-only.
 */
const AUTO_INSTALL_EXEMPTIONS: Record<string, string> = {
	'publication/site_builder/templates/basic':
		'scaffolded into each site workspace, which the agent owns and may rewrite: a bunfig there ' +
		'is a setting the agent controls, not a guarantee this gate could hold. Whether the ' +
		'scaffold ships one is the site builder’s own decision (open follow-up), not this one.',
};

function autoInstallProblems(root: string, file: string): string[] {
	if (!existsSync(file)) return [`${root}: no bunfig.toml — Bun auto-install is ON by default`];
	const parsed = Bun.TOML.parse(readFileSync(file, 'utf-8')) as { install?: { auto?: unknown } };
	const auto = parsed.install?.auto;
	return auto === 'disable'
		? []
		: [`${root}/bunfig.toml: [install] auto = ${JSON.stringify(auto)} — must be "disable"`];
}

describe('dependency integrity — committed under vendor/', () => {
	test('vendor/ directories and vendor_manifest.json rows are exact complements', () => {
		const dirs = listVendorDirs();
		const libs = readManifest().libs;
		// The complement law is over the rows WITHOUT an explicit root — those are the
		// ones that mean `vendor/<id>`. A row with a root is checked by the derived arm
		// below. Both directions, named separately so the failure says WHICH way it
		// broke: an undeclared tree is unhashed third-party code; a declared-but-absent
		// row is a manifest that describes something nobody can serve.
		const declared = Object.entries(libs)
			.filter(([, entry]) => typeof entry.root !== 'string')
			.map(([id]) => id)
			.sort();
		expect(dirs, 'a vendor/ tree with no manifest row is unhashed third-party code').toEqual(
			declared,
		);
		expect(dirs.length).toBeGreaterThan(0);
		// And the rooted rows are not a hole in the law: each root is tracked, outside
		// vendor/ and node_modules, non-overlapping, and explained in its note.
		expect(checkVendorRootsIn(readManifest())).toEqual([]);
		expect(
			Object.values(libs).filter((entry) => typeof entry.root === 'string').length,
			'no row carries an explicit root — the swagger-ui row is gone, or the field was renamed',
		).toBeGreaterThan(0);
	});

	test('every manifest row declares its licence, from the closed set, with the text in the tree', () => {
		const manifest = readManifest();
		expect(checkVendorLicencesIn(manifest)).toEqual([]);
		// Anti-vacuity: the check ran over every row, and the set is the one the
		// project decided on (AGPL-compatible only; widening it is a licensing decision).
		expect(Object.keys(manifest.libs).length).toBeGreaterThan(4);
		expect(LICENCE_SPDX_IDS.length).toBeGreaterThan(5);
		expect(LICENCE_SPDX_IDS).not.toContain('AGPL-3.0-only');
	});

	test('every package manifest declares the same licence as the project', () => {
		// OPS-08: a `license` field is what every registry, SBOM tool and downstream
		// reads; none of the four declared one. AGPL-3.0-only — License.md is the plain
		// AGPL text with no "or any later version" grant, so `-only` is the honest id.
		const declared = PACKAGES.map((root) => {
			const pkg = JSON.parse(
				readFileSync(join(REPO_ROOT, root, 'package.json'), 'utf-8'),
			) as PackageJson;
			return `${root}: ${String(pkg.license)}`;
		});
		expect(PACKAGES.length).toBeGreaterThanOrEqual(5);
		expect(declared).toEqual(PACKAGES.map((root) => `${root}: AGPL-3.0-only`));
	});

	test('every manifest row is substantive (version, upstream, review date, reason)', () => {
		const problems: string[] = [];
		for (const [id, entry] of Object.entries(readManifest().libs)) {
			if (entry.version.trim() === '') problems.push(`${id}: no version`);
			// `upstream` may be a prose "none — bespoke build" for ckeditor, whose upstream
			// genuinely does not exist. What it may never be is empty: the never-narrow law
			// wants the absence STATED, not implied.
			if (entry.upstream.trim().length < 4) problems.push(`${id}: no upstream stated`);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewed)) {
				problems.push(`${id}: reviewed "${entry.reviewed}" is not an ISO date`);
			}
			if (entry.note.trim().length < 40) problems.push(`${id}: note is too thin to be a reason`);
			if (!/^[0-9a-f]{64}$/.test(entry.tree_sha256)) problems.push(`${id}: tree_sha256 malformed`);
			if (entry.archive_sha256 !== null && !/^[0-9a-f]{64}$/.test(entry.archive_sha256)) {
				problems.push(`${id}: archive_sha256 must be a sha256 hex digest or null`);
			}
			if (entry.files < 1) problems.push(`${id}: file count ${entry.files}`);
		}
		expect(problems).toEqual([]);
	});

	test('every vendored tree still hashes to its manifest digest', () => {
		// The load-bearing assertion: this is the ONLY thing in the repo that hashes
		// the bytes we serve from vendor/.
		expect(verifyVendorTrees()).toEqual([]);
	});

	test('POSITIVE CONTROL — an edited byte and an added file both move the tree digest', () => {
		// The digest construction itself, exercised on a scratch tree so the control is
		// real without ever writing into vendor/. Both directions matter: hashing only
		// contents would miss a dropped file, hashing only names would miss an edit.
		const scratch = mkdtempSync(join(tmpdir(), 'dedalo_vendor_digest_'));
		try {
			writeFileSync(join(scratch, 'a.js'), 'export const a = 1;\n');
			mkdirSync(join(scratch, 'sub'));
			writeFileSync(join(scratch, 'sub', 'b.js'), 'export const b = 2;\n');
			const original = treeDigest(scratch);
			expect(original.files).toBe(2);

			writeFileSync(join(scratch, 'a.js'), 'export const a = 2;\n');
			expect(treeDigest(scratch).digest).not.toBe(original.digest);

			writeFileSync(join(scratch, 'a.js'), 'export const a = 1;\n');
			expect(treeDigest(scratch).digest).toBe(original.digest);

			writeFileSync(join(scratch, 'c.js'), '');
			const grown = treeDigest(scratch);
			expect(grown.files).toBe(3);
			expect(grown.digest).not.toBe(original.digest);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

/** A synthetic manifest around the REAL rows, so a control can bend one field. */
function withRow(id: string, patch: Partial<VendorManifestEntry>): VendorManifest {
	const manifest = readManifest();
	const base = manifest.libs.pdfjs as VendorManifestEntry;
	return { ...manifest, libs: { ...manifest.libs, [id]: { ...base, ...patch } } };
}

describe('dependency integrity — committed third-party bytes, DERIVED from the tree', () => {
	test('every file that looks third-party lies under a manifest root, or is an enumerated exemption', () => {
		const census = thirdPartyCensus();
		const roots = Object.entries(readManifest().libs).map(([id, entry]) =>
			libRootRelative(id, entry),
		);
		// Corpus floors, so a scan that silently narrowed (a lost root, a git failure,
		// an extension dropped) is a red rather than a green over nothing. 1100
		// tracked files were scanned on 2026-09-04; the floor sits well under a
		// deletion pass and far above "the scan found only one tree".
		expect(census.scanned.length, 'the census scanned too few files').toBeGreaterThan(800);
		expect(CENSUS_ROOTS.length).toBeGreaterThan(5);
		// EVERY manifest root contains at least one hit: the signatures still see the
		// bundles this manifest exists for. A root with zero hits means either the
		// tree is gone or the heuristic went blind — both red.
		const blindRoots = roots.filter(
			(root) => !census.hits.some((hit) => isUnderRoot(hit.file, root)),
		);
		expect(blindRoots, 'manifest roots in which the census sees no third-party file').toEqual([]);
		expect(census.hits.length).toBeGreaterThanOrEqual(roots.length);

		const exempt = new Set(THIRD_PARTY_EXEMPTIONS.map((entry) => entry.file));
		const offenders = census.hits
			.filter((hit) => !roots.some((root) => isUnderRoot(hit.file, root)))
			.filter((hit) => !exempt.has(hit.file))
			.map((hit) => `${hit.file} [${hit.signatures.join(', ')}]`);
		expect(
			offenders,
			'committed third-party bytes outside every manifest root — pin the package (src/core/client_libs/registry.ts), ' +
				'or give the tree a vendor_manifest.json row (with a `root` if it cannot live under vendor/), or ' +
				'enumerate it in THIRD_PARTY_EXEMPTIONS with its reason and licence',
		).toEqual([]);
	});

	test('the exemption list is enumerated, reasoned, shrink-only, and every entry still earns its place', () => {
		const census = thirdPartyCensus();
		const roots = Object.entries(readManifest().libs).map(([id, entry]) =>
			libRootRelative(id, entry),
		);
		const hits = new Map(census.hits.map((hit) => [hit.file, hit.signatures]));
		const stale: string[] = [];
		for (const entry of THIRD_PARTY_EXEMPTIONS) {
			if (entry.reason.trim().length < 60) stale.push(`${entry.file}: reason too thin`);
			if (!existsSync(join(REPO_ROOT, entry.file))) {
				stale.push(`${entry.file}: file is gone — delete the exemption`);
				continue;
			}
			if (!hits.has(entry.file)) {
				stale.push(`${entry.file}: the census no longer flags it — delete the exemption`);
			}
			if (roots.some((root) => isUnderRoot(entry.file, root))) {
				stale.push(`${entry.file}: lies under a manifest root — the exemption is redundant`);
			}
		}
		expect(stale).toEqual([]);
		// Shrink-only cap. 2 on 2026-09-04: one inlined stylesheet partial and the
		// theme stub of the bespoke CKEditor plugin. Lower it when one goes.
		expect(THIRD_PARTY_EXEMPTIONS.length).toBeLessThanOrEqual(2);
		expect(THIRD_PARTY_EXEMPTIONS.length).toBeGreaterThan(0);
	});

	test('POSITIVE CONTROL — a planted bundle is a hit, a first-party file is not, and a root outside the manifest is red', () => {
		// A scratch tree INSIDE the repo root (the census reads repo-relative paths),
		// fed to the census by explicit file list: git does not track it, so the
		// derived listing never sees it — which is itself the point of the listing.
		const scratch = `.scratch_third_party_census_${process.pid}`;
		const dir = join(REPO_ROOT, scratch);
		mkdirSync(dir, { recursive: true });
		try {
			const planted = `${scratch}/evil.min.js`;
			writeFileSync(
				join(REPO_ROOT, planted),
				`/*! evil-lib v9.9.9 | MIT License */\n${'x'.repeat(1200)}\n//# sourceMappingURL=evil.min.js.map\n`,
			);
			const prettyForeign = `${scratch}/lib.js`;
			writeFileSync(
				join(REPO_ROOT, prettyForeign),
				'/**\n * somelib 1.0\n * Copyright (c) 2019 Someone Else\n */\nexport const x = 1;\n',
			);
			const firstParty = `${scratch}/ours.js`;
			writeFileSync(
				join(REPO_ROOT, firstParty),
				`// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0\n${'y'.repeat(1200)}\n`,
			);
			const builtCss = `${scratch}/theme.css`;
			writeFileSync(
				join(REPO_ROOT, builtCss),
				`${'.a{}'.repeat(400)}\n/*# sourceMappingURL=theme.css.map */\n`,
			);
			writeFileSync(join(REPO_ROOT, `${scratch}/theme.less`), '.a{}\n');
			const plainSource = `${scratch}/plain.js`;
			writeFileSync(join(REPO_ROOT, plainSource), 'export const y = 2;\n');
			// MODEL ARTIFACTS (the reviewer's 2026-09-04 find: a 20 MB tokenizer under
			// tools/): a compiled model by extension, a model-card file by name, a
			// config.json by its model keys — and a config.json that is NOT a model's.
			mkdirSync(join(dir, 'm', 'onnx'), { recursive: true });
			const weights = `${scratch}/m/onnx/model_q4.onnx`;
			writeFileSync(join(REPO_ROOT, weights), Buffer.from([0x08, 0x07, 0x12, 0x00]));
			const tokenizer = `${scratch}/m/tokenizer.json`;
			writeFileSync(join(REPO_ROOT, tokenizer), '{"version":"1.0","model":{"type":"BPE"}}\n');
			const modelConfig = `${scratch}/m/config.json`;
			writeFileSync(
				join(REPO_ROOT, modelConfig),
				'{\n  "architectures": ["Gemma3ForConditionalGeneration"],\n  "model_type": "gemma3"\n}\n',
			);
			const plainConfig = `${scratch}/config.json`;
			writeFileSync(join(REPO_ROOT, plainConfig), '{"name":"dedalo","port":8080}\n');

			const census = thirdPartyCensus([
				planted,
				prettyForeign,
				firstParty,
				builtCss,
				plainSource,
				weights,
				tokenizer,
				modelConfig,
				plainConfig,
			]);
			expect(census.hits.map((hit) => hit.file).sort()).toEqual(
				[prettyForeign, planted, weights, tokenizer, modelConfig].sort(),
			);
			for (const artifact of [weights, tokenizer, modelConfig]) {
				expect(census.hits.find((hit) => hit.file === artifact)?.signatures).toEqual([
					'model artifact',
				]);
			}
			// The derived listing's OWN filter admits these shapes (a scratch corpus
			// bypasses `git ls-files`, so the filter is proved on its own).
			expect(isScannedPath('tools/x/models/m/onnx/model_q4.onnx')).toBe(true);
			expect(isScannedPath('tools/x/models/m/tokenizer.json')).toBe(true);
			expect(isScannedPath('tools/x/models/m/config.json')).toBe(true);
			expect(isScannedPath('tools/x/register.json')).toBe(false);
			expect(isScannedPath('client/x/logo.png')).toBe(false);
			const plantedSignatures: string[] = [
				...(census.hits.find((hit) => hit.file === planted)?.signatures ?? []),
			].sort();
			expect(plantedSignatures).toEqual(
				['minified line', 'minified name', 'preserved banner', 'source map'].sort(),
			);
			expect(census.hits.find((hit) => hit.file === prettyForeign)?.signatures).toEqual([
				'foreign copyright',
			]);
			expect(census.markedFirstParty.map((entry) => entry.marker).sort()).toEqual(
				['agpl banner', `built from ${scratch}/theme.less`].sort(),
			);
			// The signature function itself, on the exact shapes it claims.
			expect(thirdPartySignatures('a/b.js', 'export const a = 1;\n')).toEqual([]);
			expect(thirdPartySignatures('a/b-min.css', '.a{}')).toEqual(['minified name']);
			expect(
				firstPartyMarker('x/css/dist/y-min.css', '', (candidate) => candidate === 'x/css/y.less'),
			).toBe('built from x/css/y.less');
			expect(firstPartyMarker('x/y.js', '', () => true)).toBeNull();

			// The planted bundle lies under NO manifest root — exactly the shape the
			// gate above refuses. Proved through the same predicate.
			const roots = Object.entries(readManifest().libs).map(([id, entry]) =>
				libRootRelative(id, entry),
			);
			expect(roots.some((root) => isUnderRoot(planted, root))).toBe(false);
			expect(isUnderRoot('vendor/pdfjs/web/viewer.mjs', 'vendor/pdfjs')).toBe(true);
			expect(isUnderRoot('vendor/pdfjs2/x.js', 'vendor/pdfjs')).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('POSITIVE CONTROL — the row schema refuses a missing licence, an id outside the set, a text that disagrees, and a bad root', () => {
		// Built around the REAL rows so the checker reads real files: a control that
		// invented a manifest from nothing would prove the string comparison only.
		const real = readManifest();
		expect(checkVendorLicencesIn(real)).toEqual([]);

		const noLicence = withRow('pdfjs', {
			licence: undefined as unknown as VendorManifestEntry['licence'],
		});
		expect(checkVendorLicencesIn(noLicence).join('\n')).toContain('no "licence" block');

		const outsideSet = withRow('pdfjs', {
			licence: { spdx: 'WTFPL' as unknown as 'MIT', file: 'LICENSE' },
		});
		expect(checkVendorLicencesIn(outsideSet).join('\n')).toContain('is not one of');

		const missingFile = withRow('pdfjs', { licence: { spdx: 'Apache-2.0', file: 'COPYING' } });
		expect(checkVendorLicencesIn(missingFile).join('\n')).toContain('does not exist under');

		// pdfjs ships the Apache text; declaring it MIT must be refused by the bytes.
		const disagrees = withRow('pdfjs', { licence: { spdx: 'MIT', file: 'LICENSE' } });
		expect(checkVendorLicencesIn(disagrees).join('\n')).toContain('does not read as MIT');

		const escapes = withRow('pdfjs', { licence: { spdx: 'MIT', file: '../ckeditor/LICENSE.md' } });
		expect(checkVendorLicencesIn(escapes).join('\n')).toContain('reaches outside the tree');

		// Roots: under vendor/ (use the default), under node_modules, absent, untracked,
		// overlapping another row, and a note that does not explain itself.
		expect(checkVendorRootsIn(real)).toEqual([]);
		expect(checkVendorRootsIn(withRow('r1', { root: 'vendor/pdfjs' })).join('\n')).toContain(
			'is under vendor/',
		);
		expect(
			checkVendorRootsIn(withRow('r2', { root: 'node_modules/easyqrcodejs' })).join('\n'),
		).toContain('is under node_modules');
		expect(
			checkVendorRootsIn(withRow('r3', { root: 'tools/does_not_exist' })).join('\n'),
		).toContain('does not exist');
		const untracked = `.scratch_third_party_root_${process.pid}`;
		mkdirSync(join(REPO_ROOT, untracked), { recursive: true });
		try {
			writeFileSync(join(REPO_ROOT, untracked, 'x.js'), '');
			expect(checkVendorRootsIn(withRow('r4', { root: untracked })).join('\n')).toContain(
				'no git-tracked file',
			);
		} finally {
			rmSync(join(REPO_ROOT, untracked), { recursive: true, force: true });
		}
		expect(
			checkVendorRootsIn(
				withRow('r5', { root: 'publication/server_api/v1/docu/ui', note: 'why not vendor/: test' }),
			).join('\n'),
		).toContain('overlaps row "swagger-ui"');
		expect(
			checkVendorRootsIn(
				withRow('r6', { root: 'publication/server_api/v1/docu', note: 'a note with no reason' }),
			).join('\n'),
		).toContain('must say in its note why');
	});
});
