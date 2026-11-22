/**
 * dd_identify_api — the object-identification engine over the normal API.
 *
 * FOUR actions:
 *
 *   find_matches       { section_tipo, section_id, limit? }
 *     → { seed:{…,thumb_url}, profile:{id,label}, results:[{…,thumb_url}],
 *         more_available, blind_criteria, restricted_criteria }
 *     "What else is like THIS RECORD?" — structural agreement over a profile.
 *
 *   identify_by_image  { image, section_tipo?, limit? }
 *     → { model, scope, results:[{…, similarity, types:[…]}], warnings }
 *     "What IS this?" for material with NO record yet: a photograph the curator
 *     just took, matched against the image index. See its own header below.
 *
 *   get_proposals      { section_tipo, section_id, source?, limit?, model_id? }
 *     → { seed, profile, sources:[…], proposals:[{…, provenance, target}] }
 *     "What SHOULD this record say?" — the read half of "AI proposes, human
 *     confirms", over BOTH proposal sources. The vision source is OPT-IN (it
 *     costs money and may egress); see its own header below.
 *
 *   resolve_type_link  { section_tipo, records?, check_type_id? }
 *     → { type_section:{…}, links:[…], existing_types:[…], type_record:{…}|null }
 *     "Where would a cluster be PROMOTED to?" — the component that links an
 *     object to its canonical Type (derived from the profile, never guessed),
 *     what this caller may write, and the Types the given members already carry.
 *     A READ: the attach itself is the ordinary component save, from the client.
 *
 * Registered in the static ACTION_REGISTRY (core/api/dispatch.ts), so the
 * class+action allowlist admits exactly this and nothing else; the dispatcher
 * has already required a session and verified CSRF before a handler here runs.
 *
 * ── WHAT THIS HANDLER IS RESPONSIBLE FOR ─────────────────────────────────────
 *
 * IDENTITY. `findMatches` takes a REQUIRED principal because an absent one means
 * "internal search, skip the projects filter" to the SQL assembler — see its
 * MatchInput.principal note. This handler passes the request's seeded principal
 * (`requirePrincipal`) and nothing else: it is the ACL gate, not a parameter.
 *
 * DECLINING is CODED, not prose. Three ordinary situations are answers, not
 * engine faults — the section has no profile, its profile is malformed, the
 * caller may not read the record — and each THROWS its registered `identify.*`
 * code (envelope v2, ERRORS_SPEC §4), which the dispatch chokepoint converts to
 * `{ok:false, error:{code, …}}` with the registry status. That is the only wire
 * change: a decline is still an ANSWER the client can act on, never a 500. The
 * engine's own contract is preserved — a malformed profile is still LOUD
 * (`identify.invalid_profile` is a PUBLIC-disclosure code, so the parser's exact
 * message still reaches the curator), and an unreadable seed is refused rather
 * than answered with "no matches", which would be a worse answer than a refusal.
 *
 * ORDER MATTERS, and a THROW does not change it. The section read grant is
 * still checked BEFORE the profile is loaded, so a caller with no access to a
 * section cannot use the decline codes to learn whether it has an
 * identification descriptor (there is no oracle for descriptor existence).
 *
 * EXPLANATIONS ARE NOT OPTIONAL. Every result carries its per-criterion
 * `outcomes`, and the response carries `blind_criteria` (criteria the SEED has no
 * value for, so they discriminated nothing) and `restricted_criteria` (criteria
 * THIS CALLER may not read, so the score is computed without them and is
 * partial). A bare score is either ignored or trusted far past what it means —
 * and a partial one that does not say it is partial is worse than a bare one.
 *
 * PICTURES ARE RESOLVED HERE, not by the client. Identification is a visual task,
 * and only the PROFILE knows which media component stands for the object (the
 * candidate's section is arbitrary). `thumb_url` is therefore built server-side
 * through the media subsystem's own path grammar, and is null unless the file
 * exists — a URL to an ungenerated derivative is a broken image in every row.
 *
 * WIRE SHAPE: snake_case, like every other API payload in this engine
 * (`section_tipo`/`section_id`), converted at this boundary from the subsystem's
 * TS-side camelCase.
 *
 * THE VISION SPEND IS A GRANTED TOOL (closure Step 3, TOOLS-4's grant half;
 * WC-2026-10-01-identify-vision-grant). A model call is a resource with an
 * owner: `get_proposals` with the vision source, and `identify_by_image` on an
 * EXTERNAL multimodal provider, require the caller's profile to authorize
 * `tool_identify` (the same dd1067 grant the tool itself is opened with; no
 * admin flag — `assertToolGranted`). Refused as `tool.not_authorized` BEFORE
 * the profile is loaded, the image embedded or any model is called. The
 * structural halves (find_matches, the neighbour vote, a local encoder) spend
 * nothing and stay ungranted. The per-user budget is the other half of TOOLS-4
 * and lands with its ledger.
 */

/** The tool whose grant authorizes a vision-model spend. */
export const VISION_SPEND_TOOL = 'tool_identify';

import {
	type ElementProposal,
	type ProposeInput,
	type ProposeReport,
	proposeElements,
} from '../../../ai/identify/propose.ts';
import {
	proposeFromVision,
	type VisionElementProposal,
	type VisionProposeInput,
	type VisionProposeReport,
} from '../../../ai/identify/vision.ts';
import { collapseToRecords, tagScore } from '../../../ai/rag/fusion.ts';
import { storedThumbUrl } from '../../../ai/rag/image_source.ts';
import {
	buildMultimodalProvider,
	isMediaEnabled,
	type MultimodalRuntimeConfig,
	multimodalConfigFromEnv,
} from '../../../ai/rag/multimodal_config.ts';
import type { MultimodalEmbeddingProvider } from '../../../ai/rag/multimodal_embedding_provider.ts';
import { isRagEnabled } from '../../../ai/rag/rag_enabled.ts';
import { aclFilterCandidates } from '../../../ai/rag/retrieval.ts';
import type { Candidate } from '../../../ai/rag/types.ts';
import { queryDense } from '../../../ai/rag/vector_store.ts';
import { envSnapshot } from '../../../config/env.ts';
import { isValidTipo } from '../../concepts/ontology.ts';
import type { Rqo } from '../../concepts/rqo.ts';
import { readExistingSectionIds } from '../../db/matrix.ts';
import { runWithRecordMemo } from '../../db/record_memo.ts';
import { ok, wireMessage } from '../../errors/convert.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import type { ErrorCode } from '../../errors/registry.ts';
import {
	DEFAULT_POOL_CAP,
	findMatches,
	IdentifyAccessError,
	type MatchInput,
	type MatchReport,
} from '../../identify/match.ts';
import { readPathValues } from '../../identify/path_read.ts';
import { type PreviewRecord, previewKey, resolvePreviewThumbs } from '../../identify/preview.ts';
import { ProfileError } from '../../identify/profile.ts';
import { loadProfileForSection } from '../../identify/profile_source.ts';
import type {
	Criterion,
	CriterionPathStep,
	CriterionValue,
	IdentificationProfile,
	MatchResult,
} from '../../identify/types.ts';
import { sniffBytes } from '../../media/engine/mime.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../../ontology/resolver.ts';
import { getSectionMapValue } from '../../ontology/section_map.ts';
import { currentDataLang } from '../../resolve/request_lang.ts';
import { chargeAiSpend } from '../../security/ai_spend.ts';
import { getPermissions, type Principal } from '../../security/permissions.ts';
import { doorComponentAllowed, readDoorNotices } from '../../security/read_door.ts';
import { scopeRecordHits } from '../../security/record_scope.ts';
import { assertToolGranted } from '../../tools/security.ts';
import { type ActionHandler, requirePrincipal } from '../handler_context.ts';
import type { ApiResult } from '../response.ts';

/**
 * What a FAILED identify source may say on the wire (P2-8 / SEC-17).
 *
 * These two sites emitted `error.message` inside an `ok:true` payload — where
 * the disclosure ladder in `toErrorBody` does not reach, because nothing here
 * is an error envelope. The text is whatever threw: Postgres error output, a
 * filesystem message with an absolute path, an embedding-service URL.
 *
 * A DedaloError is the engine SPEAKING DELIBERATELY — but only its WIRE
 * sentence (`wireMessage`: registry English or the vetted publicMessage) was
 * written to be read; `.message` is the log-only field. Anything else merely
 * happened, so the caller is told the source failed and the detail goes to the
 * log, which is where a diagnosis belongs.
 */
function declineDetail(error: unknown): string {
	console.warn('[identify] source failed:', error);
	// Deliberate — but only its WIRE sentence: `.message` is the log-only field
	// (a provider constructor names its api_key_env there).
	if (error instanceof DedaloError) return wireMessage(error);
	return 'the source failed; the server log records why';
}

/** Most results a curator can ask for in one call. */
export const MAX_LIMIT = 50;
/** Results returned when the request names no limit. */
export const DEFAULT_LIMIT = 20;

/**
 * The seams this handler is built on. Production uses {@link defaultIdentifyApiDeps};
 * tests inject fakes so the DECLINE and ACL behaviour can be exercised without
 * writing an ontology descriptor to dd_ontology (which the engine's test rules
 * forbid) — the same posture match.ts takes with its reader/pool seams.
 */
export interface IdentifyApiDeps {
	/** Resolve the section's profile (null = the section declares none). */
	loadProfile(sectionTipo: string): Promise<IdentificationProfile | null>;
	/** Run the engine. */
	runMatches(input: MatchInput): Promise<MatchReport>;
	/** Whether this principal may read the section at all. */
	canReadSection(principal: Principal, sectionTipo: string): Promise<boolean>;
	/**
	 * Per-(section, component) read level — `getPermissions` in production.
	 * Optional so the existing fakes keep their shape: absent = the real grant.
	 * It gates the PREVIEW THUMB (P1-3 / SEC-10): the profile's
	 * `previewComponent` is a media component of the candidate's section, and a
	 * thumb URL of it is a read of it — `vision.ts` gates that exact field, and
	 * this door did not.
	 */
	componentGrant?(
		principal: Principal,
		sectionTipo: string,
		componentTipo: string,
	): Promise<number>;
	/**
	 * Thumb URLs for the records the answer names, keyed `${section_tipo}_${section_id}`.
	 * Optional: production omits it and gets {@link resolvePreviewThumbs}. It takes
	 * only records the engine has ALREADY gated — the record scope by the engine,
	 * the previewComponent's grant by this handler — so it is a renderer's
	 * convenience, never a second access path: a record whose thumb the caller
	 * may not read is NEVER handed to it.
	 */
	resolveThumbs?(
		previewComponent: string | null,
		records: readonly PreviewRecord[],
	): Promise<Map<string, string>>;
}

export function defaultIdentifyApiDeps(): IdentifyApiDeps {
	return {
		loadProfile: (sectionTipo) => loadProfileForSection(sectionTipo),
		runMatches: findMatches,
		canReadSection: async (principal, sectionTipo) =>
			(await getPermissions(principal, sectionTipo, sectionTipo)) >= 1,
		componentGrant: getPermissions,
		resolveThumbs: resolvePreviewThumbs,
	};
}

/**
 * The one success door of this class (ERRORS_SPEC §4 — handlers return `ok`).
 * A door that NARROWED (a thumb withheld, a hit dropped for a section grant)
 * says so with ONE `perm.out_of_scope` notice — never a count (read_door.ts).
 */
