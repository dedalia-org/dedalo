/**
 * Boot-sequence latency probe: replays the byte-identical client's cold
 * page-load ping-pong over HTTP against the TS dev server — login, then per
 * scenario `start` (serial, gates everything) followed by read(menu) ∥
 * read(section) exactly as the client fires them (page.js:514 → render_page
 * parallel element loop) — plus a static-asset pass over the boot-critical
 * files (index.html, main.css, the ES-module graph head) recording bytes,
 * validators (ETag/Last-Modified) and negotiated compression.
 *
 * Baseline consumer: rewrite/LEDGER.md "Measured baselines" (boot probe row).
 * Protocol: run once against a FRESHLY RESTARTED server (`bun run dev`) — the
 * `first` column is the data-cache-cold number; the stats columns are the
 * warm steady state. The script cannot restart the server for you.
 *
 * Usage: bun run scripts/boot_probe.ts [--iterations=30] [--json] [--oracle]
 *        [--heavy=numisdata6] [--lang=lg-spa] [--no-assets]
 *   --oracle  also replays the same sequence against the live PHP server
 *             (config.phpReference) for a side-by-side (spec §10 metric).
 */

import { config } from '../src/config/config.ts';
import { readEnv } from '../src/config/env.ts';
import { devTcpListener } from '../src/config/tcp_listener.ts';
import { PhpApiClient } from '../test/parity/php_client.ts';

// --- args --------------------------------------------------------------------
const args = new Map<string, string>();
for (const raw of Bun.argv.slice(2)) {
	const match = /^--([a-z-]+)(?:=(.*))?$/.exec(raw);
	if (match?.[1] !== undefined) args.set(match[1], match[2] ?? 'true');
}
const ITERATIONS = Number(args.get('iterations') ?? 30);
const AS_JSON = args.get('json') === 'true';
const WITH_ORACLE = args.get('oracle') === 'true';
const WITH_ASSETS = args.get('no-assets') !== 'true';
const HEAVY_SECTION = args.get('heavy') ?? 'numisdata6';
const LANG = args.get('lang') ?? 'lg-spa';

const TS_PORT = (readEnv('SERVER_TCP_PORT') ?? '3500') as string;
// The dev server's scheme follows its configuration: a developer-route install
// serves HTTPS from a local authority (SERVER_TCP_TLS_*). Bun's fetch rejects
// that authority's IP name constraint (Bun 1.4.3: "unsupported name constraint
// type"), so this probe refuses loudly rather than timing a failed handshake.
if (devTcpListener(TS_PORT, '127.0.0.1')?.tls) {
	console.error(
		'[boot_probe] the dev listener is configured for HTTPS (SERVER_TCP_TLS_*); this probe speaks plain HTTP. Start the server with SERVER_TCP_TLS_CERT_FILE= SERVER_TCP_TLS_KEY_FILE= bun run dev, and run this probe with the same two empty keys.',
	);
	process.exit(2);
}
const TS_ORIGIN = `http://localhost:${TS_PORT}`;
const TS_API_URL = `${TS_ORIGIN}/dedalo/core/api/v1/json/`;

// --- stats (scripts/benchmark_read.ts pattern) --------------------------------
interface Stats {
	p50: number;
	p95: number;
	mean: number;
}
function stats(samples: number[]): Stats {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (q: number) =>
		sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
	return {
		p50: at(0.5),
		p95: at(0.95),
		mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
	};
}
const ms = (value: number) => `${value.toFixed(1)}ms`;
const fmt = (s: Stats) => `p50 ${ms(s.p50)}  p95 ${ms(s.p95)}  mean ${ms(s.mean)}`;

// --- RQO builders (wire shapes: start_differential / menu_differential /
// context_differential parity gates — the client's exact cold-boot calls) ------
interface Scenario {
	name: string;
	searchObj: Record<string, string>;
	sectionRqo: Record<string, unknown>;
}

