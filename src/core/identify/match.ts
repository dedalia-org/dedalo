/**
 * MATCHING — score other records against a seed, using the profile's criteria.
 *
 * Two stages, deliberately:
 *
 *  1. NARROW with the database. The required criteria (and, failing those, any
 *     agreement on an identifying one) compile to a normal SQO filter, executed
 *     by the same assembler every search uses. This is what keeps the work
 *     proportional to "objects that share something" rather than to the whole
 *     corpus.
 *  2. SCORE in TypeScript, over that pool only. Comparison semantics — partial
 *     agreement, tolerances, set equality — are not expressible as a single
 *     SQL score without inventing a second query language, and they are the
 *     part a curator will want to argue with.
 *
 * Every result carries its per-criterion breakdown. That is a requirement, not
 * a nicety: a bare number is either ignored or trusted far past what it means,
 * and neither is useful to someone deciding whether two coins share a die.
 *
 * THE POOL IS BOUNDED AND SAYS SO. A profile with no required criterion could
 * otherwise ask to score an entire collection. When the cap truncates, the
 * result reports it rather than quietly presenting the first N as "the
 * matches".
 *
 * IDENTIFICATION IS A READ OF OTHER PEOPLE'S RECORDS, so it is gated like one.
 * A result quotes the candidate's values back (`outcomes[].detail`: "both
 * 'Athena'"), which makes an ungated run a read of every record the profile's
 * sections hold. The principal therefore runs through BOTH stages — the pool
 * query carries it (so the projects filter narrows the SQL) and every candidate
 * is re-checked per record before it is read (so a table exempt from the
 * projects filter, or a server-set skip flag, cannot open a side door). Same
 * shape as `ai/rag/object_retrieval.ts`, for the same reason it states there: a
 * hit from a broad index is never an authorization oracle.
 *
 * THE RECORD BOUNDARY IS NOT THE WHOLE GATE, so it is not the whole gate here.
 * dd774 grants are per-(section, component), and a criterion path routinely
 * LEAVES the record (a coin's legend lives on its Type), so "you may open this
 * record" says nothing about the component whose value the outcome would quote.
 * Every criterion therefore also passes the subsystem's ONE per-component rule,
 * `identify/component_access.ts` criterionReadableOn — the same call
 * `ai/identify/propose.ts`, `cluster.ts` and `vision.ts` make. One definition,
 * one place to audit; a duplicated security check is the shape of rule that
 * rots. What a denial DOES to the result is argued at scoreCandidate, where the
 * choice is made.
 */

import { buildLocatorLookupKey, type Locator } from '../concepts/locator.ts';
import { runWithRecordMemo } from '../db/record_memo.ts';
import { runSearch } from '../search/search_statement.ts';
import { buildSearchSql } from '../search/sql_assembler.ts';
import type { Principal } from '../security/permissions.ts';
import { scopeRecordHits } from '../security/record_scope.ts';
import { type ComponentGrant, criterionReadableOn } from './component_access.ts';
import { criteriaToFilter, criterionToSqoLeaf } from './criteria.ts';
import { createPathReadScope, IDENTITY_LOCATOR_PROPERTIES, readPathValues } from './path_read.ts';
import type {
	Criterion,
	CriterionOutcome,
	CriterionValue,
	IdentificationProfile,
	MatchResult,
	ValueLocator,
} from './types.ts';

/** Default ceiling on candidates scored in one call. */
export const DEFAULT_POOL_CAP = 500;

/** Reads one record's values at one criterion path (readPathValues in production). */
export type ValueReader = (
	record: { sectionTipo: string; sectionId: number },
	path: Criterion['path'],
) => Promise<CriterionValue | null>;

/** One record's identity in a pool — the shape both stages pass around. */
export interface CandidateRecord {
	sectionTipo: string;
	sectionId: number;
}

/** Finds the candidate pool for a seed (the SQO search in production). */
export type PoolFinder = (
	profile: IdentificationProfile,
	seedValues: ReadonlyMap<string, CriterionValue | null>,
	poolCap: number,
	principal: Principal,
) => Promise<CandidateRecord[]>;

