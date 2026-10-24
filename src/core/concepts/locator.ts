/**
 * LOCATOR — the universal relation pointer (spec §3.5).
 *
 * A locator is the value object Dédalo uses to point at "a record" (and,
 * optionally, at a specific component, tag, language or data item inside it).
 * Relation components (portal, relation_parent/children/related/index, tags in
 * text areas, …) store ARRAYS OF LOCATORS as their data. Subdatum resolution
 * (spec §3.8) expands those locators into resolved child component values.
 *
 * PHP reference: core/common/class.locator.php.
 *
 * Contract highlights:
 * - `section_tipo` + `section_id` are the mandatory core. Everything else is
 *   optional and relation-flavour specific.
 * - `section_id` CANONICAL FORM IS AN INT (WC-2026-08-10-section-id-int-canonical, repealing the historical string-canonical law). Stored legacy
 *   data still contains numeric strings until the migration sweep runs, and
 *   external-service locators carry STRING remote ids permanently (zenon
 *   zero-padded, wikidata opaque) — so parse stays tolerant and comparison
 *   stays value-based. Writers mint ints; see ./section_id.ts for the
 *   record-address concept and the conversion rule.
 * - Dataframe pairing uses `id_key` (the stable id of the main component's data
 *   item). The legacy `section_id_key`/`section_tipo_key` fields still appear
 *   in old stored data and must be READ (BC) but never written anew.
 * - Equality is property-set based (compare only the requested properties),
 *   mirroring PHP locator::compare_locators. Relation integrity (add/remove of
 *   relations, dedup in subdatum) depends on these exact semantics.
 */

import { z } from 'zod';

/**
 * A section id as it appears in STORED matrix JSON. Canonical form is an INT
 * (WC-2026-08-10-section-id-int-canonical); the string leg of the union is
 * PARSE TOLERANCE for pre-migration data, old backups and TM snapshots, and
 * narrows at contraction (plan P6). The record-address concept itself is the
 * branded int in ./section_id.ts — this union is the storage-shape twin, not
 * the concept.
 */
export const sectionIdSchema = z.union([z.number(), z.string()]);
export type StoredSectionId = z.infer<typeof sectionIdSchema>;

/**
 * The locator shape. `.passthrough()` is deliberate: stored locators may carry
 * extra keys we have not modeled yet; dropping them on re-save would violate
 * byte-compat (spec §2.2). Unknown keys survive parse → serialize untouched.
 */
export const locatorSchema = z
	.object({
		// --- mandatory core -------------------------------------------------
		/** Ontology tipo of the target section, e.g. 'numisdata3'. */
		section_tipo: z.string(),
		/** Record id inside that section. */
		section_id: sectionIdSchema,

		// --- relation flavour (all optional) ---------------------------------
		/** Destination component tipo (which component in the target the relation points at). */
		component_tipo: z.string().optional(),
		/** Source component tipo — the component that CREATED the relation. */
		from_component_tipo: z.string().optional(),
		/** Relation type tipo, e.g. 'dd151' (dd_relation) or a tag/dataframe type. */
		type: z.string().optional(),
		/** Directionality of the relation. */
		type_rel: z.string().optional(),
		/** Language of the pointed value, 'lg-*' code. */
		lang: z.string().optional(),

		// --- inline-tag pointers (text components) ---------------------------
		tag_id: z.union([z.number(), z.string()]).optional(),
		tag_component_tipo: z.string().optional(),
		tag_type: z.string().optional(),

		// --- dataframe pairing (spec §3.8 id_key contract) --------------------
		/** Stable id of the paired main-component data item. UNIFIED v7 field. */
		id_key: z.number().optional(),
		/** @deprecated legacy dataframe pairing — read for BC, never write anew. */
		section_id_key: sectionIdSchema.optional(),
		/** @deprecated legacy dataframe pairing — read for BC, never write anew. */
		section_tipo_key: z.string().optional(),
		/** Owning parent component of a dataframe pairing. */
		main_component_tipo: z.string().optional(),

		// --- misc ------------------------------------------------------------
		/** Generic integer id used by pseudo-locators (dataframe subdatum). */
		id: z.union([z.number(), z.string()]).optional(),
		/** Zero-based pagination index (paginated portals). */
		paginated_key: z.number().optional(),
	})
	.passthrough();

export type Locator = z.infer<typeof locatorSchema>;

/**
 * Default property set of the KEY-BASED lookup functions (in_array_locator /
 * build_locator_lookup_key) — verbatim PHP class.locator.php:1031/:1099. This
 * 5-field predicate is what relation components use to define locator
 * uniqueness (dedup on add, membership tests).
 */
export const DEFAULT_LOCATOR_KEY_PROPERTIES: readonly string[] = [
	'section_tipo',
	'section_id',
	'type',
	'component_tipo',
	'tag_id',
];

/** PHP DELIMITER ('_') used by build_locator_lookup_key (class.locator.php:50). */
export const LOCATOR_KEY_DELIMITER = '_';

