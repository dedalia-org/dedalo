/**
 * RETIRED UPDATE HOST: v7.master.dedalo.dev was replaced by master7/beta7 (no alias).
 * A CODE_SERVERS / ONTOLOGY_SERVERS entry still naming it logs ONE actionable line
 * per list at boot (src/config/readers.ts warnRetiredUpdateHost) and is kept as-is.
 */

import { describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { secureServerList, warnRetiredUpdateHost } from '../../src/config/readers.ts';

const OLD = 'https://v7.master.dedalo.dev/dedalo/core/api/v1/json/';
const NEW = 'https://master7.dedalo.dev/dedalo/core/api/v1/json/';

function captureErrors<T>(run: () => T): { result: T; errors: string[] } {
	const errors: string[] = [];
	const original = console.error;
	console.error = mock((line: string) => errors.push(line));
	try {
		return { result: run(), errors };
	} finally {
		console.error = original;
	}
}

describe('warnRetiredUpdateHost', () => {
	test('one line per list, naming the new URLs and the docs anchor; entries untouched', () => {
		const servers = [
			{ name: 'old', url: OLD, code: 'a' },
			{ name: 'old twin', url: OLD.replace('json/', 'json'), code: 'b' },
		];
		const { result, errors } = captureErrors(() =>
			secureServerList('ONTOLOGY_SERVERS', servers, false),
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('ONTOLOGY_SERVERS');
		expect(errors[0]).toContain('https://master7.dedalo.dev/');
		expect(errors[0]).toContain('https://beta7.dedalo.dev/');
		expect(errors[0]).toContain('docs/config/config.md#ontology-servers');
		expect(result).toEqual(servers);
	});

	test('CODE_SERVERS points at its own anchor', () => {
		const { errors } = captureErrors(() => warnRetiredUpdateHost('CODE_SERVERS', [{ url: OLD }]));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('#defining-server-code-provider');
	});

	test('silent for the new hosts, lookalikes and unparsable urls (non-vacuous: the old one fires)', () => {
		const quiet = [
			NEW,
			'https://beta7.dedalo.dev/x',
			'https://v7.master.dedalo.dev.evil.example/',
			'nope',
		];
		const { errors } = captureErrors(() =>
			warnRetiredUpdateHost(
				'CODE_SERVERS',
				quiet.map((url) => ({ url })),
			),
		);
		expect(errors).toEqual([]);
		expect(
			captureErrors(() => warnRetiredUpdateHost('CODE_SERVERS', [{ url: OLD }])).errors,
		).toHaveLength(1);
	});
});

describe('at boot, from the real env reader', () => {
	test('a CODE_SERVERS env still naming the old host logs the line and keeps the entry', () => {
		const script = `
			import { readServerList, secureServerList } from './src/config/readers.ts';
			const list = secureServerList('CODE_SERVERS', readServerList('CODE_SERVERS'), false);
			console.log(JSON.stringify(list));
		`;
		const child = Bun.spawnSync(['bun', '-e', script], {
			cwd: join(import.meta.dir, '../..'),
			env: {
				...process.env,
				CODE_SERVERS: JSON.stringify([{ name: 'old', url: OLD, code: 'a' }]),
			},
		});
		const stderr = child.stderr.toString();
		expect(stderr).toContain('is retired');
		expect(stderr).toContain('master7.dedalo.dev');
		expect(JSON.parse(child.stdout.toString())).toEqual([{ name: 'old', url: OLD, code: 'a' }]);
	});
});
