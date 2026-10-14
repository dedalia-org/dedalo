/**
 * GDAL/OGR spawn discipline for tool_uca_maps (hito 3: vector_download,
 * raster_download). Despite the filename, `runToolBinary`/`withScratchDir`/
 * `readFileBase64`/`writeFileBase64` below are binary-agnostic — 3b's
 * `raster_download.ts` reuses them for its ImageMagick conversions too
 * (resolving `magick`/`convert` itself via `media/engine/binaries.ts`,
 * imported directly there — that resolver already lives in the right place,
 * nothing to re-home here). Kept as one file rather than splitting a
 * "spawn_helpers.ts" out: this module IS still GDAL-specific for the one
 * thing that genuinely differs per binary family (`resolveGdalBinary`).
 *
 * Reuses `runBinary`/`assertSpawnOk` (`src/core/media/engine/spawn.ts`) by
 * direct import, same as `capabilities.ts` (hito 1) already does — Ágora
 * consulta 3 (AGORA_HITO0.md: reuse the media-owned spawn utility, or bring a
 * tool-local copy) is still unanswered; this follows the precedent hito 1
 * already set in code rather than waiting. Binaries are resolved from $PATH
 * via `Bun.which`, same as `capabilities.ts`'s probes — no install config key
 * exists for GDAL (that discovery is documented there).
 *
 * SCRATCH FILES: every conversion writes to a PRIVATE per-call temp directory
 * (`mkdtempSync`, mode 0700, random suffix — never a predictable shared path)
 * and removes it unconditionally afterwards. Same pattern as
 * `src/core/media/tools/pdf_extract.ts`, which documents the vulnerability
 * this defends against (UPLOAD-TRAV-01, 2026-07-28 audit): a predictable
 * `/tmp/<fixed name>` lets an attacker pre-place a symlink there to redirect
 * the write. It lives under the media root, never the OS temp dir: on both
 * shipped compose stacks that is the database's volume, and ImageMagick
 * spills its pixel cache into it (MEDIA_SPEC §10, "the spill also has a
 * chosen filesystem").
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { config } from '../../../src/config/config.ts';
import { DedaloError } from '../../../src/core/errors/index.ts';
import { identifyAvailable, resolveMagick } from '../../../src/core/media/engine/binaries.ts';
import {
	assertSpawnOk,
	runBinary,
	type SpawnResult,
} from '../../../src/core/media/engine/spawn.ts';
import { assertTestMediaRoot } from '../../../src/core/media/test_media_root.ts';
import { probeOnPath } from './capabilities.ts';

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
 * Resolve a GDAL/OGR binary, or throw the tool's own "not installed" error —
 * the same DedaloError code `tool_import_dedalo_csv` uses for its own
 * missing-dependency case. Goes through `capabilities.ts`'s `probeOnPath`
 * (review-diff finding, hito 3), not a bare `Bun.which`: a stale/broken
 * binary on $PATH must fail here the SAME way `get_capabilities` already
 * reports it — a bare `Bun.which` would resolve it, proceed, and fail the
 * conversion as a generic `tool.action_failed` instead, disagreeing with what
 * the client was already told. Re-probed on every call (no caching): an
 * install can add/remove GDAL without a server restart mattering here, and a
 * conversion is rare enough that one probe is not a hot path.
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
	return probe.path;
}

/**
 * Resolve the ImageMagick binary, or throw `tool.dependency_unavailable` —
 * review-diff finding, hito 3b: `resolveMagick()` (`media/engine/binaries.ts`)
 * NEVER throws (it falls back to an unverified guessed path when neither
 * `magick` nor `convert` exists), so a caller that used it bare would spawn a
 * nonexistent binary — `Bun.spawn` throws ENOENT synchronously, which is not
 * a `DedaloError` and surfaces as an opaque `internal.unexpected` instead of
 * the specific, client-recognized "not installed" answer. Gated on
 * `identifyAvailable()` — the SAME check `get_capabilities` already reports
 * ImageMagick availability with (`capabilities.ts` `probeCapabilities`), so
 * this can never disagree with what the client was told, same reasoning as
 * `resolveGdalBinary` above.
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
 * Where every scratch directory is created: `tool_uca_maps/` inside the
 * upload staging tree, so it shares the media volume and the staging tree's
 * permissions. The staging tree's per-user dirs are numeric ids: no clash.
 */
