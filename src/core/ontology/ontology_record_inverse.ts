/**
 * The INVERSE of the ontology parser — one ontology node (`DdOntologyNode`)
 * turned back into the jsonb columns of its `matrix_ontology` `<tld>0` source
 * record, plus the `matrix_ontology_main` (`ontology35`) registry row its main
 * node is derived from.
 *
 * Split out of `src/core/test_data/test_tld_materialize.ts` (2026-10-01). Its
 * one door today is the test-only door that materializes the generic `test`
 * TLD into a marked suite database (the engine-owned ontology door that also
 * wrote by it was REMOVED 2026-10-12: the engine owns no ontology definition).
 * It stays an ontology-layer module because it is the inverse of the parser,
 * not test policy: the field → component map below is the law a JSON node is
 * written by, and `parseSectionRecordToOntologyNode` (`./parser.ts`) is
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
 *   | machine_name      | ontology43 | string        | lg-nolan, WHEN NEEDED (1) |
 *   | use_machine_name  | ontology44 | relation      | dd64/1 yes, dd64/2 no (1) |
 *
 * (1) The machine-name pair is written only where the node's values DIFFER
 * from what the parser's legacy rungs derive from the rest of the record
 * (ontology/machine_name.ts deriveLegacyMachineName): an unconverted node —
 * its name still in ontology5 lg-spa, its flag its classification — is
 * written exactly as before, and parses back to the same columns through the
 * rungs; a converted one (name ≠ lg-spa, no lg-spa, or a flag that is not the
 * classification) states its components. On an ontology release that does
 * not define ontology43/44 yet the parser ignores them, so such a node only
 * round-trips once the release carries them — the honest outcome.
 *
 * PURE except `provisionOntologyMainRegistry`, which writes through
 * `syncMainSectionFromDefinition` (the registry's IMPORT door — a JSON node is
 * an ontology definition). No guard lives here: the calling door owns it (the
 * test door's marker check).
 */

import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import type { DdOntologyNode } from '../db/dd_ontology.ts';
import type { MatrixJsonbColumn } from '../db/matrix.ts';
import { withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/index.ts';
import { resolveLabel } from './labels.ts';
import { deriveLegacyMachineName } from './machine_name.ts';
import {
	DATA_NOLAN,
	ONTOLOGY_CONNECTED_TO,
	ONTOLOGY_CSS,
	ONTOLOGY_IS_MODEL,
	ONTOLOGY_MACHINE_NAME,
	ONTOLOGY_MODEL,
	ONTOLOGY_ORDER,
	ONTOLOGY_PARENT,
	ONTOLOGY_PROPERTIES,
	ONTOLOGY_PROPIEDADES_V5,
	ONTOLOGY_SOURCE,
	ONTOLOGY_TERM,
	ONTOLOGY_TLD,
	ONTOLOGY_TRANSLATABLE,
	ONTOLOGY_USE_MACHINE_NAME,
	RELATION_TYPE_LINK,
	RELATION_TYPE_PARENT,
	SI_NO_NO,
	SI_NO_YES,
	YES_NO_SECTION,
} from './ontology_tipos.ts';
import { syncMainSectionFromDefinition } from './ontology_write.ts';
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
	return { ...relation, ...machineNameFlagColumn(node) };
}

/** `relation.ontology44` when the node must state its flag (explicitMachineName), else nothing. */
function machineNameFlagColumn(node: DdOntologyNode): Record<string, unknown[]> {
	if (!explicitMachineName(node).flag) return {};
	return {
		[ONTOLOGY_USE_MACHINE_NAME]: [yesNoLocator(node.use_machine_name, ONTOLOGY_USE_MACHINE_NAME)],
	};
}

/**
 * Which machine-name components the node must STATE (module header, note 1):
 * each one whose value differs from the parser's legacy derivation. A node
 * that does not carry the columns (a JSON definition from before them) states
 * nothing — its record is the legacy shape the rungs read.
 */
function explicitMachineName(node: DdOntologyNode): { flag: boolean; name: boolean } {
	if (typeof node.use_machine_name !== 'boolean') return { flag: false, name: false };
	const legacy = deriveLegacyMachineName(node);
	const name = node.machine_name ?? null;
	return {
		flag: node.use_machine_name !== legacy.use_machine_name,
		name: name !== null && name !== legacy.machine_name,
	};
}

/** `string` — the MANDATORY tld plus one term item per language. */
function stringColumnFromNode(node: DdOntologyNode, tld: string): Record<string, unknown[]> {
	// The tld is MANDATORY — a record without it parses into nothing at all.
	const string: Record<string, unknown[]> = { [ONTOLOGY_TLD]: [literalItem(1, DATA_NOLAN, tld)] };
	const items = Object.entries(node.term ?? {}).map(([lang, value]) => literalItem(1, lang, value));
	if (items.length > 0) string[ONTOLOGY_TERM] = items;
	if (explicitMachineName(node).name) {
		string[ONTOLOGY_MACHINE_NAME] = [literalItem(1, DATA_NOLAN, node.machine_name)];
	}
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
		// The ONE label chain (labels.ts), read in lg-eng — it ends in the
		// machine name, then the tipo.
		label: resolveLabel(node.term ?? null, 'lg-eng', node.machine_name ?? null) ?? node.tipo,
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
 * target section) is the registry-row law's (ontology_write.ts): a JSON node
 * is a DEFINITION, so this is `syncMainSectionFromDefinition` — it mints the
 * row when missing and otherwise replaces only the definition's keys (name,
 * typology), reusing the row whose `hierarchy6` already names this TLD.
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
		await syncMainSectionFromDefinition({
			tld,
			typology_id: typology === null ? null : Number(typology[1]),
			name_data: nameData.length > 0 ? nameData : null,
		});
	});
}
