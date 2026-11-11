/**
 * MODEL RULES — what a component MODEL fixes about every ontology node of that model,
 * checked against what the node's source record declares (2026-11-11).
 *
 * The ontology is authored in the MASTER ontology and reaches an installation through
 * an update; a node can therefore declare something its model forbids (owner decision
 * 2026-11-11: `component_iri` is ALWAYS non-translatable — an IRI has no language, the
 * per-language IRIs are language VERSIONS with an lg-nolan base value). Such a node is an
 * ONTOLOGY BUG. The engine never works around it (no override of the flag at parse or
 * read time — that would hide the bug from the place that must fix it); it REPORTS it,
 * by source record, with a sentence telling the operator where the fix belongs.
 *
 * DECLARATIVE: a rule reads a DESCRIPTOR FACET (components/types.ts — today
 * `ontologyTranslatable`), never a hard-coded model name. A new rule is one entry in
 * MODEL_RULES plus its facet; a model joins a rule by declaring the facet in its
 * descriptor. The facet is read through the resolver's registered component-model lookup
 * (getComponentModelNodeRules — the S2-20 inversion seam), so this module never imports
 * the component registry (import_scc_tripwire).
 *
 * Consumers (one rule set, two doors):
 *  - ontology_state.ts inspectOntology → `OntologyState.modelRuleViolations`, a WARNING
 *    channel like `machineNameDefects` (never drift: the projection matches its source),
 *    shown by tool_ontology_parser's status panel and named in every rebuild message —
 *    the per-tld message the ontology update reports;
 *  - test/unit/ontology_model_rules_shipped_tripwire.test.ts → the release gate over the
 *    vendored install/import/ontology/<major.minor>/ packages, BEFORE they ship.
 */

import { ONTOLOGY_TRANSLATABLE } from './ontology_tipos.ts';
import { getComponentModelNodeRules } from './resolver.ts';

/** The rule a node breaks. One kind per facet-backed rule. */
export type ModelRuleKind = 'translatable_forbidden';

/** What a rule judges: one parsed node, as its source declares it. */
export interface ModelRuleSubject {
	/** `<section_tipo>/<section_id>` — the source record the operator must fix. */
	source: string;
	tipo: string;
	/** The node's model name (dd_ontology.model); null = unresolved, no rule applies. */
	model: string | null;
	/** The node's is_translatable AS PARSED (an unset ontology8 already reads true). */
	is_translatable: boolean;
	/** Whether the source states ontology8 at all (parser.ts translatableStated). */
	translatableStated: boolean;
}

/** One finding: a node breaking a rule its model fixes. */
export interface ModelRuleViolation {
	source: string;
	tipo: string;
	model: string;
	rule: ModelRuleKind;
	/** False = ontology8 is unset and the default-true rule made the node translatable. */
	translatableStated: boolean;
	/** The operator-facing sentence: what, where, and that the fix is the master ontology's. */
	message: string;
}

interface ModelRule {
	kind: ModelRuleKind;
	/** Does this model state the rule (read off its descriptor facet)? */
	appliesTo: (model: string) => boolean;
	/** Does this node break it? */
	violatedBy: (subject: ModelRuleSubject) => boolean;
	message: (subject: ModelRuleSubject & { model: string }) => string;
}

/** How the node came to be translatable — stated, or the parser's default for an unset ontology8. */
function translatableOrigin(subject: ModelRuleSubject): string {
	return subject.translatableStated
		? `${ONTOLOGY_TRANSLATABLE} = yes`
		: `${ONTOLOGY_TRANSLATABLE} unset — an unset ${ONTOLOGY_TRANSLATABLE} reads as translatable`;
}

const TRANSLATABLE_FORBIDDEN: ModelRule = {
	kind: 'translatable_forbidden',
	appliesTo: (model) => getComponentModelNodeRules(model)?.ontologyTranslatable === false,
	violatedBy: (subject) => subject.is_translatable,
	message: (subject) =>
		`${subject.source} (${subject.tipo}) is a ${subject.model} node declared translatable ` +
		`(${translatableOrigin(subject)}), but a ${subject.model} is NEVER translatable. ` +
		`This is an ontology bug: set ${ONTOLOGY_TRANSLATABLE} to "no" on this node in the master ` +
		'ontology and update the ontology — the engine does not override the flag.',
};

/** Every model rule the health check runs. Frozen: rules are definitions, never state. */
const MODEL_RULES: readonly ModelRule[] = Object.freeze([TRANSLATABLE_FORBIDDEN]);

/**
 * The rules ONE node breaks (empty for a healthy node, a node of a model that states no
 * rule, and a node whose model does not resolve — `model_unresolved` is reported by the
 * machine-name channel already).
 */
export function modelRuleViolations(subject: ModelRuleSubject): ModelRuleViolation[] {
	const model = subject.model;
	if (model === null || model === '') return [];
	const violations: ModelRuleViolation[] = [];
	for (const rule of MODEL_RULES) {
		if (!rule.appliesTo(model) || !rule.violatedBy(subject)) continue;
		violations.push({
			source: subject.source,
			tipo: subject.tipo,
			model,
			rule: rule.kind,
			translatableStated: subject.translatableStated,
			message: rule.message({ ...subject, model }),
		});
	}
	return violations;
}

/** The model names (of `models`) that state at least one rule — the gate's non-vacuity floor. */
export function modelsWithRules(models: Iterable<string>): string[] {
	return [...new Set(models)].filter((model) => MODEL_RULES.some((rule) => rule.appliesTo(model)));
}