function envelope(data: unknown, requestId: string): ApiResult {
	const notices = readDoorNotices();
	return {
		status: 200,
		body: ok(data, { requestId, ...(notices === undefined ? {} : { notices }) }),
	};
}

/**
 * The DECLINE — a throw, never a body, typed `never` so a call site cannot
 * forget to relay it. `publicMessage` is the operator-authored sentence; it
 * reaches the wire only for the public-disclosure `identify.*` codes (the
 * registry decides, not the call site).
 */
function decline(code: ErrorCode, publicMessage?: string, cause?: unknown): never {
	throw new DedaloError(code, {
		...(publicMessage === undefined ? {} : { publicMessage }),
		...(cause === undefined ? {} : { cause }),
	});
}

/** Clamp a client-supplied limit to [1, MAX_LIMIT]; anything unusable → the default. */
function clampLimit(value: unknown): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(parsed)));
}

/** The seed coordinates, or null when they are missing/unusable. */
function readSeed(
	options: Record<string, unknown> | undefined,
): { sectionTipo: string; sectionId: number } | null {
	const raw = options?.section_tipo;
	const sectionTipo = typeof raw === 'string' ? raw.trim() : '';
	const rawId = options?.section_id;
	const sectionId = typeof rawId === 'number' ? rawId : Number(rawId);
	if (sectionTipo === '' || !isValidTipo(sectionTipo)) return null;
	if (!Number.isFinite(sectionId) || sectionId < 1) return null;
	return { sectionTipo, sectionId: Math.trunc(sectionId) };
}

/**
 * MatchResult → the wire shape (the outcomes breakdown rides along, always).
 *
 * `thumb_url` is null unless the profile declares a `previewComponent` AND that
 * component's thumb exists on disk for this record. Null rather than an absent
 * key so the client has one thing to test, and never a URL it cannot render.
 *
 * THE TWO OUTCOME MARKERS TRAVEL, and this is a whitelist, so forgetting one is
 * how a partial answer stops saying it is partial:
 *
 *  - `restricted` — this caller has no grant on the criterion, so it was neither
 *    compared nor quoted and the score is computed WITHOUT it. Different from
 *    `agreed: null` alone, which means nobody recorded the value: "you may not
 *    see this" and "there is nothing to see" are claims about different things,
 *    and a curator who reads one as the other draws a wrong conclusion about
 *    their own data. The report-level `restricted_criteria` says the same thing
 *    for the run.
 *  - `required` — the criterion is the profile's GATE, so its declared `weight`
 *    is deliberately out of the ratio (IDENTIFY_SPEC §5). Without the marker the
 *    weight alone is unreadable: it reports a contribution the criterion did not
 *    make, and a zeroed one would render as "descriptive — shown, not scored",
 *    i.e. the weakest thing in the profile, when it is the one thing every
 *    scored candidate had to agree on.
 *
 * Both are emitted only when true, so an ordinary outcome keeps its shape —
 * exactly as `CriterionOutcome` declares them.
 */
function shapeResult(result: MatchResult, thumbs: Map<string, string>): Record<string, unknown> {
	return {
		section_tipo: result.sectionTipo,
		section_id: result.sectionId,
		thumb_url: thumbs.get(previewKey(result)) ?? null,
		score: result.score,
		verdict: result.verdict,
		outcomes: result.outcomes.map((outcome) => ({
			criterion_id: outcome.criterionId,
			label: outcome.label,
			agreed: outcome.agreed,
			weight: outcome.weight,
			detail: outcome.detail,
			...(outcome.restricted === true ? { restricted: true } : {}),
			...(outcome.required === true ? { required: true } : {}),
		})),
	};
}

/** find_matches, over injectable seams (see {@link IdentifyApiDeps}). */
export function buildFindMatches(deps: IdentifyApiDeps): ActionHandler {
	// A READ SPAN, AND THE ROW MEMO IS OPENED FOR IT (PERF-01 / P2-11). Every
	// action in this handler is a read door (security/read_door.ts) that walks
	// criterion paths over the same records many times — the seed's row once per
	// criterion, a Type's row once per candidate quoting it. `runWithRecordMemo`
	// gives the whole action ONE fetch per row (`db/record_memo.ts`); it is never
	// opened around a write, and nothing under these actions writes.
	return (rqo: Rqo, context): Promise<ApiResult> =>
		runWithRecordMemo(async (): Promise<ApiResult> => {
			const principal = requirePrincipal(context);
			const options = rqo.options as Record<string, unknown> | undefined;

			const seed = readSeed(options);
			if (seed === null) decline('identify.missing_seed');

			// Section read grant FIRST: the decline codes below must not tell someone
			// who cannot open this section whether it has a profile.
			if (!(await deps.canReadSection(principal, seed.sectionTipo))) decline('perm.denied');

			let profile: IdentificationProfile | null;
			try {
				profile = await deps.loadProfile(seed.sectionTipo);
			} catch (error) {
				// A malformed descriptor is a curator-facing failure, so the parser's
				// exact message travels: "criterion 'legend' hop 1 names component
				// 'x', which does not exist" is the whole point of refusing loudly.
				if (error instanceof ProfileError)
					decline('identify.invalid_profile', error.message, error);
				throw error;
			}
			if (profile === null) decline('identify.no_profile');

			let report: MatchReport;
			try {
				report = await deps.runMatches({
					profile,
					seed,
					principal,
					poolCap: DEFAULT_POOL_CAP,
					limit: clampLimit(options?.limit),
					// The REQUEST's data lang, read at this boundary and passed down
					// (path_read never reads request identity itself) — review M2:
					// omitted, the values resolved in the install default.
					lang: currentDataLang(),
				});
			} catch (error) {
				// The seed itself is not readable by this principal. Same envelope as the
				// section denial above — a caller learns "not yours", never "it exists".
				if (error instanceof IdentifyAccessError) decline('perm.denied');
				throw error;
			}

			// Thumbnails for the seed and the scored candidates, resolved server-side
			// because only the profile knows which media component stands for the
			// object. Every record here has already passed the engine's RECORD gate —
			// the seed by findMatches raising on a denied read, the candidates by its
			// per-record scope filter. The COMPONENT gate is this door's own (P1-3 /
			// SEC-10): the previewComponent is a component of each record's section,
			// and only the records whose grant the caller holds are handed to the
			// resolver at all — a denied one gets null, and is never asked about.
			const previewComponent = profile.previewComponent;
			const illustrated: PreviewRecord[] = [];
			if (previewComponent !== null) {
				const scope = {
					principal,
					door: 'dd_identify_api.find_matches',
					...(deps.componentGrant === undefined ? {} : { grant: deps.componentGrant }),
				};
				const allowedBySection = new Map<string, boolean>();
				const candidates: PreviewRecord[] = [
					{ sectionTipo: seed.sectionTipo, sectionId: seed.sectionId },
					...report.results.map((result) => ({
						sectionTipo: result.sectionTipo,
						sectionId: result.sectionId,
					})),
				];
				for (const record of candidates) {
					let allowed = allowedBySection.get(record.sectionTipo);
					if (allowed === undefined) {
						allowed = await doorComponentAllowed(scope, {
							sectionTipo: record.sectionTipo,
							componentTipo: previewComponent,
						});
						allowedBySection.set(record.sectionTipo, allowed);
					}
					if (allowed) illustrated.push(record);
				}
			}
			const thumbs =
				illustrated.length === 0
					? new Map<string, string>()
					: await (deps.resolveThumbs ?? resolvePreviewThumbs)(previewComponent, illustrated);

			return envelope(
				{
					seed: {
						section_tipo: seed.sectionTipo,
						section_id: seed.sectionId,
						thumb_url:
							thumbs.get(
								previewKey({ sectionTipo: seed.sectionTipo, sectionId: seed.sectionId }),
							) ?? null,
					},
					profile: { id: profile.id, label: profile.label },
					results: report.results.map((result) => shapeResult(result, thumbs)),
					// The cap stopped us before the pool ran out — deliberately a flag, not
					// a count (match.ts MatchReport.moreAvailable).
					more_available: report.moreAvailable,
					// Criteria the SEED records nothing for: they discriminated nothing, and
					// a score computed without them must say so.
					blind_criteria: report.blindCriteria,
					// Criteria THIS CALLER has no grant on: neither compared nor quoted, so
					// the scores in this answer are PARTIAL — computed over the rest. Sent
					// separately from `blind_criteria` because the two are claims about
					// different things ("you may not see this field" vs "nobody recorded
					// it"), and a restricted caller who cannot tell them apart concludes
					// their catalogue is empty where it is only closed to them. Not an
					// existence oracle: it names the caller's own grants, which they can
					// already read off their profile, and never anything a record holds.
					restricted_criteria: report.restrictedCriteria,
				},
				context.requestId,
			);
		});
}

/* ═══════════════════ identify_by_image — "what is this?" (P3) ═══════════════════ */

/**
 * IDENTIFY A PHOTOGRAPH OF SOMETHING THAT HAS NO RECORD YET.
 *
 * An object arrives at the museum. Before anything is catalogued, the curator
 * wants the nearest already-catalogued objects and what they are: "this looks
 * like these five coins, which are all Type X". So the input is an IMAGE, not a
 * locator — `find_matches` above answers the other question ("what else is like
 * this RECORD?") and needs a record to exist first.
 *
 * ── THIS PATH IS READ-ONLY, AND LEAVES NOTHING BEHIND ────────────────────────
 *
 * Nothing here writes: no record is created, no vector row is stored, no file is
 * staged. The uploaded bytes live in memory for the length of one request, are
 * handed to the encoder, and are dropped — there is deliberately no disk step to
 * clean up (and therefore no temp file to leak when a request fails halfway).
 * The image is a QUERY, and a query is not a document: indexing it would put an
 * unaccessioned object into the corpus that answers everybody else's searches.
 *
 * ── THE INPUT IS BOUNDED BEFORE IT IS TRUSTED ────────────────────────────────
 *
 * Base64 is 33% larger than what it encodes, so the length of the STRING is
 * checked before it is decoded — decoding first would already have paid the
 * memory. Then the decoded bytes are sniffed by MAGIC BYTES
 * (`media/engine/mime.ts`, the same sniffer the upload path uses) and refused
 * unless they really are one of the raster formats an image encoder can read.
 * A declared MIME/data: prefix is never trusted, exactly as in the upload path.
 *
 * ── IT DECLINES, IT NEVER 500s ───────────────────────────────────────────────
 *
 * Media indexing off, RAG off, an egress policy that forbids the configured
 * provider, an unusable image, an encoder that failed — all ordinary answers, all
 * REGISTERED `identify.*` codes. In particular `buildMultimodalProvider` throws a
 * legible operator message when the egress policy would ship the photograph off
 * the host; `identify.egress_forbidden` is public-disclosure, so that message
 * still travels to the curator rather than dying in a last-resort catch.
 *
 * EMPTY INDEX IS NOT "NO MATCHES". `empty_index` says nothing has been indexed to
 * compare against; an `ok` answer with zero results says the corpus WAS searched
 * and nothing came close. Collapsing the two would let a curator read "we have
 * nothing like this object" off an installation that has simply never run the
 * image indexer.
 *
 * ── ACCESS CONTROL ───────────────────────────────────────────────────────────
 *
 * A vector hit is never an oracle (`ai/rag/object_retrieval.ts`). Every hit goes
 * through `aclFilterCandidates` — the RAG subsystem's single chokepoint (schema
 * ACL + per-record projects filter) — before any of it is read or returned, and a
 * requested scope is narrowed to the sections this principal may open. Reading a
 * record's LABEL and its Type link is a second read of a second component, so
 * each is re-gated per (section, component) and each Type record passes the
 * record-scope gate before its label is quoted. Denials are silent: a "3 hidden"
 * count is an existence oracle.
 */

