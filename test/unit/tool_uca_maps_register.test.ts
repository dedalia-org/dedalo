/**
 * tool_uca_maps — register.json validates as an authoring-format manifest, the
 * same zod schema `importTools` runs, so a typo fails the suite instead of an
 * install. The label keys are derived from the client source: a missing key
 * ships as English in every other language, since each call site falls back.
 */

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { authoringRegisterSchema } from '../../src/core/tools/register_schema.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const TOOL_DIR = new URL('../../tools/tool_uca_maps/', import.meta.url);

/** `get_tool_label('some_key')`, or `('some_key', value…)` for a label with `%s`. */
const LABEL_CALL = /get_tool_label\(\s*'([A-Za-z0-9_]+)'\s*[,)]/y;
/** A computed family, `get_tool_label('raster_format_' + format)`: only its prefix is known. */
const FAMILY_CALL = /get_tool_label\(\s*'([A-Za-z0-9_]+_)'\s*\+/y;

interface LabelCall {
	file: string;
	/** The literal key, or null for a computed family. */
	key: string | null;
	/** A computed family's literal prefix (`raster_format_`), else null. */
	family: string | null;
	/** How many values the call passes for the label's `%s`; -1 when unread. */
	args: number;
	/** The call's opening text, for a failure message. */
	text: string;
}

/** Top-level commas up to the call's closing parenthesis. */
function countArgs(source: string, from: number): number {
	let depth = 0;
	let commas = 0;
	for (let i = from; i < source.length; i++) {
		const char = source[i] as string;
		if ('([{'.includes(char)) depth++;
		else if (')]}'.includes(char) && depth-- === 0) return commas;
		else if (char === ',' && depth === 0) commas++;
	}
	return -1;
}

/** Every `get_tool_label(` in the client's code, comments stripped. */
async function labelCalls(): Promise<LabelCall[]> {
	const calls: LabelCall[] = [];
	// js/lib/ is vendored third-party code — it never calls get_tool_label
	const glob = new Glob('js/**/*.js');
	for await (const relative of glob.scan({ cwd: Bun.fileURLToPath(TOOL_DIR) })) {
		if (relative.startsWith('js/lib/')) {
			continue;
		}
		const source = stripComments(await Bun.file(new URL(relative, TOOL_DIR)).text());
		for (const match of source.matchAll(/get_tool_label\(/g)) {
			const at = match.index as number;
			const text = source.slice(at, at + 60).split('\n')[0] as string;
			LABEL_CALL.lastIndex = at;
			FAMILY_CALL.lastIndex = at;
			const literal = LABEL_CALL.exec(source);
			if (literal) {
				const end = at + literal[0].length;
				const args = source[end - 1] === ',' ? countArgs(source, end) + 1 : 0;
				calls.push({ file: relative, key: literal[1] as string, family: null, args, text });
			} else {
				const family = FAMILY_CALL.exec(source);
				calls.push({
					file: relative,
					key: null,
					family: family ? (family[1] as string) : null,
					args: family ? 0 : -1,
					text,
				});
			}
		}
	}
	return calls;
}

async function usedLabelKeys(): Promise<Set<string>> {
	return new Set((await labelCalls()).flatMap((call) => (call.key === null ? [] : [call.key])));
}

describe('tool_uca_maps register.json', () => {
	test('parses as a valid authoring-format manifest', async () => {
		const raw = await Bun.file(new URL('register.json', TOOL_DIR)).json();
		const parsed = authoringRegisterSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(`register.json failed authoring schema: ${parsed.error.message}`);
		}
		expect(parsed.data.name).toBe('tool_uca_maps');
		expect(parsed.data.affected_models).toEqual(['component_geolocation']);
	});

	test('every label key the client asks for is shipped in every language', async () => {
		const raw = await Bun.file(new URL('register.json', TOOL_DIR)).json();
		const parsed = authoringRegisterSchema.parse(raw);
		const labels = parsed.labels ?? [];

		const langs = [...new Set(labels.map((label) => label.lang))].sort();
		expect(langs.length).toBeGreaterThan(0);

		const shipped = new Map<string, Set<string>>();
		for (const label of labels) {
			const forKey = shipped.get(label.name) ?? new Set<string>();
			forKey.add(label.lang);
			shipped.set(label.name, forKey);
		}

		const used = await usedLabelKeys();
		// a floor, so an accidentally-empty scan (a moved directory, a changed
		// call shape) cannot pass as "nothing to check"
		expect(used.size).toBeGreaterThan(40);

		// only this direction: a key the client asks for MUST ship. The reverse
		// (a shipped key nothing asks for) is not a defect here — several
		// families are addressed by computed keys the scan cannot see
		// (`get_tool_label('raster_format_' + format)`, `'ua_level_' + level`,
		// `'info_' + info.label_key`), so set-equality would fail on correct code.
		const missing = [...used]
			.filter((key) => langs.some((lang) => !shipped.get(key)?.has(lang)))
			.sort();
		expect(missing).toEqual([]);
	});

	test('every get_tool_label call is a literal key or a computed family the scan names', async () => {
		const calls = await labelCalls();
		expect(calls.filter((call) => call.key === null).length).toBeGreaterThan(0);
		// a double-quoted or template key would otherwise escape the key check
		expect(
			calls.filter((call) => call.args === -1).map((call) => `${call.file}: ${call.text}`),
		).toEqual([]);
	});

	// the console's measure rows name their label by `label_key`; the family's
	// prefix check passes whatever happens to one member, this one does not
	test('every label_key compute_info answers ships its info_ label, in every language', async () => {
		const labels =
			authoringRegisterSchema.parse(await Bun.file(new URL('register.json', TOOL_DIR)).json())
				.labels ?? [];
		const langs = [...new Set(labels.map((label) => label.lang))];
		const source = await Bun.file(new URL('js/object_console.js', TOOL_DIR)).text();
		const literals = [...source.matchAll(/\blabel_key\s*:\s*'([a-z_]+)'/g)];
		// a key written any other way (double-quoted, computed) would escape the check
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
		expect(literals.length).toBe([...code.matchAll(/\blabel_key\s*:/g)].length);
		const keys = [...new Set(literals.map((m) => m[1]))];
		expect(keys.sort()).toEqual(['area', 'center', 'coordinates', 'distance', 'radius']);
		const bare = keys.flatMap((key) =>
			langs
				.filter((lang) => !labels.some((l) => l.lang === lang && l.name === `info_${key}`))
				.map((lang) => `info_${key} (${lang})`),
		);
		expect(bare).toEqual([]);
	});

	// the members are computed at run time; at least one per family proves the
	// prefix is spelled as the labels are, so the family can resolve at all
	test('every computed family has labels under its prefix, in every language', async () => {
		const labels =
			authoringRegisterSchema.parse(await Bun.file(new URL('register.json', TOOL_DIR)).json())
				.labels ?? [];
		const langs = [...new Set(labels.map((label) => label.lang))];
		const families = new Set(
			(await labelCalls()).flatMap((call) => (call.family === null ? [] : [call.family])),
		);
		expect(families.size).toBeGreaterThanOrEqual(5);
		const bare = [...families]
			.flatMap((prefix) =>
				langs
					.filter((lang) => !labels.some((l) => l.lang === lang && l.name.startsWith(prefix)))
					.map((lang) => `${prefix} (${lang})`),
			)
			.sort();
		expect(bare).toEqual([]);
	});

	test('a label called with values has one %s per value, in every language', async () => {
		const parsed = authoringRegisterSchema.parse(
			await Bun.file(new URL('register.json', TOOL_DIR)).json(),
		);
		const withValues = (await labelCalls()).filter((call) => call.key !== null && call.args > 0);
		expect(withValues.length).toBeGreaterThan(0);
		const wrong = withValues.flatMap((call) =>
			(parsed.labels ?? [])
				.filter((label) => label.name === call.key)
				.filter((label) => (label.value.match(/%s/g) ?? []).length !== call.args)
				.map((label) => `${call.file}: ${call.key} (${label.lang}) wants ${call.args}`),
		);
		expect(wrong).toEqual([]);
	});
});
