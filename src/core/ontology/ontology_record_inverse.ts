/**
 * The INVERSE of the ontology parser — one ontology node (`DdOntologyNode`)
 * turned back into the jsonb columns of its `matrix_ontology` `<tld>0` source
 * record, plus the `matrix_ontology_main` (`ontology35`) registry row its main
 * node is derived from.
 *
 * Split out of `src/core/test_data/test_tld_materialize.ts` (2026-10-01,
 * closure Step 3 / TOOLS-4) because it now has TWO doors: the test-only door
 * that materializes the generic `test` TLD into a marked suite database, and
 * the PRODUCTION door that materializes the engine-owned ontology
 * (`./engine_ontology.ts`) into every installation at boot. A pure builder
 * belongs to neither: the field → component map below is the one law both
 * doors write by, and `parseSectionRecordToOntologyNode` (`./parser.ts`) is
 * the law that reads it back. `test/unit/test_tld_ontology_gate.test.ts` (b)/(c)
 * pin the map and the real round trip.
 *
 *   | node field        | component  | matrix column | note                      |
 *   |-------------------|------------|---------------|---------------------------|
 *   | parent            | ontology15 | relation      | locator, relation type dd47 |
 *   | model_tipo        | ontology6  | relation      | locator (dd151)           |
 *   | relations[]       | ontology10 | relation      | one locator per entry     |
 *   | is_translatable   | ontology8  | relation      | dd64/1 yes, dd64/2 no     |
 *   | is_model          | ontology30 | relation      | dd64/1 yes, dd64/2 no     |
 *   | term{lang:value}  | ontology5  | string        | one item per lang         |
 *   | tld               | ontology7  | string        | lg-nolan, MANDATORY       |
 *   | properties.css    | ontology16 | misc          |                           |
 *   | properties.source | ontology17 | misc          |                           |
 *   | properties (rest) | ontology18 | misc          |                           |
 *   | propiedades       | ontology19 | misc          | v5 legacy JSON text       |
 *   | order_number      | ontology41 | number        |                           |
 *
 * PURE except `provisionOntologyMainRegistry`, which writes through
 * `addMainSection` (the registry's own idempotent door). No guard lives here:
 * each door owns its own (the test door's marker check, the engine door's
 * "only its own TLD" rule).
 */

