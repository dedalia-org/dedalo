/**
 * The media-versions PANEL's three client-side contracts with the engine.
 *
 * All were invisible from the server side — the
 * build really did succeed, the API really did answer 'ok', and the panel still
 * sat blinking "Processing" forever. What failed was the completion step.
 *
 * 1. NO 'force_save'. PHP's panel finished a build by asking the component to
 *    save, so the new files_info would reach the record. The TS engine persists
 *    it on the build path itself, and `saveComponentData` REFUSES unknown save
 *    actions loudly — so that call could only ever 500. Asserted from both ends:
 *    the engine still refuses it (the refusal is the contract, not an accident),
 *    and no client sends it.
 *
 * 2. The refresh after a mutation must NOT destroy dependencies. The default
 *    `refresh()` destroys them, which nulls `main_element.context` — and the
 *    grid's re-render reads `main_element.context.features.default_quality` on
 *    its first line, so it threw before repainting a single cell. Every
 *    mutating path in the panel (build, delete_version, delete_quality,
 *    sync_files) therefore passes `destroy: false`.
 *
 * 3. BOTH SIDES OF THE UNSYNC COMPARISON COME FROM ONE ANSWER. The panel warns
 *    "files info data is unsync" when the record's stored files_info and the
 *    disk scan disagree. It took the disk side live and the DB side from the
 *    COMPONENT'S CACHED DATA — a snapshot from when the tool opened that no
 *    refresh re-reads — so every delete raised a warning about a record that was
 *    perfectly in sync, and a page reload made it vanish. `get_files_info` now
 *    returns `files_info_db` beside the scan, and the client reads the DB side
 *    only from there. Gated on the SERVER side (the field is emitted, and it is
 *    the stored value, not the scan) because that is the half a refactor would
 *    quietly drop.
 *
 * Static source assertions where the subject is vanilla JS with no DOM harness
 * in this suite — these are exactly the lines a future edit would silently
 * reintroduce.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { getFilesInfo } from '../../tools/tool_media_versions/server/media_versions.ts';

const REPO_ROOT = join(import.meta.dir, '../..');
const RENDER_JS = join(REPO_ROOT, 'tools/tool_media_versions/js/render_tool_media_versions.js');
const TOOL_JS = join(REPO_ROOT, 'tools/tool_media_versions/js/tool_media_versions.js');

describe('media-versions panel ↔ engine contract', () => {
	test("the engine refuses 'force_save' — the reason the client must not send it", async () => {
		// The seeded test3/1 (a save never creates a record — a nonexistent one would
		// be refused resource.not_found before the action check, WC-2026-11-10-save-never-creates).
		// The refusal rolls the save's transaction back, so nothing is written. If this
		// ever starts succeeding, 'force_save' became a real action and the client rule
		// below can be revisited.
		await expect(
			saveComponentData({
				componentTipo: 'test94',
				sectionTipo: 'test3',
				sectionId: 1,
				lang: 'lg-nolan',
				changedData: [{ action: 'force_save' } as never],
				userId: -1,
			} as never),
		).rejects.toThrow(/force_save/);
	});

	test('no client file sends a force_save', () => {
		for (const file of [RENDER_JS, TOOL_JS]) {
			const source = readFileSync(file, 'utf8');
			// The comment explaining WHY it is gone is allowed; a save call is not.
			const calls = source.match(/action\s*:\s*'force_save'/g) ?? [];
			expect(calls).toEqual([]);
		}
	});

	test('every refresh in the panel keeps its dependencies alive', () => {
		const source = readFileSync(RENDER_JS, 'utf8');
		// A BARE self.refresh() takes the destroying default — the exact defect.
		// It must not exist here; options are always explicit.
		expect(source.match(/self\.refresh\(\s*\)/g) ?? []).toEqual([]);
		// And every options block must say destroy:false.
		const blocks = source.match(/self\.refresh\(\{[^}]*\}\)/g) ?? [];
		expect(blocks.length).toBeGreaterThan(0);
		const destroying = blocks.filter((block) => !/destroy\s*:\s*false/.test(block));
		expect(destroying).toEqual([]);
	});

	test('get_files_info carries the STORED files_info beside the disk scan', async () => {
		// test94 on the canonical test3 playground: no media on disk, and the
		// record stores none either. Both sides must still be present and be
		// ARRAYS — the panel compares their lengths, so an absent field would read
		// as "0 entries" and silently un-warn a component that needs Regenerate.
		const response = (await getFilesInfo({
			options: { tipo: 'test94', section_tipo: 'test3', section_id: 1 },
			userId: -1,
		} as never)) as unknown as { data: { files_info: unknown; files_info_db: unknown } };
		expect(Array.isArray(response.data.files_info)).toBe(true);
		expect(Array.isArray(response.data.files_info_db)).toBe(true);
	});

	/**
	 * THE DELETE WIRING (2026-08-07). Deleting a master must re-source the derived
	 * tiers before the re-scan — the operator's decision 3. The ordering and the
	 * only-when-the-master-changed guard are gated on the core
	 * (media_two_masters.test.ts, driving `deleteAndResyncCore`), but the WIRING
	 * had no gate at all: stubbing both tool call sites left the whole media suite
	 * green. Source assertions, because driving the handler needs a stored media
	 * record; they pin exactly the regression — a handler that deletes without
	 * re-sourcing, or that swallows the rebuild failure.
	 */
	test('both delete actions go through deleteAndResyncCore, never a bare delete', () => {
		const source = readFileSync(
			join(REPO_ROOT, 'tools/tool_media_versions/server/media_versions.ts'),
			'utf8',
		);
		// Two handlers, two calls.
		expect((source.match(/deleteAndResyncCore\(/g) ?? []).length).toBe(2);
		// The bare cores bypass the rebuild — they must not be reachable from here.
		expect(source).not.toContain('deleteQualityCore(');
		expect(source).not.toContain('deleteVersionCore(');
	});

	test('a failed rebuild reaches the operator through msg, not only errors[]', () => {
		const source = readFileSync(
			join(REPO_ROOT, 'tools/tool_media_versions/server/media_versions.ts'),
			'utf8',
		);
		// render_tool_media_versions.js prints `msg` only when result===false, and
		// tool_media_versions.js delete_quality resolves `response.result` alone —
		// so `errors` on a successful delete is unreachable by the operator.
		expect((source.match(/withRebuildFailure\(/g) ?? []).length).toBe(3); // 2 uses + the definition
		// …and so is the fact that MORE FILES LEFT THE TIER than the operator named:
		// deleting a tier's own file takes its alternate-extension twins with it
		// (a twin is a companion, not an independent version — processing.ts
		// retireOrphanTwins), and one click removing a file nobody mentioned must be
		// said out loud in the SAME field, for the same reason.
		expect((source.match(/withRetiredTwins\(/g) ?? []).length).toBe(3);
		expect(source).toContain('retired: outcome.retired');
	});

	/**
	 * BUILD_VERSION'S TWO EXTENSION ARGUMENTS (2026-08-07, decision D8/Q4).
	 *
	 * The handler used to read `extension` and thread it in as the SOURCE selector
	 * (which master file to build FROM). It reads like a target, so an API caller
	 * sending `extension:'avif'` got a jpg built from whichever master that
	 * extension happened to resolve — a silent wrong answer, not an error. It is
	 * HARD-REMOVED with no alias: the client never sent it
	 * (tool_media_versions.js posts tipo/section/quality/async only), so nothing in
	 * the repo loses a capability, and a caller that did send it now gets the
	 * documented `target_extension` instead of a lie.
	 *
	 * Source assertions, scoped to the buildVersion FUNCTION BODY: `extension` is a
	 * legitimate argument of delete_version and conform_headers, where it really
	 * does name a file on disk, so a file-wide grep would be both a false positive
	 * here and a false negative there.
	 */
	describe('build_version: target_extension in, extension out', () => {
		/** The buildVersion handler's body — brace-matched, so the scan cannot drift. */
		function buildVersionBody(): string {
			const source = readFileSync(
				join(REPO_ROOT, 'tools/tool_media_versions/server/media_versions.ts'),
				'utf8',
			)
				// Comments first: the header above this handler EXPLAINS the removed
				// argument by name, and prose must never satisfy or trip a source gate.
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/(^|[^:])\/\/.*$/gm, '$1');
			const start = source.indexOf('export async function buildVersion(');
			expect(start).toBeGreaterThan(-1);
			const open = source.indexOf('{', start);
			let depth = 0;
			for (let i = open; i < source.length; i++) {
				if (source[i] === '{') depth++;
				else if (source[i] === '}') {
					depth--;
					if (depth === 0) return source.slice(open, i + 1);
				}
			}
			throw new Error('buildVersion: unbalanced body');
		}

		test('the handler reads target_extension and threads it to the core', () => {
			const body = buildVersionBody();
			expect(body).toContain('ctx.options.target_extension');
			expect(body).toMatch(/buildVersionCore\(/);
		});

		test('the handler no longer reads `extension` — hard removal, no alias', () => {
			const body = buildVersionBody();
			// `options.extension` in THIS handler could only ever be the source
			// selector again; the source selector is not the caller's to choose (it is
			// resolved from the disk by resolveMaster).
			expect(body).not.toMatch(/options\.extension\b/);
			expect(body).not.toMatch(/options\[['"]extension['"]\]/);
		});

		test('the other handlers keep their own `extension` (positive control)', () => {
			// Without this, the removal above would also pass on a file that lost the
			// argument everywhere — delete_version's extension names the FILE to move
			// and is not the same question at all.
			const source = readFileSync(
				join(REPO_ROOT, 'tools/tool_media_versions/server/media_versions.ts'),
				'utf8',
			);
			expect(source).toMatch(/options\.extension\b/);
		});

		test('a twin the host cannot write reaches the operator: errors + summary', () => {
			const body = buildVersionBody();
			// The tier BUILT, so the envelope stays ok:true — a THROW here would tell
			// the operator nothing was produced when the tier and its jpg were. The
			// refusal therefore travels in the PAYLOAD the panel renders.
			expect(body).toMatch(/errors:\s*built\.errors/);
			expect(body).toMatch(/built\.errors\.length/);
			expect(body).toMatch(/return ok\(/);
			expect(body).not.toMatch(/result:\s*false/);
		});
	});

	/**
	 * THE 3D THUMB IS CAPTURED, NOT BUILT (2026-08-08).
	 *
	 * For component_3d the thumb tier is a resize of the record's POSTERFRAME
	 * (DEDALO_QUALITY_THUMB: "3d | Will render the posterframe"), and a posterframe
	 * of a mesh can only come from something that can RENDER a mesh. Nothing on the
	 * server can: the panel's gear therefore has to drive the browser's viewer
	 * (component_3d.create_posterframe → service_upload → move_file_to_dir) and let
	 * the engine derive the thumb from the file it binds.
	 *
	 * Sending that click to `build_version` instead is not a missing feature but a
	 * MEASURED failure: the generic image branch handed `3d/web/0/<id>.glb` to
	 * ImageMagick and the operator got `identify: no decode delegate for this image
	 * format` in an alert. The server half now refuses that (tool_posterframe.test.ts
	 * — build_version thumb), so this is the half that keeps the panel from asking.
	 */
	test('a component_3d thumb click captures the posterframe from the viewer', () => {
		const source = readFileSync(RENDER_JS, 'utf8');
		// The routing decision, and that it is the one the click reads.
		expect(source).toMatch(
			/is_3d_posterframe\s*=\s*self\.main_element\.model===['"]component_3d['"]\s*&&\s*quality===THUMB_QUALITY/,
		);
		expect(source).toMatch(/is_3d_posterframe\s*\n?\s*\?\s*await create_3d_posterframe\(self\)/);
		// The capture goes through the COMPONENT's own method — the same one the edit
		// form fires after an upload — never a re-implementation of the upload dance.
		expect(source).toContain('await main_element.create_posterframe(viewer)');
		// The viewer-less fallback stays: rebuilding a thumb from a posterframe that
		// IS on disk must not depend on WebGL drawing the scene again.
		expect(source).toMatch(/await self\.build_version\(THUMB_QUALITY\)/);
	});

	/**
	 * THE OPERATOR HEARS WHAT THE ENGINE SAYS (2026-08-08).
	 *
	 * The server composes careful sentences for side effects the operator did not
	 * ask for and cannot see — "the accompanying alternate version(s) went with it
	 * (moved to the deleted folder, recoverable)", "the derived tiers could NOT be
	 * rebuilt", "not every configured format could be written" — and attaches them
	 * to a `result:true` response, because the action itself happened. The panel
	 * read `result` alone: one click could remove files nobody named, or leave a
	 * tier stale, and the only witness was the server log.
	 *
	 * Gated from BOTH ends, because either half alone is dead: the client must read
	 * the structured fields, and `delete_quality` must hand the whole response over
	 * instead of resolving the boolean it used to.
	 */
	describe('side effects of a SUCCESSFUL action reach the operator', () => {
		test('the panel reports errors/retired on a SUCCESSFUL action', () => {
			const source = readFileSync(RENDER_JS, 'utf8');
			expect(source).toContain('const report_side_effects = function(self, response)');
			// Envelope v2: the account lives in the PAYLOAD, reached through the ONE
			// accessor (`response_data`) — the retired compat mirror is gone.
			expect(source).toContain('const data = response_data(response)');
			// Triggered by STRUCTURED data, never by matching a sentence's prose —
			// a reworded sentence must not silently stop being shown.
			expect(source).toMatch(/const reported\s*=\s*data\.errors/);
			expect(source).toMatch(/Array\.isArray\(reported\)\s*\?\s*reported\s*:\s*\[\]/);
			expect(source).toMatch(/Array\.isArray\(data\.retired\)\s*\?\s*data\.retired\s*:\s*\[\]/);
			// Every mutating path calls it: build, delete_version, delete_quality, sync.
			expect(
				(source.match(/report_side_effects\(self, response\)/g) ?? []).length,
			).toBeGreaterThanOrEqual(4);
		});

		test('delete_quality resolves the WHOLE response, not just the boolean', () => {
			const source = readFileSync(TOOL_JS, 'utf8');
			const body = source.slice(source.indexOf('delete_quality = async function'));
			const head = body.slice(0, body.indexOf('}//end delete_quality'));
			// The line that threw the account away: `const result = response.result`
			// followed by `resolve(result)`.
			expect(head).not.toMatch(/resolve\(\s*result\s*\)/);
			expect(head).toMatch(/resolve\(\s*response\s*\)/);
		});
	});

	/**
	 * REGENERATE REALLY REGENERATES (2026-08-08). The control is labelled
	 * "Regenerate files", its tooltip promises "re-create alternatives and thumb",
	 * and it ships a "Delete normalized files" checkbox the client sends as
	 * `regenerate_options` — while the handler re-scanned the disk and built
	 * nothing, then reported success. A control that reports success for work it
	 * did not do is worse than a missing control.
	 */
	test('sync_files rebuilds derivatives and honours the checkbox', () => {
		const source = readFileSync(
			join(REPO_ROOT, 'tools/tool_media_versions/server/media_versions.ts'),
			'utf8',
		);
		const body = source.slice(source.indexOf('export async function syncFiles('));
		expect(body).toContain('regenerateMissingDerivatives(');
		// The operator's checkbox reaches the pass that acts on it…
		expect(body).toMatch(/delete_normalized_files/);
		expect(body).toMatch(/deleteNormalized:\s*options\.delete_normalized_files === true/);
		// …and a derivative that could not be rebuilt is reported, not swallowed.
		expect(body).toMatch(/errors:\s*rebuildErrors/);
	});

	/**
	 * ONE VIEWER WAIT, ON THE COMPONENT (2026-08-08). Capturing a 3D scene needs the
	 * lazily-mounted viewer; the media-versions gear waited for it and
	 * tool_posterframe did not, so the same action failed from one tool and worked
	 * from the other. The wait belongs to component_3d, and both callers use it.
	 */
	test('both posterframe entry points wait for the 3D viewer', () => {
		const component = readFileSync(
			join(REPO_ROOT, 'client/dedalo/core/component_3d/js/component_3d.js'),
			'utf8',
		);
		expect(component).toContain('component_3d.prototype.ensure_viewer');
		// create_posterframe itself waits, which is what fixes tool_posterframe.
		expect(component).toMatch(/viewer\s*=\s*viewer \|\| await self\.ensure_viewer\(\)/);
		// …and the panel does not keep a private copy of the wait.
		const panel = readFileSync(RENDER_JS, 'utf8');
		expect(panel).toContain('main_element.ensure_viewer()');
		expect(panel).not.toContain('const wait_for_viewer');
	});

	test('the client reads the DB side of the comparison from the server only', () => {
		const source = readFileSync(TOOL_JS, 'utf8');
		// The assignment that made the warning lie: files_info_db taken from the
		// component's cached entries. One occurrence survives ON PURPOSE as the
		// pre-request fallback, immediately overwritten by the server's answer —
		// so pin the count AND pin that the server assignment exists.
		const fromCache = source.match(/files_info_db\s*=\s*entries\[0\]/g) ?? [];
		expect(fromCache.length).toBe(1);
		// Envelope v2: the server's answer is a PAYLOAD field, read through the one
		// accessor — it used to sit on the body's top level, where nothing lives now.
		expect(source).toContain('const api_data = response_data(response)');
		expect(source).toContain('api_data?.files_info_db');
	});
});
