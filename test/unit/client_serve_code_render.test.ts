/**
 * serve_code client render — the code-server (PUBLISH) panel, split out of
 * update_code on 2026-09-28 (WC-2026-09-28-maintenance-serve-code-widget).
 *
 * The build tests moved here verbatim from client_update_code_render.test.ts
 * with the code they pin; the new assertions pin the split itself: the build
 * action speaks to model `serve_code`, and the readout re-uses the consumer
 * panel's row helpers instead of a second copy of them.
 *
 * Honest limit: reads the source (no DOM), layout-blind (`flat`) so a re-format
 * cannot redden it. DB-less, network-less → hermetic tier.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WIDGETS = join(import.meta.dir, '..', '..', 'client/dedalo/core/area_maintenance/widgets');
const render_src = readFileSync(join(WIDGETS, 'serve_code/js/render_serve_code.js'), 'utf8');
/**
 * LAYOUT-BLIND view of render_src: no whitespace, no `;`, no trailing comma.
 * The file is biome-formatted (lint:browser budget) and may be re-formatted;
 * these assertions pin what the code SAYS, never how it is laid out. The same
 * normalization is applied to every needle, so a negative check matches ANY
 * layout of the forbidden code — stronger than a literal, not weaker.
 */
const flat = (text: string) =>
	text
		.replace(/\s+/g, '')
		.replace(/;/g, '')
		.replace(/,(?=[)\]}])/g, '');
const render_flat = flat(render_src);
const has = (needle: string) => render_flat.includes(flat(needle));
const css_src = readFileSync(join(WIDGETS, 'serve_code/css/serve_code.less'), 'utf8');
/** The row helpers the readout imports (release_facts lives there, shared). */
const status_src = readFileSync(join(WIDGETS, 'update_code/js/render_update_status.js'), 'utf8');
const master_labels = JSON.parse(
	readFileSync(join(import.meta.dir, '../../src/core/labels/master.json'), 'utf8'),
) as Record<string, string>;

