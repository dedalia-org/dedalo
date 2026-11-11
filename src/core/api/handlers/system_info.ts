/**
 * system_info — the TS re-expression of PHP dd_utils_api::get_system_info
 * (class.dd_utils_api.php:252). The init call every upload / import / media-edit
 * client makes before it can transfer a file (client/dedalo/core/services/
 * service_upload/js/service_upload.js:252). Without it those panels 400 on boot.
 *
 * PHP derives the numbers from php.ini (post_max_size / upload_max_filesize /
 * session.cache_expire / the OCR-engine constant). The Bun server has no php.ini,
 * so the equivalent knobs come from the media/upload config catalog
 * (DEDALO_UPLOAD_MAX_SIZE_BYTES / DEDALO_SESSION_CACHE_EXPIRE / DEDALO_UPLOAD_
 * SERVICE_CHUNK_FILES / PDF_OCR_ENGINE), keeping the client-critical shape
 * (max_size_bytes numeric, upload_service_chunk_files number|false) intact.
 *
 * OCR (T0-11 D3): `pdf_ocr_engine` is MEASURED — the ocrmypdf binary exists and
 * is executable — never "a path is configured" (every install has a derived
 * default path, so the old reading offered OCR on hosts without ocrmypdf).
 * `pdf_ocr_langs` lists the application languages whose Tesseract model is
 * INSTALLED (`tesseract --list-langs`, mapped through media/engine/ocr_langs.ts —
 * the same map the OCR door and the installer read), so the upload panel never
 * offers a language the OCR would refuse. Computed per request, no module cache:
 * the listing costs ~25 ms (measured, Homebrew tesseract 5) on a call made once
 * per upload panel, and a per-request answer sees a language pack installed
 * after boot.
 */

import { statSync } from 'node:fs';
import os from 'node:os';
import { resolve, sep } from 'node:path';
import { config } from '../../../config/config.ts';
import {
	installedTesseractModels,
	isExecutableFile,
	ocrLangsOf,
} from '../../media/engine/ocr_langs.ts';

/** The payload shape the client reads (mirrors PHP get_system_info's $system_info). */
export interface SystemInfo {
	max_size_bytes: number;
	sys_get_temp_dir: string;
	upload_tmp_dir: string;
	upload_tmp_perms: number;
	session_cache_expire: number;
	upload_service_chunk_files: number | false;
	pdf_ocr_engine: boolean;
	/** Application langs (`lg-*`) OCR can run in: Tesseract model installed. [] when OCR is off. */
	pdf_ocr_langs: string[];
}

/** What the OCR facts are measured from (a gate passes scratch binaries). */
export interface SystemInfoSources {
	ocrmypdfPath: string;
	tesseractPath: string;
	/** The application languages (DEDALO_APPLICATION_LANGS codes, in order). */
	applicationLangs: readonly string[];
}

function defaultSources(): SystemInfoSources {
	return {
		ocrmypdfPath: config.media.binaries.ocrmypdf,
		tesseractPath: config.media.binaries.tesseract,
		applicationLangs: Object.keys(config.lang.applicationLangs),
	};
}

/** Resolve the staging root (media_root/<tmpSubdir>); null when no media root is set (dev). */
function resolveUploadTmpDir(): string {
	const root = config.media.rootPath;
	if (root === null || root === '') return '';
	const base = resolve(root, config.media.upload.tmpSubdir);
	// Confine to the media root subtree (defense in depth; tmpSubdir is config, not input).
	if (base !== root && !base.startsWith(root + sep)) return '';
	return base;
}

/** fileperms()-equivalent: the octal permission bits of the staging dir, or 0 if absent. */
function uploadTmpPerms(dir: string): number {
	if (dir === '') return 0;
	try {
		return statSync(dir).mode;
	} catch {
		return 0;
	}
}

/**
 * Build the system-info payload. Over config + the host's binaries, so a unit
 * test can assert the client-critical fields without an HTTP round-trip (and
 * pass scratch binaries through `sources`).
 */
export async function buildSystemInfo(
	sources: SystemInfoSources = defaultSources(),
): Promise<SystemInfo> {
	const ocrEngine = isExecutableFile(sources.ocrmypdfPath);
	const ocrLangs = ocrEngine
		? ocrLangsOf(sources.applicationLangs, await installedTesseractModels(sources.tesseractPath))
		: [];
	const uploadTmpDir = resolveUploadTmpDir();
	const chunkMb = config.media.upload.chunkFilesMb;
	return {
		max_size_bytes: config.media.upload.maxSizeBytes,
		sys_get_temp_dir: os.tmpdir(),
		upload_tmp_dir: uploadTmpDir,
		upload_tmp_perms: uploadTmpPerms(uploadTmpDir),
		session_cache_expire: config.media.upload.sessionCacheExpire,
		// PHP returns the raw constant (number, or false when chunking is disabled).
		upload_service_chunk_files: chunkMb > 0 ? chunkMb : false,
		// MEASURED: the ocrmypdf binary is there and executable (T0-11 D3).
		pdf_ocr_engine: ocrEngine,
		pdf_ocr_langs: ocrLangs,
	};
}
