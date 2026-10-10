/**
 * THE APP-LANG PICK of the two install manifests (ontology.json and
 * hierarchy.json): one display value out of a multilingual component's items.
 *
 * A PURE LEAF on purpose. The ontology census (data_io.ts) and the thesaurus
 * census (hierarchy_census.ts) pick a `name` with it at EXPORT time, and the
 * installer's thesaurus list (install/hierarchy_meta.ts hierarchyChoiceView)
 * re-picks from `name_data` at READ time in the requesting user's language —
 * and that reader is loaded by the install CLI BEFORE config.ts may be imported
 * (install_plan.ts cliBootEnv), so the rule cannot live in data_io.ts (which
 * imports config, the DB and the save path). One rule, no copies.
 */

/**
 * The value of the first item in `lang` that has one, else the first
 * non-empty value of any item, else ''.
 */
export function pickLangValue(
	items: readonly { lang?: string; value?: unknown }[] | undefined,
	lang: string,
): string {
	const list = items ?? [];
	const chosen = list.find((item) => item.lang === lang && hasValue(item)) ?? list.find(hasValue);
	return chosen === undefined ? '' : String(chosen.value);
}

/** An item carrying a displayable value (not undefined, null or ''). */
function hasValue(item: { value?: unknown }): boolean {
	return item.value !== undefined && item.value !== null && item.value !== '';
}
