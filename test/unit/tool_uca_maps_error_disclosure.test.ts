/**
 * tool_uca_maps — every sentence the server writes for the user survives to the client.
 *
 * A `publicMessage` survives the converter only on a `public`-disclosure code
 * (the ladder, src/core/errors/convert.ts); on an `operator` code it is
 * dropped in silence and the user reads the generic label. And the panel
 * shows a reason only for the codes in the client's REASON_CODES
 * (js/tool_error_text.js). This census ties the three together: each
 * `new DedaloError(code, {publicMessage})` under server/ names a public code,
 * the converter really puts the sentence on the wire, and REASON_CODES lists
 * the code. Whether the calling panel renders the reason is not read here.
 */

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { toErrorBody } from '../../src/core/errors/convert.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { ERROR_REGISTRY, type ErrorCode } from '../../src/core/errors/registry.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const TOOL_DIR = new URL('../../tools/tool_uca_maps/', import.meta.url);

interface ThrowSite {
	file: string;
	code: string | null;
	publicMessage: boolean;
	/** Options absent or one inline object literal without a spread: the only
	 * shape in which a `publicMessage` cannot hide from the census. */
	inlineOptions: boolean;
}

/** Whether the blanked argument text after the code is nothing or one `{…}`
 * with no spread in it. */
function isInlineOptions(args: string): boolean {
	let depth = 0;
	let comma = -1;
	for (let i = 0; i < args.length && comma === -1; i++) {
		const char = args[i] as string;
		if ('({['.includes(char)) depth++;
		else if (')}]'.includes(char)) depth--;
		else if (char === ',' && depth === 0) comma = i;
	}
	const rest =
		comma === -1
			? ''
			: args
					.slice(comma + 1)
					.trim()
					.replace(/,$/, '')
					.trim();
	if (rest === '') return true;
	if (!rest.startsWith('{') || rest.includes('...')) return false;
	depth = 0;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === '{') depth++;
		else if (rest[i] === '}' && --depth === 0) return i === rest.length - 1;
	}
	return false;
}

/** Every `new DedaloError(` in the tool's server code, read on two aligned views
 * of the source: literals kept (the code) and literals blanked (the brackets
 * and property names, which a parenthesis inside a message cannot fool). */
async function throwSites(): Promise<ThrowSite[]> {
	const sites: ThrowSite[] = [];
	const glob = new Glob('server/**/*.ts');
	for await (const relative of glob.scan({ cwd: Bun.fileURLToPath(TOOL_DIR) })) {
		const source = await Bun.file(new URL(relative, TOOL_DIR)).text();
		const code = stripComments(source);
		const blank = stripComments(source, { blankStrings: true, blankRegexBodies: true });
		for (const match of blank.matchAll(/new DedaloError\(/g)) {
			const start = (match.index as number) + match[0].length;
			let depth = 1;
			let end = start;
			while (end < blank.length && depth > 0) {
				if (blank[end] === '(') depth++;
				else if (blank[end] === ')') depth--;
				end++;
			}
			const literal = /^\s*'([a-z0-9_]+\.[a-z0-9_]+)'/.exec(code.slice(start, end - 1));
			sites.push({
				file: relative,
				code: literal ? (literal[1] as string) : null,
				publicMessage: /\bpublicMessage\b/.test(blank.slice(start, end - 1)),
				inlineOptions: isInlineOptions(blank.slice(start, end - 1)),
			});
		}
	}
	return sites;
}

/** REASON_CODES as the browser reads it — a plain source read, because the
 * module imports core client code by its served URL, not a repo path. */
async function clientReasonCodes(): Promise<Set<string>> {
	const source = await Bun.file(new URL('js/tool_error_text.js', TOOL_DIR)).text();
	const body = /REASON_CODES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(source);
	return new Set([...(body?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] as string));
}

describe('tool_uca_maps — a public message is a message the user reads', () => {
	test('every throw names its code as a literal the census can read', async () => {
		const sites = await throwSites();
		expect(sites.length).toBeGreaterThan(30);
		expect(sites.filter((site) => site.code === null)).toEqual([]);
	});

	test('every throw spells its options inline, so a publicMessage cannot hide', async () => {
		const hidden = (await throwSites()).filter((site) => !site.inlineOptions);
		expect(hidden.map((site) => `${site.file}: ${site.code}`)).toEqual([]);
		// the reader itself, on the two shapes that would hide one
		expect(isInlineOptions(" '', options")).toBe(false);
		expect(isInlineOptions(" '', { ...options, message }")).toBe(false);
		expect(isInlineOptions(" '', { message, details: { a: 1 } },")).toBe(true);
		expect(isInlineOptions(" ''")).toBe(true);
	});

	test('a publicMessage rides only a public code that the converter keeps and REASON_CODES lists', async () => {
		const reasons = await clientReasonCodes();
		const spoken = (await throwSites()).filter((site) => site.publicMessage);
		// a floor: a moved directory or a renamed field must not pass as "none"
		expect(spoken.length).toBeGreaterThanOrEqual(15);

		const wrong = spoken
			.filter((site) => {
				const spec = ERROR_REGISTRY[site.code as ErrorCode];
				return spec?.disclosure !== 'public' || !reasons.has(site.code as string);
			})
			.map((site) => `${site.file}: ${site.code}`);
		expect(wrong).toEqual([]);

		for (const code of new Set(spoken.map((site) => site.code as ErrorCode))) {
			const body = toErrorBody(new DedaloError(code, { publicMessage: 'the reason' }));
			expect(body.message).toBe('the reason');
		}
	});

	test("the client's REASON_CODES are all public: an operator code never carries a reason", async () => {
		const reasons = await clientReasonCodes();
		expect(reasons.size).toBeGreaterThanOrEqual(3);
		for (const code of reasons) {
			expect(ERROR_REGISTRY[code as ErrorCode]?.disclosure).toBe('public');
		}
	});
});
