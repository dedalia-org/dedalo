/**
 * GDAL/OGR + ImageMagick availability probe, backing the `get_capabilities`
 * action (v6 oracle: none — this action is NEW, see plan_implementacion.md §3.2).
 *
 * v6's tool assumed GDAL was always on PATH and let a missing binary fail deep
 * inside a conversion (`raster_download`, `vector_download`, hito 3) with a
 * generic error. `get_capabilities` lets the client ask FIRST and grey out the
 * export buttons a binary-less install cannot serve, instead of a user
 * discovering the gap mid-conversion.
 *
 * DISCOVERY: no core config key exists for GDAL (media/engine/binaries.ts's
 * install-configured resolution — CLAUDE.local.md forbids inventing one without
 * asking; Ágora consulta 3, plan §6, is open on whether GDAL conversions should
 * even live behind spawn.ts). Until that answer lands, this probes `$PATH` via
 * `Bun.which` — a plain existence question, not a decision about which install
 * config a later conversion step will read from. `raster_download` /
 * `vector_download` (hito 3) resolve their own binary the same way, once.
 *
 * ImageMagick reuses the CORE resolver (`media/engine/binaries.ts`) — that one
 * IS install-configured (`config.media.binaries.magick`), already reused by the
 * whole media subsystem, and required reading the file, not adding to it.
 */

import { identifyAvailable, resolveIdentify } from '../../../src/core/media/engine/binaries.ts';
import { runBinary } from '../../../src/core/media/engine/spawn.ts';

/** One external binary's availability, resolved path and self-reported version. */
export interface BinaryCapability {
	available: boolean;
	path: string | null;
	version: string | null;
}

/** First non-empty line of a version banner (`gdalinfo --version` → one line). */
function firstLine(text: string): string | null {
	const line = text.split('\n')[0]?.trim();
	return line !== undefined && line !== '' ? line : null;
}

/**
 * Resolve `name` on $PATH and confirm it actually runs `versionArgs`
 * successfully — a stale/broken binary on PATH must report unavailable, not a
 * path that later fails every real conversion.
 */
async function probeOnPath(
	name: string,
	versionArgs: readonly string[],
): Promise<BinaryCapability> {
	const resolved = Bun.which(name);
	if (resolved === null) {
		return { available: false, path: null, version: null };
	}
	const probe = await runBinary([resolved, ...versionArgs], { timeoutMs: 5000, nice: false });
	return {
		available: probe.ok,
		path: resolved,
		version: probe.ok ? firstLine(probe.stdout) : null,
	};
}

/** The capabilities `get_capabilities` reports. */
export interface UcaMapsCapabilities {
	/** `gdalinfo` — raster probing, and the GDAL version every driver shares. */
	gdal: BinaryCapability;
	/** `ogr2ogr` — vector format conversion (hito 3: GeoJSON/SHP/KML downloads). */
	ogr2ogr: BinaryCapability;
	/** `gdal_translate` — raster conversion + reprojection (hito 3: GeoTIFF export). */
	gdalTranslate: BinaryCapability;
	/** Core-resolved ImageMagick (PNG/JPEG map-image export, hito 3). */
	imagemagick: { available: boolean; path: string | null };
}

/** Probe every binary `get_capabilities` needs to answer. Never throws. */
export async function probeCapabilities(): Promise<UcaMapsCapabilities> {
	const [gdal, ogr2ogr, gdalTranslate] = await Promise.all([
		probeOnPath('gdalinfo', ['--version']),
		probeOnPath('ogr2ogr', ['--version']),
		probeOnPath('gdal_translate', ['--version']),
	]);
	// resolve once: identifyAvailable() itself calls resolveIdentify() + existsSync,
	// so calling either twice redoes the same filesystem checks for nothing.
	const available = identifyAvailable();
	return {
		gdal,
		ogr2ogr,
		gdalTranslate,
		imagemagick: {
			available,
			path: available ? (resolveIdentify()[0] as string) : null,
		},
	};
}
