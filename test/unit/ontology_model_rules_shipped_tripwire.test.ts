/**
 * THE SHIPPED ONTOLOGY BREAKS NO MODEL RULE (2026-11-11) — the pre-release half of the
 * model-rule invariant (ontology/model_rules.ts). Owner decision: `component_iri` is ALWAYS
 * non-translatable; a component_iri node that projects `is_translatable = true` is an
 * ONTOLOGY bug, fixed in the master ontology — and must never SHIP. The runtime half (every
 * install's health check) is ontology_model_rules_native.
 *
 * WHAT IT READS — THE VENDORED FILES, NOT THE SUITE DB. The suite database installs the
 * core TLDs (the seed), the default domain `oh` and the suite's own `test`; the release in
 * `install/import/ontology/<major.minor>/` ships ~200 packages. A gate over the suite DB
 * would judge a handful of them and call the release clean. So every `<tld>.copy.gz` of
 * the release directory the seed compiler and the installer use (seed_sources.ts
 * ONTOLOGY_RELEASE_DIR, listed by release_files.ts releaseDataFiles) is read row by row:
 * matrix_ontology record dumps in MATRIX_COPY_COLUMNS order.
 *
 * THE PARSER'S OWN RULES, NOT A SECOND COPY. A row is a node iff it states ontology7 (the
 * parser's mandatory tld); its tipo is `<ontology7><section_id>`; its model tipo is the
 * ontology6 locator composed by the parser's getTermIdFromLocator; its model NAME is the
 * parser's projectModel rule — modelNameOf(dd_ontology row of the model tipo), read on the
 * suite DB, whose core `dd` IS this release's (install_seed_manifest_tripwire keeps the seed
 * compiled from these files) — every model DEFINITION lives in `dd` (machine_name.ts
 * MODEL_DEFINITION_TLD; an ontology6 into ANY other tld types a node by a label class —
 * today only `crm` classes — which no component rule concerns, so it is counted, not judged); its translatability is parser.ts translatableFromItems — an
 * UNSET ontology8 reads TRUE. The verdict is model_rules.ts modelRuleViolations, the very
 * function inspectOntology runs. (The release carries no localontology0 overrides, and
 * ontology8 is canonical-only in the parser anyway.)
 *
 * NON-VACUITY: the walk is floored (files, node records, component_iri nodes actually
 * judged — a gate that saw no iri would pass forever), every model tipo must resolve to a
 * name (an unresolved model is a node the rule could not judge — loud, never skipped), and
 * a PLANTED control package (ontology_package_fixture.ts, scratch tld `zzri`, never
 * written anywhere) proves a translatable iri AND an ontology8-less iri are caught by the
 * same scan while a non-translatable one and a non-iri are not.
 */