/** Largest image this action accepts, decoded. Bigger than any phone photo worth sending. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * The base64 length that could decode to more than {@link MAX_IMAGE_BYTES}, plus
 * slack for a `data:` prefix and whitespace. Checked BEFORE decoding: an
 * unbounded body must not be materialised as bytes just to measure it.
 *
 * EXPORTED because the request parse door must not be TIGHTER than this: the
 * `options.image` budget in `core/concepts/scalar_bounds.ts` is sized above it,
 * and `test/unit/rqo_scalar_bound_tripwire.test.ts` reads both so raising this
 * cap without raising that budget is RED rather than a silent refusal.
 */
export const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024;

/**
 * Sniffed kinds (media/engine/mime.ts) an image encoder can actually be handed.
 * Deliberately a closed list of RASTER formats: the sniffer also recognises
 * PDFs, PSDs, SVGs and video containers, none of which a CLIP-style tower reads.
 */
const EMBEDDABLE_IMAGE_KINDS: ReadonlySet<string> = new Set([
	'jpeg',
	'png',
	'webp',
	'tiff',
	'bmp',
	'heic',
	'avif',
]);

/** A record the answer names, plus the Type it is linked to (when there is one). */
interface TypeLink {
	sectionTipo: string;
	sectionId: number;
	label: string | null;
}

/** One accepted image, or the REGISTERED code its refusal carries. */
type ImageInput =
	| { ok: true; bytes: Uint8Array; kind: string }
	| { ok: false; code: ErrorCode; msg: string };

/**
 * Decode + bound + sniff the client's image. Never throws, never trusts a
 * declared type, and never allocates more than {@link MAX_IMAGE_BYTES}.
 */
export function readImageInput(raw: unknown): ImageInput {
	if (typeof raw !== 'string' || raw.trim() === '') {
		return {
			ok: false,
			code: 'identify.missing_image',
			msg: 'Missing image (base64 or data: URL)',
		};
	}
	const trimmed = raw.trim();
	if (trimmed.length > MAX_IMAGE_BASE64_CHARS) {
		return {
			ok: false,
			code: 'identify.image_too_large',
			msg: `Image too large (limit ${MAX_IMAGE_BYTES} bytes)`,
		};
	}
	// A data: URL is accepted for the client's convenience; its DECLARED type is
	// discarded — the magic bytes below decide, as in the upload path.
	const base64 = trimmed.startsWith('data:') ? trimmed.slice(trimmed.indexOf(',') + 1) : trimmed;
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(Buffer.from(base64, 'base64'));
	} catch {
		return { ok: false, code: 'identify.invalid_image', msg: 'Image is not decodable base64' };
	}
	if (bytes.length === 0) {
		return { ok: false, code: 'identify.invalid_image', msg: 'Image is empty' };
	}
	if (bytes.length > MAX_IMAGE_BYTES) {
		return {
			ok: false,
			code: 'identify.image_too_large',
			msg: `Image too large (limit ${MAX_IMAGE_BYTES} bytes)`,
		};
	}
	const sniffed = sniffBytes(bytes);
	if (sniffed === null || !EMBEDDABLE_IMAGE_KINDS.has(sniffed.kind)) {
		return {
			ok: false,
			code: 'identify.invalid_image',
			msg: `Not an embeddable image (${sniffed === null ? 'unrecognised' : sniffed.kind}); expected one of ${[...EMBEDDABLE_IMAGE_KINDS].join(', ')}`,
		};
	}
	return { ok: true, bytes, kind: sniffed.kind };
}

/**
 * The seams `identify_by_image` is built on. Production uses
 * {@link defaultIdentifyByImageDeps}; tests inject fakes so every DECLINE and
 * every ACL rule is exercisable without a live encoder, a live vector store or
 * an ontology descriptor (which the engine's test rules forbid writing).
 */
export interface IdentifyByImageDeps {
	/** The master RAG kill-switch. */
	ragEnabled(): boolean;
	/** The image half's own switch (DEDALO_RAG_MEDIA_ENABLED). */
	mediaEnabled(): boolean;
	/** The multimodal runtime config (model name = the vector partition, egress policy). */
	config(): MultimodalRuntimeConfig;
	/** Build the provider that would embed the image. THROWS when egress is forbidden. */
	buildProvider(cfg: MultimodalRuntimeConfig): MultimodalEmbeddingProvider;
	/** ANN over the IMAGE partition of the vector store. */
	queryImagePartition(input: {
		model: string;
		vector: number[];
		limit: number;
		sectionTipos: string[];
	}): Promise<Candidate[]>;
	/** The RAG ACL chokepoint: schema ACL + per-record projects filter. */
	filterAccessible(principal: Principal, candidates: Candidate[]): Promise<Candidate[]>;
	/** Per-(section, component) read level — `getPermissions` in production. */
	componentGrant(principal: Principal, sectionTipo: string, componentTipo: string): Promise<number>;
	/** Per-record scope gate, applied before a Type record's label is quoted. */
	scopeRecords(
		records: { section_tipo: string; section_id: number }[],
		principal: Principal,
	): Promise<{ section_tipo: string; section_id: number }[]>;
	/** The section's label component (section_map `main.term`), or null. */
	labelComponent(sectionTipo: string): Promise<string | null>;
	/**
	 * Values at a path on a record (the identification path reader), read AS
	 * the principal: the reader authorizes every record the path lands on, on
	 * that record's own section (path_read.ts, P1-3 / SEC-12).
	 */
	readValues(
		record: { sectionTipo: string; sectionId: number },
		path: CriterionPathStep[],
		principal: Principal,
	): Promise<CriterionValue | null>;
	/** The section's identification profile. Null = none; throws ProfileError when malformed. */
	loadProfile(sectionTipo: string): Promise<IdentificationProfile | null>;
	/** THROWS `tool.not_authorized` unless the profile grants the tool (`assertToolGranted`). */
	requireToolGrant(principal: Principal, toolName: string): Promise<void>;
	/**
	 * CHARGES one vision call to the caller's daily AI budget (security/ai_spend.ts);
	 * THROWS `ai.budget_exhausted` / `ai.budget_unavailable` — before the model is called.
	 */
	chargeVision(principal: Principal, door: string): Promise<void>;
}

/** One vision call against the daily AI budget (TOOLS-4). */
const chargeOneVisionCall = (principal: Principal, door: string): Promise<void> =>
	chargeAiSpend(principal, { door, vision: 1 });

export function defaultIdentifyByImageDeps(): IdentifyByImageDeps {
	return {
		requireToolGrant: assertToolGranted,
		chargeVision: chargeOneVisionCall,
		ragEnabled: isRagEnabled,
		// ONE env snapshot per read, applying the documented precedence (real
		// process environment over ../private/.env) — the buildMediaStack posture.
		mediaEnabled: () => isMediaEnabled(envSnapshot()),
		config: () => multimodalConfigFromEnv(envSnapshot()),
		buildProvider: buildMultimodalProvider,
		queryImagePartition: ({ model, vector, limit, sectionTipos }) =>
			queryDense(model, vector, limit, { sectionTipos, modality: 'image', maxDistance: null }),
		filterAccessible: aclFilterCandidates,
		componentGrant: getPermissions,
		scopeRecords: scopeRecordHits,
		labelComponent: async (sectionTipo) => {
			const tipo = await getSectionMapValue(sectionTipo, 'main', 'term');
			return typeof tipo === 'string' && tipo !== '' ? tipo : null;
		},
		// The data language is the REQUEST's (ALS-scoped), read at this boundary and
		// passed down — path_read never reads request identity for itself; the
		// principal travels the same way.
		readValues: (record, path, principal) =>
			readPathValues(record, path, {
				lang: currentDataLang(),
				scope: { principal, surface: 'door', door: 'dd_identify_api.identify_by_image' },
			}),
		loadProfile: (sectionTipo) => loadProfileForSection(sectionTipo),
	};
}

/** The requested compare scope: `section_tipo` as a string or an array of them. */
function readScope(options: Record<string, unknown> | undefined): string[] {
	const raw = options?.section_tipo;
	const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== 'string') continue;
		const tipo = value.trim();
		if (tipo !== '' && isValidTipo(tipo) && !out.includes(tipo)) out.push(tipo);
	}
	return out;
}

/**
 * The component on the OBJECT that links it to its Type, per the section's
 * profile: the entry component of any criterion whose FIRST hop lands in
 * `typeSectionTipo`.
 *
 * Only the first hop qualifies, and deliberately: the hop component of step `i`
 * is stored on the record of step `i-1` (path_read.ts), so a Type reached two
 * hops out is not a component of the object at all and could not be read from it.
 * A profile that reaches its Types that way simply reports no Type here rather
 * than reporting some other section's link as one.
 */
function typeEntryComponents(profile: IdentificationProfile, sectionTipo: string): string[] {
	return typeLinkCandidates(profile, sectionTipo).map((candidate) => candidate.componentTipo);
}

/**
 * THE ONE RULE for "is this criterion's entry hop a component of THIS section?".
 *
 * A profile is legitimately MULTI-SECTION (`sectionTipos` is a list: one
 * descriptor covers the coins and the coin Types, or two object sections that
 * are identified the same way), so `criteria[i].path[0].section_tipo` is NOT
 * necessarily the section being read or written. A criterion that enters through
 * another section's component describes a field this record does not have, and
 * offering it is how thirty locators get written into a component the section
 * never had.
 *
 * Both users of that question — {@link resolveAcceptTarget} (`foreign_section`)
 * and {@link typeLinkCandidates} (which component may be WRITTEN as the Type
 * link) — must answer it identically, so they ask this one function. Two copies
 * are exactly how the file came to have two answers: the accept path refused a
 * foreign entry hop while the promotion path offered the same hop as writable.
 */
function entryIsOwnComponent(entry: CriterionPathStep | undefined, sectionTipo: string): boolean {
	// Deliberately NOT a type predicate: the negative branch of a predicate
	// narrows a known-defined `entry` to `never`, and the callers keep reading it
	// to explain the refusal.
	return entry !== undefined && entry.section_tipo === sectionTipo;
}

/** A component that links an object to its Type, and the criteria that revealed it. */
export interface TypeLinkCandidate {
	componentTipo: string;
	/** The criteria whose first hop lands in `typeSectionTipo` through this component. */
	revealedBy: { criterionId: string; label: string }[];
}

/**
 * THE ONE RULE for "which component links an object to its Type", with the
 * criteria that revealed it kept alongside.
 *
 * {@link typeEntryComponents} (identify_by_image) and `resolve_type_link` (the
 * promotion flow) are the same question asked by two features, so they are the
 * same function: a second copy would let the panel that WRITES the link disagree
 * with the panel that merely reports it — and the disagreement would surface as a
 * curator's confirmation landing in a component nothing else considers the Type
 * link.
 *
 * Deliberately DERIVED and never guessed: no "the first portal pointing at the
 * Type section" fallback, because a section commonly holds several relation
 * components aimed at the same place (a provenance portal, an inverse index) and
 * picking a plausible one writes curatorial data into the wrong field. When no
 * criterion reveals it the answer is the empty list, and the caller refuses.
 *
 * `sectionTipo` is REQUIRED, and it is the section whose records will be read or
 * written — never "the profile's section", because a profile covers several
 * (`sectionTipos`). Only criteria ENTERING on that section qualify
 * ({@link entryIsOwnComponent}): a criterion that enters through a sibling
 * section's component names a component these records do not have, and emitting
 * it as the writable Type link is a silent bulk write into the wrong field.
 */