function listReadRqo(tipo: string): Record<string, unknown> {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			model: 'section',
			tipo,
			section_tipo: tipo,
			mode: 'list',
			lang: LANG,
			action: 'search',
		},
		sqo: { section_tipo: [tipo], limit: 10, offset: 0 },
	};
}

function editReadRqo(tipo: string, sectionId: string): Record<string, unknown> {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			model: 'section',
			tipo,
			section_tipo: tipo,
			mode: 'edit',
			lang: LANG,
			action: 'search',
		},
		sqo: {
			section_tipo: [tipo],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: tipo, section_id: sectionId }],
		},
	};
}

const MENU_RQO = {
	action: 'read',
	dd_api: 'dd_core_api',
	prevent_lock: true,
	source: {
		typo: 'source',
		model: 'menu',
		tipo: 'dd85',
		section_tipo: 'dd85',
		action: 'get_data',
		mode: 'list',
		lang: LANG,
	},
};

function startRqo(searchObj: Record<string, string>): Record<string, unknown> {
	return {
		action: 'start',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: { search_obj: searchObj, menu: true },
	};
}

const SCENARIOS: Scenario[] = [
	{
		name: `main-list (${config.mainSection})`,
		searchObj: { t: config.mainSection, m: 'list' },
		sectionRqo: listReadRqo(config.mainSection),
	},
	{
		name: `heavy-list (${HEAVY_SECTION})`,
		searchObj: { t: HEAVY_SECTION, m: 'list' },
		sectionRqo: listReadRqo(HEAVY_SECTION),
	},
	{
		name: `heavy-edit (${HEAVY_SECTION} id=1)`,
		searchObj: { t: HEAVY_SECTION, m: 'edit', id: '1' },
		sectionRqo: editReadRqo(HEAVY_SECTION, '1'),
	},
];

// --- probe A: the ping-pong ----------------------------------------------------
interface SequenceSample {
	start: number;
	menu: number;
	section: number;
	/** start + max(menu, section) — what the user actually waits for. */
	criticalPath: number;
}

function assertOk(label: string, body: Record<string, unknown>): void {
	if (body.result === false || body.result === null || body.result === undefined) {
		throw new Error(`${label} failed: ${JSON.stringify(body.msg ?? body).slice(0, 300)}`);
	}
}

async function runSequence(client: PhpApiClient, scenario: Scenario): Promise<SequenceSample> {
	const t0 = performance.now();
	const startResponse = await client.call(startRqo(scenario.searchObj));
	const startMs = performance.now() - t0;
	assertOk(`start[${scenario.name}]`, startResponse.body);
	const startResult = startResponse.body.result as { context?: unknown[] };
	if (!Array.isArray(startResult.context) || startResult.context.length === 0) {
		throw new Error(
			`start[${scenario.name}] returned no context — nothing for the client to render`,
		);
	}
	if (typeof startResponse.body.csrf_token !== 'string') {
		throw new Error(`start[${scenario.name}] returned no csrf_token`);
	}

	// The client fires these in parallel after start (render_page.js element loop).
	const timed = async (rqo: Record<string, unknown>, label: string): Promise<number> => {
		const from = performance.now();
		const { body } = await client.call(structuredClone(rqo));
		const took = performance.now() - from;
		assertOk(label, body);
		return took;
	};
	const [menuMs, sectionMs] = await Promise.all([
		timed(MENU_RQO, `read-menu[${scenario.name}]`),
		timed(scenario.sectionRqo, `read-section[${scenario.name}]`),
	]);

	return {
		start: startMs,
		menu: menuMs,
		section: sectionMs,
		criticalPath: startMs + Math.max(menuMs, sectionMs),
	};
}

interface ScenarioReport {
	name: string;
	first: SequenceSample;
	warm: { start: Stats; menu: Stats; section: Stats; criticalPath: Stats };
}

