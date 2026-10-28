/**
 * Media protection, Rule A (src/core/media/protection.ts) — the behavior gate.
 *
 * Covers the mode resolver, the public-quality hard filter, the generated rule text for
 * every mode, the config-hash idempotency guard, and the auth-marker/cookie lifecycle.
 *
 * Everything runs against a per-test temp dir through the guarded
 * overrideMediaProtectionPathsForTests seam (it REFUSES non-temp paths), so a test can
 * never write to the real media tree — a stray syncAuthMarkers() against the live store
 * would rotate out every real marker and 404 every logged-in user's media until they
 * logged in again.
 *
 * The lockstep between the three enforcement surfaces is a separate, registered tripwire:
 * media_protection_tripwire.test.ts.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as protection from '../../src/core/media/protection.ts';
import {
	buildHtaccess,
	buildNginxConf,
	dropAuthMarker,
	filterPublicQualities,
	getAddonLines,
	getConfigHash,
	getDefaultPublicQualities,
	getPublicQualities,
	getRulesStatus,
	issueSessionMediaKey,
	layAuthMarker,
	MARKER_REAP_GRACE_MS,
	MEDIA_AUTH_COOKIE,
	MEDIA_WORKING_FILE_EXTENSIONS,
	mediaTreeUnreachableReason,
	mintAuthCookieValue,
	overrideMediaProtectionPathsForTests,
	reconcileAuthMarkers,
	resolveMediaAccessMode,
	retireLegacyAuthStore,
	ruleFilePaths,
	syncAuthMarkers,
	writeRuleFiles,
} from '../../src/core/media/protection.ts';
import { getServerState, setServerState } from '../../src/core/resolve/server_state.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';

let scratch: string;
let mediaRoot: string;
let authStore: string;

const HEX_A = 'a'.repeat(128);
const HEX_B = 'b'.repeat(128);

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), 'dedalo_media_prot_'));
	mediaRoot = join(scratch, 'media');
	authStore = join(scratch, 'private', 'media_auth.json');
	// DECLARE the scratch media root — media_protection.mediaRoot() refuses an
	// unmarked one under the test-media seam (src/core/media/test_media_root.ts).
	markMediaRoot(mediaRoot);
	overrideMediaProtectionPathsForTests({ mediaRoot, authStorePath: authStore });
	// DEDALO_TS_STATE_PATH already points at a per-run scratch file (test/preload), so
	// touching the override here can never reach the live server state.
	setServerState({ media_access_mode: null });
});

afterEach(() => {
	setServerState({ media_access_mode: null });
	overrideMediaProtectionPathsForTests(null);
	rmSync(scratch, { recursive: true, force: true });
});

describe('the test seam refuses to touch a real media tree', () => {
	test('a non-temp path is rejected outright', () => {
		expect(() =>
			overrideMediaProtectionPathsForTests({
				mediaRoot: '/var/www/dedalo/media',
				authStorePath: '/tmp/x/media_auth.json',
			}),
		).toThrow(/temp-dir paths/);
		// restore the scratch override the beforeEach installed
		overrideMediaProtectionPathsForTests({ mediaRoot, authStorePath: authStore });
	});
});

describe('mode resolution', () => {
	test('the ts_state override wins over the .env layer', () => {
		setServerState({ media_access_mode: 'publication' });
		expect(resolveMediaAccessMode()).toBe('publication');
	});

	test('an explicit `false` override is OFF — it does NOT fall through to .env', () => {
		// The nastiest bug in the resolver: writing `override ?? configValue` is correct,
		// but `override || configValue` would flip an operator's explicit OFF back on, and
		// the reverse mistake would silently disable a configured install. Pin both.
		setServerState({ media_access_mode: false });
		expect(resolveMediaAccessMode()).toBe(false);
	});

	test('null means "no override" — the .env layer decides', () => {
		setServerState({ media_access_mode: null });
		// The catalog value is whatever this test env configures; the contract under test
		// is only that a null override defers to it rather than forcing false.
		const { config } = require('../../src/config/config.ts');
		expect(resolveMediaAccessMode()).toBe(config.features.mediaAccessMode);
	});

	test('a garbage override value fails CLOSED to false, never to a mode', () => {
		setServerState({ media_access_mode: 'publicaton' as unknown as 'publication' });
		expect(resolveMediaAccessMode()).toBe(false);
	});

	test('the resolver is never memoized — a mode change is visible immediately', () => {
		// This Bun process lives for weeks. A module-level cache here would make the
		// widget report success while the server kept serving the old mode until restart.
		setServerState({ media_access_mode: 'private' });
		expect(resolveMediaAccessMode()).toBe('private');
		setServerState({ media_access_mode: 'publication' });
		expect(resolveMediaAccessMode()).toBe('publication');
	});
});

describe('public qualities (rule B folder allowlist)', () => {
	test('defaults are DERIVED from the install quality catalog', () => {
		const defaults = getDefaultPublicQualities();
		expect(defaults).toContain('image/thumb');
		expect(defaults).toContain('av/posterframe');
		expect(defaults).toContain('pdf/web');
		// rich-text images: rule B gates their record-keyed names (TODO-066)
		expect(defaults).toContain('image/web');
		// masters are never in the default set
		expect(defaults).not.toContain('image/original');
		expect(defaults).not.toContain('image/modified');
	});

	test('master/work qualities are refused even when explicitly configured', () => {
		// The single worst config mistake: publishing the masters. 16-32 GB source files,
		// anonymously. The filter must beat the configuration, not defer to it.
		expect(
			filterPublicQualities([
				'original',
				'image/original',
				'image/modified',
				'foo/original/bar',
				'image/thumb',
			]),
		).toEqual(['image/thumb']);
	});

	test('master tiers are refused in ANY letter case (case-insensitive storage)', () => {
		// On APFS/SMB/NTFS `image/ORIGINAL/` IS `image/original/`: a case-sensitive
		// compare would let the rule allowlist the master folder and serve it anonymously.
		expect(
			filterPublicQualities([
				'image/ORIGINAL',
				'image/Original',
				'image/MODIFIED',
				'av/oRiGiNaL',
				'Foo/Modified/bar',
				'image/thumb',
			]),
		).toEqual(['image/thumb']);
		for (const quality of ['ORIGINAL', 'Original', 'MODIFIED', '/Modified/']) {
			expect(protection.isMasterQuality(quality)).toBe(true);
		}
		expect(protection.isMasterQuality('thumb')).toBe(false);
	});

	test('a configured custom master name is refused in any case, either side', () => {
		// config.media is frozen at import, so the custom name is configured in a child
		// process. Configured mixed-case, probed upper and lower: both sides normalize.
		const probe = `const p = await import('./src/core/media/protection.ts');
console.log(JSON.stringify({
	filtered: p.filterPublicQualities(['image/ARCHIVO', 'image/archivo', 'image/Archivo', 'image/thumb']),
	master: ['ARCHIVO', 'archivo'].map((q) => p.isMasterQuality(q)),
}));`;
		const run = Bun.spawnSync(['bun', '-e', probe], {
			cwd: join(import.meta.dir, '..', '..'),
			env: { ...process.env, DEDALO_IMAGE_QUALITY_ORIGINAL: 'Archivo' },
		});
		expect(run.exitCode).toBe(0);
		const lines = run.stdout.toString().trim().split('\n');
		const out = JSON.parse(lines[lines.length - 1] ?? '{}');
		expect(out).toEqual({ filtered: ['image/thumb'], master: [true, true] });
	}, 30_000);

	test('traversal and hostile charsets are refused', () => {
		expect(
			filterPublicQualities(['image/../../etc', '..', 'image/1.5MB;rm -rf /', 'image/thumb', '']),
		).toEqual(['image/thumb']);
	});

	test('the live list never contains a master quality, whatever the config says', () => {
		for (const quality of getPublicQualities()) {
			expect(quality.split('/')).not.toContain('original');
			expect(quality.split('/')).not.toContain('modified');
		}
	});
});

describe('the generated Apache rules', () => {
	test("mode 'off' keeps the hardening but adds NO access gate", () => {
		// If 'off' ever UNLINKS the rule file instead of writing this, the media root —
		// full of user-uploaded files — becomes a directory where Apache will execute an
		// uploaded .php. That is an RCE, not a permissions nit.
		const text = buildHtaccess('off');
		expect(text).toContain('Require all denied');
		expect(text).toContain('Options -Indexes -ExecCGI');
		// The marker store stays denied even with protection off (auth/ filenames are live
		// credentials), but nothing GATES media access:
		expect(text).toContain('\\.publication');
		expect(text).not.toContain(MEDIA_AUTH_COOKIE);
		expect(text).not.toContain('/.publication/pub/');
		expect(text).not.toContain('RewriteRule ^ - [R=404,L]'); // no default deny
	});

	test('MEDIA_HTACCESS_ADDONS is JSON-only — a bad value must never reach the file', () => {
		// These are RAW Apache directives, and a directive legitimately contains commas
		// (`[R=404,L]`). A comma-list reader (readListEnv) falls back to comma-splitting the
		// moment JSON.parse throws — which it does on the natural single-escaped regex
		// `^10\.0\.` — shredding ONE directive into two garbage lines and writing them
		// verbatim into a live .htaccess, which 500s the whole media directory.
		// The reader must refuse and fall back to [] instead.
		const { config } = require('../../src/config/config.ts');
		expect(Array.isArray(config.media.htaccessAddons)).toBe(true);

		// Whatever is configured, every emitted addon line must be a directive we were
		// actually given — never a fragment carrying JSON punctuation.
		for (const line of getAddonLines()) {
			expect(line).not.toStartWith('[');
			expect(line).not.toStartWith('"');
			expect(line).not.toEndWith(']');
		}
	});

	test('addon lines land verbatim, immediately before the default deny', () => {
		const text = buildHtaccess('private', [], ['RewriteRule ^ - [R=404,L]']);
		expect(text).toContain('# MEDIA_HTACCESS_ADDONS (from config)');
		// the comma inside [R=404,L] survives intact — the whole point
		expect(text).toContain('RewriteRule ^ - [R=404,L]');
	});

	test("mode 'private' gates on the auth cookie and denies everything else as 404", () => {
		const text = buildHtaccess('private');
		expect(text).toContain(`${MEDIA_AUTH_COOKIE}=([a-f0-9]{128})`);
		expect(text).toContain('/.publication/auth/%1" -f');
		expect(text).toContain('RewriteRule (^|/)\\.publication(/|$) - [R=404,L]');
		// 404, never 403: the existence of unpublished media is not disclosed.
		expect(text).toContain('RewriteRule ^ - [R=404,L]');
		expect(text).not.toContain('/.publication/pub/');
	});

	test("mode 'publication' adds the pub-marker rule with the $1_$2 backreference", () => {
		const text = buildHtaccess('publication', ['image/thumb']);
		// THE documented real bug: %1 would reference rule A's last RewriteCond capture,
		// not this rule's. It must be $1_$2, and the RewriteRule must immediately follow.
		expect(text).toContain('/.publication/pub/$1_$2" -f');
		expect(text).not.toContain('%1_%2');
		const lines = text.split('\n');
		const condIndex = lines.findIndex((line) => line.includes('/.publication/pub/$1_$2'));
		expect(lines[condIndex + 1]).toStartWith('RewriteRule ^(?:');
	});

	test('quality folders are regex-escaped in the alternation', () => {
		// Unescaped, `image/1.5MB` also matches `image/1x5MB`.
		const text = buildHtaccess('publication', ['image/1.5MB']);
		expect(text).toContain('image/1\\.5MB');
	});
});

describe('the generated nginx rules', () => {
	test('the rule-A location is a PLAIN prefix, never ^~', () => {
		// `^~` on the catch-all makes nginx stop before ever consulting the rule-B regex
		// location, and every anonymous request for published media 404s.
		const text = buildNginxConf('publication', ['image/thumb']);
		expect(text).toContain('location /dedalo/media/ {');
		expect(text).not.toContain('location ^~ /dedalo/media/ {');
	});

	test('the marker store is denied with ^~ so no regex can reach it', () => {
		expect(buildNginxConf('private')).toContain('location ^~ /dedalo/media/.publication/');
	});

	test('rule B uses NAMED captures (the inner `if` resets numeric ones)', () => {
		const text = buildNginxConf('publication', ['image/thumb']);
		expect(text).toContain('(?<dd_s>[a-z0-9]+)');
		expect(text).toContain('(?<dd_i>[0-9]+)');
		expect(text).toContain('pub/${dd_s}_${dd_i}');
	});

	test('the SEC-088 script block is emitted in EVERY mode, including off', () => {
		for (const mode of ['off', 'private', 'publication'] as const) {
			expect(buildNginxConf(mode, ['image/thumb'])).toContain('phps?|phtml|phar');
		}
	});

	test('working files (F2) are denied as 404 in EVERY mode, before rule B', () => {
		const deny = `location ~* ^/dedalo/media/.+\\.(${MEDIA_WORKING_FILE_EXTENSIONS.join('|')})$ {\n\tdeny all;\n\treturn 404;\n}`;
		for (const mode of ['off', 'private', 'publication'] as const) {
			const text = buildNginxConf(mode, ['image/thumb']);
			expect(text).toContain(deny);
			if (mode === 'publication') {
				expect(text.indexOf(deny)).toBeLessThan(text.indexOf('location ~ "^'));
			}
		}
	});
});

describe('the config-hash idempotency guard', () => {
	test('identical inputs produce identical bytes', () => {
		expect(buildHtaccess('private')).toBe(buildHtaccess('private'));
	});

	test('the hash changes with the mode and with the quality list', () => {
		const a = getConfigHash('private', [], []);
		const b = getConfigHash('publication', [], []);
		const c = getConfigHash('publication', ['image/thumb'], []);
		expect(a).not.toBe(b);
		expect(b).not.toBe(c);
	});

	test('writeRuleFiles rewrites only when the config actually changed', () => {
		setServerState({ media_access_mode: 'private' });
		writeRuleFiles();
		const paths = ruleFilePaths();
		expect(paths).not.toBeNull();
		if (paths === null) return;

		const firstWrite = statSync(paths.htaccess).mtimeMs;
		const firstText = readFileSync(paths.htaccess, 'utf8');
		expect(firstText).toContain('# config-hash: ');

		// Same config → no rewrite at all (the normal login path is a no-op).
		writeRuleFiles();
		expect(statSync(paths.htaccess).mtimeMs).toBe(firstWrite);

		// Changed config → rewritten.
		writeRuleFiles('publication');
		expect(readFileSync(paths.htaccess, 'utf8')).not.toBe(firstText);
	});

	test('an .htaccess ADDON never makes the nginx conf permanently stale', () => {
		// MEDIA_HTACCESS_ADDONS is Apache syntax and reaches the .htaccess only —
		// buildNginxConf never sees it. Both files used to be judged by the
		// addons-INCLUSIVE hash, so the moment an install configured any addon the
		// nginx conf could never match: rewritten on every login, and reported
		// "out of date" forever by the media_control widget. A permanent false
		// alarm is how operators learn to ignore the widget.
		setServerState({ media_access_mode: 'private' });
		// The addons are INJECTED, not set in process.env: config.media is frozen at
		// import (src/config/config.ts), so an env write here changes nothing.
		const addons = spyOn(protection, 'getAddonLines').mockReturnValue([
			'<IfModule mod_headers.c>',
			'\tHeader always set Access-Control-Allow-Origin "http://app.example.org"',
			'</IfModule>',
		]);
		try {
			writeRuleFiles();
			const paths = ruleFilePaths();
			expect(paths).not.toBeNull();
			if (paths === null) return;

			// The addon reached the file it belongs in, and only that one.
			expect(readFileSync(paths.htaccess, 'utf8')).toContain('Access-Control-Allow-Origin');
			expect(readFileSync(paths.nginx, 'utf8')).not.toContain('Access-Control-Allow-Origin');

			// BOTH report up to date, and a second run rewrites neither.
			const status = getRulesStatus();
			expect(status.htaccess.up_to_date).toBe(true);
			expect(status.nginx.up_to_date).toBe(true);

			const nginxWrite = statSync(paths.nginx).mtimeMs;
			writeRuleFiles();
			expect(statSync(paths.nginx).mtimeMs).toBe(nginxWrite);
		} finally {
			addons.mockRestore();
		}
	});

	test('getRulesStatus reports up_to_date honestly', () => {
		setServerState({ media_access_mode: 'private' });
		writeRuleFiles();
		expect(getRulesStatus().htaccess.up_to_date).toBe(true);

		// Simulate a config drift: the file on disk carries another mode's hash.
		const paths = ruleFilePaths();
		if (paths === null) throw new Error('media root not configured');
		writeFileSync(paths.htaccess, '# config-hash: stale\n');
		expect(getRulesStatus().htaccess.up_to_date).toBe(false);
	});
});

describe('the auth markers (rule A)', () => {
	test('markers are laid for the valid values and stale ones are rotated out', () => {
		const authDir = join(mediaRoot, '.publication', 'auth');
		mkdirSync(authDir, { recursive: true });
		writeFileSync(join(authDir, 'c'.repeat(128)), ''); // yesterday's yesterday

		syncAuthMarkers([HEX_A, HEX_B]);

		expect(readdirSync(authDir).sort()).toEqual([HEX_A, HEX_B].sort());
	});

	test('anything that is not sha512 hex is refused — the value becomes a FILENAME', () => {
		// This is the path-traversal guard. A loosened pattern here lets a crafted cookie
		// stat any file on the box.
		syncAuthMarkers([
			'../../../etc/passwd',
			'..',
			'',
			'abc',
			'A'.repeat(128), // uppercase
			'g'.repeat(128), // non-hex
			'a'.repeat(127), // one short
			HEX_A,
		]);
		const authDir = join(mediaRoot, '.publication', 'auth');
		expect(readdirSync(authDir)).toEqual([HEX_A]);
		expect(existsSync(join(scratch, 'etc'))).toBe(false);
	});

	test('the auth marker dir is not world-readable (its filenames ARE credentials)', () => {
		syncAuthMarkers([HEX_A]);
		const mode = statSync(join(mediaRoot, '.publication', 'auth')).mode & 0o777;
		expect(mode & 0o007).toBe(0);
	});

	test('minted values match the pattern the web server validates, and are unique', () => {
		const values = new Set(Array.from({ length: 50 }, () => mintAuthCookieValue()));
		expect(values.size).toBe(50);
		for (const value of values) expect(value).toMatch(/^[a-f0-9]{128}$/);
	});
});

describe('the login hook (issueSessionMediaKey)', () => {
	test('mode false is a TOTAL no-op: no cookie, no markers, no rule files', () => {
		setServerState({ media_access_mode: false });
		expect(issueSessionMediaKey()).toBeNull();
		expect(existsSync(join(mediaRoot, '.publication'))).toBe(false);
		expect(existsSync(join(mediaRoot, '.htaccess'))).toBe(false);
	});

	test("mode 'private' mints a key, lays its marker and writes the rules", () => {
		setServerState({ media_access_mode: 'private' });
		const value = issueSessionMediaKey();
		expect(value).toMatch(/^[a-f0-9]{128}$/);
		if (value === null) return;
		expect(existsSync(join(mediaRoot, '.publication', 'auth', value))).toBe(true);
		expect(existsSync(join(mediaRoot, '.htaccess'))).toBe(true);
	});

	test('every login mints a DISTINCT key, and neither displaces the other', () => {
		// This is the whole change (2026-08-24). The value used to be one per INSTALL per
		// DAY, so a second login recycled it — which is also why logging out could not
		// revoke anything: unlinking the shared marker would have logged every other
		// editor out of the media tree, so nothing was unlinked and a stolen cookie
		// stayed valid for up to ~48 hours. Two sessions must now hold two credentials.
		setServerState({ media_access_mode: 'private' });
		const first = issueSessionMediaKey();
		const second = issueSessionMediaKey();
		expect(second).not.toBe(first);
		const authDir = join(mediaRoot, '.publication', 'auth');
		expect(existsSync(join(authDir, String(first)))).toBe(true);
		expect(existsSync(join(authDir, String(second)))).toBe(true);
	});

	test('laying a marker never disturbs another session marker', () => {
		// layAuthMarker, not syncAuthMarkers: the latter unlinks everything it was not
		// given, which is right for a reconcile and catastrophic for a login.
		setServerState({ media_access_mode: 'private' });
		const keys = [issueSessionMediaKey(), issueSessionMediaKey(), issueSessionMediaKey()];
		expect(readdirSync(join(mediaRoot, '.publication', 'auth'))).toHaveLength(3);
		for (const key of keys) expect(key).toMatch(/^[a-f0-9]{128}$/);
	});

	test('dropAuthMarker revokes ONE credential and leaves the rest', () => {
		setServerState({ media_access_mode: 'private' });
		const doomed = issueSessionMediaKey();
		const survivor = issueSessionMediaKey();
		if (doomed === null || survivor === null) return;
		dropAuthMarker(doomed);
		const authDir = join(mediaRoot, '.publication', 'auth');
		expect(existsSync(join(authDir, doomed))).toBe(false);
		expect(existsSync(join(authDir, survivor))).toBe(true);
	});

	test('dropAuthMarker never builds a path from an unvetted value', () => {
		// The value is a literal FILENAME, so the hex grammar is the traversal guard.
		setServerState({ media_access_mode: 'private' });
		const survivor = issueSessionMediaKey();
		expect(() => {
			dropAuthMarker('../../../etc/passwd');
		}).not.toThrow();
		if (survivor === null) return;
		expect(existsSync(join(mediaRoot, '.publication', 'auth', survivor))).toBe(true);
	});

	test('reconcileAuthMarkers keeps the live keys and collects orphans', () => {
		setServerState({ media_access_mode: 'private' });
		const live = issueSessionMediaKey();
		const orphan = issueSessionMediaKey();
		if (live === null || orphan === null) return;
		const authDir = join(mediaRoot, '.publication', 'auth');
		// AGE THE ORPHAN past the login-in-flight grace. A marker laid milliseconds ago
		// is indistinguishable from a login between `layAuthMarker` and its session
		// INSERT, and the reconcile deliberately declines to guess — see the next test.
		const old = (Date.now() - MARKER_REAP_GRACE_MS * 2) / 1000;
		utimesSync(join(authDir, orphan), old, old);
		reconcileAuthMarkers([live]);
		expect(existsSync(join(authDir, live))).toBe(true);
		expect(existsSync(join(authDir, orphan))).toBe(false);
	});

	test('a reconcile landing MID-LOGIN does not unlink the in-flight marker', () => {
		// THE RACE (2026-08-28): `login()` lays this session's marker BEFORE inserting
		// the session row, and awaits a database round-trip in between. The hourly
		// sweeper (SEC-09) can land in that window, where the marker is backed by no
		// live session and looks exactly like an orphan. Unlinking it logs a user who
		// just authenticated out of the entire media tree, silently, until they log in
		// again. Not hypothetical once the sweep became automatic: it was operator-
		// triggered when this ordering was chosen.
		setServerState({ media_access_mode: 'private' });
		const inFlight = issueSessionMediaKey(); // marker laid; no session row yet
		if (inFlight === null) return;
		reconcileAuthMarkers([]); // ... the sweep runs, and the store knows nothing
		expect(existsSync(join(mediaRoot, '.publication', 'auth', inFlight))).toBe(true);

		// And the grace only DELAYS collection — pass 0 and it is an orphan like any
		// other, which is what proves the marker is not permanently exempt.
		reconcileAuthMarkers([], 0);
		expect(existsSync(join(mediaRoot, '.publication', 'auth', inFlight))).toBe(false);
	});

	test('the retired day-global auth store is moved aside, not left on disk', () => {
		// It held INSTALL-WIDE cookie values. Dead credentials still on disk are what
		// get restored from a backup years later.
		mkdirSync(dirname(authStore), { recursive: true });
		writeFileSync(authStore, '{"2026_08_08":{"cookie_name":"x","cookie_value":"y"}}');
		retireLegacyAuthStore();
		expect(existsSync(authStore)).toBe(false);
		expect(existsSync(`${authStore}.migrated`)).toBe(true);
	});

	test('an UNREACHABLE media tree does not block login — it degrades, loudly', () => {
		// THE REPORT (2026-09-06): MEDIA_PATH pointed at an external volume that was not
		// mounted, so laying the auth marker died with EACCES on mkdir '/Volumes/…' and
		// the exception came out of login(). Nobody could sign in to read a TEXT record
		// because a disk of images was unplugged.
		//
		// The fail-loud rule is right, and it is about a DIFFERENT fault: a tree the web
		// server IS serving whose gate cannot be written would be served unprotected. A
		// tree that is not there is served to nobody — every media URL 404s at the web
		// server — so there is nothing to protect and no reason to refuse authentication.
		setServerState({ media_access_mode: 'private' });
		rmSync(mediaRoot, { recursive: true, force: true }); // the volume goes away
		expect(mediaTreeUnreachableReason()).toMatch(/cannot be reached \(ENOENT\)/);
		expect(issueSessionMediaKey()).toBeNull(); // no cookie, no throw
		expect(existsSync(mediaRoot)).toBe(false); // and nothing was created behind it
		// The other two writers degrade the same way, for the same reason: layAuthMarker
		// also runs per session on the authenticated hot path (server.ts
		// sessionMediaKeyFor) and syncAuthMarkers runs from the hourly session sweeper.
		expect(() => {
			layAuthMarker(HEX_A);
		}).not.toThrow();
		expect(() => {
			syncAuthMarkers([HEX_A]);
		}).not.toThrow();
		expect(writeRuleFiles()).toBe(false);
	});

	test('a root this process cannot STAT is not "absent" — it still fails LOUD', () => {
		// THE CONFLATION THE PROBE MUST NOT MAKE (found in adversarial review of the fix):
		// `MEDIA_PATH=/srv/media` under a `/srv` this process may not traverse answers
		// EACCES, not ENOENT — while the web server's own user traverses it perfectly well
		// and serves every file in the tree. Reading "any stat failure" as "the tree is
		// gone" would hide a world-readable media tree behind one console line. Only
		// ENOENT/ENOTDIR/ESTALE mean absent.
		setServerState({ media_access_mode: 'private' });
		if (process.getuid?.() === 0) return; // root traverses anything
		const parent = join(scratch, 'untraversable');
		const buried = markMediaRoot(join(parent, 'media'));
		overrideMediaProtectionPathsForTests({ mediaRoot: buried, authStorePath: authStore });
		chmodSync(parent, 0o000);
		try {
			expect(mediaTreeUnreachableReason()).toBeNull(); // EACCES is NOT absence
			expect(() => issueSessionMediaKey()).toThrow();
		} finally {
			chmodSync(parent, 0o700);
		}
	});

	test('a NOT-A-DIRECTORY root reads as absent (nothing is served from it)', () => {
		setServerState({ media_access_mode: 'private' });
		rmSync(mediaRoot, { recursive: true, force: true });
		writeFileSync(mediaRoot, 'a file where a tree should be');
		expect(mediaTreeUnreachableReason()).toMatch(/not a directory/);
		expect(issueSessionMediaKey()).toBeNull();
	});

	test('protection OFF + an absent tree writes nothing and says so QUIETLY', () => {
		// writeRuleFiles resolves the mode BEFORE probing the tree: an install that turned
		// protection off and unplugged its media disk must not get a boot-time error line
		// about files it never asked for. `true` = "nothing to do", not "written".
		setServerState({ media_access_mode: false });
		rmSync(mediaRoot, { recursive: true, force: true });
		expect(writeRuleFiles()).toBe(true);
	});

	test('a media root that EXISTS but cannot be written still fails LOUD', () => {
		// The other half of the distinction: this tree IS being served, so a gate that
		// cannot be written means unprotected media. Never degrade here.
		setServerState({ media_access_mode: 'private' });
		if (process.getuid?.() === 0) return; // root ignores the mode bits
		chmodSync(mediaRoot, 0o500); // readable, not writable
		try {
			expect(() => issueSessionMediaKey()).toThrow();
		} finally {
			chmodSync(mediaRoot, 0o700);
		}
	});

	test('a configured mode with no media root fails LOUD, never silently unprotected', () => {
		setServerState({ media_access_mode: 'private' });
		overrideMediaProtectionPathsForTests(null); // no MEDIA_PATH in this test env
		const { config } = require('../../src/config/config.ts');
		if (config.media.rootPath !== null) return; // a configured dev env: not applicable
		expect(() => issueSessionMediaKey()).toThrow(/MEDIA_PATH is not configured/);
	});
});

describe('server state round-trip', () => {
	test('the override persists and reads back', () => {
		setServerState({ media_access_mode: 'publication' });
		expect(getServerState().media_access_mode).toBe('publication');
	});
});
