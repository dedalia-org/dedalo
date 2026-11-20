/**
 * tool_uca_maps — a refusal's sentence is the tool's DECLARATION, never the throw's.
 * The browser explains a refusal from `details.reason_key` (the tool's label, else
 * `server/reasons.ts`); core's tripwire holds that map against the labels and the guard.
 * This census holds the tool's side: no own `publicMessage` under server/, a named key
 * (inline or through a `reasons.ts` builder) names a code that carries one and is
 * declared, the module serves exactly the declared map, no dead key.
 */

import { describe, expect, test } from 'bun:test';
import { type ErrorCode, REASON_KEY_CODES } from '../../src/core/errors/registry.ts';
import { tool } from '../../tools/tool_uca_maps/server/index.ts';
import { REASON_KEYS } from '../../tools/tool_uca_maps/server/reasons.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import { toolSources, toolUrl } from './fixtures/tool_uca_maps/source_census.ts';

/** Measured today: 11 inline `new DedaloError(` sites + 52 builder calls passing a key. */
const FLOOR_KEYED = 63;

interface ThrowSite {
	file: string;
	code: string | null;
	publicMessage: boolean;
	/** Whether the options write `details.reason_key` (a literal or a typed parameter). */
	reasonKey: boolean;
	/** The key when written as a literal, else null. */
	reasonLiteral: string | null;
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
	for (const [relative, source] of await toolSources('server/**/*.ts')) {
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
				reasonLiteral:
					/\breason_key:\s*'([a-z0-9_]+)'/.exec(code.slice(start, end - 1))?.[1] ?? null,
				inlineOptions: isInlineOptions(blank.slice(start, end - 1)),
			});
		}
	}
	return sites;
}

/** The arguments of a call whose text (blanked view) starts after its `(`: each
 * as [start, end) offsets, split on the commas at depth 0. */
function callArguments(blank: string, start: number): Array<[number, number]> {
	const args: Array<[number, number]> = [];
	let depth = 1;
	let from = start;
	let i = start;
	for (; i < blank.length && depth > 0; i++) {
		const char = blank[i] as string;
		if ('({['.includes(char)) depth++;
		else if (')}]'.includes(char)) depth--;
		else if (char === ',' && depth === 1) {
			args.push([from, i]);
			from = i + 1;
		}
	}
	if (blank.slice(from, i - 1).trim() !== '') args.push([from, i - 1]);
	return args;
}

/** Each builder `reasons.ts` exports, with the code its `new DedaloError(` names. */
async function builderCodes(): Promise<Map<string, string>> {
	const source = stripComments(await Bun.file(toolUrl('server/reasons.ts')).text());
	const builders = new Map<string, string>();
	for (const part of source.split(/(?=\bexport function )/)) {
		const match =
			/^export function (\w+)\([\s\S]*?new DedaloError\('([a-z0-9_]+\.[a-z0-9_]+)'/.exec(part);
		if (match) builders.set(match[1] as string, match[2] as string);
	}
	return builders;
}

interface BuilderCall {
	file: string;
	builder: string;
	code: string;
	/** The second argument as written: the key literal, any other text, or null when absent. */
	reason: string | null;
	/** Whether that argument is a single-quoted literal the census can read. */
	reasonIsLiteral: boolean;
}

/** Every call of a `reasons.ts` builder elsewhere under server/: a refusal site whose
 * options the builder spells inline, so its key is the call's second argument. */
async function builderCalls(): Promise<BuilderCall[]> {
	const builders = await builderCodes();
	const pattern = new RegExp(`(?<![\\w.$])(${[...builders.keys()].join('|')})\\(`, 'g');
	const calls: BuilderCall[] = [];
	for (const [relative, source] of await toolSources('server/**/*.ts')) {
		if (relative === 'server/reasons.ts') continue;
		const code = stripComments(source);
		const blank = stripComments(source, { blankStrings: true, blankRegexBodies: true });
		for (const match of blank.matchAll(pattern)) {
			const builder = match[1] as string;
			const second = callArguments(blank, (match.index as number) + match[0].length)[1];
			const text = second ? code.slice(second[0], second[1]).trim() : '';
			const literal = /^'([a-z0-9_]+)'$/.exec(text);
			calls.push({
				file: relative,
				builder,
				code: builders.get(builder) as string,
				reason: text === '' || text === 'undefined' ? null : (literal?.[1] ?? text),
				reasonIsLiteral: literal !== null,
			});
		}
	}
	return calls;
}

/** Every server source but the declaration itself, comments stripped. */
async function serverSources(): Promise<string> {
	return (await toolSources('server/**/*.ts'))
		.filter(([relative]) => relative !== 'server/reasons.ts')
		.map(([, source]) => stripComments(source))
		.join('\n');
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

	test('a refusal that names a reason_key names a code that carries one', async () => {
		const keyed = [
			...(await throwSites()).filter((site) => site.reasonKey),
			...(await builderCalls()).filter((call) => call.reason !== null),
		];
		// a floor at today's count: a moved directory, a renamed field or a builder
		// the census stops seeing must not pass as "none"
		expect(keyed.length).toBeGreaterThanOrEqual(FLOOR_KEYED);
		const wrong = keyed
			.filter((site) => !REASON_KEY_CODES.includes(site.code as ErrorCode))
			.map((site) => `${site.file}: ${site.code}`);
		expect(wrong).toEqual([]);
	});

	test('every key a refusal names is a literal of the declared map', async () => {
		const builders = await builderCodes();
		expect(builders.size).toBeGreaterThanOrEqual(3);
		const calls = (await builderCalls()).filter((call) => call.reason !== null);
		const unreadable = calls.filter((call) => !call.reasonIsLiteral);
		expect(unreadable.map((call) => `${call.file}: ${call.builder}(…, ${call.reason})`)).toEqual(
			[],
		);
		const named = [
			...calls.map((call) => ({ file: call.file, key: call.reason as string })),
			...(await throwSites())
				.filter((site) => site.reasonLiteral !== null)
				.map((site) => ({ file: site.file, key: site.reasonLiteral as string })),
		];
		const undeclared = named.filter((entry) => !Object.hasOwn(REASON_KEYS, entry.key));
		expect(undeclared.map((entry) => `${entry.file}: ${entry.key}`)).toEqual([]);
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
