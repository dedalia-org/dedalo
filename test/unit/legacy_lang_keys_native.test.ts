/**
 * APPLICATION_LANG / DATA_LANG transition release: still honoured, classified for the
 * boot warning (override) and the check_config widget (redundant, override). Pure: the
 * lookups are injected, so nothing here reads this machine's ../private/.env.
 */
import { describe, expect, test } from 'bun:test';
import { langDefaultMembershipReports } from '../../src/config/data_langs.ts';
import {
	classifyDeprecatedLangKeys,
	DEPRECATED_LANG_KEYS,
	deprecatedLangBootLines,
	deprecatedLangWidgetRows,
	PHP_KEY_ALIASES,
} from '../../src/config/env.ts';

const DEFAULTS: Record<string, string> = {
	DEDALO_APPLICATION_LANGS_DEFAULT: 'lg-eng',
	DEDALO_DATA_LANG_DEFAULT: 'lg-spa',
};
const classify = (env: Record<string, string>) =>
	classifyDeprecatedLangKeys(
		(key) => DEFAULTS[key] ?? '',
		(spelling) => env[spelling],
	);
const byKey = (env: Record<string, string>, key: 'APPLICATION_LANG' | 'DATA_LANG') =>
	classify(env).find((status) => status.key === key);

describe('DEPRECATED_LANG_KEYS', () => {
	test('PHP spellings are still honoured aliases (transition release)', () => {
		for (const [key, { php }] of Object.entries(DEPRECATED_LANG_KEYS)) {
			expect(PHP_KEY_ALIASES[key]).toBe(php);
		}
	});
});

describe('classifyDeprecatedLangKeys', () => {
	test('absent and empty/blank are unset, with no action', () => {
		for (const env of [{}, { APPLICATION_LANG: '' }, { APPLICATION_LANG: '  ' }] as Record<
			string,
			string
		>[]) {
			const status = byKey(env, 'APPLICATION_LANG');
			expect(status?.state).toBe('unset');
			expect(status?.action).toBeUndefined();
		}
	});

	test('equal to its default = redundant, named by spelling', () => {
		const status = byKey({ DEDALO_DATA_LANG: 'lg-spa' }, 'DATA_LANG');
		expect(status).toMatchObject({
			state: 'redundant',
			spelling: 'DEDALO_DATA_LANG',
			value: 'lg-spa',
			defaultKey: 'DEDALO_DATA_LANG_DEFAULT',
		});
		expect(status?.action).toContain('delete the redundant DEDALO_DATA_LANG line');
	});

	test('differs from its default = override with the exact edit', () => {
		const status = byKey({ APPLICATION_LANG: 'lg-cat' }, 'APPLICATION_LANG');
		expect(status).toMatchObject({
			state: 'override',
			spelling: 'APPLICATION_LANG',
			value: 'lg-cat',
		});
		expect(status?.action).toContain("overrides DEDALO_APPLICATION_LANGS_DEFAULT='lg-eng'");
		expect(status?.action).toContain(
			'set DEDALO_APPLICATION_LANGS_DEFAULT=lg-cat and delete the APPLICATION_LANG line; from the next release this line refuses the boot',
		);
	});

	test('PHP spelling alone is classified under its own name', () => {
		expect(byKey({ DEDALO_APPLICATION_LANG: 'lg-fra' }, 'APPLICATION_LANG')).toMatchObject({
			state: 'override',
			spelling: 'DEDALO_APPLICATION_LANG',
		});
	});

	test('native spelling wins over the PHP one (readEnv precedence)', () => {
		const status = byKey({ DATA_LANG: 'lg-spa', DEDALO_DATA_LANG: 'lg-cat' }, 'DATA_LANG');
		expect(status).toMatchObject({ state: 'redundant', spelling: 'DATA_LANG' });
	});

	test('an empty native stub masks the PHP line, exactly as readEnv serves it', () => {
		expect(byKey({ DATA_LANG: '', DEDALO_DATA_LANG: 'lg-cat' }, 'DATA_LANG')?.state).toBe('unset');
	});

	test('a line config already overrules is ignored: delete, never "set the default to it"', () => {
		// DATA_LANG naming an undeclared language: resolveCurrentDataLang serves the default.
		const env: Record<string, string> = { DATA_LANG: 'lg-fra' };
		const status = classifyDeprecatedLangKeys(
			(key) => DEFAULTS[key] ?? '',
			(spelling) => env[spelling],
			(key) => (key === 'DATA_LANG' ? 'lg-spa' : (env[key] ?? '')),
		).find((s) => s.key === 'DATA_LANG');
		expect(status?.state).toBe('ignored');
		expect(status?.action).toContain('delete the DATA_LANG line');
		expect(status?.action).not.toContain('set DEDALO_DATA_LANG_DEFAULT=lg-fra');
	});

	test('a served override stays an override', () => {
		const env: Record<string, string> = { DATA_LANG: 'lg-eng' };
		expect(
			classifyDeprecatedLangKeys(
				(key) => DEFAULTS[key] ?? '',
				(spelling) => env[spelling],
				(key) => env[key] ?? '',
			).find((s) => s.key === 'DATA_LANG')?.state,
		).toBe('override');
	});

	test('both keys are always reported, in table order', () => {
		expect(classify({}).map((status) => status.key)).toEqual(['APPLICATION_LANG', 'DATA_LANG']);
	});
});

