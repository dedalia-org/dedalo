/**
 * VISION PROPOSALS — the COLD-START tier of "AI proposes, human confirms".
 *
 * `./propose.ts` fills a record's empty criteria by weighted vote over the
 * neighbours that are ALREADY TAGGED. That is the right answer whenever a
 * corpus exists, and no answer at all for the first coin of a new type: nothing
 * similar is catalogued, so nobody can vote. This module is the second source
 * for exactly that case — it SHOWS THE RECORD'S PHOTOGRAPH TO A VISION MODEL and
 * asks which of the profile's own controlled values it depicts.
 *
 * It feeds the SAME acceptance flow (IDENTIFY_SPEC §9: "both later sources feed
 * the same acceptance flow"), so a proposal here carries the same value +
 * confidence + evidence a vote does and renders identically.
 *
 * ── THIS MODULE NEVER WRITES ─────────────────────────────────────────────────
 *
 * Same structural rule as propose.ts, and for a stronger reason: this one talks
 * to a MODEL. Nothing here saves, enqueues or mutates anything — no write module
 * is imported, no SQL is issued, every value produced is a plain object handed
 * back to the caller. `identify_propose.test.ts` scans `src/ai/identify/*.ts`
 * mechanically, so this file is inside that gate by construction.
 *
 * ── THE VOCABULARY IS THE WHOLE DESIGN ───────────────────────────────────────
 *
 * A vision model asked "what is on this coin?" free-associates, and a plausible
 * invented term reaching a curator as a proposal is the failure this feature
 * cannot have: a curator confirms proposals quickly, and a hallucinated deity
 * that looks like a term is indistinguishable from a real one at confirm time.
 *
 * So the model never NAMES anything. For each open criterion the profile's
 * controlled vocabulary is resolved first — for a `same_locator`/`same_term`
 * criterion over a portal, the very list the curator's own picker offers
 * (`relations/datalist.ts` getDatalist: the component's request_config target
 * sections and its fixed filter) — and it is put in the request as an enumerated
 * list of OPAQUE IDS. The model answers with ids. Every answer is then looked up
 * in that same map and ANYTHING NOT IN IT IS DISCARDED, counted, and reported.
 * Two consequences, both deliberate:
 *
 *  - criteria with no closed vocabulary get NO vision proposal at all
 *    (a weight, a date, a free-text legend: `no_controlled_vocabulary`). A
 *    measurement invented from a photograph is not a proposal, it is a number
 *    with a picture next to it;
 *  - a vocabulary larger than the cap is REFUSED, never truncated
 *    (`vocabulary_too_large`). Truncation would silently narrow what the model
 *    was allowed to see and hand back a confident answer from a list nobody
 *    chose — the project's "never silently narrow scope" rule.
 *
 * ── EVERY PROPOSAL SAYS IT CAME FROM A MODEL ─────────────────────────────────
 *
 * Confirming a machine's guess about a photograph is a different act from
 * confirming what seven catalogued coins agree on, and the UI can only tell them
 * apart if the DATA does. Every proposal here carries `source: 'vision_model'`,
 * the model that produced it (id, label, egress class), the model's own stated
 * REASON, and which image it looked at. `votes` is 0 and `distribution` is empty
 * — not an oversight: no record voted, and manufacturing a distribution would
 * dress a single opinion up as a corpus consensus.
 *
 * ── EGRESS ───────────────────────────────────────────────────────────────────
 *
 * A vision model is by definition external unless the institution runs one. The
 * decision is NOT a new policy key: it is the institution's existing statement
 * about object images leaving the host, `DEDALO_RAG_IMAGE_EGRESS_POLICY`, read
 * through `rag/multimodal_config.ts` and judged the same way — the model's
 * declared egress class AND its endpoint ADDRESS (`endpointIsLocal`, which fails
 * closed on anything unparseable). Under `local_only` a non-local model is
 * refused with the operator-facing message naming the key, before any image is
 * read from disk.
 *
 * ── ACCESS CONTROL ───────────────────────────────────────────────────────────
 *
 * The principal is REQUIRED and gates BOTH WHICH RECORD'S IMAGE MAY BE READ and
 * WHICH CRITERIA MAY BE ASKED AT ALL, in three steps:
 *
 *  1. the record scope gate (a denied seed RAISES `IdentifyAccessError` —
 *     match.ts's, same question, same answer);
 *  2. the SHARED per-criterion grant, `core/identify/component_access.ts`
 *     criterionReadableOn — the very call propose.ts's vote and cluster.ts's
 *     consensus make, for the very reason it was lifted into core: a duplicated
 *     security gate is the shape of rule that rots. A criterion whose entry or
 *     leaf component this caller may not read is skipped BEFORE its vocabulary
 *     is resolved, so a denied component contributes NOTHING — no enumeration of
 *     its target section, no line in the prompt, no proposal. It matters here
 *     more than anywhere else: the vocabulary is the component's WHOLE option
 *     list (`getDatalist` is unscoped by design), and under `allow_external` it
 *     would leave the host;
 *  3. the per-component grant on the profile's preview component, because dd774
 *     grants are per-(section, component) and a caller who may open a record may
 *     still not see its photographs.
 *
 * Nothing is transmitted before all three pass.
 *
 * ── DEGRADING HONESTLY ───────────────────────────────────────────────────────
 *
 * No vision model configured, a non-vision model, policy forbidding egress, no
 * photograph, no vocabulary, an unusable answer — each ends as a clean "no
 * proposals from this source" carrying a `declined` reason and a detail string,
 * never a crash and never a fabricated proposal.
 *
 * REQUEST IDENTITY IS A PARAMETER, never an ALS read (isolation rule 2/6): the
 * principal and the data lang are passed in. No module-level state lives here.
 */

