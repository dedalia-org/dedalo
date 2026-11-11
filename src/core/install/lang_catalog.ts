/**
 * Install-time language catalog + derivation (DEC-19 lang config).
 *
 * The owner rule (config.ts: "LANGUAGE definitions are install configuration —
 * a missing/malformed value must refuse boot, never fall back to a hardcoded
 * list") makes four lang keys mandatory once the server is configured. The
 * installer therefore collects a working-language set and writes them; this
 * module is the ONE source of truth the installer's screens and its
 * env-preset share.
 *
 * PURE — no config.ts import (the CLI calls it BEFORE config is imported, to set
 * the lang env vars so config resolves without throwing at import time).
 */

import { isValidLang } from '../concepts/ontology.ts';

/**
 * The labelled language catalog the installer offers — EXACTLY the languages the
 * UI-label subsystem ships a translation for (src/core/labels/catalog/lg-*.json;
 * gate: test/unit/install_lang_catalog.test.ts). A labelled dropdown needs
 * display names (endonyms), and the full 639-code matrix_langs dump has none.
 * Insertion order is the presentation order.
 */
export const INSTALL_LANG_CATALOG: Readonly<Record<string, string>> = Object.freeze({
	'lg-eng': 'English',
	'lg-spa': 'Castellano',
	'lg-cat': 'Català',
	'lg-eus': 'Euskara',
	'lg-fra': 'Français',
	'lg-por': 'Português',
	'lg-deu': 'Deutsch',
	'lg-ita': 'Italiano',
	'lg-ell': 'Ελληνικά',
	'lg-nep': 'नेपाली',
	'lg-ara': 'العربية',
	'lg-ben': 'বাংলা',
	'lg-chi': '中文',
	'lg-hin': 'हिन्दी',
	'lg-jpn': '日本語',
	'lg-kor': '한국어',
	'lg-rus': 'Русский',
	'lg-urd': 'اردو',
});

/** All catalog codes in presentation order (every language the installer OFFERS). */
export const INSTALL_LANG_CODES: readonly string[] = Object.freeze(
	Object.keys(INSTALL_LANG_CATALOG),
);

/**
 * THE default languages — interface AND working (data) — pre-ticked on the
 * screens, taken by the CLI and install.sh when no language is given: English +
 * Spanish. Every other catalog language is OPTIONAL — offered, never on by
 * default.
 */
export const INSTALL_DEFAULT_LANG_CODES: readonly string[] = Object.freeze(['lg-eng', 'lg-spa']);

export interface LangConfigInput {
	/** Working-language codes (array or comma string). Default: INSTALL_DEFAULT_LANG_CODES. */
	langs?: string[] | string;
	/** Default interface (application) language. Default: first picked code. */
	appLangDefault?: string;
	/** Default data language. Default: first picked code. */
	dataLangDefault?: string;
}

export interface DerivedLangConfig {
	/** code→label map for the picked set (DEDALO_APPLICATION_LANGS). */
	applicationLangs: Record<string, string>;
	/** ordered codes (DEDALO_PROJECTS_DEFAULT_LANGS / PROJECTS_DEFAULT_LANGS). */
	projectsDefaultLangs: string[];
	/** DEDALO_APPLICATION_LANGS_DEFAULT + DEDALO_APPLICATION_LANG. */
	applicationLangsDefault: string;
	/** DEDALO_DATA_LANG_DEFAULT + DEDALO_DATA_LANG. */
	dataLangDefault: string;
	/** DEDALO_STRUCTURE_LANG — the ontology LABEL-FALLBACK lang (labels.ts; never a name). */
	structureLang: string;
	/** Non-empty when the input is unusable (empty set / default ∉ set / bad code). */
	errors: string[];
	/**
	 * The same sentences as `errors`, each tagged with the answer it is about:
	 * `langs` (the set), `app_lang_default`, `data_lang_default` (a default
	 * outside the set) — the terminal screen model shows each on its question.
	 */
	fieldErrors: { key: 'langs' | 'app_lang_default' | 'data_lang_default'; message: string }[];
}

