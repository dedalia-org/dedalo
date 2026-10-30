/**
 * Hardened release-archive download (UPDATE_PROCESS Phase 4) — the same
 * transport posture as the Phase-2 ontology downloader
 * (data_io_import.downloadRemoteOntologyFile), generalized for a code archive:
 * TLS verification ON, origin-pinned to the configured code server, redirects
 * refused, streamed byte ceiling + stall guard, confined destination. The
 * caller verifies the sha256 (WC-024) after this returns.
 */

import { createWriteStream, rmSync } from 'node:fs';
import { config } from '../../config/config.ts';
import { isSecureUpdateSource } from '../../config/readers.ts';
import { assertTlsVerificationOn } from '../ontology/data_io_import.ts';
import { refuseUpdate, rethrowOrRefuseUpdate } from './refuse.ts';

export const CODE_DOWNLOAD_TIMEOUT_MS = 600_000;
export const CODE_DOWNLOAD_STALL_TIMEOUT_MS = 60_000;
export const MAX_CODE_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** What a COMPLETED download reports. Every refusal throws (./refuse.ts). */
export interface CodeDownloadResponse {
	msg: string;
	bytes: number;
}

/**
 * The release URL, parsed and PROVED to be on the configured code server.
 * Origin equality is the whole point: a manifest is remote input, so the only
 * host this engine will download code from is the one its own config names.
 */
function releaseUrlOrRefuse(
	url: string,
	configuredOrigin: string,
	allowHttp: boolean = config.update.httpSourcesDev,
): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (error) {
		refuseUpdate('request.invalid_options', 'Error. Invalid release URL', error);
	}
	if (parsed.origin !== configuredOrigin) {
		refuseUpdate(
			'request.invalid_options',
			'Error. Release URL is not on the configured code server',
		);
	}
	// U-24: the bytes' own door re-checks the transport rule (config already
	// dropped an http master; this holds for any URL that reaches the fetch).
	if (!isSecureUpdateSource(parsed.href, allowHttp)) {
		refuseUpdate('update.refused', 'Error. A code master must be reached over https');
	}
	return parsed;
}

/**
 * Everything that must hold before a single byte is read, and the body itself
 * once it does. Split out so the download reads as "gate, then stream" — and so
 * the null-body refusal is what NARROWS the type, rather than a check the
 * caller has to be trusted to have made.
 */
function servableBodyOrRefuse(remote: Response, url: string): ReadableStream<Uint8Array> {
	if (!remote.ok) {
		// A 404 here is almost never "the museum did something wrong": the
		// manifest that named this URL was written by the MASTER, and every
		// gate before this one passed. The usual cause is that the master's
		// reverse proxy does not route /dedalo/install/code/ to its socket —
		// the path has no client subtree, so the master's static alias answers
		// 404 and the request never reaches its engine. Saying only
		// "bad server response code: 404" sent the operator to audit their own
		// install, which is the one place the fault cannot be. The master's own
		// panel now self-probes this (status.ts advertisedUrlReachableCheck);
		// this message is what the person on the other end reads.
		if (remote.status === 404) {
			refuseUpdate(
				'update.failed',
				`Error. The code server does not serve the release it offered (404): ${url}. ` +
					'Ask its administrator to check the code-update panel — a master whose reverse ' +
					'proxy does not route /dedalo/install/code/ advertises releases it cannot deliver.',
			);
		}
		refuseUpdate('update.failed', `Error. bad server response code: ${remote.status}`);
	}
	const declared = Number(remote.headers.get('content-length') ?? '0');
	if (declared > MAX_CODE_ARCHIVE_BYTES) {
		refuseUpdate('update.refused', 'Error. Release archive exceeds the size cap');
	}
	if (remote.body === null) {
		refuseUpdate('update.failed', 'Error. empty response body');
	}
	return remote.body;
}

/**
 * Stream a release archive from `url` (must sit on `configuredOrigin`) to
 * `targetPath`. Refuses redirects, caps bytes, and guards against a stalled
 * socket. The destination is assumed already confined by the caller.
 */
/*
 * COVERAGE-EXEMPT (coverage plan §5.2; reason registered in
 * engineering/crap_coverage_exempt.json): an OUTBOUND NETWORK fetch of a release
 * archive. A test never fetches — a gate here would be non-hermetic and would
 * depend on a third party's availability. If the surrounding logic is ever
 * needed, inject at the boundary instead.
 */
export async function downloadReleaseArchive(options: {
	url: string;
	configuredOrigin: string;
	targetPath: string;
	/** The U-24 development seam (default: config.update.httpSourcesDev). */
	allowHttp?: boolean;
}): Promise<CodeDownloadResponse> {
	assertTlsVerificationOn();

	const parsed = releaseUrlOrRefuse(options.url, options.configuredOrigin, options.allowHttp);

	try {
		const remote = await fetch(parsed, {
			redirect: 'error',
			signal: AbortSignal.timeout(CODE_DOWNLOAD_TIMEOUT_MS),
		});
		const reader = servableBodyOrRefuse(remote, options.url).getReader();
		const sink = createWriteStream(options.targetPath);
		let total = 0;
		try {
			for (;;) {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error('download stalled')), CODE_DOWNLOAD_STALL_TIMEOUT_MS),
					),
				]);
				if (chunk.done) break;
				total += chunk.value.byteLength;
				if (total > MAX_CODE_ARCHIVE_BYTES) {
					refuseUpdate('update.refused', 'Error. Release archive exceeds the size cap');
				}
				if (!sink.write(chunk.value)) {
					await new Promise<void>((resolveDrain) => sink.once('drain', () => resolveDrain()));
				}
			}
		} finally {
			await new Promise<void>((resolveEnd) => sink.end(() => resolveEnd()));
			reader.releaseLock();
		}
		if (total === 0) {
			rmSync(options.targetPath, { force: true });
			refuseUpdate('update.failed', 'Error. empty data');
		}
		return { msg: 'OK. Release downloaded', bytes: total };
	} catch (error) {
		rmSync(options.targetPath, { force: true });
		rethrowOrRefuseUpdate(
			error,
			'update.failed',
			`Error. Release download failed: ${(error as Error).message}`,
		);
	}
}