/** Drops the records a principal may not read (the section + projects ACL). */
export type AccessFilter = (
	principal: Principal,
	records: readonly CandidateRecord[],
) => Promise<CandidateRecord[]>;

export interface MatchInput {
	profile: IdentificationProfile;
	seed: { sectionTipo: string; sectionId: number };
	/**
	 * WHOSE READ THIS IS. Required, not optional — deliberately.
	 *
	 * `buildSearchSql` treats an absent principal as an INTERNAL search and skips
	 * the projects filter (see SearchOptions.principal), which is the right
	 * default for system code and exactly the wrong one here: identification
	 * reads other records and quotes their values back, so "no principal" would
	 * mean "see everything" for whoever reached this function first. Making it a
	 * required field moves that decision to the caller, where it can be reviewed:
	 * an API action passes `currentPrincipal()`, and a background job passes an
	 * explicit system principal (the shape `ai/rag` uses for its indexer) so the
	 * grant is visible in the code that chose it.
	 */
	principal: Principal;
	/** Max candidates to SCORE (not to return). */
	poolCap?: number;
	/** Max results to return, best first. */
	limit?: number;
	/**
	 * Injectable seams. Production omits all four. They exist so the SCORING
	 * rules — partial agreement, tolerances, the required gate, exact-set
	 * identity — and the ACCESS rules can be tested exhaustively as pure logic; a
	 * scorer only reachable through a live database ends up tested for the two
	 * cases someone had fixtures for.
	 */
	readValues?: ValueReader;
	findPool?: PoolFinder;
	filterAccessible?: AccessFilter;
	/**
	 * The per-(section, component) read level — `getPermissions` in production,
	 * injected the same way `propose.ts`/`cluster.ts`/`vision.ts` inject it, so
	 * the RULE ("a denied criterion is never quoted, never scored") is testable
	 * without a dd774 fixture standing between the assertion and the rule.
	 */
	componentGrant?: ComponentGrant;
}

/** Answers "may this principal read what this criterion touches on this record?" */
type CriterionReadable = (
	criterion: Criterion,
	record: { sectionTipo: string },
) => Promise<boolean>;

/**
 * The per-component gate, memoized for ONE call.
 *
 * The question is asked per (criterion, candidate) over a pool of up to
 * {@link DEFAULT_POOL_CAP} records, which is the one place in this subsystem
 * where re-asking is not free: `getPermissions` is TTL-cached per user (the
 * reason `propose.ts` can call it per (criterion, neighbour) without a query
 * each time), but it still resolves component aliases and walks the table on
 * every call. The ANSWER depends only on the principal (fixed for a call), the
 * criterion's PATH and the record's SECTION — never on the record's id — so a
 * pool of 500 candidates in one section costs exactly as many lookups as a pool
 * of one.
 *
 * The key is the whole path, not the components criterionReadableOn happens to
 * inspect: a memo that encoded "entry and leaf" would be a second, silent copy
 * of the rule, and would go stale the day the rule tightens.
 *
 * Keyed on the DECLARED path and the candidate's section — and that is now
 * honest (P1-3 / SEC-12): this answer is the DECLARED pre-check that mints the
 * `restricted` marker, while the LANDED-section authorization lives inside the
 * path reader itself, per record, where the memo cannot reach it.
 */
function memoizeReadability(
	principal: Principal,
	grant: ComponentGrant | undefined,
): CriterionReadable {
	const answers = new Map<string, Promise<boolean>>();
	return (criterion, record) => {
		const key = `${record.sectionTipo}\0${criterion.path
			.map((step) => `${step.section_tipo}:${step.component_tipo}`)
			.join('>')}`;
		let answer = answers.get(key);
		if (answer === undefined) {
			answer = criterionReadableOn(criterion, record, principal, grant);
			answers.set(key, answer);
		}
		return answer;
	};
}

/**
 * What a criterion's outcome says when the caller may not read its components.
 * A CONSTANT: it must be identical for every candidate, or the string itself
 * becomes the disclosure the gate exists to prevent.
 */