import { z } from 'zod';
import { config } from '../../config/config.ts';
import { buildLocatorLookupKey, type Locator } from '../../core/concepts/locator.ts';
import { canonicalizeStoredSectionId } from '../../core/concepts/section_id.ts';
import { DedaloError, wireMessage } from '../../core/errors/index.ts';
import { type ComponentGrant, criterionReadableOn } from '../../core/identify/component_access.ts';
import {
	type AccessFilter,
	type CandidateRecord,
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
import { sniffBytes } from '../../core/media/engine/mime.ts';
import {
	getColumnNameByModel,
	getModelByTipo,
	getPropertiesByTipo,
} from '../../core/ontology/resolver.ts';
import { getDatalist, probeDatalistSize } from '../../core/relations/datalist.ts';
import { getPermissions, type Principal } from '../../core/security/permissions.ts';
import { scopeRecordHits } from '../../core/security/record_scope.ts';
import type { AgentImage, AgentLlmProvider } from '../agent/llm_provider.ts';
import { type CatalogModel, ModelCatalogError, resolveProvider } from '../agent/model_catalog.ts';
import type { Evidence } from '../rag/characterizer.ts';
import { type ExtractedImage, extractImageForEmbedding } from '../rag/image_source.ts';
import {
	endpointIsLocal,
	type ImageEgressPolicy,
	multimodalConfigFromEnv,
} from '../rag/multimodal_config.ts';

/* ─────────────────────────────── the contract ───────────────────────────── */

/**
 * Where a proposal came from. A single member today ON PURPOSE: the field
 * exists so the confirm UI can tell a machine's guess from a corpus consensus,
 * and a boolean would have to be renamed the day OCR lands (IDENTIFY_SPEC §9).
 */
export type ProposalSource = 'vision_model';

/** The model that produced a proposal — named on every one of them. */
export interface VisionModelInfo {
	/** Catalog id (never the provider-native model name). */
	id: string;
	label: string;
	egress: 'external' | 'local';
}

/** Which picture the model actually looked at. */
export interface VisionImageInfo {
	/** The media component the profile declares as the record's photograph. */
	componentTipo: string;
	/** The derivative tier the bytes came from (never a master — image_source). */
	quality: string;
	/** For rendering the evidence next to the proposal. Null when none exists. */
	thumbUrl: string | null;
}

/** One value the profile's criterion is allowed to take. */
export interface VocabularyEntry {
	/**
	 * Identity key — a locator's `buildLocatorLookupKey` on the subsystem's ONE
	 * property set, so a vision proposal and a neighbour vote agree about which
	 * values are "the same value". Never shown to the model.
	 */
	key: string;
	/** What the model (and the curator) reads. */
	label: string;
	/** The structured value an accepted proposal would save. */
	value: CriterionValue;
}

/**
 * "There are more values than may ever be shown" — the answer a resolver gives
 * INSTEAD of a list it should never have built.
 *
 * The cap is a REFUSAL (`vocabulary_too_large`), so materialising the list to
 * discover it is over the cap is paying in full for something thrown away: a
 * thesaurus leaf enumerates every record of its target section with a read each,
 * and the discarded list then evicts the shared datalist cache on its way out.
 * A resolver that can count cheaply says so with this instead.
 */
export interface VocabularyOverflow {
	tooLarge: true;
	/** A LOWER BOUND, not a total — the probe stops counting at the cap. */
	atLeast: number;
}

/**
 * Resolve the closed list of values a criterion may take. Returning an empty
 * list means "this criterion has no controlled vocabulary" and the criterion is
 * skipped — it is never an invitation to let the model speak freely.
 *
 * `limit` is `maxVocabulary + 1`: the caller needs to know whether the list is
 * over the cap, and nothing beyond that. A resolver may stop there and return a
 * {@link VocabularyOverflow} rather than the entries — see its doc.
 */
export type VocabularyResolver = (input: {
	criterion: Criterion;
	profile: IdentificationProfile;
	lang: string;
	limit: number;
}) => Promise<VocabularyEntry[] | VocabularyOverflow>;

/** Reads the record's photograph as transmittable bytes. */
export type ImageExtractor = (input: {
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	maxPx: number;
}) => Promise<ExtractedImage | null>;

/** The chosen vision model, or WHY there is none (never a throw at the seam). */
export type VisionModelChoice =
	| { ok: true; model: CatalogModel; provider: AgentLlmProvider }
	| { ok: false; message: string };

/** Picks the model this run would use. */
export type VisionModelResolver = (modelId: string | undefined) => Promise<VisionModelChoice>;

/**
 * A vision proposal. Structurally a `propose.ts` categorical proposal (same
 * value / confidence / evidence, so both sources render through one component)
 * plus the attribution that makes it legible as a MODEL's answer.
 */
export interface VisionElementProposal {
	kind: 'categorical';
	/** THE ATTRIBUTION. Present on every proposal — see the header. */
	source: ProposalSource;
	model: VisionModelInfo;
	criterionId: string;
	label: string;
	role: Criterion['role'];
	/** Always 0: no record voted for this. Kept so the shapes are one shape. */
	votes: number;
	/** Always empty: a single opinion has no distribution (see the header). */
	distribution: [];
	/** What a curator reads — the vocabulary entry's own label. */
	display: string;
	/** The winning value in the engine's dialect, ready for the confirm flow. */
	value: CriterionValue;
	/** The model's own stated reason. Verbatim, bounded, never rewritten. */
	reason: string;
	/** Which photograph produced it. */
	image: VisionImageInfo;
	/** In the shared shape: the seed record, the reason, the confidence, the thumb. */
	evidence: Evidence[];
	confidence: number;
}

/** Why one criterion produced no vision proposal. Never silent. */
export type VisionSkipReason =
	/** The seed already records it: the feature fills gaps, it does not argue. */
	| 'already_recorded'
	/** `role: 'ignored'` — retained in the profile, not in play. */
	| 'ignored_role'
	/** `mode: 'image_similarity'` — not a value, a comparison. */
	| 'not_votable'
	/**
	 * dd774 says this caller may not read the components this criterion touches.
	 * Nothing about it is resolved, prompted or proposed (see ACCESS CONTROL).
	 */
	| 'component_not_readable'
	/** No closed list of values exists, so a model may not answer it at all. */
	| 'no_controlled_vocabulary'
	/** The list is too long to show the model — refused, never truncated. */
	| 'vocabulary_too_large'
	/** The model offered nothing usable for this criterion. */
	| 'no_model_suggestion';

export interface VisionSkippedCriterion {
	criterionId: string;
	label: string;
	reason: VisionSkipReason;
	detail: string;
}

/** Why the WHOLE source produced nothing. Null when the model actually ran. */
export type VisionDeclineReason =
	| 'no_vision_model'
	| 'model_not_vision_capable'
	| 'egress_forbidden'
	| 'no_open_criteria'
	| 'no_vocabulary'
	| 'no_photograph'
	| 'image_not_readable'
	| 'unsupported_image_format'
	| 'model_error'
	| 'model_returned_nothing';

export interface VisionDecline {
	reason: VisionDeclineReason;
	/** Operator-facing prose: what to change to make this source work. */
	detail: string;
}

/** A model answer that was thrown away. Reported, so hallucination is visible. */
export interface DiscardedSuggestion {
	/** The criterion it claimed to answer ('' when even that was unusable). */
	criterionId: string;
	/** What the model said, bounded. */
	offered: string;
	/** Why it did not survive validation. */
	detail: string;
}

export interface VisionProposeReport {
	seed: CandidateRecord;
	profileId: string;
	/** Constant, and the point: this report is a MODEL's opinion. */
	source: ProposalSource;
	/** The model that ran, or null when none did. */
	model: VisionModelInfo | null;
	/** The photograph that was transmitted, or null when none was. */
	image: VisionImageInfo | null;
	/** In profile order — the curator's ordering, not a confidence ranking. */
	proposals: VisionElementProposal[];
	skipped: VisionSkippedCriterion[];
	/** Non-null ⇒ no proposals, and the reason a curator/operator can act on. */
	declined: VisionDecline | null;
	/** Answers dropped because they were not in the vocabulary shown. */
	discarded: DiscardedSuggestion[];
}

export interface VisionProposeInput {
	profile: IdentificationProfile;
	seed: CandidateRecord;
	/**
	 * WHOSE READ THIS IS. Required: it decides whether this record's photograph
	 * may be read at all, and a photograph is the most disclosing thing the
	 * repository holds. An API action passes the request principal; a background
	 * job passes an explicit system one.
	 */
	principal: Principal;
	/** Catalog model id. Undefined ⇒ the deployment's default entry. */
	modelId?: string;
	/** Data language for labels and value resolution. Explicit, never an ALS read. */
	lang?: string;
	/** Cap on one criterion's vocabulary. Over it, the criterion is refused. */
	maxVocabulary?: number;
	/**
	 * Injectable seams. Production omits them all: they exist so the VOCABULARY
	 * CONSTRAINT, the gates and every degradation path are testable as pure logic
	 * with no network and no corpus.
	 */
	resolveModel?: VisionModelResolver;
	resolveVocabulary?: VocabularyResolver;
	extractImage?: ImageExtractor;
	readValues?: ValueReader;
	filterAccessible?: AccessFilter;
	componentGrant?: ComponentGrant;
	/** The institution's image-egress policy. Default: the configured one. */
	egressPolicy?: ImageEgressPolicy;
	/** Longest side of the transmitted image. Default: the RAG image cap. */
	imageMaxPx?: number;
}

/* ──────────────────────────────── the limits ────────────────────────────── */

/**
 * Longest vocabulary a criterion may show a model. Beyond this the list stops
 * being a constraint (it stops fitting a prompt) — the criterion is refused
 * rather than truncated. Generous enough for a real iconography or denomination
 * list, far short of a whole thesaurus.
 */
export const MAX_VOCABULARY_ENTRIES = 200;

/** Longest reason kept from a model answer — prose, not an essay. */
const MAX_REASON_CHARS = 400;

/**
 * Longest vocabulary label put in the prompt. A label is REPOSITORY CONTENT —
 * anyone with write access on the target section authors it — and it lands in an
 * instruction document, one entry per line. Uncapped it is a budget the prompt
 * does not have; unstripped (see {@link sanitizeForPrompt}) a newline lets it
 * stop being a list entry and start being a rule. Long enough for any real term
 * spelling, far short of a paragraph.
 */
const MAX_PROMPT_LABEL_CHARS = 160;

/** Longest offered value echoed back in `discarded` (bounded log hygiene). */
const MAX_OFFERED_CHARS = 120;

/**
 * Confidence used when the model states none. Deliberately middling: the
 * proposal is an unsupported guess, and inventing a high number would make it
 * outrank a real corpus consensus in any list sorted by confidence.
 */
const DEFAULT_CONFIDENCE = 0.5;

/**
 * Sniffed image kind → the wire media type (llm_provider.ts AgentImage). A
 * closed map: an AVIF or HEIC derivative is refused, not relabeled.
 */
const WIRE_MEDIA_TYPES: Readonly<Record<string, 'image/jpeg' | 'image/png' | 'image/webp'>> = {
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
};

/* ────────────────────────────── the entry point ─────────────────────────── */

/**
 * Propose values for the criteria this record leaves empty, by showing its
 * photograph to a vision model CONSTRAINED to the profile's own vocabulary.
 *
 * Throws {@link IdentifyAccessError} when the principal cannot read the SEED —
 * proposing for a record you may not open is an error, not an empty answer
 * (match.ts and propose.ts make the same call for the same reason). Every other
 * failure is a clean decline.
 */
export async function proposeFromVision(input: VisionProposeInput): Promise<VisionProposeReport> {
	const { profile, seed, principal } = input;
	const lang = input.lang ?? config.lang.dataLangDefault;
	const componentGrant = input.componentGrant ?? getPermissions;
	// ONE path-reader scope per run: every landed record is authorized on its
	// own section inside the reader (path_read.ts ACCESS, P1-3 / SEC-12).
	const pathScope = createPathReadScope({ principal, door: 'identify.vision', componentGrant });
	const readValues: ValueReader =
		input.readValues ??
		((record, path) => readPathValues(record, path, { lang, scope: pathScope }));
	const filterAccessible = input.filterAccessible ?? defaultAccessFilter;
	const resolveModel = input.resolveModel ?? defaultModelResolver;
	const resolveVocabulary = input.resolveVocabulary ?? defaultVocabularyResolver;
	const extractImage = input.extractImage ?? extractImageForEmbedding;
	const maxVocabulary = input.maxVocabulary ?? MAX_VOCABULARY_ENTRIES;

	// The seed's IMAGE is read below, so the record gate runs before anything
	// else happens — including before any model is constructed.
	const [readableSeed] = await filterAccessible(principal, [seed]);
	if (readableSeed === undefined) throw new IdentifyAccessError(seed);

	const base = {
		seed,
		profileId: profile.id,
		source: 'vision_model' as const,
		model: null,
		image: null,
		proposals: [],
		skipped: [] as VisionSkippedCriterion[],
		discarded: [] as DiscardedSuggestion[],
	};

	// 1. THE MODEL. Cheapest disqualifier and the most static one: a deployment
	//    with no vision model never gets as far as touching a record.
	const choice = await resolveModel(input.modelId);
	if (!choice.ok) {
		return { ...base, declined: { reason: 'no_vision_model', detail: choice.message } };
	}
	const { model, provider } = choice;
	const modelInfo: VisionModelInfo = { id: model.id, label: model.label, egress: model.egress };
	if (!model.vision) {
		return {
			...base,
			model: modelInfo,
			declined: {
				reason: 'model_not_vision_capable',
				detail: `model '${model.id}' does not accept images — pick a vision model, or mark it "vision": true in DEDALO_AGENT_MODELS if it is one.`,
			},
		};
	}

	// 2. EGRESS, before a single byte is read from disk.
	const policy = input.egressPolicy ?? multimodalConfigFromEnv().imageEgressPolicy;
	const refusal = visionEgressRefusal(model, policy);
	if (refusal !== null) {
		return { ...base, model: modelInfo, declined: { reason: 'egress_forbidden', detail: refusal } };
	}

	// 3. THE GAP RULE, identical to propose.ts: a criterion the curator already
	//    answered is not up for discussion.
	const skipped: VisionSkippedCriterion[] = [];
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
					'an image-similarity criterion compares pictures, it holds no value a model could name',
				),
			);
			continue;
		}
		// THE SHARED PER-COMPONENT GATE, before this criterion is read, resolved,
		// prompted or proposed. propose.ts and cluster.ts ask the same question of
		// the same paths through the same function — one definition, one place to
		// audit (core/identify/component_access.ts).
		if (!(await criterionReadableOn(criterion, seed, principal, componentGrant))) {
			skipped.push(
				skip(
					criterion,
					'component_not_readable',
					'the caller has no read grant on the components this criterion touches',
				),
			);
			continue;
		}
		if ((await readValues(seed, criterion.path)) !== null) {
			skipped.push(
				skip(criterion, 'already_recorded', 'the record already records a value at this path'),
			);
			continue;
		}
		open.push(criterion);
	}
	if (open.length === 0) {
		return {
			...base,
			model: modelInfo,
			skipped,
			declined: {
				reason: 'no_open_criteria',
				detail:
					'every criterion of this profile is already recorded, ignored, not answerable from a picture, or not readable by this caller',
			},
		};
	}

	// 4. THE PHOTOGRAPH — per-component gated, then read.
	const previewComponent = profile.previewComponent;
	if (previewComponent === null) {
		return {
			...base,
			model: modelInfo,
			skipped,
			declined: {
				reason: 'no_photograph',
				detail: `profile '${profile.id}' declares no previewComponent, so there is no photograph to show a model`,
			},
		};
	}
	if ((await componentGrant(principal, seed.sectionTipo, previewComponent)) < 1) {
		return {
			...base,
			model: modelInfo,
			skipped,
			declined: {
				reason: 'image_not_readable',
				detail: `the caller may not read '${previewComponent}' on '${seed.sectionTipo}'`,
			},
		};
	}
	const extracted = await extractImage({
		componentTipo: previewComponent,
		sectionTipo: seed.sectionTipo,
		sectionId: seed.sectionId,
		maxPx: input.imageMaxPx ?? multimodalConfigFromEnv().imageMaxPx,
	});
	if (extracted === null) {
		return {
			...base,
			model: modelInfo,
			skipped,
			declined: {
				reason: 'no_photograph',
				detail: `no readable derivative of '${previewComponent}' for ${seed.sectionTipo}/${seed.sectionId} — the record has no picture to identify from`,
			},
		};
	}
	const wireImage = toAgentImage(extracted);
	const imageInfo: VisionImageInfo = {
		componentTipo: previewComponent,
		quality: extracted.quality,
		thumbUrl: extracted.thumbUrl,
	};
	if (wireImage === null) {
		return {
			...base,
			model: modelInfo,
			image: imageInfo,
			skipped,
			declined: {
				reason: 'unsupported_image_format',
				detail: `the '${extracted.quality}' derivative of '${previewComponent}' is not a JPEG, PNG or WEBP — the vision wire carries no other raster format`,
			},
		};
	}

	// 5. THE VOCABULARY. Resolved per criterion; a criterion with none is skipped
	//    rather than left to the model's imagination.
	const vocabularies = new Map<string, Map<string, VocabularyEntry>>();
	const prompted: Criterion[] = [];
	for (const criterion of open) {
		// `limit` is the cap PLUS ONE — enough to decide "over the cap", and the
		// most a resolver ever has to produce. The refusal is not worth a 60k-row
		// enumeration (see VocabularyOverflow).
		const resolved = await resolveVocabulary({
			criterion,
			profile,
			lang,
			limit: maxVocabulary + 1,
		});
		if (!Array.isArray(resolved)) {
			skipped.push(
				skip(
					criterion,
					'vocabulary_too_large',
					`at least ${resolved.atLeast} candidate values exceed the ${maxVocabulary} shown to a model; refused rather than truncated to a list nobody chose`,
				),
			);
			continue;
		}
		const usable = resolved.filter((entry) => entry.key !== '' && entry.label.trim() !== '');
		if (usable.length === 0) {
			skipped.push(
				skip(
					criterion,
					'no_controlled_vocabulary',
					'this criterion takes no closed list of values (a measurement, a date or free text), and a model may not invent one from a picture',
				),
			);
			continue;
		}
		if (usable.length > maxVocabulary) {
			skipped.push(
				skip(
					criterion,
					'vocabulary_too_large',
					`at least ${usable.length} candidate values exceed the ${maxVocabulary} shown to a model; refused rather than truncated to a list nobody chose`,
				),
			);
			continue;
		}
		vocabularies.set(criterion.id, indexVocabulary(usable));
		prompted.push(criterion);
	}
	if (prompted.length === 0) {
		return {
			...base,
			model: modelInfo,
			image: imageInfo,
			skipped,
			declined: {
				reason: 'no_vocabulary',
				detail:
					'no open criterion of this profile has a controlled vocabulary to constrain a model to',
			},
		};
	}

	// 6. ASK. One turn, no tools: this is a classification, not an agent loop.
	const request = buildVisionRequest(prompted, vocabularies, wireImage);
	let answerText: string;
	try {
		const turn = await provider.createTurn(request);
		answerText = turn.text;
	} catch (error) {
		// The exception text is a provider/transport message (a fetch failure
		// naming the endpoint, an ENOENT naming a media path): it is for the log
		// above. `detail` reaches an ok:true payload verbatim through
		// dd_identify_api (`declined.detail`), at read level 1, where no
		// disclosure ladder applies — so it is a DELIBERATE sentence (SEC-18).
		console.warn(`[identify/vision] model '${model.id}' failed: ${String(error)}`);
		return {
			...base,
			model: modelInfo,
			image: imageInfo,
			skipped,
			declined: {
				reason: 'model_error',
				detail: `model '${model.id}' did not answer; the server log records why`,
			},
		};
	}

	const parsed = parseSuggestions(answerText);
	if (parsed === null) {
		return {
			...base,
			model: modelInfo,
			image: imageInfo,
			skipped,
			declined: {
				reason: 'model_returned_nothing',
				detail: `model '${model.id}' returned no usable answer (expected a JSON array of suggestions)`,
			},
		};
	}

	// 7. VALIDATE AGAINST THE VOCABULARY. This is the anti-hallucination gate:
	//    an answer that is not in the list the model was shown never becomes a
	//    proposal — it is discarded and counted.
	const discarded: DiscardedSuggestion[] = [];
	const accepted = new Map<string, VisionElementProposal>();
	for (const suggestion of parsed) {
		const criterion = prompted.find((item) => item.id === suggestion.criterion_id);
		if (criterion === undefined) {
			discarded.push({
				criterionId: '',
				offered: bounded(`${suggestion.criterion_id}=${suggestion.value_id}`, MAX_OFFERED_CHARS),
				detail: 'names a criterion that was not asked about',
			});
			continue;
		}
		const vocabulary = vocabularies.get(criterion.id);
		const entry =
			vocabulary === undefined ? undefined : lookupEntry(vocabulary, suggestion.value_id);
		if (entry === AMBIGUOUS) {
			// Two vocabulary entries carry that label — homonymous thesaurus terms
			// are ordinary, and they render IDENTICALLY to the curator who confirms.
			// Picking the first would write a permanently wrong locator that nothing
			// downstream can show is wrong. Same posture as the duplicate-answer
			// branch below: this module does not choose between readings.
			discarded.push({
				criterionId: criterion.id,
				offered: bounded(suggestion.value_id, MAX_OFFERED_CHARS),
				detail: `names more than one of the values offered for '${criterion.label}' — ambiguous, so nothing is proposed`,
			});
			continue;
		}
		if (entry === undefined) {
			// The whole point of the module: a value outside the controlled list is
			// a hallucination whatever it looks like, and never reaches a curator.
			discarded.push({
				criterionId: criterion.id,
				offered: bounded(suggestion.value_id, MAX_OFFERED_CHARS),
				detail: `not one of the values offered for '${criterion.label}'`,
			});
			continue;
		}
		if (accepted.has(criterion.id)) {
			// One proposal per criterion: a second answer is the model arguing with
			// itself, and picking a winner between two ungrounded guesses is not
			// something this module may do.
			discarded.push({
				criterionId: criterion.id,
				offered: bounded(entry.label, MAX_OFFERED_CHARS),
				detail: `a second answer for '${criterion.label}' — only the first is kept`,
			});
			continue;
		}
		const confidence = clampConfidence(suggestion.confidence);
		// UNTRUSTED, and the one string a curator is asked to weigh. It is a
		// model's prose — quite possibly repeating text the model was shown — so it
		// is flattened to one bounded line rather than trusted as structure
		// (sanitizeForPrompt's second population).
		const reason = sanitizeForPrompt(suggestion.reason ?? '', MAX_REASON_CHARS);
		accepted.set(criterion.id, {
			kind: 'categorical',
			source: 'vision_model',
			model: modelInfo,
			criterionId: criterion.id,
			label: criterion.label,
			role: criterion.role,
			votes: 0,
			distribution: [],
			display: entry.label,
			value: entry.value,
			reason,
			image: imageInfo,
			confidence,
			// The shared evidence shape, filled honestly: the record whose picture
			// was read, the model's own reason as the quoted value, its confidence
			// as the weight, and the thumb of the image it looked at.
			evidence: [
				{
					sectionTipo: seed.sectionTipo,
					sectionId: seed.sectionId,
					value: reason === '' ? entry.label : reason,
					weight: confidence,
					thumbUrl: extracted.thumbUrl,
				},
			],
		});
	}

	// Profile order, so both sources list in the curator's own ordering.
	const proposals: VisionElementProposal[] = [];
	for (const criterion of prompted) {
		const proposal = accepted.get(criterion.id);
		if (proposal === undefined) {
			skipped.push(
				skip(
					criterion,
					'no_model_suggestion',
					'the model offered nothing from this criterion’s controlled vocabulary',
				),
			);
			continue;
		}
		proposals.push(proposal);
	}

	return {
		seed,
		profileId: profile.id,
		source: 'vision_model',
		model: modelInfo,
		image: imageInfo,
		proposals,
		skipped,
		declined: null,
		discarded,
	};
}

