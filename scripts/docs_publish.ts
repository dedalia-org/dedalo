/**
 * PUBLISH THE MANUAL to dedalo.dev/docs/v7/.
 *
 * This script is THE GATE. Not a convenience wrapper around rsync — the only
 * route the manual has to production, with the checks standing in it rather
 * than beside it. Nothing external enforces anything: no CI job, no service,
 * no vendor. Run it on any machine with the deploy key and the result is the
 * same.
 *
 *   bun run docs:publish
 *
 * WHAT IT DOES, in order. Each step must pass before the next runs:
 *
 *   1. CONTENT GATE  — docs_current_engine_tripwire (the manual documents the
 *                      current engine, links resolve, no gitignored paths) and
 *                      docs_versioning_tripwire (the version wiring agrees, and
 *                      no published page vanished without a redirect), and
 *                      change_log_tripwire (the generated change log is current).
 *   2. BUILD GATE    — `mkdocs build --strict`, run HERE. It does not trust a
 *                      docs_site/ lying around from an earlier attempt; it
 *                      builds the tree it is about to ship. --strict promotes
 *                      MkDocs warnings to errors, so a dangling link fails the
 *                      publish instead of shipping a 404.
 *   3. UPLOAD        — rsync --delete, scoped INSIDE the version prefix, plus
 *                      versions.json and the routing .htaccess at the docs root.
 *                      Then, if DEDALO_DOCS_STAGE_DIR is set, mirror the same
 *                      tree into that local docs root so a preview copy cannot
 *                      fall behind the site.
 *   4. RECORD        — rewrite docs/published_paths.json with what was actually
 *                      served, which is what makes step 1's rename check real.
 *
 * HARD REFUSAL, NO OVERRIDE. A red gate exits non-zero having written nothing,
 * locally or remotely. There is deliberately no --force: the repo's posture
 * everywhere else (assertTestDatabase, the media-root marker) is to refuse
 * loudly rather than offer an escape hatch, because an escape hatch that exists
 * is one that gets used at the worst possible moment.
 *
 * WHY THE VERSION PREFIX MATTERS: --delete is scoped to DOCS_ROOT/v7/, so this
 * command cannot reach /docs/v6/ (frozen, and published from the v6 checkout)
 * nor any future /docs/v8/. A version's tree is only ever written by its own
 * repo. See deploy/docs/htaccess for the routing this assumes.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import { readEnv } from '../src/config/env.ts';
import { publishedPagePaths } from './lib/docs_paths.ts';
import { TEST_TIMEOUT_FLAG } from './lib/test_flags.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');
const SITE_DIR = join(REPO_ROOT, 'docs_site');
const MANIFEST = join(DOCS_DIR, 'published_paths.json');

/** The version this repo owns. Must match `site_url` in mkdocs.yml. */
const VERSION = 'v7';

/**
 * Where the site lives, as an rsync destination WITHOUT the version suffix —
 * e.g. `user@host:/home/www/vhosts/dedalo.dev/httpdocs/docs`.
 *
 * Deliberately NOT a config-catalog key. That catalog is the operator-facing
 * census: every entry is rendered into `install/sample.env` and the generated
 * region of `docs/administration/configuration/config.md`, and an institution running Dédalo never
 * publishes this manual. Publishing is a developer action, so this is a
 * developer setting, read from `../private/.env` like the rest of a
 * workstation's local truth.
 *
 * (`scripts/` is outside the `process.env` ban, which covers `src/` and
 * `tools/` — but readEnv is what actually reads ../private/.env, so it is the
 * right door regardless.)
 */
const TARGET_KEY = 'DEDALO_DOCS_RSYNC_TARGET';

/**
 * Optional non-default SSH port, as a number ALONE (`22`).
 *
 * Separate from the target on purpose. Bun's `$` escapes every interpolation as
 * a single argument, so flags folded into the target arrive as one unusable
 * token — and rsync's `-p` is "preserve permissions" anyway, not a port. Keeping
 * the port in its own key means neither the caller nor the script has to think
 * about quoting.
 */
const PORT_KEY = 'DEDALO_DOCS_SSH_PORT';

