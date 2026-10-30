/**
 * THE RUN PLANNER (update audit 2026-10-29, design §3.1; owner decisions D-1,
 * D-2, D-4, D-7): installed state + target release + the catalog → the ordered
 * phase list of one run, or a refusal. Pure — it is also the dry run.
 *
 * A run walks every catalog release after the installed one up to the target,
 * in version order, and runs their declared steps (D-1) with ONE code swap —
 * the target's tree carries every intermediate release's migrations, scripts
 * and tools:
 *
 *   1. every `ontology` step placed BEFORE its release's `code` step (an
 *      ontology precondition, `min`) — they gate the swap, so they come first;
 *   2. one `code` step, of the target release;
 *   3. then each release's remaining steps in its declared order (ontology,
 *      schema, data, ancillary) — a schema phase applies that release's
 *      migrations (the ledger names each file's release), a data phase its rung.
 *
 * The endpoints carry the data model (version_contract.ts) so the journal can
 * say, before anything runs, whether this run crosses one (D-2).
 */

import { dataVersionOf, RELEASE_PLANS, UPDATE_CATALOG } from '../catalog.ts';
import type { ReleasePlan, ReleaseStep } from '../catalog_file.ts';
import { parseReleaseVersion } from '../release_identity.ts';
import { compareVersionArrays, formatVersion } from '../version.ts';
import { dataModelOf } from '../version_contract.ts';
import type { RunEndpoint, RunJournal } from './journal.ts';

export type PlanRefusal =
	| 'release_unreadable'
	| 'release_unknown'
	| 'not_forward'
	| 'model_unknown';

export type RunPlan =
	| {
			ok: true;
			from: RunEndpoint;
			to: RunEndpoint;
			plan: RunJournal['plan'];
			releasePlans: Record<string, ReleasePlan>;
			/** ontologyOnlyPlan: the operator's narrowing (RunJournal.ontology_scope). */
			ontologyScope?: string[];
	  }
	| { ok: false; refusal: PlanRefusal; detail: string };

type Plans = Readonly<Record<string, ReleasePlan>>;

/** The releases strictly after `from` up to and including `to`, ascending. */
function walk(plans: Plans, from: readonly number[], to: readonly number[]): ReleasePlan[] {
	return Object.values(plans)
		.map((plan) => ({ plan, triple: tripleOf(plan.version) ?? [] }))
		.filter(
			({ triple }) =>
				compareVersionArrays(triple, from) > 0 && compareVersionArrays(triple, to) <= 0,
		)
		.sort((a, b) => compareVersionArrays(a.triple, b.triple))
		.map(({ plan }) => plan);
}

function tripleOf(release: string): number[] | null {
	const parsed = parseReleaseVersion(release);
	return parsed === null ? null : [...parsed.triple];
}

/** A release's steps split at its code step: the ontology preconditions before, the rest after. */
function splitAtCode(plan: ReleasePlan): { pre: ReleaseStep[]; post: ReleaseStep[] } {
	const code = plan.steps.findIndex((step) => step.kind === 'code');
	return {
		pre: plan.steps.slice(0, Math.max(code, 0)).filter((step) => step.kind === 'ontology'),
		post: plan.steps.slice(code + 1),
	};
}

/** The ordered phases of a walk (see the header). */
export function phasesOf(releases: readonly ReleasePlan[], target: string): RunJournal['plan'] {
	const split = releases.map((plan) => ({ release: plan.version, ...splitAtCode(plan) }));
	return [
		...split.flatMap(({ release, pre }) => pre.map((step) => ({ release, step }))),
		{ release: target, step: { kind: 'code' } },
		...split.flatMap(({ release, post }) => post.map((step) => ({ release, step }))),
	];
}

/** An endpoint: the release, its data version, the data model. */
function endpoint(release: string, data: readonly number[], plans: Plans): RunEndpoint | null {
	const model = dataModelOf(data, plans);
	return model === null
		? null
		: { release, data: formatVersion(data), model: formatVersion(model) };
}

/**
 * Plan the run from the installed release (and the data version its database
 * stands at) to `target`. Refuses an unreadable or uncatalogued target, a
 * target triple below the installed one, or a data model it cannot name. A
 * same-triple target is a code-only run (see walkSpan).
 */