export function typeLinkCandidates(
	profile: IdentificationProfile,
	sectionTipo: string,
): TypeLinkCandidate[] {
	const typeSection = profile.typeSectionTipo;
	if (typeSection === null) return [];
	const out: TypeLinkCandidate[] = [];
	for (const criterion of profile.criteria) {
		const entry = criterion.path[0];
		const hop = criterion.path[1];
		if (entry === undefined || hop === undefined) continue;
		// The entry hop must be a component of THIS section (same rule as the
		// accept path's `foreign_section`), and the first hop must land in the
		// typology.
		if (!entryIsOwnComponent(entry, sectionTipo)) continue;
		if (hop.section_tipo !== typeSection) continue;
		const existing = out.find((candidate) => candidate.componentTipo === entry.component_tipo);
		const revealed = { criterionId: criterion.id, label: criterion.label };
		if (existing === undefined) {
			out.push({ componentTipo: entry.component_tipo, revealedBy: [revealed] });
		} else {
			existing.revealedBy.push(revealed);
		}
	}
	return out;
}

/** identify_by_image, over injectable seams (see {@link IdentifyByImageDeps}). */
export function buildIdentifyByImage(deps: IdentifyByImageDeps): ActionHandler {
	// The row memo, for the same reason buildFindMatches opens one (PERF-01).
	return (rqo: Rqo, context): Promise<ApiResult> =>
		runWithRecordMemo(async (): Promise<ApiResult> => {
			const principal = requirePrincipal(context);
			const options = rqo.options as Record<string, unknown> | undefined;

			// The feature switches first: they are installation facts, and answering
			// them before anything is decoded keeps a disabled install from ever
			// materialising an uploaded body.
			if (!deps.ragEnabled()) decline('identify.rag_disabled');
			if (!deps.mediaEnabled()) decline('identify.media_disabled');

			const image = readImageInput(options?.image);
			if (!image.ok) decline(image.code, image.msg);

			const cfg = deps.config();
			let provider: MultimodalEmbeddingProvider;
			try {
				provider = deps.buildProvider(cfg);
			} catch (error) {
				// buildMultimodalProvider refuses LOUDLY when the configured provider
				// would send object images off this host under a 'local_only' policy.
				// That message is written for an operator; it travels verbatim.
				const message = error instanceof Error ? error.message : String(error);
				decline(
					cfg.imageEgressPolicy === 'local_only'
						? 'identify.egress_forbidden'
						: 'identify.provider_unavailable',
					message,
				);
			}

			// AN EXTERNAL ENCODER IS A SPEND (TOOLS-4): granted by tool_identify, asked
			// before the image leaves the host. A local encoder spends nothing.
			// …and METERED (one vision call against the daily budget), still before it leaves.
			if (provider.isExternal()) {
				await deps.requireToolGrant(principal, VISION_SPEND_TOOL);
				await deps.chargeVision(principal, 'dd_identify_api.identify_by_image');
			}

			const model = provider.model();
			// embedImage returns [] on ANY failure and never a partial batch, so an
			// empty answer here is "the encoder could not read this", not "no vector".
			const [vector] = await provider.embedImage([image.bytes]);
			if (vector === undefined || vector.length === 0) {
				decline(
					'identify.embed_failed',
					`The multimodal provider ('${cfg.provider}', model '${model}') returned no embedding for this image`,
				);
			}

			// A requested scope is narrowed to the sections this caller may open. When
			// nothing survives, refuse — running the query unscoped instead would
			// quietly answer a different question than the one that was asked.
			const requested = readScope(options);
			const scope: string[] = [];
			for (const sectionTipo of requested) {
				if ((await deps.componentGrant(principal, sectionTipo, sectionTipo)) >= 1) {
					scope.push(sectionTipo);
				}
			}
			if (requested.length > 0 && scope.length === 0) decline('perm.denied');

			const limit = clampLimit(options?.limit);
			// Over-fetch so the ACL filter cannot starve the answer (object_retrieval's
			// own ratio — a hit dropped for permissions must not cost a result slot).
			const hits = await deps.queryImagePartition({
				model,
				vector,
				limit: Math.max(40, limit * 4),
				sectionTipos: scope,
			});
			if (hits.length === 0) {
				// DISTINCT from "no matches": the ANN returns the nearest rows whatever
				// their distance, so an empty answer means the partition it searched holds
				// no vectors at all. A curator must never read this as "nothing like it".
				decline(
					'identify.empty_index',
					scope.length === 0
						? `Nothing has been indexed to compare against: the image index holds no vectors for model '${model}'. Run the image indexer before identifying by photograph.`
						: `Nothing has been indexed to compare against in ${scope.join(', ')}: those sections hold no image vectors for model '${model}'.`,
				);
			}

			const accessible = await deps.filterAccessible(principal, tagScore(hits));
			// THE SECTION GRANT ON EVERY SURVIVING HIT, named scope or not (P1-3 /
			// SEC-11). A NAMED scope was narrowed to readable sections above; an
			// OMITTED one meant "the whole image index", and a hit from a section
			// this caller may not open reached the answer on its media component's
			// grant alone. Same predicate as the scope narrowing, per hit, memoised
			// per section; a refusal drops the hit (the ACL filter's own posture — a
			// count would be an existence oracle) and is logged by the door.
			const sectionAllowed = new Map<string, boolean>();
			const sectionScope = {
				principal,
				door: 'dd_identify_api.identify_by_image',
				grant: deps.componentGrant,
			};
			const inScope: Candidate[] = [];
			for (const candidate of accessible) {
				let allowed = sectionAllowed.get(candidate.sectionTipo);
				if (allowed === undefined) {
					allowed = await doorComponentAllowed(sectionScope, {
						sectionTipo: candidate.sectionTipo,
						componentTipo: candidate.sectionTipo,
					});
					sectionAllowed.set(candidate.sectionTipo, allowed);
				}
				if (allowed) inScope.push(candidate);
			}
			const records = collapseToRecords(inScope, 'score').slice(0, limit);

			// Per-section lookups are memoised for THIS request only (no module state):
			// a page of results is usually one or two sections.
			const labelTipoBySection = new Map<string, string | null>();
			const profileBySection = new Map<string, IdentificationProfile | null>();
			const warnings: string[] = [];

			const labelComponentOf = async (sectionTipo: string): Promise<string | null> => {
				const cached = labelTipoBySection.get(sectionTipo);
				if (cached !== undefined) return cached;
				const tipo = await deps.labelComponent(sectionTipo);
				labelTipoBySection.set(sectionTipo, tipo);
				return tipo;
			};

			/** A record's label, gated per component (the record gate says nothing about it). */
			const labelOf = async (sectionTipo: string, sectionId: number): Promise<string | null> => {
				const labelTipo = await labelComponentOf(sectionTipo);
				if (labelTipo === null) return null;
				if ((await deps.componentGrant(principal, sectionTipo, labelTipo)) < 1) return null;
				const value = await deps.readValues(
					{ sectionTipo, sectionId },
					[{ section_tipo: sectionTipo, component_tipo: labelTipo }],
					principal,
				);
				// A section whose main term is a relation (a thesaurus term rather than a
				// literal) has no string to show here; null, never a locator rendered raw.
				return value !== null && value.kind === 'text' ? (value.values[0] ?? null) : null;
			};

			const profileOf = async (sectionTipo: string): Promise<IdentificationProfile | null> => {
				const cached = profileBySection.get(sectionTipo);
				if (cached !== undefined) return cached;
				let profile: IdentificationProfile | null = null;
				try {
					profile = await deps.loadProfile(sectionTipo);
				} catch (error) {
					// A malformed descriptor must not silently become "this section has no
					// Types" — the whole answer would look complete while one section's
					// typology quietly dropped out. The image answer still stands, so the
					// failure rides along as a warning carrying the parser's own message.
					if (!(error instanceof ProfileError)) throw error;
					const message = `Section '${sectionTipo}' has a malformed identification profile, so no Type could be resolved for its results: ${error.message}`;
					if (!warnings.includes(message)) warnings.push(message);
				}
				profileBySection.set(sectionTipo, profile);
				return profile;
			};

			/** The Types a candidate is linked to — the "…which are all Type X" half. */
			const typesOf = async (sectionTipo: string, sectionId: number): Promise<TypeLink[]> => {
				const profile = await profileOf(sectionTipo);
				if (profile === null || profile.typeSectionTipo === null) return [];
				const typeSection = profile.typeSectionTipo;
				const seen = new Set<string>();
				const found: { section_tipo: string; section_id: number }[] = [];
				// The candidate's OWN section decides which criteria enter on it: this
				// profile may cover several sections, and a sibling's entry component is
				// not a component of this record.
				for (const entryTipo of typeEntryComponents(profile, sectionTipo)) {
					// The link component is a component of the CANDIDATE: re-gate it.
					if ((await deps.componentGrant(principal, sectionTipo, entryTipo)) < 1) continue;
					const value = await deps.readValues(
						{ sectionTipo, sectionId },
						[{ section_tipo: sectionTipo, component_tipo: entryTipo }],
						principal,
					);
					if (value === null || value.kind !== 'locators') continue;
					for (const locator of value.locators) {
						if (locator.section_tipo !== typeSection) continue;
						const id = Number(locator.section_id);
						if (!Number.isInteger(id)) continue;
						const key = `${typeSection}_${id}`;
						if (seen.has(key)) continue;
						seen.add(key);
						found.push({ section_tipo: typeSection, section_id: id });
					}
				}
				if (found.length === 0) return [];
				// The Type is ANOTHER record and its label is a quote of it: the same
				// record-scope gate the candidates went through applies before it is read.
				const readable = await deps.scopeRecords(found, principal);
				const links: TypeLink[] = [];
				for (const record of readable) {
					links.push({
						sectionTipo: record.section_tipo,
						sectionId: record.section_id,
						label: await labelOf(record.section_tipo, record.section_id),
					});
				}
				return links;
			};

			const results: Record<string, unknown>[] = [];
			for (const candidate of records) {
				const meta = candidate.chunkMeta ?? {};
				const distance = candidate.distance;
				results.push({
					section_tipo: candidate.sectionTipo,
					section_id: candidate.sectionId,
					label: await labelOf(candidate.sectionTipo, candidate.sectionId),
					// Cosine similarity, rounded like every other image answer (rag/api.ts
					// shapeObject) so two views of the same number never disagree.
					similarity: distance === undefined ? null : Math.round((1 - distance) * 10000) / 10000,
					view: typeof meta.view === 'string' ? meta.view : null,
					// The thumb of the identity the INDEXER stored for this vector, on
					// today's media web base — present only when the section declares a
					// media component and its thumb derivative existed at index time.
					thumb_url: storedThumbUrl(meta),
					media_tipo: typeof meta.media_tipo === 'string' ? meta.media_tipo : null,
					context: candidate.sourceText,
					types: (await typesOf(candidate.sectionTipo, candidate.sectionId)).map((type) => ({
						section_tipo: type.sectionTipo,
						section_id: type.sectionId,
						label: type.label,
					})),
				});
			}

			return envelope(
				{
					// The partition that was searched: two models are two indexes, and a
					// curator comparing results across installs needs to know which one.
					model,
					// The sections actually searched ([] = the whole image index).
					scope,
					results,
					// Legible reasons something could not be resolved. Empty on a clean run;
					// never a substitute for a decline (the answer itself is valid).
					warnings,
				},
				context.requestId,
			);
		});
}

