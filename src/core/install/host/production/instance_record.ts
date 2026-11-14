/**
 * AN INSTANCE'S FROZEN PLAN, READ BACK FROM ITS INSTALL RECORD — the ONE
 * derivation of a recorded instance's plan context (`/var/lib/dedalo-install/<i>/`:
 * the plan's answers, the preflight's measured facts; the host registry's bun
 * pin), shared by the root re-render command (units_refresh.ts) and by the
 * template-upgrade decision of host_units (units.ts siblingUnitsBlockers): the
 * installer renders the units of ANOTHER instance on this host exactly as that
 * instance's own refresh would, so the two can never disagree on what "its
 * render" is.
 *
 * PURE but for its seams: `fs` (a HostFs — the scratch root in a gate) and
 * `readRecord` (the record files; `readRecordVia(fs)` reads them through the
 * same fs, host_executor.ts readHostRecord through the scratch seam).
 */

import { normalizeInstallAnswers } from '../../install_plan.ts';
import { type PlanFile, readPlanFile, readStateFile } from '../../run_files_core.ts';
import type { HostPlanCtx } from '../contract.ts';
import type { HostFs } from '../fs.ts';
import { INSTALL_STATE_ROOT, pathsFor } from '../layout.ts';
import { OS_ROWS, type OsRowId, osRowById } from '../os_support.ts';
import { hostRefuse } from '../refuse.ts';
import { ownEntry } from '../registry.ts';
import { bunPinOf, sourceTreeRoot } from '../source.ts';

/** The recorded plan and the part of the state the plan context needs. */
export type RecordReader = (instance: string) => {
	plan: PlanFile;
	state: { preflight: { host?: { facts: HostPlanCtx['facts'] } } } | null;
} | null;

/** What rendering a recorded instance needs of the host. */
export interface RecordedInstanceDeps {
	readonly fs: HostFs;
	readonly readRecord: RecordReader;
	/** The tree whose templates are rendered (default: the running one). */
	readonly source?: string;
}

/**
 * A record reader over `fs`: the instance's run dir under INSTALL_STATE_ROOT,
 * mapped by the fs (a scratch root's real path in a gate). An absent plan is
 * null; a plan or state file of another schema is null too — unreadable is
 * "no record", never a throw out of a sibling check.
 */
export function readRecordVia(fs: HostFs): RecordReader {
	return (instance) => {
		const dir = fs.real(`${INSTALL_STATE_ROOT}/${instance}`);
		try {
			const plan = readPlanFile(dir);
			return plan === null ? null : { plan, state: readStateFile(dir) };
		} catch {
			return null;
		}
	};
}

/** The recorded plan and its measured host facts, or the refusal that names what is missing. */
function recordedPlanAndFacts(
	instance: string,
	readRecord: RecordReader,
): { plan: PlanFile; facts: HostPlanCtx['facts']; os: OsRowId } {
	const record = readRecord(instance);
	if (record === null) {
		hostRefuse(
			'install.state_conflict',
			`no production install record for instance '${instance}' (/var/lib/dedalo-install/${instance}/) — the units can be rendered only from the plan the installer wrote`,
		);
	}
	const facts = record.state?.preflight.host?.facts;
	if (facts === undefined || facts.os === null) {
		hostRefuse(
			'install.state_conflict',
			`the install record of '${instance}' holds no measured host facts (the System check never ran to completion) — finish or abort the install first`,
		);
	}
	return { plan: record.plan, facts, os: facts.os };
}

/** The plan context of a recorded instance — the executor's own derivation (host_executor.ts planContext). */
export function recordedPlanContext(instance: string, deps: RecordedInstanceDeps): HostPlanCtx {
	const source = deps.source ?? sourceTreeRoot();
	const { plan, facts, os } = recordedPlanAndFacts(instance, deps.readRecord);
	const answers = normalizeInstallAnswers(plan.answers as Record<string, unknown>).answers;
	// The runtime pin the instance RUNS (the registry) — not necessarily this tree's.
	const treePin = bunPinOf(source);
	const pin = ownEntry(deps.fs, pathsFor(answers, treePin, facts))?.bun_pin ?? treePin;
	return {
		plan,
		answers,
		facts,
		row: osRowById(os) ?? (OS_ROWS[0] as (typeof OS_ROWS)[number]),
		paths: pathsFor(answers, pin, facts),
		source,
	};
}
