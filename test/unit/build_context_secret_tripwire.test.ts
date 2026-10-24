/**
 * build_context_secret_tripwire — SECRET MATERIAL NEVER TRAVELS WITH THE CODE,
 * BY ANY LANE (audit 2026-08-26, OPS-01 · P1-5).
 *
 * THE DEFECT THIS CLOSES. `Dockerfile` was `COPY . .` over the whole build
 * context and `.dockerignore` was a hand-maintained denylist that named neither
 * `deploy/certs/` nor `.dedalo.env` — although `.gitignore` already treats both
 * as secrets and `install.sh` WRITES them before it runs `compose build`
 * (`tls_local_ca` creates `deploy/certs/dedalo-local-ca.key`, step 4 writes
 * `.dedalo.env` with `POSTGRES_PASSWORD`, step 5 builds). The worst asset is the
 * local-CA private key: the script instructs the operator to install the
 * matching CA certificate into the Trusted Root store of EVERY computer that
 * will use Dédalo, so whoever obtains that key can mint a browser-trusted
 * certificate for ANY hostname on all of those workstations. The image carries
 * it to wherever the image goes — `deploy/dedalo-image-update.sh --mode pull`
 * documents a registry, and any `docker save` tarball or docker-group member is
 * the same lane.
 *
 * The engine already refuses the identical hazard one lane over: `code_update`
 * REFUSES a tree swap rather than let `deploy/certs/key.pem` travel with the
 * code tree. This gate holds the generalisation.
 *
 * WHAT IS ASSERTED, and why each leg exists:
 *
 *  A. THE MATCHER. Docker decides what enters a build context; this file has to
 *     decide the same thing without a daemon, so it re-implements
 *     moby/patternmatcher (`Matches` + `MatchesUsingParentResults`): a pattern
 *     compiled to an anchored regexp where `*` never crosses `/`, a path
 *     inheriting its ancestors' per-pattern results, LAST MATCH WINS. Leg A
 *     pins that behaviour against the documented semantics AND proves the
 *     matcher can answer `false` — a matcher that excludes everything would
 *     make legs C–E vacuously green.
 *  B. DERIVED, NOT MAINTAINED. `.dockerignore` and the Dockerfile COPY block
 *     must equal what `deploy/build_context.ts` renders from the tracked tree +
 *     the `.gitignore` census. Add a secret to `.gitignore`, forget to
 *     regenerate, and this is red.
 *  C. THE CENSUS IS TOTAL OVER EVERY TRACKED `.gitignore`. Every rule of the
 *     root one AND of each nested one (`publication/host_agent`,
 *     `publication/server_api/v2`, `publication/site_builder`) — derived from `git ls-files`, never
 *     enumerated here — is excluded from the build context, at the depth git
 *     would apply it RELATIVE TO ITS OWN DIRECTORY, and inside its subtree. The
 *     scoping is asserted in both directions: a nested rule must NOT reach
 *     outside its directory (the v2 API's `dist/` must not drop
 *     `client/…/service_ckeditor/css/dist/`).
 *  D. THE THREE NAMED PATHS. `deploy/certs`, `deploy/*.generated.conf` and
 *     `.dedalo.env` appear verbatim in `.dockerignore`.
 *  E. THE REAL ASSETS. The exact files install.sh writes are excluded, by path.
 *  F. NOT TOO EAGER. A context narrowed past what the engine needs breaks an
 *     install: every tracked file must still be INCLUDED unless it sits under a
 *     named exclusion, and every exclusion must still match tracked files
 *     (staleness is failure).
 *  G. THE SECOND LAYER, READ OFF THE ARTIFACT. Every `COPY`/`ADD` in the
 *     DOCKERFILE is parsed — flags (`--from=`, `--chown=`, `--chmod=`,
 *     `--link`, `--exclude=`) separated from sources, both the shell and the
 *     JSON-array form — and no instruction may name the whole context or reach
 *     `deploy/` IN ANY SPELLING (`deploy`, `./deploy`, `deploy/certs`,
 *     `deploy/./certs`, a glob such as `d*` or `*`). It was a self-comparison
 *     before (the block was compared to `renderCopyBlock`, i.e. to its own
 *     generator), which could not fail on an artifact defect; the allowlist
 *     equality is now read out of the Dockerfile too. The detector's own
 *     offending inputs are constructed and proved to trip it.
 *  J. THE RESIDUAL, STATED. `*` is segment-wise, so the deny-all is deny-all AT
 *     DEPTH 1. This leg pins what that leaves: a nested untracked drop-in of
 *     SECRET SHAPE is denied by section 3 of the artifact, a nested untracked
 *     drop-in of ordinary shape ENTERS the context — the documented limit, held
 *     to its exact size so it cannot quietly grow.
 *  H. ROTATION. A key that already shipped in an image is compromised, so the
 *     fix ships a rotation path — and the gate RUNS it (issue, then rotate) on
 *     a scratch directory, proving new material, a working chain, 600 perms and
 *     an archived predecessor.
 *
 * HONEST LIMIT: legs A–G evaluate the ignore rules the way Docker does, they do
 * not run Docker (no daemon here). That is what leg G is for — the narrowed
 * COPY keeps `deploy/` out of the image on a rule Docker cannot interpret two
 * ways. Leg H is skipped, loudly, on a machine without `openssl`.
 */

import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
	allowlistCensusConflicts,
	COPY_BLOCK_BEGIN,
	COPY_BLOCK_END,
	censusPatterns,
	censusRules,
	contextAllowlist,
	gitignoreFiles,
	IMAGE_EXCLUSIONS,
	isSecretShapedPath,
	NAMED_SECRET_PATHS,
	renderCopyBlock,
	renderDockerignore,
	SECRET_LIKE_NAME,
	SECRET_SHAPE_PATTERNS,
	trackedSecretShapedFiles,
	trackedTopLevelEntries,
} from '../../deploy/build_context.ts';
import { tlsCommands as stackTlsCommands } from '../../src/core/install/host/stack/tls.ts';
import { engineSourceFiles } from '../helpers/engine_source_corpus.ts';
import { stackPlanCtx } from '../helpers/install_host_scratch.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = resolve(import.meta.dir, '../..');
const DOCKERIGNORE = readFileSync(join(ROOT, '.dockerignore'), 'utf-8');
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8');

// --- A. The matcher ---------------------------------------------------------

type CompiledPattern = { raw: string; exclusion: boolean; regex: RegExp };

/** Go's `filepath.Clean`, reduced to what a pattern needs: collapse `//`, drop
 * `./` segments and any trailing slash. */
function cleanPattern(pattern: string): string {
	const cleaned = pattern
		.split('/')
		.filter((segment, index) => segment !== '' || index === 0)
		.filter((segment) => segment !== '.')
		.join('/');
	return cleaned.length > 1 && cleaned.endsWith('/') ? cleaned.slice(0, -1) : cleaned;
}

/** moby/patternmatcher `Pattern.compile`: `**` spans separators, `*` and `?`
 * never do, everything else is a literal. */
