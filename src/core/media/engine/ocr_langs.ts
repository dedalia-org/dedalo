/**
 * OCR LANGUAGES — the ONE map from a Dédalo language (`lg-spa`) to the Tesseract
 * language model OCR runs with (`spa`), and from that model to the OS package
 * that ships it (T0-11, owner decision D3 2026-11-11).
 *
 * ONE TABLE, TWO READERS: the OCR door (engine/pdf.ts buildOcrArgv via
 * media/ingest/pdf_transcription.ts) and the installer's package plan
 * (core/install/host) — so the language an operator picks at install time is
 * exactly the model the upload can later run. Two copies would drift silently:
 * the installer would ship `tesseract-ocr-zho` while the OCR asks for `chi_sim`.
 *
 * NEVER A GUESS. A Dédalo code maps only when the Tesseract model is KNOWN to
 * exist (TESSERACT_MODELS, the tessdata 4/5 model list); anything else is a loud
 * `request.invalid_options` refusal, never an identity pass-through that would
 * fail three binaries later as an opaque ocrmypdf error.
 *
 * Exceptions to the "strip `lg-`" rule are explicit (DEDALO_TO_TESSERACT):
 *   - lg-vlca (Valencian) → cat — PHP process_ocr_file's one exception; it shares
 *     the Catalan model, as it shares the Catalan alpha-2 (resolve/lang_names.ts).
 *   - Chinese: Tesseract has no `zho`/`cmn`/`chi` model, only the script models;
 *     Simplified is the model (`lg-chi` is the code the installer's language
 *     catalog offers — install/lang_catalog.ts — `lg-zho` the one lang.json uses).
 */

import { accessSync, constants, statSync } from 'node:fs';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { runBinary } from './spawn.ts';

/**
 * The Tesseract language models (tessdata 4.x/5.x, language entries only — the
 * `script/*` models and `osd` are not languages a curator picks). Frozen: a model
 * absent here is refused even if some host happens to have it.
 */
export const TESSERACT_MODELS: ReadonlySet<string> = new Set([
	'afr',
	'amh',
	'ara',
	'asm',
	'aze',
	'aze_cyrl',
	'bel',
	'ben',
	'bod',
	'bos',
	'bre',
	'bul',
	'cat',
	'ceb',
	'ces',
	'chi_sim',
	'chi_sim_vert',
	'chi_tra',
	'chi_tra_vert',
	'chr',
	'cos',
	'cym',
	'dan',
	'deu',
	'div',
	'dzo',
	'ell',
	'eng',
	'enm',
	'epo',
	'equ',
	'est',
	'eus',
	'fao',
	'fas',
	'fil',
	'fin',
	'fra',
	'frk',
	'frm',
	'fry',
	'gla',
	'gle',
	'glg',
	'grc',
	'guj',
	'hat',
	'heb',
	'hin',
	'hrv',
	'hun',
	'hye',
	'iku',
	'ind',
	'isl',
	'ita',
	'ita_old',
	'jav',
	'jpn',
	'jpn_vert',
	'kan',
	'kat',
	'kat_old',
	'kaz',
	'khm',
	'kir',
	'kmr',
	'kor',
	'kor_vert',
	'lao',
	'lat',
	'lav',
	'lit',
	'ltz',
	'mal',
	'mar',
	'mkd',
	'mlt',
	'mon',
	'mri',
	'msa',
	'mya',
	'nep',
	'nld',
	'nor',
	'oci',
	'ori',
	'pan',
	'pol',
	'por',
	'pus',
	'que',
	'ron',
	'rus',
	'san',
	'sin',
	'slk',
	'slv',
	'snd',
	'spa',
	'spa_old',
	'sqi',
	'srp',
	'srp_latn',
	'sun',
	'swa',
	'swe',
	'syr',
	'tam',
	'tat',
	'tel',
	'tgk',
	'tha',
	'tir',
	'ton',
	'tur',
	'uig',
	'ukr',
	'urd',
	'uzb',
	'uzb_cyrl',
	'vie',
	'yid',
	'yor',
]);