export function planRun(input: {
	installedRelease: string;
	installedData: readonly number[];
	target: string;
	plans?: Plans;
	targetData?: readonly number[];
}): RunPlan {
	const plans = input.plans ?? RELEASE_PLANS;
	const span = walkSpan(plans, input);
	if (!('from' in span)) return span;
	const targetData = input.targetData ?? dataVersionOf(UPDATE_CATALOG, span.to, true);
	const start = endpoint(input.installedRelease, input.installedData, plans);
	const end = endpoint(input.target, targetData, plans);
	if (start === null || end === null) {
		return {
			ok: false,
			refusal: 'model_unknown',
			detail: 'a data model of this walk is not in the catalog',
		};
	}
	const releases = walk(plans, span.from, span.to);
	const releasePlans = Object.fromEntries(releases.map((plan) => [plan.version, plan]));
	const phases = withTargetSchema(phasesOf(releases, input.target), formatVersion(span.to));
	return { ok: true, from: start, to: end, plan: phases, releasePlans };
}

/**
 * A run with a code phase OWNS the new tree's boot migrations (run/boot.ts: the
 * boot skips them), so the plan must apply them: when no `schema` phase follows
 * the code phase — a same-triple run (a developer build, a prerelease → its
 * stable: the walk is empty), or releases that declared no schema step — one
 * for the target triple closes the plan. Without it a new migration is never
 * applied and post-verify (schema_clean) rolls a healthy build back (review
 * 2026-10-30 #3).
 */
function withTargetSchema(plan: RunJournal['plan'], targetTriple: string): RunJournal['plan'] {
	const code = plan.findIndex((entry) => entry.step.kind === 'code');
	const schemaAfter = plan.slice(code + 1).some((entry) => entry.step.kind === 'schema');
	if (code === -1 || schemaAfter) return plan;
	return [...plan, { release: targetTriple, step: { kind: 'schema' } }];
}

/** The walk's two triples, or why it cannot be planned. */
function walkSpan(
	plans: Plans,
	input: { installedRelease: string; target: string },
): Extract<RunPlan, { ok: false }> | { from: number[]; to: number[] } {
	const from = tripleOf(input.installedRelease);
	const to = tripleOf(input.target);
	if (from === null || to === null) {
		return {
			ok: false,
			refusal: 'release_unreadable',
			detail: `${input.installedRelease} → ${input.target}`,
		};
	}
	// The SAME triple (a prerelease → its stable, a developer build of the
	// installed release) walks no catalog release: a code-only run, whose
	// identity move code_update.ts judges (version_walk.ts). The data model
	// cannot move inside one triple.
	const sameTriple = compareVersionArrays(to, from) === 0;
	if (!sameTriple && plans[formatVersion(to)] === undefined) {
		return {
			ok: false,
			refusal: 'release_unknown',
			detail: `${input.target} is in no catalog this run can read (this tree's, or the master's manifest)`,
		};
	}
	if (compareVersionArrays(to, from) < 0) {
		return {
			ok: false,
			refusal: 'not_forward',
			detail: `${input.target} is not ahead of ${input.installedRelease}`,
		};
	}
	return { from, to };
}

/**
 * The plan of an ONTOLOGY-ONLY run (the maintenance panel's Update ontology):
 * the installed release stays, one ontology phase updates every shared TLD
 * this install takes from its sources (run/ontology_phase.ts). No code phase,
 * so no restart, and a failure is a pre-swap failure (the previous code is the
 * running code).
 */
export function ontologyOnlyPlan(input: {
	installedRelease: string;
	installedData: readonly number[];
	plans?: Plans;
	scope?: string[];
}): RunPlan {
	const here = endpoint(input.installedRelease, input.installedData, input.plans ?? RELEASE_PLANS);
	if (here === null) {
		return {
			ok: false,
			refusal: 'model_unknown',
			detail: 'the installed data model is not in the catalog',
		};
	}
	const plan = [{ release: input.installedRelease, step: { kind: 'ontology' as const } }];
	const scope = input.scope === undefined ? {} : { ontologyScope: input.scope };
	return { ok: true, from: here, to: here, plan, releasePlans: {}, ...scope };
}