function compilePattern(line: string): CompiledPattern | null {
	let raw = line.trim();
	if (raw.length === 0 || raw.startsWith('#')) return null;
	let exclusion = false;
	if (raw.startsWith('!')) {
		exclusion = true;
		raw = raw.slice(1).trim();
	}
	const pattern = cleanPattern(raw);
	if (pattern.length === 0) return null;
	let source = '^';
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index] as string;
		if (char === '*') {
			if (pattern[index + 1] === '*') {
				index++;
				if (pattern[index + 1] === '/') index++;
				source += index >= pattern.length - 1 ? '.*' : '((.*/)|([^/]*))';
			} else {
				source += '[^/]*';
			}
		} else if (char === '?') {
			source += '[^/]';
		} else if ('.+()^$|{}\\'.includes(char)) {
			source += `\\${char}`;
		} else {
			source += char;
		}
	}
	return { raw, exclusion, regex: new RegExp(`${source}$`) };
}

/**
 * The build context's decision for a path, the way Docker takes it: each
 * pattern's match is inherited from the path's ancestors (a file under an
 * excluded directory stays excluded), and the LAST matching pattern decides.
 */
class BuildContext {
	private readonly patterns: CompiledPattern[];
	private readonly cache = new Map<string, boolean[]>();

	constructor(dockerignore: string) {
		this.patterns = dockerignore
			.split('\n')
			.map((line) => compilePattern(line))
			.filter((pattern): pattern is CompiledPattern => pattern !== null);
	}

	get size(): number {
		return this.patterns.length;
	}

	private vector(path: string): boolean[] {
		const cached = this.cache.get(path);
		if (cached !== undefined) return cached;
		const parent = dirname(path);
		const inherited =
			parent === '.' || parent === path ? this.patterns.map(() => false) : this.vector(parent);
		const vector = this.patterns.map(
			(pattern, index) => (inherited[index] as boolean) || pattern.regex.test(path),
		);
		this.cache.set(path, vector);
		return vector;
	}

	/** true = the path does NOT enter the build context. */
	excludes(path: string): boolean {
		const vector = this.vector(path);
		let excluded = false;
		for (const [index, pattern] of this.patterns.entries()) {
			if (vector[index] === true) excluded = !pattern.exclusion;
		}
		return excluded;
	}
}

const CONTEXT = new BuildContext(DOCKERIGNORE);

describe('A. the ignore matcher behaves the way Docker does', () => {
	test('a bare pattern excludes the directory AND its whole subtree', () => {
		const context = new BuildContext('*\n!src\nnode_modules\n');
		expect(context.excludes('node_modules')).toBe(true);
		expect(context.excludes('node_modules/pkg/index.js')).toBe(true);
	});

	test('a single `*` never crosses a separator; `**` does', () => {
		expect(new BuildContext('*.log\n').excludes('deep/dir/app.log')).toBe(false);
		expect(new BuildContext('**/*.log\n').excludes('deep/dir/app.log')).toBe(true);
	});

	test('last match wins, in both directions', () => {
		expect(new BuildContext('*\n!src\n').excludes('src/server.ts')).toBe(false);
		expect(new BuildContext('*\n!src\nsrc/secret.pem\n').excludes('src/secret.pem')).toBe(true);
		expect(new BuildContext('src\n!src\n').excludes('src/server.ts')).toBe(false);
	});

	test('a leading `**/` matches a PARTIAL segment — the trap `atAnyDepth` avoids', () => {
		// moby compiles `**/` to `((.*​/)|([^/]*))`, whose second branch is a
		// PARTIAL SEGMENT with no separator after it — so the name is matched with
		// an arbitrary prefix at the level immediately below the pattern's literal
		// part. Measured, not assumed: `publication/site_builder/**/.env` (the
		// nested census's first spelling) dropped the tracked, lawful
		// `publication/site_builder/sample.env` out of the image. That file has since
		// been retired (the site builder's host artifacts are rendered now, not
		// committed by hand), so the live near-miss the census must not drop is the
		// committed rendered example `…/instances/example/env` — asserted below with
		// the rest of the lawful traffic. The trap itself is a property of moby's
		// compiler, not of any one file, which is why it is exercised on generic
		// paths here.
		expect(new BuildContext('**/.env\n').excludes('sample.env')).toBe(true);
		expect(new BuildContext('d/**/.env\n').excludes('d/sample.env')).toBe(true);
		expect(new BuildContext('d/**/certs\n').excludes('d/mycerts')).toBe(true);
		// The two-spelling form: depth 1 by the bare pattern, deeper by `**/*/`,
		// and a real separator is required before the name in both.
		const fixed = new BuildContext('d/.env\nd/**/*/.env\n');
		expect(fixed.excludes('d/sample.env')).toBe(false);
		expect(fixed.excludes('d/a/sample.env')).toBe(false);
		expect(fixed.excludes('d/.env')).toBe(true);
		expect(fixed.excludes('d/a/.env')).toBe(true);
		expect(fixed.excludes('d/a/b/c/.env')).toBe(true);
		// An extension body already begins with `*`, so the plain spelling is exact.
		const extension = new BuildContext('**/*.pem\n');
		expect(extension.excludes('backup.pem')).toBe(true);
		expect(extension.excludes('a/b/backup.pem')).toBe(true);
		expect(extension.excludes('a/b/backup.pemx')).toBe(false);
	});

	test('ANTI-VACUITY: the real context answers false for ordinary source', () => {
		expect(CONTEXT.size).toBeGreaterThan(40);
		expect(CONTEXT.excludes('src/server.ts')).toBe(false);
		expect(CONTEXT.excludes('client/dedalo/core/page/js/page.js')).toBe(false);
	});
});

// --- B. Derived, not maintained --------------------------------------------