async function probeApi(apiUrl: string, engine: string): Promise<ScenarioReport[]> {
	const client = new PhpApiClient(apiUrl);
	const loggedIn = await client.login(
		config.phpReference.username as string,
		config.phpReference.password as string,
	);
	if (!loggedIn) throw new Error(`${engine}: login failed at ${apiUrl} (dev credentials)`);

	const reports: ScenarioReport[] = [];
	for (const scenario of SCENARIOS) {
		const first = await runSequence(client, scenario);
		const samples: SequenceSample[] = [];
		for (let i = 0; i < ITERATIONS; i++) {
			samples.push(await runSequence(client, scenario));
		}
		reports.push({
			name: scenario.name,
			first,
			warm: {
				start: stats(samples.map((sample) => sample.start)),
				menu: stats(samples.map((sample) => sample.menu)),
				section: stats(samples.map((sample) => sample.section)),
				criticalPath: stats(samples.map((sample) => sample.criticalPath)),
			},
		});
	}
	return reports;
}

// --- probe B: boot-critical static assets ---------------------------------------
interface AssetSample {
	path: string;
	status: number;
	bytes: number;
	ms: number;
	etag: string | null;
	lastModified: string | null;
	cacheControl: string | null;
	contentEncoding: string | null;
	conditional304: boolean | null;
}

const IMPORT_RE = /(?:from|import)\s+['"](\.[^'"]+)['"]/g;

/** index.html + main.css + the head of the ES-module boot graph (≤ maxFiles). */
async function discoverBootAssets(origin: string, maxFiles: number): Promise<string[]> {
	const pagePath = '/dedalo/core/page/';
	const found: string[] = [
		`${pagePath}index.html`,
		`${pagePath}css/main.css`,
		`${pagePath}js/head-init.js`,
	];
	const resolveRelative = (baseDir: string, relative: string): string => {
		const url = new URL(relative, `${origin}${baseDir}`);
		return url.pathname;
	};
	// BFS one level past index.js: index.js's imports, then theirs.
	const queue: string[] = [`${pagePath}js/index.js`];
	const seen = new Set<string>(found);
	while (queue.length > 0 && found.length < maxFiles) {
		const path = queue.shift() as string;
		if (seen.has(path)) continue;
		seen.add(path);
		found.push(path);
		const response = await fetch(`${origin}${path}`);
		if (!response.ok) continue;
		const source = await response.text();
		const baseDir = path.slice(0, path.lastIndexOf('/') + 1);
		for (const match of source.matchAll(IMPORT_RE)) {
			const resolved = resolveRelative(baseDir, match[1] as string);
			if (!seen.has(resolved) && !queue.includes(resolved)) queue.push(resolved);
		}
	}
	return found;
}

async function fetchAsset(origin: string, path: string, gzip: boolean): Promise<AssetSample> {
	const headers: Record<string, string> = gzip
		? { 'Accept-Encoding': 'gzip, br' }
		: { 'Accept-Encoding': 'identity' };
	const from = performance.now();
	const response = await fetch(`${origin}${path}`, { headers });
	const bytes = (await response.arrayBuffer()).byteLength;
	const took = performance.now() - from;
	const etag = response.headers.get('etag');
	const lastModified = response.headers.get('last-modified');

	// Conditional replay: does the server answer 304 to its own validators?
	let conditional304: boolean | null = null;
	if (etag !== null || lastModified !== null) {
		const conditionalHeaders: Record<string, string> = { ...headers };
		if (etag !== null) conditionalHeaders['If-None-Match'] = etag;
		if (lastModified !== null) conditionalHeaders['If-Modified-Since'] = lastModified;
		const revalidated = await fetch(`${origin}${path}`, { headers: conditionalHeaders });
		conditional304 = revalidated.status === 304;
		await revalidated.arrayBuffer();
	}

	return {
		path,
		status: response.status,
		bytes,
		ms: took,
		etag,
		lastModified,
		cacheControl: response.headers.get('cache-control'),
		contentEncoding: response.headers.get('content-encoding'),
		conditional304,
	};
}

interface AssetReport {
	files: number;
	totalBytes: number;
	totalMs: number;
	withValidators: number;
	served304: number;
	gzipped: number;
	samples: AssetSample[];
}