describe('serve_code split', () => {
	test('the build action targets model serve_code, never update_code', () => {
		expect(
			has("model	: 'serve_code',\n\t\t\t\t\taction	: 'build_version_from_git_master'"),
			"model	: 'serve_code',\n\t\t\t\t\taction	: 'build_version_from_git_master'",
		).toBe(true);
		expect(has("model	: 'update_code'"), "model	: 'update_code'").toBe(false);
	});

	test('the readout re-uses the shared row helpers (one vocabulary, no copy)', () => {
		const shared = render_src.match(
			/import\s*\{([^}]*)\}\s*from\s*'\.\.\/\.\.\/update_code\/js\/render_update_status\.js'/,
		);
		expect(
			(shared?.[1] ?? '')
				.split(',')
				.map((name) => name.trim())
				.filter((name) => name !== '')
				.sort(),
		).toEqual([
			'CHANNELS',
			'channel_label',
			'check_counts',
			'check_row',
			'fact_row',
			'fold_section',
			'release_facts',
			'section',
			'verdict',
		]);
		for (const helper of [
			'section',
			'fact_row',
			'check_row',
			'verdict',
			'release_facts',
			'channel_label',
		]) {
			expect(status_src).toContain(`export const ${helper} = function(`);
			expect(has(`const ${helper} = function(`), `const ${helper} = function(`).toBe(false);
		}
		expect(status_src).toContain("export const CHANNELS = ['master', 'prerelease', 'dev']");
	});

	test('check-id-derived label keys were NOT renamed with the split', () => {
		// check_row resolves `update_code_check_<id>` / `update_code_note_<id>` at
		// RUNTIME, and code_server.checks rides through it: renaming one of those
		// keys to serve_code_* silently dropped its note (release_ref_current, caught
		// in review 2026-09-28). Every code-server check id keeps its update_code_ key.
		const status_ts = readFileSync(
			join(import.meta.dir, '../../src/core/update/status.ts'),
			'utf8',
		);
		const ids = [...status_ts.matchAll(/check\('([a-z_]+)'/g)].map((m) => m[1] as string);
		expect(ids.length).toBeGreaterThan(10);
		for (const id of ids) {
			expect(master_labels[`serve_code_check_${id}`], id).toBeUndefined();
			expect(master_labels[`serve_code_note_${id}`], id).toBeUndefined();
		}
		expect(master_labels.update_code_note_release_ref_current).toBeDefined();
	});

	test('a non-code-server (development entity) is told which key makes it one', () => {
		expect(has('serve_code_not_server'), 'serve_code_not_server').toBe(true);
		expect(master_labels.serve_code_not_server).toContain('IS_A_CODE_SERVER');
	});

	test('the status layout is the shared mixin, not a copy', () => {
		expect(css_src).toContain('.dd_update_status();');
		expect(css_src).toContain('button.build_button');
	});

	test('the build styles are scoped to the serve_code wrapper, and update_code has none left', () => {
		// build_form stamps `.light` on every submit button; the build button's own
		// weight must come from THIS widget's scope (serve_code.less), and a copy
		// left in update_code.less would style nothing and drift.
		const scope = css_src.slice(css_src.indexOf('.wrapper_widget.serve_code {'));
		expect(scope).toContain('.build_row {');
		expect(scope).toContain('button.build_button {');
		const update_css = readFileSync(join(WIDGETS, 'update_code/css/update_code.less'), 'utf8');
		expect(update_css).not.toContain('build_row');
		expect(update_css).not.toContain('build_button');
		// …and the compiled bundle carries the rule under the new wrapper
		const main_css = readFileSync(
			join(import.meta.dir, '../../client/dedalo/core/page/css/main.css'),
			'utf8',
		);
		expect(main_css).toMatch(/\.wrapper_widget\.serve_code > ?\.content_data \.build_row/);
	});

	test('no dead cross-widget event: nothing publishes what nobody subscribes to', () => {
		// 'build_code_done' was published for update_data_version, which never
		// subscribed to it. A build changes nothing THIS install runs.
		expect(has("publish('build_code_done'"), "publish('build_code_done'").toBe(false);
		expect(has('import {event_manager}'), 'import {event_manager}').toBe(false);
	});
});

