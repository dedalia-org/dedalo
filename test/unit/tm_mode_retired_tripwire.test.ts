/**
 * TRIPWIRE — the ddo/display mode 'tm' stays retired
 * (WC-2026-08-14-tm-ddo-mode-retired).
 *
 * WHY THIS EXISTS. `'tm'` used to mean two unrelated things at once: a ROW
 * SOURCE (read from matrix_time_machine rather than matrix) and a RENDER MODE
 * stamped on every dd15 ddo, context entry and data item. The second meaning
 * bought nothing — all 29 client `prototype.tm` slots were verbatim copies of
 * their `prototype.list` twin — while costing everything: each generic per-cell
 * policy gates on `ddoMode === 'list'`, so a synonym of `list` silently opted
 * dd15 out of ALL of them. That is how a Time Machine cell came to render a
 * 101 KB transcript raw where the section's own list rendered a 130-char
 * preview.
 *
 * A mode that is a synonym of `list` in every renderer is not a mode; it is a
 * hole in every policy keyed to `list`. Deleting it closes the hole BY
 * CONSTRUCTION — but only for as long as nobody reintroduces the token. Hence a
 * grep gate rather than a behavioural one: the failure this guards against is
 * someone writing `mode: 'tm'` again, and no behavioural test can see that
 * coming.
 *
 * THE SURVIVING MEANING. `sqo.mode === 'tm'` is untouched and load-bearing: it
 * is what routes a read to the matrix_time_machine backend. Setting it to
 * 'list' returns the caller section's LIVE records instead of its history —
 * silently, with no error, a correct-looking list of the wrong rows (this
 * happened once during the unification and is why the base SQO now carries an
 * inline warning). Read-only provenance travels on `source.data_source === 'tm'`
 * plus the server-stamped `consultation_only` section flag.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..');

/**
 * The ONLY sites where the token may still appear, each pinned to the SHAPE that
 * makes it legitimate and each carrying its reason. Keyed on file + a required
 * substring rather than on the file alone: a blanket file exemption would let a
 * genuine render-mode regression hide inside the very plumbing this guards.
 *
 * Every entry here is a ROW SOURCE (or an input alias for one). None is a render
 * mode. Adding an entry is a deliberate act that must say which it is.
 */
interface ExemptSite {
	readonly file: string;
	readonly contains: string;
	readonly reason: string;
}

const EXEMPT_SITES: readonly ExemptSite[] = [
	{
		file: 'src/core/section/read_facade.ts',
		contains: 'rqo.sqo as',
		reason:
			'the ACL-gate trigger reads sqo.mode through a cast — the ROW SOURCE, which decides whether the Time Machine access gate runs at all',
	},
	{
		file: 'src/core/section/read.ts',
		contains: "): 'tm' | 'temporal' | 'search' | null",
		reason:
			"the null-record KIND label — a data_source discriminator for the tool's preview pane, not a render mode",
	},
	{
		file: 'src/core/section/read.ts',
		contains: 'if (tmOverride !== null)',
		reason: 'returns that KIND label; tmOverride is a matrix_id, i.e. a data source',
	},
	{
		file: 'src/core/section/read.ts',
		contains: "source.mode === 'tm' ? 'list'",
		reason:
			"input tolerance: a browser holding a pre-retirement client still sends source.mode 'tm', which is normalized to list rather than refused (tool JS ships with no cachebust). Nothing downstream ever sees it",
	},
	{
		file: 'src/core/section/read_source.ts',
		contains: "if (mode === 'tm')",
		reason: 'pickReadSource itself — the ROW SOURCE selector, the surviving meaning of the token',
	},
	{
		file: 'src/core/api/handlers/dd_core_api.ts',
		contains: 'rqo.sqo as',
		reason:
			'the read-activity skip tests the ROW SOURCE, so a history read never appends a dd542 Activity row',
	},
	{
		file: 'tools/tool_time_machine/js/tool_time_machine.js',
		contains: 'mode',
		reason:
			"the tool's SQO row source: it is what routes the dd15 section instance's read to matrix_time_machine instead of the caller section's own table",
	},
	{
		file: 'client/dedalo/core/inspector/js/render_inspector.js',
		contains: 'mode',
		reason:
			"the inspector's two history blocks carry the same SQO row source; their dd15 section instances read matrix_time_machine, not the inspected section's own table",
	},
	{
		file: 'client/dedalo/test/client/js/test_pinned_record_view.js',
		contains: "mode: 'tm'",
		reason:
			"the pinned-record-view gate reproduces the inspector's load_component_history request verbatim: the `mode: 'tm'` is that SQO row source (the field it sits in is `sqo`), asking the dd15 section for matrix_time_machine rows — not a render mode",
	},
];

