/**
 * Local gazetteer store — the ONE door every local-dataset read of fila #14
 * ("Imperio Romano") goes through.
 *
 * WHY THE DATA IS NOT IN THE REPO (Sergio, 2026-09-16): v6 ships both
 * gazetteers INSIDE the tool — `services/pleiades/pleiades.json` (1.8 MB
 * name→id index) and `services/pelagios/data/*.geojson` (18 MB of Roman-world
 * layers). Vendoring 20 MB of a third party's data into a tree headed for a PR
 * to the official repository makes every clone carry a dataset it cannot
 * update and nobody reviews. So the tool ships NO data: an install points the
 * `gazetteer_data_path` tool-config option at a directory it owns, and the
 * functionality announces itself through `get_capabilities` exactly like GDAL
 * and ImageMagick already do (`capabilities.ts`) — present, or honestly absent.
 *
 * The config option is the TOOL's own `default_config` (register.json), not a
 * new core config key: the plan (§7 item 6) already prescribes that same
 * mechanism, empty by default, for the SSRF allowlist.
 *
 * PATH SAFETY: the directory comes from an install administrator, but the
 * dataset NAME arrives from the browser, so it is checked against the fixed
 * list below AND the resolved file is prefix-checked against the resolved
 * directory (a symlinked dataset name must not read outside the store).
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { DedaloError } from '../../../src/core/errors/index.ts';
import { getToolConfigValue } from '../../../src/core/tools/config.ts';

/** The tool-config option naming the directory that holds the data files. */
export const GAZETTEER_CONFIG_KEY = 'gazetteer_data_path';

/** v6: `services/pleiades/pleiades.json` — a flat array of [name, id] pairs. */
export const PLEIADES_INDEX_FILE = 'pleiades.json';

/**
 * The twelve layers v6 offers as checkboxes (`special_tools_roman_empire.js`
 * load_pelagios), each a `<name>.geojson` in the store's `pelagios/` subdir.
 * A CLOSED list: the client picks names from it, never a free path.
 */
export const PELAGIOS_DATASETS: readonly string[] = Object.freeze([
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
]);

/** Where each family lives under the configured directory. */
const PELAGIOS_SUBDIR = 'pelagios';

/**
 * The store is not configured, or the configured directory no longer holds
 * the file this action needs. `tool.dependency_unavailable` is the same class
 * a missing GDAL binary already raises (503, operator disclosure): an install
 * gap, never the caller's input.
 */
export function gazetteerUnavailable(message: string): DedaloError {
	return new DedaloError('tool.dependency_unavailable', { message });
}

/**
 * The configured store directory, or null when unset/unusable. Resolved
 * through `realpathSync` so the prefix check below compares canonical paths.
 */
export async function resolveGazetteerDir(): Promise<string | null> {
	const raw = String((await getToolConfigValue('tool_uca_maps', GAZETTEER_CONFIG_KEY, '')) ?? '');
	const trimmed = raw.trim();
	// relative would resolve against the server's cwd — an install setting
	// names a place on disk, not a path relative to however it was started
	if (trimmed === '' || !isAbsolute(trimmed)) {
		return null;
	}
	try {
		const real = realpathSync(trimmed);
		return statSync(real).isDirectory() ? real : null;
	} catch {
		return null;
	}
}

/**
 * Canonical path of one store file, or null when it escapes the store or is
 * absent. `relative` is built by this module's own callers from the closed
 * lists above — never concatenated from a raw client string.
 */
export function gazetteerFilePath(dir: string, relative: string): string | null {
	const target = resolve(dir, relative);
	if (target !== dir && !target.startsWith(dir + sep)) {
		return null;
	}
	if (!existsSync(target)) {
		return null;
	}
	// a symlink inside the store may still point outside it
	const real = realpathSync(target);
	return real === dir || real.startsWith(dir + sep) ? real : null;
}

/** Path of the Pleiades name→id index inside `dir`, or null if absent. */
export function pleiadesIndexPath(dir: string): string | null {
	return gazetteerFilePath(dir, PLEIADES_INDEX_FILE);
}

/** Path of one Pelagios dataset inside `dir`, or null if absent/unknown. */
export function pelagiosDatasetPath(dir: string, dataset: string): string | null {
	if (!PELAGIOS_DATASETS.includes(dataset)) {
		return null;
	}
	return gazetteerFilePath(dir, `${PELAGIOS_SUBDIR}/${dataset}.geojson`);
}

/** What `get_capabilities` reports about the local gazetteer store. */
export interface GazetteerCapability {
	/** An absolute, existing directory is configured. */
	configured: boolean;
	/** The Pleiades name→id index is present in it. */
	pleiades: boolean;
	/** Which of PELAGIOS_DATASETS are actually present (may be empty). */
	pelagios: string[];
}

/**
 * Probe the store. Reports WHAT is available, never WHERE — the capabilities
 * panel is a client payload, and the install's directory layout is not part
 * of the question "can I search Pleiades here". Never throws.
 */
export async function probeGazetteers(): Promise<GazetteerCapability> {
	// the config read is a DB query: a probe that answers "what do you have"
	// must degrade to "nothing", never propagate an outage as a 500 (and it is
	// what keeps `get_capabilities` answerable on the DB-less test tier)
	let dir: string | null = null;
	try {
		dir = await resolveGazetteerDir();
	} catch {
		return { configured: false, pleiades: false, pelagios: [] };
	}
	if (dir === null) {
		return { configured: false, pleiades: false, pelagios: [] };
	}
	return {
		configured: true,
		pleiades: pleiadesIndexPath(dir) !== null,
		pelagios: PELAGIOS_DATASETS.filter((name) => pelagiosDatasetPath(dir, name) !== null),
	};
}
