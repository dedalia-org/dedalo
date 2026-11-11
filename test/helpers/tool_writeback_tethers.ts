/**
 * The BEHAVIOUR TETHERS of tool_lossless_writeback_tripwire's SERVER cells — their titles,
 * nothing else. Two files compose over this one list:
 *
 *   - the CENSUS (test/unit/tool_lossless_writeback_tripwire.test.ts, HERMETIC tier: no
 *     database) maps every server PENDING cell and every server `refuses` cell to a tether
 *     (SERVER_PENDING_TETHERS / SERVER_REFUSES_TETHERS, each held EQUAL to its cells) and
 *     checks each named title IS in this list — and that no title here tethers nothing;
 *   - the TETHERS (test/unit/tool_lossless_writeback_tethers_native.test.ts, DB tier: the
 *     suite Postgres) register each title as a RUNNING test through `behaviourTether` and
 *     check the registered set EQUALS this list, so a deleted tether — or one turned into
 *     `test.skip` — is red there.
 *
 * Composed: every tether a cell names really runs. The split exists because the tethers
 * write scratch records and the census must run where no database is.
 */
export const WRITEBACK_TETHERS = {
	emptyBody:
		'runAutomaticTranslation × translateAndWrite: an EMPTY provider body is REFUSED and the target language KEPT — and a real body is written',
	deleteIfSafe:
		'deleteIfSafe × deleteSectionRecord: the revert KEEPS a record it created that someone else wrote to — and deletes one nobody did',
	transcription:
		'backgroundTranscriberPoll × pollTranscriptionCompletion: a finished ASR result does NOT replace a non-empty target slice — and fills an empty one',
} as const;

export const WRITEBACK_TETHER_TITLES: readonly string[] = Object.values(WRITEBACK_TETHERS);
