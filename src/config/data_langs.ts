/**
 * THE DATA LANGUAGES THIS INSTALLATION DECLARES (DATA-01/DATA-25).
 *
 * ONE SET, and it is the READ-REACHABLE one. The read fallback chain
 * (`core/resolve/component_data.ts`) iterates, in order: the requested lang, its
 * declared equivalents, `DEDALO_DATA_LANG_DEFAULT`, `lg-nolan`, then
 * `DEDALO_PROJECTS_DEFAULT_LANGS`. A slice stored under any OTHER code is a
 * slice no read resolves through a language the install offers — the write
 * returned ok:true and the bytes became unreachable, which is the silent-loss
 * class this engine ranks above everything else. So the write chokepoint
 * (`core/section/record/save_component.ts`) admits exactly the codes that chain
 * can reach, and this module is where they are computed.
 *
 * WHY IT LIVES IN `src/config/` AND NOT AT THE CHOKEPOINT. Every language key
 * is read here already, and the set has a SECOND consumer that cannot import the
 * chokepoint: `config.menu.dataLang` itself (see `resolveCurrentDataLang`). One
 * home, two doors — "link, never duplicate". It also keeps `src/core/` free of
 * the `config.menu` lang reads the P0-7 census ratchets down.
 *
 * A LEAF: it imports only the code grammar. `src/config/` may not import
 * `src/core/`, so `lg-nolan` is spelled here rather than imported from
 * `core/ontology/ontology_tipos.ts` — which imports config, so the import would
 * be a cycle. That leaves two spellings of the same token (three, counting the
 * local `NOLAN` in `core/resolve/component_data.ts`); the way to ONE is for
 * core's `DATA_NOLAN` to re-export this constant, exactly as
 * `core/concepts/ontology.ts` re-exports `LANG_PATTERN` from `./lang_code.ts`.
 * That edit belongs to the file that owns `DATA_NOLAN`, not here.
 */

import { isDiffusionLangCode } from './lang_code.ts';

/**
 * The structural no-language token (PHP DEDALO_DATA_NOLAN): every
 * non-translatable write's lang, and never a real language. Always declared —
 * it is the one code whose meaning does not depend on configuration.
 */
export const NO_LANG = 'lg-nolan';

/** The language configuration the declared set is derived from. */
export interface DeclaredDataLangSource {
	/** DEDALO_DATA_LANG_DEFAULT — the read chain's first fallback candidate. */
	readonly dataLangDefault: string;
	/** DEDALO_PROJECTS_DEFAULT_LANGS — what the read fallback chain iterates. */
	readonly projectLangs: readonly string[];
	/** DEDALO_LANG_EQUIVALENCES — the classes whose members substitute for each other. */
	readonly equivalences: readonly (readonly string[])[];
}

/**
 * Build the declared-language set from a language configuration.
 *
 * DELIBERATELY NOT AN INPUT: `DEDALO_DATA_LANG`. It is the MENU's current data
 * language — a per-user selection whose configured value is only the starting
 * point — and it is NOT in the read fallback chain. Seeding it here (the shape
 * this file replaced, 2026-08-27) bought the engine a write language no read
 * ever reaches: a silent write-to-nowhere, which is worse than the refusal it
 * was added to prevent. The outage that motivated the seeding is closed at the
 * other end instead — `resolveCurrentDataLang` below keeps the menu language
 * INSIDE this set, and `currentDataLang()` falls back to
 * `DEDALO_DATA_LANG_DEFAULT` outside any request scope.
 *
 * `DEDALO_APPLICATION_LANGS` is not an input either: a UI language is not a data
 * language — an install may offer an interface in a language it does not
 * catalogue in — and admitting them would make the gate agree with a set no read
 * path consults.
 *
 * A pure function of an explicit source rather than a closure over `config`, so
 * the rule is testable on a configuration whose keys DISAGREE — which is the
 * only shape that can tell "the set is built from these keys" from "this install
 * happens to set every key to the same code".
 */