/** Normalize the `langs` input to an ordered, de-duped code array. */
function toCodeArray(langs: string[] | string | undefined): string[] {
	const raw = Array.isArray(langs) ? langs : typeof langs === 'string' ? langs.split(',') : [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of raw) {
		const code = String(entry).trim();
		if (code !== '' && !seen.has(code)) {
			seen.add(code);
			out.push(code);
		}
	}
	return out;
}

/** Keep the codes that are well-formed AND catalog members; push an error per rejected code. */
function validCatalogCodes(codes: readonly string[], errors: string[]): string[] {
	const valid: string[] = [];
	for (const code of codes) {
		if (!isValidLang(code)) {
			errors.push(`invalid language code '${code}'`);
		} else if (INSTALL_LANG_CATALOG[code] === undefined) {
			errors.push(`unsupported language '${code}' (not in the install catalog)`);
		} else {
			valid.push(code);
		}
	}
	return valid;
}

/**
 * The picked codes. ABSENT (undefined) → the default working languages, so a
 * frontend that never collects langs still produces a bootable config. An
 * EXPLICIT empty set (operator unchecked everything) is an error — never
 * silently pick for them.
 */
function pickedCodes(
	langs: string[] | string | undefined,
	refuse: (key: 'langs', message: string) => void,
): string[] {
	if (langs === undefined) return [...INSTALL_DEFAULT_LANG_CODES];
	const codes = toCodeArray(langs);
	if (codes.length === 0) refuse('langs', 'at least one language must be selected');
	return codes;
}

/**
 * Derive the full lang config from the operator's picks, validating as it goes.
 * The picked set drives BOTH the map and the code list, so they can never
 * disagree. An absent set takes INSTALL_DEFAULT_LANG_CODES; the interface/data
 * defaults fall back to the first picked code when absent (and refuse when
 * out-of-set).
 */
export function deriveLangConfig(input: LangConfigInput): DerivedLangConfig {
	const errors: string[] = [];
	const fieldErrors: DerivedLangConfig['fieldErrors'] = [];
	const refuse = (key: DerivedLangConfig['fieldErrors'][number]['key'], message: string): void => {
		errors.push(message);
		fieldErrors.push({ key, message });
	};
	const codes = pickedCodes(input.langs, refuse);
	const codeErrors: string[] = [];
	const valid = validCatalogCodes(codes, codeErrors);
	for (const message of codeErrors) refuse('langs', message);

	const applicationLangs: Record<string, string> = {};
	for (const code of valid) applicationLangs[code] = INSTALL_LANG_CATALOG[code] as string;

	const first = valid[0] ?? INSTALL_LANG_CODES[0] ?? 'lg-eng';
	const pickDefault = (
		candidate: string | undefined,
		label: string,
		key: 'app_lang_default' | 'data_lang_default',
	): string => {
		if (candidate === undefined || candidate === '') return first;
		if (!valid.includes(candidate)) {
			refuse(key, `the ${label} language '${candidate}' is not in the selected set`);
			return first;
		}
		return candidate;
	};
	const applicationLangsDefault = pickDefault(
		input.appLangDefault,
		'default interface',
		'app_lang_default',
	);
	const dataLangDefault = pickDefault(input.dataLangDefault, 'default data', 'data_lang_default');

	return {
		applicationLangs,
		projectsDefaultLangs: valid,
		applicationLangsDefault,
		dataLangDefault,
		// The ontology label-fallback lang: lg-spa, the language every shipped
		// ontology label is guaranteed in. Only a label fallback — no name depends
		// on it (machine names are language-free, WC-2026-11-04-ontology-machine-names).
		structureLang: 'lg-spa',
		errors,
		fieldErrors,
	};
}
