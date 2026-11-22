/**
 * Neighbour-aggregated object characterization (port of
 * core/rag/class.rag_characterizer.php; reference `src/ai/rag2/src/characterizer.ts`,
 * Brick 5). NO LLM.
 *
 * Given a seed object, retrieve its nearest visual+lexical neighbours
 * (ObjectRetrieval.findSimilarObjects) and aggregate their STRUCTURED ontology
 * metadata into a grounded proposal with confidence + cited evidence:
 *  - aggregateCategorical: a similarity-WEIGHTED VOTE over a categorical role
 *    (typology / material). Winner = highest-weight value; confidence = its share.
 *  - summarizeDates: earliest…latest range + weighted-central estimate for a date
 *    role (period). Confidence = 1 - (midpoint spread / total span).
 *
 * Each neighbour's value is read through the NEIGHBOUR'S OWN section context
 * (config.getContextMetadata(neighbour.sectionTipo)), so neighbours of different
 * sections contribute via their own role→componentTipo mapping. The metadata READER
 * is injected (unit-tested directly; the aggregators are pure). No module globals.
 */

import { getPermissions, type Principal } from '../../core/security/permissions.ts';
import { storedThumbUrl } from './image_source.ts';
import type { ObjectRetrieval, SimilarityMode } from './object_retrieval.ts';
import type { Candidate, RecordLocator } from './types.ts';

/** Default neighbour count aggregated into a proposal. */
export const DEFAULT_CHARACTERIZE_TOP_K = 20;

/** A categorical value read for a role from one neighbour. */
export interface CategoricalRead {
	kind: 'categorical';
	value: string;
}

/** A date read for a role: ordinal-seconds range + display label. */
export interface DateRead {
	kind: 'date';
	from: number;
	to: number;
	label: string;
}

export type RoleRead = CategoricalRead | DateRead | null;

/** Read one role's value for a neighbour record (resolved via its own context metadata). */
export type RoleReader = (
	role: string,
	componentTipo: string,
	neighbour: RecordLocator,
) => Promise<RoleRead>;

/** The config surface the characterizer needs (satisfied by RagConfig). */
export interface CharacterizerConfig {
	getCompareScope(sectionTipo: string): Promise<string[]>;
	getContextMetadata(sectionTipo: string): Promise<Record<string, string>>;
}

export interface CharacterizerDeps {
	config: CharacterizerConfig;
	objectRetrieval: Pick<ObjectRetrieval, 'findSimilarObjects'>;
	roleReader: RoleReader;
}

export interface CharacterizeOptions {
	topK?: number;
	/** Restrict to these roles; default = the seed section's metadata roles. */
	fields?: string[];
	/** Compare scope override; default = the seed section's compare scope. */
	sectionTipos?: string[];
	mode?: SimilarityMode;
}

export interface Evidence {
	sectionTipo: string;
	sectionId: number;
	value: string;
	weight: number;
	thumbUrl: string | null;
}

export interface CategoricalProposal {
	kind: 'categorical';
	proposal: string;
	confidence: number;
	distribution: Array<{ value: string; share: number }>;
	evidence: Evidence[];
}

export interface DateProposal {
	kind: 'date_range';
	proposal: { earliest: string; latest: string; central: string };
	confidence: number;
	evidence: Evidence[];
}

export type RoleProposal = CategoricalProposal | DateProposal;

export interface CharacterizeResult {
	proposals: Record<string, RoleProposal>;
	neighboursConsidered: number;
}

interface CatItem {
	value: string;
	weight: number;
	sectionTipo: string;
	sectionId: number;
	thumbUrl: string | null;
}
interface DateItem {
	from: number;
	to: number;
	label: string;
	weight: number;
	sectionTipo: string;
	sectionId: number;
	thumbUrl: string | null;
}

export class RagCharacterizer {
	constructor(private readonly deps: CharacterizerDeps) {}

