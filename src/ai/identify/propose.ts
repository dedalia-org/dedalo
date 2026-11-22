/**
 * ELEMENT PROPOSALS — the no-model tier of "AI proposes, human confirms".
 *
 * Given a record whose identification criteria are only half filled in, propose
 * what the missing ones probably hold, by a SIMILARITY-WEIGHTED VOTE over the
 * neighbours that are ALREADY TAGGED. No model, no egress, no training: the
 * only knowledge used is what curators already recorded, which is why every
 * proposal can name the records it came from and a curator can check it in one
 * click. Vision and OCR land later (IDENTIFY_SPEC §9) and feed the SAME
 * acceptance flow — they are additional sources of votes, not a different
 * pipeline.
 *
 * ── THIS MODULE NEVER WRITES ─────────────────────────────────────────────────
 *
 * Nothing here saves, enqueues, or mutates anything: it returns data. That is
 * the project's first identification invariant ("no model-written data" —
 * IDENTIFY_PLAN §7.1), and it is meant to be STRUCTURALLY true rather than a
 * convention someone remembers. Concretely: this file imports no write module
 * (no `db/matrix_write`, no `section/record/*`, no `relations/save`, no queue),
 * issues no SQL of its own, and every value it produces is a plain object handed
 * back to the caller. `identify_propose.test.ts` asserts that mechanically, so a
 * future edit that adds a write seam fails the gate rather than shipping.
 * Acceptance is a separate, curator-initiated action through the normal
 * TM-audited component save path.
 *
 * ── WHY THIS IS THE CHARACTERIZER, GENERALISED ───────────────────────────────
 *
 * `ai/rag/characterizer.ts` already does this exact algorithm — retrieve
 * neighbours, read a value per neighbour, vote weighted by similarity, cite the
 * evidence — but only over the fixed `rag.context.metadata` roles (typology,
 * period, material). Identification's vocabulary is the PROFILE's criteria, and
 * a criterion is an SQO path rather than a component tipo, so the retrieval and
 * the aggregation are reused verbatim (`aggregateCategorical`, `summarizeDates`)
 * and only the READ side changes: `identify/path_read.ts` instead of a role
 * reader. Writing a third voting implementation would guarantee three
 * confidences that disagree.
 *
 * Two adaptations happen at that boundary, deliberately:
 *  1. The aggregators vote over STRINGS. A criterion value is a locator, a
 *     number or a date range, so each neighbour value is projected to a VOTE KEY
 *     (a locator's identity key, a normalized text, a tolerance bucket) and the
 *     winning key is mapped back to the structured value a curator can accept.
 *     The proposal therefore carries both: a display string and the
 *     `CriterionValue` the confirm flow will save.
 *  2. `summarizeDates` reports labels, not ordinals. The earliest/latest ordinal
 *     range is computed here alongside it, from the same items, so an accepted
 *     date proposal has something to write and not just something to read.
 *
 * ── WHERE NEIGHBOURS COME FROM, AND WHY IT IS ALWAYS REPORTED ────────────────
 *
 * Visual neighbours (`ai/rag/object_retrieval.ts`) when the section declares an
 * image index; otherwise STRUCTURAL neighbours — records that agree on the
 * criteria the seed DOES record, found by the ordinary matcher
 * (`core/identify/match.ts` findMatches). The two answer very different
 * questions ("looks like this" vs "is catalogued like this"), so which one ran
 * is part of the result and carries its reason. A structural fallback that
 * looked like a visual result would quietly turn "we have no photograph of this"
 * into a confident-looking visual claim.
 *
 * ── ACCESS CONTROL ───────────────────────────────────────────────────────────
 *
 * The principal is REQUIRED, for the reason match.ts states at length: an absent
 * principal means "unscoped" downstream, and a proposal QUOTES its neighbours'
 * values back. A neighbour the caller cannot read must never contribute a vote
 * and never appear as evidence — that is an information leak, not a permissions
 * nicety. Three gates, in this order:
 *   - the SEED is checked first and a denied seed RAISES (match.ts's
 *     IdentifyAccessError, reused: same question, same answer);
 *   - every neighbour passes the per-RECORD scope gate BEFORE any value of it is
 *     read (the retrieval legs gate too; this is not redundant, it is the gate
 *     that does not depend on which leg ran);
 *   - every criterion is re-gated per COMPONENT on that neighbour
 *     (`getPermissions`, the characterizer's M3 rule): dd774 grants are
 *     per-(section, component), and the record grant says nothing about the
 *     component this criterion actually reads.
 * Denied neighbours are dropped SILENTLY — a "3 hidden" count is an existence
 * oracle.
 *
 * REQUEST IDENTITY IS A PARAMETER, never an ALS read (isolation rule 2/6): the
 * principal and the data lang are passed in, so this is callable from a
 * background job. No module-level state of any kind lives here.
 */