const RESTRICTED_DETAIL = 'not readable by this caller';

/** Thrown when the caller may not read the record they asked to identify. */
export class IdentifyAccessError extends Error {
	constructor(seed: CandidateRecord) {
		super(`identification: record ${seed.sectionTipo}/${seed.sectionId} is not readable`);
		this.name = 'IdentifyAccessError';
	}
}

export interface MatchReport {
	results: MatchResult[];
	/**
	 * The cap stopped us before the pool ran out — there are more candidates
	 * than were scored. Deliberately a FLAG, not a count: the pool query asks
	 * for `cap + 2` rows (one to answer "is there more?", one for the seed's own
	 * row, which the query returns and the matcher drops) precisely so it can
	 * answer that without paying for a full count, and reporting it as a number
	 * would say "1 more" when there might be five thousand.
	 */
	moreAvailable: boolean;
	/** Criteria the seed itself has no value for; they cannot discriminate. */
	blindCriteria: string[];
	/**
	 * Criteria this caller has no component grant on. They were neither compared
	 * nor quoted, so THE SCORES IN THIS REPORT ARE PARTIAL — computed over the
	 * remaining criteria. Reported rather than left implicit: a restricted caller
	 * otherwise sees a different number for the same pair of records than a
	 * privileged one, with nothing saying why.
	 *
	 * NOT an existence oracle: it is a statement about the CALLER'S OWN GRANTS
	 * (the same for every candidate, derivable from their profile), never about
	 * what any record holds. Kept separate from `blindCriteria`, which means "the
	 * seed records nothing here" — a claim about the data that would be a lie.
	 */
	restrictedCriteria: string[];
}

/**
 * Locator identity: the fields that name a record, never the transient `id`.
 * Built through concepts/locator.ts on the SAME property set path_read.ts reads
 * with — one locator-identity rule per subsystem, so a stored '05' and a 5 are
 * one record on both sides of the comparison (DEC-21).
 */
function locatorKey(locator: ValueLocator): string {
	return buildLocatorLookupKey(locator as Locator, IDENTITY_LOCATOR_PROPERTIES);
}

/**
 * The Unicode combining marks NFD splits an accented letter into. Written as
 * escapes, not as the literal characters: a combining mark pasted into a source
 * file attaches itself to whatever precedes it (here the class's `[`), which is
 * both unreadable and how the range silently stops meaning what it says.
 */
// stripping the combining marks NFD produced is exactly the point (same as ai/mcp/label_resolution.ts)
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Normalize text for comparison: case, accents and whitespace are not identity.
 *
 * EXPORTED because the proposal engine (`src/ai/identify/propose.ts`) groups
 * neighbour values into votes with the same rule. If the two ever diverge, a
 * proposal splits a vote over spellings the matcher already considers one value
 * — and the disagreement would surface as a confidence that quietly makes no
 * sense, not as an error. One definition.
 */
