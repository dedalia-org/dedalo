/**
 * Fills a gazetteer data directory for fila #14 ("Imperio Romano") — the store
 * the `gazetteer_data_path` tool option points at (`server/gazetteer_store.ts`).
 *
 * The tool ships NO gazetteer data (Sergio, 2026-09-16): 20 MB of a third
 * party's datasets do not belong in the engine's tree. This script is how an
 * install gets them — ops tooling, never part of a request path, and it lives
 * in the tool (not in the local-only `dev/`) because a capability nobody can
 * provision is a capability nobody has.
 *
 *   bun tools/tool_uca_maps/gazetteers/provision.ts --out <dir> \
 *       [--from-v6 <path to tool_leaflet_special_tools>]
 *
 *  · Pleiades: the name→id index is BUILT here from Pleiades' own published
 *    dumps (atlantides.org), places + names deduplicated — so it can be
 *    rebuilt on any install, at any date, instead of being a frozen copy.
 *  · Pelagios: the Roman-world layers are copied from an existing v6 tool
 *    checkout. No canonical download URL for them is pinned here because none
 *    was verified (DARE publishes at dh.gu.se; `imperium.ahlfeldt.se`'s own
 *    data zip 404s today) — inventing one would be a URL that rots silently.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const PLEIADES_DUMPS = [
	'https://atlantides.org/downloads/pleiades/dumps/pleiades-places-latest.csv.gz',
	'https://atlantides.org/downloads/pleiades/dumps/pleiades-names-latest.csv.gz',
];

/** The layers `gazetteer_store.ts` knows how to serve. */
const PELAGIOS_DATASETS = [
	'places_high',
	'places_medium',
	'places_low',
	'places_subsites',
	'fortifications',
	'provinces',
	'provinces_label',
	'roads_high',
	'roads_low',
	'10m_lakes',
	'10m_lakes_label',
	'10m_rivers_lake_centerlines',
];

function arg(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index === -1 ? undefined : Bun.argv[index + 1];
}

/**
 * One CSV row → fields, honouring double-quoted fields with embedded commas
 * (the dumps carry both: author lists and inline JSON geometry).
 */
function splitCsvRow(line: string): string[] {
	const fields: string[] = [];
	let current = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			if (quoted && line[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				quoted = !quoted;
			}
		} else if (char === ',' && !quoted) {
			fields.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	fields.push(current);
	return fields;
}

/** Downloads one dump and yields its [title, place id] pairs. */
async function readDump(url: string): Promise<[string, string][]> {
	console.log(`fetching ${basename(url)}…`);
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`${url} answered ${response.status}`);
	}
	const csv = new TextDecoder().decode(
		Bun.gunzipSync(new Uint8Array(await response.arrayBuffer())),
	);

	const [header, ...rows] = csv.split('\n');
	const columns = splitCsvRow(header ?? '');
	const titleIndex = columns.indexOf('title');
	// the places dump names the place in `path`; the names dump points at it with `pid`
	const pidIndex = columns.indexOf('pid');
	const pathIndex = columns.indexOf('path');
	if (titleIndex === -1 || (pidIndex === -1 && pathIndex === -1)) {
		throw new Error(`${url}: unexpected columns`);
	}

	const pairs: [string, string][] = [];
	for (const row of rows) {
		if (row.trim() === '') continue;
		const fields = splitCsvRow(row);
		const title = (fields[titleIndex] ?? '').trim();
		const reference = (fields[pidIndex] ?? fields[pathIndex] ?? '').trim();
		const id = reference.replace(/^\/places\//, '').split('/')[0] ?? '';
		if (title === '' || !/^[0-9]+$/.test(id)) continue;
		pairs.push([title, id]);
	}
	return pairs;
}

async function buildPleiadesIndex(outDir: string): Promise<void> {
	const seen = new Set<string>();
	const index: [string, string][] = [];
	for (const url of PLEIADES_DUMPS) {
		for (const [title, id] of await readDump(url)) {
			const key = `${title}|${id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			index.push([title, id]);
		}
	}
	const target = join(outDir, 'pleiades.json');
	await Bun.write(target, JSON.stringify(index));
	console.log(`wrote ${target} (${index.length} names)`);
}

async function copyPelagiosLayers(outDir: string, v6Dir: string): Promise<void> {
	const source = join(v6Dir, 'services', 'pelagios', 'data');
	if (!existsSync(source)) {
		throw new Error(`no Pelagios data under ${source}`);
	}
	const target = join(outDir, 'pelagios');
	mkdirSync(target, { recursive: true });

	let copied = 0;
	for (const dataset of PELAGIOS_DATASETS) {
		const file = join(source, `${dataset}.geojson`);
		if (!existsSync(file)) {
			console.log(`skipped ${dataset}: not in this v6 checkout`);
			continue;
		}
		await Bun.write(join(target, `${dataset}.geojson`), Bun.file(file));
		copied++;
	}
	console.log(`copied ${copied} Pelagios layers into ${target}`);
}

const out = arg('--out');
if (!out) {
	console.error('usage: --out <dir> [--from-v6 <path to tool_leaflet_special_tools>]');
	process.exit(1);
}
const outDir = resolve(out);
mkdirSync(outDir, { recursive: true });

await buildPleiadesIndex(outDir);

const v6 = arg('--from-v6');
if (v6) {
	await copyPelagiosLayers(outDir, resolve(v6));
} else {
	console.log(
		'no --from-v6 given: the Pelagios layers are not installed (Pleiades and DARE still work).',
	);
}

console.log(`Set the tool option "gazetteer_data_path" to: ${outDir}`);