import { buildLocatorLookupKey, type Locator } from '../../core/concepts/locator.ts';
import { type ComponentGrant, criterionReadableOn } from '../../core/identify/component_access.ts';
import { SECONDS_PER_VIRTUAL_YEAR } from '../../core/identify/criteria.ts';
import {
	type AccessFilter,
	type CandidateRecord,
	findMatches,
	IdentifyAccessError,
	normalizeText,
	type ValueReader,
} from '../../core/identify/match.ts';
import {
	createPathReadScope,
	IDENTITY_LOCATOR_PROPERTIES,
	readPathValues,
} from '../../core/identify/path_read.ts';
import type {
	Criterion,
	CriterionValue,
	IdentificationProfile,
	ValueLocator,
} from '../../core/identify/types.ts';
import { getPermissions, type Principal } from '../../core/security/permissions.ts';
import { scopeRecordHits } from '../../core/security/record_scope.ts';
import {
	aggregateCategorical,
	DEFAULT_CHARACTERIZE_TOP_K,
	type Evidence,
	summarizeDates,
} from '../rag/characterizer.ts';
import { defaultOntologyPort, RagConfig } from '../rag/config.ts';
import { storedThumbUrl } from '../rag/image_source.ts';
import {
	buildMultimodalProvider,
	isMediaEnabled,
	multimodalConfigFromEnv,
} from '../rag/multimodal_config.ts';
import { ObjectRetrieval } from '../rag/object_retrieval.ts';
import { isRagEnabled } from '../rag/rag_enabled.ts';
import type { Candidate } from '../rag/types.ts';

/**
 * Seconds in one virtual Dédalo year (dd_date's 372-day calendar). Mirrors
 * `core/identify/criteria.ts:61`, which does not export it; used ONLY to turn an
 * ordinal into a human year for a date proposal's label, never for comparison.
 */

/** Where a proposal's neighbours came from. Always reported (see the header). */
export type NeighbourSource = 'image_index' | 'structural';

/** One neighbour that may vote: a record identity plus its retrieval weight. */
export interface ProposalNeighbour {
	sectionTipo: string;
	sectionId: number;
	/**
	 * The vote weight: a visual neighbour's RRF/similarity score, or a structural
	 * neighbour's match score. Both are "how like the seed is this record", which
	 * is the only property the vote needs of them.
	 */
	weight: number;
	/** Thumbnail when the neighbour carries one (image neighbours do). */
	thumbUrl: string | null;
}

/** The neighbour set plus WHICH source produced it and why. */
export interface NeighbourReport {
	source: NeighbourSource;
	/** Stated in prose, so a fallback is legible in the API answer itself. */
	reason: string;
	neighbours: ProposalNeighbour[];
}

/** Finds the neighbours whose values will be voted over. */
export type NeighbourFinder = (input: {
	profile: IdentificationProfile;
	seed: CandidateRecord;
	principal: Principal;
	topK: number;
	/** The run's data language (ProposeInput.lang), threaded to the matcher. */
	lang?: string;
}) => Promise<NeighbourReport>;

