/**
 * The VENDORED ontology release read straight off disk — read-only, no
 * database: `install/import/ontology/<release>/<tld>.copy.gz` are the ontology
 * section RECORDS (`<tld>0`, MATRIX_COPY_COLUMNS COPY text) an installation
 * imports. A gate that must hold for what the release SHIPS (not for whatever a
 * database happens to hold — the suite DB installs only a few of its TLDs)
 * reads it here.
 *
 * Only the record-level facts a gate needs are exposed, by the ontology
 * components that carry them: relations (ontology10), model (ontology6),
 * parent (ontology15), properties (ontology18), machine name (ontology43).
 * No override (localontology0) exists in a release, so no merge is needed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { releaseDataFiles } from '../../src/core/install/release_files.ts';
import { ONTOLOGY_RELEASE_DIR } from '../../src/core/install/seed_sources.ts';

export interface ReleaseLocator {
	section_tipo: string;
	section_id: number | string;
}

export interface ReleaseRecord {
	/** `<tld><section_id>` — the node's tipo. */
	tipo: string;
	file: string;
	relations: string[];
	modelLocator: ReleaseLocator | null;
	parent: string | null;
	properties: Record<string, unknown> | null;
	machineName: string | null;
}

/** PostgreSQL COPY text-format field unescape (`\N` handled by the caller). */
function unescapeCopyField(field: string): string {
	return field.replace(/\\(.)/g, (_match, char: string) => {
		switch (char) {
			case 't':
				return '\t';
			case 'n':
				return '\n';
			case 'r':
				return '\r';
			case 'b':
				return '\b';
			case 'f':
				return '\f';
			case 'v':
				return '\v';
			default:
				return char;
		}
	});
}

/** The tipo a locator into an ontology section (`<tld>0`) names. */
export function locatorTipo(locator: ReleaseLocator): string | null {
	if (!locator.section_tipo.endsWith('0')) return null;
	return `${locator.section_tipo.slice(0, -1)}${locator.section_id}`;
}

function componentItems(columns: Record<string, unknown>, key: string): unknown[] {
	for (const column of Object.values(columns)) {
		if (column === null || typeof column !== 'object') continue;
		const items = (column as Record<string, unknown>)[key];
		if (Array.isArray(items)) return items;
	}
	return [];
}

function parseRecord(line: string, file: string): ReleaseRecord | null {
	const fields = line.split('\t');
	if (fields.length !== MATRIX_COPY_COLUMNS.length) {
		throw new Error(
			`release ${file}: a COPY row has ${fields.length} fields, expected ${MATRIX_COPY_COLUMNS.length}`,
		);
	}
	const sectionId = fields[0] as string;
	const sectionTipo = fields[1] as string;
	if (!sectionTipo.endsWith('0')) return null;
	const columns: Record<string, unknown> = {};
	MATRIX_COPY_COLUMNS.forEach((name, index) => {
		const raw = fields[index] as string;
		if (index < 2 || raw === '\\N') return;
		columns[name] = JSON.parse(unescapeCopyField(raw));
	});
	const locators = (key: string) =>
		componentItems(columns, key).filter(
			(item): item is ReleaseLocator =>
				item !== null &&
				typeof item === 'object' &&
				typeof (item as ReleaseLocator).section_tipo === 'string' &&
				(item as ReleaseLocator).section_id !== undefined,
		);
	const firstValue = (key: string): unknown =>
		(componentItems(columns, key)[0] as { value?: unknown } | undefined)?.value;
	const parentLocator = locators('ontology15')[0];
	const properties = firstValue('ontology18');
	const machineName = firstValue('ontology43');
	return {
		tipo: `${sectionTipo.slice(0, -1)}${sectionId}`,
		file,
		relations: locators('ontology10')
			.map(locatorTipo)
			.filter((tipo): tipo is string => tipo !== null),
		modelLocator: locators('ontology6')[0] ?? null,
		parent: parentLocator ? locatorTipo(parentLocator) : null,
		properties:
			properties !== null && typeof properties === 'object' && !Array.isArray(properties)
				? (properties as Record<string, unknown>)
				: null,
		machineName: typeof machineName === 'string' ? machineName : null,
	};
}

/** Every ontology record of the vendored release, keyed by tipo (read once per process). */
let cache: Map<string, ReleaseRecord> | null = null;
export function readReleaseOntology(
	dir: string = ONTOLOGY_RELEASE_DIR,
): Map<string, ReleaseRecord> {
	if (cache !== null && dir === ONTOLOGY_RELEASE_DIR) return cache;
	const records = new Map<string, ReleaseRecord>();
	for (const file of releaseDataFiles(dir)) {
		const text = gunzipSync(readFileSync(join(dir, file))).toString('utf8');
		for (const line of text.split('\n')) {
			if (line === '' || line === '\\.') continue;
			const record = parseRecord(line, file);
			if (record !== null) records.set(record.tipo, record);
		}
	}
	if (dir === ONTOLOGY_RELEASE_DIR) cache = records;
	return records;
}

/** The release records whose model is the model node with machine name `model`. */
export function releaseNodesOfModel(
	records: Map<string, ReleaseRecord>,
	model: string,
): ReleaseRecord[] {
	const modelNodes = [...records.values()].filter((record) => record.machineName === model);
	if (modelNodes.length !== 1) {
		throw new Error(
			`release: ${modelNodes.length} model nodes named '${model}' (expected exactly 1)`,
		);
	}
	const modelTipo = (modelNodes[0] as ReleaseRecord).tipo;
	return [...records.values()].filter(
		(record) => record.modelLocator !== null && locatorTipo(record.modelLocator) === modelTipo,
	);
}
