/**
 * tool_uca_maps — a refusal's sentence is the tool's DECLARATION, never the throw's.
 *
 * The browser explains a refusal from `details.reason_key` (the tool's
 * `reason_<key>` label, else the sentence `server/reasons.ts` declares; the
 * loader's guard puts it on the wire). Core's tripwire holds the map against
 * the labels and the guard; this census holds the tool's side of it: no throw
 * under server/ carries a `publicMessage` of its own, a throw that names a
 * key names a code that carries one, the module serves exactly the declared
 * map, and no declared key is dead.
 */

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { type ErrorCode, REASON_KEY_CODES } from '../../src/core/errors/registry.ts';
import { tool } from '../../tools/tool_uca_maps/server/index.ts';
import { REASON_KEYS } from '../../tools/tool_uca_maps/server/reasons.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const TOOL_DIR = new URL('../../tools/tool_uca_maps/', import.meta.url);

interface ThrowSite {
	file: string;
	code: string | null;
	publicMessage: boolean;
	/** Whether the options write `details.reason_key` (a literal or a typed parameter). */
	reasonKey: boolean;
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
				reasonKey: /\breason_key\b/.test(blank.slice(start, end - 1)),
				inlineOptions: isInlineOptions(blank.slice(start, end - 1)),
			});
		}
	}
	return sites;
}

/** Every server source but the declaration itself, comments stripped. */
async function serverSources(): Promise<string> {
	const parts: string[] = [];
	for await (const relative of new Glob('server/**/*.ts').scan({
		cwd: Bun.fileURLToPath(TOOL_DIR),
	})) {
		if (relative === 'server/reasons.ts') continue;
		parts.push(stripComments(await Bun.file(new URL(relative, TOOL_DIR)).text()));
	}
	return parts.join('\n');
}

describe('tool_uca_maps — a refusal says what the declaration says', () => {
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

	test('no throw carries a sentence of its own: the declaration owns it', async () => {
		const spoken = (await throwSites()).filter((site) => site.publicMessage);
		expect(spoken.map((site) => `${site.file}: ${site.code}`)).toEqual([]);
	});

	test('a throw that names a reason_key names a code that carries one', async () => {
		const keyed = (await throwSites()).filter((site) => site.reasonKey);
		// a floor: a moved directory or a renamed field must not pass as "none"
		expect(keyed.length).toBeGreaterThanOrEqual(13);
		const wrong = keyed
			.filter((site) => !REASON_KEY_CODES.includes(site.code as ErrorCode))
			.map((site) => `${site.file}: ${site.code}`);
		expect(wrong).toEqual([]);
	});

	test('the module serves exactly the declared map', () => {
		expect(tool.reasonKeys).toBe(REASON_KEYS);
	});

	test('every declared key is thrown somewhere: none is dead', async () => {
		const code = await serverSources();
		const dead = Object.keys(REASON_KEYS).filter((key) => !code.includes(`'${key}'`));
		expect(dead).toEqual([]);
	});
});