import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import type { DdOntologyNode } from '../db/dd_ontology.ts';
import type { MatrixJsonbColumn } from '../db/matrix.ts';
import { withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/index.ts';
import {
	DATA_NOLAN,
	ONTOLOGY_CONNECTED_TO,
	ONTOLOGY_CSS,
	ONTOLOGY_IS_MODEL,
	ONTOLOGY_MODEL,
	ONTOLOGY_ORDER,
	ONTOLOGY_PARENT,
	ONTOLOGY_PROPERTIES,
	ONTOLOGY_PROPIEDADES_V5,
	ONTOLOGY_SOURCE,
	ONTOLOGY_TERM,
	ONTOLOGY_TLD,
	ONTOLOGY_TRANSLATABLE,
	RELATION_TYPE_LINK,
	RELATION_TYPE_PARENT,
	SI_NO_NO,
	YES_NO_SECTION,
	SI_NO_YES,
} from './ontology_tipos.ts';
import { addMainSection } from './ontology_write.ts';
import { getSectionIdFromTipo, getTldFromTipo, safeTld } from './tld.ts';

/** The jsonb columns of one materialized record — what the parser reads back. */
export type OntologyRecordColumns = Partial<Record<MatrixJsonbColumn, unknown>>;

/** A node that cannot be inverted: an integrity failure of the definitions, never a caller fault. */
function refuse(message: string, coordinates: Record<string, string | number> = {}): never {
	throw new DedaloError('internal.invariant', {
		message: `ontology record inverse: ${message}`,
		coordinates,
	});
}

/** A stored literal item, exactly as the parser reads it back ({id, lang, value}). */
function literalItem(id: number, lang: string, value: unknown): Record<string, unknown> {
	return { id, lang, value };
}

/**
 * A stored relation locator. `section_id` goes through the ONE canonical
 * door (WC-2026-08-10-section-id-int-canonical), same as
 * `ontology_write.relationLocator`.
 */
function relationLocator(
	id: number,
	type: string,
	targetTipo: string,
	fromComponentTipo: string,
): Record<string, unknown> {
	const tld = getTldFromTipo(targetTipo);
	const sectionId = getSectionIdFromTipo(targetTipo);
	if (tld === null || sectionId === null) {
		refuse(`'${targetTipo}' is not a <tld><id> tipo (referenced by ${fromComponentTipo})`, {
			tipo: targetTipo,
		});
	}
	return {
		id,
		type,
		section_id: canonicalizeStoredSectionId(sectionId),
		section_tipo: `${tld}0`,
		from_component_tipo: fromComponentTipo,
	};
}

/** The si/no locator a boolean flag is stored as (dd64/1 = yes, dd64/2 = no). */
function yesNoLocator(value: boolean, fromComponentTipo: string): Record<string, unknown> {
	return {
		id: 1,
		type: RELATION_TYPE_LINK,
		section_id: canonicalizeStoredSectionId(value ? SI_NO_YES : SI_NO_NO),
		section_tipo: YES_NO_SECTION,
		from_component_tipo: fromComponentTipo,
	};
}

/** A nullable tipo field the parser reads as "set" (present and non-empty). */
const isSetTipo = (value: string | null | undefined): value is string =>
	value !== null && value !== undefined && value !== '';

/** `relation` — parent, model, connected_to, and the two always-written flags. */
function relationColumnFromNode(node: DdOntologyNode): Record<string, unknown[]> {
	const relation: Record<string, unknown[]> = {};
	if (isSetTipo(node.parent)) {
		relation[ONTOLOGY_PARENT] = [
			relationLocator(1, RELATION_TYPE_PARENT, node.parent, ONTOLOGY_PARENT),
		];
	}
	if (isSetTipo(node.model_tipo)) {
		relation[ONTOLOGY_MODEL] = [
			relationLocator(1, RELATION_TYPE_LINK, node.model_tipo, ONTOLOGY_MODEL),
		];
	}
	if ((node.relations?.length ?? 0) > 0 && node.relations !== null) {
		relation[ONTOLOGY_CONNECTED_TO] = node.relations.map((item, index) =>
			relationLocator(index + 1, RELATION_TYPE_LINK, item.tipo, ONTOLOGY_CONNECTED_TO),
		);
	}
	// Always written: the parser reads a MISSING ontology8 as translatable=true.
	relation[ONTOLOGY_TRANSLATABLE] = [yesNoLocator(node.is_translatable, ONTOLOGY_TRANSLATABLE)];
	relation[ONTOLOGY_IS_MODEL] = [yesNoLocator(node.is_model, ONTOLOGY_IS_MODEL)];
	return relation;
}

/** `string` — the MANDATORY tld plus one term item per language. */
function stringColumnFromNode(node: DdOntologyNode, tld: string): Record<string, unknown[]> {
	// The tld is MANDATORY — a record without it parses into nothing at all.
	const string: Record<string, unknown[]> = { [ONTOLOGY_TLD]: [literalItem(1, DATA_NOLAN, tld)] };
	const items = Object.entries(node.term ?? {}).map(([lang, value]) => literalItem(1, lang, value));
	if (items.length > 0) string[ONTOLOGY_TERM] = items;
	return string;
}

/**
 * `propiedades` (v5 legacy) as the parser stores it back: parsed JSON when it
 * is JSON, otherwise the raw text verbatim (phpPrettyJsonEncode of a string is
 * that string, quoted), which is the only round-tripping choice.
 */
function propiedadesValue(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/**
 * `misc` — the three components `properties` is the MERGE of (parser:
 * ontology18 first, then .css, then .source), so the split is by key, and a key
 * that is PRESENT-BUT-NULL still belongs to its own component; plus the v5
 * `propiedades` text.
 */
function miscColumnFromNode(node: DdOntologyNode): Record<string, unknown[]> {
	const misc: Record<string, unknown[]> = {};
	const allProperties = node.properties ?? {};
	const { css, source, ...restProperties } = allProperties;
	if (Object.hasOwn(allProperties, 'css')) misc[ONTOLOGY_CSS] = [{ id: 1, value: css }];
	if (Object.hasOwn(allProperties, 'source')) misc[ONTOLOGY_SOURCE] = [{ id: 1, value: source }];
	if (Object.keys(restProperties).length > 0) {
		misc[ONTOLOGY_PROPERTIES] = [{ id: 1, value: restProperties }];
	}
	if (isSetTipo(node.propiedades)) {
		misc[ONTOLOGY_PROPIEDADES_V5] = [{ id: 1, value: propiedadesValue(node.propiedades) }];
	}
	return misc;
}

/** The two identity facts every column needs, both REQUIRED by the parser. */
function nodeIdentity(node: DdOntologyNode): { tld: string; sectionId: number } {
	const tld = node.tld ?? getTldFromTipo(node.tipo);
	if (tld === null || safeTld(tld) === null) {
		refuse(`node '${node.tipo}' has no valid tld`, { tipo: node.tipo });
	}
	const sectionId = getSectionIdFromTipo(node.tipo);
	if (sectionId === null) refuse(`node '${node.tipo}' has no section_id part`, { tipo: node.tipo });
	return { tld, sectionId: Number(sectionId) };
}

/** `data` — the row's own coordinates plus the human label the list shows. */
function dataColumnFromNode(
	node: DdOntologyNode,
	tld: string,
	sectionId: number,
): OntologyRecordColumns['data'] {
	return {
		section_id: sectionId,
		section_tipo: `${tld}0`,
		label: node.term?.['lg-eng'] ?? node.term?.['lg-spa'] ?? node.tipo,
	};
}

/**
 * ONE ontology node → the jsonb columns of its `matrix_ontology` record — the
 * exact inverse of `parseSectionRecordToOntologyNode` (module header table).
 *
 * PURE: no database, no ontology lookups. The column each component lands in is
 * FIXED here rather than resolved through `getModelByTipo` +
 * `getColumnNameByModel`, because those are the very rows this door is
 * bootstrapping; the gate asserts the two agree, so a model change on an
 * `ontology*` component cannot drift silently.
 *
 * A component is OMITTED when the node's value is null/absent, which is
 * precisely how the parser reads "not set" (`getComponentItems` → null): an
 * absent `ontology15` parses to `parent: null`, an absent `ontology41` to
 * `order_number: null`. The one exception is `ontology8`: the parser DEFAULTS a
 * missing translatable flag to TRUE, so the flag is always written.
 *
 * The four per-column builders above are the halves of that inverse, split out
 * so each stays readable (and under the complexity cap).
 */
export function ontologyRecordFromNode(node: DdOntologyNode): OntologyRecordColumns {
	const { tld, sectionId } = nodeIdentity(node);
	const misc = miscColumnFromNode(node);
	const columns: OntologyRecordColumns = {
		data: dataColumnFromNode(node, tld, sectionId),
		relation: relationColumnFromNode(node),
		string: stringColumnFromNode(node, tld),
	};
	if (Object.keys(misc).length > 0) columns.misc = misc;
	if (node.order_number !== null) {
		columns.number = { [ONTOLOGY_ORDER]: [{ id: 1, value: node.order_number }] };
	}
	return columns;
}

/* -------------------------------------------------- the main-node registry */

/**
 * Write the `matrix_ontology_main` (`ontology35`) registry row a TLD's `<tld>0`
 * main node is derived from, taking BOTH of its variable fields straight out of
 * the JSON node:
 *
 *   node.term            → `hierarchy5`  (the main record's name, per language)
 *   node.parent          → `hierarchy9`  (the typology; `ontologytype<id>` IS
 *                                         the grouper the rebuild re-derives)
 *
 * Everything else the registry carries (project filter, language, active flags,
 * target section) is `addMainSection`'s own contract and is left to it —
 * IDEMPOTENT, reusing the row whose `hierarchy6` already names this TLD.
 *
 * The inverse is `createDdOntologyRootNode`: it builds `<tld>0` with
 * `parent = ontologytype<typology_id>` and `term = termFromNameData(name_data)`.
 * So writing the row from the node and letting the rebuild mint the node from
 * the row is a round trip, and the gate's "dd_ontology equals the JSON node for
 * node" check is what proves it closed.
 */
export async function provisionOntologyMainRegistry(mainNode: DdOntologyNode): Promise<void> {
	const tld = mainNode.tld ?? getTldFromTipo(mainNode.tipo);
	if (tld === null) refuse(`main node '${mainNode.tipo}' has no tld`, { tipo: mainNode.tipo });
	// The typology grouper: `createParentGrouper` builds `ontologytype<id>`, so
	// the id is readable straight off the node's parent. A main node parented
	// anywhere else keeps the registry's default (PHP's 'others', 15).
	const typology = /^ontologytype([0-9]+)$/.exec(mainNode.parent ?? '');
	const nameData = Object.entries(mainNode.term ?? {}).map(([lang, value]) => ({
		id: 1,
		lang,
		value: String(value),
	}));
	await withTransaction(async () => {
		await addMainSection({
			tld,
			typology_id: typology === null ? null : Number(typology[1]),
			name_data: nameData.length > 0 ? nameData : null,
		});
	});
}