	/** Characterize a seed object by aggregating its neighbours' metadata. */
	async characterize(
		principal: Principal,
		locator: RecordLocator,
		opts: CharacterizeOptions = {},
	): Promise<CharacterizeResult> {
		const out: CharacterizeResult = { proposals: {}, neighboursConsidered: 0 };
		const topK = opts.topK ?? DEFAULT_CHARACTERIZE_TOP_K;
		const sectionTipos =
			opts.sectionTipos ?? (await this.deps.config.getCompareScope(locator.sectionTipo));

		const neighbours = await this.deps.objectRetrieval.findSimilarObjects(principal, locator, {
			sectionTipos,
			mode: opts.mode ?? 'hybrid',
			topK,
		});
		out.neighboursConsidered = neighbours.length;
		if (neighbours.length === 0) return out;

		const roles =
			opts.fields ?? Object.keys(await this.deps.config.getContextMetadata(locator.sectionTipo));

		for (const role of roles) {
			const catItems: CatItem[] = [];
			const dateItems: DateItem[] = [];

			for (const neighbour of neighbours) {
				const weight = neighbourWeight(neighbour);
				const thumbUrl = thumbOf(neighbour);
				// resolve the role THROUGH THE NEIGHBOUR'S OWN context metadata
				const neighbourMeta = await this.deps.config.getContextMetadata(neighbour.sectionTipo);
				const componentTipo = neighbourMeta[role];
				if (componentTipo === undefined || componentTipo === '') continue;

				// Per-component ACL (M3): the neighbour list is ACL-filtered on the IMAGE
				// component, but this role reads a DIFFERENT component (typology / period /
				// material). dd774 grants are per-(section, component), so re-gate each role
				// component and skip neighbours the caller cannot read it on — otherwise the
				// proposal would surface values from a component they are denied.
				const roleLevel = await getPermissions(principal, neighbour.sectionTipo, componentTipo);
				if (roleLevel < 1) continue;

				const read = await this.deps.roleReader(role, componentTipo, {
					sectionTipo: neighbour.sectionTipo,
					sectionId: neighbour.sectionId,
				});
				if (read === null) continue;
				if (read.kind === 'date') {
					dateItems.push({
						...read,
						weight,
						sectionTipo: neighbour.sectionTipo,
						sectionId: neighbour.sectionId,
						thumbUrl,
					});
				} else if (read.value !== '') {
					catItems.push({
						value: read.value,
						weight,
						sectionTipo: neighbour.sectionTipo,
						sectionId: neighbour.sectionId,
						thumbUrl,
					});
				}
			}

			if (dateItems.length > 0) out.proposals[role] = summarizeDates(dateItems);
			else if (catItems.length > 0) out.proposals[role] = aggregateCategorical(catItems);
		}

		return out;
	}
}

/** Weight a neighbour by its retrieval score (rrfScore preferred, then score, then 0). */
function neighbourWeight(c: Candidate): number {
	return c.rrfScore ?? c.score ?? 0;
}

/** A candidate's thumb URL, derived from the stored identity (image vectors carry it). */
function thumbOf(c: Candidate): string | null {
	return storedThumbUrl(c.chunkMeta);
}

/**
 * Similarity-weighted vote over categorical values. Winner = highest total-weight
 * value; confidence = winner's share; distribution = every value's share (desc);
 * evidence = winning-value neighbours (top 8 by weight). Pure + unit-testable.
 */
export function aggregateCategorical(items: CatItem[]): CategoricalProposal {
	const weightByValue = new Map<string, number>();
	let total = 0;
	for (const item of items) {
		const w = Math.max(0, item.weight);
		weightByValue.set(item.value, (weightByValue.get(item.value) ?? 0) + w);
		total += w;
	}
	const sorted = [...weightByValue.entries()].sort((a, b) => b[1] - a[1]);
	const proposal = sorted[0]?.[0] ?? '';
	const winnerWeight = sorted[0]?.[1] ?? 0;
	const confidence = total > 0 ? round4(winnerWeight / total) : 0;
	const distribution = sorted.map(([value, w]) => ({
		value,
		share: total > 0 ? round4(w / total) : 0,
	}));
	return {
		kind: 'categorical',
		proposal,
		confidence,
		distribution,
		evidence: evidenceFor(
			items.filter((it) => it.value === proposal),
			(it) => it.value,
		),
	};
}

/**
 * Earliest…latest range + weighted-central estimate over date items (ordinal
 * seconds). Confidence = 1 - (midpoint spread / total span). Pure + unit-testable.
 */
export function summarizeDates(items: DateItem[]): DateProposal {
	const byFrom = [...items].sort((a, b) => a.from - b.from);
	const earliest = byFrom[0] as DateItem;
	let latest = byFrom[0] as DateItem;
	for (const it of byFrom) if (it.to > latest.to) latest = it;

	const mids = items
		.map((it) => ({ mid: (it.from + it.to) / 2, weight: Math.max(0, it.weight), label: it.label }))
		.sort((a, b) => a.mid - b.mid);
	const totalW = mids.reduce((s, m) => s + m.weight, 0);

	let central = mids[Math.floor(mids.length / 2)] as { mid: number; weight: number; label: string };
	if (totalW > 0) {
		let acc = 0;
		for (const m of mids) {
			acc += m.weight;
			if (acc >= totalW / 2) {
				central = m;
				break;
			}
		}
	}

	const span = Math.max(1, latest.to - earliest.from);
	const midMin = (mids[0] as { mid: number }).mid;
	const midMax = (mids[mids.length - 1] as { mid: number }).mid;
	const confidence = round4(Math.max(0, 1 - (midMax - midMin) / span));

	return {
		kind: 'date_range',
		proposal: { earliest: earliest.label, latest: latest.label, central: central.label },
		confidence,
		evidence: evidenceFor(items, (it) => it.label),
	};
}

/** Top-8-by-weight cited support. */
function evidenceFor<T extends CatItem | DateItem>(
	items: T[],
	getValue: (it: T) => string,
): Evidence[] {
	return items
		.map((it) => ({
			sectionTipo: it.sectionTipo,
			sectionId: it.sectionId,
			value: getValue(it),
			weight: round4(it.weight),
			thumbUrl: it.thumbUrl,
		}))
		.sort((a, b) => b.weight - a.weight)
		.slice(0, 8);
}

function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}