/* ══════════ get_proposals — the read half of "AI proposes, human confirms" ══════════ */

/**
 * PROPOSE VALUES FOR THE CRITERIA A RECORD LEAVES EMPTY.
 *
 * Two engines answer this question and they answer it in the same SHAPE while
 * making fundamentally different CLAIMS:
 *
 *   - `ai/identify/propose.ts` — a similarity-weighted vote over the neighbours
 *     that are already tagged. "Seven similar coins record this." No model, no
 *     egress, and every proposal cites the records it came from.
 *   - `ai/identify/vision.ts` — a vision model shown the record's photograph and
 *     constrained to the profile's own controlled vocabulary. "A model looking
 *     at the picture suggested this, because …".
 *
 * A curator must not confirm those two on the same evidence, so the wire never
 * lets them blur: every proposal carries `source` and a `provenance` object that
 * is a DIFFERENT shape per source (citing neighbours vs. naming the model, its
 * egress class, its stated reason and the photograph it read). The UI is then
 * able to distinguish them because the data does — not because it remembered to.
 *
 * ── THE VISION SOURCE IS OPT-IN, ALWAYS ──────────────────────────────────────
 *
 * It calls a paid model and, depending on the deployment, sends the record's
 * photograph off the host. That is never a side effect of opening a panel. The
 * default `source` is the neighbour vote ALONE; the vision source runs only when
 * the request names it (`source: 'vision'`, or `'all'` for both). The answer
 * SAYS SO — an unrequested source rides along in `sources` with
 * `declined:{reason:'not_requested'}`, so "no vision proposals" can never be
 * misread as "the model found nothing".
 *
 * ── DECLINING ────────────────────────────────────────────────────────────────
 *
 * Whole-request declines are find_matches's, for the same reasons and in the
 * same order (section grant BEFORE the profile, so the codes are not an oracle):
 * `missing_seed`, `forbidden`, `no_profile`, `invalid_profile`, plus
 * `invalid_source` for a source name nobody defined — never silently narrowed to
 * the default, which would answer a different question than the one asked.
 *
 * A SOURCE being unavailable is NOT a request failure. Each source reports its
 * own outcome in `sources[]`: the vision module's own `declined` reasons (no
 * model configured, egress forbidden, no photograph, no vocabulary…), or
 * `source_failed` with the error's message when a source threw. The other
 * source's proposals still travel.
 *
 * ── ACCEPTANCE IS A CLIENT ACTION, AND THIS SAYS WHERE IT MAY LAND ───────────
 *
 * Nothing here writes (both engines are structurally write-free, gated by
 * `identify_propose.test.ts`). Confirming a proposal is the ordinary component
 * save the record form issues. But a criterion is an SQO PATH, and a MULTI-HOP
 * path's value does not live on this record at all — it lives on the linked
 * record the first hop reaches. Writing it to the seed would put a curator's
 * confirmation in the wrong place, silently.
 *
 * So every proposal carries a `target`: whether it is writable HERE, the exact
 * (section_tipo, component_tipo, component_model) it would be written to, and
 * when it is not writable, WHY — `multi_hop` (with the linked records the
 * curator can open instead, ACL-gated), `forbidden_component` (read-only for
 * this caller: the write grant is checked here, not guessed by the client),
 * `unsupported_value_kind` (a date range is not one component-dialect value this
 * flow can honestly compose), `foreign_section`. The client renders a
 * non-writable proposal read-only with that explanation; it never guesses.
 */

/** The two proposal sources. Same shape on the wire, different claims. */
export type ProposalSourceName = 'neighbour_vote' | 'vision_model';

/** What one request gets when it names no source: the vote ALONE. Vision is opt-in. */
export const DEFAULT_PROPOSAL_SOURCES: readonly ProposalSourceName[] = ['neighbour_vote'];

/** Accepted spellings of a source name, including the short ones a client sends. */
const PROPOSAL_SOURCE_ALIASES: Readonly<Record<string, ProposalSourceName>> = {
	neighbour_vote: 'neighbour_vote',
	neighbours: 'neighbour_vote',
	neighbors: 'neighbour_vote',
	vote: 'neighbour_vote',
	vision_model: 'vision_model',
	vision: 'vision_model',
};

/**
 * The sources this request asks for, or the message refusing an unknown one.
 *
 * An unrecognised name is REFUSED rather than dropped: a client that misspells
 * 'vision' and silently gets the default would report a vote as a model's
 * opinion — and the curator would confirm it on evidence that was never shown.
 */
export function readProposalSources(
	raw: unknown,
): { ok: true; sources: ProposalSourceName[] } | { ok: false; msg: string } {
	if (raw === undefined || raw === null || raw === '') {
		return { ok: true, sources: [...DEFAULT_PROPOSAL_SOURCES] };
	}
	const values = Array.isArray(raw) ? raw : [raw];
	const sources: ProposalSourceName[] = [];
	const add = (name: ProposalSourceName): void => {
		if (!sources.includes(name)) sources.push(name);
	};
	for (const value of values) {
		const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
		if (name === 'all' || name === 'both') {
			add('neighbour_vote');
			add('vision_model');
			continue;
		}
		const alias = PROPOSAL_SOURCE_ALIASES[name];
		if (alias === undefined) {
			return {
				ok: false,
				msg: `Unknown proposal source '${String(value)}'. Use 'neighbour_vote' (the default), 'vision_model' (opt-in: it calls a model and may send the photograph off this host), or 'all'.`,
			};
		}
		add(alias);
	}
	if (sources.length === 0) {
		return { ok: false, msg: 'No usable proposal source was named' };
	}
	return { ok: true, sources };
}

/** Why a proposal may (or may not) be written to the seed record from the panel. */
export type AcceptTargetReason =
	/** Writable here: a single-hop criterion on a component this caller may edit. */
	| 'ok'
	/** The value lives on a LINKED record — see the header. */
	| 'multi_hop'
	/** A date range is not a component-dialect value this flow composes. */
	| 'unsupported_value_kind'
	/** The caller may read this record but not write this component. */
	| 'forbidden_component'
	/** The criterion's entry hop is not on the seed's own section. */
	| 'foreign_section'
	/** The profile's criterion could not be found, or states no path. */
	| 'no_path';

/** The seams `get_proposals` is built on. Production uses {@link defaultIdentifyProposalsDeps}. */
export interface IdentifyProposalsDeps {
	/** Resolve the section's profile (null = the section declares none). */
	loadProfile(sectionTipo: string): Promise<IdentificationProfile | null>;
	/** Whether this principal may read the section at all. */
	canReadSection(principal: Principal, sectionTipo: string): Promise<boolean>;
	/** The neighbour-vote source. */
	runNeighbourVote(input: ProposeInput): Promise<ProposeReport>;
	/** The vision source. Only ever called when the request opted in. */
	runVision(input: VisionProposeInput): Promise<VisionProposeReport>;
	/** Per-(section, component) grant — `getPermissions` in production. */
	componentGrant(principal: Principal, sectionTipo: string, componentTipo: string): Promise<number>;
	/** The component's ontology model, so the client knows what it is writing into. */
	componentModel(componentTipo: string): Promise<string | null>;
	/** Values at a path on a record — used ONLY to resolve a multi-hop target. Read AS the principal (path_read.ts scope). */
	readValues(
		record: { sectionTipo: string; sectionId: number },
		path: CriterionPathStep[],
		principal: Principal,
	): Promise<CriterionValue | null>;
	/** Per-record scope gate, applied before a linked record is offered to open. */
	scopeRecords(
		records: { section_tipo: string; section_id: number }[],
		principal: Principal,
	): Promise<{ section_tipo: string; section_id: number }[]>;
	/** THROWS `tool.not_authorized` unless the profile grants the tool (`assertToolGranted`). */
	requireToolGrant(principal: Principal, toolName: string): Promise<void>;
	/**
	 * CHARGES one vision call to the caller's daily AI budget (security/ai_spend.ts);
	 * THROWS `ai.budget_exhausted` / `ai.budget_unavailable` — before the model is called.
	 */
	chargeVision(principal: Principal, door: string): Promise<void>;
}

export function defaultIdentifyProposalsDeps(): IdentifyProposalsDeps {
	return {
		requireToolGrant: assertToolGranted,
		chargeVision: chargeOneVisionCall,
		loadProfile: (sectionTipo) => loadProfileForSection(sectionTipo),
		runNeighbourVote: proposeElements,
		runVision: proposeFromVision,
		canReadSection: async (principal, sectionTipo) =>
			(await getPermissions(principal, sectionTipo, sectionTipo)) >= 1,
		componentGrant: getPermissions,
		componentModel: getModelByTipo,
		// The data language is the REQUEST's (ALS-scoped), read at this boundary and
		// passed down — path_read never reads request identity for itself.
		readValues: (record, path, principal) =>
			readPathValues(record, path, {
				lang: currentDataLang(),
				scope: { principal, surface: 'door', door: 'dd_identify_api.get_proposals' },
			}),
		scopeRecords: scopeRecordHits,
	};
}

/** One piece of evidence on the wire (both sources fill the same shape). */
function shapeEvidence(item: {
	sectionTipo: string;
	sectionId: number;
	value: string;
	weight: number;
	thumbUrl: string | null;
}): Record<string, unknown> {
	return {
		section_tipo: item.sectionTipo,
		section_id: item.sectionId,
		value: item.value,
		weight: item.weight,
		thumb_url: item.thumbUrl,
	};
}

/**
 * WHERE AN ACCEPTED PROPOSAL WOULD LAND — and whether it may land there at all.
 *
 * The write grant is resolved HERE rather than left to the client: a curator who
 * may read a record but not edit one of its components must see the proposal
 * read-only, and a client-side guess about that is a guess about permissions.
 */
