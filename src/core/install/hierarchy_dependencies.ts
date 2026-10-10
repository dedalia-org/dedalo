/**
 * THE DECLARED THESAURI OF AN INSTALLED DATABASE — what the wizard's
 * install_hierarchies step must import whatever the operator ticked.
 *
 * WHY HERE, AND FROM THE DATABASE. The CLI decides its whole thesaurus set in
 * the plan (install_plan.ts — the vendored core declaration + the catalog
 * entries of the install order). The wizard cannot: install_hierarchies runs in
 * the process restarted after persist_config, after install_ontologies, with no
 * plan in hand — and the client's posted list is not trusted to carry the
 * mandatory ones. By then the truth is IN the database: every registry row the
 * seed restore and the ontology import wrote carries its declaration
 * (misc.hierarchy60, written by syncMainSectionFromDefinition from the very
 * entries the plan read). So the step reads the declarations of the configured
 * ACTIVE_ONTOLOGY_TLDS (core + the installed domains) and collects them with
 * THE collector the plan uses (ontology_choice.ts collectHierarchyDependencies).
 *
 * READ-ONLY. A malformed stored declaration is dropped item by item through THE
 * normalizer; its warnings are returned, never thrown.
 * Gate: test/unit/install_hierarchy_dependencies_native.test.ts.
 */

import { config } from '../../config/config.ts';
import { storedDeclaredDependencies } from '../ontology/dependency_report.ts';
import {
	collectHierarchyDependencies,
	type DependencyDeclarer,
	type HierarchyDependency,
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