/* ─────────────────────────────── the egress gate ────────────────────────── */

/**
 * The operator-facing refusal when this model would send the record's
 * photograph off the host under a `local_only` policy, or null when it may run.
 *
 * The model's declared egress class is necessary but NOT sufficient, exactly as
 * `multimodal_config.assertEgressAllowed` argues: a deployer can label an
 * openai_compatible entry "local" while pointing it at a vendor URL, and the
 * address is what actually decides. `endpointIsLocal` fails closed on anything
 * it cannot parse.
 */
export function visionEgressRefusal(
	model: Pick<CatalogModel, 'id' | 'egress' | 'endpoint' | 'provider'>,
	policy: ImageEgressPolicy,
): string | null {
	if (policy === 'allow_external') return null;
	const addressLocal = endpointIsLocal(model.endpoint ?? '');
	if (model.egress === 'local' && addressLocal) return null;
	const reason =
		model.egress === 'external'
			? `model '${model.id}' is declared egress 'external'`
			: `endpoint '${model.endpoint ?? ''}' is not on this host or its private network`;
	return `Showing this record's photograph to model '${model.id}' would send it off this host (${reason}), but DEDALO_RAG_IMAGE_EGRESS_POLICY is 'local_only'. Set it to allow_external to permit it, or configure a vision model you run yourself.`;
}

