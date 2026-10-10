/**
 * ONTOLOGY PACKAGE FIXTURE — the bytes of an ontology source in the server
 * export layout (`ontology.json` + `<tld>.copy.gz` [+ `matrix_dd.copy.gz`]),
 * built from a declared node list, for the gates that drive the manifest
 * client, the reference classifier and the installer's ontology door.
 *
 * DB-FREE AND IT WRITES NOTHING: it RETURNS the files as bytes
 * (`Map<file name, bytes>`); the gate decides where they go (a mkdtemp dir, a
 * loopback stand-in's routes, a tar archive). That is why it needs no
 * `assertTestDatabase` and no marker-tripwire row: nothing here can reach a
 * database or a media root.
 *
 * SCRATCH TLDs ONLY: every TLD must be `zz…` (refused otherwise), so a package
 * built here can never aim an import at a real ontology. Model tipos are the
 * fixture's own (or core ones) and must fit `dd_ontology.model_tipo`
 * (varchar(8)) — refused when longer.
 *
 * Each node becomes ONE matrix_ontology record line in MATRIX_COPY_COLUMNS
 * order, the shape the export writes and the import/parser read:
 *   relation.ontology15 = parent, ontology6 = model, ontology10 = relations,
 *   ontology30 = is_model (yes, when declared), string.ontology5 = term
 *   (lg-spa), ontology7 = TLD (lg-nolan); every other column NULL. Values are
 *   encoded through the one COPY codec (src/core/db/copy_text.ts).
 */

import { gzipSync } from 'node:zlib';
import { encodeCopyField } from '../db/copy_text.ts';
import { MATRIX_COPY_COLUMNS } from '../db/matrix_write.ts';
import { DedaloError } from '../errors/index.ts';
import {
	ONTOLOGY_CONNECTED_TO,
	ONTOLOGY_IS_MODEL,
	ONTOLOGY_MODEL,
	ONTOLOGY_PARENT,
	ONTOLOGY_TERM,
	ONTOLOGY_TLD,
	RELATION_TYPE_LINK,
	RELATION_TYPE_PARENT,
	SI_NO_YES,
	YES_NO_SECTION,
} from '../ontology/ontology_tipos.ts';
import { getSectionIdFromTipo, getTldFromTipo } from '../ontology/tld.ts';
import { DEDALO_VERSION } from '../update/version.ts';

/** One node of a fixture ontology. */
export interface FixtureOntologyNode {
	/** The section_id: the node's tipo is `<tld><id>`. */
	id: number;
	/** The parent tipo (`<tld>0` for a top node). */
	parent: string;
	/** The model tipo (<= 8 chars). */
	model: string;
	term: string;
	/** Related tipos (ontology10), in order. */
	relations?: string[];
	/** Declares the node a MODEL (ontology30 = yes). */
	isModel?: boolean;
}

/** One fixture ontology (one TLD). */
export interface FixtureOntologyTld {
	tld: string;
	name: string;
	typologyId: number;
	typologyName?: string | null;
	/**
	 * Declared dependencies, written VERBATIM into the active_ontologies entry
	 * (`{tld, main, mandatory}` objects — or a deliberately malformed value, so a
	 * gate can plant one); OMITTED = not declared (the older-server case).
	 */
	dependencies?: unknown;
	nodes: FixtureOntologyNode[];
}

const MODEL_TIPO_MAX = 8;

function refuse(message: string): never {
	throw new DedaloError('internal.invariant', { message: `ontology package fixture: ${message}` });
}

function assertScratch(definition: FixtureOntologyTld): void {
	if (!/^zz[a-z]+$/.test(definition.tld)) refuse(`'${definition.tld}' is not a zz scratch TLD`);
	for (const node of definition.nodes) {
		if (node.model.length > MODEL_TIPO_MAX)
			refuse(`model tipo '${node.model}' exceeds ${MODEL_TIPO_MAX} chars`);
	}
}

/** A stored locator to `tipo` (`<tld>0` / id), as the export writes one. */
function locatorTo(tipo: string, from: string, type: string, id: number): Record<string, unknown> {
	const tld = getTldFromTipo(tipo) ?? refuse(`'${tipo}' is not a tipo`);
	return {
		id,
		type,
		section_id: getSectionIdFromTipo(tipo) ?? '0',
		section_tipo: `${tld}0`,
		from_component_tipo: from,
	};
}

