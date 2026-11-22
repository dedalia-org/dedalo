/**
 * THE DIFFUSION JOB REPORT'S DOWNLOAD LINK RIDES THE MEDIA ADDRESS (T2 D03-d, owner Q10).
 * Wire: WC-042 addendum 2026-11-22 (admin-facing links use `webBase`; published
 * data unchanged).
 *
 * A file publication (rdf/xml/json…) reports its consolidated artifacts —
 * `consolidated_files.{merged_url,zip_url}` + `diffusion_data[].file_url` — and
 * the tool's Download button opened them. Both ends assumed ONE origin: the
 * runner built the URL on the hardcoded `/dedalo/<mediaDir>`, and the client
 * prefixed `window.location.origin` to whatever came. On a split-origin install
 * (app on the Bun port, media on the web server that enforces the generated
 * protection rules) the link opened the APP's address and failed.
 *
 * Now: the runner builds the report URL on `config.media.webBase` (the media
 * address the client already receives everywhere else); the client prefixes its
 * own origin ONLY to a relative URL and opens an absolute one as given.
 *
 * Server half in a FRESH process: config freezes at first import and the suite
 * preload pins `DEDALO_MEDIA_WEB_BASE=''`, under which webBase IS the old
 * literal — an in-process assertion would pass with the defect intact.
 * RED before: `/dedalo/media/rdf/…` (the hardcoded base); the client helper did
 * not exist (every URL was origin-prefixed, an absolute one doubled).
 */

import { describe, expect, test } from 'bun:test';
import { report_download_url } from '../../tools/tool_diffusion/js/report_model.js';

const REPO_ROOT = `${import.meta.dir}/../..`;
const MEDIA_ORIGIN_BASE = 'http://media.example.test:8080/dedalo/media';

describe('diffusion job report URLs on a split-origin install', () => {
	test('server: the consolidated artifact URLs are built on the media web base', () => {
		const probe = Bun.spawnSync(
			[
				'bun',
				'-e',
				[
					'const { consolidatedFileResults } = await import("./src/diffusion/runner.ts");',
					'const out = await consolidatedFileResults([',
					'  { table_name: "consolidated_merged:/rdf/zz/all.rdf", count: 0 },',
					'  { table_name: "consolidated_zip:/rdf/zz/all.zip", count: 0 },',
					'  { table_name: "zz_table", count: 3 },',
					'], "rdf");',
					'console.log(JSON.stringify(out));',
					'process.exit(0);',
				].join('\n'),
			],
			{
				cwd: REPO_ROOT,
				env: { ...process.env, DEDALO_MEDIA_WEB_BASE: `${MEDIA_ORIGIN_BASE}/` },
			},
		);
		const stdout = probe.stdout.toString().trim();
		if (probe.exitCode !== 0) throw new Error(`child failed: ${probe.stderr.toString()}`);
		const out = JSON.parse(stdout.split('\n').pop() as string) as {
			tables: { table_name: string }[];
			fileResultFields: {
				consolidated_files: { merged_url: string; zip_url: string };
				diffusion_data: { file_url: string }[];
				diffusion_class: string;
			};
		};
		expect(out.fileResultFields.consolidated_files).toEqual({
			merged_url: `${MEDIA_ORIGIN_BASE}/rdf/zz/all.rdf`,
			zip_url: `${MEDIA_ORIGIN_BASE}/rdf/zz/all.zip`,
		});
		expect(out.fileResultFields.diffusion_data).toEqual([
			{ file_url: `${MEDIA_ORIGIN_BASE}/rdf/zz/all.rdf` },
			{ file_url: `${MEDIA_ORIGIN_BASE}/rdf/zz/all.zip` },
		]);
		expect(out.fileResultFields.diffusion_class).toBe('diffusion_rdf');
		// an ordinary table entry is not an artifact
		expect(out.tables.map((entry) => entry.table_name)).toEqual(['zz_table']);
	});

	test('server, default config: the URL stays the same-origin relative shape', () => {
		const probe = Bun.spawnSync(
			[
				'bun',
				'-e',
				[
					'const { consolidatedFileResults } = await import("./src/diffusion/runner.ts");',
					'const { config } = await import("./src/config/config.ts");',
					'const out = await consolidatedFileResults([{ table_name: "consolidated_zip:/xml/a.zip", count: 0 }], "xml");',
					'console.log(JSON.stringify({ url: out.fileResultFields.consolidated_files.zip_url, mediaDir: config.mediaDir }));',
					'process.exit(0);',
				].join('\n'),
			],
			{ cwd: REPO_ROOT, env: { ...process.env, DEDALO_MEDIA_WEB_BASE: '' } },
		);
		if (probe.exitCode !== 0) throw new Error(`child failed: ${probe.stderr.toString()}`);
		const out = JSON.parse(probe.stdout.toString().trim().split('\n').pop() as string) as {
			url: string;
			mediaDir: string;
		};
		expect(out.url).toBe(`/dedalo/${out.mediaDir}/xml/a.zip`);
	});

	test('client: an absolute URL opens as given, a relative one on the page origin', () => {
		const origin = 'http://app.example.test:3500';
		expect(report_download_url(`${MEDIA_ORIGIN_BASE}/rdf/zz/all.zip`, origin)).toBe(
			`${MEDIA_ORIGIN_BASE}/rdf/zz/all.zip`,
		);
		expect(report_download_url('https://media.example.test/x.zip', origin)).toBe(
			'https://media.example.test/x.zip',
		);
		expect(report_download_url('/dedalo/media/rdf/zz/all.zip', origin)).toBe(
			`${origin}/dedalo/media/rdf/zz/all.zip`,
		);
		// a protocol-relative URL already names its host: never prefixed
		expect(report_download_url('//media.example.test/x.zip', origin)).toBe(
			'//media.example.test/x.zip',
		);
		// a scheme the browser would EXECUTE is never opened
		expect(report_download_url('javascript:alert(1)', origin)).toBeNull();
		expect(report_download_url('', origin)).toBeNull();
	});
});
