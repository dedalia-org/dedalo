/**
 * THE VERSION CONTRACT (update audit 2026-10-29, design §1; owner decisions
 * D-2, D-4, D-10) — the ONE definition of the three numbers an update compares.
 *
 *   release R        the code identity (build_stamp.ts RELEASE_IDENTITY) — one per tree
 *   data version V   the newest catalog release with a data step, ≤ R
 *                    (catalog.ts dataVersionOf → version.ts DEDALO_DATA_VERSION)
 *   ontology version = the V of the master that exported it (data_io.ts writes
 *                    ontology.json `version` = its DEDALO_DATA_VERSION); the
 *                    ontology `date` is informative only, never compared
 *   data model M(v)  the newest `incompatible` catalog release ≤ v, else the
 *                    line start — crossing a model needs a human restore (D-2)
 *
 *   compatible(O, installed) ⇔ M(O) = M(code V) = M(installed V)
 *
 * A version ABOVE every release this catalog knows has an UNKNOWN model (the
 * master runs a newer line than this code) — never "the same as ours": an
 * unknown model is refused, the conservative reading of a fact we cannot see.
 *
 * The DATA MODEL and the ontology compatibility are defined here and nowhere
 * else (the update run's planner/verify, the ontology source check). R and V
 * themselves stay where they are declared (build_stamp.ts / version.ts) — a
 * wire field that IS the data version (the manifest ask) reads it there. Pure:
 * the catalog plans are a parameter (default: the shipped RELEASE_PLANS).
 */

import { RELEASE_PLANS } from './catalog.ts';
import type { ReleasePlan } from './catalog_file.ts';
import {
	compareVersionArrays,
	DATA_LINE_START,
	DEDALO_DATA_VERSION,
	formatVersion,
	parseVersionString,
} from './version.ts';

type Plans = Readonly<Record<string, ReleasePlan>>;

/** The releases of `plans` as triples, ascending (the file is a linear walk). */
function releaseTriples(plans: Plans): { triple: number[]; plan: ReleasePlan }[] {
	return Object.values(plans)
		.map((plan) => ({ triple: parseVersionString(plan.version), plan }))
		.sort((a, b) => compareVersionArrays(a.triple, b.triple));
}

/**
 * M(v): the data model `version` belongs to — the newest `incompatible`
 * release ≤ it, else the line start. Null when `version` is above every
 * release of the catalog and above the line start's own triple: a model this
 * code does not know.
 */
export function dataModelOf(
	version: readonly number[],
	plans: Plans = RELEASE_PLANS,
	lineStart: readonly number[] = DATA_LINE_START,
): number[] | null {
	const releases = releaseTriples(plans);
	if (!withinKnownLine(version, releases, lineStart)) return null;
	let model: number[] = [...lineStart];
	for (const { triple, plan } of releases) {
		if (compareVersionArrays(triple, version) > 0) break;
		if (plan.compat === 'incompatible') model = triple;
	}
	return model;
}

/** Between the line start and the newest release the catalog knows (inclusive). */
function withinKnownLine(
	version: readonly number[],
	releases: readonly { triple: number[] }[],
	lineStart: readonly number[],
): boolean {
	const newest = releases.at(-1)?.triple ?? lineStart;
	const ceiling = compareVersionArrays(newest, lineStart) > 0 ? newest : lineStart;
	return (
		compareVersionArrays(version, lineStart) >= 0 && compareVersionArrays(version, ceiling) <= 0
	);
}

/** Why an ontology version cannot be imported here (machine ids; the refusal carries them). */
export type OntologyRefusal =
	| 'ontology_version_unreadable'
	| 'ontology_model_unknown'
	| 'ontology_model_mismatch'
	| 'installed_model_mismatch';

export interface OntologyVerdict {
	ok: boolean;
	refusal: OntologyRefusal | null;
	/** Operator-facing detail (names the versions and models). */
	detail: string;
}

/**
 * Can an ontology exported at `ontologyVersion` (ontology.json `version`) be
 * imported into an install whose code declares `codeVersion` and whose
 * database stands at `installedVersion`? All three on ONE data model.
 */
export function ontologyCompatibility(
	ontologyVersion: string | null,
	installedVersion: readonly number[],
	codeVersion: readonly number[] = DEDALO_DATA_VERSION,
	plans: Plans = RELEASE_PLANS,
	lineStart: readonly number[] = DATA_LINE_START,
): OntologyVerdict {
	const parsed = ontologyTriple(ontologyVersion);
	if (parsed === null) {
		return verdict(
			'ontology_version_unreadable',
			`the master's ontology names no version (${String(ontologyVersion)})`,
		);
	}
	const model = (version: readonly number[]) => dataModelOf(version, plans, lineStart);
	const codeModel = model(codeVersion);
	return (
		ontologyModelRefusal(parsed, model(parsed), codeVersion, codeModel) ??
		installedModelRefusal(installedVersion, model(installedVersion), codeModel) ?? {
			ok: true,
			refusal: null,
			detail: `ontology ${formatVersion(parsed)} on data model ${formatVersion(codeModel ?? [])}`,
		}
	);
}

/** ontology.json `version` as a triple, or null (absent, a date, garbage). */
function ontologyTriple(version: string | null): number[] | null {
	const parsed = version === null ? [] : parseVersionString(version);
	return parsed.length === 3 && !parsed.some(Number.isNaN) ? parsed : null;
}

/** The ontology's model must be known and equal the code's. */
function ontologyModelRefusal(
	ontology: readonly number[],
	ontologyModel: number[] | null,
	codeVersion: readonly number[],
	codeModel: number[] | null,
): OntologyVerdict | null {
	if (ontologyModel === null) {
		return verdict(
			'ontology_model_unknown',
			`the master exported ontology ${formatVersion(ontology)}, a data model this code (${formatVersion(codeVersion)}) does not know — update the code first`,
		);
	}
	if (codeModel !== null && compareVersionArrays(ontologyModel, codeModel) === 0) return null;
	return verdict(
		'ontology_model_mismatch',
		`ontology ${formatVersion(ontology)} is data model ${formatVersion(ontologyModel)}, this code is ${codeModel === null ? 'unknown' : formatVersion(codeModel)}`,
	);
}

/** The database's model must equal the code's (an "Update data" first). */
function installedModelRefusal(
	installed: readonly number[],
	installedModel: number[] | null,
	codeModel: number[] | null,
): OntologyVerdict | null {
	if (
		installedModel !== null &&
		codeModel !== null &&
		compareVersionArrays(installedModel, codeModel) === 0
	) {
		return null;
	}
	return verdict(
		'installed_model_mismatch',
		`the database is on data version ${formatVersion(installed)} (model ${installedModel === null ? 'unknown' : formatVersion(installedModel)}), the code on model ${codeModel === null ? 'unknown' : formatVersion(codeModel)} — run "Update data" first`,
	);
}

function verdict(refusal: OntologyRefusal, detail: string): OntologyVerdict {
	return { ok: false, refusal, detail };
}