/** The relation column of one node. */
function relationColumn(node: FixtureOntologyNode): Record<string, unknown[]> {
	const column: Record<string, unknown[]> = {
		[ONTOLOGY_PARENT]: [locatorTo(node.parent, ONTOLOGY_PARENT, RELATION_TYPE_PARENT, 1)],
		[ONTOLOGY_MODEL]: [locatorTo(node.model, ONTOLOGY_MODEL, RELATION_TYPE_LINK, 1)],
	};
	const relations = node.relations ?? [];
	if (relations.length > 0) {
		column[ONTOLOGY_CONNECTED_TO] = relations.map((tipo, index) =>
			locatorTo(tipo, ONTOLOGY_CONNECTED_TO, RELATION_TYPE_LINK, index + 1),
		);
	}
	if (node.isModel === true) column[ONTOLOGY_IS_MODEL] = [isModelLocator()];
	return column;
}

function isModelLocator(): Record<string, unknown> {
	return {
		id: 1,
		type: RELATION_TYPE_LINK,
		section_id: SI_NO_YES,
		section_tipo: YES_NO_SECTION,
		from_component_tipo: ONTOLOGY_IS_MODEL,
	};
}

/** One matrix_ontology record line (MATRIX_COPY_COLUMNS order) for `node` of `tld`. */
export function ontologyCopyRow(tld: string, node: FixtureOntologyNode): string {
	const sectionTipo = `${tld}0`;
	const values: Record<string, string | number | null> = {
		section_id: node.id,
		section_tipo: sectionTipo,
		data: JSON.stringify({ label: tld, section_id: node.id, section_tipo: sectionTipo }),
		relation: JSON.stringify(relationColumn(node)),
		string: JSON.stringify({
			[ONTOLOGY_TERM]: [{ id: 1, lang: 'lg-spa', value: node.term }],
			[ONTOLOGY_TLD]: [{ id: 1, lang: 'lg-nolan', value: tld }],
		}),
	};
	return MATRIX_COPY_COLUMNS.map((column) => encodeCopyField(copyText(values[column]))).join('\t');
}

/** A column value as COPY text (the int `section_id` column included); absent = NULL. */
function copyText(value: string | number | null | undefined): string | null {
	return value === null || value === undefined ? null : `${value}`;
}

/** The ontology.json active_ontologies entry of one TLD (`dependencies` only when declared). */
function infoEntry(definition: FixtureOntologyTld): Record<string, unknown> {
	return {
		tld: definition.tld,
		name: definition.name,
		name_data: [{ id: 1, lang: 'lg-spa', value: definition.name }],
		typology_id: definition.typologyId,
		typology_name: definition.typologyName ?? null,
		...(definition.dependencies === undefined ? {} : { dependencies: definition.dependencies }),
	};
}

function gzLines(lines: readonly string[]): Uint8Array {
	return gzipSync(Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8'));
}

/**
 * The files of an ontology source for `tlds`: `ontology.json` (version =
 * `options.version` ?? this engine's), one `<tld>.copy.gz` per TLD, and
 * `matrix_dd.copy.gz` when `options.matrixDdLines` is given.
 */
export function buildOntologyPackage(
	tlds: readonly FixtureOntologyTld[],
	options: { version?: string; matrixDdLines?: string[] } = {},
): Map<string, Uint8Array> {
	for (const definition of tlds) assertScratch(definition);
	const info = {
		version: options.version ?? DEDALO_VERSION,
		date: '2026-01-01T00:00:00+00:00',
		entity: 'zz ontology package fixture',
		active_ontologies: tlds.map(infoEntry),
	};
	const files = new Map<string, Uint8Array>([
		['ontology.json', Buffer.from(JSON.stringify(info, null, 4), 'utf8')],
	]);
	for (const definition of tlds) {
		const lines = definition.nodes.map((node) => ontologyCopyRow(definition.tld, node));
		files.set(`${definition.tld}.copy.gz`, gzLines(lines));
	}
	if (options.matrixDdLines !== undefined)
		files.set('matrix_dd.copy.gz', gzLines(options.matrixDdLines));
	return files;
}
