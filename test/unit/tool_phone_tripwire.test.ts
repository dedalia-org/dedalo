/**
 * TOOL PHONE TRIPWIRE (DEC-12) — the phone contract for tools stays stated,
 * tokenised and ratcheted.
 *
 * The contract lives in `client/dedalo/core/tools_common/css/tool_responsive.less`
 * (no page-level horizontal scroll at @min_target_viewport, controls on screen and
 * ≥ 44px). The browser half — actually rendering each tool at 360px — is
 * `scripts/tool_viewport_check.ts`; this is the hermetic half:
 *
 * CORPUS: the tracked tree (`trackedRepoFiles`, the registered `git ls-files`
 * lister) — a tool or sheet must be tracked (or `git add -N`) to be seen.
 *
 *  1. RATCHET TOTALITY: every tool directory under tools/ is in exactly one of
 *     PHONE_CASES / NOT_YET_PHONE / HIDDEN_BY_CAPABILITY
 *     (test/helpers/tool_phone_ratchet.ts); no stale name. A new tool lands in
 *     NOT_YET_PHONE with a reason, never silently.
 *  1b. CAPABILITY COHERENCE (src/ai/capabilities.ts, the engine's own
 *     aiCapabilities() run in a child with PHONE_RUN_ENV in its process env):
 *     every PHONE_CASES tool is OFFERED under the run's pinned PHONE_RUN_ENV (a probe never depends on
 *     the machine's .env), every HIDDEN_BY_CAPABILITY tool is gated by its named
 *     flag and that flag is false — a stale hidden entry is red here, not only
 *     in the browser run.
 *  2. TOKENS, NOT LITERALS: every width @media in a tool sheet (tools/**\/*.less
 *     and tools_common/css) names a `@width_break_point_*` token (a `+ 1`
 *     complement allowed) — a literal width is a private breakpoint.
 *  3. ONE PHONE WIDTH: the literal the dd-modal shadow root must carry (it
 *     cannot read LESS) equals `@width_break_point_phone`, and the harness
 *     viewport / hit target equal `@min_target_viewport` / `@phone_hit_target`.
 *  4. The foundation is wired: tool_common.less imports tool_responsive.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AiCapabilities, toolOfferedByCapabilities } from '../../src/ai/capabilities.ts';
import { trackedRepoFiles } from '../helpers/css_reference_corpus.ts';
import { isGrantOnlyTool } from '../helpers/tool_directory_corpus.ts';
import {
	HIDDEN_BY_CAPABILITY,
	NOT_YET_PHONE,
	PHONE_CASES,
	PHONE_HIT_TARGET_PX,
	PHONE_RUN_ENV,
	PHONE_VIEWPORT,
} from '../helpers/tool_phone_ratchet.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const TOOLS_COMMON_CSS = join(REPO_ROOT, 'client/dedalo/core/tools_common/css');
const VARS_LESS = join(REPO_ROOT, 'client/dedalo/core/page/css/layout/vars.less');
const DD_MODAL = join(REPO_ROOT, 'client/dedalo/core/common/js/dd-modal.js');

const read = (path: string): string => readFileSync(path, 'utf8');
const TRACKED = trackedRepoFiles();

function lessVarPx(source: string, name: string): number {
	const match = source.match(new RegExp(`@${name}\\s*:\\s*(\\d+)px\\s*;`));
	if (!match?.[1]) throw new Error(`@${name} not found as a px value`);
	return Number(match[1]);
}

describe('tool phone ratchet', () => {
	const toolDirs = [
		...new Set(
			TRACKED.map((file) => file.match(/^tools\/(tool_[^/]+)\//)?.[1]).filter(
				(name): name is string => name !== undefined,
			),
		),
	].sort();

	test('census floor (anti-vacuity)', () => {
		expect(toolDirs.length).toBeGreaterThan(30);
	});

	test('every tool is in exactly one list, no stale names', () => {
		const proven = Object.keys(PHONE_CASES);
		const pending = [...Object.keys(NOT_YET_PHONE), ...Object.keys(HIDDEN_BY_CAPABILITY)];
		// A GRANT-ONLY tool has no surface to open on a phone — DERIVED from its own
		// register.json (tool_directory_corpus.isGrantOnlyTool), never listed; that it
		// really ships no client is the grant-only law (tools_register_validate).
		const grantOnly = toolDirs.filter(isGrantOnlyTool);
		expect(proven.filter((name) => pending.includes(name))).toEqual([]);
		expect(new Set(pending).size).toBe(pending.length);
		expect([...proven, ...pending].filter((name) => grantOnly.includes(name))).toEqual([]);
		expect([...proven, ...pending, ...grantOnly].sort()).toEqual(toolDirs);
	});

	test('every pending entry carries a substantive reason', () => {
		for (const [name, entry] of [
			...Object.entries(NOT_YET_PHONE),
			...Object.entries(HIDDEN_BY_CAPABILITY),
		]) {
			expect(`${name}: ${entry.reason.trim().length >= 8}`).toBe(`${name}: true`);
		}
	});
});

describe('tool phone ratchet vs AI capabilities', () => {
	/**
	 * The ENGINE's own aiCapabilities(), measured in a child whose process env
	 * carries `env` — exactly how the run's server sees PHONE_RUN_ENV (readEnv:
	 * process env wins over ../private/.env). No re-implementation of the rule.
	 */
	function capabilitiesInChild(env: Readonly<Record<string, string>>): AiCapabilities {
		const script = `
			const m = await import(${JSON.stringify(join(REPO_ROOT, 'src', 'ai', 'capabilities.ts'))});
			console.log(JSON.stringify(m.aiCapabilities()));
		`;
		const child = Bun.spawnSync(['bun', '-e', script], {
			cwd: REPO_ROOT,
			env: { ...(process.env as Record<string, string>), ...env },
		});
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		const lines = child.stdout.toString().trim().split('\n');
		return JSON.parse(lines[lines.length - 1] as string);
	}

	const run = capabilitiesInChild(PHONE_RUN_ENV);

	test('the pin really offers the assistant (the engine accepts its catalog)', () => {
		expect(run.assistant).toBe(true);
	});

	test('positive control: the same engine call without a usable pin hides the assistant', () => {
		const off = capabilitiesInChild({ ...PHONE_RUN_ENV, DEDALO_AGENT_HTTP_ENABLED: 'false' });
		expect(off.assistant).toBe(false);
		expect(toolOfferedByCapabilities('tool_assistant', off)).toBe(false);
		expect(toolOfferedByCapabilities('tool_export', off)).toBe(true);
	});

	test('every PHONE_CASES tool is offered under the run capabilities', () => {
		const unoffered = Object.keys(PHONE_CASES).filter(
			(tool) => !toolOfferedByCapabilities(tool, run),
		);
		expect(unoffered).toEqual([]);
	});

	test('every HIDDEN_BY_CAPABILITY tool is gated by its named flag, and that flag is off in the run', () => {
		const all: AiCapabilities = { assistant: true, semantic: true, identify: true };
		const stale: string[] = [];
		for (const [tool, entry] of Object.entries(HIDDEN_BY_CAPABILITY)) {
			const gatedByIt =
				toolOfferedByCapabilities(tool, all) &&
				!toolOfferedByCapabilities(tool, { ...all, [entry.capability]: false });
			if (!gatedByIt) stale.push(`${tool}: not gated by '${entry.capability}'`);
			else if (toolOfferedByCapabilities(tool, run))
				stale.push(`${tool}: '${entry.capability}' is on — move it back to PHONE_CASES`);
		}
		expect(stale).toEqual([]);
	});
});