async function probeAssets(origin: string): Promise<AssetReport> {
	const paths = await discoverBootAssets(origin, 25);
	const samples: AssetSample[] = [];
	for (const path of paths) {
		samples.push(await fetchAsset(origin, path, true));
	}
	return {
		files: samples.length,
		totalBytes: samples.reduce((sum, sample) => sum + sample.bytes, 0),
		totalMs: samples.reduce((sum, sample) => sum + sample.ms, 0),
		withValidators: samples.filter((s) => s.etag !== null || s.lastModified !== null).length,
		served304: samples.filter((sample) => sample.conditional304 === true).length,
		gzipped: samples.filter((sample) => sample.contentEncoding !== null).length,
		samples,
	};
}

// --- run -----------------------------------------------------------------------
function printApiReport(engine: string, reports: ScenarioReport[]): void {
	console.log(`\n${engine} — ping-pong (${ITERATIONS} warm iterations per scenario)`);
	for (const report of reports) {
		console.log(`  ${report.name}`);
		console.log(
			`    first:  start ${ms(report.first.start)}  menu ${ms(report.first.menu)}  section ${ms(report.first.section)}  critical-path ${ms(report.first.criticalPath)}`,
		);
		console.log(`    start:          ${fmt(report.warm.start)}`);
		console.log(`    read(menu):     ${fmt(report.warm.menu)}`);
		console.log(`    read(section):  ${fmt(report.warm.section)}`);
		console.log(`    critical path:  ${fmt(report.warm.criticalPath)}`);
	}
}

function printAssetReport(engine: string, report: AssetReport): void {
	console.log(`\n${engine} — boot assets (${report.files} files)`);
	console.log(
		`  total ${(report.totalBytes / 1024).toFixed(0)}KB in ${ms(report.totalMs)} (serial)`,
	);
	console.log(
		`  validators (ETag/Last-Modified): ${report.withValidators}/${report.files}   conditional→304: ${report.served304}/${report.files}   compressed: ${report.gzipped}/${report.files}`,
	);
	const biggest = [...report.samples].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
	for (const sample of biggest) {
		console.log(
			`    ${sample.path}  ${(sample.bytes / 1024).toFixed(0)}KB ${ms(sample.ms)}  cache-control=${sample.cacheControl ?? '—'}  encoding=${sample.contentEncoding ?? '—'}`,
		);
	}
}

const output: Record<string, unknown> = {
	config: { iterations: ITERATIONS, lang: LANG, heavy: HEAVY_SECTION, tsOrigin: TS_ORIGIN },
};

const tsReports = await probeApi(TS_API_URL, 'TS');
output.ts = tsReports;
if (WITH_ASSETS) {
	output.tsAssets = await probeAssets(TS_ORIGIN);
}

if (WITH_ORACLE) {
	const phpApiUrl = config.phpReference.apiBaseUrl as string;
	if (!phpApiUrl) throw new Error('--oracle: PHP_API_BASE_URL not configured (private/.env)');
	output.php = await probeApi(phpApiUrl, 'PHP');
	if (WITH_ASSETS) {
		// Asset paths are /dedalo/core/page/… — strip the api suffix AND the
		// trailing /dedalo from the configured URL so the prefix isn't doubled.
		const url = new URL(phpApiUrl);
		const prefix = (url.pathname.split('/core/api/')[0] ?? '').replace(/\/dedalo$/, '');
		output.phpAssets = await probeAssets(`${url.origin}${prefix}`);
	}
}

if (AS_JSON) {
	console.log(JSON.stringify(output, null, 2));
} else {
	printApiReport('TS', tsReports);
	if (output.tsAssets) printAssetReport('TS', output.tsAssets as AssetReport);
	if (output.php) printApiReport('PHP (oracle)', output.php as ScenarioReport[]);
	if (output.phpAssets) printAssetReport('PHP (oracle)', output.phpAssets as AssetReport);
}