describe('serve_code developer-builds', () => {
	test('the buttons send a CHANNEL, never a ref — the server resolves it', () => {
		// A client-baked 'v7' refused on every code server that does not carry
		// that branch ("Could not read src/core/update/version.ts at ref 'v7'").
		// Policy 2026-09-29: release = the newest vX.Y.Z tag (source.release_ref),
		// developer = the tip of `master` (source.dev_ref). The client only NAMES
		// them in the confirm; the request carries the channel alone.
		// (comments stripped: prose may say "branch:")
		const code = render_src.replace(/^\s*(\/\/|\*).*$/gm, '');
		expect(/\b(branch|ref)\s*:/.test(code)).toBe(false);
		expect(has('channel : channel'), 'channel : channel').toBe(true);
		expect(has('source.release_ref'), 'source.release_ref').toBe(true);
		expect(has('source.dev_ref'), 'source.dev_ref').toBe(true);
		// a channel with nothing to build says why instead of offering a button
		expect(has('serve_code_build_master_unavailable'), 'serve_code_build_master_unavailable').toBe(
			true,
		);
		expect(
			has('serve_code_build_developer_unavailable'),
			'serve_code_build_developer_unavailable',
		).toBe(true);
		expect(has('serve_code_build_developer_no_ref'), 'serve_code_build_developer_no_ref').toBe(
			true,
		);
		// the refs are NAMED placeholders: their position differs per language
		expect(has("replaceAll('%branch%'"), "replaceAll('%branch%'").toBe(true);
		expect(has("replaceAll('%tag%'"), "replaceAll('%tag%'").toBe(true);
		expect(master_labels.serve_code_build_developer_confirm).toContain('%branch%');
		expect(master_labels.serve_code_build_master_confirm).toContain('%tag%');
		// each row pairs with ITS channel's version (release tag's / master's)
		expect(has('source.release_version'), 'source.release_version').toBe(true);
		expect(has('source.dev_version'), 'source.dev_version').toBe(true);
	});

	test('every translation of both confirms keeps ONE named ref and TWO %s', () => {
		// The client substitutes %branch% / %tag% by NAME and then the two %s
		// POSITIONALLY (version, then path). A translator dropping the name ships
		// a sentence naming no ref; a third %s puts the path where the version
		// belongs — both silent, and both invisible to the labels tripwire (it
		// checks key sets, never placeholders).
		const catalog_dir = join(import.meta.dir, '../../src/core/labels/catalog');
		for (const [key, token] of [
			['serve_code_build_developer_confirm', '%branch%'],
			['serve_code_build_master_confirm', '%tag%'],
		] as const) {
			const sentences: Array<[string, string]> = [['master', master_labels[key] as string]];
			for (const file of readdirSync(catalog_dir).filter((name) => name.endsWith('.json'))) {
				const labels = JSON.parse(readFileSync(join(catalog_dir, file), 'utf8')) as Record<
					string,
					string
				>;
				// lg-eng carries no copy of master.json (the tripwire refuses duplicates)
				if (typeof labels[key] === 'string') sentences.push([file, labels[key]]);
			}
			expect(sentences.length).toBeGreaterThan(10);
			for (const [where, sentence] of sentences) {
				expect(`${key} ${where}: ${sentence.split(token).length - 1}`).toBe(`${key} ${where}: 1`);
				expect(`${key} ${where}: ${sentence.split('%s').length - 1}`).toBe(`${key} ${where}: 2`);
			}
		}
	});

	test('each build action is ONE entry with the archive it produces', () => {
		// The buttons and the archives were two blocks, and nothing said the first
		// writes the second. The readout now lays out a row per channel and calls
		// back to mount the action into it.
		expect(has('make_builder_mounter'), 'make_builder_mounter').toBe(true);
		// rendered through render_code_server_half, so a build can re-run it
		expect(
			/render_code_server_status\(\s*content_data_body,\s*code_server,\s*make_builder_mounter/.test(
				render_src,
			),
		).toBe(true);
		expect(
			has('render_code_server_half(value.code_server)'),
			'render_code_server_half(value.code_server)',
		).toBe(true);
		// the mounter also receives the ARTIFACT CELL and the facts it currently
		// shows: the in-flight state belongs on the row being rewritten, and the
		// before-value has to be captured before the refresh destroys this half.
		expect(
			has('mount_builder(channel, action, value, built || null)'),
			'mount_builder(channel, action, value, built || null)',
		).toBe(true);
		expect(has('build_row'), 'build_row').toBe(true);
		expect(has('serve_code_build_publish'), 'serve_code_build_publish').toBe(true);
		// an unbuilt channel still shows its row, saying so
		expect(status_src).toContain('update_code_not_built');
		// and archives of other versions are listed, never dropped
		expect(has('serve_code_other_archives'), 'serve_code_other_archives').toBe(true);
		// ONE writer for the archive facts, called from BOTH lists (the duplicate
		// is how the stale 'developer (not offered)' wording survived in one)
		expect(status_src).toContain('const release_facts = function(');
		expect((render_src.match(/release_facts\(/g) ?? []).length).toBe(2);
	});

	test('the build actions read as BUTTONS, weighted by channel', () => {
		// In the readout's label column a pale outline reads as a caption; the one
		// thing on the row that DOES something must not be the quietest mark on it.
		expect(has("button_class\t: 'primary'"), "button_class\t: 'primary'").toBe(true);
		expect(
			has("classList.add('build_button', def.button_class)"),
			"classList.add('build_button', def.button_class)",
		).toBe(true);
		expect(css_src).toContain('button.build_button');
	});

	test('a finished build REFRESHES the archive list beside the button', () => {
		// The row next to the button is a claim about the disk that the build just
		// changed: stale, it shows the old timestamp — or 'Not built yet' next to a
		// build that succeeded.
		expect(has('on_built'), 'on_built').toBe(true);
		expect(has('refresh_code_server'), 'refresh_code_server').toBe(true);
		// re-read from the SERVER, not from the value this render closed over
		expect(
			/refresh_code_server\s*=\s*async\s*\(build_mark\)\s*=>\s*\{[\s\S]{0,200}await self\.get_value\(\)/.test(
				render_src,
			),
		).toBe(true);
		// and the half is re-rendered from that fresh value, carrying the mark:
		// the whole half is replaced, so without it the new archive line appears
		// where the old one was with nothing saying which one is on screen.
		expect(
			has('render_code_server_half(fresh.code_server, build_mark)'),
			'render_code_server_half(fresh.code_server, build_mark)',
		).toBe(true);
		// a failed refresh must not take the panel down
		expect(
			/catch \(error\) \{[\s\S]{0,240}console\.error\('serve_code: could not refresh/.test(
				render_src,
			),
		).toBe(true);
	});
});

describe('serve_code build feedback', () => {
	test('the in-flight state is armed by the REQUEST, never by the click', () => {
		// build_form runs window.confirm synchronously and only then adds
		// `button_spinner`, before its first await — so a listener registered
		// after it sees the spinner iff the operator confirmed. Marking on click
		// would leave a declined confirm showing "building…" forever.
		expect(has("form.addEventListener('submit'"), "form.addEventListener('submit'").toBe(true);
		expect(
			has("classList.contains('button_spinner')"),
			"classList.contains('button_spinner')",
		).toBe(true);
		expect(
			has("artifact_cell.classList.add('building')"),
			"artifact_cell.classList.add('building')",
		).toBe(true);
		expect(has('serve_code_build_building'), 'serve_code_build_building').toBe(true);
		// the marker goes on the ARTIFACT cell, not on the button: the button
		// already reports the request; only the row can report that ITS file is
		// the one being rewritten.
		expect(
			has('(channel, node, artifact_cell, built_before) =>'),
			'(channel, node, artifact_cell, built_before) =>',
		).toBe(true);
	});

	test('the before-value is captured at mount and survives the refresh', () => {
		// the refresh destroys this half, so nothing could read it back off the
		// DOM afterwards — it has to be closed over when the row is built.
		expect(has('built_before'), 'built_before').toBe(true);
		expect(/previous\s*:\s*built_before/.test(render_src)).toBe(true);
		expect(has('channel\t\t: channel'), 'channel\t\t: channel').toBe(true);
		// …and reaches the renderer as the mark for that channel only
		expect(
			has('build_mark && build_mark.channel===channel'),
			'build_mark && build_mark.channel===channel',
		).toBe(true);
		expect(
			has('render_code_server_status = (parent, code_server, mount_builder, build_mark, details_open) =>'),
		).toBe(true);
	});

	test('the verdict is read off the STAMP, not asserted', () => {
		// "updated" must be a statement about the disk that the disk supports: a
		// build that wrote nothing leaves the stamp where it was, and the row
		// says THAT instead of claiming a change.
		expect(status_src).toContain('previous.stamp!==release.stamp');
		expect(status_src).toContain('update_code_build_updated');
		expect(status_src).toContain('update_code_build_unchanged');
		// the archive that did not exist before is an update, not "unchanged"
		expect(status_src).toContain('previous===null || previous.stamp!==release.stamp');
	});

	test('the before-value shows only what MOVED', () => {
		// Repeating the unchanged facts ("173 MB · 28/08/2026, 11:41:43" above,
		// "was 173 MB · 28/08/2026, 11:41:12" below) buries the one figure the
		// operator is reading for in three that did not change.
		expect(status_src).toContain('previous.bytes!==release.bytes');
		expect(status_src).toContain('same_day(previous.stamp, release.stamp)');
		expect(status_src).toContain('format_time');
		// and an UNCHANGED build renders no before-line at all: it would be
		// identical to the value above it, and the badge already says so.
		expect(/if \(!wrote\) \{\s*return null/.test(status_src)).toBe(true);
		expect(status_src).toContain('if (previous_text!==null)');
	});

	test('the value it replaced is spelled out, and every label is defined', () => {
		expect(status_src).toContain('build_file_previous');
		expect(status_src).toContain('update_code_build_previous');
		for (const key of [
			'serve_code_build_building',
			'update_code_build_previous',
			'update_code_build_unchanged',
			'update_code_build_updated',
		]) {
			expect(master_labels[key], `${key} is defined in master.json`).toBeDefined();
		}
		// one substitution slot: the size · date the row showed before
		expect(((master_labels.update_code_build_previous ?? '').match(/%s/g) ?? []).length).toBe(1);
		// and the states have somewhere to render
		expect(css_src).toContain('&.building');
		expect(css_src).toContain('.build_file_previous');
		expect(css_src).toContain('&.built_updated');
	});
});

describe('serve_code prerelease channel (RELEASE_IDENTITY_DESIGN §2.8 item 1)', () => {
	test('a third row, Build prerelease, beside Build release — the server resolves its tag', () => {
		// the readout lists the channels in this order; the button sends the channel alone
		expect(status_src).toContain("export const CHANNELS = ['master', 'prerelease', 'dev']");
		expect(has('serve_code_build_prerelease'), 'serve_code_build_prerelease').toBe(true);
		expect(has('source.prerelease_ref'), 'source.prerelease_ref').toBe(true);
		// none above the newest release: the row says why instead of a button
		expect(
			has('serve_code_build_prerelease_unavailable'),
			'serve_code_build_prerelease_unavailable',
		).toBe(true);
		// several betas share one triple: the row pairs with its archive by IDENTITY
		expect(
			has("release.channel === 'prerelease' ? release.identity : release.version"),
			"release.channel === 'prerelease' ? release.identity : release.version",
		).toBe(true);
		expect(status_src).toContain('update_code_channel_prerelease');
	});

	test('every translation of the prerelease confirm keeps each NAMED placeholder exactly once', () => {
		// all three are substituted by NAME (their order differs per language); a dropped
		// or doubled one ships a sentence naming no tag, or the file twice.
		const catalog_dir = join(import.meta.dir, '../../src/core/labels/catalog');
		const key = 'serve_code_build_prerelease_confirm';
		const sentences: Array<[string, string]> = [['master', master_labels[key] as string]];
		for (const file of readdirSync(catalog_dir).filter((name) => name.endsWith('.json'))) {
			const labels = JSON.parse(readFileSync(join(catalog_dir, file), 'utf8')) as Record<
				string,
				string
			>;
			if (typeof labels[key] === 'string') sentences.push([file, labels[key]]);
		}
		expect(sentences.length).toBeGreaterThan(10);
		for (const [where, sentence] of sentences) {
			for (const token of ['%identity%', '%tag%', '%file%']) {
				expect(`${where} ${token}: ${sentence.split(token).length - 1}`).toBe(
					`${where} ${token}: 1`,
				);
				expect(has(`replaceAll('${token}'`), `replaceAll('${token}'`).toBe(true);
			}
			expect(`${where}: ${sentence.split('%s').length - 1}`).toBe(`${where}: 0`);
		}
	});
});

describe('client constructors keep their prototype', () => {
	test('no client file assigns X.prototype.* where X is an arrow function', () => {
		// 2026-11-07: a biome useArrowFunction pass turned `render_serve_code = function ()`
		// into `() => true`; an arrow has no .prototype, so the module threw on load
		// and the Serve Code panel never rendered. Whole-client scan, not one file.
		const client = join(import.meta.dir, '..', '..', 'client/dedalo');
		const offenders: string[] = [];
		for (const rel of readdirSync(client, { recursive: true }) as string[]) {
			if (!rel.endsWith('.js') || rel.includes('node_modules') || rel.includes('/lib/')) continue;
			const src = readFileSync(join(client, rel), 'utf8');
			for (const [, name] of src.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm)) {
				if (new RegExp(`^${name.replace(/\$/g, '\\$')}\\.prototype\\.`, 'm').test(src)) offenders.push(`${rel}: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
