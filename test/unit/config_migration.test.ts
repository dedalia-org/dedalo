/**
 * v6→v7 config migration: the PHP `define()` parser and the value mapping.
 *
 * The parser is the risky half — it reads a language we cannot execute (no `php`
 * binary exists in the TS world, and v6's config.php is a PROGRAM: it includes
 * class.loader.php and would boot the app). So every syntax form a real v6 config
 * uses is pinned here, including the two that decide whether a migration is
 * CORRECT or merely plausible:
 *
 *  - a LIST OF CONSTANTS (`[DEDALO_IMAGE_QUALITY_ORIGINAL, '100MB', …]`) must
 *    resolve. The PHP-side extractor this ports rejects it and silently degrades
 *    the value to "runtime" → dropped, losing every *_AR_QUALITY setting.
 *  - a RUNTIME value (`$_SERVER`, `dirname()`, a function call) must NOT resolve.
 *    Baking a guess would write a wrong path into the .env and look like it worked.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile } from '../../src/config/env.ts';
import { encodeEnvValue, V6_MIGRATION } from '../../src/config/migration_map.ts';
import { extractDefines } from '../../src/config/php_defines.ts';

const FIXTURE_DIR = join(import.meta.dir, '..', 'fixtures', 'v6_config');

const parse = (php: string) => extractDefines([{ path: 'test.php', content: `<?php\n${php}` }]);
const defineOf = (php: string, name: string) => parse(php).records.get(name);

describe('PHP define() parser — value forms', () => {
	test('scalars: string, int, float, bool, null', () => {
		const r = parse(`
			define('S', 'hello');
			define('I', 10);
			define('F', 1.5);
			define('B', true);
			define('N', null);
		`);
		expect(r.records.get('S')?.value).toBe('hello');
		expect(r.records.get('I')?.value).toBe(10);
		expect(r.records.get('F')?.value).toBe(1.5);
		expect(r.records.get('B')?.value).toBe(true);
		expect(r.records.get('N')?.value).toBe(null);
	});

	test('list literal, and the both-syntaxes array() form', () => {
		expect(defineOf("define('L', ['a','b']);", 'L')?.value).toEqual(['a', 'b']);
		expect(defineOf("define('L', array('a','b'));", 'L')?.value).toEqual(['a', 'b']);
		expect(defineOf("define('E', []);", 'E')?.value).toEqual([]);
	});

	test('string-keyed map, including non-ASCII values', () => {
		const v = defineOf("define('M', ['lg-eng'=>'English','lg-ell'=>'Ελληνικά']);", 'M');
		expect(v?.value).toEqual({ 'lg-eng': 'English', 'lg-ell': 'Ελληνικά' });
	});

	test('nested map', () => {
		const v = defineOf("define('N', [['name'=>'a','url'=>'u']]);", 'N');
		expect(v?.value).toEqual([{ name: 'a', url: 'u' }]);
	});

	test('constant cross-reference and string concatenation fold', () => {
		const r = parse(`
			define('BASE', '/srv');
			define('SUB', 'media');
			define('PATH', BASE . '/' . SUB);
			define('ALIAS', BASE);
		`);
		expect(r.records.get('PATH')?.value).toBe('/srv/media');
		expect(r.records.get('ALIAS')?.value).toBe('/srv');
	});

	test('LIST OF CONSTANTS resolves (the bug in the PHP original)', () => {
		const r = parse(`
			define('Q_ORIG', 'original');
			define('Q_THUMB', 'thumb');
			define('AR', [Q_ORIG, '100MB', Q_THUMB]);
		`);
		const ar = r.records.get('AR');
		expect(ar?.kind).toBe('literal');
		expect(ar?.value).toEqual(['original', '100MB', 'thumb']);
	});

	test('a $var assigned a literal resolves', () => {
		const r = parse(`
			$handler = 'files';
			define('H', $handler);
		`);
		expect(r.records.get('H')?.value).toBe('files');
	});

	test('RUNTIME values never resolve — and are never baked', () => {
		for (const [name, php] of [
			['SRV', "define('SRV', $_SERVER['HTTP_HOST']);"],
			['DIR', "define('DIR', dirname(__FILE__, 2));"],
			['FN', "define('FN', fix_cascade_config_var('x', 'y'));"],
			['TERN', "define('TERN', php_sapi_name()==='cli' ? 'a' : 'b');"],
			['UNK', "define('UNK', SOME_CONST_DEFINED_ELSEWHERE);"],
			['INTERP', 'define(\'INTERP\', "host-$x");'],
		] as const) {
			const rec = defineOf(php, name);
			expect(rec?.kind).toBe('runtime');
			expect(rec?.value).toBe(null);
		}
	});

	test('a define inside a branch is recorded but flagged conditional', () => {
		const r = parse(`
			if (!defined('SHOW_DEBUG')) {
				define('SHOW_DEBUG', true);
			}
			define('TOP', 1);
		`);
		expect(r.records.get('SHOW_DEBUG')?.conditional).toBe(true);
		expect(r.records.get('TOP')?.conditional).toBe(false);
	});

	test('PHP keeps the FIRST define; the redefinition is reported', () => {
		const r = parse(`
			define('X', 'first');
			define('X', 'second');
		`);
		expect(r.records.get('X')?.value).toBe('first');
		expect(r.duplicates).toContain('X');
	});

	test('comments are not code: a commented-out define is reported, never applied', () => {
		const r = parse(`
			// define('COMMENTED', 'nope');
			# define('HASHED', 'nope');
			define('REAL', 'yes');
		`);
		expect(r.records.has('COMMENTED')).toBe(false);
		expect(r.records.has('HASHED')).toBe(false);
		expect(r.commentedOut).toEqual(['COMMENTED', 'HASHED']);
		expect(r.records.get('REAL')?.value).toBe('yes');
	});

	test('a name both commented AND defined is not a "commented-out" default', () => {
		const r = parse(`
			// define('IP_API', ['url'=>'example']);
			define('IP_API', ['url'=>'real']);
		`);
		expect(r.commentedOut).toEqual([]);
		expect(r.records.get('IP_API')?.value).toEqual({ url: 'real' });
	});

	test('includes are seen and reported, never followed', () => {
		const r = parse("include dirname(__FILE__) . '/../private/config.inc';");
		expect(r.includes).toHaveLength(1);
		expect(r.includes[0]?.raw).toContain('config.inc');
		expect(r.records.size).toBe(0);
	});

	test('`include $path` names the file it skipped (the real v6 stub layout)', () => {
		// A real v6 config.php is:
		//     $path = dirname(dirname(dirname(__FILE__))) . '/private/config.inc';
		//     include $path;
		// The include statement mentions NO filename, so without resolving $path back
		// to its source the report could not tell the operator which file it skipped —
		// and they would get a silently empty migration.
		const r = parse(`
			$path = dirname(dirname(dirname(__FILE__))) . '/private/config.inc';
			include $path;
		`);
		expect(r.records.size).toBe(0);
		expect(r.includes).toHaveLength(1);
		expect(r.includes[0]?.raw).toContain('$path');
		expect(r.includes[0]?.raw).toContain('config.inc'); // the skipped file is NAMED
	});
});

describe('value encoding for the .env line format', () => {
	test('scalars, booleans and numbers', () => {
		expect(encodeEnvValue('x')).toBe('x');
		expect(encodeEnvValue(true)).toBe('true');
		expect(encodeEnvValue(false)).toBe('false');
		expect(encodeEnvValue(10)).toBe('10');
	});

	test('arrays and maps go out as JSON — the one encoding every v7 reader accepts', () => {
		expect(encodeEnvValue(['a', 'b'])).toBe('["a","b"]');
		expect(encodeEnvValue({ k: 'v' })).toBe('{"k":"v"}');
	});

	test('PHP null = "unset": the key is SKIPPED so the engine default stands', () => {
		expect(encodeEnvValue(null)).toBe(null);
		expect(encodeEnvValue(undefined)).toBe(null);
	});

	test('a JSON value with .env metacharacters survives a parseEnvFile round-trip', () => {
		// IP_API's value carries BOTH '#' and '$' — the reason config_persist writes
		// JSON raw rather than through envQuote.
		const value = encodeEnvValue({ href: 'https://ip-api.com/#$ip' }) as string;
		const round = parseEnvFile(`IP_API=${value}\n`);
		expect(JSON.parse(round.IP_API as string)).toEqual({ href: 'https://ip-api.com/#$ip' });
	});
});

describe('the mapping applied to a REAL v6 config (the vendored fixture)', () => {
	const files = ['config.php', 'config_db.php', 'config_areas.php', 'config_core.php'].map(
		(name) => ({ path: name, content: readFileSync(join(FIXTURE_DIR, name), 'utf8') }),
	);
	const extracted = extractDefines(files);

	test('the renamed key is emitted under its NEW name, never the retired one', () => {
		const rule = V6_MIGRATION.DEDALO_PREFIX_TIPOS;
		expect(rule?.cls).toBe('RENAMED');
		expect(rule?.target).toBe('ACTIVE_ONTOLOGY_TLDS');

		const record = extracted.records.get('DEDALO_PREFIX_TIPOS');
		expect(record?.kind).toBe('literal');
		expect(encodeEnvValue(record?.value)).toContain('"dd"');
	});

	test('the AR_QUALITY families survive (they are lists of constants)', () => {
		for (const key of [
			'DEDALO_IMAGE_AR_QUALITY',
			'DEDALO_AV_AR_QUALITY',
			'DEDALO_PDF_AR_QUALITY',
		]) {
			const record = extracted.records.get(key);
			expect(record?.kind).toBe('literal');
			expect(Array.isArray(record?.value)).toBe(true);
			expect((record?.value as unknown[]).length).toBeGreaterThan(1);
		}
	});

	test('binary paths are reshaped from a v6 DIRECTORY to a v7 executable path', () => {
		const rule = V6_MIGRATION.MAGICK_PATH;
		expect(rule?.target).toBe('DEDALO_MAGICK_PATH');
		expect(rule?.transform?.('/usr/bin/')).toBe('/usr/bin/magick');
		// an install that already points at the binary is left alone
		expect(rule?.transform?.('/opt/homebrew/bin/magick')).toBe('/opt/homebrew/bin/magick');
	});

	test('API_WEB_USER_CODE_MULTIPLE: real entries migrate, the stock placeholder does not', () => {
		const rule = V6_MIGRATION.API_WEB_USER_CODE_MULTIPLE;
		expect(rule?.cls).toBe('SAME');
		expect(rule?.target).toBe('API_WEB_USER_CODE_MULTIPLE');

		// the vendored stock config carries ONE empty placeholder → key skipped, so a
		// migrated install does not log "1 of 1 entries were DROPPED" on every boot
		const record = extracted.records.get('API_WEB_USER_CODE_MULTIPLE');
		expect(record?.kind).toBe('literal');
		expect(encodeEnvValue(rule?.transform?.(record?.value))).toBeNull();

		const real = { db_name: 'web_my_entity', code: 'abc', api_ui: null };
		const out = encodeEnvValue(rule?.transform?.([real, { db_name: '', code: '', api_ui: null }]));
		expect(JSON.parse(out as string)).toEqual([real]);
	});

	test('the MariaDB connection moves to the DEDALO_DIFFUSION_DB_* family', () => {
		expect(V6_MIGRATION.MYSQL_DEDALO_HOSTNAME_CONN?.target).toBe('DEDALO_DIFFUSION_DB_HOST');
		expect(V6_MIGRATION.MYSQL_DEDALO_PASSWORD_CONN?.target).toBe('DEDALO_DIFFUSION_DB_PASSWORD');
	});

	test('derived paths are DROPPED with a reason, never migrated as literals', () => {
		for (const key of ['DEDALO_ROOT_PATH', 'DEDALO_CORE_URL', 'DEDALO_API_URL']) {
			const rule = V6_MIGRATION[key];
			expect(rule?.cls).toBe('DROPPED');
			expect(rule?.reason).toBeTruthy();
		}
	});
});

describe('the .env writer MERGES (../private/.env is append-only)', () => {
	test('an existing key is never rewritten, and new keys are appended', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-mig-'));
		const target = join(dir, '.env');
		writeFileSync(target, '# operator notes\nENTITY=mine\nDB_HOST=db.internal\n');

		// The merge rule the CLI applies: skip keys already present, append the rest.
		const existing = parseEnvFile(readFileSync(target, 'utf8'));
		const planned = [
			{ key: 'ENTITY', value: 'from_v6' }, // already set — must NOT win
			{ key: 'DB_NAME', value: 'dedalo' }, // new — appended
		];
		const fresh = planned.filter((p) => !(p.key in existing));
		expect(fresh.map((f) => f.key)).toEqual(['DB_NAME']);

		const merged = `${readFileSync(target, 'utf8')}\n${fresh.map((f) => `${f.key}=${f.value}`).join('\n')}\n`;
		writeFileSync(target, merged);

		const after = parseEnvFile(readFileSync(target, 'utf8'));
		expect(after.ENTITY).toBe('mine'); // the operator's line stands
		expect(after.DB_HOST).toBe('db.internal');
		expect(after.DB_NAME).toBe('dedalo');
		expect(readFileSync(target, 'utf8')).toContain('# operator notes'); // comments kept
		expect(existsSync(target)).toBe(true);
	});
});