function isExempt(relative: string, line: string): boolean {
	return EXEMPT_SITES.some((site) => site.file === relative && line.includes(site.contains));
}

/** Source roots the gate walks. */
const ROOTS = ['src', 'client/dedalo', 'tools'];
const EXTENSIONS = ['.ts', '.js'];
/** Compiled/vendored artifacts and the frozen fixture store are not source. */
const SKIP_DIRS = new Set(['node_modules', 'fixtures', 'lib', 'vendor', 'dist', 'build']);

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			yield* walk(full);
		} else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) {
			yield full;
		}
	}
}

/** Strip line and block comments — prose about the retirement is not a usage. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * A RENDER-MODE use of 'tm': the token assigned to, or compared against, a
 * `mode` key. Row-source uses (`sqo.mode`, `data_source`, `type`) are excluded
 * by construction — they are matched and skipped first.
 */
const ROW_SOURCE = /(sqo\??\.mode|data_source|\btype\b|pickReadSource)/;
const MODE_USE = /\bmode\b\s*(?::|===?|!==?|=)\s*'tm'|'tm'\s*(?:===?|!==?)\s*[\w.?]*\bmode\b/;

describe('the ddo/display mode tm stays retired', () => {
	test('no source file assigns or compares a RENDER mode of tm', () => {
		const offenders: string[] = [];
		for (const root of ROOTS) {
			for (const file of walk(join(REPO, root))) {
				const relative = file.slice(REPO.length + 1);
				const body = stripComments(readFileSync(file, 'utf8'));
				for (const [index, line] of body.split('\n').entries()) {
					if (!line.includes("'tm'")) continue;
					if (ROW_SOURCE.test(line)) continue; // the surviving meaning
					if (!MODE_USE.test(line)) continue;
					if (isExempt(relative, line)) continue;
					offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
				}
			}
		}

		expect(
			offenders,
			`The ddo/display mode 'tm' is retired (WC-2026-08-14-tm-ddo-mode-retired).\n` +
				`These sites reintroduce it as a RENDER mode. If one is legitimate, add it to\n` +
				`EXEMPT_SITES in this file WITH ITS REASON — never silently.\n` +
				`Note: sqo.mode 'tm' is the ROW SOURCE and is always allowed.`,
		).toEqual([]);
	});

	test('every exemption is REAL, shape-pinned and reasoned (no stale free passes)', () => {
		// A gate whose exemption list quietly grows to cover everything is no gate.
		// Three ways an entry can rot, all fatal: the file is gone, the SHAPE it
		// pins no longer occurs (a stale free pass), or it carries no real reason.
		expect(EXEMPT_SITES.length).toBeGreaterThan(0);
		const stale: string[] = [];
		for (const site of EXEMPT_SITES) {
			expect(site.reason.length, `exemption ${site.file} must carry a reason`).toBeGreaterThan(40);
			let body: string;
			try {
				body = readFileSync(join(REPO, site.file), 'utf8');
			} catch {
				stale.push(`${site.file}: file does not exist`);
				continue;
			}
			const matches = stripComments(body)
				.split('\n')
				.some((line) => line.includes("'tm'") && line.includes(site.contains));
			if (!matches) stale.push(`${site.file}: no line matches ${JSON.stringify(site.contains)}`);
		}
		expect(
			stale,
			'A stale exemption is a silent widening of this gate — delete it or repoint it.',
		).toEqual([]);
	});

	test('no client prototype slot named tm survives', () => {
		// All 29 were verbatim aliases of prototype.list; a new one would silently
		// resurrect the second dispatch path this unification removed.
		const offenders: string[] = [];
		for (const root of ['client/dedalo', 'tools']) {
			for (const file of walk(join(REPO, root))) {
				const body = stripComments(readFileSync(file, 'utf8'));
				if (/\.prototype\.tm\s*=/.test(body)) offenders.push(file.slice(REPO.length + 1));
			}
		}
		expect(offenders, 'prototype.tm is retired — a TM cell renders through prototype.list').toEqual(
			[],
		);
	});

	test('the SQO row source is still reachable (the surviving meaning)', async () => {
		// Guards the opposite mistake: "retire 'tm'" must never be read as
		// "delete the row source". If this breaks, the Time Machine reads the
		// caller section's live records instead of its history.
		const { pickReadSource } = await import('../../src/core/section/read_source.ts');
		const { tmReadSource } = await import('../../src/core/resolve/read_tm.ts');
		expect(await pickReadSource('tm')).toBe(tmReadSource);
		expect(await pickReadSource('list')).not.toBe(tmReadSource);
	});
});