describe('B. the artifacts are DERIVED from the tracked tree + the census', () => {
	test('.dockerignore equals what deploy/build_context.ts renders', () => {
		expect(DOCKERIGNORE).toBe(renderDockerignore(ROOT));
	});

	test('the Dockerfile COPY block equals the rendered allowlist', () => {
		const begin = DOCKERFILE.indexOf(COPY_BLOCK_BEGIN);
		const end = DOCKERFILE.indexOf(COPY_BLOCK_END);
		expect(begin).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(begin);
		expect(DOCKERFILE.slice(begin, end + COPY_BLOCK_END.length)).toBe(renderCopyBlock(ROOT));
	});

	test('the artifacts say how to regenerate themselves', () => {
		expect(DOCKERIGNORE).toContain('bun run deploy/build_context.ts');
		expect(DOCKERFILE).toContain('bun run deploy/build_context.ts');
		expect(DOCKERIGNORE).toContain('bun run context:gen');
		expect(DOCKERFILE).toContain('bun run context:gen');
	});

	test('the regeneration has a named script, like css:build and config:gen', () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
			scripts: Record<string, string>;
		};
		expect(manifest.scripts['context:gen']).toBe('bun run deploy/build_context.ts');
		expect(manifest.scripts['context:check']).toBe('bun run deploy/build_context.ts --check');
	});

	test('`--check` passes on THIS tree and REFUSES a stale one (driven end to end)', () => {
		const generator = join(ROOT, 'deploy/build_context.ts');
		const check = (root: string) =>
			Bun.spawnSync(['bun', 'run', generator, '--check', '--root', root], {
				stdout: 'pipe',
				stderr: 'pipe',
			});
		expect(check(ROOT).exitCode).toBe(0);

		// A synthetic checkout: its own git repo, its own nested .gitignore, its own
		// Dockerfile markers. A --check that has only ever run on a current tree has
		// never been observed to refuse anything.
		const scratch = scratchDir('ops01_check');
		try {
			const write = (path: string, body: string) => {
				mkdirSync(join(scratch, dirname(path)), { recursive: true });
				writeFileSync(join(scratch, path), body);
			};
			write('.gitignore', 'node_modules/\n.env\n');
			write('pkg/.gitignore', 'dist/\n');
			write('pkg/index.ts', 'export const x = 1;\n');
			write('src/server.ts', 'export const y = 2;\n');
			write('Dockerfile', `FROM scratch\n${COPY_BLOCK_BEGIN}\n${COPY_BLOCK_END}\n`);
			for (const args of [
				['init', '-q'],
				['add', '-A'],
				['-c', 'user.email=gate@dedalo.test', '-c', 'user.name=gate', 'commit', '-qm', 'x'],
			]) {
				expect(
					Bun.spawnSync(['git', '-C', scratch, ...args], { stdout: 'pipe', stderr: 'pipe' })
						.exitCode,
				).toBe(0);
			}
			// Nothing rendered yet: the check must REFUSE.
			writeFileSync(join(scratch, '.dockerignore'), '# stale\n');
			expect(check(scratch).exitCode).toBe(1);
			// Render, and it passes.
			expect(
				Bun.spawnSync(['bun', 'run', generator, '--root', scratch], {
					stdout: 'pipe',
					stderr: 'pipe',
				}).exitCode,
			).toBe(0);
			expect(check(scratch).exitCode).toBe(0);
			// The synthetic tree's own nested rule was translated relative to itself.
			const rendered = readFileSync(join(scratch, '.dockerignore'), 'utf-8');
			expect(rendered.split('\n')).toContain('pkg/dist');
			expect(rendered.split('\n')).not.toContain('dist');
			// And a drifted Dockerfile is refused on its own.
			writeFileSync(
				join(scratch, 'Dockerfile'),
				`FROM scratch\n${COPY_BLOCK_BEGIN}\n${COPY_BLOCK_END}\n`,
			);
			expect(check(scratch).exitCode).toBe(1);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	/**
	 * THE PAIR THAT CANNOT BOTH BE TRUE (2026-09-21). Rule 1 allowlists a
	 * top-level entry that holds TRACKED files; rule 2 denies it when a
	 * `.gitignore` names it — and the census is applied after the allowlist, last
	 * match wins. Emitted together, `.dockerignore` drops the whole tree while
	 * the Dockerfile still COPYs it: not a narrower image, a build that FAILS on
	 * that COPY.
	 *
	 * It shipped: dev/prompts/ui_redesign_calm_scholarly.md was tracked
	 * 2026-07-28, `dev/` was gitignored 2026-09-21, and the generator wrote `!dev`
	 * and `dev` without a word. Resolved by untracking the file; the generator now
	 * REFUSES the shape, because only the repository can say which of the two
	 * it means.
	 */
	test('a top-level entry that is BOTH allowlisted and denied is REFUSED, not rendered', () => {
		const generator = join(ROOT, 'deploy/build_context.ts');

		// This tree is clean — the real assertion, stated over the real repo.
		expect(
			allowlistCensusConflicts(ROOT),
			'a tracked tree is gitignored at top level: .dockerignore would drop it while the Dockerfile COPYs it',
		).toEqual([]);

		// POSITIVE CONTROL, driven end to end: a synthetic checkout that plants
		// exactly that shape must make the generator exit non-zero and SAY which
		// entry and which tracked file. A refusal never observed refusing is not
		// a refusal.
		const scratch = scratchDir('ops01_conflict');
		try {
			const write = (path: string, body: string) => {
				mkdirSync(join(scratch, dirname(path)), { recursive: true });
				writeFileSync(join(scratch, path), body);
			};
			write('.gitignore', 'dev/\n');
			write('dev/prompt.md', '# tracked under an ignored tree\n');
			write('src/server.ts', 'export const y = 2;\n');
			write('Dockerfile', `FROM scratch\n${COPY_BLOCK_BEGIN}\n${COPY_BLOCK_END}\n`);
			for (const args of [
				['init', '-q'],
				['add', '-A', '-f'],
				['-c', 'user.email=gate@dedalo.test', '-c', 'user.name=gate', 'commit', '-qm', 'x'],
			]) {
				expect(
					Bun.spawnSync(['git', '-C', scratch, ...args], { stdout: 'pipe', stderr: 'pipe' })
						.exitCode,
				).toBe(0);
			}
			expect(
				allowlistCensusConflicts(scratch),
				'matcher control: a tracked file under a gitignored top-level tree must be reported',
			).toEqual([{ entry: 'dev', trackedFiles: ['dev/prompt.md'] }]);

			const run = Bun.spawnSync(['bun', 'run', generator, '--root', scratch], {
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(run.exitCode, 'the generator must REFUSE the contradiction, not render it').not.toBe(
				0,
			);
			const said = run.stderr.toString();
			expect(said).toContain('dev');
			expect(said, 'the refusal must name the tracked file that causes it').toContain(
				'dev/prompt.md',
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

// --- C. The census is TOTAL -------------------------------------------------

/** Paths a `.gitignore` rule would ignore, RELATIVE TO THE DIRECTORY THAT
 * DECLARED IT: the rule with its wildcards filled, a nested twin when git would
 * match at any depth below that directory, and a child of each (the subtree a
 * directory rule covers). */
function pathsIgnoredBy(rule: string, directory: string): string[] {
	let body = rule.endsWith('/') ? rule.slice(0, -1) : rule;
	const anchored = body.startsWith('/');
	if (anchored) body = body.slice(1);
	const filled = body
		.replace(/\*\*\//g, 'nested/')
		.replace(/\*\*/g, 'nested')
		.replace(/\*/g, 'x')
		.replace(/\?/g, 'y');
	const paths = [filled];
	if (!anchored && !filled.includes('/')) paths.push(`deep/dir/${filled}`);
	const scope = directory.length > 0 ? `${directory}/` : '';
	return [...paths, ...paths.map((path) => `${path}/child.txt`)].map((path) => `${scope}${path}`);
}

describe('C. every path a tracked .gitignore treats as ignorable is out of the build context', () => {
	const rules = censusRules(ROOT).filter((one) => !one.rule.startsWith('!'));

	test('the census reads EVERY tracked .gitignore, not just the root one', () => {
		// Derived from `git ls-files`, so a new nested .gitignore joins the census
		// (and rewrites the artifact, which leg B then reddens) without an edit here.
		const files = gitignoreFiles(ROOT);
		expect(files[0]).toBe('.gitignore');
		expect(files.length).toBeGreaterThan(1);
		const listed = Bun.spawnSync(['git', '-C', ROOT, 'ls-files', '-z', '--', '*.gitignore'], {
			stdout: 'pipe',
		})
			.stdout.toString()
			.split('\0')
			.filter((path) => path === '.gitignore' || path.endsWith('/.gitignore'));
		expect(files.slice().sort()).toEqual(listed.slice().sort());
		expect(new Set(rules.map((one) => one.directory)).size).toBe(files.length);
	});

	test('the census is non-empty and derived (anti-vacuity floor)', () => {
		expect(rules.length).toBeGreaterThan(20);
		expect(censusPatterns(ROOT).length).toBeGreaterThanOrEqual(rules.length);
	});

	for (const { directory, rule } of rules) {
		test(`${directory.length > 0 ? directory : '<root>'} .gitignore rule ${rule} is excluded from the build context`, () => {
			for (const path of pathsIgnoredBy(rule, directory)) {
				expect({ directory, rule, path, excluded: CONTEXT.excludes(path) }).toEqual({
					directory,
					rule,
					path,
					excluded: true,
				});
			}
		});
	}

	test('a NESTED rule never reaches outside the directory that declared it', () => {
		// The v2 API ignores `dist/` and `coverage/`; the site builder ignores
		// `.test-tmp/`. Translated globally, the first would drop
		// client/…/service_ckeditor/css/dist/ — bytes the image needs — which is a
		// context narrowed past what the engine needs, i.e. a defect, not caution.
		for (const path of [
			'client/dedalo/core/services/service_ckeditor/css/dist/service_ckeditor.css',
			'src/coverage/report.ts',
			'scripts/.test-tmp/keep.ts',
		]) {
			expect({ path, excluded: CONTEXT.excludes(path) }).toEqual({ path, excluded: false });
		}
		// …while the same names INSIDE the declaring directory are excluded.
		for (const path of [
			'publication/server_api/v2/dist/index.js',
			'publication/server_api/v2/coverage/lcov.info',
			'publication/site_builder/.test-tmp/build/x.html',
		]) {
			expect({ path, excluded: CONTEXT.excludes(path) }).toEqual({ path, excluded: true });
		}
	});
});

// --- D + E. The named paths and the real assets -----------------------------

describe('D. the OPS-01 paths are named in .dockerignore', () => {
	for (const named of NAMED_SECRET_PATHS) {
		test(`${named} appears verbatim`, () => {
			expect(DOCKERIGNORE.split('\n')).toContain(named);
		});
	}
});

describe('E. the files the installer writes before `compose build` cannot enter the image', () => {
	// The docker/trial host steps (src/core/install/host/stack/): stack_tls (CA key +
	// site key + chain, copied institutional key), stack_files (.dedalo.env with the
	// generated POSTGRES_PASSWORD, compose.override.yaml, the generated nginx site),
	// and the host run's record (.dedalo-install/: plan + state).
	const assets = [
		'deploy/certs',
		'deploy/certs/dedalo-local-ca.key',
		'deploy/certs/dedalo-local-ca.pem',
		'deploy/certs/privkey.pem',
		'deploy/certs/fullchain.pem',
		'deploy/certs/dedalo-local-ca.srl',
		'deploy/nginx.simple.generated.conf',
		'deploy/nginx.docker.generated.conf',
		'deploy/anything.generated.conf',
		'.dedalo.env',
		'compose.override.yaml',
		'.dedalo-install/install.state.json',
		'.dedalo-install/install.plan.json',
		'.env',
		'private/.env',
		'media/1/5/original/coin.jpg',
		'src/core/update/install_stamp.json',
		'src/core/update/publication_manifest.json',
		'.agents/settings.local.json',
		'publication/server_api/v1/config_api/server_config_api.php',
		'backup.pem',
		'deploy/certs/nested/deeper/key.pem',
	];
	for (const asset of assets) {
		test(`${asset} is excluded`, () => {
			expect({ asset, excluded: CONTEXT.excludes(asset) }).toEqual({ asset, excluded: true });
		});
	}
});

// --- F. Not too eager -------------------------------------------------------

function trackedFiles(): string[] {
	const listed = Bun.spawnSync(['git', '-C', ROOT, 'ls-files', '-z'], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	expect(listed.exitCode).toBe(0);
	return listed.stdout
		.toString()
		.split('\0')
		.filter((path) => path.length > 0);
}

describe('F. the context is not narrowed past what the engine needs', () => {
	const tracked = trackedFiles();
	const excludedEntries = new Set(IMAGE_EXCLUSIONS.map((one) => one.entry));

	test('the tracked tree was read (anti-vacuity floor)', () => {
		expect(tracked.length).toBeGreaterThan(4000);
	});

	test('every tracked file is IN the context unless it sits under a named exclusion', () => {
		const dropped = tracked.filter(
			(path) => !excludedEntries.has(path.split('/')[0] as string) && CONTEXT.excludes(path),
		);
		expect(dropped).toEqual([]);
	});

	test('every named exclusion is still real (staleness is failure)', () => {
		const topLevel = new Set(trackedTopLevelEntries(ROOT));
		for (const exclusion of IMAGE_EXCLUSIONS) {
			expect({ entry: exclusion.entry, tracked: topLevel.has(exclusion.entry) }).toEqual({
				entry: exclusion.entry,
				tracked: true,
			});
			expect(exclusion.reason.length).toBeGreaterThan(30);
		}
	});

	test('every named exclusion is actually excluded', () => {
		for (const exclusion of IMAGE_EXCLUSIONS) {
			expect({ entry: exclusion.entry, excluded: CONTEXT.excludes(exclusion.entry) }).toEqual({
				entry: exclusion.entry,
				excluded: true,
			});
		}
	});

	test('what the engine cannot boot, install or update without is present', () => {
		const required = [
			'src/server.ts',
			'scripts/install.ts',
			'install/db/dedalo_install.pgsql.gz',
			'install/db/migrate.ts',
			'client/dedalo/core/page/css/main.css',
			'vendor/vendor_manifest.json',
			'tools/tool_export/register.json',
			'package.json',
			'bun.lock',
			'.bun-version',
			'src/core/update/build_info.txt',
		];
		for (const path of required) {
			expect({ path, present: existsSync(join(ROOT, path)) }).toEqual({ path, present: true });
			expect({ path, excluded: CONTEXT.excludes(path) }).toEqual({ path, excluded: false });
		}
	});
});

// --- G. The second layer: the COPY list -------------------------------------

type CopyInstruction = {
	line: string;
	verb: 'COPY' | 'ADD';
	flags: string[];
	sources: string[];
	destination: string;
};

/**
 * Every `COPY`/`ADD` of a Dockerfile, parsed the way the builder reads it:
 * `\`-continuations joined first, the leading `--flag[=value]` run (`--from=`,
 * `--chown=`, `--chmod=`, `--link`, `--exclude=`) separated from the operands,
 * BOTH forms of operand list — shell (`COPY a b ./`) and JSON array
 * (`COPY ["a","b","./"]`) — and the LAST operand is the destination.
 *
 * `--from=` is honoured rather than ignored: a stage source is still parsed and
 * still judged, because every stage in this file descends from `runtime`, which
 * is built from the context — a `COPY --from=runtime deploy …` would put the key
 * in the final image exactly as a context copy would.
 */
function copyInstructions(dockerfile: string): CopyInstruction[] {
	const joined = dockerfile.replace(/\\\r?\n\s*/g, ' ');
	const parsed: CopyInstruction[] = [];
	for (const line of joined.split('\n')) {
		const match = /^\s*(COPY|ADD)\s+(.*)$/i.exec(line);
		if (match === null) continue;
		const verb = (match[1] as string).toUpperCase() as 'COPY' | 'ADD';
		let rest = (match[2] as string).trim();
		const flags: string[] = [];
		while (rest.startsWith('--')) {
			const [flag, ...tail] = rest.split(/\s+/);
			flags.push(flag as string);
			rest = tail.join(' ').trim();
		}
		let operands: string[];
		if (rest.startsWith('[')) {
			operands = JSON.parse(rest) as string[];
		} else {
			operands = rest
				.split(/\s+/)
				.filter((token) => token.length > 0)
				.map((token) => token.replace(/^["']|["']$/g, ''));
		}
		if (operands.length < 2) continue;
		parsed.push({
			line: line.trim(),
			verb,
			flags,
			sources: operands.slice(0, -1),
			destination: operands[operands.length - 1] as string,
		});
	}
	return parsed;
}

/** `./deploy/./certs/` and `deploy//certs` are the same source. */
function normalizeSource(source: string): string {
	let path = source.trim();
	while (path.startsWith('./')) path = path.slice(2);
	path = path.replace(/\/\.\//g, '/').replace(/\/+/g, '/');
	if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
	return path.length === 0 ? '.' : path;
}

/** Does this source name the WHOLE build context? */
function isWholeContext(source: string): boolean {
	return ['.', '/', '*', '**', '**/*', './'].includes(normalizeSource(source));
}

/** Does this source reach `deploy/` — literally, or as a glob that could? */
function reachesDeploy(source: string): boolean {
	const normalized = normalizeSource(source);
	if (normalized === 'deploy' || normalized.startsWith('deploy/')) return true;
	const compiled = compilePattern(normalized);
	if (compiled === null) return false;
	// The same segment-wise matcher leg A pins: `d*` and `*` reach `deploy`,
	// `dep*/certs` reaches the key, `docs` reaches neither.
	return ['deploy', 'deploy/certs', 'deploy/certs/dedalo-local-ca.key'].some((path) =>
		compiled.regex.test(path),
	);
}

/** The offending sources of one Dockerfile text — the detector legs G asserts
 * empty on the real artifact, and non-empty on constructed offenders. */
function forbiddenCopySources(dockerfile: string): string[] {
	return copyInstructions(dockerfile)
		.flatMap((one) => one.sources)
		.filter((source) => isWholeContext(source) || reachesDeploy(source));
}

describe('G. no COPY in the DOCKERFILE can reach the key, in any spelling', () => {
	const instructions = copyInstructions(DOCKERFILE);

	test('the Dockerfile was actually parsed (anti-vacuity floor)', () => {
		// Asserted over the artifact, never over renderCopyBlock(): comparing the
		// generator to itself can only ever be green.
		expect(instructions.length).toBeGreaterThan(10);
		expect(instructions.every((one) => one.sources.length > 0)).toBe(true);
		expect(instructions.some((one) => one.sources.includes('src'))).toBe(true);
	});

	test('no COPY/ADD names the whole context or reaches deploy/', () => {
		expect(forbiddenCopySources(DOCKERFILE)).toEqual([]);
	});

	test('MUTATION: each forbidden spelling really does trip the detector', () => {
		const offenders = [
			'COPY . .',
			'COPY . ./',
			'COPY ./ .',
			'COPY --chown=bun:bun . .',
			'COPY --from=runtime --chown=bun:bun . /opt/x',
			'COPY * ./',
			'COPY --link ["**", "./"]',
			'COPY deploy ./deploy',
			'COPY ./deploy ./deploy',
			'COPY deploy/certs ./certs',
			'COPY deploy/./certs/ ./certs',
			'COPY --from=runtime deploy/certs/dedalo-local-ca.key /tmp/ca.key',
			'COPY ["deploy/certs", "./certs"]',
			'COPY d* ./',
			'ADD deploy ./deploy',
			'ADD --chown=1000:1000 . .',
			'copy deploy ./deploy',
		];
		for (const offender of offenders) {
			expect({ offender, tripped: forbiddenCopySources(offender).length > 0 }).toEqual({
				offender,
				tripped: true,
			});
		}
		// …and the lawful ones do NOT — a guard that refuses lawful traffic is a
		// defect, not caution.
		for (const lawful of [
			'COPY src ./src',
			'COPY package.json bun.lock* bun.lockb* ./',
			'COPY --from=runtime /opt/dedalo/master_dedalo/src ./src',
			'COPY docs ./docs',
			'COPY ["docs", "./docs"]',
			'COPY dev ./dev',
		]) {
			expect({ lawful, tripped: forbiddenCopySources(lawful).length > 0 }).toEqual({
				lawful,
				tripped: false,
			});
		}
	});

	test('a `\\`-continued COPY is parsed as one instruction, not silently skipped', () => {
		const continued = 'COPY --chown=bun:bun \\\n\tdeploy \\\n\t./deploy\n';
		expect(copyInstructions(continued).length).toBe(1);
		expect(forbiddenCopySources(continued)).toEqual(['deploy']);
	});

	test('the COPY block of the DOCKERFILE names exactly the allowlist', () => {
		const begin = DOCKERFILE.indexOf(COPY_BLOCK_BEGIN);
		const end = DOCKERFILE.indexOf(COPY_BLOCK_END);
		expect(begin).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(begin);
		const block = DOCKERFILE.slice(begin, end);
		const named = new Set(copyInstructions(block).flatMap((one) => one.sources));
		expect([...named].sort()).toEqual(contextAllowlist(ROOT).sort());
	});

	test('every allowlisted entry that is a directory lands at its own path', () => {
		// A multi-source COPY with a directory source copies its CONTENTS, which
		// would flatten every tree into the same place — the reason the generator
		// emits one COPY per directory.
		for (const one of copyInstructions(
			DOCKERFILE.slice(DOCKERFILE.indexOf(COPY_BLOCK_BEGIN), DOCKERFILE.indexOf(COPY_BLOCK_END)),
		)) {
			if (one.sources.length > 1) {
				const directories = one.sources.filter((source) =>
					statSync(join(ROOT, source)).isDirectory(),
				);
				expect({ line: one.line, directories }).toEqual({ line: one.line, directories: [] });
			} else {
				const source = one.sources[0] as string;
				if (statSync(join(ROOT, source)).isDirectory()) {
					expect({ source, destination: one.destination }).toEqual({
						source,
						destination: `./${source}`,
					});
				}
			}
		}
	});
});

// --- H. Rotation ------------------------------------------------------------

const ROTATE = join(ROOT, 'deploy/dedalo-tls-rotate.sh');
const INSTALL_SH = readFileSync(join(ROOT, 'install.sh'), 'utf-8');
const OPENSSL = Bun.which('openssl');

function runRotate(args: string[]): { code: number | null; err: string } {
	const proc = Bun.spawnSync([ROTATE, ...args], { stdout: 'pipe', stderr: 'pipe' });
	return { code: proc.exitCode, err: proc.stderr.toString() };
}

/** `openssl verify` of a chain against an authority. Since 2026-10-16 the
 * authority is two-tier (root trusted by workstations, issuing CA on the
 * server), and `verify` reads only the FIRST certificate of a file — the
 * issuing CA must be named as untrusted, as a browser takes it from the chain. */
function verifyExit(caPem: string, chain: string, issuing?: string): number | null {
	const args = [OPENSSL as string, 'verify', '-CAfile', caPem];
	if (issuing !== undefined) args.push('-untrusted', issuing);
	return Bun.spawnSync([...args, chain], { stdout: 'pipe', stderr: 'pipe' }).exitCode;
}

function opensslText(args: string[]): string {
	const proc = Bun.spawnSync([OPENSSL as string, ...args], { stdout: 'pipe', stderr: 'pipe' });
	return proc.stdout.toString();
}

describe('H. a key that already shipped in an image can be ROTATED', () => {
	test('the rotation script exists and is executable', () => {
		expect(existsSync(ROTATE)).toBe(true);
		const listed = Bun.spawnSync(['git', '-C', ROOT, 'ls-files', '-s', '--', 'deploy'], {
			stdout: 'pipe',
		});
		// Untracked before this change lands; once tracked it must carry the exec
		// bit, or install.sh cannot call it on a fresh clone.
		const row = listed.stdout
			.toString()
			.split('\n')
			.find((line) => line.includes('dedalo-tls-rotate.sh'));
		if (row !== undefined) expect(row.startsWith('100755 ')).toBe(true);
		expect(Bun.spawnSync(['bash', '-n', ROTATE], { stderr: 'pipe' }).exitCode).toBe(0);
	});

	test('the installer has ONE local-CA generator, and it is that script', () => {
		// Phase 4 (2026-10-12): the docker route's local CA is the TypeScript stack_tls
		// step's — and it RUNS the rotation script (the argv it builds, read back).
		const ctx = stackPlanCtx({
			route: 'docker',
			entity: 'museo',
			server_name: 'dedalo.example.org',
			tls_mode: 'local_ca',
		});
		const generators = stackTlsCommands(ctx)
			.filter((command) => command.kind === 'exec')
			.map((command) => (command.kind === 'exec' ? command.argv.join(' ') : ''))
			.filter((line) => line.includes('dedalo-tls-rotate.sh'));
		expect(generators.length).toBe(1);
		expect(generators[0]).toContain('--mode local-ca');
		// No second generator: no openssl invocation in the bootstrap or anywhere in the
		// engine (the installer's host steps included) — two generators would drift in
		// SAN, lifetime or permissions the first time one is fixed. The corpus is the
		// registered engine lister (all of src/), never a subtree chosen here. Reported
		// as booleans (a `not.toContain` failure prints the whole script).
		const engineFiles = engineSourceFiles();
		expect(engineFiles.length).toBeGreaterThan(500);
		const hostSources = engineFiles.map((file) => readFileSync(file, 'utf-8')).join('\n');
		expect({
			req: INSTALL_SH.includes('openssl req') || /['"]req['"],\s*['"]-x509/.test(hostSources),
			x509: INSTALL_SH.includes('openssl x509') || hostSources.includes("'x509'"),
		}).toEqual({ req: false, x509: false });
	});

	test('a rotated archive is itself outside the build context', () => {
		for (const path of [
			'deploy/certs/rotated-2026-01-01T000000Z',
			'deploy/certs/rotated-2026-01-01T000000Z/dedalo-local-ca.key',
			'deploy/certs/rotated-2026-01-01T000000Z-2/privkey.pem',
		]) {
			expect({ path, excluded: CONTEXT.excludes(path) }).toEqual({ path, excluded: true });
		}
	});

	if (OPENSSL === null) {
		test('THE ROTATION DRILL IS SKIPPED: openssl is not on PATH', () => {
			console.warn(
				'[build_context_secret_tripwire] openssl not found — the rotation drill did NOT run. Install openssl and re-run this file; install.sh refuses the local-CA mode without it too.',
			);
			expect(OPENSSL).toBeNull();
		});
	}

	describe.if(OPENSSL !== null)('the drill (issue, then rotate)', () => {
		const dir = scratchDir('ops01_rotate');
		mkdirSync(dir, { recursive: true });

		test('first issue produces a working chain with a protected key', () => {
			expect(
				runRotate([
					'--mode',
					'local-ca',
					'--host',
					'dedalo.test',
					'--dir',
					dir,
					'--no-reload',
					'--quiet',
				]).code,
			).toBe(0);
			for (const name of [
				'dedalo-issuing-ca.key',
				'dedalo-issuing-ca.pem',
				'dedalo-local-ca.pem',
				'privkey.pem',
				'fullchain.pem',
			]) {
				expect({ name, present: existsSync(join(dir, name)) }).toEqual({ name, present: true });
			}
			// The ROOT key is deleted at issue (only the name-constrained issuing
			// CA's key stays on the server — tls_local_ca_native holds the rest).
			expect(existsSync(join(dir, 'dedalo-local-ca.key'))).toBe(false);
			expect(
				verifyExit(
					join(dir, 'dedalo-local-ca.pem'),
					join(dir, 'fullchain.pem'),
					join(dir, 'dedalo-issuing-ca.pem'),
				),
			).toBe(0);
			expect(
				opensslText(['x509', '-in', join(dir, 'dedalo-local-ca.pem'), '-noout', '-subject']),
			).toMatch(/Dedalo local CA \d{4}-\d{2}-\d{2}T\d{6}Z/);
		});

		test('rotating replaces BOTH keys and archives the predecessors intact', () => {
			const previousCaKey = readFileSync(join(dir, 'dedalo-issuing-ca.key'), 'utf-8');
			const previousSiteKey = readFileSync(join(dir, 'privkey.pem'), 'utf-8');
			const previousCaPem = readFileSync(join(dir, 'dedalo-local-ca.pem'), 'utf-8');

			expect(
				runRotate([
					'--mode',
					'local-ca',
					'--host',
					'192.168.1.20',
					'--dir',
					dir,
					'--no-reload',
					'--quiet',
				]).code,
			).toBe(0);

			expect(readFileSync(join(dir, 'dedalo-issuing-ca.key'), 'utf-8')).not.toBe(previousCaKey);
			expect(readFileSync(join(dir, 'privkey.pem'), 'utf-8')).not.toBe(previousSiteKey);
			// The new chain verifies against the NEW authority…
			expect(
				verifyExit(
					join(dir, 'dedalo-local-ca.pem'),
					join(dir, 'fullchain.pem'),
					join(dir, 'dedalo-issuing-ca.pem'),
				),
			).toBe(0);
			// …and NOT against the old one: rotation is a replacement, not a re-issue.
			const archives = Bun.spawnSync(['sh', '-c', `ls -d ${dir}/rotated-* | head -1`], {
				stdout: 'pipe',
			})
				.stdout.toString()
				.trim();
			expect(archives.length).toBeGreaterThan(0);
			expect(readFileSync(join(archives, 'dedalo-local-ca.pem'), 'utf-8')).toBe(previousCaPem);
			expect(readFileSync(join(archives, 'dedalo-issuing-ca.key'), 'utf-8')).toBe(previousCaKey);
			expect(
				verifyExit(
					join(archives, 'dedalo-local-ca.pem'),
					join(dir, 'fullchain.pem'),
					join(dir, 'dedalo-issuing-ca.pem'),
				),
			).not.toBe(0);
			expect(
				verifyExit(
					join(archives, 'dedalo-local-ca.pem'),
					join(dir, 'fullchain.pem'),
					join(archives, 'dedalo-issuing-ca.pem'),
				),
			).not.toBe(0);
			// The IP branch of the SAN, which is what a LAN install actually gets.
			expect(opensslText(['x509', '-in', join(dir, 'fullchain.pem'), '-noout', '-text'])).toContain(
				'IP Address:192.168.1.20',
			);
		});

		test('two rotations inside one second do not overwrite each other archive', () => {
			const before = Bun.spawnSync(['sh', '-c', `ls -d ${dir}/rotated-* | wc -l`], {
				stdout: 'pipe',
			})
				.stdout.toString()
				.trim();
			expect(
				runRotate([
					'--mode',
					'local-ca',
					'--host',
					'dedalo.test',
					'--dir',
					dir,
					'--no-reload',
					'--quiet',
				]).code,
			).toBe(0);
			expect(
				runRotate([
					'--mode',
					'local-ca',
					'--host',
					'dedalo.test',
					'--dir',
					dir,
					'--no-reload',
					'--quiet',
				]).code,
			).toBe(0);
			const after = Bun.spawnSync(['sh', '-c', `ls -d ${dir}/rotated-* | wc -l`], {
				stdout: 'pipe',
			})
				.stdout.toString()
				.trim();
			expect(Number(after)).toBe(Number(before) + 2);
		});

		test('an institution certificate can be installed, even from the destination itself', () => {
			const chain = readFileSync(join(dir, 'fullchain.pem'), 'utf-8');
			expect(
				runRotate([
					'--mode',
					'existing',
					'--cert',
					join(dir, 'fullchain.pem'),
					'--key',
					join(dir, 'privkey.pem'),
					'--dir',
					dir,
					'--no-reload',
					'--quiet',
				]).code,
			).toBe(0);
			// The archive step MOVES the destination away; staging the inputs first
			// is what keeps a re-run from destroying the certificate it installs.
			expect(readFileSync(join(dir, 'fullchain.pem'), 'utf-8')).toBe(chain);
		});

		test('the private keys are never left readable by other accounts', () => {
			// Self-contained: `existing` mode above RETIRES the local CA into the
			// archive, so this issues its own material rather than depending on the
			// order the file's tests happen to run in.
			expect(
				runRotate([
					'--mode',
					'local-ca',
					'--host',
					'perms.test',
					'--dir',
					dir,
					'--no-reload',
					'--quiet',
				]).code,
			).toBe(0);
			// node's own stat, not `stat(1)`: the BSD (`-f %Lp`) and GNU (`-c %a`)
			// spellings are incompatible, and on GNU `-f` means --file-system, so a
			// shelled-out probe reads filesystem data on Linux and the gate goes red
			// in CI while passing on macOS.
			for (const name of ['privkey.pem', 'dedalo-issuing-ca.key']) {
				const octal = (statSync(join(dir, name)).mode & 0o777).toString(8);
				expect({ name, octal }).toEqual({ name, octal: '600' });
			}
			for (const name of ['fullchain.pem', 'dedalo-local-ca.pem', 'dedalo-issuing-ca.pem']) {
				// The certificates are PUBLIC — the CA file has to be copied to every
				// workstation, so a 600 here would be a support call, not security.
				const octal = (statSync(join(dir, name)).mode & 0o777).toString(8);
				expect({ name, octal }).toEqual({ name, octal: '644' });
			}
		});

		test('a refusal, not a half-rotation, when the arguments are wrong', () => {
			rmSync(dir, { recursive: true, force: true });
			expect(runRotate(['--mode', 'local-ca', '--dir', dir, '--no-reload']).code).not.toBe(0);
			expect(runRotate(['--mode', 'nonsense']).code).not.toBe(0);
			expect(
				runRotate(['--mode', 'existing', '--cert', '/no/such/cert', '--key', '/no/such/key']).code,
			).not.toBe(0);
		});
	});
});

// --- I. The walk ------------------------------------------------------------

/**
 * `SECRET_LIKE_NAME` / `isSecretShapedPath` are imported from the build-context
 * policy, which MIRRORS `src/core/update/code_update.ts` — the rule the
 * tree-swap lane already enforces. Mirrored rather than imported there:
 * importing the updater pulls the whole update subsystem into a gate that must
 * run with no database and no config. The mirror is checked against the
 * original below.
 */

/** Every file a Docker build would SEND from `root`, given the ignore rules.
 * A directory the rules exclude is pruned — unless an exception pattern could
 * re-include something inside it, which is exactly how Docker walks. */
function contextContents(root: string, context: BuildContext, exceptions: string[]): string[] {
	const sent: string[] = [];
	const walk = (relative: string): void => {
		for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
			const path = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				const prunable =
					context.excludes(path) && !exceptions.some((one) => one.startsWith(`${path}/`));
				if (!prunable) walk(path);
				continue;
			}
			if (!context.excludes(path)) sent.push(path);
		}
	};
	walk('');
	return sent.sort();
}

/** The `!` patterns of the real .dockerignore, as literal path prefixes. */
const EXCEPTION_PREFIXES = DOCKERIGNORE.split('\n')
	.map((line) => line.trim())
	.filter((line) => line.startsWith('!'))
	.map((line) => line.slice(1));

/**
 * The only secret-SHAPED files that legitimately travel: tracked samples and
 * fixtures that carry placeholder values, never live credentials. Shrink-only,
 * and each is re-checked as TRACKED on every run.
 */
const SECRET_SHAPED_IN_CONTEXT: ReadonlyArray<{ path: string; reason: string }> = [
	{
		path: 'publication/server_api/v2/.env.example',
		reason:
			'The publication API v2 sample configuration — the file an operator COPIES to .env and fills in. Placeholder values only (DB_PASSWORD=secret); the real one is .gitignored and outside the context.',
	},
	{
		path: 'publication/host_agent/.env.test',
		reason:
			"The publication-host agent's test fixture, loaded by `bun test` in that package (NODE_ENV=test, the only mode its config accepts an env-file SERVICE_TOKEN in): instance `test`, a dummy service token and ./.test-tmp roots, no live credential.",
	},
	{
		path: 'publication/site_builder/.env.test',
		reason:
			"The site builder's test fixture, loaded by `bun test` in that package: a dummy service token and ./.test-tmp roots, no live credential.",
	},
];

describe('I. walking an operator tree sends the code and nothing else', () => {
	test('the secret-shape rule is the one the tree-swap lane already uses', () => {
		const updater = readFileSync(join(ROOT, 'src/core/update/code_update.ts'), 'utf-8');
		expect(updater).toContain(String(SECRET_LIKE_NAME));
	});

	test('a synthetic install host: only the code is sent', () => {
		const root = scratchDir('ops01_context');
		// What a machine that ran ./install.sh actually holds.
		const planted = [
			'src/server.ts',
			'src/core/update/install_stamp.json',
			'client/dedalo/core/page/js/page.js',
			'deploy/certs/dedalo-local-ca.key',
			'deploy/certs/privkey.pem',
			'deploy/certs/rotated-2026-01-01T000000Z/dedalo-local-ca.key',
			'deploy/nginx.simple.generated.conf',
			'.dedalo.env',
			'.env',
			'media/1/5/original/coin.jpg',
			'.venv/lib/python3.14/site-packages/certifi/cacert.pem',
			'.agents/settings.local.json',
			'audits/2026-08-26_deep/FINDINGS.md',
			'node_modules/leaflet/dist/leaflet.js',
			'test/unit/something.test.ts',
			'app.log',
		];
		for (const path of planted) {
			mkdirSync(join(root, dirname(path)), { recursive: true });
			writeFileSync(join(root, path), 'x');
		}
		const sent = contextContents(root, CONTEXT, EXCEPTION_PREFIXES);
		rmSync(root, { recursive: true, force: true });
		expect(sent).toEqual(['client/dedalo/core/page/js/page.js', 'src/server.ts']);
	});

	test('THIS working tree: the only secret-SHAPED files sent are the named, tracked samples', () => {
		const sent = contextContents(ROOT, CONTEXT, EXCEPTION_PREFIXES);
		expect(sent.length).toBeGreaterThan(3000);
		const shaped = sent.filter((path) => isSecretShapedPath(path)).sort();
		expect(shaped).toEqual(SECRET_SHAPED_IN_CONTEXT.map((one) => one.path).sort());
		// A secret-shaped file may ride along only if git tracks it: an UNTRACKED
		// one is exactly the operator drop-in this whole change is about, and no
		// reason written here could make it safe.
		const tracked = new Set(trackedFiles());
		for (const allowed of SECRET_SHAPED_IN_CONTEXT) {
			expect({ path: allowed.path, tracked: tracked.has(allowed.path) }).toEqual({
				path: allowed.path,
				tracked: true,
			});
			expect(allowed.reason.length).toBeGreaterThan(30);
		}
	});
});

// --- J. The residual of a segment-wise `*` ----------------------------------

/** The real context with section 3 (the secret-shape denies) removed — the
 * mutation control that proves those lines are load-bearing rather than
 * decorative. */
const CONTEXT_WITHOUT_SHAPES = new BuildContext(
	DOCKERIGNORE.split('\n')
		.filter((line) => !SECRET_SHAPE_PATTERNS.includes(line.trim()))
		.join('\n'),
);

describe('J. the deny-all is deny-all AT DEPTH 1, and the residual is exactly this', () => {
	test('the shape denies are in the artifact verbatim', () => {
		const lines = DOCKERIGNORE.split('\n');
		for (const pattern of SECRET_SHAPE_PATTERNS) {
			expect({ pattern, present: lines.includes(pattern) }).toEqual({ pattern, present: true });
		}
	});

	test('the depth-1 fact itself: `*` denies the root and NOT what is under it', () => {
		// This is the overstatement the artifact used to carry. `*` is compiled to
		// `[^/]*`, which cannot cross a separator — so with the allowlist in place a
		// nested path is decided by the LATER sections, never by this line.
		const bare = new BuildContext('*\n!src\n');
		expect(bare.excludes('scratch.pem')).toBe(true); // depth 1: denied
		expect(bare.excludes('src/keys/backup.pem')).toBe(false); // depth 3: NOT denied
	});

	test('a nested untracked secret-shaped drop-in is denied — at every depth', () => {
		for (const path of [
			'src/keys/backup.pem',
			'client/dedalo/private.key',
			'scripts/tls/site.crt',
			'docs/install/institution.p12',
			'engineering/ca.cer',
			'vendor/pdfjs/signing.pfx',
			'src/certs/anything.txt',
			'client/dedalo/core/certs/deep/key.txt',
			'publication/site_builder/.env.local',
			'tools/tool_export/.env',
		]) {
			expect({ path, excluded: CONTEXT.excludes(path) }).toEqual({ path, excluded: true });
		}
	});

	test('MUTATION: without section 3 those same drop-ins would travel', () => {
		for (const path of [
			'src/keys/backup.pem',
			'client/dedalo/private.key',
			'src/certs/anything.txt',
			'publication/site_builder/.env.local',
		]) {
			expect({ path, excluded: CONTEXT_WITHOUT_SHAPES.excludes(path) }).toEqual({
				path,
				excluded: false,
			});
		}
	});

	test('the shape denies do NOT refuse lawful traffic', () => {
		// The tracked placeholder samples, re-included by exact path…
		for (const sample of trackedSecretShapedFiles(ROOT)) {
			expect({ sample, excluded: CONTEXT.excludes(sample) }).toEqual({ sample, excluded: false });
		}
		expect(trackedSecretShapedFiles(ROOT).length).toBeGreaterThan(0);
		// …and ordinary source with a near-miss name.
		for (const path of [
			'src/core/security/keys.ts',
			'client/dedalo/core/common/js/certificate_view.js',
			'publication/site_builder/deploy/examples/rendered/etc/dedalo_sites/instances/example/env',
			'publication/site_builder/deploy/examples/rendered/etc/dedalo_sites/instances/example/engine.env.fragment',
			'src/core/media/envelope.ts',
		]) {
			expect({ path, excluded: CONTEXT.excludes(path) }).toEqual({ path, excluded: false });
		}
	});

	test('WHAT IS LEFT, held to its exact size: a nested ORDINARY drop-in travels', () => {
		// Not a bug hidden in a comment — the documented limit, asserted so it
		// cannot quietly grow into something else. Closing it would mean
		// allowlisting every tracked file by name, and a context narrowed past what
		// the engine needs breaks an install.
		for (const path of ['client/scratch.js', 'src/notes.txt', 'docs/DRAFT.md']) {
			expect({ path, excluded: CONTEXT.excludes(path) }).toEqual({ path, excluded: false });
		}
		// The artifact SAYS so, in the section that owns the residual.
		expect(DOCKERIGNORE).toContain('WHAT IS LEFT');
		expect(DOCKERIGNORE).toContain('deny-all AT DEPTH');
	});

	test('the shape rule is the tree-swap lane rule, unchanged', () => {
		expect(readFileSync(join(ROOT, 'src/core/update/code_update.ts'), 'utf-8')).toContain(
			String(SECRET_LIKE_NAME),
		);
		expect(isSecretShapedPath('deploy/certs/key.txt')).toBe(true);
		expect(isSecretShapedPath('src/server.ts')).toBe(false);
	});
});