export function normalizeText(value: string): string {
	return value
		.normalize('NFD')
		.replace(COMBINING_MARKS, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Compare a seed value with a candidate value under one criterion's mode.
 * Returns null when EITHER side is empty: that is absence, not disagreement,
 * and scoring it as disagreement punishes incomplete cataloguing — which is
 * the normal state of every collection.
 */
export function compareValues(
	criterion: Criterion,
	seedValue: CriterionValue | null,
	candidateValue: CriterionValue | null,
): { agreed: boolean | null; detail: string } {
	if (seedValue === null || candidateValue === null) {
		return { agreed: null, detail: 'not recorded on one side' };
	}
	if (seedValue.kind !== candidateValue.kind) {
		return {
			agreed: false,
			detail: `incomparable values (${seedValue.kind} vs ${candidateValue.kind})`,
		};
	}

	switch (seedValue.kind) {
		case 'locators': {
			const candidate = candidateValue as Extract<CriterionValue, { kind: 'locators' }>;
			if (seedValue.locators.length === 0 || candidate.locators.length === 0) {
				return { agreed: null, detail: 'not recorded on one side' };
			}
			const seedKeys = new Set(seedValue.locators.map(locatorKey));
			const shared = candidate.locators.filter((locator) => seedKeys.has(locatorKey(locator)));
			return {
				agreed: shared.length > 0,
				detail:
					shared.length > 0 ? `shares ${shared.length} of ${seedKeys.size}` : 'no shared value',
			};
		}
		case 'text': {
			const candidate = candidateValue as Extract<CriterionValue, { kind: 'text' }>;
			const seedTexts = new Set(seedValue.values.map(normalizeText).filter((v) => v !== ''));
			const candidateTexts = candidate.values.map(normalizeText).filter((v) => v !== '');
			if (seedTexts.size === 0 || candidateTexts.length === 0) {
				return { agreed: null, detail: 'not recorded on one side' };
			}
			const hit = candidateTexts.find((text) => seedTexts.has(text));
			return {
				agreed: hit !== undefined,
				detail: hit !== undefined ? `both '${hit}'` : 'differs',
			};
		}
		case 'number': {
			const candidate = candidateValue as Extract<CriterionValue, { kind: 'number' }>;
			if (seedValue.values.length === 0 || candidate.values.length === 0) {
				return { agreed: null, detail: 'not recorded on one side' };
			}
			const tolerance = criterion.tolerance ?? 0;
			for (const seedNumber of seedValue.values) {
				for (const candidateNumber of candidate.values) {
					const delta = Math.abs(seedNumber - candidateNumber);
					if (delta <= tolerance) {
						return {
							agreed: true,
							detail: delta === 0 ? 'identical' : `differs by ${delta} (within ${tolerance})`,
						};
					}
				}
			}
			return { agreed: false, detail: `outside tolerance ${tolerance}` };
		}
		case 'date': {
			const candidate = candidateValue as Extract<CriterionValue, { kind: 'date' }>;
			if (seedValue.ranges.length === 0 || candidate.ranges.length === 0) {
				return { agreed: null, detail: 'not recorded on one side' };
			}
			for (const seedRange of seedValue.ranges) {
				for (const candidateRange of candidate.ranges) {
					if (seedRange.from <= candidateRange.to && candidateRange.from <= seedRange.to) {
						return { agreed: true, detail: 'ranges overlap' };
					}
				}
			}
			return { agreed: false, detail: 'no overlap' };
		}
	}
}

/** Exact-set identity: the die-study test. Same values, no extras either way. */
function setsAreIdentical(
	seedValue: CriterionValue | null,
	candidateValue: CriterionValue | null,
): boolean {
	if (seedValue === null || candidateValue === null) return seedValue === candidateValue;
	if (seedValue.kind !== candidateValue.kind) return false;
	if (seedValue.kind === 'locators') {
		const candidate = candidateValue as Extract<CriterionValue, { kind: 'locators' }>;
		const seedKeys = new Set(seedValue.locators.map(locatorKey));
		const candidateKeys = new Set(candidate.locators.map(locatorKey));
		if (seedKeys.size !== candidateKeys.size) return false;
		for (const key of seedKeys) if (!candidateKeys.has(key)) return false;
		return true;
	}
	if (seedValue.kind === 'text') {
		const candidate = candidateValue as Extract<CriterionValue, { kind: 'text' }>;
		const seedTexts = new Set(seedValue.values.map(normalizeText));
		const candidateTexts = new Set(candidate.values.map(normalizeText));
		if (seedTexts.size !== candidateTexts.size) return false;
		for (const text of seedTexts) if (!candidateTexts.has(text)) return false;
		return true;
	}
	// Numbers and dates are measurements, not sets: exact-set identity is not a
	// meaningful question for them, so they fall back to the normal comparison.
	return true;
}

/** The criteria that actually participate in identity. */
function identifyingCriteria(profile: IdentificationProfile): Criterion[] {
	return profile.criteria.filter((criterion) => criterion.role === 'identifying');
}

/**
 * Build the candidate pool with ONE query: everything the required criteria
 * demand, plus at least one identifying agreement. Without the second half a
 * profile with no required criterion would ask for the whole collection.
 */
async function findPool(
	profile: IdentificationProfile,
	seedValues: Map<string, CriterionValue | null>,
	poolCap: number,
	principal: Principal,
): Promise<CandidateRecord[]> {
	const required = profile.criteria.filter((criterion) => criterion.required);
	const anyOf = identifyingCriteria(profile)
		.map((criterion) => {
			const value = seedValues.get(criterion.id);
			return value === undefined || value === null ? null : criterionToSqoLeaf(criterion, value);
		})
		.filter((leaf): leaf is object => leaf !== null);

	// Nothing to search on: the seed records none of its identifying features.
	if (anyOf.length === 0) return [];

	const requiredFilter = criteriaToFilter(required, seedValues);
	const filter =
		requiredFilter === null ? { $or: anyOf } : { $and: [requiredFilter, { $or: anyOf }] };

	const pool = await buildSearchSql(
		{
			section_tipo: profile.sectionTipos,
			limit: poolCap,
			offset: 0,
			filter,
		} as never,
		// The projects filter runs ONLY when the assembler is given a principal.
		// Omitting the options object (as this did) silently made every pool an
		// unscoped internal search — the cap was the only thing bounding it.
		{ principal },
	);

	const rows = await runSearch<{ section_tipo: string; section_id: number }>(pool);
	return rows.map((row) => ({ sectionTipo: row.section_tipo, sectionId: Number(row.section_id) }));
}

/**
 * The per-record half of the gate: keep only records this principal may read.
 * The pool query's projects filter is NOT sufficient on its own — shared
 * vocabulary tables are exempt from it by design (sql_assembler
 * PROJECTS_FILTER_EXEMPT_TABLES) and it says nothing about the section-level
 * read grant — so every candidate is re-asked through the engine's shared
 * per-record scope gate before its values are read and quoted.
 */
async function filterReadableRecords(
	principal: Principal,
	records: readonly CandidateRecord[],
): Promise<CandidateRecord[]> {
	const scoped = await scopeRecordHits(
		records.map((record) => ({
			section_tipo: record.sectionTipo,
			section_id: record.sectionId,
		})),
		principal,
	);
	return scoped.map((hit) => ({ sectionTipo: hit.section_tipo, sectionId: hit.section_id }));
}

/**
 * Score one candidate against the seed. The caller MUST have passed the
 * candidate through the access filter first: this reads the record and copies
 * its values into `outcomes[].detail`.
 *
 * ── WHAT A DENIED CRITERION DOES TO THE RESULT (the decision, and why) ───────
 *
 * Two coherent answers were on the table. (a) Score over the readable criteria
 * only — the candidate stays, ranked on less evidence. (b) Drop the candidate
 * entirely, as §6 already drops denied RECORDS.
 *
 * (b) is the one that looks safer and is not. A component grant is uniform
 * across a section: if the caller lacks it, EVERY candidate is denied on that
 * criterion, so (b) turns "you have a gap on one descriptive field" into "this
 * feature returns nothing", silently, on a corpus full of matches. That is the
 * failure this codebase refuses everywhere else — a silently narrowed answer
 * that looks like a real one. The §6 precedent does not carry across either:
 * denied records vary PER RECORD, which is what makes a count of them an
 * existence oracle; a denied component varies per CALLER, and the caller already
 * knows their own grants.
 *
 * So: (a) — but (a) has to answer the objection that a restricted caller sees a
 * different score for the same pair of records with nothing labelling it. Three
 * rules make it answerable:
 *
 *  1. The criterion is neither compared nor read. It appears in `outcomes` with
 *     `agreed: null`, `restricted: true` and a CONSTANT detail — never a value —
 *     and contributes to neither side of the ratio, exactly as a criterion
 *     nobody recorded already does. The score is then a well-defined ratio over
 *     what this caller may see, and `restrictedCriteria` says so at the top of
 *     the report: partial, and labelled partial.
 *  2. A denied criterion that IS THE PROFILE'S GATE (`required`, and not one the
 *     seed is blind to anyway) drops the candidate. Two reasons, either
 *     sufficient: the pool was SELECTED by that criterion, so admitting the
 *     candidate answers "does this record share the value you may not read?"
 *     with a yes; and the profile's own membership test cannot be verified, so
 *     calling the candidate a match would assert something the engine did not
 *     check. Every candidate falls the same way, which makes this the one place
 *     option (b) is right — and it is not silent: the criterion is named in
 *     `restrictedCriteria`, so an empty answer says why it is empty. A required
 *     criterion the SEED cannot judge is not a gate for anyone (§5), so it is
 *     treated as an ordinary restricted criterion instead — "cannot judge"
 *     meaning READABLE AND EMPTY. A seed value that was itself withheld is an
 *     UNKNOWN gate, not an absent one, and fails closed.
 *  3. A candidate with no readable agreement at all, when something was denied,
 *     drops for the same reason at a lower volume: the pool's `$or` means it
 *     agreed on SOMETHING, so if nothing readable agrees, its mere presence
 *     names the denied criterion as the reason it is here.
 *
 * What remains, stated rather than laundered: the pool query is compiled from
 * the SEED's values, and the seed's own criteria are gated (findMatches, below)
 * precisely so a component this caller cannot read never enters that SQL. A
 * profile spanning SEVERAL sections can still admit a candidate through a leaf
 * readable on the seed's section and denied on the candidate's — rule 3 is what
 * covers that case.
 */
async function scoreCandidate(
	profile: IdentificationProfile,
	candidate: CandidateRecord,
	seedValues: Map<string, CriterionValue | null>,
	readValues: ValueReader,
	isReadable: CriterionReadable,
	restricted: Set<string>,
	seedRestricted: ReadonlySet<string>,
): Promise<MatchResult | null> {
	const outcomes: CriterionOutcome[] = [];
	let achieved = 0;
	let achievable = 0;
	let gatesPassed = 0;
	let agreements = 0;
	let denied = 0;
	let exactSetHolds = true;

	for (const criterion of profile.criteria) {
		if (criterion.role === 'ignored') continue;
		const seedValue = seedValues.get(criterion.id) ?? null;

		// THE PER-COMPONENT GATE — before the read, because the read is what pulls
		// another record's value into a string a curator will see.
		if (!(await isReadable(criterion, candidate))) {
			restricted.add(criterion.id);
			// Rule 2: an unverifiable gate that the pool was selected by. A seed the
			// caller MAY read and that holds no value gates nobody, so it does not
			// drop anyone either — `seedRestricted` is what tells the two apart, since
			// a withheld seed value also reads as null here.
			if (criterion.required && (seedValue !== null || seedRestricted.has(criterion.id))) {
				return null;
			}
			denied++;
			outcomes.push({
				criterionId: criterion.id,
				label: criterion.label,
				agreed: null,
				weight: criterion.role === 'identifying' ? criterion.weight : 0,
				detail: RESTRICTED_DETAIL,
				restricted: true,
				// A gate says so even when it could not be applied: the reader must
				// still not read its declared weight as a contribution.
				...(criterion.required ? { required: true as const } : {}),
			});
			continue;
		}

		const candidateValue = await readValues(candidate, criterion.path);
		const { agreed, detail } = compareValues(criterion, seedValue, candidateValue);

		if (criterion.role === 'identifying') {
			// The required gate asks "does the CANDIDATE have this?", not "do both
			// sides?". `agreed === null` collapses two very different situations,
			// so the seed's own absence is checked separately: a worn, half-
			// catalogued coin with an empty obverse-deity field is exactly the
			// object identification exists for, and gating on it would return an
			// empty result set with no explanation. The compiler makes the same
			// distinction when building the pool, and the two must agree.
			const seedCanJudge = seedValue !== null;
			if (criterion.required && seedCanJudge) {
				if (agreed !== true) return null;
				gatesPassed++;
			}
			if (agreed === true) agreements++;
			// WEIGHT IS IGNORED WHEN `required` (types.ts Criterion.weight,
			// IDENTIFY_SPEC §3 and §5). A required criterion is the POOL GATE, so
			// every candidate that reaches this line already agrees on it — adding
			// its weight would add the SAME CONSTANT to both sides of the ratio and
			// pull every score toward `sameType`. With a required legend (weight 6)
			// beside a deity (weight 1), a candidate sharing the legend and
			// differing on the deity would score 6/7 = 0.857 — "the same coin type"
			// — where the contract says 0/1. The gate decides membership; the
			// remaining criteria decide the ranking WITHIN it, which is the only
			// thing a score can usefully mean here.
			//
			// A criterion neither side records cannot discriminate either, so it is
			// not part of what was achievable — otherwise sparse records would score
			// low for being sparse rather than for being different.
			if (!criterion.required && agreed !== null) {
				achievable += criterion.weight;
				if (agreed) achieved += criterion.weight;
			}
			if (profile.exactSetIdentity && !setsAreIdentical(seedValue, candidateValue)) {
				exactSetHolds = false;
			}
		}

		outcomes.push({
			criterionId: criterion.id,
			label: criterion.label,
			agreed,
			weight: criterion.role === 'identifying' ? criterion.weight : 0,
			detail,
			// THE GATE MARKS ITSELF. `weight` above is the DECLARED number and a
			// required criterion contributes none of it (see the ratio just above),
			// so without this flag the breakdown reads as either "it contributed 6"
			// or — if a curator zeroed the weight to compensate — "descriptive,
			// shown not scored", which is the exact opposite of what a gate is.
			...(criterion.required ? { required: true as const } : {}),
		});
	}

	// Rule 3 (see the header): something was withheld, and nothing this caller can
	// read agrees. The pool's `$or` admitted this record on SOME agreement, so
	// returning it would name the withheld criterion as the reason it is here.
	if (denied > 0 && agreements === 0) return null;

	// Nothing comparable: not a match, not a zero — UNLESS the candidate cleared a
	// required gate. A profile whose only identifying criterion is required ("same
	// obverse legend = same type") is the simplest one a curator can write, and
	// with the gate rightly out of the ratio there is nothing left to divide by.
	// Answering that with an empty result set would silently narrow the profile to
	// nothing; the honest reading is that the candidate agreed on everything this
	// profile is able to judge it on, which is a full score.
	if (achievable === 0) {
		if (gatesPassed === 0) return null;
		achieved = 1;
		achievable = 1;
	}
	const score = achieved / achievable;

	let verdict: MatchResult['verdict'] = 'weak';
	if (score >= profile.thresholds.sameType && (!profile.exactSetIdentity || exactSetHolds)) {
		verdict = 'same_type';
	} else if (score >= profile.thresholds.candidate) {
		verdict = 'candidate';
	}

	return {
		sectionTipo: candidate.sectionTipo,
		sectionId: candidate.sectionId,
		score,
		verdict,
		outcomes,
	};
}

/**
 * Find and score the records that share this one's identifying features.
 *
 * Throws {@link IdentifyAccessError} when the principal cannot read the SEED —
 * asking to identify a record you cannot open is an error, not an empty result,
 * and answering it with "no matches" would be a worse answer than a refusal.
 * Candidates the principal cannot read are dropped SILENTLY (and are not
 * counted anywhere in the report): a "3 hidden" line is an existence oracle.
 */
export function findMatches(input: MatchInput): Promise<MatchReport> {
	// ONE ROW, ONE READ, FOR THE WHOLE CALL (PERF-01 / P2-11). Identification is
	// a READ — it never writes, and every path below goes through the same
	// point-in-time view — so the engine's read-scoped row memo
	// (`db/record_memo.ts`, the one `readSection` opens) applies here unmodified.
	// Without it the criterion reader re-fetched the SEED's row once per
	// criterion and each candidate's row once per criterion again: a 6-criterion
	// profile over a 500-record pool paid ~3000 whole-row reads for 501 rows.
	// An ambient memo is JOINED, so an identification nested inside a section
	// read shares that read's rows instead of shadowing them.
	return runWithRecordMemo(() => matchWithinReadScope(input));
}

/** {@link findMatches}, inside the row-memo scope it opens. */
async function matchWithinReadScope(input: MatchInput): Promise<MatchReport> {
	const { profile, seed, principal } = input;
	const poolCap = input.poolCap ?? DEFAULT_POOL_CAP;
	// The production reader is bound to ONE scope for the whole call: every
	// path it walks is authorized per LANDED record on that record's own section
	// (path_read.ts, ACCESS). A reader injected by a gate is the gate's own.
	const pathScope = createPathReadScope({
		principal,
		door: 'identify.find_matches',
		...(input.componentGrant === undefined ? {} : { componentGrant: input.componentGrant }),
	});
	const readValues: ValueReader =
		input.readValues ?? ((record, path) => readPathValues(record, path, { scope: pathScope }));
	const poolFinder = input.findPool ?? findPool;
	const filterAccessible = input.filterAccessible ?? filterReadableRecords;
	const isReadable = memoizeReadability(principal, input.componentGrant);
	const restricted = new Set<string>();

	// The seed is read before anything else, so it is gated before anything else.
	const [readableSeed] = await filterAccessible(principal, [seed]);
	if (readableSeed === undefined) throw new IdentifyAccessError(seed);

	// Read the seed once: every comparison is against these values.
	//
	// THE SEED IS PER-COMPONENT GATED TOO, and that is not symmetry for its own
	// sake: these values compile into the POOL QUERY, so a component this caller
	// may not read would otherwise pick the candidates — and a candidate's mere
	// presence would then disclose that it shares a value they were never allowed
	// to see. A withheld criterion is recorded as restricted, NOT as blind: blind
	// means "the seed records nothing here", which would be a claim about the
	// record rather than about the caller.
	const seedValues = new Map<string, CriterionValue | null>();
	const blindCriteria: string[] = [];
	const seedRestricted = new Set<string>();
	for (const criterion of profile.criteria) {
		if (criterion.role === 'ignored') continue;
		if (!(await isReadable(criterion, seed))) {
			restricted.add(criterion.id);
			seedRestricted.add(criterion.id);
			seedValues.set(criterion.id, null);
			continue;
		}
		const value = await readValues(seed, criterion.path);
		seedValues.set(criterion.id, value);
		if (value === null) blindCriteria.push(criterion.id);
	}

	// Ask for TWO more than we will score: one to learn whether more exist, and
	// one for the SEED'S OWN ROW. The seed satisfies its own `$or` filter by
	// construction and the default order is `section_id`, so it normally comes
	// back inside the window and is dropped just below — `cap + 1` therefore left
	// exactly `cap` survivors and reported `moreAvailable: false` on a pool the
	// LIMIT had genuinely cut. One row is a cheap price for the flag being true.
	const pool = (await poolFinder(profile, seedValues, poolCap + 2, principal)).filter(
		(candidate) =>
			!(candidate.sectionTipo === seed.sectionTipo && candidate.sectionId === seed.sectionId),
	);
	// `moreAvailable` stays a statement about the CAP, measured before the ACL:
	// it means "the cap stopped us", not "there are more you may see".
	const moreAvailable = pool.length > poolCap;
	const readable = await filterAccessible(principal, pool.slice(0, poolCap));
	const scored: MatchResult[] = [];
	for (const candidate of readable) {
		const result = await scoreCandidate(
			profile,
			candidate,
			seedValues,
			readValues,
			isReadable,
			restricted,
			seedRestricted,
		);
		if (result !== null) scored.push(result);
	}

	scored.sort((a, b) => b.score - a.score);
	return {
		results: input.limit === undefined ? scored : scored.slice(0, input.limit),
		moreAvailable,
		blindCriteria,
		// In profile order — the curator's own ordering, and stable whatever the
		// pool happened to contain.
		restrictedCriteria: profile.criteria
			.filter((criterion) => restricted.has(criterion.id))
			.map((criterion) => criterion.id),
	};
}
