/**
 * Every web-server config we ship or document for the CLIENT tree (/dedalo)
 * revalidates text assets (`Cache-Control: no-cache`). The client is served in
 * place, not content-hashed: a block without the header lets browsers cache
 * main.css/index.html heuristically and keep stale styles after a code update
 * (master7, 2026-11-06 — its vhost was copied from an abridged doc block).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const SOURCES = [
	...['docs/install', 'engineering'].flatMap((dir) =>
		readdirSync(join(ROOT, dir))
			.filter((f) => f.endsWith('.md'))
			.map((f) => `${dir}/${f}`),
	),
	...readdirSync(join(ROOT, 'deploy'))
		.filter((f) => /\.conf(\.tpl)?$/.test(f))
		.map((f) => `deploy/${f}`),
];

/** The text of each client block: from its opener to the first closer after it. */
function clientBlocks(text: string): string[] {
	const blocks: string[] = [];
	for (const m of text.matchAll(/^\s*Alias \/dedalo (\S+)/gm)) {
		const rest = text.slice(m.index);
		const start = rest.indexOf(`<Directory ${m[1]}>`);
		if (start === -1) continue;
		blocks.push(rest.slice(start, rest.indexOf('</Directory>', start)));
	}
	for (const m of text.matchAll(/^\s*location \/dedalo\/ \{/gm)) {
		// up to the nested static-media location (its max-age must not satisfy the check)
		const end = text.indexOf('location ~*', m.index);
		blocks.push(text.slice(m.index, end === -1 ? m.index + 1500 : end));
	}
	return blocks;
}

describe('client tree cache header in shipped/documented web configs', () => {
	const found = SOURCES.flatMap((rel) =>
		clientBlocks(readFileSync(join(ROOT, rel), 'utf8')).map((block) => ({ rel, block })),
	);

	test('the scan finds the known blocks (not vacuous)', () => {
		expect(found.length).toBeGreaterThanOrEqual(9);
	});

	for (const { rel, block } of found) {
		test(`${rel}: ${block.split('\n')[0]?.trim()}`, () => {
			expect(block).toMatch(/Cache-Control "no-cache"/);
		});
	}
});
