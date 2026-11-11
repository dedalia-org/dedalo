/**
 * T0-11 D3 — the production installer installs one Tesseract language pack per
 * WORKING language plus `osd`, named by the ONE map (media/engine/ocr_langs.ts):
 * Debian/Ubuntu `tesseract-ocr-<model>` in the main transaction (ocrmypdf is
 * mandatory there), EL `tesseract-langpack-<model>` + `tesseract-osd` in the
 * warn-only `optional` lane — ocrmypdf in its own transaction, ONE per pack (a
 * pack dnf cannot find warns alone, never costs ocrmypdf). Only what the facts
 * say is missing.
 * A working language without a model is TOLD, never fatal, never guessed.
 */

import { describe, expect, test } from 'bun:test';
import type { HostPlanCtx } from '../../src/core/install/host/contract.ts';
import {
	desiredPackages,
	host_packages,
	ocrLangsToldFor,
	ocrModelPlanFor,
	optionalPackages,
	optionalTransactions,
} from '../../src/core/install/host/production/packages.ts';
import { reviewTodo } from '../../src/core/install/host/review.ts';
import { HOST_VARIANTS, productionPlanCtx } from '../helpers/install_host_scratch.ts';

/** Every argv token the step's commands would run. */
function argvOf(ctx: HostPlanCtx): string[] {
	return host_packages
		.commands(ctx)
		.flatMap((command) => (command.kind === 'exec' ? command.argv : []));
}

const NO_FILES = { readText: () => null, exists: () => false } as never;

const variantOf = (os: string) =>
	HOST_VARIANTS.find((variant) => variant.os === os && variant.tls === 'letsencrypt');

/**
 * The scratch answers pin `langs: ['lg-eng']`; an ABSENT answer is the
 * installer's default working set (INSTALL_DEFAULT_LANG_CODES: lg-eng, lg-spa).
 */
const DEFAULT_LANGS = {
	langs: undefined,
	app_lang_default: undefined,
	data_lang_default: undefined,
};
const defaultCtx = (os: string): HostPlanCtx =>
	productionPlanCtx(variantOf(os) as never, undefined, DEFAULT_LANGS);

