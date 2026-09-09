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
 * the write.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DedaloError } from '../../../src/core/errors/index.ts';
import { identifyAvailable, resolveMagick } from '../../../src/core/media/engine/binaries.ts';
import {
	assertSpawnOk,
	runBinary,
	type SpawnResult,
} from '../../../src/core/media/engine/spawn.ts';
import { probeOnPath } from './capabilities.ts';

/** Bounded — these are single-object/single-screenshot conversions, never a
 * multi-GB media transcode; a stuck GDAL/ImageMagick process must not hold
 * the request open indefinitely. */
const TOOL_BINARY_TIMEOUT_MS = 60_000;

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
	name: 'ogr2ogr' | 'gdal_translate' | 'gdalwarp' | 'gdalinfo',
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
 * Run `fn` with a private per-call scratch directory, removed unconditionally
 * afterwards (success or failure) — see the module header for why this is
 * never a shared/predictable path.
 */
export async function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo_uca_maps_'));
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
	const result = await runBinary(argv, {
		timeoutMs: TOOL_BINARY_TIMEOUT_MS,
		nice: false,
		env: options.env,
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