/**
 * Per-(section, component) read level — `getPermissions` in production.
 * Re-exported from `core/identify/component_access.ts`, which now owns the gate
 * itself: the clusterer asks the same question of the same paths, and a
 * duplicated security rule is the exact shape that rots (one copy gets fixed,
 * the other keeps leaking).
 */
export type { ComponentGrant };

/** One competing value in a proposal's vote. */
export interface ProposalDistributionEntry {
	/** Curator-facing spelling of the value. */
	value: string;
	/** Share of the total vote weight, in [0,1]. */
	share: number;
}

interface ProposalCommon {
	criterionId: string;
	label: string;
	role: Criterion['role'];
	/** How many neighbours contributed a value to this criterion's vote. */
	votes: number;
	/** The neighbours that support the proposal — locator, weight and thumb. */
	evidence: Evidence[];
	confidence: number;
}

/** A proposal for a criterion whose values are discrete (the common case). */
export interface CategoricalElementProposal extends ProposalCommon {
	kind: 'categorical';
	/** What a curator reads. */
	display: string;
	/**
	 * The winning value in the engine's own dialect — a single-valued
	 * CriterionValue, so the confirm flow has something exact to save rather than
	 * a string it would have to re-resolve.
	 */
	value: CriterionValue;
	distribution: ProposalDistributionEntry[];
}

/** A proposal for a date criterion: a range, not a winner. */
export interface DateElementProposal extends ProposalCommon {
	kind: 'date_range';
	/** Labels, as `summarizeDates` reports them. */
	display: { earliest: string; latest: string; central: string };
	/** The same span in ordinal seconds (earliest.from … latest.to). */
	value: CriterionValue;
}

export type ElementProposal = CategoricalElementProposal | DateElementProposal;

/** Why a criterion produced no proposal. Never silent — the point of the list. */
export type SkipReason =
	/** The seed already records it: the feature fills gaps, it does not argue. */
	| 'already_recorded'
	/** `role: 'ignored'` — retained in the profile, not in play. */
	| 'ignored_role'
	/** `mode: 'image_similarity'` — not a value a neighbour can vote for. */
	| 'not_votable'
	/** Nobody readable held a value there. */
	| 'no_neighbour_values';

export interface SkippedCriterion {
	criterionId: string;
	label: string;
	reason: SkipReason;
	detail: string;
}

export interface ProposeReport {
	seed: CandidateRecord;
	profileId: string;
	/** Which neighbour leg ran, and why — never inferred by the caller. */
	neighbourSource: NeighbourSource;
	neighbourSourceReason: string;
	/** Neighbours that survived the record-level ACL and could vote. */
	neighboursConsidered: number;
	/** In profile order — the curator's own ordering, not a confidence ranking. */
	proposals: ElementProposal[];
	skipped: SkippedCriterion[];
}

export interface ProposeInput {
	profile: IdentificationProfile;
	seed: CandidateRecord;
	/**
	 * WHOSE READ THIS IS. Required for the same reason `MatchInput.principal` is:
	 * downstream, an absent principal means an unscoped internal search, and a
	 * proposal quotes other records' values back. The caller decides — an API
	 * action passes the request principal, a background job passes an explicit
	 * system one.
	 */
	principal: Principal;
	/** How many neighbours to aggregate. Default DEFAULT_CHARACTERIZE_TOP_K. */
	topK?: number;
	/** Data language for value resolution. Explicit, never an ALS read. */
	lang?: string;
	/**
	 * Injectable seams. Production omits all four: they exist so the VOTE, the
	 * gap rule and the ACCESS rules are testable as pure logic. A proposal engine
	 * only reachable through a live corpus ends up tested for the two cases
	 * someone had fixtures for.
	 */
	findNeighbours?: NeighbourFinder;
	readValues?: ValueReader;
	filterAccessible?: AccessFilter;
	componentGrant?: ComponentGrant;
}

/* ────────────────────────────── the entry point ─────────────────────────── */

/**
 * Propose values for the criteria this record does not yet record, by weighted
 * vote over its already-tagged neighbours.
 *
 * Throws {@link IdentifyAccessError} when the principal cannot read the SEED —
 * proposing for a record you may not open is an error, not an empty answer
 * (match.ts makes the same call for the same reason).
 */