/* ──────────────────────────── the model + the wire ──────────────────────── */

/**
 * The production model seam: the deployment catalog. A catalog problem (none
 * configured, malformed, unknown id, missing key) is a DECLINE with the
 * catalog's own WIRE sentence, not a throw — this source is optional by design.
 *
 * `message` here IS wire text: dd_identify_api copies `declined.detail` into
 * an ok:true `sources[]` at read level 1 (SEC-18). So a DedaloError speaks
 * only through `wireMessage` (registry English / vetted publicMessage) — its
 * `.message` is the log-only field, and a provider constructor names the
 * api_key_env it could not read there, the very field `publicModelList` hides.
 * Anything else merely happened: a deliberate sentence, the text to the log.
 */
const NO_USABLE_MODEL_DETAIL = 'no usable vision model; the server log records why';
const defaultModelResolver: VisionModelResolver = async (modelId) => {
	try {
		const { model, provider } = resolveProvider(modelId);
		return { ok: true, model, provider };
	} catch (error) {
		if (error instanceof ModelCatalogError) return { ok: false, message: wireMessage(error) };
		console.warn(`[identify/vision] no usable vision model: ${String(error)}`);
		return {
			ok: false,
			message: error instanceof DedaloError ? wireMessage(error) : NO_USABLE_MODEL_DETAIL,
		};
	}
};