import { describe, expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { splitCopyRow } from '../../src/core/db/copy_text.ts';
import { readDdOntologyRow } from '../../src/core/db/dd_ontology.ts';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { releaseDataFiles } from '../../src/core/install/release_files.ts';
import { ONTOLOGY_RELEASE_DIR } from '../../src/core/install/seed_sources.ts';
import { MODEL_DEFINITION_TLD, modelNameOf } from '../../src/core/ontology/machine_name.ts';
import {
	type ModelRuleViolation,
	modelRuleViolations,
} from '../../src/core/ontology/model_rules.ts';
import {
	ONTOLOGY_MODEL,
	ONTOLOGY_TLD,
	ONTOLOGY_TRANSLATABLE,
} from '../../src/core/ontology/ontology_tipos.ts';
import { getTermIdFromLocator, translatableFromItems } from '../../src/core/ontology/parser.ts';
import { getTldFromTipo } from '../../src/core/ontology/tld.ts';
import { buildOntologyPackage } from '../../src/core/test_data/ontology_package_fixture.ts';
import { modelTipoNamed } from '../helpers/machine_name_scratch.ts';

/**
 * Not ontology nodes: the private-list records (matrix_dd) the release ships beside the
 * packages. Named, so a NEW non-node file is a loud row-shape failure below, not a skip.
 */
const NOT_NODE_PACKAGES = new Set(['matrix_dd.copy.gz']);

/**
 * Floors, measured 2026-11-11 on the 7.0 release: 199 node packages, 16,184 node records,
 * 59 component_iri nodes (all non-translatable), 15 label-typed nodes. Set below the
 * measure so an ordinary master-ontology edit does not trip them; a release that lost most
 * of its packages or its iri nodes — or a scan that silently read nothing — does.
 */
const FILE_FLOOR = 150;
const NODE_FLOOR = 10_000;
const IRI_FLOOR = 40;

const COLUMN_INDEX = new Map(MATRIX_COPY_COLUMNS.map((column, index) => [column, index]));

interface ScanResult {
	files: number;
	nodes: number;
	/** Node count per model name (the floor reads component_iri's). */
	byModel: Map<string, number>;
	violations: ModelRuleViolation[];
	/** Model DEFINITION tipos (tld dd) no dd_ontology row names: nodes the rules could not judge. */
	unresolvedModels: Map<string, string[]>;
	/**
	 * Nodes whose ontology6 names a node in ANY tld other than the model-definition tld
	 * (`dd`) — today only `tch` classes typed by a `crm` class. Those are labels, not model definitions
	 * (machine_name.ts MODEL_DEFINITION_TLD), so no COMPONENT model rule can apply.
	 */
	labelTypedNodes: number;
	/** Rows that are not node records of their package (unexpected shape). */
	foreignRows: string[];
}

function emptyScan(): ScanResult {
	return {
		files: 0,
		nodes: 0,
		byModel: new Map(),
		violations: [],
		unresolvedModels: new Map(),
		labelTypedNodes: 0,
		foreignRows: [],
	};
}

/** One jsonb column of a COPY row, parsed (null = SQL NULL). */
function jsonColumn(fields: (string | null)[], column: string): Record<string, unknown[]> | null {
	const raw = fields[COLUMN_INDEX.get(column) as number] ?? null;
	return raw === null ? null : (JSON.parse(raw) as Record<string, unknown[]>);
}

/** A component's items as the parser's getComponentItems answers: null when absent or empty. */
function items(column: Record<string, unknown[]> | null, tipo: string): unknown[] | null {
	const value = column?.[tipo];
	return Array.isArray(value) && value.length > 0 ? value : null;
}

/** Model tipo → model name, memoized per scan (the parser's projectModel rule). */
async function modelName(
	modelTipo: string,
	cache: Map<string, string | null>,
): Promise<string | null> {
	if (!cache.has(modelTipo)) {
		cache.set(modelTipo, modelNameOf(await readDdOntologyRow(modelTipo)).model);
	}
	return cache.get(modelTipo) ?? null;
}

/** Judge ONE COPY row of package `file` into `scan`. */
async function judgeRow(
	file: string,
	line: string,
	scan: ScanResult,
	models: Map<string, string | null>,
): Promise<void> {
	const fields = splitCopyRow(line);
	const sectionTipo = fields[COLUMN_INDEX.get('section_tipo') as number] ?? '';
	const sectionId = fields[COLUMN_INDEX.get('section_id') as number] ?? '';
	const source = `${sectionTipo}/${sectionId}`;
	const tldItem = items(jsonColumn(fields, 'string'), ONTOLOGY_TLD)?.[0] as
		| { value?: unknown }
		| undefined;
	const tld = String(tldItem?.value ?? '');
	if (tld === '' || !sectionTipo.endsWith('0')) {
		scan.foreignRows.push(`${file}: ${source}`);
		return;
	}
	scan.nodes++;
	const tipo = `${tld}${sectionId}`;
	const relation = jsonColumn(fields, 'relation');
	const modelLocator = items(relation, ONTOLOGY_MODEL)?.[0];
	if (modelLocator === undefined) return; // no model: no model rule can apply
	const modelTipo = await getTermIdFromLocator(
		modelLocator as Parameters<typeof getTermIdFromLocator>[0],
	);
	if (modelTipo !== null && getTldFromTipo(modelTipo) !== MODEL_DEFINITION_TLD) {
		scan.labelTypedNodes++;
		return;
	}
	const model = modelTipo === null ? null : await modelName(modelTipo, models);
	if (model === null) {
		const key = modelTipo ?? JSON.stringify(modelLocator);
		scan.unresolvedModels.set(key, [...(scan.unresolvedModels.get(key) ?? []), tipo]);
		return;
	}
	scan.byModel.set(model, (scan.byModel.get(model) ?? 0) + 1);
	const translatableItems = items(relation, ONTOLOGY_TRANSLATABLE);
	scan.violations.push(
		...modelRuleViolations({
			source,
			tipo,
			model,
			is_translatable: translatableFromItems(translatableItems),
			translatableStated: translatableItems !== null,
		}),
	);
}

/** Scan packages given as `[file name, gzip bytes]`. */
async function scanPackages(packages: Iterable<[string, Uint8Array]>): Promise<ScanResult> {
	const scan = emptyScan();
	const models = new Map<string, string | null>();
	for (const [file, bytes] of packages) {
		if (NOT_NODE_PACKAGES.has(file)) continue;
		scan.files++;
		const text = gunzipSync(bytes).toString('utf8');
		for (const line of text.split('\n')) {
			if (line !== '') await judgeRow(file, line, scan, models);
		}
	}
	return scan;
}

/** The release's own packages, read from disk. */
async function* releasePackages(): AsyncGenerator<[string, Uint8Array]> {
	for (const file of releaseDataFiles(ONTOLOGY_RELEASE_DIR)) {
		yield [file, new Uint8Array(await Bun.file(`${ONTOLOGY_RELEASE_DIR}/${file}`).arrayBuffer())];
	}
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of source) out.push(item);
	return out;
}