export async function proposeElements(input: ProposeInput): Promise<ProposeReport> {
	const { profile, seed, principal } = input;
	const topK = input.topK ?? DEFAULT_CHARACTERIZE_TOP_K;
	const componentGrant = input.componentGrant ?? getPermissions;
	// ONE path-reader scope per run: every landed record is authorized on its
	// own section inside the reader (path_read.ts ACCESS, P1-3 / SEC-12).
	const pathScope = createPathReadScope({
		principal,
		door: 'identify.propose',
		componentGrant,
	});
	const readValues: ValueReader =
		input.readValues ??
		((record, path) => readPathValues(record, path, { lang: input.lang, scope: pathScope }));
	const filterAccessible = input.filterAccessible ?? defaultAccessFilter;
	const findNeighbours = input.findNeighbours ?? buildNeighbourFinder(defaultNeighbourPorts());

	// The seed is read below, so it is gated before anything else happens.
	const [readableSeed] = await filterAccessible(principal, [seed]);
	if (readableSeed === undefined) throw new IdentifyAccessError(seed);

	const skipped: SkippedCriterion[] = [];
	const open: Criterion[] = [];
	for (const criterion of profile.criteria) {
		if (criterion.role === 'ignored') {
			skipped.push(skip(criterion, 'ignored_role', "the profile marks this criterion 'ignored'"));
			continue;
		}
		if (criterion.mode === 'image_similarity') {
			skipped.push(
				skip(
					criterion,
					'not_votable',
					'an image-similarity criterion compares pictures, not values a neighbour can vote for',
				),
			);
			continue;
		}
		// THE GAP RULE: a criterion the curator already answered is not up for
		// discussion. Proposals fill gaps; they never argue with a cataloguer.
		const seedValue = await readValues(seed, criterion.path);
		if (seedValue !== null) {
			skipped.push(
				skip(criterion, 'already_recorded', 'the record already records a value at this path'),
			);
			continue;
		}
		open.push(criterion);
	}

	const found = await findNeighbours({ profile, seed, principal, topK, lang: input.lang });
	// The record gate runs BEFORE any neighbour value is read: the read is what
	// pulls another record's values into a string a curator will see.
	const readable = await filterAccessible(
		principal,
		found.neighbours.map((neighbour) => ({
			sectionTipo: neighbour.sectionTipo,
			sectionId: neighbour.sectionId,
		})),
	);
	const admitted = new Set(readable.map((record) => recordKey(record)));
	const voters = found.neighbours.filter(
		(neighbour) => admitted.has(recordKey(neighbour)) && !isSameRecord(neighbour, seed),
	);

	const proposals: ElementProposal[] = [];
	for (const criterion of open) {
		const proposal = await proposeForCriterion({
			criterion,
			voters,
			principal,
			readValues,
			componentGrant,
		});
		if (proposal === null) {
			skipped.push(
				skip(
					criterion,
					'no_neighbour_values',
					'no readable neighbour records a value at this path',
				),
			);
			continue;
		}
		proposals.push(proposal);
	}

	return {
		seed,
		profileId: profile.id,
		neighbourSource: found.source,
		neighbourSourceReason: found.reason,
		neighboursConsidered: voters.length,
		proposals,
		skipped,
	};
}

/* ──────────────────────────── one criterion's vote ──────────────────────── */

/** A neighbour's value projected into one vote. */
interface VoteItem {
	/** The identity values are grouped by (never shown to a curator). */
	key: string;
	/** The spelling shown to a curator. */
	display: string;
	/** The structured value an accepted proposal would save. */
	value: CriterionValue;
	weight: number;
	sectionTipo: string;
	sectionId: number;
	thumbUrl: string | null;
}

/** A date neighbour's contribution — the shape `summarizeDates` aggregates. */
interface DateVoteItem {
	from: number;
	to: number;
	label: string;
	weight: number;
	sectionTipo: string;
	sectionId: number;
	thumbUrl: string | null;
}