/**
 * The extracted derivative as a wire image, or null when the format is not one
 * the vision wire carries. The media type is SNIFFED from the bytes (the same
 * magic-byte sniffer the upload path uses) rather than assumed: `image_source`
 * returns the stored derivative untouched when it is already small enough, and
 * installs store their tiers as jpg, webp or avif depending on when they were
 * generated. Declaring an avif "image/jpeg" would be a lie the provider
 * discovers, in production, as an opaque 400.
 */
function toAgentImage(extracted: ExtractedImage): AgentImage | null {
	const head = Buffer.from(extracted.base64.slice(0, 64), 'base64');
	const sniffed = sniffBytes(new Uint8Array(head));
	const mediaType = sniffed === null ? undefined : WIRE_MEDIA_TYPES[sniffed.kind];
	if (mediaType === undefined) return null;
	// base64, never {url}: media URLs are protection-cookie gated, so a URL a
	// provider fetched would 404 (or, worse, would have to be un-gated).
	return { media_type: mediaType, data_base64: extracted.base64 };
}

/* ──────────────────────────────── the request ───────────────────────────── */

const SYSTEM_PROMPT = [
	'You identify what is depicted in a photograph of a museum object, for a curator who will review every answer.',
	'',
	'RULES, in order of importance:',
	'1. You may ONLY answer with the value ids listed for each criterion. Never invent a value, never answer with a value you were not shown, never answer in your own words.',
	'2. If the photograph does not clearly show something from a criterion’s list, OMIT that criterion. An omission costs nothing; a wrong answer costs a curator their trust in this tool.',
	'3. Judge only what is visible in the picture. Do not infer from what such objects usually carry.',
	'',
	'Answer with a JSON array and nothing else:',
	'[{"criterion_id": "<id>", "value_id": "<id from that criterion\'s list>", "reason": "<what in the picture shows it, one sentence>", "confidence": <0..1>}]',
	'An empty array [] is a perfectly good answer.',
].join('\n');