async function resolveAcceptTarget(input: {
	criterion: Criterion | undefined;
	kind: 'categorical' | 'date_range';
	seed: { sectionTipo: string; sectionId: number };
	principal: Principal;
	deps: IdentifyProposalsDeps;
}): Promise<Record<string, unknown>> {
	const { criterion, kind, seed, principal, deps } = input;

	const base = {
		writable: false,
		section_tipo: null as string | null,
		component_tipo: null as string | null,
		component_model: null as string | null,
		multi_hop: false,
		hops: [] as CriterionPathStep[],
		open_records: [] as { section_tipo: string; section_id: number }[],
	};

	const path = criterion?.path ?? [];
	const entry = path[0];
	if (criterion === undefined || entry === undefined) {
		return {
			...base,
			reason: 'no_path' as AcceptTargetReason,
			detail: 'this proposal names no field path, so there is nowhere to write it',
		};
	}
	const hops = path.map((step) => ({
		section_tipo: step.section_tipo,
		component_tipo: step.component_tipo,
	}));

	// MULTI-HOP: the value belongs to the linked record, not to this one.
	const nextHop = path[1];
	if (nextHop !== undefined) {
		// The records this seed already links to through the entry hop — offered so
		// the curator can go and set the value where it actually lives. Both gates
		// apply (component read, then record scope): this is a second read.
		const openRecords: { section_tipo: string; section_id: number }[] = [];
		if ((await deps.componentGrant(principal, seed.sectionTipo, entry.component_tipo)) >= 1) {
			const value = await deps.readValues(seed, [entry], principal);
			if (value !== null && value.kind === 'locators') {
				const seen = new Set<string>();
				const found: { section_tipo: string; section_id: number }[] = [];
				for (const locator of value.locators) {
					if (locator.section_tipo !== nextHop.section_tipo) continue;
					const id = Number(locator.section_id);
					if (!Number.isInteger(id)) continue;
					const key = `${locator.section_tipo}_${id}`;
					if (seen.has(key)) continue;
					seen.add(key);
					found.push({ section_tipo: locator.section_tipo, section_id: id });
				}
				if (found.length > 0) openRecords.push(...(await deps.scopeRecords(found, principal)));
			}
		}
		const where = `the linked '${nextHop.section_tipo}' record reached through '${entry.component_tipo}'`;
		return {
			...base,
			multi_hop: true,
			hops,
			open_records: openRecords,
			reason: 'multi_hop' as AcceptTargetReason,
			detail:
				openRecords.length > 0
					? `this value is held by ${where}, not by this record — writing it here would put it in the wrong place. Open the linked record and set it there.`
					: `this value is held by ${where}, and this record links to no readable one yet — there is nothing to open and nowhere here to write it.`,
		};
	}

	// SINGLE HOP: the criterion's own component, on this record's section — the
	// SAME rule resolve_type_link derives its writable link component with
	// ({@link entryIsOwnComponent}); one question, one answer.
	if (!entryIsOwnComponent(entry, seed.sectionTipo)) {
		return {
			...base,
			hops,
			section_tipo: entry.section_tipo,
			component_tipo: entry.component_tipo,
			reason: 'foreign_section' as AcceptTargetReason,
			detail: `this criterion reads '${entry.component_tipo}' on section '${entry.section_tipo}', which is not this record's section`,
		};
	}

	const componentModel = await deps.componentModel(entry.component_tipo);
	const located = {
		...base,
		hops,
		section_tipo: entry.section_tipo,
		component_tipo: entry.component_tipo,
		component_model: componentModel,
	};

	if (kind === 'date_range') {
		// A date proposal is a SPAN in ordinal seconds. Every date component stores
		// a dialect (date / period / time frames) this flow would have to invent a
		// mapping for, and an invented mapping is a wrong date written confidently.
		return {
			...located,
			reason: 'unsupported_value_kind' as AcceptTargetReason,
			detail:
				'a proposed date range cannot be composed into this component’s stored date value from here — read it and enter the date yourself',
		};
	}

	if ((await deps.componentGrant(principal, seed.sectionTipo, entry.component_tipo)) < 2) {
		return {
			...located,
			reason: 'forbidden_component' as AcceptTargetReason,
			detail: `you may read this record but not write '${entry.component_tipo}', so this proposal is shown for information only`,
		};
	}

	return { ...located, writable: true, reason: 'ok' as AcceptTargetReason, detail: '' };
}

/** A neighbour-vote proposal on the wire, carrying its citing neighbours. */
function shapeVoteProposal(
	proposal: ElementProposal,
	report: ProposeReport,
	target: Record<string, unknown>,
): Record<string, unknown> {
	const dateRange =
		proposal.kind === 'date_range'
			? {
					earliest: proposal.display.earliest,
					latest: proposal.display.latest,
					central: proposal.display.central,
				}
			: null;
	const display =
		dateRange === null
			? proposal.display
			: dateRange.earliest === dateRange.latest
				? dateRange.earliest
				: `${dateRange.earliest} – ${dateRange.latest}`;
	return {
		source: 'neighbour_vote',
		criterion_id: proposal.criterionId,
		label: proposal.label,
		role: proposal.role,
		kind: proposal.kind,
		// Always a string, so one renderer reads both kinds; the parts ride along.
		display,
		date_range: dateRange,
		// The engine's own dialect, ready for the confirm flow (never re-resolved).
		value: proposal.value,
		confidence: proposal.confidence,
		votes: proposal.votes,
		distribution:
			proposal.kind === 'categorical'
				? proposal.distribution.map((entry) => ({ value: entry.value, share: entry.share }))
				: [],
		evidence: proposal.evidence.map(shapeEvidence),
		// THE PROVENANCE. A corpus consensus: which leg found the neighbours, why
		// that leg, and how many of them could vote at all.
		provenance: {
			kind: 'neighbour_vote',
			neighbour_source: report.neighbourSource,
			neighbour_source_reason: report.neighbourSourceReason,
			neighbours_considered: report.neighboursConsidered,
			votes: proposal.votes,
		},
		target,
	};
}

/** A vision proposal on the wire, carrying the model and its stated reason. */
function shapeVisionProposal(
	proposal: VisionElementProposal,
	target: Record<string, unknown>,
): Record<string, unknown> {
	return {
		source: 'vision_model',
		criterion_id: proposal.criterionId,
		label: proposal.label,
		role: proposal.role,
		kind: proposal.kind,
		display: proposal.display,
		date_range: null,
		value: proposal.value,
		confidence: proposal.confidence,
		// Both 0/[] by construction: no record voted, and manufacturing a
		// distribution would dress one opinion up as a consensus (vision.ts).
		votes: proposal.votes,
		distribution: [],
		evidence: proposal.evidence.map(shapeEvidence),
		// THE PROVENANCE. A machine's guess about a photograph: which model, what
		// it may egress, what it said, and which picture it looked at.
		provenance: {
			kind: 'vision_model',
			model: {
				id: proposal.model.id,
				label: proposal.model.label,
				egress: proposal.model.egress,
			},
			reason: proposal.reason,
			image: {
				component_tipo: proposal.image.componentTipo,
				quality: proposal.image.quality,
				thumb_url: proposal.image.thumbUrl,
			},
		},
		target,
	};
}

/** Criteria a source did not propose for — never silent (both engines report them). */
function shapeSkipped(
	skipped: readonly { criterionId: string; label: string; reason: string; detail: string }[],
): Record<string, unknown>[] {
	return skipped.map((item) => ({
		criterion_id: item.criterionId,
		label: item.label,
		reason: item.reason,
		detail: item.detail,
	}));
}

/** get_proposals, over injectable seams (see {@link IdentifyProposalsDeps}). */
export function buildGetProposals(deps: IdentifyProposalsDeps): ActionHandler {
	// The row memo, for the same reason buildFindMatches opens one (PERF-01).
	return (rqo: Rqo, context): Promise<ApiResult> =>
		runWithRecordMemo(async (): Promise<ApiResult> => {
			const principal = requirePrincipal(context);
			const options = rqo.options as Record<string, unknown> | undefined;

			const seed = readSeed(options);
			if (seed === null) decline('identify.missing_seed');

			// Section read grant FIRST, exactly as find_matches: the decline codes must
			// not tell someone who cannot open this section whether it has a profile.
			if (!(await deps.canReadSection(principal, seed.sectionTipo))) decline('perm.denied');

			const requested = readProposalSources(options?.source);
			if (!requested.ok) decline('identify.invalid_source', requested.msg);
			// THE VISION SPEND IS GRANTED (TOOLS-4): asked for, it needs tool_identify —
			// refused before the profile is loaded or any model is called.
			if (requested.sources.includes('vision_model')) {
				await deps.requireToolGrant(principal, VISION_SPEND_TOOL);
			}

			let profile: IdentificationProfile | null;
			try {
				profile = await deps.loadProfile(seed.sectionTipo);
			} catch (error) {
				if (error instanceof ProfileError)
					decline('identify.invalid_profile', error.message, error);
				throw error;
			}
			if (profile === null) decline('identify.no_profile');

			const lang = currentDataLang();
			const topK = clampLimit(options?.limit);
			const rawModelId = options?.model_id;
			const modelId =
				typeof rawModelId === 'string' && rawModelId.trim() !== '' ? rawModelId.trim() : undefined;

			// Profile order is the CURATOR's ordering, and it is what both sources list
			// in; the merged list keeps it, with the vote before the model when both
			// answered the same criterion (a corpus consensus is the stronger claim).
			const criterionById = new Map(profile.criteria.map((criterion) => [criterion.id, criterion]));
			const criterionOrder = new Map(
				profile.criteria.map((criterion, index) => [criterion.id, index]),
			);

			// One target per (criterion, kind): both sources land in the same place.
			const targets = new Map<string, Record<string, unknown>>();
			const targetFor = async (
				criterionId: string,
				kind: 'categorical' | 'date_range',
			): Promise<Record<string, unknown>> => {
				const key = `${criterionId}::${kind}`;
				const cached = targets.get(key);
				if (cached !== undefined) return cached;
				const resolved = await resolveAcceptTarget({
					criterion: criterionById.get(criterionId),
					kind,
					seed,
					principal,
					deps,
				});
				targets.set(key, resolved);
				return resolved;
			};

			const sources: Record<string, unknown>[] = [];
			const proposals: { order: number; rank: number; wire: Record<string, unknown> }[] = [];
			const rankOf = (name: ProposalSourceName): number => (name === 'neighbour_vote' ? 0 : 1);

			// ── the neighbour vote ───────────────────────────────────────────────────
			if (requested.sources.includes('neighbour_vote')) {
				try {
					const report = await deps.runNeighbourVote({ profile, seed, principal, topK, lang });
					for (const proposal of report.proposals) {
						const target = await targetFor(proposal.criterionId, proposal.kind);
						proposals.push({
							order: criterionOrder.get(proposal.criterionId) ?? Number.MAX_SAFE_INTEGER,
							rank: rankOf('neighbour_vote'),
							wire: shapeVoteProposal(proposal, report, target),
						});
					}
					sources.push({
						source: 'neighbour_vote',
						requested: true,
						ran: true,
						declined: null,
						neighbour_source: report.neighbourSource,
						neighbour_source_reason: report.neighbourSourceReason,
						neighbours_considered: report.neighboursConsidered,
						skipped: shapeSkipped(report.skipped),
					});
				} catch (error) {
					// A denied SEED is the whole request's answer, not one source's.
					if (error instanceof IdentifyAccessError) decline('perm.denied');
					// Anything else is THIS SOURCE being unavailable: the other source's
					// proposals still stand, and the failure travels rather than vanishing.
					sources.push({
						source: 'neighbour_vote',
						requested: true,
						ran: false,
						declined: {
							reason: 'source_failed',
							detail: declineDetail(error),
						},
						skipped: [],
					});
				}
			} else {
				sources.push({
					source: 'neighbour_vote',
					requested: false,
					ran: false,
					declined: {
						reason: 'not_requested',
						detail: "this request did not ask for the neighbour vote (source: 'neighbour_vote')",
					},
					skipped: [],
				});
			}

			// ── the vision model (opt-in) ────────────────────────────────────────────
			if (requested.sources.includes('vision_model')) {
				// METERED (TOOLS-4): one vision call, charged right before the model is
				// asked and OUTSIDE the source's try — a refused budget is the request's
				// 429, never a quiet "source_failed" decline.
				await deps.chargeVision(principal, 'dd_identify_api.get_proposals');
				try {
					const report = await deps.runVision({
						profile,
						seed,
						principal,
						lang,
						...(modelId !== undefined ? { modelId } : {}),
					});
					if (report.declined === null) {
						for (const proposal of report.proposals) {
							const target = await targetFor(proposal.criterionId, 'categorical');
							proposals.push({
								order: criterionOrder.get(proposal.criterionId) ?? Number.MAX_SAFE_INTEGER,
								rank: rankOf('vision_model'),
								wire: shapeVisionProposal(proposal, target),
							});
						}
					}
					sources.push({
						source: 'vision_model',
						requested: true,
						ran: report.declined === null,
						declined:
							report.declined === null
								? null
								: { reason: report.declined.reason, detail: report.declined.detail },
						model:
							report.model === null
								? null
								: { id: report.model.id, label: report.model.label, egress: report.model.egress },
						image:
							report.image === null
								? null
								: {
										component_tipo: report.image.componentTipo,
										quality: report.image.quality,
										thumb_url: report.image.thumbUrl,
									},
						skipped: shapeSkipped(report.skipped),
						// Answers the model gave that were NOT in the vocabulary it was shown.
						// Reported so hallucination is visible rather than invisible.
						discarded: report.discarded.map((item) => ({
							criterion_id: item.criterionId,
							offered: item.offered,
							detail: item.detail,
						})),
					});
				} catch (error) {
					if (error instanceof IdentifyAccessError) decline('perm.denied');
					sources.push({
						source: 'vision_model',
						requested: true,
						ran: false,
						declined: {
							reason: 'source_failed',
							detail: declineDetail(error),
						},
						model: null,
						image: null,
						skipped: [],
						discarded: [],
					});
				}
			} else {
				sources.push({
					source: 'vision_model',
					requested: false,
					ran: false,
					// Said out loud: "no vision proposals" must never read as "the model
					// looked and found nothing". It was never asked.
					declined: {
						reason: 'not_requested',
						detail:
							"the vision source is opt-in — it calls a model and may send this record's photograph off this host. Ask for it with source: 'vision' (or 'all').",
					},
					model: null,
					image: null,
					skipped: [],
					discarded: [],
				});
			}

			proposals.sort((a, b) => a.order - b.order || a.rank - b.rank);

			return envelope(
				{
					seed: { section_tipo: seed.sectionTipo, section_id: seed.sectionId },
					profile: { id: profile.id, label: profile.label },
					// Every source's own outcome, requested or not. The panel reads this to
					// say WHY a source contributed nothing.
					sources,
					proposals: proposals.map((item) => item.wire),
				},
				context.requestId,
			);
		});
}

