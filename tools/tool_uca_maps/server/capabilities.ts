/**
 * `get_capabilities`: which binaries this install has, so the client greys out
 * what it cannot serve instead of failing mid-conversion. Core has no config
 * key for GDAL, so it is looked up on $PATH; ImageMagick goes through core's
 * install-configured resolver (`media/engine/binaries.ts`).
 */

import { ok } from '../../../src/core/errors/index.ts';
import { identifyAvailable, resolveIdentify } from '../../../src/core/media/engine/binaries.ts';
import { runBinary } from '../../../src/core/media/engine/spawn.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { externalImagesEnabled } from './external_image.ts';
import { type GazetteerCapability, probeGazetteers } from './gazetteer_store.ts';

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
 * Resolve `name` on $PATH and confirm it runs `versionArgs`. `gdal.ts` resolves
 * through this too: a broken binary must read as unavailable on both sides, so
 * a conversion fails `tool.dependency_unavailable`, never `tool.action_failed`.
 */
export async function probeOnPath(
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

/** `-if`, which every GDAL file read names, exists from GDAL 3.2 on. */
export const GDAL_MIN_VERSION: readonly [major: number, minor: number] = [3, 2];

/**
 * Whether a `--version` banner ("GDAL 3.6.2, released …") is at least
 * GDAL_MIN_VERSION. A banner that names no version is not: below the floor
 * every action would fail as `tool.action_failed` on `-if`.
 */
export function meetsGdalMinVersion(banner: string | null): boolean {
	const match = /^GDAL (\d+)\.(\d+)/.exec(banner ?? '');
	if (match === null) return false;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	const [floorMajor, floorMinor] = GDAL_MIN_VERSION;
	return major > floorMajor || (major === floorMajor && minor >= floorMinor);
}

/**
 * A GDAL probe as `get_capabilities` reports it: below GDAL_MIN_VERSION the
 * binary runs but every action would refuse, so it reads as unavailable and
 * the client greys the action out instead of offering a button that fails.
 */
export function gdalCapability(probe: BinaryCapability): BinaryCapability {
	return { ...probe, available: probe.available && meetsGdalMinVersion(probe.version) };
}

/** The capabilities `get_capabilities` reports. */
export interface UcaMapsCapabilities {
	/** `gdalinfo` — raster probing, and the GDAL version every driver shares. */
	gdal: BinaryCapability;
	/** `ogr2ogr` — vector format conversion (SHP/KML downloads, vector uploads). */
	ogr2ogr: BinaryCapability;
	/** `gdal_translate` — raster conversion (GeoTIFF export). */
	gdalTranslate: BinaryCapability;
	/** Core-resolved ImageMagick (the map image as jpg/gif/webp). */
	imagemagick: { available: boolean; path: string | null };
	/** The local gazetteer store: a data directory an install configures, not a
	 * binary (`gazetteer_store.ts`). The client greys out what it cannot serve. */
	gazetteers: GazetteerCapability;
	/** Whether this install allows importing an object's linked images
	 * (`external_image.ts`, on unless turned off): the button shows only then. */
	externalImages: boolean;
}

/** Probe every binary `get_capabilities` needs to answer. Never throws.
 * `externalImagesOn` is a parameter only so a gate can turn the option off. */
export async function probeCapabilities(
	externalImagesOn: () => Promise<boolean> = externalImagesEnabled,
): Promise<UcaMapsCapabilities> {
	const [gdal, ogr2ogr, gdalTranslate, gazetteers, externalImages] = await Promise.all([
		probeOnPath('gdalinfo', ['--version']).then(gdalCapability),
		probeOnPath('ogr2ogr', ['--version']).then(gdalCapability),
		probeOnPath('gdal_translate', ['--version']).then(gdalCapability),
		probeGazetteers(),
		// the option is a DB read: an outage reads as "off", never a 500
		externalImagesOn().catch(() => false),
	]);
	// the predicate `resolveMagickBinary` gates on, so the two never disagree
	const available = identifyAvailable();
	return {
		gdal,
		ogr2ogr,
		gdalTranslate,
		imagemagick: { available, path: available ? (resolveIdentify()[0] ?? null) : null },
		gazetteers,
		externalImages,
	};
}

export async function getCapabilities(context: ToolActionContext): Promise<ToolResponse> {
	return ok(await probeCapabilities(), { requestId: toolRequestId(context) });
}