/** The one-turn request: the enumerated vocabularies plus the photograph. */
function buildVisionRequest(
	criteria: readonly Criterion[],
	vocabularies: ReadonlyMap<string, ReadonlyMap<string, VocabularyEntry>>,
	image: AgentImage,
): {
	system: string;
	tools: [];
	transcript: [{ role: 'user'; text: string; images: AgentImage[] }];
} {
	const lines: string[] = [
		'Identify the object in the attached photograph against these criteria.',
		'',
	];
	for (const criterion of criteria) {
		const vocabulary = vocabularies.get(criterion.id);
		if (vocabulary === undefined) continue;
		lines.push(
			`criterion_id: ${sanitizeForPrompt(criterion.id, MAX_PROMPT_LABEL_CHARS)}  (${sanitizeForPrompt(criterion.label, MAX_PROMPT_LABEL_CHARS)})`,
		);
		lines.push('  allowed value_id → meaning:');
		for (const [key, entry] of vocabulary) {
			// The KEY is what the model echoes; it is the vocabulary's own identity
			// key, so a returned id is looked up rather than parsed. The LABEL beside
			// it is repository content and is sanitised as such — one line, bounded.
			lines.push(
				`    ${sanitizeForPrompt(key, MAX_PROMPT_LABEL_CHARS)} → ${sanitizeForPrompt(entry.label, MAX_PROMPT_LABEL_CHARS)}`,
			);
		}
		lines.push('');
	}
	return {
		system: SYSTEM_PROMPT,
		tools: [],
		transcript: [{ role: 'user', text: lines.join('\n'), images: [image] }],
	};
}

