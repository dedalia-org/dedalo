/**
 * THE SUITE POSTURE — config values the test suite runs with, whatever the
 * developer's ../private/.env says. One copy, read by the bun test preload
 * (test/preload/test_database.ts) and held EQUAL to the hosted CI tier's own
 * default (scripts/ci/hosted_env.sh) by media_export_base.test.ts, so a local
 * run and CI measure the same branches — and the unit baseline's per-file
 * floors mean the same thing on every machine.
 *
 * Plain constants: the preload imports this BEFORE src/config/config.ts freezes,
 * so nothing here may import engine code.
 */

/**
 * DEDALO_MEDIA_EXPORT_BASE. Unset, every export/relation cell that leaves the
 * app is reported unresolved and the media-ZIP gates that read cells skip or
 * go red (tool_export_media_zip_native R4/R7, tool_export_native) — measured
 * 2026-09-26 on a .env without the key. The value is only string-compared.
 */
export const SUITE_MEDIA_EXPORT_BASE = 'http://localhost:8080/dedalo/media';

/**
 * THE SUITE'S LANGUAGES (install campaign 3, C3-40). The declared data-language
 * set (`INSTALLED_DATA_LANGS`, src/config/config.ts) is derived from these keys,
 * and the save chokepoint refuses a write in any other language. Inherited from
 * a developer's ../private/.env — a fresh install declares two — about 25 gates
 * that write in the suite's own languages went red as
 * "lang 'lg-…' is not one this installation declares". Pinned here to the
 * hosted CI tier's defaults (scripts/ci/hosted_env.sh, held equal by
 * media_export_base.test.ts), so every machine measures the same language set.
 * A value the SHELL exports still wins (`suiteLangPins`), as in CI.
 */
export const SUITE_LANGS: Readonly<Record<string, string>> = Object.freeze({
	DEDALO_APPLICATION_LANGS:
		'{"lg-spa":"Castellano","lg-cat":"Català","lg-eng":"English","lg-fra":"Français","lg-por":"Português","lg-deu":"German","lg-ell":"Ελληνικά","lg-ita":"Italiano"}',
	DEDALO_APPLICATION_LANGS_DEFAULT: 'lg-spa',
	DEDALO_DATA_LANG_DEFAULT: 'lg-spa',
	DEDALO_PROJECTS_DEFAULT_LANGS:
		'["lg-spa","lg-cat","lg-vlca","lg-eus","lg-eng","lg-por","lg-fra","lg-ara","lg-ell","lg-deu","lg-ita","lg-nep"]',
	// THE PUBLICATION LANGUAGES (T1-4 review). Unset, config derives them from
	// DEDALO_PROJECTS_DEFAULT_LANGS — but a developer .env that SETS it (lg-eng first,
	// or without lg-eng) moved the plan's main lang and its lang set, and the
	// diffusion gates that pin a published document (diffusion_rdf_graph_native's
	// es-before-en literals, the main-lang fill of an untranslated slot) went
	// red for an environment reason. Pinned to exactly what the derivation
	// yields from the project languages above, so CI's value is unchanged.
	DEDALO_DIFFUSION_LANGS:
		'["lg-spa","lg-cat","lg-vlca","lg-eus","lg-eng","lg-por","lg-fra","lg-ara","lg-ell","lg-deu","lg-ita","lg-nep"]',
});

/**
 * The SUITE_LANGS entries to write into the process environment: every key the
 * shell did not set (`shellSets` — the preload passes the engine's own
 * process-env reader, which also knows each key's alternative spelling). The
 * process environment outranks ../private/.env, so the developer's file never
 * reaches the suite.
 */
export function suiteLangPins(
	shellSets: (key: string) => boolean,
	shellValue: (key: string) => string | undefined = () => undefined,
): [string, string][] {
	// DEDALO_DIFFUSION_LANGS is DERIVED from DEDALO_PROJECTS_DEFAULT_LANGS (the pin is
	// "exactly what the derivation yields from the project languages above").
	// A shell that sets its own project languages but not the publication ones
	// (the hermetic tier: lg-eng only) gets the publication set derived from ITS
	// project value — pinning the suite's 12 would name languages outside the
	// shell's project set (every plan compile refuses, config.ts
	// langsOutsideProject), and leaving it unpinned would let a developer's
	// ../private/.env value through.
	const shellProject = shellSets('DEDALO_PROJECTS_DEFAULT_LANGS')
		? shellValue('DEDALO_PROJECTS_DEFAULT_LANGS')
		: undefined;
	const pins: [string, string][] = [];
	for (const [key, value] of Object.entries(SUITE_LANGS)) {
		if (shellSets(key)) continue;
		if (key === 'DEDALO_DIFFUSION_LANGS' && shellSets('DEDALO_PROJECTS_DEFAULT_LANGS')) {
			if (shellProject !== undefined) pins.push([key, shellProject]);
			continue;
		}
		pins.push([key, value]);
	}
	return pins;
}