export function scratchRoot(): string {
	const configured = config.media.rootPath;
	if (configured === null || configured === '') {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'media root is not configured',
		});
	}
	const root = assertTestMediaRoot(configured, 'tool_uca_maps.scratchRoot');
	const scratch = join(root, config.media.upload.tmpSubdir, 'tool_uca_maps');
	mkdirSync(scratch, { recursive: true, mode: 0o775 });
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
 * would otherwise outlive every restart; a cheap readdir run on each action.
 * Best-effort: a dir that vanishes or cannot be read is skipped.
 */
export function sweepScratchOrphans(root: string, now: number = Date.now()): number {
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
	const root = scratchRoot();
	sweepScratchOrphans(root);
	const dir = mkdtempSync(join(root, SCRATCH_PREFIX));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Options for `runToolBinary` beyond the argv/context every call needs. */
export interface RunToolBinaryOptions {
	/** Extra environment (e.g. ImageMagick's `magickPolicyEnv()`, MEDIA-02). */
	env?: Record<string, string>;
	/**
	 * Asserted to exist AFTER a successful exit — review-diff finding, hito
	 * 3b: every conversion function was repeating its own `existsSync` +
	 * "did not produce the expected file" throw; a binary that exits 0
	 * without leaving its promised output is the SAME failure everywhere,
	 * folded in here once instead of four times.
	 */
	expectedOutput?: string;
}

/**
 * Run one binary (GDAL/OGR or ImageMagick) with an argv array (no shell —
 * `runBinary`'s own discipline), assert it actually succeeded, and — when
 * `expectedOutput` is given — that it left the promised file. `context`
 * names the operation for the thrown error's log-only message. Named
 * generically (not `runGdal`, hito 3b): the assert-and-wrap logic has
 * nothing GDAL-specific in it; `raster_download.ts` reuses it verbatim for
 * its ImageMagick conversions too — one runner, always the SAME 60s bound
 * (review-diff finding: a caller that spawned via a bare `runBinary` instead
 * silently inherited `spawn.ts`'s 10-minute default) — not two copies, and
 * not one path with a shorter leash than the other.
 *
 * Returns the spawn result so a caller that needs the binary's OUTPUT rather
 * than its side effect can read it (hito 13: `gdalinfo -json` reports a
 * GeoTIFF's footprint on stdout and writes no file at all). Widened from
 * `void`; the file-producing callers ignore it exactly as before.
 */
export async function runToolBinary(
	argv: readonly string[],
	context: string,
	options: RunToolBinaryOptions = {},
): Promise<SpawnResult> {
	if (GDAL_FILE_READERS.has(basename(argv[0] ?? '')) && !argv.includes('-if')) {
		throw new DedaloError('internal.invariant', {
			message: `${context}: a GDAL input is opened only with its driver named (-if)`,
		});
	}
	const result = await runBinary(argv, {
		timeoutMs: TOOL_BINARY_TIMEOUT_MS,
		nice: false,
		env: { ...options.env, ...OFFLINE_ENV },
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

/** Read a file's full content and base64-encode it — the only channel a tool
 * action has to hand back generated bytes: this encargo's surface rule
 * (CLAUDE.local.md) keeps `src/server.ts` off limits, so there is no new HTTP
 * download route to register (unlike v6, which wrote to a web-exposed
 * `downloads/` folder and handed back a URL). Exports here are small
 * (one drawn object, one map screenshot), so the base64 overhead is
 * irrelevant — this is not a media-transcode-sized payload. */
export async function readFileBase64(path: string): Promise<string> {
	const bytes = await Bun.file(path).arrayBuffer();
	return Buffer.from(bytes).toString('base64');
}

/** The write side of `readFileBase64` — decode a caller-supplied base64
 * payload (hito 3b: the client's captured map screenshot) straight to a
 * scratch file. `Bun.write` accepts a `Buffer` directly. */
export async function writeFileBase64(path: string, base64: string): Promise<void> {
	await Bun.write(path, Buffer.from(base64, 'base64'));
}
