/**
 * The spawn discipline every GDAL/OGR and ImageMagick call shares: argv, no
 * shell, one time bound, offline, and a private scratch dir per call under the
 * media root — never a predictable temp path (a planted symlink redirects the
 * write) nor the OS temp dir, the database's volume on the shipped stacks.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { config } from '../../../src/config/config.ts';
import { DedaloError } from '../../../src/core/errors/index.ts';
import { MEDIA_DIR_MODE } from '../../../src/core/install/media_tree.ts';
import { identifyAvailable, resolveMagick } from '../../../src/core/media/engine/binaries.ts';
import {
	assertSpawnOk,
	runBinary,
	type SpawnResult,
} from '../../../src/core/media/engine/spawn.ts';
import { assertTestMediaRoot } from '../../../src/core/media/test_media_root.ts';
import type { ToolBootHandle } from '../../../src/core/tools/module.ts';
import { GDAL_MIN_VERSION, meetsGdalMinVersion, probeOnPath } from './capabilities.ts';

/** Bounded — these are single-object/single-screenshot conversions, never a
 * multi-GB media transcode; a stuck GDAL/ImageMagick process must not hold
 * the request open indefinitely. */
const TOOL_BINARY_TIMEOUT_MS = 60_000;

/**
 * Every spawn runs offline. GDAL fetches on its own (a GeoJSON `crs` link, a
 * VRT's `/vsicurl/`) through libcurl, which no engine guard sees; a proxy with
 * a scheme libcurl does not know fails before any socket opens, and `NO_PROXY`
 * is emptied so no host skips it. `PROJ_NETWORK` is PROJ's own grid download.
 */
export const OFFLINE_ENV: Readonly<Record<string, string>> = {
	GDAL_HTTP_PROXY: 'dedalo-offline://refused',
	GDAL_HTTPS_PROXY: 'dedalo-offline://refused',
	NO_PROXY: '',
	no_proxy: '',
	PROJ_NETWORK: 'OFF',
};

/**
 * GDAL's reading pinned like the network: with `GDAL_JPEG_TO_RGB=NO` in the
 * server's env a CMYK JPEG comes as Cyan/Magenta/Yellow/Black bands without
 * `SOURCE_COLOR_SPACE`, the one signal the image download's CMYK refusal reads.
 */
export const GDAL_READ_ENV: Readonly<Record<string, string>> = {
	GDAL_JPEG_TO_RGB: 'YES',
};

/** GDAL binaries that open a file: each picks its driver by CONTENT unless
 * `-if` names it, so a `.kml` that is really a VRT would read any path. */
const GDAL_FILE_READERS: ReadonlySet<string> = new Set([
	'ogr2ogr',
	'ogrinfo',
	'gdalinfo',
	'gdal_translate',
	'gdalwarp',
]);

/** `-if` for each driver GDAL may open the input with, and no other. */
export function inputDrivers(...drivers: readonly string[]): string[] {
	return drivers.flatMap((driver) => ['-if', driver]);
}

const RASTER_DRIVER_BY_EXTENSION: Readonly<Record<string, string>> = {
	tif: 'GTiff',
	tiff: 'GTiff',
	jpg: 'JPEG',
	jpeg: 'JPEG',
	png: 'PNG',
	webp: 'WEBP',
	avif: 'AVIF',
	gif: 'GIF',
};

/** The one raster driver a file's extension stands for. */
export function rasterDriverOf(path: string): string {
	const driver = RASTER_DRIVER_BY_EXTENSION[extname(path).slice(1).toLowerCase()];
	if (driver === undefined) {
		throw new DedaloError('internal.invariant', {
			message: `tool_uca_maps: no raster driver for ${basename(path)}`,
		});
	}
	return driver;
}

// GDAL's GeoJSON reader, case-insensitive: `link` and `URL` fetch the CRS
// they point to; `name` is read with network and file access off
const OFFLINE_GEOJSON_CRS_TYPES: ReadonlySet<string> = new Set(['name', 'epsg', 'ogc']);

/**
 * A GeoJSON reaches GDAL only with every `crs` resolvable offline. GDAL matches
 * member names in any case and reads a `crs` on the root and on each geometry,
 * so every object is walked except attribute values (`properties`). The offline
 * env already stops the fetch; this refuses the file with a reason.
 */
export function assertOfflineGeoJsonCrs(geojson: unknown): void {
	if (Array.isArray(geojson)) {
		for (const item of geojson) assertOfflineGeoJsonCrs(item);
		return;
	}
	if (geojson === null || typeof geojson !== 'object') return;
	for (const [key, value] of Object.entries(geojson)) {
		const name = key.toLowerCase();
		if (name === 'crs') assertOfflineCrs(value);
		else if (name !== 'properties') assertOfflineGeoJsonCrs(value);
	}
}

