/**
 * THE /health BODY — pure, so the contract it carries can be gated without
 * booting a server (server.ts owns the status code and the DB probe).
 *
 * WHY IT IS ITS OWN MODULE (2026-08-24). This payload is not only a liveness
 * ping: it is the ONLY thing the code-update panel can still read across the
 * restart it just triggered — the job-frame stream dies with the process by
 * design. The panel's "updated vs rolled back" verdict is computed from these
 * bytes, so they are a client contract, and a client contract with no gate is
 * how `version` came to be the verdict for an install where the version cannot
 * change (the dev channel). `install_digest` is the token that does move.
 *
 * Leaf module: no config, no DB, no fs (type-only imports).
 */

import type {
	BootSchemaStateName,
	DataVersionState,
	UpdateRunFacts,
} from '../update/boot_state.ts';
import type { ReleaseKind } from '../update/release_identity.ts';

export interface HealthPayload {
	result: 'ok' | 'error';
	entity: string;
	/**
	 * The running engine's RELEASE IDENTITY (release_identity.ts): `X.Y.Z` for an
	 * exact stable tag, `X.Y.Z-(alpha|beta|rc).N` for an exact prerelease tag,
	 * `X.Y.Z.dev` for anything untagged (WC-2026-10-15-release-identity-from-tag).
	 * Opaque to a reader that orders: the data triple is never parsed out of it.
	 */
	version: string;
	/**
	 * Which of the three kinds `version` is — so a reader never infers it from
	 * the string's shape. OPTIONAL on the wire: a server predating the release
	 * identity omits it, and a mid-restart poll may still be talking to one.
	 */
	release_kind?: ReleaseKind;
	db: 'ok' | 'down';
	/**
	 * sha256 of the archive this tree was installed from (install_stamp.ts), or
	 * null on a dev checkout / an install predating stamps. ALWAYS present: a
	 * client that cannot tell "no digest" from "key absent" would read a missing
	 * key as a changed one. It names a public archive published next to its own
	 * `.sha256` sidecar, so it discloses nothing the release URL does not.
	 */
	install_digest: string | null;
	request_id: string;
	/** Dev-mode-only, opaque; present only when a fingerprint was computed. */
	test_database?: string | null;
	/**
	 * This boot's migration run (update audit 2026-10-29, U-01): `failed` turns
	 * the probe red — a tree whose schema did not land is not healthy, and a red
	 * probe is what keeps a pending code update from passing as a success.
	 * `skipped`: no run in this process (smoke boot). Optional on the wire: a
	 * server predating it omits the key.
	 */
	boot_schema?: BootSchemaStateName;
	/**
	 * Installed data version vs this code's (U-04). `pending`: an "Update data"
	 * is due — reported, not red (it is the normal state between a code update
	 * and its data update). `ahead`: older code over a newer database — red.
	 */
	data_version?: DataVersionState;
	/**
	 * Present only when `boot_schema` is `failed`: whether the failed run had
	 * already moved the schema (null = unknown, treated as moved). false → the
	 * update stays pending and the watchdog rolls the code back; true/null → the
	 * update is `needs_restore` and waits for a human (a database restore).
	 */
	boot_schema_moved?: boolean | null;
	/**
	 * The update run in flight, or the last one this process ended (update audit
	 * 2026-10-29, design §3.5). A run applying schema/data is NOT red for it —
	 * `boot_schema` is `skipped` and `data_version` `pending` while it works.
	 * Red in one case: the run ordered its code ROLLED BACK (rollback.ts allowed
	 * it) and this process still runs the target tree — the red probe is what
	 * makes the supervisor's watchdog put the previous tree back.
	 */
	update_run?: UpdateRunFacts;
}

/** Whether the boot facts make the probe red (see the field comments above). */
function bootFactsRed(
	bootSchema: BootSchemaStateName | undefined,
	dataVersion: DataVersionState | null | undefined,
	rollbackOrdered: boolean,
): boolean {
	return bootSchema === 'failed' || dataVersion?.state === 'ahead' || rollbackOrdered;
}

/** Green: the database answers and no boot fact is red. */
function isHealthy(options: {
	dbOk: boolean;
	version?: string;
	bootSchema?: BootSchemaStateName;
	dataVersion?: DataVersionState | null;
	updateRun?: UpdateRunFacts | null;
}): boolean {
	const ordered = rollbackOrdered(options.updateRun);
	return options.dbOk && !bootFactsRed(options.bootSchema, options.dataVersion, ordered);
}

/** The run ordered a code rollback and this process still runs the tree it installed. */
function rollbackOrdered(run: UpdateRunFacts | null | undefined): boolean {
	return run?.state === 'ROLLED_BACK_CODE' && run.on_target;
}

export function buildHealthPayload(options: {
	dbOk: boolean;
	entity: string;
	version?: string;
	releaseKind?: ReleaseKind;
	installDigest: string | null;
	requestId: string;
	testDatabase?: string | null;
	bootSchema?: BootSchemaStateName;
	bootSchemaMoved?: boolean | null;
	dataVersion?: DataVersionState | null;
	updateRun?: UpdateRunFacts | null;
}): HealthPayload {
	const healthy = isHealthy(options);
	return {
		result: healthy ? 'ok' : 'error',
		entity: options.entity,
		version: options.version ?? '',
		...optional('release_kind', options.releaseKind),
		db: options.dbOk ? 'ok' : 'down',
		install_digest: options.installDigest,
		request_id: options.requestId,
		...optional('test_database', options.testDatabase),
		...optional('boot_schema', options.bootSchema),
		...optional('boot_schema_moved', options.bootSchemaMoved),
		...optional('data_version', options.dataVersion ?? undefined),
		...optional('update_run', options.updateRun ?? undefined),
	};
}

/**
 * THE WIRE VIEW of the payload: /health answers anyone (supervisors, load
 * balancers, the panel's post-restart poll — no session), so the update facts
 * are cut to what those readers act on (update audit 2026-10-29 review, #17):
 * `update_run` → its `state` (the panel's run_progress), `data_version` → its
 * `state` (the watchdog's `ahead`). The run id, its target release, owns_boot /
 * on_target and the installed/code version pair are not an anonymous caller's
 * business; `bun run update status` shows them to the operator. The verdict
 * (`result`) is computed from the FULL facts before the cut.
 */
export type HealthWireView = Omit<HealthPayload, 'update_run' | 'data_version'> & {
	update_run?: Pick<UpdateRunFacts, 'state'>;
	data_version?: Pick<DataVersionState, 'state'>;
};

export function anonymousHealthView(payload: HealthPayload): HealthWireView {
	const { update_run: run, data_version: data, ...rest } = payload;
	return {
		...rest,
		...(run === undefined ? {} : { update_run: { state: run.state } }),
		...(data === undefined ? {} : { data_version: { state: data.state } }),
	};
}

/** `{ [key]: value }`, or nothing when the value is absent — an optional wire key is omitted, never null-filled. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}
