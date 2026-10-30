/**
 * THE BOUNDED RECORD POOL — which records a clustering run is allowed to look at.
 *
 * `match.ts` narrows with the database because it has a SEED to narrow by.
 * Clustering has no seed: "these thirty just came in, what are they?" is a
 * question about a SET. So the pool here is an ordinary search — the caller's
 * own SQO (the import batch's filter, the list the curator is looking at) or,
 * failing that, the sections themselves.
 *
 * THAT IS WHY THE CAP IS NOT OPTIONAL. Clustering compares records with each
 * other, so the work grows with the square of the pool; an unbounded pool is a
 * quadratic pass over a whole collection. The cap is applied HERE, at the one
 * place the pool is produced, and the run is told whether it truncated — a
 * clustering answer computed over the first N of a much larger set is a
 * different claim about the collection than one computed over all of it, and
 * the difference must not be invisible.
 *
 * `truncated` is a FLAG, not a count, for the reason `MatchReport.moreAvailable`
 * gives: the query asks for `cap + 1` rows precisely so it can answer "is there
 * more?" without paying for a count, and reporting that as a number would say
 * "1 more" when there might be five thousand.
 *
 * The principal is REQUIRED here for the same reason it is required in match.ts:
 * `buildSearchSql` treats an absent principal as an INTERNAL unscoped search, so
 * "optional" would mean "see everything" for whoever called this first. This is
 * a SELECT-only module — it enumerates identities and reads no values.
 */

import { type Sqo, sanitizeClientSqo } from '../concepts/sqo.ts';
import { runSearch } from '../search/search_statement.ts';
import { buildSearchSql } from '../search/sql_assembler.ts';
import type { Principal } from '../security/permissions.ts';
import type { CandidateRecord } from './match.ts';

/** Default ceiling on records considered by one clustering run. */
export const DEFAULT_CLUSTER_POOL_CAP = 300;

export interface RecordPoolRequest {
	/** Sections to draw the pool from. Also forced onto any supplied SQO. */
	sectionTipos: string[];
	/** Whose search this is. Required — see the module header. */
	principal: Principal;
	/** Max records to return. The query asks for `cap + 1` to detect truncation. */
	cap: number;
	/**
	 * The caller's live filter (a client SQO — the import batch, the list the
	 * curator is looking at). Sanitized like any client SQO; its pagination is
	 * replaced by the cap, because the run's bound is the cap and not whatever
	 * page size a widget happened to send.
	 */
	sqo?: Record<string, unknown> | null;
}

export interface RecordPool {
	records: CandidateRecord[];
	/** The cap stopped us: more records match than were considered. */
	truncated: boolean;
}

/**
 * The records a clustering run will consider, capped and principal-scoped.
 */
export async function listRecordPool(request: RecordPoolRequest): Promise<RecordPool> {
	const { sectionTipos, principal } = request;
	const cap = Math.max(1, Math.trunc(request.cap));
	if (sectionTipos.length === 0) return { records: [], truncated: false };

	const sqo: Sqo =
		request.sqo === undefined || request.sqo === null
			? ({ section_tipo: sectionTipos } as unknown as Sqo)
			: sanitizeClientSqo(structuredClone(request.sqo));

	// The scope is the CALLER'S argument, not the SQO's: a clustering run states
	// which sections it is about, and a sanitized client SQO must not be able to
	// widen that by carrying a different section_tipo than the gated one.
	const shaped = sqo as unknown as Record<string, unknown>;
	shaped.section_tipo = sectionTipos;
	shaped.limit = cap + 1;
	shaped.offset = 0;

	const built = await buildSearchSql(sqo, { principal, idsOnly: true });
	const rows = (await runSearch(built)) as Array<{
		section_tipo: string;
		section_id: number;
	}>;

	const records = rows.map((row) => ({
		sectionTipo: row.section_tipo,
		sectionId: Number(row.section_id),
	}));
	return { records: records.slice(0, cap), truncated: records.length > cap };
}

/**
 * Apply the same cap to a pool the caller supplied itself (an explicit "cluster
 * exactly these thirty"). Same bound, same truncation report — a caller-supplied
 * list is not a licence to run unbounded.
 */
export function capExplicitPool(records: readonly CandidateRecord[], cap: number): RecordPool {
	const bound = Math.max(1, Math.trunc(cap));
	return { records: records.slice(0, bound), truncated: records.length > bound };
}