export function declaredDataLangs(source: DeclaredDataLangSource): ReadonlySet<string> {
	// THE ASSERTION, and it runs BEFORE the value is seeded — seeding first is
	// what made the previous version of this check unfirable (it could only fail
	// on the empty string, because the empty string was the one value the seed
	// filtered out). DEDALO_DATA_LANG_DEFAULT is the read chain's first fallback
	// candidate AND the language the engine writes in outside any request scope,
	// so a value that names no single real language ('', 'spa', 'all') puts every
	// engine-default write into a slice nothing resolves. Named as an OPERATOR
	// fixes it (../private/.env), not as the TS path that reads it.
	if (!isDiffusionLangCode(source.dataLangDefault)) {
		throw new Error(
			`config: DEDALO_DATA_LANG_DEFAULT = '${source.dataLangDefault}' does not name one real ` +
				"language (expected a 'lg-xxx' code; 'all' is a stored-value sentinel, not a " +
				"language). It is the data-read fallback chain's first candidate and the language " +
				'the engine writes in outside any request, so every such write would land in a ' +
				'slice no read resolves (src/config/data_langs.ts).',
		);
	}
	// The project languages are taken VERBATIM, malformations included: the read
	// chain iterates this same list, so a typo there is reachable-but-wrong, not
	// unreachable. Agreement with the read path is this set's whole job; policing
	// the operator's spelling belongs to the key's own validator.
	const langs = new Set<string>([NO_LANG, source.dataLangDefault, ...source.projectLangs]);
	// A declared EQUIVALENCE class is symmetric for DATA (`resolve/lang_alias.ts`):
	// data written in any member is first-choice fallback for every other member,
	// so a class with one declared member has all its members declared.
	for (const group of source.equivalences) {
		if (group.some((code) => langs.has(code))) {
			for (const code of group) langs.add(code);
		}
	}
	return langs;
}

/** What `resolveCurrentDataLang` decided, and whether it had to overrule the key. */
export interface CurrentDataLangResolution {
	/** The install's current data language — always a member of the declared set. */
	readonly lang: string;
	/** True when DEDALO_DATA_LANG was outside the set and had to be overruled. */
	readonly replaced: boolean;
}

/**
 * Resolve `DEDALO_DATA_LANG` — the install's CURRENT data language — against the
 * declared set, so it can never be a language the install does not declare.
 *
 * WHY THIS EXISTS. `DEDALO_DATA_LANG` is a separate key from
 * `DEDALO_DATA_LANG_DEFAULT` and nothing makes the two agree, yet the configured
 * value is what a session without a language choice writes in: dispatch seeds
 * the request-language scope with it, the client reads it back as
 * `page_globals.dedalo_data_lang`, and the save carries it. A value outside the
 * declared set therefore had exactly two possible fates, both bad — refused by
 * the write chokepoint (a total interactive write outage for every fresh
 * session), or admitted into a slice the read chain never reaches.
 *
 * So it is neither: an out-of-set value is OVERRULED by
 * `DEDALO_DATA_LANG_DEFAULT`, which is by construction both declared and the
 * read chain's first candidate. Nothing is stranded by the substitution — data
 * already stored under the overruled code was unreachable before it (the data
 * language SELECTOR only offers the project languages, and the fallback chain
 * never consults DEDALO_DATA_LANG), and the caller reports the fact with the
 * action that recovers it: add the language to DEDALO_PROJECTS_DEFAULT_LANGS.
 *
 * NOT A THROW. An unconfigured box is exactly this shape — its sentinels
 * hold PROJECTS_DEFAULT_LANGS ['lg-eng'] while DATA_LANG is its catalog
 * default 'lg-spa' — and `config` must stay importable there (the installer's
 * probe child, config:gen, the server on its way to its not-installed refusal). The precedent is one screen up in config.ts: DEDALO_DIFFUSION_LANGS
 * reports at boot and refuses at the point of use, because a server whose
 * editors are working must not die for a language-list mistake.
 */
export function resolveCurrentDataLang(
	configured: string,
	declared: ReadonlySet<string>,
	dataLangDefault: string,
): CurrentDataLangResolution {
	if (declared.has(configured)) return { lang: configured, replaced: false };
	return { lang: dataLangDefault, replaced: true };
}
