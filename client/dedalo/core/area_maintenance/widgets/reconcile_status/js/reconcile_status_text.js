// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * RECONCILE_STATUS_TEXT
 * Pure: the two sentences a reconcile row shows — its schedule and its last
 * run. Plain TEXT (the render layer puts it through textContent, SEC-XSS-011).
 * No imports: unit-tested from test/unit (reconcile_status_client.test.ts).
 */

/**
 * SCHEDULE_TEXT
 * @param {string|Object} schedule - 'operator' | 'boot' | {everyMs, atBoot?}
 * @returns {string}
 */
export const schedule_text = (schedule) => {
	if (schedule && typeof schedule === 'object' && schedule.everyMs) {
		const every = `every ${Math.round(schedule.everyMs / 60000)} min`;
		return schedule.atBoot === true ? `boot + ${every}` : every;
	}
	return String(schedule);
}; //end schedule_text

/**
 * LAST_RUN_TEXT
 * @param {Object|null} last_run - the registry's run record (null = never ran)
 * @returns {string}
 */
export const last_run_text = (last_run) => {
	if (!last_run) {
		return 'never (this process)';
	}
	if (last_run.error) {
		return `${last_run.ranAt} FAILED: ${last_run.error}`;
	}
	if (last_run.deferred) {
		// The apply could not happen then (a writer held the store); it is owed.
		return `${last_run.ranAt} DEFERRED — drift ${last_run.drift}, nothing applied: ${last_run.deferred}`;
	}
	if (last_run.refused) {
		// The apply was refused by its own precondition; re-running unchanged is refused again.
		return `${last_run.ranAt} REFUSED — drift ${last_run.drift}, nothing applied: ${last_run.refused}`;
	}
	return (
		last_run.ranAt +
		' ' +
		(last_run.apply ? 'apply' : 'check') +
		' — drift ' +
		last_run.drift +
		(last_run.apply ? `, applied ${last_run.applied}` : '')
	);
}; //end last_run_text

// @license-end
