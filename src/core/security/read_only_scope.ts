/**
 * The READ-ONLY request scope — the runtime half of a tool action's
 * `readOnly: true` declaration (tools/module.ts `GatedToolActionSpec.readOnly`).
 *
 * WHY A SCOPE AND NOT ONLY A DECLARATION. `readOnly` is a CLAIM the dispatcher
 * acts on: a read-only tool action skips the idempotency ledger
 * (api/dispatch.ts Gate 4), so a resend of it re-executes. That is only safe if
 * the action really writes nothing. `test/unit/tool_read_only_action_tripwire.test.ts`
 * proves it statically (the writer closure over the corpus), but a static walk
 * cannot see a dynamic dispatch, a computed `import()` or a callback handed to a
 * non-writer. So the dispatcher also runs a read-only action's handler INSIDE
 * this scope, and every door that stamps a record, a history row, an activity
 * row or a job calls {@link assertNotReadOnlyRequest} before its first effect: a
 * declared-read action that reaches one is refused as `internal.invariant` —
 * it is OUR bug (a wrong declaration), never the caller's. ONE DOOR REFUSES
 * QUIETLY: the activity row's only emitter, `logActivity`, swallows every
 * failure by design (an audit write must never fail the user action), so there
 * the refusal is a dropped row plus a logged line, never a thrown error; the
 * static walk is what names an action that logs activity.
 *
 * ALS, not a module flag: a flag would leak across the concurrent requests of
 * this long-lived process (engineering/REQUEST_ISOLATION.md). The scope is
 * inherited by every async continuation the handler starts — a fire-and-forget
 * write it launches is refused too.
 *
 * WHAT THE SCOPE COVERS (ENFORCED, and what the tripwire proves): the guarded
 * doors — every matrix DML primitive (db/matrix_write.ts), the per-component
 * item-id counter writes (allocateComponentItemId / absorbComponentItemIds: a
 * resend would bump the counter again), the activity and update-row writers
 * beside them, the Time Machine writers (db/time_machine.ts) and the job
 * manager's submit (media/jobs.ts).
 *
 * WHAT NOTHING ENFORCES (author-attested, stated so it is not read as coverage):
 *  - media FILES — about 40 `fs` write/rename call sites and no single write
 *    door to guard (media/test_media_root.ts counts the same sites and guards
 *    the root RESOLVERS instead, which serve reads too);
 *  - a psql child process spawned directly;
 *  - DML outside matrix_write.ts on other stores (user stats, locks, queues,
 *    the ontology and the derived search tables — the off-home ledger of
 *    sql_confinement_tripwire), which the static walk does not seed;
 *  - the lazily consumed body of a streamed response (the stream's pulls run
 *    outside the handler's async tree).
 * A `readOnly` action that touches one of these breaks its own declaration and
 * nothing refuses it; the claim in module.ts is worded to the enforced set.
 *
 * NO ESCAPE HATCH, on purpose: a scope that code can step out of is a write
 * door of its own. None is needed for the job manager either — a worker never
 * inherits the scope. `MediaJobManager.submit` refuses inside it, so no job is
 * ever STARTED from a read-only handler, and a job that waited for a lane slot
 * resumes in the context its own `await` captured at submit time, not in the
 * context of whichever call frees the slot (tool_read_only_action_tripwire
 * LEG 3 drives that scenario: a queued job whose slot is freed from inside
 * `runReadOnly`).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { DedaloError } from '../errors/dedalo_error.ts';

const readOnlyStore = new AsyncLocalStorage<true>();

/** Run `fn` with the read-only scope in force for its whole async tree. */
export function runReadOnly<T>(fn: () => T): T {
	return readOnlyStore.run(true, fn);
}

/** True inside {@link runReadOnly}. */
export function inReadOnlyScope(): boolean {
	return readOnlyStore.getStore() === true;
}

/**
 * Refuse a write door under the read-only scope. Called as the FIRST statement
 * of every guarded door, before any argument handling or SQL, so the refusal
 * costs nothing and names the door.
 */
export function assertNotReadOnlyRequest(door: string): void {
	if (readOnlyStore.getStore() !== true) return;
	throw new DedaloError('internal.invariant', {
		message: `${door}: a tool action declared readOnly reached a write door — fix the action (it writes) or drop its readOnly declaration`,
		coordinates: { door },
	});
}