/**
 * section_id loose equality (PHP `!=`, class.locator.php:999-1002): the id may
 * be stored as int in one locator and numeric string in another depending on
 * the hydration path. PHP 8 loose comparison compares two numeric strings
 * NUMERICALLY ("5" == "05" is true); reproduce that exactly, and ONLY for
 * section_id. Never applied to stored data.
 */
function sectionIdLooselyEquals(valueA: unknown, valueB: unknown): boolean {
	if (valueA === valueB) return true;
	const stringA = String(valueA).trim();
	const stringB = String(valueB).trim();
	const numberA = Number(stringA);
	const numberB = Number(stringB);
	if (stringA !== '' && stringB !== '' && Number.isFinite(numberA) && Number.isFinite(numberB)) {
		return numberA === numberB;
	}
	return String(valueA) === String(valueB);
}

/**
 * Compare two locators property by property (PHP locator::compare_locators,
 * class.locator.php:956). Faithful semantics:
 * - `properties` empty (the default) -> compare the UNION of both locators'
 *   own keys, minus `excludeProperties`;
 * - property missing on BOTH sides -> skip (still equal);
 * - property present on exactly ONE side -> not equal;
 * - `section_id` compares loosely (int 5 == "5"); every OTHER property
 *   compares strictly (===): tag_id 5 vs "5" is NOT equal here.
 * Relation add/remove integrity depends on these exact rules.
 * - a NON-OBJECT side (a bare legacy id `2`, a label string, null) is not a
 *   locator and equals NOTHING → false. PHP typed both params `object` and
 *   threw a TypeError; here the stored data is untrusted (decade-scale TM
 *   history carries pre-v7 shapes), and one non-locator entry must not take a
 *   whole read down through `in` on a primitive. Between two objects the rules
 *   above are unchanged.
 */
export function compareLocators(
	locatorA: Locator,
	locatorB: Locator,
	properties: readonly string[] = [],
	excludeProperties: readonly string[] = [],
): boolean {
	if (!isLocatorObject(locatorA) || !isLocatorObject(locatorB)) return false;
	return compareLocatorRecords(
		locatorA as Record<string, unknown>,
		locatorB as Record<string, unknown>,
		properties,
		excludeProperties,
	);
}

/** compareLocators over two objects (the rules in its doc comment). */
function compareLocatorRecords(
	recordA: Record<string, unknown>,
	recordB: Record<string, unknown>,
	properties: readonly string[],
	excludeProperties: readonly string[],
): boolean {
	let compareList: readonly string[] = properties;
	if (compareList.length === 0) {
		const excluded = new Set(excludeProperties);
		const union = new Set<string>();
		for (const key of Object.keys(recordA)) {
			if (!excluded.has(key)) union.add(key);
		}
		for (const key of Object.keys(recordB)) {
			if (!excluded.has(key)) union.add(key);
		}
		compareList = [...union];
	}
	for (const property of compareList) {
		const existsInA = property in recordA;
		const existsInB = property in recordB;
		if (!existsInA && !existsInB) continue;
		if (existsInA !== existsInB) return false;
		if (property === 'section_id') {
			if (!sectionIdLooselyEquals(recordA[property], recordB[property])) return false;
		} else if (recordA[property] !== recordB[property]) {
			return false;
		}
	}
	return true;
}

/** Whether a value can be a locator at all (a non-null object, not an array). */
function isLocatorObject(value: unknown): boolean {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Membership test in a locator array (PHP locator::in_array_locator,
 * class.locator.php:1031): KEY-BASED — builds the lookup key for the needle
 * and each candidate and compares strings, so it inherits the key's
 * stringified (loose) matching on every property, unlike compareLocators.
 */
export function isLocatorInArray(
	needle: Locator,
	haystack: readonly Locator[],
	properties: readonly string[] = DEFAULT_LOCATOR_KEY_PROPERTIES,
): boolean {
	const needleKey = buildLocatorLookupKey(needle, properties);
	return haystack.some((candidate) => buildLocatorLookupKey(candidate, properties) === needleKey);
}

/**
 * Build the composite lookup key over a property set (PHP
 * locator::build_locator_lookup_key, class.locator.php:1099): the property
 * values (missing -> '') joined with '_' (PHP DELIMITER). NOTE this
 * stringifies: 5 and "5" produce the SAME key (looser than compareLocators'
 * strict fields), and PHP documents that collisions are possible when the
 * property list does not uniquely identify the locators; both quirks are part
 * of the contract.
 */
export function buildLocatorLookupKey(
	locator: Locator,
	properties: readonly string[] = DEFAULT_LOCATOR_KEY_PROPERTIES,
): string {
	return properties
		.map((property) => {
			const value = (locator as Record<string, unknown>)[property];
			return value === undefined || value === null ? '' : String(value);
		})
		.join(LOCATOR_KEY_DELIMITER);
}

/** Canonical term id string, e.g. 'es1_185' (PHP locator::get_term_id_from_locator). */
export function getTermIdFromLocator(locator: Locator): string {
	return `${locator.section_tipo}_${locator.section_id}`;
}