/* ───────────────────────────── the answer, validated ────────────────────── */

const suggestionSchema = z.object({
	criterion_id: z.string().max(200),
	value_id: z.string().max(500),
	reason: z.string().max(4000).optional(),
	confidence: z.number().optional(),
});

type Suggestion = z.infer<typeof suggestionSchema>;

/**
 * The model's answer as suggestions, or null when there is nothing usable.
 *
 * Tolerant about the ENVELOPE (a fenced block, a sentence before the array, an
 * object wrapping a `suggestions` array) and strict about the CONTENT: an entry
 * that is not `{criterion_id, value_id}` is dropped here, and the values are
 * checked against the vocabulary by the caller. Being forgiving about prose
 * costs nothing; being forgiving about values would defeat the module.
 */
export function parseSuggestions(text: string): Suggestion[] | null {
	const decoded = decodeJsonPayload(text);
	if (decoded === null) return null;
	const array = Array.isArray(decoded)
		? decoded
		: ((decoded as { suggestions?: unknown }).suggestions ?? null);
	if (!Array.isArray(array)) return null;
	const suggestions: Suggestion[] = [];
	for (const entry of array) {
		const parsed = suggestionSchema.safeParse(entry);
		if (parsed.success) suggestions.push(parsed.data);
	}
	return suggestions;
}

