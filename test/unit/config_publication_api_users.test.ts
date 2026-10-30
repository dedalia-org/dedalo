/**
 * API_WEB_USER_CODE_MULTIPLE reader (readPublicationApiUsers) — the publication_api
 * maintenance widget's Swagger-docu buttons come from it. The api_ui address reaches
 * window.open, so only http(s)/root-relative survives.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { encodeEnvValue, V6_MIGRATION } from '../../src/config/migration_map.ts';
import { extractDefines } from '../../src/config/php_defines.ts';
import { readPublicationApiUsers, readPublicationApiV2Url } from '../../src/config/readers.ts';

const ROOT = join(import.meta.dir, '..', '..');

const KEY = 'API_WEB_USER_CODE_MULTIPLE';
const saved = process.env[KEY];

afterEach(() => {
	if (saved === undefined) delete process.env[KEY];
	else process.env[KEY] = saved;
});

const read = (value: string) => {
	process.env[KEY] = value;
	const errors = spyOn(console, 'error').mockImplementation(() => {});
	try {
		return { users: readPublicationApiUsers(KEY), logged: errors.mock.calls.length };
	} finally {
		errors.mockRestore();
	}
};

describe('readPublicationApiUsers', () => {
	test('valid entries pass, api_ui defaults to null', () => {
		const { users, logged } = read(
			JSON.stringify([
				{ db_name: 'web_a', code: 'c1' },
				{ db_name: 'web_b', code: 'c2', api_ui: 'https://example.org/docu/ui/' },
				{ db_name: 'web_c', code: 'c3', api_ui: '/dedalo/publication/server_api/v1/docu/ui/' },
			]),
		);
		// The floor: the reader yields entries at all — so the toEqual([]) verdicts
		// below are refusals, not a reader that returns nothing (gate_vacuity).
		expect(users).toHaveLength(3);
		expect(users).toEqual([
			{ db_name: 'web_a', code: 'c1', api_ui: null },
			{ db_name: 'web_b', code: 'c2', api_ui: 'https://example.org/docu/ui/' },
			{ db_name: 'web_c', code: 'c3', api_ui: '/dedalo/publication/server_api/v1/docu/ui/' },
		]);
		expect(logged).toBe(0);
	});

	test('a non-http(s) api_ui is dropped to the default, loudly', () => {
		for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/']) {
			const { users, logged } = read(
				JSON.stringify([{ db_name: 'web_a', code: 'c', api_ui: bad }]),
			);
			expect(users).toEqual([{ db_name: 'web_a', code: 'c', api_ui: null }]);
			expect(logged).toBe(1);
		}
	});

	test('entries without string db_name/code are dropped, loudly', () => {
		const { users, logged } = read(
			JSON.stringify([
				{ db_name: 'web_a', code: 'c' },
				{ db_name: 'web_b' },
				{ code: 'x' },
				'str',
				null,
			]),
		);
		expect(users).toEqual([{ db_name: 'web_a', code: 'c', api_ui: null }]);
		expect(logged).toBe(1);
	});

	test('malformed / non-array JSON refuses to [], loudly', () => {
		for (const bad of ['web_a,code', '{"db_name":"web_a","code":"c"}']) {
			const { users, logged } = read(bad);
			expect(users).toEqual([]);
			expect(logged).toBe(1);
		}
	});

	// Empty only: deleting the key would fall through to ../private/.env (readEnv
	// precedence), which on an installation may hold real entries.
	test('empty = no users', () => {
		expect(read('').users).toEqual([]);
		expect(read('  ').users).toEqual([]);
	});
});

// v6 define() → migration rule → .env line → reader: what the migrator writes is
// what the panel reads, with nothing reported as dropped at boot.
describe('v6 migration round-trip', () => {
	const migrate = (php: string): string | null => {
		const record = extractDefines([{ path: 'config.php', content: `<?php\n${php}` }]).records.get(
			KEY,
		);
		expect(record?.kind).toBe('literal');
		const rule = V6_MIGRATION[KEY];
		return encodeEnvValue(rule?.transform ? rule.transform(record?.value) : record?.value);
	};

	test('real v6 entries reach the reader intact, the placeholder is left out', () => {
		const line = migrate(`define('${KEY}', [
			['db_name' => 'web_a', 'code' => 'c1', 'api_ui' => null],
			['db_name' => '', 'code' => '', 'api_ui' => null],
			['db_name' => 'web_b', 'code' => 'c2', 'api_ui' => 'https://example.org/docu/ui/'],
		]);`);
		expect(line).not.toBeNull();
		const { users, logged } = read(line as string);
		expect(users).toEqual([
			{ db_name: 'web_a', code: 'c1', api_ui: null },
			{ db_name: 'web_b', code: 'c2', api_ui: 'https://example.org/docu/ui/' },
		]);
		expect(logged).toBe(0);
	});

	test('the stock v6 placeholder alone writes no key (a verbatim copy would warn every boot)', () => {
		const stock = `define('${KEY}', [['db_name' => '', 'code' => '', 'api_ui' => null]]);`;
		expect(migrate(stock)).toBeNull();
		// the counterfactual: copied verbatim, the reader drops it loudly
		const verbatim = encodeEnvValue(
			extractDefines([{ path: 'config.php', content: `<?php\n${stock}` }]).records.get(KEY)?.value,
		);
		const { users, logged } = read(verbatim as string);
		expect(users).toEqual([]);
		expect(logged).toBe(1);
	});
});

// The panel end: config is frozen at import, so the widget is booted in a child
// process with the key set. The widget's whole-body catch would answer [] on any
// failure, so a non-empty list proves the value reached the eager payload.
describe('publication_api widget', () => {
	test('serves the configured users as api_web_user_code_multiple', () => {
		const snippet = `const { widget } = await import('./src/core/area_maintenance/widgets/publication_api.ts');
const value = await widget.eagerValue();
console.log(JSON.stringify(value.api_web_user_code_multiple));
process.exit(0);`;
		const child = Bun.spawnSync(['bun', '-e', snippet], {
			cwd: ROOT,
			env: {
				...process.env,
				[KEY]: JSON.stringify([
					{ db_name: 'web_a', code: 'c1' },
					{ db_name: 'web_b', code: 'c2', api_ui: 'javascript:alert(1)' },
				]),
			} as Record<string, string>,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(child.exitCode).toBe(0);
		const lines = child.stdout.toString().trim().split('\n');
		expect(JSON.parse(lines[lines.length - 1] ?? '')).toEqual([
			{ db_name: 'web_a', code: 'c1', api_ui: null },
			{ db_name: 'web_b', code: 'c2', api_ui: null },
		]);
	}, 60_000);
});

describe('readPublicationApiV2Url', () => {
	const V2 = 'DEDALO_PUBLICATION_API_V2_URL';
	const savedV2 = process.env[V2];
	afterEach(() => {
		if (savedV2 === undefined) delete process.env[V2];
		else process.env[V2] = savedV2;
	});
	const readV2 = (value: string) => {
		process.env[V2] = value;
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			return { url: readPublicationApiV2Url(V2), logged: errors.mock.calls.length };
		} finally {
			errors.mockRestore();
		}
	};

	test('http(s) and root-relative pass, trailing slash dropped', () => {
		expect(readV2('https://pub.example.org/publication/server_api/v2/')).toEqual({
			url: 'https://pub.example.org/publication/server_api/v2',
			logged: 0,
		});
		expect(readV2('/publication/server_api/v2')).toEqual({
			url: '/publication/server_api/v2',
			logged: 0,
		});
	});

	test('unset/empty → null silently; unsafe → null loudly', () => {
		expect(readV2('')).toEqual({ url: null, logged: 0 });
		for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/', '/', '///']) {
			expect(readV2(bad)).toEqual({ url: null, logged: 1 });
		}
	});
});
