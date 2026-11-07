/**
 * UI-label catalogs — the repo-owned label dictionaries (WC-033). Since the
 * 2026-07-16 label-model migration these files are the SINGLE source of truth
 * for program strings: dd_ontology rows with model='label' (the dd383
 * children) are INERT for the TS engine, and labels ride code deploys — not
 * ontology updates — so a key and the code referencing it always ship in the
 * same commit (rewrite/LABELS_RECONCILE.md records the one-time DB↔file merge).
 *
 * TWO ROLES, deliberately separated (they were one file at first — WC-033
 * amendment, same day):
 *
 *  - ../labels/master.json — the SOURCE OF DEFINITIONS: the complete key set,
 *    each with its source string. This is a ROLE, not a language preference:
 *    the master happens to be authored in MASTER_SOURCE_LANG (a fact about
 *    who writes the strings, gettext-msgid style).
 *  - ./catalog/lg-<code>.json — per-lang TRANSLATIONS of the master. All
 *    langs equal; sparse allowed (missing keys resolve via the chain below).
 *    EVERY application lang has a catalog file, including the master-source
 *    lang: its file is a sparse OVERRIDE (curated display text where it
 *    should differ from the master's source string) that starts empty — the
 *    master remains its baseline, so nothing is ever duplicated.
 *
 * Serving contract (WC-2026-11-07-labels-separate-resource): the merged
 * dictionary for an application lang, ALWAYS the full master key set, is its
 * OWN versioned HTTP resource — GET /api/v1/labels?lang=<lg>&v=<version>
 * (src/core/api/labels_resource.ts), immutable-cached when `v` is current.
 * The environment no longer carries it; page_globals.labels_version
 * (getLabelsVersion) names the version the client asks for. Route and
 * labels_version agree on the served lang through labelsServingLang (a lang
 * outside DEDALO_APPLICATION_LANGS → the install default). Fallback
 * criteria, in order (later overlays win; no hardcoded language priority):
 *
 *  1. master.json — the guaranteed-complete base (labels_tripwire);
 *  2. the INSTALL's default application lang (DEDALO_APPLICATION_LANGS_DEFAULT
 *     — the operator's choice, not the engine's);
 *  3. a declared LINGUISTIC alias (`translationLangOf`, driven by
 *     DEDALO_LANG_EQUIVALENCES, e.g. lg-vlca reads lg-cat — language
 *     proximity, preserving the aliasing PHP baked into its generated vlca
 *     file);
 *  4. the requested lang's own catalog.
 *
 * A missing per-lang catalog is normal (the chain serves); a missing or
 * malformed MASTER throws loudly — that is a broken deploy.
 */

import { createHash } from 'node:crypto';
import { config } from '../../config/config.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { translationLangOf } from '../resolve/lang_alias.ts';

/**
 * The language master.json is AUTHORED in. Requesting it serves the master
 * overlaid with its own catalog file only (a sparse display-text override —
 * no other lang may fill its gaps, since the master already covers them).
 * Change this only if the team rewrites the master strings in another language.
 */
export const MASTER_SOURCE_LANG = 'lg-eng';

/**
 * Merged-dictionary cache per requested lang. Master/catalog files and the
 * install default lang are immutable per deploy, so this never goes stale in
 * production; it lives in the ontology cache hub anyway (uniformity: EVERY
 * cache is invalidation-registered by construction) — a hub clear just
 * re-reads the files.
 */
const dictionaryCache = createOntologyCache<string, Record<string, string>>();
/** getLabelsVersion answer per lang — same lifecycle as dictionaryCache. */
const versionCache = createOntologyCache<string, string>();

export function clearLabelsCache(): void {
	dictionaryCache.clear();
	versionCache.clear();
}
registerOntologyCacheClearer(clearLabelsCache);

async function readJsonDict(url: URL): Promise<Record<string, string> | null> {
	const file = Bun.file(url.pathname);
	if (!(await file.exists())) return null;
	try {
		return (await file.json()) as Record<string, string>;
	} catch (error) {
		// A malformed label file is a broken deploy — surface it, never serve a
		// silently-narrowed dictionary.
		throw new Error(`UI-label file ${url.pathname} is not valid JSON: ${String(error)}`);
	}
}

/** One translation catalog, or null when that lang ships none. */
async function readCatalog(lang: string): Promise<Record<string, string> | null> {
	// Lang codes come from config/session ('lg-' + word chars); the guard keeps
	// a hostile value from ever forming a path segment.
	if (!/^lg-[a-z0-9_]+$/.test(lang)) return null;
	return readJsonDict(new URL(`./catalog/${lang}.json`, import.meta.url));
}

/**
 * The localized UI label dictionary served as `get_label` — the full master
 * key set, localized per the fallback criteria above.
 */
export async function getLabels(lang: string): Promise<Record<string, string>> {
	const cached = dictionaryCache.get(lang);
	if (cached !== undefined) return cached;

	const master = await readJsonDict(new URL('./master.json', import.meta.url));
	if (master === null) {
		throw new Error(
			'UI-label master.json (the source of definitions) is missing — the deploy is broken (src/core/labels/)',
		);
	}

	const labels: Record<string, string> = { ...master };
	// Overlay order = fallback criteria in reverse: default lang, then alias,
	// then the requested lang itself (later spreads win; duplicates skipped).
	// Requesting the master-source lang applies ONLY its own override catalog:
	// the master satisfies it completely, so no other lang may shadow it.
	const stages =
		lang === MASTER_SOURCE_LANG
			? [lang]
			: // Linguistic proximity (criterion 3) comes from the DECLARED language
				// equivalences (DEDALO_LANG_EQUIVALENCES — lg-vlca reads the Catalan
				// catalog; the pre-migration lg-vlca.js was a byte-copy of lg-cat.js),
				// not a private table: one source of truth with the ontology-term and
				// data-fallback consumers.
				[config.lang.applicationLangsDefault, translationLangOf(lang) ?? undefined, lang];
	const applied = new Set<string>();
	for (const stage of stages) {
		if (stage === undefined || applied.has(stage)) continue;
		applied.add(stage);
		Object.assign(labels, await readCatalog(stage));
	}

	dictionaryCache.set(lang, labels);
	return labels;
}

/**
 * The lang whose dictionary is SERVED for `lang` — ONE allowlist shared by the
 * labels route and page_globals.labels_version, so every lang the environment
 * can emit (a session lang set outside DEDALO_APPLICATION_LANGS, DATA_LANG_SYNC,
 * APPLICATION_LANG, a lang removed from the list) gets a 200, and the public
 * route's cache keys stay bounded by config. A configured application lang
 * serves itself; any other serves the install default.
 * shortcut: a non-configured lang loses its linguistic alias (lg-vlca → Catalan); map through translationLangOf if one is ever needed.
 */
export function labelsServingLang(lang: string): string {
	return Object.hasOwn(config.lang.applicationLangs, lang)
		? lang
		: config.lang.applicationLangsDefault;
}

/**
 * Content version of getLabels(lang): 16 hex of sha256 over the MERGED
 * dictionary (so install-config inputs — default lang, equivalences — are
 * covered, not just the files). The labels URL is built from it, so a
 * dictionary change is a new URL and the old one may stay immutable-cached.
 */
export async function getLabelsVersion(lang: string): Promise<string> {
	const cached = versionCache.get(lang);
	if (cached !== undefined) return cached;
	const version = createHash('sha256')
		.update(JSON.stringify(await getLabels(lang)))
		.digest('hex')
		.slice(0, 16);
	versionCache.set(lang, version);
	return version;
}