describe('installer: Tesseract language packs for the working languages (T0-11 D3)', () => {
	for (const os of ['debian13', 'ubuntu2604']) {
		test(`${os}: default langs (lg-eng, lg-spa) → tesseract-ocr-eng/-spa/-osd in the main transaction`, () => {
			const ctx = defaultCtx(os);
			const desired = desiredPackages(ctx);
			for (const name of ['tesseract-ocr-eng', 'tesseract-ocr-spa', 'tesseract-ocr-osd']) {
				expect(desired).toContain(name);
				expect(argvOf(ctx)).toContain(name);
			}
			expect(optionalPackages(ctx)).toEqual([]);
		});
	}

	test('el10: the langpacks + tesseract-osd ride the optional lane beside ocrmypdf, not the main transaction', () => {
		const ctx = defaultCtx('el10');
		const packs = ['tesseract-langpack-eng', 'tesseract-langpack-spa', 'tesseract-osd'];
		expect(optionalPackages(ctx)).toEqual(['ocrmypdf', ...packs]);
		for (const name of packs) expect(desiredPackages(ctx)).not.toContain(name);
		const dnfInstalls = host_packages
			.commands(ctx)
			.flatMap((command) => (command.kind === 'exec' ? [command.argv] : []))
			.filter((argv) => argv[0]?.endsWith('/dnf') === true && argv[1] === 'install');
		// ocrmypdf in its OWN transaction — never beside a langpack dnf may not find.
		const ocr = dnfInstalls.filter((argv) => argv.includes('ocrmypdf'));
		expect(ocr).toEqual([['/usr/bin/dnf', 'install', '-y', 'ocrmypdf']]);
		// ONE transaction per pack, each warn-only.
		for (const name of packs) {
			expect(dnfInstalls.filter((argv) => argv.includes(name))).toEqual([
				['/usr/bin/dnf', 'install', '-y', name],
			]);
		}
		const transactions = optionalTransactions(ctx);
		expect(transactions.map((entry) => entry.packages)).toEqual([
			['ocrmypdf'],
			...packs.map((name) => [name]),
		]);
		for (const entry of transactions) expect(entry.command.okExit).toEqual([0, 1]);
	});

	test('el10: a missing langpack warns ALONE — ocrmypdf and the other packs still install', async () => {
		const ctx = defaultCtx('el10');
		const ran: string[][] = [];
		const result = await host_packages.run({
			...ctx,
			runner: {
				run: async (command: { argv: readonly string[] }) => {
					ran.push([...command.argv]);
					// dnf has no match for the Spanish pack: that transaction alone exits 1.
					const failed = command.argv.includes('tesseract-langpack-spa');
					return {
						exitCode: failed ? 1 : 0,
						stdout: '',
						stderr: failed ? 'No match for argument' : '',
						timedOut: false,
					};
				},
			},
		} as never);
		const warnings = (result as { warnings?: string[] }).warnings ?? [];
		expect(warnings.filter((line) => line.includes('could not be installed'))).toEqual([
			expect.stringContaining('tesseract-langpack-spa'),
		]);
		expect(warnings.some((line) => line.includes('ocrmypdf'))).toBe(false);
		expect(ran.some((argv) => argv.join(' ') === '/usr/bin/dnf install -y ocrmypdf')).toBe(true);
		expect(
			ran.some((argv) => argv.join(' ') === '/usr/bin/dnf install -y tesseract-langpack-eng'),
		).toBe(true);
	});

	test('the picked working languages decide the packs (lg-vlca → cat, once with lg-cat)', () => {
		const ctx = productionPlanCtx(variantOf('debian13') as never, undefined, {
			langs: ['lg-cat', 'lg-chi'],
			app_lang_default: 'lg-cat',
			data_lang_default: 'lg-cat',
		});
		const desired = desiredPackages(ctx).filter((name) => name.startsWith('tesseract-ocr-'));
		expect(desired).toEqual(['tesseract-ocr-cat', 'tesseract-ocr-chi-sim', 'tesseract-ocr-osd']);
		expect(ocrModelPlanFor(['lg-cat', 'lg-vlca']).models).toEqual(['cat', 'osd']);
	});

	test('only what the facts say is missing: an installed pack is not installed again', () => {
		const bare = defaultCtx('debian13');
		const ctx: HostPlanCtx = {
			...bare,
			facts: { ...bare.facts, packages: ['tesseract-ocr-spa'] },
		};
		const argv = argvOf(ctx);
		expect(argv).toContain('tesseract-ocr-eng');
		expect(argv).not.toContain('tesseract-ocr-spa');
		const el = defaultCtx('el10');
		const elCtx: HostPlanCtx = { ...el, facts: { ...el.facts, packages: ['tesseract-osd'] } };
		expect(argvOf(elCtx)).not.toContain('tesseract-osd');
	});

	test('a working language Tesseract has no model for is TOLD, never fatal, never guessed', () => {
		const plan = ocrModelPlanFor(['lg-eng', 'lg-xyz']);
		expect(plan).toEqual({ models: ['eng', 'osd'], unmapped: ['lg-xyz'] });
		const told = ocrLangsToldFor(plan.unmapped);
		expect(told.length).toBe(1);
		expect(told[0]).toContain('lg-xyz');
		expect(ocrLangsToldFor([])).toEqual([]);
	});

	test('the Review to-do tells nothing about OCR when every working language has a model', () => {
		const ctx = defaultCtx('debian13');
		expect(reviewTodo(ctx, NO_FILES, Date.now()).some((line) => line.includes('OCR'))).toBe(false);
	});
});