/**
 * Optional LOCAL docs root to mirror the published tree into — the website
 * checkout's `docs/` folder, say, so a local preview shows what is actually
 * live.
 *
 * Unset is the normal case and mirrors nothing. It exists because the moment a
 * second copy of the manual exists, it starts drifting: `docs:publish` goes
 * repo → server and would leave a hand-copied preview stale and silently so.
 * Refreshing it from the same tree in the same command is the only way the two
 * stay honest.
 *
 * Like the remote target, this is the ROOT — the script appends the version
 * directory itself, so it can never write over another version's copy.
 */
const STAGE_KEY = 'DEDALO_DOCS_STAGE_DIR';

function die(message: string, detail?: string): never {
	console.error(`\n✗ REFUSED: ${message}`);
	if (detail) console.error(`\n${detail}`);
	console.error('\nNothing was uploaded.\n');
	process.exit(1);
}

console.log('Publishing the Dédalo v7 manual.\n');

// ---------------------------------------------------------------------------
// 0. Where are we sending it?
// ---------------------------------------------------------------------------
const target = readEnv(TARGET_KEY);
if (!target) {
	die(
		`${TARGET_KEY} is not set.`,
		`Add the docs destination to ../private/.env (append-only, documented keys only):\n\n` +
			`  # Where \`bun run docs:publish\` uploads the manual. The docs ROOT —\n` +
			`  # the script appends /${VERSION}/ itself, so it can never write another\n` +
			`  # version's tree.\n` +
			`  ${TARGET_KEY}="dedalo_dev@dedalo.dev:/home/www/vhosts/dedalo.dev/httpdocs/docs"\n\n` +
			`A non-default SSH port goes in its OWN key — never inside the target:\n\n` +
			`  ${PORT_KEY}=22`,
	);
}

// The target must be a bare `[user@]host:/path`. Anything else — a flag folded
// in, a stray quote — reaches rsync as one argument and fails with an opaque
// "invalid option". Catching it here costs nothing and explains itself.
if (/\s/.test(target.trim()) || target.trim().startsWith('-')) {
	const embeddedPort = target.match(/-p\s*(\d+)/);
	die(
		`${TARGET_KEY} must be just \`[user@]host:/path\`, with no flags or spaces.`,
		`Got: ${target}\n\n` +
			(embeddedPort
				? `That looks like an SSH port folded into the target. It cannot go there — this\n` +
					`script passes the target to rsync as a SINGLE argument, and rsync's own -p means\n` +
					`"preserve permissions", not a port. Split them:\n\n` +
					`  ${TARGET_KEY}="${target.replace(/-p\s*\d+\s*/, '').trim()}"\n` +
					`  ${PORT_KEY}=${embeddedPort[1]}\n`
				: `Use two keys: ${TARGET_KEY} for [user@]host:/path, ${PORT_KEY} for a port.`),
	);
}
if (!/^[^\s:]+:\/.+/.test(target.trim())) {
	die(
		`${TARGET_KEY} does not look like a remote path.`,
		`Got: ${target}\nExpected \`[user@]host:/absolute/path\`, e.g.\n` +
			`  dedalo_dev@dedalo.dev:/home/www/vhosts/dedalo.dev/httpdocs/docs`,
	);
}
if (target.includes(`/${VERSION}`)) {
	die(
		`${TARGET_KEY} must be the docs ROOT, not the version directory.`,
		`Got: ${target}\nThe script appends /${VERSION}/ itself. Including it here would publish to\n` +
			`.../${VERSION}/${VERSION}/ and leave the real tree stale.`,
	);
}

// Validated above; bind it so the narrowing survives into the upload helper.
const DEST: string = target.trim();

const port = readEnv(PORT_KEY)?.trim();
if (port && !/^\d+$/.test(port)) {
	die(`${PORT_KEY} must be a bare number.`, `Got: ${port}`);
}

/**
 * Validated HERE, at step 0, and used at the very end. A misconfigured mirror
 * must stop the run before it uploads — discovering the typo after the site is
 * live would mean either a failed command that already published, or a silent
 * skip that leaves the preview stale, and both are worse than refusing early.
 */