/** Dédalo code (without `lg-`) → Tesseract model, where the two differ. */
const DEDALO_TO_TESSERACT: Readonly<Record<string, string>> = {
	vlca: 'cat',
	zho: 'chi_sim',
	cmn: 'chi_sim',
	chi: 'chi_sim',
};

/** The model Tesseract needs besides the language one (page orientation/script detection). */
export const TESSERACT_OSD_MODEL = 'osd';

/**
 * The Tesseract model for a Dédalo language, or null when Tesseract has none.
 * Pure; never throws (the installer asks it of every working language and
 * reports the ones without a model, it does not abort an install over them).
 */
export function tesseractModelFor(dedaloLang: string): string | null {
	if (!dedaloLang.startsWith('lg-')) return null;
	const code = dedaloLang.slice(3);
	const model = DEDALO_TO_TESSERACT[code] ?? code;
	return TESSERACT_MODELS.has(model) ? model : null;
}

/** The Tesseract model for a Dédalo language — REFUSING loudly when there is none. */
export function requireTesseractModel(dedaloLang: string): string {
	const model = tesseractModelFor(dedaloLang);
	if (model === null) {
		throw new DedaloError('request.invalid_options', {
			message: `ocr: no Tesseract language model for '${dedaloLang}'`,
			publicMessage: 'OCR is not available for this language.',
		});
	}
	return model;
}

/** Debian/Ubuntu package shipping a model: `tesseract-ocr-chi-sim` for `chi_sim`. */
export function debianTesseractPackage(model: string): string {
	return `tesseract-ocr-${model.replace(/_/g, '-')}`;
}

/**
 * RHEL-family package shipping a model: `tesseract-langpack-chi_sim` for
 * `chi_sim`. The two non-language models are their own packages there
 * (Fedora/EPEL tesseract-tessdata: `tesseract-osd`, `tesseract-equ`).
 */
export function rhelTesseractPackage(model: string): string {
	if (model === TESSERACT_OSD_MODEL || model === 'equ') return `tesseract-${model}`;
	return `tesseract-langpack-${model}`;
}

// -------- host probe (system_info) --------
// Lives HERE, under src/core/media, not in the API handler: no handler spawns a
// binary itself (magick_policy_tripwire, "no API handler spawns a converter").

/** A regular file this process may execute (never just "a path is set"). */
export function isExecutableFile(path: string): boolean {
	if (path === '') return false;
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Bounded: `--list-langs` answers in milliseconds; a hung binary must not hang the panel. */
const LIST_LANGS_TIMEOUT_MS = 10_000;

/**
 * The Tesseract models installed on this host (`tesseract --list-langs`), or an
 * empty set when the binary is missing or fails. Tesseract 4/5 print the list on
 * stdout under a `List of available languages …` header; older builds used
 * stderr — both are read, and only bare model names (`spa`, `chi_sim`) count
 * (the header and `script/Latin` entries never match).
 */
export async function installedTesseractModels(tesseractPath: string): Promise<Set<string>> {
	if (!isExecutableFile(tesseractPath)) return new Set();
	const result = await runBinary([tesseractPath, '--list-langs'], {
		nice: false,
		timeoutMs: LIST_LANGS_TIMEOUT_MS,
	});
	if (!result.ok) return new Set();
	const models = new Set<string>();
	for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
		const name = line.trim();
		if (/^[a-z][a-z0-9_]*$/.test(name)) models.add(name);
	}
	return models;
}

/** The application langs whose Tesseract model is installed, in application order. */
export function ocrLangsOf(
	applicationLangs: readonly string[],
	installed: ReadonlySet<string>,
): string[] {
	return applicationLangs.filter((lang) => {
		const model = tesseractModelFor(lang);
		return model !== null && installed.has(model);
	});
}