describe('tool @media widths are tokens', () => {
	const sheets = TRACKED.filter(
		(file) =>
			/^tools\/.+\.less$/.test(file) ||
			/^client\/dedalo\/core\/tools_common\/css\/[^/]+\.less$/.test(file),
	);

	test('sheet floor (anti-vacuity)', () => {
		expect(sheets.length).toBeGreaterThan(30);
	});

	test('no literal width in a @media query', () => {
		const offenders: string[] = [];
		let judged = 0;
		for (const path of sheets) {
			const lines = read(join(REPO_ROOT, path)).split('\n');
			for (const [i, line] of lines.entries()) {
				const code = line.replace(/\/\/.*$/, '');
				if (!/@media\b/.test(code)) continue;
				for (const m of code.matchAll(/(?:max|min)-width\s*:\s*([^)]*\)?)/g)) {
					judged++;
					const value = (m[1] ?? '')
						.replace(/\)+\s*$/, '')
						.replace(/^\(/, '')
						.trim();
					if (!/^@width_break_point_\w+(\s*\+\s*1)?$/.test(value)) {
						offenders.push(`${path}:${i + 1}  ${line.trim()}`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
		expect(judged).toBeGreaterThan(20);
	});

	test('positive control: the matcher rejects a literal and accepts a token', () => {
		const judge = (v: string) => /^@width_break_point_\w+(\s*\+\s*1)?$/.test(v);
		expect(judge('520px')).toBe(false);
		expect(judge('@width_break_point_phone')).toBe(true);
		expect(judge('@width_break_point_0 + 1')).toBe(true);
	});
});

describe('one phone width everywhere', () => {
	const vars = read(VARS_LESS);

	test('dd-modal shadow-root phone query equals @width_break_point_phone', () => {
		const phone = lessVarPx(vars, 'width_break_point_phone');
		const modal = read(DD_MODAL);
		const block = modal.match(/PHONE:[\s\S]*?@media screen and \(max-width:\s*(\d+)px\)/);
		expect(block?.[1] ?? null).toBe(String(phone));
	});

	test('harness viewport equals @min_target_viewport; hit target equals @phone_hit_target', () => {
		expect(PHONE_VIEWPORT.width as number).toBe(lessVarPx(vars, 'min_target_viewport'));
		const responsive = read(join(TOOLS_COMMON_CSS, 'tool_responsive.less'));
		expect(PHONE_HIT_TARGET_PX).toBe(lessVarPx(responsive, 'phone_hit_target'));
	});

	test('tool_common.less imports the phone foundation', () => {
		expect(read(join(TOOLS_COMMON_CSS, 'tool_common.less'))).toMatch(
			/@import \(once\) "tool_responsive";/,
		);
	});
});
