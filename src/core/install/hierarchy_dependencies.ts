/**
 * THE DECLARED THESAURI OF AN INSTALLED DATABASE — what the wizard's
 * install_hierarchies step checks the operator's ticked list against.
 *
 * WHY HERE, AND FROM THE DATABASE. The CLI decides its whole thesaurus set in
 * the plan (install_plan.ts — the vendored core declaration + the catalog
 * entries of the install order). The wizard cannot: install_hierarchies runs in
 * the process restarted after persist_config, after install_ontologies, with no
 * plan in hand. The posted list IS the operator's answer on every thesaurus
 * (owner decision 2026-10-10: a thesaurus never blocks an install — a mandatory
 * one is strongly recommended, pre-ticked, declinable), but a mandatory one it
 * leaves out must be WARNED about by name. By then the truth is IN the
 * database: every registry row the
 * seed restore and the ontology import wrote carries its declaration
 * (misc.hierarchy60, written by syncMainSectionFromDefinition from the very
 * entries the plan read). So the step reads the declarations of the configured
 * ACTIVE_ONTOLOGY_TLDS (core + the installed domains) and collects them with
 * THE collector the plan uses (ontology_choice.ts collectHierarchyDependencies).
 *
 * READ-ONLY. A malformed stored declaration is dropped item by item through THE
 * normalizer; its warnings are returned, never thrown.
 *
 * THE THESAURI'S OWN DECLARATIONS (2026-10-10 review): a chosen thesaurus's
 * hierarchy.json entry declares dependencies too (its registry row's
 * hierarchy60), and the same law applies — {@link withThesaurusDependencies}
 * checks a selection against them (nothing added: a mandatory thesaurus left
 * out is a warning; a declared MANDATORY ONTOLOGY that is not installed is
 * refused — the ontology law); hierarchy_import.ts installHierarchies runs it
 * before anything is imported, so every front end gets it through the one door.
 * Gate: test/unit/install_hierarchy_dependencies_native.test.ts.
 */

import { config } from '../../config/config.ts';
import { storedDeclaredDependencies } from '../ontology/dependency_report.ts';
import { offeredHierarchies } from './hierarchy_meta.ts';
import {
	closeThesaurusChoice,
	collectHierarchyDependencies,
	type DependencyDeclarer,
	type HierarchyDependency,
	type ThesaurusChoiceClosure,
} from './ontology_choice.ts';

/**
 * The thesauri the given TLDs' registry rows declare (`main: 'hierarchy1'`,
 * every one — mandatory and optional; core hierarchies excluded). A TLD with
 * no registry row declares nothing. Defaults to the configured active set.
 */
export async function installedHierarchyDependencies(
	tlds: readonly string[] = config.ontologyIo.activeOntologyTlds,
): Promise<{ dependencies: HierarchyDependency[]; warnings: string[] }> {
	const warnings: string[] = [];
	const declarers: DependencyDeclarer[] = await Promise.all(
		tlds.map(async (tld) => ({
			tld,
			dependencies: await storedDeclaredDependencies(tld, warnings),
		})),
	);
	return { dependencies: collectHierarchyDependencies(declarers).dependencies, warnings };
}

/**
 * A thesaurus selection checked against the chosen entries' OWN declared
 * dependencies (hierarchy.json — ontology_choice.ts closeThesaurusChoice, the
 * rule the CLI plan applies). The selection is the caller's ANSWER on every
 * thesaurus (the front ends pre-tick the declared ones): nothing is added — a
 * MANDATORY thesaurus it leaves out is a WARNING (strongly recommended,
 * installable later), an optional one is silent; a declared ONTOLOGY must be
 * one of the configured `installedOntologies` (mandatory → error). `dir` is the
 * gate seam (a scratch manifest). The manifest is read only when there is a
 * choice to close.
 */
export function withThesaurusDependencies(
	chosen: readonly string[],
	options: { installedOntologies?: readonly string[]; dir?: string } = {},
): ThesaurusChoiceClosure {
	if (chosen.length === 0) {
		return { hierarchies: [], dependencies: [], notes: [], warnings: [], errors: [] };
	}
	const declarers: DependencyDeclarer[] = offeredHierarchies(options.dir).map((meta) => ({
		tld: meta.tld,
		dependencies: meta.dependencies ?? null,
	}));
	return closeThesaurusChoice(
		chosen,
		declarers,
		new Set(options.installedOntologies ?? config.ontologyIo.activeOntologyTlds),
		{ accept: () => false },
	);
}