/** First JSON value in the text — fenced, bare, or embedded in prose. */
function decodeJsonPayload(text: string): unknown {
	const unfenced = text.replace(/```(?:json)?/gi, '').trim();
	const direct = tryJson(unfenced);
	if (direct !== undefined) return direct;
	for (const [open, close] of [
		['[', ']'],
		['{', '}'],
	] as const) {
		const start = unfenced.indexOf(open);
		const end = unfenced.lastIndexOf(close);
		if (start === -1 || end <= start) continue;
		const slice = tryJson(unfenced.slice(start, end + 1));
		if (slice !== undefined) return slice;
	}
	return null;
}

function tryJson(candidate: string): unknown {
	if (candidate === '') return undefined;
	try {
		return JSON.parse(candidate);
	} catch {
		return undefined;
	}
}

/** "That label names more than one entry" — never a value, never a proposal. */
const AMBIGUOUS = Symbol('ambiguous vocabulary label');

/**
 * Look one answer up in the criterion's vocabulary: by the id the model was
 * shown, or — because a model that reads a list sometimes answers with the LABEL
 * — by an exact normalized label match. Both are lookups INTO the controlled
 * list (`normalizeText` is the matcher's own, so "athéna" and "Athena" are one
 * value here exactly as they are one value everywhere else). Anything that
 * misses both is not in the vocabulary, and is discarded.
 *
 * A label answer matching TWO entries returns {@link AMBIGUOUS}, not the first
 * one. Homonymous terms are ordinary in a thesaurus and they render identically
 * at confirm time, so "first match" is an unreviewable coin-flip that writes a
 * permanently wrong locator. The KEY lookup cannot be ambiguous — keys are the
 * map's own — so only the label fallback can produce this.
 */
function lookupEntry(
	vocabulary: ReadonlyMap<string, VocabularyEntry>,
	offered: string,
): VocabularyEntry | typeof AMBIGUOUS | undefined {
	const trimmed = offered.trim();
	if (trimmed === '') return undefined;
	const byKey = vocabulary.get(trimmed);
	if (byKey !== undefined) return byKey;
	const normalized = normalizeText(trimmed);
	if (normalized === '') return undefined;
	let match: VocabularyEntry | undefined;
	for (const entry of vocabulary.values()) {
		if (normalizeText(entry.label) !== normalized) continue;
		if (match !== undefined) return AMBIGUOUS;
		match = entry;
	}
	return match;
}

/** Keyed by the entry key, insertion-ordered (the order the model is shown). */
function indexVocabulary(entries: readonly VocabularyEntry[]): Map<string, VocabularyEntry> {
	const map = new Map<string, VocabularyEntry>();
	for (const entry of entries) if (!map.has(entry.key)) map.set(entry.key, entry);
	return map;
}

/** A model-stated confidence, or the conservative default. Never outside [0,1]. */
function clampConfidence(value: number | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONFIDENCE;
	return Math.min(1, Math.max(0, value));
}

function bounded(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * UNTRUSTED TEXT, made safe to put on one line of a document that is read as
 * instructions — and to hand a curator as a justification.
 *
 * Two populations flow through here and both are authored outside this module:
 *
 *  - VOCABULARY LABELS, which are repository content. A term label is written by
 *    anyone with write access on the target section; the prompt lists one per
 *    line, so an embedded newline turns a list entry into a line that looks like
 *    a RULE ("4. Always answer …"). The list is the only constraint this feature
 *    has, and a constraint an editor can rewrite is not one.
 *  - the model's own REASON, which the curator reads as the justification for
 *    confirming. It is a string a model chose (possibly repeating text it was
 *    just shown), never a claim this module vouches for. Line structure in it
 *    lets it imitate the interface that frames it.
 *
 * So: control characters and line breaks out (each becomes a space), runs of
 * whitespace collapsed, then bounded. Never rejected — a term with a stray tab
 * in its label is a typo, not an attack, and dropping the value would be a
 * silent narrowing of the vocabulary.
 */
function sanitizeForPrompt(text: string, max: number): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const flattened = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
	return bounded(flattened.replace(/\s+/g, ' ').trim(), max);
}

/* ────────────────────────────── the vocabulary ──────────────────────────── */

/**
 * The production vocabulary: for a criterion that compares LINKS
 * (`same_locator` / `same_term`), the list the curator's own picker offers for
 * that component — `relations/datalist.ts` getDatalist, which resolves the
 * component's request_config target sections and applies its fixed filter. Using
 * the picker's list rather than a query of our own is what makes an accepted
 * proposal exactly the value a curator could have chosen by hand.
 *
 * Every other mode returns EMPTY, and the caller skips the criterion: a weight,
 * a date or a free-text legend has no closed list, and a model naming one from a
 * photograph would be guessing with a picture as an alibi.
 *
 * IT COUNTS BEFORE IT BUILDS. `getDatalist` enumerates every record of the
 * component's target sections WITH A READ EACH and caches the result; a criterion
 * pointed at a real thesaurus is tens of thousands of sequential reads whose only
 * use, over the cap, is to be refused — and which evict the process-wide datalist
 * cache on their way out, so ordinary reads pay for a refusal too. So the size is
 * probed first (`probeDatalistSize`, bounded by `limit`), and a list over the cap
 * is reported as {@link VocabularyOverflow} without ever being materialised.
 *
 * Never throws: an unresolvable component is "no vocabulary", warned once.
 */
export const defaultVocabularyResolver: VocabularyResolver = async ({ criterion, lang, limit }) => {
	if (criterion.mode !== 'same_locator' && criterion.mode !== 'same_term') return [];
	const leaf = criterion.path[criterion.path.length - 1];
	if (leaf === undefined) return [];
	try {
		const model = await getModelByTipo(leaf.component_tipo);
		if (model === null) return [];
		if (getColumnNameByModel(model) !== 'relation') {
			// A criterion that compares locators over a component that stores none is
			// a mis-authored profile, not a vocabulary this module may improvise.
			return [];
		}
		const properties = await getPropertiesByTipo(leaf.component_tipo);
		// No owner RECORD: the vocabulary of a criterion path, for any record.
		const owner = { section_tipo: leaf.section_tipo, section_id: null };
		const size = await probeDatalistSize(
			leaf.component_tipo,
			properties ?? null,
			owner,
			lang,
			limit,
		);
		// `limit` is the cap PLUS ONE, so reaching it IS the overflow.
		if (size >= limit) return { tooLarge: true, atLeast: size };
		const items = await getDatalist(leaf.component_tipo, properties ?? null, owner, lang);
		const entries: VocabularyEntry[] = [];
		for (const item of items) {
			const label = item.label.trim();
			if (label === '') continue; // an unlabeled option is unpickable by a model
			const locator = toValueLocator(item.value);
			entries.push({
				key: buildLocatorLookupKey(locator as Locator, IDENTITY_LOCATOR_PROPERTIES),
				label,
				value: { kind: 'locators', locators: [locator] },
			});
		}
		return entries;
	} catch (error) {
		console.warn(
			`[identify/vision] no vocabulary for criterion '${criterion.id}' (${leaf.component_tipo}): ${String(error)}`,
		);
		return [];
	}
};

/**
 * A datalist option as a stored-shaped locator. KEPT as a union: a criterion
 * may target an EXTERNAL-service section, whose datalist options carry the
 * remote id verbatim ('001338683', 'Q42') — never an int address. Convertible
 * ids are canonicalized below so the value handed to the confirm flow looks
 * like what the column holds (`buildLocatorLookupKey` matches either way).
 */
function toValueLocator(value: {
	section_tipo: string;
	section_id: number | string;
}): ValueLocator {
	return {
		section_tipo: value.section_tipo,
		// The datalist already emits the canonical int; this stays as the ONE
		// normalization point for any other caller (and keeps an external
		// remote id verbatim, which the old Number() sniff did too)
		// — WC-2026-08-10-section-id-int-canonical.
		section_id: canonicalizeStoredSectionId(value.section_id) as number | string,
	};
}

/* ──────────────────────────────── the gates ─────────────────────────────── */

/**
 * The per-record half of the ACL, through the engine's shared scope gate — the
 * same call match.ts and propose.ts make, for the same reason.
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

function skip(
	criterion: Criterion,
	reason: VisionSkipReason,
	detail: string,
): VisionSkippedCriterion {
	return { criterionId: criterion.id, label: criterion.label, reason, detail };
}