describe('the release rule: boot prints overrides only, the widget lists every set line', () => {
	const env: Record<string, string> = { APPLICATION_LANG: 'lg-cat', DATA_LANG: 'lg-spa' };
	const statuses = classifyDeprecatedLangKeys(
		(key) => DEFAULTS[key] ?? '',
		(spelling) => env[spelling],
		(key) => (key === 'DATA_LANG' ? 'lg-spa' : (env[key] ?? '')),
	);

	test('boot: exactly the override action line; redundant prints nothing', () => {
		const override = statuses.find((s) => s.state === 'override');
		expect(deprecatedLangBootLines(statuses)).toEqual([`[config] ${override?.action}`]);
	});

	test('boot: ignored and unset print nothing', () => {
		const quiet = classifyDeprecatedLangKeys(
			(key) => DEFAULTS[key] ?? '',
			(spelling) => ({ DATA_LANG: 'lg-fra' })[spelling],
			() => 'lg-spa',
		);
		expect(quiet.map((s) => s.state)).toEqual(['unset', 'ignored']);
		expect(deprecatedLangBootLines(quiet)).toEqual([]);
	});

	test('widget: unset is omitted, every other state is a row', () => {
		expect(deprecatedLangWidgetRows(statuses).map((s) => s.state)).toEqual([
			'override',
			'redundant',
		]);
		expect(deprecatedLangWidgetRows(classify({}))).toEqual([]);
	});
});

describe('langDefaultMembershipReports', () => {
	const coherent = {
		applicationLangs: { 'lg-eng': 'English', 'lg-spa': 'Castellano' },
		applicationLangsDefault: 'lg-eng',
		projectLangs: ['lg-spa', 'lg-eng'],
		dataLangDefault: 'lg-spa',
	};

	test('coherent config reports nothing', () => {
		expect(langDefaultMembershipReports(coherent)).toEqual([]);
	});

	test('interface default outside DEDALO_APPLICATION_LANGS is reported', () => {
		const reports = langDefaultMembershipReports({
			...coherent,
			applicationLangsDefault: 'lg-cat',
		});
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("DEDALO_APPLICATION_LANGS_DEFAULT = 'lg-cat'");
	});

	test('data default outside PROJECTS_DEFAULT_LANGS is reported', () => {
		const reports = langDefaultMembershipReports({ ...coherent, dataLangDefault: 'lg-fra' });
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("DEDALO_DATA_LANG_DEFAULT = 'lg-fra'");
	});

	test('a prototype key is not a member', () => {
		expect(
			langDefaultMembershipReports({ ...coherent, applicationLangsDefault: 'toString' }),
		).toHaveLength(1);
	});
});