async function proposeForCriterion(input: {
	criterion: Criterion;
	voters: readonly ProposalNeighbour[];
	principal: Principal;
	readValues: ValueReader;
	componentGrant: ComponentGrant;
}): Promise<ElementProposal | null> {
	const { criterion, voters, principal, readValues, componentGrant } = input;
	const votes: VoteItem[] = [];
	const dateVotes: DateVoteItem[] = [];
	let contributors = 0;

	for (const neighbour of voters) {
		// PER-COMPONENT re-gate. The record gate above says the caller may open
		// this record; dd774 grants are per-(section, component) and this criterion
		// reads a specific one, possibly in another section entirely.
		if (!(await criterionReadableOn(criterion, neighbour, principal, componentGrant))) continue;

		const value = await readValues(
			{ sectionTipo: neighbour.sectionTipo, sectionId: neighbour.sectionId },
			criterion.path,
		);
		if (value === null) continue;

		if (value.kind === 'date') {
			const before = dateVotes.length;
			for (const range of value.ranges) {
				dateVotes.push({
					from: range.from,
					to: range.to,
					label: rangeLabel(range),
					weight: Math.max(0, neighbour.weight),
					sectionTipo: neighbour.sectionTipo,
					sectionId: neighbour.sectionId,
					thumbUrl: neighbour.thumbUrl,
				});
			}
			if (dateVotes.length > before) contributors++;
			continue;
		}

		const items = voteItemsOf(value, criterion, neighbour);
		if (items.length > 0) contributors++;
		votes.push(...items);
	}

	if (dateVotes.length > 0) {
		// The aggregator reports LABELS; the ordinal span is recomputed here from
		// the same items so an accepted proposal has an exact value to save.
		const summary = summarizeDates(dateVotes);
		const from = Math.min(...dateVotes.map((item) => item.from));
		const to = Math.max(...dateVotes.map((item) => item.to));
		return {
			kind: 'date_range',
			criterionId: criterion.id,
			label: criterion.label,
			role: criterion.role,
			votes: contributors,
			confidence: summary.confidence,
			display: summary.proposal,
			value: { kind: 'date', ranges: [{ from, to }] },
			evidence: summary.evidence,
		};
	}

	if (votes.length === 0) return null;

	// THE VOTE ITSELF is the characterizer's, unmodified: winner = highest total
	// weight, confidence = its share, distribution = every value's share.
	const aggregated = aggregateCategorical(
		votes.map((item) => ({
			value: item.key,
			weight: item.weight,
			sectionTipo: item.sectionTipo,
			sectionId: item.sectionId,
			thumbUrl: item.thumbUrl,
		})),
	);

	// Map the winning KEY back to what it means: the first spelling seen for it
	// (displays) and the structured value the confirm flow will save.
	const byKey = new Map<string, VoteItem>();
	for (const item of votes) if (!byKey.has(item.key)) byKey.set(item.key, item);
	const winner = byKey.get(aggregated.proposal);
	if (winner === undefined) return null;

	return {
		kind: 'categorical',
		criterionId: criterion.id,
		label: criterion.label,
		role: criterion.role,
		votes: contributors,
		confidence: aggregated.confidence,
		display: winner.display,
		value: winner.value,
		distribution: aggregated.distribution.map((entry) => ({
			value: byKey.get(entry.value)?.display ?? entry.value,
			share: entry.share,
		})),
		// The aggregator's evidence quotes the VOTE KEY; a curator reads the
		// display spelling. Same records, same weights, legible value.
		evidence: aggregated.evidence.map((item) => ({ ...item, value: winner.display })),
	};
}

/**
 * Project one neighbour's value at a criterion into votes. A multi-valued
 * component votes for each of its values with the neighbour's full weight —
 * a coin linking two deities genuinely attests both.
 */