describe('the shipped ontology release breaks no model rule', () => {
	let release: ScanResult = emptyScan();

	test('scan the vendored release (floored: files, nodes, component_iri nodes)', async () => {
		release = await scanPackages(await collect(releasePackages()));
		expect(release.files).toBeGreaterThanOrEqual(FILE_FLOOR);
		expect(release.nodes).toBeGreaterThanOrEqual(NODE_FLOOR);
		expect(release.byModel.get('component_iri') ?? 0).toBeGreaterThanOrEqual(IRI_FLOOR);
		expect(release.foreignRows).toEqual([]);
	}, 120_000);

	test('every model tipo the release names resolves (no node escapes the judgement)', () => {
		expect(Object.fromEntries(release.unresolvedModels)).toEqual({});
	});

	test('NO shipped component_iri projects translatable (fix the master ontology, never the engine)', () => {
		expect(release.violations.map((item) => item.message)).toEqual([]);
	});

	test('planted control: a translatable AND an ontology8-less iri are caught, the healthy ones are not', async () => {
		const iri = await modelTipoNamed('component_iri');
		const inputText = await modelTipoNamed('component_input_text');
		const planted = buildOntologyPackage([
			{
				tld: 'zzri',
				name: 'zzri planted model-rule control',
				typologyId: 15,
				nodes: [
					{ id: 1, parent: 'zzri0', model: iri, term: 'iri no', translatable: false },
					{ id: 2, parent: 'zzri0', model: iri, term: 'iri yes', translatable: true },
					{ id: 3, parent: 'zzri0', model: iri, term: 'iri unset' },
					{ id: 4, parent: 'zzri0', model: inputText, term: 'text unset' },
				],
			},
		]);
		const scan = await scanPackages(
			[...planted].filter(([file]) => file.endsWith('.copy.gz')) as [string, Uint8Array][],
		);
		expect(scan.nodes).toBe(4);
		expect(scan.violations.map((item) => [item.tipo, item.rule, item.translatableStated])).toEqual([
			['zzri2', 'translatable_forbidden', true],
			['zzri3', 'translatable_forbidden', false],
		]);
	});
});
