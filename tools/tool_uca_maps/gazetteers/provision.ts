/**
 * Fills the directory the `gazetteer_data_path` tool option points at; the tool
 * ships no gazetteer data. Ops tooling, never on a request path.
 *
 *   bun tools/tool_uca_maps/gazetteers/provision.ts --out <dir> \
 *       [--from-v6 <path to tool_leaflet_special_tools>]
 *
 * Pleiades: the name→id index is built from Pleiades' own dumps (atlantides.org),
 * so any install can rebuild it. Pelagios: the layers are copied from a v6 tool
 * checkout, as no canonical download URL for them could be verified.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DedaloError } from '../../../src/core/errors/index.ts';
import { type HarvestDeps, harvestFetch } from '../../../src/core/harvest/harvest.ts';
import { harvestTooLarge, siteOf } from '../../../src/core/harvest/refusals.ts';

const PLEIADES_HOST = 'atlantides.org';

/** The two dumps weigh ~7 and ~4 MB today: room to grow, never unbounded. */
export const PLEIADES_DUMP_MAX_BYTES = 64 * 1024 * 1024;

/** ~26 and ~17 MB once decompressed (4x the gzip): the download ceiling bounds only
 * the compressed bytes, and a gzip expands without limit unless told one. */
export const PLEIADES_DUMP_MAX_EXPANDED_BYTES = 256 * 1024 * 1024;

const PLEIADES_DUMPS = [
	'https://atlantides.org/downloads/pleiades/dumps/pleiades-places-latest.csv.gz',
	'https://atlantides.org/downloads/pleiades/dumps/pleiades-names-latest.csv.gz',
];

/** The layers `gazetteer_store.ts` serves, copied rather than imported: that
 * module loads the engine's database config, which this script never needs.
 * Exported for the gate that keeps the two lists equal. */
export const PELAGIOS_DATASETS = [
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

/**
 * Downloads one dump and yields its [title, place id] pairs. A file on
 * another site: the harvesting door, https only, Pleiades' host only, with an
 * explicit byte ceiling. `deps` scripts the site in tests.
 */
export async function readDump(url: string, deps: HarvestDeps = {}): Promise<[string, string][]> {
	console.log(`fetching ${basename(url)}…`);
	const response = await harvestFetch(
		{
			url,
			hosts: [PLEIADES_HOST],
			requireHttps: true,
			maxBytes: PLEIADES_DUMP_MAX_BYTES,
		},
		deps,
	);
	if (!response.ok) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: `${url} answered ${String(response.status)}`,
		});
	}
	let expanded: Uint8Array;
	try {
		expanded = gunzipSync(response.bytes, { maxOutputLength: PLEIADES_DUMP_MAX_EXPANDED_BYTES });
	} catch (error) {
		if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
			throw harvestTooLarge(siteOf(url), PLEIADES_DUMP_MAX_EXPANDED_BYTES, error);
		}
		throw error;
	}
	const csv = new TextDecoder().decode(expanded);

	const [header, ...rows] = csv.split('\n');
	const columns = splitCsvRow(header ?? '');
	const titleIndex = columns.indexOf('title');
	// the places dump names the place in `path`; the names dump points at it with `pid`
	const pidIndex = columns.indexOf('pid');
	const pathIndex = columns.indexOf('path');
	if (titleIndex === -1 || (pidIndex === -1 && pathIndex === -1)) {
		throw new DedaloError('security.outbound_failed', { message: `${url}: unexpected columns` });
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
		throw new DedaloError('request.invalid_options', {
			message: `no Pelagios data under ${source}`,
		});
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

// a script, and a module its test imports: run only when invoked
if (import.meta.main) {
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
}