/* ═══════ resolve_type_link — what a cluster may be PROMOTED into ═══════ */

/**
 * WHERE A CLUSTER BECOMES A TYPE — the read that makes promotion possible, and
 * the only server work promotion needs.
 *
 * A curator looking at a cluster ("these thirty coins are the same thing") wants
 * to stop the grouping being implicit: mint a canonical **Type** record, or point
 * at the one that already exists, and link every member to it. That link is an
 * ORDINARY `component_portal` value, so the write is the standard `change_value`
 * component save issued per member from the client — the precedent
 * `tools/tool_cataloging/js/tool_cataloging.js` set, and the reason `src/ai/identify/*.ts`
 * stays inside the no-write static scan (IDENTIFY_SPEC §8.2). There is deliberately
 * NO confirm/attach endpoint here: a second write path into portals would have to
 * re-implement the TM audit, the observers and the permission re-check the first
 * one already does, and would drift from it the first time either changed.
 *
 * What the client CANNOT work out for itself is three facts, and this action is
 * exactly those three:
 *
 *  1. **Is promotion meaningful at all?** `typeSectionTipo` is null for a corpus
 *     with no published typology (a photo archive clusters happily and has
 *     nothing to promote INTO). That is a normal, stated fact about the
 *     collection, so it is a DECLINE with its own code — the panel says so in
 *     words and offers no button, rather than showing one that cannot work.
 *  2. **Which component holds the link?** Derived from the profile by
 *     {@link typeLinkCandidates}, never guessed. A section usually has several
 *     relation components aimed at the Type section; writing a curator's
 *     confirmation into the wrong one is invisible and permanent. When no
 *     criterion reveals it, this REFUSES (`no_link_component`) instead of
 *     picking the plausible portal.
 *  3. **What may this caller actually do?** The write grant on the link
 *     component, the write grant on the Type section (can a new Type be minted
 *     at all), and the Type section's own label component — all resolved
 *     server-side, because a client-side guess about permissions is a guess.
 *
 * It additionally SURVEYS the members it is given (`records`): the Types they
 * already link to, with how many members each. That is what makes "attach to an
 * existing Type" the one-click common case it should be — the type is usually
 * already catalogued and usually already on some of the cluster's members —
 * without inventing a record picker. Every value read is gated twice (the
 * component grant on the member, then the record scope gate on the Type before
 * its label is quoted), exactly as `identify_by_image` gates its `types`.
 *
 * And it CHECKS a hand-typed Type id (`check_type_id` → `type_record`,
 * {@link checkTypeRecord}): the one place the flow takes a locator from a
 * keyboard is the one place a typo becomes thirty locators on a record that does
 * not exist, and no downstream gate catches that for a portal.
 *
 * IT WRITES NOTHING.
 */

/** How many member records one survey will read. Promotion is a curator-sized batch. */
export const MAX_SURVEY_RECORDS = 300;

/** Why a link component may (or may not) be written by this caller. */
export type TypeLinkReason =
	/** Writable: a locator-holding component this caller may edit. */
	| 'ok'
	/** The caller may read the section but not write this component. */
	| 'forbidden_component'
	/** The component does not store locators, so a Type link cannot live in it. */
	| 'unsupported_component_model';

/** The seams `resolve_type_link` is built on. Production uses {@link defaultTypeLinkDeps}. */
export interface IdentifyTypeLinkDeps {
	/** Resolve the section's profile (null = the section declares none). */
	loadProfile(sectionTipo: string): Promise<IdentificationProfile | null>;
	/** Whether this principal may read the section at all. */
	canReadSection(principal: Principal, sectionTipo: string): Promise<boolean>;
	/** Per-(section, component) grant — `getPermissions` in production. */
	componentGrant(principal: Principal, sectionTipo: string, componentTipo: string): Promise<number>;
	/** The component's ontology model, so the client knows what it writes into. */
	componentModel(componentTipo: string): Promise<string | null>;
	/** The matrix column a model stores in; 'relation' = it holds locators. */
	modelColumn(model: string): string | null;
	/** The section's label component (section_map `main.term`), or null. */
	labelComponent(sectionTipo: string): Promise<string | null>;
	/** Values at a path on a record (the identification path reader), read AS the principal (path_read.ts scope). */
	readValues(
		record: { sectionTipo: string; sectionId: number },
		path: CriterionPathStep[],
		principal: Principal,
	): Promise<CriterionValue | null>;
	/** Per-record scope gate, applied before a record is named or its label quoted. */
	scopeRecords(
		records: { section_tipo: string; section_id: number }[],
		principal: Principal,
	): Promise<{ section_tipo: string; section_id: number }[]>;
	/**
	 * Does this record EXIST? Asked of the matrix, not of a filter: the scope gate
	 * above answers "may you see it", and for a global admin it answers "yes" about
	 * a record that was never created. Attaching thirty members to a Type id that
	 * does not exist is a silent, permanent scattering of locators (nothing
	 * downstream checks portal target existence — save_component only does it for
	 * component_relation_children), so the CHECK the panel arms its confirm step
	 * with asks both questions.
	 */
	recordExists(sectionTipo: string, sectionId: number): Promise<boolean>;
}

export function defaultTypeLinkDeps(): IdentifyTypeLinkDeps {
	return {
		loadProfile: (sectionTipo) => loadProfileForSection(sectionTipo),
		canReadSection: async (principal, sectionTipo) =>
			(await getPermissions(principal, sectionTipo, sectionTipo)) >= 1,
		componentGrant: getPermissions,
		componentModel: getModelByTipo,
		modelColumn: getColumnNameByModel,
		labelComponent: async (sectionTipo) => {
			const tipo = await getSectionMapValue(sectionTipo, 'main', 'term');
			return typeof tipo === 'string' && tipo !== '' ? tipo : null;
		},
		// The data language is the REQUEST's (ALS-scoped), read at this boundary and
		// passed down — path_read never reads request identity for itself.
		readValues: (record, path, principal) =>
			readPathValues(record, path, {
				lang: currentDataLang(),
				scope: { principal, surface: 'door', door: 'dd_identify_api.resolve_type_link' },
			}),
		scopeRecords: scopeRecordHits,
		// Existence through the db layer's own batch primitive (no SQL here): the
		// section's matrix table, then "is this id in it".
		recordExists: async (sectionTipo, sectionId) => {
			const table = await getMatrixTableFromTipo(sectionTipo);
			if (table === null) return false;
			const existing = await readExistingSectionIds(table, sectionTipo, [sectionId]);
			return existing.has(sectionId);
		},
	};
}

/**
 * The member records a survey was asked for, in the engine's shape. Ill-typed
 * rows are dropped, and so are members of ANOTHER section: the link component
 * was derived from THIS section's profile, so reading it off a foreign record
 * would be reading a component that section does not have. A cluster spanning
 * two sections is two questions, and the caller asks them separately.
 */