const STAGE_DIR = readEnv(STAGE_KEY)?.trim();
if (STAGE_DIR) {
	if (!STAGE_DIR.startsWith('/')) {
		die(`${STAGE_KEY} must be an absolute path.`, `Got: ${STAGE_DIR}`);
	}
	if (!existsSync(STAGE_DIR)) {
		die(
			`${STAGE_KEY} points at a directory that does not exist.`,
			`Got: ${STAGE_DIR}\n\nCreate it first, or remove the key. The script will not create a\n` +
				`docs root on its own: a typo would silently build a tree nobody serves.`,
		);
	}
	if (STAGE_DIR.endsWith(`/${VERSION}`)) {
		die(
			`${STAGE_KEY} must be the docs ROOT, not the version directory.`,
			`Got: ${STAGE_DIR}\nThe script appends /${VERSION} itself.`,
		);
	}
	// Mirroring onto the build output would have rsync --delete eat its own source.
	if (resolve(STAGE_DIR) === resolve(SITE_DIR) || resolve(STAGE_DIR) === resolve(DOCS_DIR)) {
		die(
			`${STAGE_KEY} may not point inside this repo's own docs or build tree.`,
			`Got: ${STAGE_DIR}`,
		);
	}
}

// ---------------------------------------------------------------------------
// 1. CONTENT GATE
// ---------------------------------------------------------------------------
console.log('[1/4] Content gates…');
// TEST_TIMEOUT_FLAG, not a bare `bun test`: Bun 1.4.0 silently ignores bunfig's
// [test] timeout, so a flagless run reverts to the built-in 5000 ms cap — and
// these gates walk the whole manual. Imported from the one source of truth
// (scripts/lib/test_flags.ts), which test_timeout_tripwire holds every site to.
const content =
	await $`bun test ${TEST_TIMEOUT_FLAG} test/unit/docs_current_engine_tripwire.test.ts test/unit/docs_versioning_tripwire.test.ts test/unit/change_log_tripwire.test.ts`
		.cwd(REPO_ROOT)
		.nothrow()
		.quiet();
if (content.exitCode !== 0) {
	die('the docs content gates are red.', content.stderr.toString() + content.stdout.toString());
}
console.log('      ✓ manual documents the current engine; version wiring agrees\n');

// ---------------------------------------------------------------------------
// 2. BUILD GATE
// ---------------------------------------------------------------------------
console.log('[2/4] mkdocs build --strict…');
const mkdocs = existsSync(join(REPO_ROOT, '.venv/bin/mkdocs'))
	? join(REPO_ROOT, '.venv/bin/mkdocs')
	: 'mkdocs';
const build = await $`${mkdocs} build --strict`
	.cwd(REPO_ROOT)
	.env({ ...process.env, DISABLE_MKDOCS_2_WARNING: 'true' })
	.nothrow()
	.quiet();
if (build.exitCode !== 0) {
	const out = build.stderr.toString() + build.stdout.toString();
	die(
		'the site build failed.',
		/command not found|No such file/i.test(out)
			? `The docs toolchain is not installed. From the repo root:\n\n` +
					`  python3 -m venv .venv\n` +
					`  .venv/bin/pip install -r docs/requirements.txt\n\n` +
					`The pins in docs/requirements.txt are what CI and every developer share.`
			: out,
	);
}
if (!existsSync(join(SITE_DIR, 'index.html'))) {
	die('mkdocs reported success but docs_site/index.html does not exist.');
}
console.log('      ✓ every internal link resolves; site built\n');

// ---------------------------------------------------------------------------
// 3. UPLOAD
// ---------------------------------------------------------------------------
console.log(`[3/4] Uploading to ${DEST}/${VERSION}/ …`);

// A non-default SSH port travels as `-e "ssh -p N"`. It CANNOT ride inside the
// target string: Bun's $ escapes each interpolation as ONE argument, so a target
// of `-p 22 user@host:/path` reaches rsync as a single token and it reports
// `invalid option`. (rsync's own -p means "preserve permissions" — nothing to do
// with ports — so even unquoted it would be wrong.)
const sshTransport = port ? ['-e', `ssh -p ${port}`] : [];

/**
 * Run one rsync with the terminal ATTACHED.
 *
 * stdio is inherited rather than captured, for two reasons that only show up on
 * a real server: ssh asks for a key passphrase or a password on the TTY, and a
 * captured stdin means that prompt is never seen and the publish appears to
 * hang or fail for no reason. Inheriting also lets rsync print its own progress
 * and its own error text, which is better than anything this script could
 * paraphrase.
 */
