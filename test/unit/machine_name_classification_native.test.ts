/**
 * G5 — THE MACHINE-NAME CLASSIFICATION HOLDS ON THE INSTALLED ONTOLOGY
 * (WC-2026-11-04-ontology-machine-names, plan §5 / §7 / §10 G5). Until the model
 * typology (C3) supplies the default of `use_machine_name`, this gate stands in
 * for it, over every non-scratch row of the suite database's dd_ontology — the
 * vendored release, the seed scaffold and the repo-owned test fixtures, built
 * through the installer's doors (`bun run test:db:setup`):
 *
 *  1. FLAG ⟺ CLASS: `use_machine_name` is true exactly on the nodes
 *     `isNameClassNode` (src/core/ontology/machine_name.ts) names — a model
 *     definition, or an instance of a NAME_MODELS model — and no row is left
 *     un-derived (NULL). Today the flag is derived from the class (ontology44
 *     is not in the release), so this measures the STORED columns of every
 *     door (parser, rows-only upsert, seed); once ontology44 ships it measures
 *     the stated flags — the post-upgrade verification of plan §6b.
 *  2. THE ROW PREDICATE IS THE TREE: `isModelDefinition` (is_model ∧ tld dd ∧
 *     no model_tipo ∧ ≠ dd2) selects exactly the strict descendants of dd2 —
 *     the predicate stands in for a parent walk, so the two may never drift.
 *  3. THE CLOSED LIST IS REAL: every NAME_MODELS entry names an installed model
 *     definition (a typo would silently classify nothing).
 *  4. THE DIFFUSION VOCABULARY IS CLASSIFIED: every model definition under
 *     dd1226 (the diffusion models) is in NAME_MODELS or in DIFFUSION_LABEL_MODELS
 *     below — a new diffusion model is a deliberate decision, never a default.
 *  5. EVERY ontology6 TARGET IS A MODEL DEFINITION (or a declared crm exception):
 *     `model` = the target's machine name, so a target outside dd2 would type its
 *     instances by a label.
 *  6. NO NAME NODE IS NAMELESS AND NO MODEL IS UNRESOLVED: flag yes ⇒ machine_name
 *     set; model_tipo set ⇒ model set (plan §6b's other two verifications).
 *
 * Scratch `zz*` tlds are excluded (another gate's live situation is not the
 * installed ontology). Read-only; needs the suite DB.
 */

import { describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import {
	isModelDefinition,
	isNameClassNode,
	MODEL_DEFINITION_ROOT,
	NAME_MODELS,
} from '../../src/core/ontology/machine_name.ts';
import { DIFFUSION_MODEL_ROOT } from '../../src/core/ontology/ontology_tipos.ts';

/**
 * The diffusion models (under dd1226) whose instances are LABELS — the mixed
 * diffusion family (plan §5, verified 2026-11-04: nothing matches an element,
 * group, section or component by its term; they are found by model, by
 * `properties.diffusion.type` and by `service_name`) and the xml/rdf document
 * containers. Each entry is a decision; moving one to NAME_MODELS reclassifies
 * every instance (a WC entry + the PHP upgrade copy).
 */
const DIFFUSION_LABEL_MODELS: ReadonlySet<string> = new Set([
	'body',
	'diffusion_component',
	'diffusion_element',
	'diffusion_element_alias',
	'diffusion_group',
	'diffusion_head',
	'diffusion_section',
	'diffusion_section_stats',
	'head',
	'rdf',
	'structure_data',
	'xml',
]);

/**
 * ontology6 targets that are NOT dd2 model definitions, by tipo, with the reason.
 * The crm "models" (model NULL, plan D13) are out of scope and are not installed
 * on the suite; none is declared, so any such target here is red.
 */
const DECLARED_NON_DEFINITION_TARGETS: ReadonlyMap<string, string> = new Map();

interface Row {
	tipo: string;
	parent: string | null;
	tld: string;
	is_model: boolean;
	model_tipo: string | null;
	model: string | null;
	machine_name: string | null;
	use_machine_name: boolean | null;
}

const rows = (await sql.unsafe(
	`SELECT tipo, parent, tld, is_model, model_tipo, model, machine_name, use_machine_name
	   FROM dd_ontology WHERE tld !~ '^zz' ORDER BY tipo`,
)) as Row[];
const byTipo = new Map(rows.map((row) => [row.tipo, row]));

/** Strict descendants of `root` (a parent walk over the loaded rows). */
function strictDescendants(root: string): Set<string> {
	const children = new Map<string, string[]>();
	for (const row of rows) {
		if (row.parent === null) continue;
		const list = children.get(row.parent) ?? [];
		list.push(row.tipo);
		children.set(row.parent, list);
	}
	const out = new Set<string>();
	const queue = [...(children.get(root) ?? [])];
	for (let tipo = queue.shift(); tipo !== undefined; tipo = queue.shift()) {
		if (out.has(tipo)) continue;
		out.add(tipo);
		queue.push(...(children.get(tipo) ?? []));
	}
	return out;
}

const modelDefinitions = rows.filter((row) => isModelDefinition(row));
const definitionNames = new Set(modelDefinitions.map((row) => row.machine_name));

describe('machine-name classification of the installed ontology (G5)', () => {
	test('floor: the suite carries the release (model definitions and name nodes exist)', () => {
		expect(modelDefinitions.length).toBeGreaterThan(100);
		expect(rows.filter((row) => row.use_machine_name === true).length).toBeGreaterThan(
			modelDefinitions.length,
		);
	});

	test('use_machine_name is true exactly on the name-class nodes; none is un-derived', () => {
		const underived = rows.filter((row) => row.use_machine_name === null).map((row) => row.tipo);
		expect(underived).toEqual([]);
		const disagreeing = rows
			.filter((row) => row.use_machine_name !== isNameClassNode(row))
			.map((row) => `${row.tipo}(${row.model}) flag=${row.use_machine_name}`);
		expect(disagreeing).toEqual([]);
	});

	test('the model-definition predicate selects exactly the strict dd2 descendants', () => {
		const tree = [...strictDescendants(MODEL_DEFINITION_ROOT)].sort();
		const predicate = modelDefinitions.map((row) => row.tipo).sort();
		expect(predicate).toEqual(tree);
		// dd2 itself is the label "Model names", not a model
		expect(byTipo.get(MODEL_DEFINITION_ROOT)?.use_machine_name).toBe(false);
	});

	test('every NAME_MODELS entry names an installed model definition', () => {
		const unknown = [...NAME_MODELS].filter((name) => !definitionNames.has(name));
		expect(unknown).toEqual([]);
	});

	test('every diffusion model (under dd1226) is classified: a name model or a declared label model', () => {
		const diffusionModels = [...strictDescendants(DIFFUSION_MODEL_ROOT)]
			.map((tipo) => byTipo.get(tipo))
			.filter((row): row is Row => row !== undefined && isModelDefinition(row))
			.map((row) => row.machine_name as string);
		expect(diffusionModels.length).toBeGreaterThan(20);
		const unclassified = diffusionModels.filter(
			(name) => !NAME_MODELS.has(name) && !DIFFUSION_LABEL_MODELS.has(name),
		);
		expect(unclassified).toEqual([]);
		// both lists stay live and disjoint
		const stale = [...DIFFUSION_LABEL_MODELS].filter((name) => !diffusionModels.includes(name));
		expect(stale).toEqual([]);
		expect([...DIFFUSION_LABEL_MODELS].filter((name) => NAME_MODELS.has(name))).toEqual([]);
	});

	test('every ontology6 target is a model definition (or a declared exception)', () => {
		const targets = new Set(rows.map((row) => row.model_tipo).filter((tipo) => tipo !== null));
		const outside = [...targets].filter((tipo) => {
			const target = byTipo.get(tipo as string);
			if (target !== undefined && isModelDefinition(target)) return false;
			return !DECLARED_NON_DEFINITION_TARGETS.has(tipo as string);
		});
		expect(outside).toEqual([]);
		for (const tipo of DECLARED_NON_DEFINITION_TARGETS.keys()) expect(targets.has(tipo)).toBe(true);
	});

	test('no name node is nameless; no model_tipo leaves model unresolved', () => {
		const nameless = rows
			.filter((row) => row.use_machine_name === true && (row.machine_name ?? '') === '')
			.map((row) => row.tipo);
		expect(nameless).toEqual([]);
		const unresolved = rows
			.filter((row) => row.model_tipo !== null && (row.model ?? '') === '')
			.map((row) => row.tipo);
		expect(unresolved).toEqual([]);
		// and a model is ALWAYS its target's machine name
		const mismatched = rows
			.filter((row) => row.model_tipo !== null)
			.filter((row) => byTipo.get(row.model_tipo as string)?.machine_name !== row.model)
			.map((row) => `${row.tipo}: ${row.model}`);
		expect(mismatched).toEqual([]);
	});
});