function assertOfflineCrs(crs: unknown): void {
	if (crs === null || crs === undefined) return;
	// one `type` member only: with two spellings, which one GDAL takes is not ours to guess
	const types =
		typeof crs === 'object'
			? Object.entries(crs).filter(([key]) => key.toLowerCase() === 'type')
			: [];
	const type = types.length === 1 ? types[0]?.[1] : undefined;
	if (typeof type === 'string' && OFFLINE_GEOJSON_CRS_TYPES.has(type.toLowerCase())) return;
	const message =
		"This GeoJSON's crs is a link, which is never followed: name its projection " +
		'instead (for example "EPSG:25830")';
	throw new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/**
 * Resolve a GDAL/OGR binary with the same probe `get_capabilities` reports, so
 * a broken or too old one is `tool.dependency_unavailable` here too, never a
 * generic `tool.action_failed`. Re-probed on every call: an install may add or
 * remove GDAL without a restart, and a conversion is no hot path.
 */
export async function resolveGdalBinary(
	name: 'ogr2ogr' | 'ogrinfo' | 'gdal_translate' | 'gdalwarp' | 'gdalinfo' | 'gdalsrsinfo',
): Promise<string> {
	const probe = await probeOnPath(name, ['--version']);
	if (!probe.available || probe.path === null) {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { tool: 'tool_uca_maps', binary: name },
			message: `${name} is not installed on this server`,
		});
	}
	if (!meetsGdalMinVersion(probe.version)) {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { tool: 'tool_uca_maps', binary: name },
			message: `${name} reports '${probe.version ?? ''}': GDAL ${GDAL_MIN_VERSION.join('.')} or later is required`,
		});
	}
	return probe.path;
}

/**
 * Whether `error` is `resolveGdalBinary`'s "not installed" (or too old) for
 * `name`. The code alone does not say it: a missing media root raises the same
 * one (scratchRoot).
 */
export function isMissingGdalBinary(error: unknown, name: string): boolean {
	return (
		error instanceof DedaloError &&
		error.code === 'tool.dependency_unavailable' &&
		error.coordinates?.binary === name
	);
}

/**
 * The ImageMagick binary, or `tool.dependency_unavailable`. `resolveMagick()`
 * never throws (it guesses a path), and spawning a missing binary surfaces as
 * `internal.unexpected`; gated on the check `get_capabilities` reports.
 */
export function resolveMagickBinary(): string {
	if (!identifyAvailable()) {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { tool: 'tool_uca_maps', binary: 'imagemagick' },
			message: 'ImageMagick is not installed on this server',
		});
	}
	return resolveMagick();
}

/**
 * The upload staging tree under the media root, refused unless the root is
 * configured (and, under the suite, marked); `door` names the caller in that
 * refusal. The root is a parameter only so a gate can hand it a missing or
 * unmarked one: `config.media` is frozen.
 */
export function uploadStagingBase(
	door: string,
	configured: string | null = config.media.rootPath,
): string {
	if (configured === null || configured === '') {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'media root is not configured',
		});
	}
	return join(assertTestMediaRoot(configured, door), config.media.upload.tmpSubdir);
}

/**
 * Where every scratch directory is created: `tool_uca_maps/` inside the
 * upload staging tree, so it shares the media volume and the staging tree's
 * permissions. The staging tree's per-user dirs are numeric ids: no clash.
 */
export function scratchRoot(configured: string | null = config.media.rootPath): string {
	const scratch = join(uploadStagingBase('tool_uca_maps.scratchRoot', configured), 'tool_uca_maps');
	mkdirSync(scratch, { recursive: true, mode: MEDIA_DIR_MODE });
	return scratch;
}

/** Every scratch directory's name prefix: the sweep touches nothing else. */
const SCRATCH_PREFIX = 'scratch_';

/** A scratch dir idle this long was left by a process that died mid-action
 * (its `finally` never ran). An action is minutes at most (60 s per spawn,
 * 120 s of converter queue by default), so an hour never touches a live one. */
export const SCRATCH_ORPHAN_TTL_MS = 60 * 60 * 1000;

/** Newest mtime of a dir and its direct entries (the spill files live there). */
function lastActivity(path: string): number {
	let newest = statSync(path).mtimeMs;
	for (const entry of readdirSync(path)) {
		try {
			newest = Math.max(newest, statSync(join(path, entry)).mtimeMs);
		} catch {
			// removed by its own action meanwhile — not an error
		}
	}
	return newest;
}

/**
 * Remove the orphaned `scratch_*` dirs under `root`. On the media volume they
 * would otherwise outlive every restart. Best-effort: a dir that vanishes or
 * cannot be read is skipped.
 */