function readSurveyRecords(
	raw: unknown,
	sectionTipo: string,
): { sectionTipo: string; sectionId: number }[] {
	if (!Array.isArray(raw)) return [];
	const out: { sectionTipo: string; sectionId: number }[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const row = entry as { section_tipo?: unknown; section_id?: unknown };
		const rowTipo = typeof row?.section_tipo === 'string' ? row.section_tipo.trim() : '';
		const sectionId = Number(row?.section_id);
		if (rowTipo === '' || rowTipo !== sectionTipo) continue;
		if (!Number.isInteger(sectionId) || sectionId < 1) continue;
		const key = `${sectionTipo}_${sectionId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ sectionTipo, sectionId });
		if (out.length >= MAX_SURVEY_RECORDS) break;
	}
	return out;
}

/** Why a hand-typed Type id may (or may not) be attached to. */
export type TypeRecordCheckReason =
	/** The record exists, this caller may read it, and it is in the Type section. */
	| 'ok'
	/** What was typed is not a record id at all. */
	| 'invalid_id'
	/**
	 * There is no such record here — or there is, and this caller may not read it.
	 * ONE code for both on purpose: splitting them turns this into an existence
	 * oracle for records outside the caller's projects filter.
	 */
	| 'not_found';

/**
 * IS THIS HAND-TYPED TYPE ID SOMETHING THIRTY RECORDS MAY BE ATTACHED TO?
 *
 * The panel's "another existing Type, by record id" field is the one place a
 * curator types a locator instead of picking one, so it is the one place a typo
 * becomes a bulk write. Everything the client could check itself is unable to
 * answer it: `get_section_terms` omits forbidden sections silently and returns
 * null for an id that does not exist, and the title renderer falls back to
 * "tipo / id" — so a miss and a hit render identically.
 *
 * The answer is therefore server-side and it is BOTH questions at once: does the
 * record exist (asked of the matrix, because the scope gate says "yes" to a
 * global admin about a record that was never created), and may this caller read
 * it (the ordinary record-scope gate, plus the section read grant). Only `ok`
 * may arm an attach.
 */
async function checkTypeRecord(input: {
	raw: unknown;
	typeSectionTipo: string;
	typeLabelTipo: string | null;
	principal: Principal;
	deps: IdentifyTypeLinkDeps;
}): Promise<Record<string, unknown>> {
	const { raw, typeSectionTipo, typeLabelTipo, principal, deps } = input;

	const sectionId = typeof raw === 'number' ? raw : Number(String(raw).trim());
	const base = {
		section_tipo: typeSectionTipo,
		section_id: Number.isInteger(sectionId) ? sectionId : null,
		exists: false,
		label: null as string | null,
	};
	if (!Number.isInteger(sectionId) || sectionId < 1) {
		return {
			...base,
			reason: 'invalid_id' as TypeRecordCheckReason,
			detail: `'${String(raw)}' is not a record id`,
		};
	}

	const missing = {
		...base,
		reason: 'not_found' as TypeRecordCheckReason,
		// Deliberately one sentence for "no such record" and "not yours": the
		// difference is an existence oracle, and neither is attachable.
		detail: `No readable record '${typeSectionTipo} / ${sectionId}' exists, so nothing can be attached to it. Check the id.`,
	};

	// Read grant on the Type section first, then existence, then the record scope
	// gate — the order find_matches uses, so the codes never leak what they gate.
	if ((await deps.canReadSection(principal, typeSectionTipo)) !== true) return missing;
	if (!(await deps.recordExists(typeSectionTipo, sectionId))) return missing;
	const readable = await deps.scopeRecords(
		[{ section_tipo: typeSectionTipo, section_id: sectionId }],
		principal,
	);
	if (readable.length === 0) return missing;

	// It is real and readable: name it, so the curator confirms against a TITLE
	// and not against the id they just typed.
	let label: string | null = null;
	if (
		typeLabelTipo !== null &&
		(await deps.componentGrant(principal, typeSectionTipo, typeLabelTipo)) >= 1
	) {
		const value = await deps.readValues(
			{ sectionTipo: typeSectionTipo, sectionId },
			[{ section_tipo: typeSectionTipo, component_tipo: typeLabelTipo }],
			principal,
		);
		label = value !== null && value.kind === 'text' ? (value.values[0] ?? null) : null;
	}

	return { ...base, exists: true, label, reason: 'ok' as TypeRecordCheckReason, detail: '' };
}

/** resolve_type_link, over injectable seams (see {@link IdentifyTypeLinkDeps}). */
export function buildResolveTypeLink(deps: IdentifyTypeLinkDeps): ActionHandler {
	// The row memo, for the same reason buildFindMatches opens one (PERF-01).
	return (rqo: Rqo, context): Promise<ApiResult> =>
		runWithRecordMemo(async (): Promise<ApiResult> => {
			const principal = requirePrincipal(context);
			const options = rqo.options as Record<string, unknown> | undefined;

			const raw = options?.section_tipo;
			const sectionTipo = typeof raw === 'string' ? raw.trim() : '';
			if (sectionTipo === '' || !isValidTipo(sectionTipo)) decline('identify.missing_section');

			// Section read grant FIRST, exactly as find_matches: the decline codes below
			// must not tell someone who cannot open this section whether it has a
			// profile, or where its typology lives.
			if (!(await deps.canReadSection(principal, sectionTipo))) decline('perm.denied');

			let profile: IdentificationProfile | null;
			try {
				profile = await deps.loadProfile(sectionTipo);
			} catch (error) {
				if (error instanceof ProfileError)
					decline('identify.invalid_profile', error.message, error);
				throw error;
			}
			if (profile === null) decline('identify.no_profile');

			// 1. IS THERE ANYWHERE TO PROMOTE INTO? Null is not a defect: a collection
			//    with no published typology clusters perfectly well and simply has no
			//    canonical Type to attach members to.
			const typeSectionTipo = profile.typeSectionTipo;
			if (typeSectionTipo === null) {
				decline(
					'identify.no_type_section',
					`The identification profile '${profile.label || profile.id}' declares no Type section, so there is nothing to promote a group into. Clustering still works — this collection just keeps no canonical Type records.`,
				);
			}

			// 2. WHICH COMPONENT HOLDS THE LINK? Derived from the profile's own criteria,
			//    or refused. Never the portal that happens to point at the right section,
			//    and never a component of a SIBLING section this profile also covers.
			const candidates = typeLinkCandidates(profile, sectionTipo);
			if (candidates.length === 0) {
				decline(
					'identify.no_link_component',
					`No criterion in profile '${profile.label || profile.id}' starts on '${sectionTipo}' and reaches section '${typeSectionTipo}' in one hop, so the component that links a record to its Type cannot be derived. Add a criterion whose path starts on '${sectionTipo}' and hops into '${typeSectionTipo}', or link the records by hand — this refuses to guess which component is the Type link.`,
				);
			}

			// 3. WHAT MAY THIS CALLER DO? Grants resolved here, never guessed client-side.
			const links: Record<string, unknown>[] = [];
			for (const candidate of candidates) {
				const model = await deps.componentModel(candidate.componentTipo);
				const holdsLocators = model !== null && deps.modelColumn(model) === 'relation';
				const grant = await deps.componentGrant(principal, sectionTipo, candidate.componentTipo);
				const reason: TypeLinkReason = !holdsLocators
					? 'unsupported_component_model'
					: grant < 2
						? 'forbidden_component'
						: 'ok';
				links.push({
					section_tipo: sectionTipo,
					component_tipo: candidate.componentTipo,
					component_model: model,
					writable: reason === 'ok',
					reason,
					detail:
						reason === 'ok'
							? ''
							: reason === 'forbidden_component'
								? `you may read this section but not write '${candidate.componentTipo}', so members cannot be attached to a Type from here`
								: `'${candidate.componentTipo}' is a '${model ?? 'unknown'}', which does not store record links, so a Type link cannot be written into it`,
					revealed_by: candidate.revealedBy.map((entry) => ({
						criterion_id: entry.criterionId,
						label: entry.label,
					})),
				});
			}

			// The Type section itself: may this caller mint one, and what names it?
			const typeLabelTipo = await deps.labelComponent(typeSectionTipo);
			const typeLabelModel =
				typeLabelTipo === null ? null : await deps.componentModel(typeLabelTipo);
			const typeLabelColumn = typeLabelModel === null ? null : deps.modelColumn(typeLabelModel);
			const typeLabelGrant =
				typeLabelTipo === null
					? 0
					: await deps.componentGrant(principal, typeSectionTipo, typeLabelTipo);
			const typeSectionGrant = await deps.componentGrant(
				principal,
				typeSectionTipo,
				typeSectionTipo,
			);

			// 4. THE SURVEY. Which Types do these members already carry? Two gates per
			//    value: the component grant on the member, then the record scope gate on
			//    the Type before its label is quoted.
			const members = readSurveyRecords(options?.records, sectionTipo);
			const readableMembers =
				members.length === 0
					? []
					: await deps.scopeRecords(
							members.map((member) => ({
								section_tipo: member.sectionTipo,
								section_id: member.sectionId,
							})),
							principal,
						);
			const writableLinkTipos = links
				.filter((link) => link.writable === true || link.reason === 'forbidden_component')
				.map((link) => String(link.component_tipo));
			const counts = new Map<number, number>();
			for (const member of readableMembers) {
				const seenForMember = new Set<number>();
				for (const componentTipo of writableLinkTipos) {
					if ((await deps.componentGrant(principal, member.section_tipo, componentTipo)) < 1) {
						continue;
					}
					const value = await deps.readValues(
						{ sectionTipo: member.section_tipo, sectionId: member.section_id },
						[{ section_tipo: member.section_tipo, component_tipo: componentTipo }],
						principal,
					);
					if (value === null || value.kind !== 'locators') continue;
					for (const locator of value.locators) {
						if (locator.section_tipo !== typeSectionTipo) continue;
						const id = Number(locator.section_id);
						if (!Number.isInteger(id)) continue;
						// One member counts ONCE per Type however many components link it.
						if (seenForMember.has(id)) continue;
						seenForMember.add(id);
						counts.set(id, (counts.get(id) ?? 0) + 1);
					}
				}
			}
			const existingTypes: Record<string, unknown>[] = [];
			if (counts.size > 0) {
				// The Type is ANOTHER record and its label is a quote of it: the same
				// record-scope gate the members went through applies before it is read.
				const readableTypes = await deps.scopeRecords(
					[...counts.keys()].map((id) => ({ section_tipo: typeSectionTipo, section_id: id })),
					principal,
				);
				const labelReadable =
					typeLabelTipo !== null &&
					(await deps.componentGrant(principal, typeSectionTipo, typeLabelTipo)) >= 1;
				for (const record of readableTypes) {
					let label: string | null = null;
					if (labelReadable && typeLabelTipo !== null) {
						const value = await deps.readValues(
							{ sectionTipo: record.section_tipo, sectionId: record.section_id },
							[{ section_tipo: record.section_tipo, component_tipo: typeLabelTipo }],
							principal,
						);
						// A section whose main term is a relation has no string to show here;
						// null, never a locator rendered raw.
						label = value !== null && value.kind === 'text' ? (value.values[0] ?? null) : null;
					}
					existingTypes.push({
						section_tipo: record.section_tipo,
						section_id: record.section_id,
						label,
						member_count: counts.get(record.section_id) ?? 0,
					});
				}
				existingTypes.sort(
					(a, b) =>
						Number(b.member_count) - Number(a.member_count) ||
						Number(a.section_id) - Number(b.section_id),
				);
			}

			// 5. THE CHECK. "Attach to another existing Type, by record id" is a TYPED
			//    id, and a typed id is a typo waiting to be confirmed: 4321 for 432
			//    scatters thirty locators onto a record that does not exist, and no
			//    later gate notices (portal inserts do not check target existence).
			//    So the panel arms its confirm step on THIS answer and on nothing it
			//    worked out itself — a title resolver cannot tell a miss from a hit
			//    (it falls back to "tipo / id" for both).
			const rawCheckId = options?.check_type_id;
			const typeRecord =
				rawCheckId === undefined || rawCheckId === null || rawCheckId === ''
					? null
					: await checkTypeRecord({
							raw: rawCheckId,
							typeSectionTipo,
							typeLabelTipo,
							principal,
							deps,
						});

			return envelope(
				{
					section_tipo: sectionTipo,
					profile: { id: profile.id, label: profile.label },
					type_section: {
						section_tipo: typeSectionTipo,
						// Minting a Type is an ordinary record creation, re-checked by the
						// create handler itself; this only tells the panel whether to offer it.
						can_create: typeSectionGrant >= 2,
						label_component:
							typeLabelTipo === null
								? null
								: {
										section_tipo: typeSectionTipo,
										component_tipo: typeLabelTipo,
										component_model: typeLabelModel,
										// A thesaurus-term main (a relation) cannot be filled with a
										// typed string from here: the panel must say so and offer the
										// record instead of composing a value it would get wrong.
										kind: typeLabelColumn === 'relation' ? 'relation' : 'literal',
										writable: typeLabelGrant >= 2 && typeLabelColumn !== 'relation',
									},
					},
					// Usually one. More than one is a real answer (two criteria reaching the
					// typology through different components) and the panel must ASK, not pick.
					links,
					// Types the surveyed members already carry, commonest first.
					existing_types: existingTypes,
					// How many of the named members could actually be read and surveyed.
					members_surveyed: readableMembers.length,
					// null unless the request asked (`check_type_id`). `exists:true` is the
					// ONLY thing that may arm an attach to a hand-typed id.
					type_record: typeRecord,
				},
				context.requestId,
			);
		});
}

/** The dd_identify_api action table (registered in dispatch.ts). */
export const identifyApiActions: Record<string, ActionHandler> = {
	find_matches: buildFindMatches(defaultIdentifyApiDeps()),
	identify_by_image: buildIdentifyByImage(defaultIdentifyByImageDeps()),
	get_proposals: buildGetProposals(defaultIdentifyProposalsDeps()),
	resolve_type_link: buildResolveTypeLink(defaultTypeLinkDeps()),
};