function voteItemsOf(
	value: CriterionValue,
	criterion: Criterion,
	neighbour: ProposalNeighbour,
): VoteItem[] {
	const base = {
		weight: Math.max(0, neighbour.weight),
		sectionTipo: neighbour.sectionTipo,
		sectionId: neighbour.sectionId,
		thumbUrl: neighbour.thumbUrl,
	};

	switch (value.kind) {
		case 'locators':
			return value.locators.map((locator) => ({
				...base,
				key: locatorKey(locator),
				display: `${locator.section_tipo}/${locator.section_id}`,
				value: { kind: 'locators', locators: [locator] } as CriterionValue,
			}));
		case 'text':
			// Grouped on the NORMALIZED form (case, accents, whitespace are not
			// identity — the rule match.ts:164 compares by), displayed as written.
			return value.values
				.filter((text) => normalizeText(text) !== '')
				.map((text) => ({
					...base,
					key: normalizeText(text),
					display: text,
					value: { kind: 'text', values: [text] } as CriterionValue,
				}));
		case 'number':
			// Bucketed by the criterion's own tolerance, so 9.1 g and 9.15 g are one
			// candidate value rather than two singleton votes. Bucket EDGES can still
			// split a near-pair; the distribution shows that rather than hiding it.
			return value.values.map((number) => ({
				...base,
				key: numberBucketKey(number, criterion.tolerance),
				display: String(number),
				value: { kind: 'number', values: [number] } as CriterionValue,
			}));
		case 'date':
			return []; // handled by summarizeDates, never as a categorical vote
	}
}

/* ─────────────────────────────── neighbours ─────────────────────────────── */

/** The two legs a neighbour finder chooses between (injected in tests). */
export interface NeighbourPorts {
	/** Does this section declare an image index at all? */
	hasImageIndex(sectionTipo: string): Promise<boolean>;
	imageNeighbours(input: {
		seed: CandidateRecord;
		principal: Principal;
		topK: number;
	}): Promise<ProposalNeighbour[]>;
	structuralNeighbours(input: {
		profile: IdentificationProfile;
		seed: CandidateRecord;
		principal: Principal;
		topK: number;
		lang?: string;
	}): Promise<ProposalNeighbour[]>;
}

/**
 * Choose the neighbour leg and SAY WHICH ONE RAN.
 *
 * Visual similarity when the section declares an image index AND the seed
 * actually has indexed neighbours; structural agreement otherwise. The
 * "declared but empty" case is a real one — a section can be image-indexed while
 * this particular record has no photograph yet — and it falls back rather than
 * returning nothing, because a half-catalogued record with no photo is exactly
 * what proposals are for. It is reported as the fallback it is.
 */
export function buildNeighbourFinder(ports: NeighbourPorts): NeighbourFinder {
	return async ({ profile, seed, principal, topK, lang }) => {
		if (await ports.hasImageIndex(seed.sectionTipo)) {
			const neighbours = await ports.imageNeighbours({ seed, principal, topK });
			if (neighbours.length > 0) {
				return {
					source: 'image_index',
					reason: `section '${seed.sectionTipo}' declares an image index; neighbours are visually similar records`,
					neighbours,
				};
			}
			return {
				source: 'structural',
				reason: `section '${seed.sectionTipo}' declares an image index but this record has no indexed image (or no visual neighbours); fell back to records agreeing on the criteria it does record`,
				neighbours: await ports.structuralNeighbours({ profile, seed, principal, topK, lang }),
			};
		}
		return {
			source: 'structural',
			reason: `section '${seed.sectionTipo}' declares no image index; neighbours are records agreeing on the criteria this record does record`,
			neighbours: await ports.structuralNeighbours({ profile, seed, principal, topK, lang }),
		};
	};
}

/**
 * The production ports.
 *
 * The image leg is built exactly as `ai/rag/api.ts` similar_objects builds it
 * (kill-switch, media switch, env-configured provider, the section's declared
 * compare scope), so proposals and "similar objects" never disagree about what a
 * neighbour is. The structural leg is the ordinary matcher — the same scores a
 * curator sees in the match list become the vote weights here.
 */