async function rsync(args: string[], what: string): Promise<void> {
	const proc = Bun.spawn(['rsync', '-az', ...sshTransport, ...args], {
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	});
	const code = await proc.exited;
	if (code !== 0) {
		die(
			`${what} failed (rsync exit ${code}). Its output is above.`,
			code === 255 || code === 12
				? `That is usually the SSH layer, not rsync: an unknown host key, or an account\n` +
						`that cannot authenticate.\n\n` +
						`This publish should not depend on typing a password. Install your key once:\n\n` +
						`  ssh-copy-id${port ? ` -p ${port}` : ''} ${DEST.split(':')[0]}\n\n` +
						`If the host key itself is unknown, connect by hand once and verify it:\n\n` +
						`  ssh${port ? ` -p ${port}` : ''} ${DEST.split(':')[0]}`
				: undefined,
		);
	}
}

/**
 * Copy into the optional local mirror. Same rsync, no SSH transport.
 *
 * `--delete` is used for the version TREE (dest must end up an exact copy, with
 * files deleted upstream disappearing here too) and not for single files.
 */
async function localMirror(dest: string, src: string, tree = true): Promise<void> {
	const args = tree ? ['-a', '--delete', src, `${dest}/`] : ['-a', src, dest];
	const proc = Bun.spawn(['rsync', ...args], {
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	});
	const code = await proc.exited;
	if (code !== 0) {
		// The site is already live at this point; say so, so nobody reads this as
		// a failed publish and re-runs it thinking nothing shipped.
		die(
			`the upload SUCCEEDED but mirroring to ${STAGE_KEY} failed (rsync exit ${code}).`,
			`https://dedalo.dev/docs/${VERSION}/ is live and correct. Only the local copy at\n` +
				`${STAGE_DIR} is stale. Fix the path or unset ${STAGE_KEY}; re-running is safe.`,
		);
	}
}

// Trailing slash on the source: copy the CONTENTS of docs_site, not the
// directory itself. --delete is scoped to this version's prefix, so no other
// version's tree is reachable from here.
await rsync(
	['--delete', '--human-readable', `${SITE_DIR}/`, `${DEST}/${VERSION}/`],
	'the v7 upload',
);

// The switcher index and the routing rules live at the docs ROOT, beside the
// version trees rather than inside one. Both are small and idempotent.
//
// Each goes in its own call with a FULL destination path, because that is how
// rsync renames in flight — which is what lets `htaccess` land as `.htaccess`
// without a second ssh session to `mv` it. One less remote command, one less
// way for a non-default port or a restricted shell to break the publish.
await rsync([join(DOCS_DIR, 'versions.json'), `${DEST}/versions.json`], 'uploading versions.json');
await rsync(
	[join(REPO_ROOT, 'deploy/docs/htaccess'), `${DEST}/.htaccess`],
	'uploading the routing .htaccess',
);
console.log('      ✓ v7 tree, versions.json and routing uploaded');

// Optional local mirror, refreshed from the SAME tree that just went up, so a
// preview folder cannot quietly fall behind production. Last, and only after
// the upload succeeded: the server is what matters, and a local copy that is
// newer than the site is the exact drift this exists to prevent.
if (STAGE_DIR) {
	await localMirror(join(STAGE_DIR, VERSION), `${SITE_DIR}/`);
	await localMirror(join(STAGE_DIR, 'versions.json'), join(DOCS_DIR, 'versions.json'), false);
	// NOTE: deploy/docs/htaccess is deliberately NOT staged. Its rules are
	// absolute (/docs/v6/, /docs/v7/), which is right on dedalo.dev and WRONG
	// under a local prefix like /web_dedalo/docs/ — there it would 301 previews
	// out of the staging tree and into 404s. A local preview needs no routing:
	// the switcher and the banner use relative links and work at any prefix.
	console.log(`      ✓ mirrored to ${STAGE_DIR} (no .htaccess — see the note in this script)`);
}
console.log('');

// ---------------------------------------------------------------------------
// 4. RECORD what is now served
// ---------------------------------------------------------------------------
const manifest = {
	_comment: JSON.parse(readFileSync(MANIFEST, 'utf8'))._comment,
	published_at: new Date().toISOString().slice(0, 10),
	paths: publishedPagePaths(REPO_ROOT),
};
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[4/4] Recorded ${manifest.paths.length} published paths in docs/published_paths.json`);
console.log('      COMMIT THIS FILE — it is what makes the rename gate real.\n');

console.log(`✓ Live: https://dedalo.dev/docs/${VERSION}/\n`);
