/**
 * tool_uca_maps — `js/download_filename.js`, the one rule that turns a typed
 * download name into a safe one. A unit gate, not only a browser one, because
 * both sides run it: the client on `link.download`, `server/raster_download.ts`
 * in the envelope's `filename`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	DEFAULT_MAP_IMAGE_NAME,
	sanitize_download_name,
	with_extension,
} from '../../tools/tool_uca_maps/js/download_filename.js';

describe('tool_uca_maps download_filename — sanitize_download_name', () => {
	test('keeps a heritage-shaped name intact, accents and spaces included', () => {
		expect(sanitize_download_name('Necrópolis de Cádiz 1984')).toBe('Necrópolis de Cádiz 1984');
	});

	test('strips path separators instead of reducing to a basename', () => {
		// Fail-closed on the traversal shape: what comes back must not be a
		// path at all, and must not silently become the last segment either.
		expect(sanitize_download_name('../../etc/passwd')).toBe('etcpasswd');
		expect(sanitize_download_name('a\\b/c')).toBe('abc');
	});

	test('strips NUL, control characters and the names Windows refuses', () => {
		expect(sanitize_download_name('map\u0000\u001f\u007f')).toBe('map');
		expect(sanitize_download_name('a<b>c:d"e|f?g*h')).toBe('abcdefgh');
	});

	test('drops leading and trailing dots and whitespace', () => {
		expect(sanitize_download_name('  .hidden.  ')).toBe('hidden');
		expect(sanitize_download_name('...')).toBe('');
	});

	test('collapses internal whitespace runs to one space', () => {
		expect(sanitize_download_name('a \t\n b')).toBe('a b');
		// blanks that are not controls, so only the collapse can remove them
		expect(sanitize_download_name('a \u00a0\u3000b')).toBe('a b');
	});

	test('strips the bidi/format characters that make a name display as another', () => {
		// The classic trick: a right-to-left override so "…gnp.exe" reads ".png".
		expect(sanitize_download_name('photo\u202Egnp.exe')).toBe('photognp.exe');
		expect(sanitize_download_name('a\u200bb\ufeffc')).toBe('abc');
	});

	test('truncates by CODE POINT, never leaving a lone surrogate', () => {
		const astral = '🏺'; // 2 UTF-16 units, 1 code point
		const name = astral.repeat(120);
		const out = sanitize_download_name(name);
		// A UTF-16 `.slice(0, MAX_LENGTH)` would keep 100 units: 50 amphorae.
		expect(out).toBe(astral.repeat(100));
	});

	test('caps the length, and re-trims what the cut exposed', () => {
		expect(sanitize_download_name('x'.repeat(250))).toHaveLength(100);
		// The 100th character is a space here: the cut must not leave it.
		expect(sanitize_download_name(`${'x'.repeat(99)} tail`)).toBe('x'.repeat(99));
	});

	test('returns the empty string — a REFUSAL, never a default — when nothing survives', () => {
		expect(sanitize_download_name('')).toBe('');
		expect(sanitize_download_name('   ')).toBe('');
		expect(sanitize_download_name('/\\')).toBe('');
		expect(sanitize_download_name(undefined as unknown as string)).toBe('');
		expect(sanitize_download_name(42 as unknown as string)).toBe('');
	});
});

describe('tool_uca_maps download_filename — with_extension', () => {
	test('appends the extension', () => {
		expect(with_extension('map', 'png')).toBe('map.png');
		expect(with_extension('map', 'tif')).toBe('map.tif');
	});

	test('does not double it when the user already typed it, whatever the case', () => {
		expect(with_extension('map.png', 'png')).toBe('map.png');
		expect(with_extension('map.PNG', 'png')).toBe('map.PNG');
	});

	test('a different extension in the name is kept, not replaced', () => {
		// "mapa.v2" is a name, not a format claim — the real extension still
		// has to arrive, or the file downloads as something the OS cannot open.
		expect(with_extension('mapa.v2', 'png')).toBe('mapa.v2.png');
	});

	test("the default base name is 'map', and a usable one", () => {
		// Literal on purpose: the one pin of the default that needs no ImageMagick.
		expect(DEFAULT_MAP_IMAGE_NAME).toBe('map');
		expect(sanitize_download_name(DEFAULT_MAP_IMAGE_NAME)).toBe(DEFAULT_MAP_IMAGE_NAME);
	});
});

/** Top-level `let`/`var` and `const … = new Map|Set…`, exported or not. */
function mutableBindings(source: string): string[] {
	return source
		.split('\n')
		.filter(
			(line) =>
				/^(export\s+)?(let|var)\s/.test(line) ||
				/^(export\s+)?const\s.*\bnew (Map|Set|WeakMap|WeakSet)\(/.test(line),
		);
}

/**
 * The server imports this module, so one instance serves every concurrent
 * request. `module_state_tripwire` reads only `.ts`, so this gate stands in
 * for it: stateless, and import-free so both sides can load it.
 */
describe('tool_uca_maps download_filename — stateless, because the server shares it', () => {
	const SOURCE = readFileSync(
		new URL('../../tools/tool_uca_maps/js/download_filename.js', import.meta.url),
		'utf8',
	);

	test('the census sees every mutable binding shape', () => {
		const sample = [
			'let a = 1',
			'export let b = 1',
			'var c',
			'export var d',
			'const e = new Map()',
			'export const f = new Set()',
			'const g = 1',
			'export const h = Object.freeze({})',
			'\tlet local = 1',
		].join('\n');
		expect(mutableBindings(sample)).toEqual([
			'let a = 1',
			'export let b = 1',
			'var c',
			'export var d',
			'const e = new Map()',
			'export const f = new Set()',
		]);
	});

	test('declares no module-level mutable binding', () => {
		expect(mutableBindings(SOURCE)).toEqual([]);
	});

	test('imports nothing, so both the browser and the server can load it', () => {
		expect(SOURCE).not.toMatch(/^import\s/m);
	});
});