function sweepScratchOrphans(root: string): number {
	const now = Date.now();
	let removed = 0;
	for (const entry of readdirSync(root)) {
		if (!entry.startsWith(SCRATCH_PREFIX)) continue;
		const full = join(root, entry);
		try {
			if (now - lastActivity(full) <= SCRATCH_ORPHAN_TTL_MS) continue;
			rmSync(full, { recursive: true, force: true });
			removed++;
		} catch {
			// raced with a sibling sweep or its own action — leave it
		}
	}
	return removed;
}

/**
 * Run `fn` with a private per-call scratch directory, removed unconditionally
 * afterwards (success or failure) — see the module header for why this is
 * never a shared/predictable path, nor the OS temp dir.
 */
export async function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(scratchRoot(), SCRATCH_PREFIX));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The tool's `onBoot`: a sweep at boot and then every TTL, armed and returned
 * at once (the hook must not block). An orphan only exists once a process died
 * mid-action; one younger than the TTL at boot is collected by a later pass.
 * A sweep that cannot reach the media root only warns: it must never stop the
 * server. The TTL spares a dir another engine process on the same root uses.
 */
export function startScratchSweep(
	configured: string | null = config.media.rootPath,
	periodMs: number = SCRATCH_ORPHAN_TTL_MS,
): ToolBootHandle {
	const sweep = () => {
		try {
			sweepScratchOrphans(scratchRoot(configured));
		} catch (error) {
			console.warn('[tool_uca_maps] scratch sweep skipped:', error);
		}
	};
	const first = setTimeout(sweep, 0);
	const every = setInterval(sweep, periodMs);
	every.unref();
	return {
		stop: () => {
			clearTimeout(first);
			clearInterval(every);
		},
	};
}

/** Options for `runToolBinary` beyond the argv/context every call needs. */
interface RunToolBinaryOptions {
	/**
	 * This call's `withScratchDir` dir, handed to the binary as `CPL_TMPDIR`
	 * and `TMPDIR`: GDAL (and any child it starts) writes its own temp files
	 * there, never in the OS temp dir. Required, the twin of `magickPolicyEnv`.
	 */
	scratchDir: string;
	/** Extra environment (e.g. ImageMagick's `magickPolicyEnv()`, MEDIA-02). */
	env?: Record<string, string>;
	/** Asserted to exist after a successful exit: exit 0 without the promised
	 * file is the same failure for every conversion. */
	expectedOutput?: string;
}

/**
 * Run one GDAL/OGR or ImageMagick binary and assert it succeeded (and left
 * `expectedOutput`, when given); `context` names the operation in the
 * log-only message. Every spawn goes through here (bar `probeOnPath`'s
 * bounded `--version`) so none inherits `spawn.ts`'s 10-minute default
 * instead of TOOL_BINARY_TIMEOUT_MS.
 */
export async function runToolBinary(
	argv: readonly string[],
	context: string,
	options: RunToolBinaryOptions,
): Promise<SpawnResult> {
	if (GDAL_FILE_READERS.has(basename(argv[0] ?? '')) && !argv.includes('-if')) {
		throw new DedaloError('internal.invariant', {
			message: `${context}: a GDAL input is opened only with its driver named (-if)`,
		});
	}
	const result = await runBinary(argv, {
		timeoutMs: TOOL_BINARY_TIMEOUT_MS,
		nice: false,
		env: {
			...options.env,
			CPL_TMPDIR: options.scratchDir,
			TMPDIR: options.scratchDir,
			...OFFLINE_ENV,
			...GDAL_READ_ENV,
		},
	});
	try {
		assertSpawnOk(result, context);
	} catch (error) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: (error as Error).message,
		});
	}
	if (options.expectedOutput !== undefined && !existsSync(options.expectedOutput)) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: `${context}: exit 0 but did not produce ${options.expectedOutput}`,
		});
	}
	return result;
}

/** `gdalinfo -json` of a raster, opened only with its extension's driver. */
export async function readGdalInfoJson(
	dir: string,
	path: string,
	context: string,
): Promise<unknown> {
	const gdalinfo = await resolveGdalBinary('gdalinfo');
	const result = await runToolBinary(
		[gdalinfo, ...inputDrivers(rasterDriverOf(path)), '-json', path],
		context,
		{ scratchDir: dir },
	);
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'gdalinfo -json returned output that is not JSON',
		});
	}
}

/** A generated file, base64 for the envelope: a tool has no download route of
 * its own (v6 wrote to a web-exposed `downloads/` folder and returned a URL).
 * Exports are one object or one image, so the overhead does not matter. */
export async function readFileBase64(path: string): Promise<string> {
	const bytes = await Bun.file(path).arrayBuffer();
	return Buffer.from(bytes).toString('base64');
}

/** The write side of `readFileBase64`: a caller-supplied payload (the map
 * screenshot) decoded straight to a scratch file. */
export async function writeFileBase64(path: string, base64: string): Promise<void> {
	await Bun.write(path, Buffer.from(base64, 'base64'));
}