export function defaultNeighbourPorts(): NeighbourPorts {
	return {
		async hasImageIndex(sectionTipo: string): Promise<boolean> {
			if (!isRagEnabled() || !isMediaEnabled()) return false;
			return await new RagConfig(defaultOntologyPort()).sectionHasImageContext(sectionTipo);
		},
		async imageNeighbours({ seed, principal, topK }): Promise<ProposalNeighbour[]> {
			const cfg = multimodalConfigFromEnv();
			const retrieval = new ObjectRetrieval(buildMultimodalProvider(cfg));
			const scope = await new RagConfig(defaultOntologyPort()).getCompareScope(seed.sectionTipo);
			const hits = await retrieval.findSimilarObjects(principal, seed, {
				sectionTipos: scope,
				mode: cfg.imageHybrid ? 'hybrid' : 'visual',
				topK,
			});
			return hits.map(candidateToNeighbour);
		},
		async structuralNeighbours({
			profile,
			seed,
			principal,
			topK,
			lang,
		}): Promise<ProposalNeighbour[]> {
			const report = await findMatches({ profile, seed, principal, limit: topK, lang });
			return report.results.map((result) => ({
				sectionTipo: result.sectionTipo,
				sectionId: result.sectionId,
				weight: result.score,
				thumbUrl: null,
			}));
		},
	};
}

/**
 * A retrieval hit as a voter: RRF score preferred, then the uniform score; the
 * thumb DERIVED from the stored identity (image_source.storedThumbUrl).
 */
export function candidateToNeighbour(candidate: Candidate): ProposalNeighbour {
	return {
		sectionTipo: candidate.sectionTipo,
		sectionId: candidate.sectionId,
		weight: candidate.rrfScore ?? candidate.score ?? 0,
		thumbUrl: storedThumbUrl(candidate.chunkMeta),
	};
}

/* ──────────────────────────────── the gates ─────────────────────────────── */

/**
 * The per-record half of the ACL, through the engine's shared scope gate — the
 * same call match.ts makes, for the same reason (a hit from a broad index is
 * never an authorization oracle).
 */
const defaultAccessFilter: AccessFilter = async (principal, records) => {
	const scoped = await scopeRecordHits(
		records.map((record) => ({
			section_tipo: record.sectionTipo,
			section_id: record.sectionId,
		})),
		principal,
	);
	return scoped.map((hit) => ({ sectionTipo: hit.section_tipo, sectionId: hit.section_id }));
};

/* ─────────────────────────────── small helpers ──────────────────────────── */

function skip(criterion: Criterion, reason: SkipReason, detail: string): SkippedCriterion {
	return { criterionId: criterion.id, label: criterion.label, reason, detail };
}

function recordKey(record: { sectionTipo: string; sectionId: number }): string {
	return buildLocatorLookupKey(
		{ section_tipo: record.sectionTipo, section_id: record.sectionId } as Locator,
		IDENTITY_LOCATOR_PROPERTIES,
	);
}

function isSameRecord(a: { sectionTipo: string; sectionId: number }, b: CandidateRecord): boolean {
	return recordKey(a) === recordKey(b);
}

/** Locator identity, on the subsystem's ONE property set (path_read/match agree). */
function locatorKey(locator: ValueLocator): string {
	return buildLocatorLookupKey(locator as Locator, IDENTITY_LOCATOR_PROPERTIES);
}

/** A number's vote bucket: exact when no tolerance is configured. */
function numberBucketKey(value: number, tolerance: number | undefined): string {
	if (tolerance === undefined || !(tolerance > 0)) return String(value);
	return String(Math.round(value / tolerance));
}

/** Virtual-calendar seconds → the whole year they fall in. */
function yearOf(seconds: number): number {
	return Math.floor(seconds / SECONDS_PER_VIRTUAL_YEAR);
}

/** A curator-facing label for one ordinal range ('1628' or '1628–1650'). */
function rangeLabel(range: { from: number; to: number }): string {
	const from = yearOf(range.from);
	const to = yearOf(range.to);
	return from === to ? String(from) : `${from}–${to}`;
}
