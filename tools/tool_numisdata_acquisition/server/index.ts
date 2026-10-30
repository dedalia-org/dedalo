/**
 * tool_numisdata_acquisition — pastes a public auction URL, fetches it, and
 * lets the operator review every lot before committing: preview_url returns
 * the parsed auction + lots (nothing written yet); commit_lots creates one
 * numisdata4 record per kept lot, resolves/links its Auction and Type, and
 * imports the lot's image via the shared cropCoinPair splitter (src/core/media/tools/).
 *
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { NO_LANG } from '../../../src/config/data_langs.ts';
import { sanitizeClientSqo } from '../../../src/core/concepts/sqo.ts';
import { withTransaction } from '../../../src/core/db/postgres.ts';
import { DedaloError } from '../../../src/core/errors/dedalo_error.ts';
import {
	type ApiErrorBody,
	ok,
	toDedaloError,
	toErrorBody,
} from '../../../src/core/errors/index.ts';
import { type HarvestDeps, harvestFetch } from '../../../src/core/harvest/harvest.ts';
import { stagingDir } from '../../../src/core/media/ingest/add_file.ts';
import {
	processUploadedFile,
	requireMediaSpec,
} from '../../../src/core/media/ingest/process_uploaded_file.ts';
import { receiveUpload } from '../../../src/core/media/ingest/upload.ts';
import { buildMediaIdentifier } from '../../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../../src/core/media/tool_support.ts';
import { cropCoinPair } from '../../../src/core/media/tools/crop_coin_pair.ts';
import {
	nameKeysForQuality,
	persistUploadedMedia,
} from '../../../src/core/media/tools/files_info_persist.ts';
import { labelByTipo } from '../../../src/core/ontology/labels.ts';
import { getColumnNameByModel, getModelByTipo } from '../../../src/core/ontology/resolver.ts';
import { getTldFromTipo } from '../../../src/core/ontology/tld.ts';
import { currentDataLang } from '../../../src/core/resolve/request_lang.ts';
import { runSearch } from '../../../src/core/search/search_statement.ts';
import { buildSearchSql } from '../../../src/core/search/sql_assembler.ts';
import { createSectionRecord } from '../../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../../src/core/section/record/save_component.ts';
import { isRecordInScope } from '../../../src/core/security/record_scope.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { acquireDedupLock } from './lib/acquisition/lock.ts';
import { aureoAdapter } from './lib/sources/aureo/adapter.ts';
import { biddrAdapter } from './lib/sources/biddr/adapter.ts';
import { jesusvicoAdapter } from './lib/sources/jesusvico/adapter.ts';
import { numisbidsAdapter } from './lib/sources/numisbids/adapter.ts';
import { sixbidAdapter } from './lib/sources/sixbid/adapter.ts';
import type { RawSource, SourceAdapter } from './lib/sources/types.ts';

/**
 * EVERY section and component tipo this tool reads or writes — ONE object, so a
 * gate can rebind the whole set to a scratch `zz*` situation
 * (`withAcquisitionSeamForTests`) instead of the tool's fixed install sections,
 * which the suite database never holds (the generic-TLD law). Production reads
 * `NUMISDATA_ACQUISITION_TARGETS`; no write path names a tipo any other way.
 */
export interface AcquisitionTargets {
	readonly object: string;
	readonly weight: string;
	readonly diameter: string;
	readonly inventoryNumber: string;
	readonly dateText: string;
	readonly auctionRelation: string;
	readonly obverseDesign: string;
	readonly reverseDesign: string;
	readonly publicRemark: string;
	readonly sourceUri: string;
	readonly auctionSection: string;
	readonly auctionCompany: string;
	readonly entitySection: string;
	readonly entityName: string;
	readonly auctionNumberTitle: string;
	readonly auctionCode: string;
	readonly typeRelation: string;
	readonly typeSection: string;
	readonly typeCode: string;
	readonly typeCatalogueRelation: string;
	readonly catalogueSection: string;
	readonly catalogueName: string;
	readonly obversePortal: string;
	readonly reversePortal: string;
	readonly imageSection: string;
	readonly imageComponent: string;
}

export const NUMISDATA_ACQUISITION_TARGETS: AcquisitionTargets = Object.freeze({
	object: 'numisdata4',
	// material/mint/ruler/denomination/condition (thesaurus-linked) are still deliberately deferred.
	weight: 'numisdata133', // component_number
	diameter: 'numisdata135', // component_number
	inventoryNumber: 'numisdata151', // component_input_text, "Inventory number"
	dateText: 'numisdata1372', // component_input_text
	auctionRelation: 'numisdata147', // component_autocomplete -> numisdata224
	obverseDesign: 'numisdata763', // component_text_area, "Specific obverse design"
	reverseDesign: 'numisdata1029', // component_text_area, "Specific reverse design"
	// Fallback ONLY, when a description doesn't follow jesusvico's "A/...R/..."
	// split: component_text_area, "Public remark".
	publicRemark: 'numisdata150',
	// component_iri "URI" (Documentation group), non-translatable. Real numisdata4 rows store it as
	// [{id, iri, lang:'lg-nolan'}] (an external object page, e.g. a museum collection URL). Holds the
	// lot's CANONICAL URL - rebuilt by its source adapter from the lot's own identity
	// (SourceAdapter.canonicalLotUrl), only when that identity is known - and is the
	// auction-independent dedup key.
	sourceUri: 'numisdata275',

	// numisdata224's own fields (confirmed via dd_ontology this session).
	auctionSection: 'numisdata224',
	// numisdata228 IS a relation, not free text (review item 9, confirmed against
	// 14,759/14,780 real numisdata224 rows): component_autocomplete -> rsc106
	// (Entity), display name on rsc116. Writing it as {id,value} text gets
	// silently dropped by validateRelationInsert's PHP-era 'bad_form' compat path
	// (saveComponentData still returns ok:true), so findExistingAuction's text
	// match never hits and every batch created a duplicate Auction with no
	// company linked. Resolved as a real relation below (findEntityByExactName /
	// resolveCompanySelectionByName / linkCompany).
	auctionCompany: 'numisdata228',
	entitySection: 'rsc106',
	entityName: 'rsc116', // the only field every real rsc106 record carries
	// "Number & title" is a genuinely COMBINED field — formatAuctionNumberTitle
	// uses the source's own title text, not the bare number. Since that's no
	// longer a stable dedup key on its own, the bare number is ALSO written to
	// `auctionCode` purely for findExistingAuction to match on.
	auctionNumberTitle: 'numisdata230', // component_input_text
	auctionCode: 'numisdata231', // component_input_text, "Code" (otherwise unused) — dedup key

	// numisdata3 ("Type") — a shared scholarly catalog-classification record
	// (Catalog system + Number, e.g. "ACIP" 1781). Read-only: findExistingType
	// only ever LINKS to an existing Type, never creates one — it's a shared
	// taxonomy entry (Mint/Denomination cross-links, weight/diameter averages
	// computed across every linked object), and auto-fabricating one from
	// scraped auction-house text risks polluting it in a way that's much harder
	// to notice than an extra Auction record. No match -> left unlinked, reported.
	typeRelation: 'numisdata161', // component_autocomplete -> numisdata3
	typeSection: 'numisdata3',
	typeCode: 'numisdata27', // component_input_text, "Code"/"Number"
	typeCatalogueRelation: 'numisdata309', // component_select -> numisdata300
	catalogueSection: 'numisdata300',
	catalogueName: 'numisdata303', // component_input_text, e.g. "ACIP", "MIB", "RPC"

	// Confirmed directly from the live numisdata256 ("Add images") ontology config.
	obversePortal: 'numisdata164',
	reversePortal: 'numisdata165',
	imageSection: 'rsc170', // the shared "resource" image record type
	imageComponent: 'rsc29', // component_image on rsc170
});

// The generic non-reciprocal link relation type used everywhere else in this
// codebase; numisdata147 declares no config_relation.relation_type override.
const RELATION_TYPE_LINK = 'dd151';

/** What a gate rebinds: the targets, and the harvesting door's scripted site (HarvestDeps). */
export interface AcquisitionSeam {
	readonly targets: AcquisitionTargets;
	readonly harvest?: HarvestDeps;
}

/**
 * THE SEAM. LIFECYCLE: request-scoped by construction — an AsyncLocalStorage
 * scope opened ONLY by `withAcquisitionSeamForTests` around one gate's call;
 * outside it the store is absent and the production targets + the real
 * harvesting transport apply. Carries no identity.
 */
const acquisitionSeam = new AsyncLocalStorage<AcquisitionSeam>();

/** The targets in force: a gate's rebinding inside its scope, else production. */
function T(): AcquisitionTargets {
	return acquisitionSeam.getStore()?.targets ?? NUMISDATA_ACQUISITION_TARGETS;
}

/** The harvesting door's deps in force (a gate's scripted site), else the real transport. */
function harvestDeps(): HarvestDeps | undefined {
	return acquisitionSeam.getStore()?.harvest;
}

/**
 * Run `work` with this tool rebound to `seam` — TEST ISOLATION ONLY: the write
 * gate (test/unit/tool_numisdata_acquisition_commit_native.test.ts) drives
 * commit_lots against a scratch `zz*` situation and a scripted image site.
 *
 * SCRATCH-ONLY: every rebound target must be the shipped tipo or sit under a
 * `zz` scratch TLD, else the seam REFUSES before `work` runs (internal.invariant;
 * ai_spend's seamLedger/seamLimits twin). The dd128 write census's `not-dd128`
 * verdict rests on the targets being module constants: a seam that could name
 * any section would be a second, unbounded way to address a write.
 * Gate: numisdata_acquisition_seam_scope_native.
 */
export async function withAcquisitionSeamForTests<R>(
	seam: AcquisitionSeam,
	work: () => Promise<R>,
): Promise<R> {
	const shipped: Readonly<Record<string, string>> = { ...NUMISDATA_ACQUISITION_TARGETS };
	for (const [field, tipo] of Object.entries(seam.targets)) {
		if (tipo === shipped[field]) continue;
		if (getTldFromTipo(tipo)?.startsWith('zz') === true) continue;
		throw new DedaloError('internal.invariant', {
			message: `tool_numisdata_acquisition: the test seam may only name zz scratch tipos ('${field}' = '${tipo}')`,
			coordinates: { field, tipo },
		});
	}
	return await acquisitionSeam.run(seam, work);
}

const IMPORT_KEY_DIR = 'numisdata_acquisition';

const ADAPTERS = [jesusvicoAdapter, biddrAdapter, aureoAdapter, numisbidsAdapter, sixbidAdapter];

// `lots` is otherwise UNBOUNDED input (review item G): each committed lot costs about 8 saves plus
// an image fetch at >=3s, so a pathological listing could turn one commit into an hours-long job
// (or, from a malformed/adversarial commit_lots payload, an effectively unbounded one). The largest
// real auction fetched live this session (aureo, subasta/0470) ran 2,193 lots; this leaves headroom
// above that while still bounding the worst case. Applied to both what preview shows and what
// commit accepts, so the two never disagree about what "the batch" is.
const MAX_LOTS = 3000;

// The harvesting door's host policy per source, by adapter id - a bare domain also admits its
// subdomains (harvestFetch's own rule), which is what covers each source's separate image/CDN
// host (biddr's media.biddr.com, sixbid's image-cdn.sixbid.com, ...) without listing it separately.
const HOSTS_BY_ADAPTER_ID: Record<string, readonly string[]> = {
	jesusvico: ['jesusvico.com'],
	biddr: ['biddr.com'],
	aureo: ['aureo.com'],
	numisbids: ['numisbids.com'],
	sixbid: ['sixbid.com'],
};

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/tiff': 'tif',
	'image/gif': 'gif',
	'image/avif': 'avif',
};

/**
 * Extension from the server's own content-type first, falling back to the URL's last path
 * segment. The URL alone was unreliable: `lastIndexOf('.')` over the WHOLE path matched the wrong
 * thing on a versioned path (`/v1.2/img/123` -> "2/img/123") or a query-string id
 * (`/image.php?id=5` -> "php") - review item 10. GIF/AVIF are mapped too, not folded into the
 * `jpg` fallback: a mismatched extension fails the engine's own magic-byte check and the lot's
 * image import is rejected outright - review item D5.
 */
function extensionFromUrl(url: string, contentType: string): string {
	const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
	const byMimeType = EXTENSION_BY_MIME_TYPE[mime];
	if (byMimeType !== undefined) return byMimeType;

	const lastSegment = new URL(url).pathname.split('/').pop() ?? '';
	const dot = lastSegment.lastIndexOf('.');
	const extension = dot > 0 ? lastSegment.slice(dot + 1).toLowerCase() : '';
	return /^(?:jpe?g|png|webp|tiff?|gif|avif)$/.test(extension) ? extension : 'jpg';
}

function assertUrlOption(options: Record<string, unknown>): string {
	const url = options.url;
	if (typeof url !== 'string' || url.trim() === '') {
		throw new DedaloError('request.invalid_options', {
			message: 'preview_url requires a non-empty "url" string option.',
			publicMessage: 'Paste an auction URL first.',
		});
	}
	return url;
}

function findAdapterOrThrow(url: string) {
	const adapter = ADAPTERS.find((candidate) => candidate.matchesUrl(url));
	if (!adapter) {
		throw new DedaloError('request.invalid_options', {
			message: `No supported source adapter matches this URL: ${url}`,
			publicMessage:
				'Only jesusvico.com, biddr.com, aureo.com, numisbids.com, and sixbid.com URLs are supported.',
		});
	}
	return adapter;
}

/**
 * Fetches and parses one auction URL — no curation, no persistence. Also
 * runs a read-only Auction existence check so the review screen can show
 * "will link" vs "will create" before the operator commits to anything.
 *
 * Runs as a background job (multi-page listings can take 30s+, long enough
 * to hit the client's own retry timeout and collide with the idempotency
 * lock on the still-running attempt) — progress is published per page.
 */
async function previewUrl(context: ToolActionContext): Promise<ToolResponse> {
	const url = assertUrlOption(context.options);
	const adapter = findAdapterOrThrow(url);

	const acquisition = await adapter.acquire(url, (currentPage, totalPages, message) => {
		context.publishProgress?.({
			msg: message ?? `Fetching page ${currentPage} of ${totalPages}`,
			counter: currentPage,
			total: totalPages,
		});
	});
	const firstPage = acquisition.pages[0];
	if (firstPage === undefined) {
		throw new DedaloError('tool.action_failed', {
			message: `Adapter '${adapter.id}' returned zero pages for ${url}.`,
		});
	}

	const auction = adapter.parseAuction(firstPage, url);
	const foundLots = acquisition.pages.flatMap((page) => adapter.parseLots(page, url));
	const lots = foundLots.slice(0, MAX_LOTS);

	const auctionHouse = auction.auctionHouse?.trim() ?? '';
	const auctionNumber = auction.auctionNumber?.trim() ?? '';
	const auctionStatus = await checkExistingAuctionStatus(auctionHouse, auctionNumber, context);

	return ok(
		{
			auction,
			lots,
			auction_status: auctionStatus,
			lots_truncated_by: foundLots.length - lots.length,
		},
		{ requestId: toolRequestId(context) },
	);
}

/**
 * Parses a page the OPERATOR's own browser already fetched, instead of this
 * tool fetching it live — the fallback for a source whose own defenses block
 * automated retrieval outright (confirmed live for numisbids.com: HTTP 403
 * from multiple independent networks). A human visiting a page isn't
 * automated retrieval, so there's nothing here to detect or bypass — this
 * just parses HTML the operator already legitimately has, in memory only,
 * never written to disk.
 *
 * Single-page only — no live fetch here to drive a pagination walk, so a
 * multi-page sale needs one preview_html call per page.
 */
async function previewHtml(context: ToolActionContext): Promise<ToolResponse> {
	const url = assertUrlOption(context.options);
	const html = context.options.html;
	if (typeof html !== 'string' || html.trim() === '') {
		throw new DedaloError('request.invalid_options', {
			message: 'preview_html requires a non-empty "html" string option.',
			publicMessage: "Paste or upload the saved page's HTML first.",
		});
	}

	const adapter = findAdapterOrThrow(url);
	// findAdapterOrThrow already confirmed the host belongs to a known source (each adapter's own
	// matchesUrl). No live fetch happens on this path (the operator supplies the HTML), so there is
	// nothing here for the harvesting door to guard beyond that - just the same https-only shape
	// check a real fetch would also enforce.
	if (new URL(url).protocol !== 'https:') {
		throw new DedaloError('request.invalid_options', {
			message: `preview_html: only https:// URLs are supported, got ${url}.`,
			publicMessage: 'Only https:// URLs are supported.',
		});
	}

	const page: RawSource = { html, finalUrl: url, httpStatus: 200, contentType: 'text/html' };
	const auction = adapter.parseAuction(page, url);
	const foundLots = adapter.parseLots(page, url);
	const lots = foundLots.slice(0, MAX_LOTS);

	const auctionHouse = auction.auctionHouse?.trim() ?? '';
	const auctionNumber = auction.auctionNumber?.trim() ?? '';
	const auctionStatus = await checkExistingAuctionStatus(auctionHouse, auctionNumber, context);

	return ok(
		{
			auction,
			lots,
			auction_status: auctionStatus,
			lots_truncated_by: foundLots.length - lots.length,
		},
		{ requestId: toolRequestId(context) },
	);
}

/** Parses "6.75g" / "29.6mm" style values into the plain float component_number expects. */
function parseLeadingNumber(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const match = value.match(/^-?\d+(\.\d+)?/);
	return match ? Number(match[0]) : null;
}

/**
 * Splits a jesusvico.com description on its "A/" (Anverso) / "R/" (Reverso)
 * markers, cutting the reverse run where the metrology block starts. One
 * confirmed sample, not a guaranteed convention — English-locale
 * descriptions carry no such markers. Returns nulls (not a guess) when
 * absent; the caller falls back to a general remark field.
 */
function splitJesusvicoDesign(description: string | null): {
	obverse: string | null;
	reverse: string | null;
} {
	if (description === null) return { obverse: null, reverse: null };
	const obverseStart = description.indexOf('A/');
	const reverseStart = description.indexOf('R/', obverseStart + 1);
	if (obverseStart === -1 || reverseStart === -1 || reverseStart <= obverseStart) {
		return { obverse: null, reverse: null };
	}
	const trimTrailingPunctuation = (text: string): string => text.trim().replace(/[.,;]\s*$/, '');
	const obverse = trimTrailingPunctuation(description.slice(obverseStart + 2, reverseStart));
	const afterReverse = description.slice(reverseStart + 2);
	// Lookahead, not a literal trailing \s (same fix as extractJesusvicoWeight):
	// a weight mention at the very end of the description has nothing after the
	// dot, so a literal \s there never matched and the whole metrology tail
	// (weight included) bled into the reverse design text instead of being cut.
	const metrologyMatch = afterReverse.match(
		/\b(?:AE|AR|AV|AU|BI|Æ)\b|\d+(?:[.,]\d+)?\s*g\.?(?=\s|$|[,;)])/i,
	);
	const reverse = trimTrailingPunctuation(
		metrologyMatch?.index !== undefined
			? afterReverse.slice(0, metrologyMatch.index)
			: afterReverse,
	);
	return { obverse: obverse || null, reverse: reverse || null };
}

/** numisdata230 ("Number & title") gets the source's own auction title, which
 * already reads as both — falls back to the bare number only when a page has
 * no title at all. */
function formatAuctionNumberTitle(auctionNumber: string, title: string | null): string {
	const cleanTitle = title?.trim();
	return cleanTitle ? cleanTitle : auctionNumber;
}

/** Writes one field as a fresh 'set_data' (a bare {id, value} item).
 * `sectionTipo` MUST be the tipo `sectionId` actually belongs to — a prior
 * version hard-coded the object section (numisdata4) here, which silently no-opped
 * every Auction-record write (findOrCreateAuction targets numisdata224, not
 * numisdata4) with no error surfaced at all. */
async function writeField(
	sectionId: number,
	sectionTipo: string,
	componentTipo: string,
	value: string | number,
	userId: number,
	// Defaults to NO_LANG for the (majority) non-translatable call sites; a
	// translatable component (numisdata150/231/763/1029/1372 - review item C5)
	// must instead pass currentDataLang(), or the write lands in a slot the
	// edit form never shows, and the operator's first real edit creates a
	// SECOND value instead of replacing it.
	lang: string = NO_LANG,
): Promise<void> {
	const save = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang,
		userId,
		changedData: [{ action: 'set_data', value: [{ id: 1, value }] }],
	});
	if (!save.ok) {
		// The refusal reason rides `cause` (log-only, never the wire), and WHICH write failed rides
		// `coordinates` (also log-only) — never a template string: a tool holding an outbound door
		// (harvestFetch) must never carry a literal property read off an error/result object in its
		// own source (ssrf_one_guard_tripwire). The console's own Error-printing walks `cause`
		// automatically, so the refusal reason still reaches the log.
		throw new DedaloError('record.save_failed', {
			coordinates: {
				component_tipo: componentTipo,
				section_tipo: sectionTipo,
				section_id: sectionId,
			},
			cause: save,
		});
	}
}

/** Writes one component_iri value as a fresh 'set_data' ({id, iri} - the shape real numisdata275
 * rows carry; non-translatable, so NO_LANG). Same refusal handling as writeField. */
async function writeIriField(
	sectionId: number,
	sectionTipo: string,
	componentTipo: string,
	iri: string,
	userId: number,
): Promise<void> {
	const save = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang: NO_LANG,
		userId,
		changedData: [{ action: 'set_data', value: [{ id: 1, iri }] }],
	});
	if (!save.ok) {
		throw new DedaloError('record.save_failed', {
			coordinates: {
				component_tipo: componentTipo,
				section_tipo: sectionTipo,
				section_id: sectionId,
			},
			cause: save,
		});
	}
}

/** One coin face linked by importImagesForLot: the portal it hangs from + the rsc170 record. */
interface CreatedImage {
	portalTipo: string;
	sectionId: number;
}

/** importImagesForLot's outcome. The pair is all-or-nothing: on failure every rsc170 record THIS
 * call created has been deleted again, except the ids in `orphaned` - those whose own deletion
 * failed (logged), which the operator must remove by hand. */
type ImageImportResult =
	| { imported: true; created: CreatedImage[] }
	| { imported: false; cause: unknown; orphaned: number[] };

/**
 * Deletes the rsc170 records one importImagesForLot call created (ids taken only from that call's
 * own save results - never a lookup), through the engine's delete door, which also strips the
 * portal locators pointing at them from the lot. Returns the ids whose deletion failed or was
 * refused. Best-effort by design (the face failure is what the caller reports), but never silent:
 * each failure is logged with its coordinates for the operator, and the id reaches the summary.
 */
async function removeCreatedImageRecords(
	context: ToolActionContext,
	sectionIds: readonly number[],
): Promise<number[]> {
	const orphaned: number[] = [];
	for (const imageSectionId of sectionIds) {
		try {
			const deleted = await deleteSectionRecord(T().imageSection, imageSectionId, context.userId);
			if (deleted.refused !== undefined) {
				console.error('[tool_numisdata_acquisition] image record cleanup refused', {
					section_tipo: T().imageSection,
					section_id: imageSectionId,
					request_id: toolRequestId(context),
				});
				orphaned.push(imageSectionId);
			}
		} catch (cleanupError) {
			console.error(
				'[tool_numisdata_acquisition] image record cleanup failed',
				{
					section_tipo: T().imageSection,
					section_id: imageSectionId,
					request_id: toolRequestId(context),
				},
				cleanupError,
			);
			orphaned.push(imageSectionId);
		}
	}
	return orphaned;
}

/**
 * Downloads the lot's first image, stages it through Dédalo's upload
 * pipeline, splits it with `crop_50` (called directly — trusted server code,
 * not an untrusted client-named processor), then links each half through its
 * portal the same way tool_import_files' importIntoPortal does. The obverse/
 * reverse pair is all-or-nothing (see ImageImportResult): a half-imported coin
 * (obverse linked, reverse missing) is never left behind.
 */
async function importImagesForLot(
	context: ToolActionContext,
	lot: Record<string, unknown>,
	sectionId: number,
): Promise<ImageImportResult> {
	const createdIds: number[] = [];
	try {
		return { imported: true, created: await importImagePair(context, lot, sectionId, createdIds) };
	} catch (error) {
		const orphaned = await removeCreatedImageRecords(context, createdIds);
		return { imported: false, cause: error, orphaned };
	}
}

/** importImagesForLot's body. Pushes each rsc170 id into `createdIds` the moment its record exists,
 * so the caller can undo exactly what this call made when a later face fails. */
async function importImagePair(
	context: ToolActionContext,
	lot: Record<string, unknown>,
	sectionId: number,
	createdIds: number[],
): Promise<CreatedImage[]> {
	const images = lot.images;
	const first = Array.isArray(images) ? images[0] : undefined;
	const sourceUrl =
		first !== null && typeof first === 'object'
			? (first as { sourceUrl?: unknown }).sourceUrl
			: null;
	if (typeof sourceUrl !== 'string' || sourceUrl === '') {
		throw new DedaloError('resource.not_found', {
			publicMessage: 'This lot has no image to import.',
		});
	}

	// The image host isn't always the page's own host (sixbid's
	// image-cdn.sixbid.com, biddr's media.biddr.com), so the host policy is
	// resolved from the image URL itself via the same adapter registry - a bare
	// domain entry also admits its subdomains (harvestFetch's own host rule).
	const imageAdapter = ADAPTERS.find((candidate) => candidate.matchesUrl(sourceUrl));
	if (!imageAdapter) {
		throw new DedaloError('tool.unsupported_target', {
			message: `No source adapter recognizes this image's host: ${sourceUrl}`,
			publicMessage: 'This image is hosted somewhere this tool does not recognize.',
		});
	}

	const imageResponse = await harvestFetch(
		{
			url: sourceUrl,
			hosts: HOSTS_BY_ADAPTER_ID[imageAdapter.id] ?? [],
			requireHttps: true,
			expectContentType: ['image/'],
			maxBytes: 25 * 1024 * 1024,
		},
		harvestDeps(),
	);
	if (!imageResponse.ok) {
		throw new DedaloError('tool.action_failed', {
			message: `Could not download image (HTTP ${imageResponse.status}).`,
			publicMessage: `Could not download the lot image (HTTP ${imageResponse.status}).`,
		});
	}
	const extension = extensionFromUrl(sourceUrl, imageResponse.contentType);
	const fileName = `${T().object}_${sectionId}.${extension}`;

	const staged = receiveUpload(
		{
			keyDir: IMPORT_KEY_DIR,
			fileName,
			chunked: false,
			chunkIndex: 0,
			totalChunks: 1,
			blob: imageResponse.bytes,
			uploadId: null,
			csrfToken: null,
		},
		context.userId,
	);
	if (staged.tmpName === undefined) {
		throw new DedaloError('tool.action_failed', { message: 'Image upload did not stage a file.' });
	}

	const outcome = await cropCoinPair({
		file_path: join(stagingDir(context.userId, IMPORT_KEY_DIR), staged.tmpName),
		file_name: fileName,
		user_id: context.userId,
		key_dir: IMPORT_KEY_DIR,
		file_processor_properties: [
			{
				function_name: 'crop_50',
				custom_arguments: {
					destination_1: T().obversePortal,
					destination_2: T().reversePortal,
				},
			},
		],
	});
	if (!outcome.ok || outcome.outputs === undefined) {
		// cropCoinPair's own `message` is already a vetted, operator-safe diagnostic (see its SEC-18
		// comment) - but `tool.action_failed` is an operator-disclosure code, so publicMessage was
		// never actually reaching the wire here either way. `cause` carries it to the log without a
		// literal property read off a result object in this door-holding file (ssrf_one_guard_tripwire).
		throw new DedaloError('tool.action_failed', { cause: outcome });
	}

	const spec = requireMediaSpec('component_image');
	const created: CreatedImage[] = [];
	// Transcodes start only once EVERY face is in: a face started and then rolled back (its
	// record deleted because the other face failed) would transcode a file for a gone record.
	const startTranscodes: (() => unknown)[] = [];
	for (const output of outcome.outputs) {
		if (output.portalComponentTipo === undefined) continue;
		const save = await saveComponentData({
			componentTipo: output.portalComponentTipo,
			sectionTipo: T().object,
			sectionId,
			lang: NO_LANG,
			userId: context.userId,
			changedData: [{ action: 'add_new_element', id: null, value: T().imageSection }],
		});
		const createdSectionId = (save as { ok: boolean; created_section_id?: number })
			.created_section_id;
		if (!save.ok || createdSectionId === undefined) {
			throw new DedaloError('record.save_failed', {
				coordinates: { component_tipo: output.portalComponentTipo, section_id: sectionId },
				cause: save,
			});
		}
		// Tracked BEFORE its file is processed: the portal add_new_element above already created
		// and linked this rsc170 record, so from here on a failure of THIS face or of a later one
		// must delete it again (importImagesForLot's all-or-nothing cleanup).
		createdIds.push(createdSectionId);
		const { identity, pathOpts } = await resolveMediaToolContext({
			component_tipo: T().imageComponent,
			section_tipo: T().imageSection,
			section_id: createdSectionId,
		});
		const result = await processUploadedFile({
			spec,
			identity,
			pathOpts,
			userId: context.userId,
			keyDir: IMPORT_KEY_DIR,
			tmpName: output.tmpName,
			extension,
		});
		await persistUploadedMedia({
			sectionTipo: identity.sectionTipo,
			sectionId: identity.sectionId,
			componentTipo: identity.componentTipo,
			lang: identity.lang,
			filesInfo: result.filesInfo,
			originalFileName: output.fileName,
			originalNormalizedName: `${buildMediaIdentifier(identity)}.${result.extension}`,
			nameKeys: nameKeysForQuality(spec, undefined),
		});
		if (result.startTranscode) startTranscodes.push(result.startTranscode);
		created.push({ portalTipo: output.portalComponentTipo, sectionId: createdSectionId });
	}

	for (const startTranscode of startTranscodes) startTranscode();
	return created;
}

/** Either an EXISTING Entity the operator (or an auto-resolve fallback)
 * picked, or an explicit instruction to create a new one — never a bare
 * string, so a Company can no longer be silently written as text. */
type CompanySelection = { sectionId: number } | { create: true; name: string };

/**
 * Exact-name lookup of an rsc106 Entity through the engine's '==' operator:
 * accent-insensitive (both sides through Postgres `f_unaccent`) but
 * CASE-SENSITIVE (builder_string.ts 'exact') - "jesus vico" does not match
 * "Jesus Vico". Runs WITH the caller's principal (buildSearchSql's
 * `{principal}` option), so it only sees Entities the caller can read — never
 * a hand-written SQL WHERE that bypasses the projects filter.
 */
async function findEntityByExactName(
	name: string,
	context: ToolActionContext,
): Promise<number | null> {
	const sqo = sanitizeClientSqo({
		section_tipo: [T().entitySection],
		limit: 1,
		filter: {
			$and: [
				{
					q: `==${name}`,
					path: [{ section_tipo: T().entitySection, component_tipo: T().entityName }],
				},
			],
		},
	});
	const built = await buildSearchSql(sqo, { principal: context.principal });
	const rows = (await runSearch(built)) as {
		section_id: number;
	}[];
	return rows[0]?.section_id ?? null;
}

/** The auto-resolve fallback used where no human picker is in the loop (the
 * biddr/sixbid per-lot auction-house override, and a defensive fallback if
 * the client's own picker selection is missing/malformed): reuse an exact
 * name match when one exists, otherwise an explicit "create new". Still never
 * writes free text — just skips the human-confirmation step the client
 * picker normally provides for the batch's own auction. */
async function resolveCompanySelectionByName(
	name: string,
	context: ToolActionContext,
): Promise<CompanySelection> {
	const existing = await findEntityByExactName(name, context);
	return existing !== null ? { sectionId: existing } : { create: true, name };
}

// acquireDedupLock (lib/acquisition/lock.ts) folds the term IN SQL by the '==' search's own
// f_unaccent (+ lower), so a lock key is never finer than the equality it guards.

/** Resolves a CompanySelection to a real rsc106 section_id, creating one
 * (Name only — the one field every real Entity record carries) when the
 * selection says to. The create path is its own transaction (joins an
 * ambient one, e.g. findOrCreateAuction's, when already inside one) - a
 * failed name write used to leave an unnamed orphan Entity behind (review
 * item C1, same shape as the Auction/Person/Series cases it names). Locked
 * and RE-CHECKED under the lock before creating: the picker's own search ran
 * outside any lock, so two concurrent "create new Entity 'X'" commits could
 * otherwise both miss each other and both create it (review item C4). */
async function resolveCompanyEntityId(
	context: ToolActionContext,
	selection: CompanySelection,
): Promise<number> {
	if ('sectionId' in selection) return selection.sectionId;
	return withTransaction(async () => {
		await acquireDedupLock('rsc106:name:', selection.name);
		const existing = await findEntityByExactName(selection.name, context);
		if (existing !== null) return existing;
		const sectionId = await createSectionRecord(T().entitySection, context.userId);
		await writeField(sectionId, T().entitySection, T().entityName, selection.name, context.userId);
		return sectionId;
	});
}

/** Links numisdata224's Company field to a real rsc106 Entity — same relation
 * shape as linkAuction/linkType below, not the free-text writeField call this
 * replaces. */
async function linkCompany(
	context: ToolActionContext,
	auctionSectionId: number,
	entitySectionId: number,
): Promise<void> {
	const save = await saveComponentData({
		componentTipo: T().auctionCompany,
		sectionTipo: T().auctionSection,
		sectionId: auctionSectionId,
		lang: NO_LANG,
		userId: context.userId,
		changedData: [
			{
				action: 'set_data',
				value: [
					{
						id: 1,
						type: RELATION_TYPE_LINK,
						section_id: entitySectionId,
						section_tipo: T().entitySection,
						from_component_tipo: T().auctionCompany,
					},
				],
			},
		],
	});
	if (!save.ok) {
		throw new DedaloError('record.save_failed', {
			coordinates: { component_tipo: T().auctionCompany, section_id: auctionSectionId },
			cause: save,
		});
	}
}

/**
 * Exact match on (Company Entity, Code) — a wrong match would silently
 * attach a lot to someone else's auction, worse than an occasional
 * duplicate. A `format:'relation'` SQO leaf (docs/core/sqo.md's "Relation
 * filter leaves") over the resolved Entity id, run WITH the caller's
 * principal — never a hand-written SQL WHERE that bypasses the engine's
 * search subsystem and its projects filter. Used by previewUrl (check only)
 * and findOrCreateAuction.
 */
async function findExistingAuction(
	companyEntityId: number,
	auctionNumber: string,
	context: ToolActionContext,
): Promise<number | null> {
	const sqo = sanitizeClientSqo({
		section_tipo: [T().auctionSection],
		limit: 1,
		filter: {
			$and: [
				{
					q: [
						{
							section_tipo: T().entitySection,
							section_id: companyEntityId,
							from_component_tipo: T().auctionCompany,
						},
					],
					path: [{ section_tipo: T().auctionSection, component_tipo: T().auctionCompany }],
					format: 'relation',
				},
				{
					q: `==${auctionNumber}`,
					path: [{ section_tipo: T().auctionSection, component_tipo: T().auctionCode }],
				},
			],
		},
	});
	const built = await buildSearchSql(sqo, { principal: context.principal });
	const rows = (await runSearch(built)) as {
		section_id: number;
	}[];
	return rows[0]?.section_id ?? null;
}

/**
 * Exact match on (Auction, Inventory number) — the dedup key a re-committed batch is checked
 * against (review item G: "re-committing the same lots duplicates them"), whenever the lot HAS a
 * resolved Auction and a lot number; findExistingLotByUrl covers the lots that don't. The Auction
 * relation + the Inventory number
 * (`inventoryNumber`, already written on every lot from `l.lotNumber`) together are already a
 * real, confirmed-working stand-in for "this exact lot": two DIFFERENT lots sharing the same number
 * under the SAME auction never happens in a real catalogue. Same `format:'relation'` SQO pattern as
 * findExistingAuction/findExistingType — never a hand-written SQL WHERE.
 */
async function findExistingLot(
	auctionSectionId: number,
	lotNumber: string,
	context: ToolActionContext,
): Promise<number | null> {
	const sqo = sanitizeClientSqo({
		section_tipo: [T().object],
		limit: 1,
		filter: {
			$and: [
				{
					q: [
						{
							section_tipo: T().auctionSection,
							section_id: auctionSectionId,
							from_component_tipo: T().auctionRelation,
						},
					],
					path: [{ section_tipo: T().object, component_tipo: T().auctionRelation }],
					format: 'relation',
				},
				{
					q: `==${lotNumber}`,
					path: [{ section_tipo: T().object, component_tipo: T().inventoryNumber }],
				},
			],
		},
	});
	const built = await buildSearchSql(sqo, { principal: context.principal });
	const rows = (await runSearch(built)) as {
		section_id: number;
	}[];
	return rows[0]?.section_id ?? null;
}

/**
 * Exact match on the lot's canonical URL (`sourceUri`) - the dedup key that needs no Auction:
 * a search-batch lot, a lot whose auction failed to resolve, or one with no lot number (review
 * item: "dedup gaps"). The stored value is written by this tool already canonical
 * (SourceAdapter.canonicalLotUrl - one spelling per lot), so the '==' leaf (builder_iri 'exact':
 * f_unaccent(iri) = f_unaccent(q)) is an exact URL match. Same principal-scoped SQO pattern as findExistingLot - never a hand-written
 * SQL WHERE.
 */
async function findExistingLotByUrl(
	lotUrl: string,
	context: ToolActionContext,
): Promise<number | null> {
	const sqo = sanitizeClientSqo({
		section_tipo: [T().object],
		limit: 1,
		filter: {
			$and: [
				{
					q: `==${lotUrl}`,
					path: [{ section_tipo: T().object, component_tipo: T().sourceUri }],
				},
			],
		},
	});
	const built = await buildSearchSql(sqo, { principal: context.principal });
	const rows = (await runSearch(built)) as {
		section_id: number;
	}[];
	return rows[0]?.section_id ?? null;
}

/** previewUrl/previewHtml's informational "does this auction already exist"
 * check — an exact-name Entity lookup (the same match the client's own
 * picker would land on for an unambiguous name) feeding the same SQO dedup
 * check commit time uses. Purely informational: the operator's actual pick
 * (possibly a different Entity, or "create new") is what commit_lots uses. */
async function checkExistingAuctionStatus(
	auctionHouse: string,
	auctionNumber: string,
	context: ToolActionContext,
): Promise<{ exists: boolean; section_id: number | null }> {
	if (auctionHouse === '' || auctionNumber === '') return { exists: false, section_id: null };
	const entityId = await findEntityByExactName(auctionHouse, context);
	const existingAuctionSectionId =
		entityId !== null ? await findExistingAuction(entityId, auctionNumber, context) : null;
	return { exists: existingAuctionSectionId !== null, section_id: existingAuctionSectionId };
}

/** Finds an existing numisdata224 Auction record, or creates one when none
 * matches — resolving (and, per `selection`, possibly creating) the Company
 * Entity first, since the dedup check itself needs a real entity id. One
 * transaction for the whole thing (Entity included): a failure partway used
 * to leave an unnamed orphan Auction (or Entity) behind — review item C1.
 * Locked on (entity, number) before the existence check: two concurrent
 * commit_lots jobs for the same sale used to both miss the lookup and both
 * create the Auction — review item C4. */
async function findOrCreateAuction(
	context: ToolActionContext,
	companySelection: CompanySelection,
	auctionNumber: string,
	title: string | null,
): Promise<{ sectionId: number; created: boolean }> {
	return withTransaction(async () => {
		const entityId = await resolveCompanyEntityId(context, companySelection);
		await acquireDedupLock(`numisdata224:${entityId}:`, auctionNumber);

		const found = await findExistingAuction(entityId, auctionNumber, context);
		if (found !== null) return { sectionId: found, created: false };

		const sectionId = await createSectionRecord(T().auctionSection, context.userId);
		await linkCompany(context, sectionId, entityId);
		await writeField(
			sectionId,
			T().auctionSection,
			T().auctionNumberTitle,
			formatAuctionNumberTitle(auctionNumber, title),
			context.userId,
		);
		await writeField(
			sectionId,
			T().auctionSection,
			T().auctionCode,
			auctionNumber,
			context.userId,
			currentDataLang(),
		);
		return { sectionId, created: true };
	});
}

/** Links numisdata4's Auction field to an EXISTING numisdata224 record — a
 * real relation (numisdata147 carries a `source` config), so this goes
 * through save_component.ts's validateRelationInsert path. */
async function linkAuction(
	context: ToolActionContext,
	lotSectionId: number,
	auctionSectionId: number,
): Promise<void> {
	const save = await saveComponentData({
		componentTipo: T().auctionRelation,
		sectionTipo: T().object,
		sectionId: lotSectionId,
		lang: NO_LANG,
		userId: context.userId,
		changedData: [
			{
				action: 'set_data',
				value: [
					{
						id: 1,
						type: RELATION_TYPE_LINK,
						section_id: auctionSectionId,
						section_tipo: T().auctionSection,
						from_component_tipo: T().auctionRelation,
					},
				],
			},
		],
	});
	if (!save.ok) {
		throw new DedaloError('record.save_failed', {
			coordinates: { component_tipo: T().auctionRelation, section_id: lotSectionId },
			cause: save,
		});
	}
}

/** Real Catalogue (numisdata300) name -> section_id, loaded once per commit
 * batch — small, stable reference data. */
type CatalogueIndex = Map<string, number>;

/** Loads every real, currently-curated Catalogue name, so a scraped citation
 * is matched against what this Dédalo instance actually curates, never a
 * hardcoded/guessed abbreviation list. An SQO run WITH the caller's principal
 * (buildSearchSql), not a hand-written SQL WHERE that bypassed the projects
 * filter and could leak a curator's out-of-scope Catalogue names into every
 * citation match (review item B3). `limit: 'all'` (set after sanitization,
 * the same override matchFreeName in tool_import_files uses): the index must
 * see every name the caller can read, not just the first page of them. */
async function loadCatalogueIndex(context: ToolActionContext): Promise<CatalogueIndex> {
	const index: CatalogueIndex = new Map();
	const sqo = sanitizeClientSqo({ section_tipo: [T().catalogueSection] });
	// Server-side override AFTER the gate (same as tool_import_files' matchFreeName):
	// the index must see every Catalogue name the caller can read, not just a page of them.
	sqo.limit = 'all';
	const built = await buildSearchSql(sqo, { principal: context.principal });
	const rows = (await runSearch(built)) as ({
		section_id: number;
	} & Record<string, unknown>)[];

	// The rows already carry the component's data column — same extraction as
	// matchFreeName, no per-record read needed.
	const model = await getModelByTipo(T().catalogueName);
	const column = model !== null ? getColumnNameByModel(model) : null;
	if (column === null) return index;
	for (const row of rows) {
		const payload = row[column] as Record<string, unknown> | null | undefined;
		const rawItems = payload?.[T().catalogueName];
		const items = (Array.isArray(rawItems) ? rawItems : rawItems == null ? [] : [rawItems]).filter(
			(item) => item !== null && item !== '',
		);
		const first = items[0];
		if (first === null || first === undefined) continue;
		const name =
			typeof first === 'object'
				? String((first as { value?: unknown }).value ?? '')
				: String(first);
		if (name) index.set(name, row.section_id);
	}
	return index;
}

/**
 * Best-effort extraction of a catalog citation ("ACIP-1759") from a lot's
 * description — matched ONLY against real, currently-curated Catalogue
 * names. Confirmed live: jesusvico descriptions also carry citations from
 * catalogs this instance does NOT curate (e.g. "I-109" — jesusvico's own
 * house numbering) alongside real ones ("ACIP-1759"); non-matches are
 * silently skipped rather than guessed at. Longest name checked first so
 * e.g. "RIC I" can't shadow "RIC I (second edition)".
 */
function extractCatalogueCitation(
	text: string | null,
	catalogueIndex: CatalogueIndex,
): { catalogueName: string; catalogueSectionId: number; code: string } | null {
	if (!text) return null;
	const names = [...catalogueIndex.keys()].sort((a, b) => b.length - a.length);
	for (const name of names) {
		const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const match = text.match(new RegExp(`\\b${escapedName}[\\s-]+(\\d+(?:[./]\\d+)?)`));
		if (match) {
			const catalogueSectionId = catalogueIndex.get(name);
			if (catalogueSectionId !== undefined) {
				return { catalogueName: name, catalogueSectionId, code: match[1]! };
			}
		}
	}
	return null;
}

/** Finds an EXISTING numisdata3 Type record matching a catalog citation —
 * deliberately never creates one (see TYPE_* constants for why). A
 * `format:'relation'` SQO leaf over the Catalogue relation + exact Code
 * text, run WITH the caller's principal (same pattern as findExistingAuction,
 * review item B3) — never a hand-written SQL WHERE that bypassed the
 * engine's search subsystem and its projects filter. */
async function findExistingType(
	catalogueSectionId: number,
	code: string,
	context: ToolActionContext,
): Promise<number | null> {
	const sqo = sanitizeClientSqo({
		section_tipo: [T().typeSection],
		limit: 1,
		filter: {
			$and: [
				{
					q: [
						{
							section_tipo: T().catalogueSection,
							section_id: catalogueSectionId,
							from_component_tipo: T().typeCatalogueRelation,
						},
					],
					path: [{ section_tipo: T().typeSection, component_tipo: T().typeCatalogueRelation }],
					format: 'relation',
				},
				{
					q: `==${code}`,
					path: [{ section_tipo: T().typeSection, component_tipo: T().typeCode }],
				},
			],
		},
	});
	const built = await buildSearchSql(sqo, { principal: context.principal });
	const rows = (await runSearch(built)) as {
		section_id: number;
	}[];
	return rows[0]?.section_id ?? null;
}

/** Links numisdata4's Type field to an EXISTING numisdata3 record — same
 * relation-write shape as linkAuction. */
async function linkType(
	context: ToolActionContext,
	lotSectionId: number,
	typeSectionId: number,
): Promise<void> {
	const save = await saveComponentData({
		componentTipo: T().typeRelation,
		sectionTipo: T().object,
		sectionId: lotSectionId,
		lang: NO_LANG,
		userId: context.userId,
		changedData: [
			{
				action: 'set_data',
				value: [
					{
						id: 1,
						type: RELATION_TYPE_LINK,
						section_id: typeSectionId,
						section_tipo: T().typeSection,
						from_component_tipo: T().typeRelation,
					},
				],
			},
		],
	});
	if (!save.ok) {
		throw new DedaloError('record.save_failed', {
			coordinates: { component_tipo: T().typeRelation, section_id: lotSectionId },
			cause: save,
		});
	}
}

/** One lot's outcome from commitLots. Every `*_error` is the error system's wire body
 * (toErrorBody(toDedaloError(...))), never a raw exception's own text property - review item E2:
 * that raw text can carry tipos, ids and SQL driver text to the client. */
interface CommitOneLotResult {
	lot_identifier: unknown;
	section_tipo: string;
	// null only when the item failed entirely (the transactional record+fields
	// write rolled back before creating anything) - `error` names why. A
	// partial record is never left behind: review item C1.
	section_id: number | null;
	error: ApiErrorBody | null;
	/** True when a numisdata4 record for this lot already existed - matched on (Auction, Inventory
	 * number) or on the lot's canonical URL. Nothing else in this result was attempted;
	 * section_id names the pre-existing record. Closes review item G: re-committing the same batch
	 * no longer duplicates every lot in it. */
	skipped: boolean;
	/** The written fields' display labels (ontology term, request application lang) - never tipos. */
	fields_written: string[];
	auction_section_id: number | null;
	auction_created: boolean | null;
	auction_error: ApiErrorBody | null;
	// null section_id covers both "no citation found" and "citation found but
	// no Type matched it" — type_citation distinguishes the two.
	type_section_id: number | null;
	type_citation: string | null;
	type_error: ApiErrorBody | null;
	/** One display entry per linked face ("<portal label> #<rsc170 id>"); null when no pair was
	 * imported - the pair is all-or-nothing, so never just one face. */
	images_created: string[] | null;
	images_error: ApiErrorBody | null;
	/** rsc170 ids created by a FAILED image import whose cleanup deletion also failed (logged with
	 * coordinates): records that may remain without media and need removing by hand. */
	images_orphaned: number[];
}

/** Display labels for written component tipos, in the request's application language (the job
 * manager pins the submitter's langs into a background job). Falls back to the tipo only when the
 * ontology has no term at all for it. */
async function fieldLabels(tipos: readonly string[]): Promise<string[]> {
	return Promise.all(tipos.map(async (tipo) => (await labelByTipo(tipo)) ?? tipo));
}

/** One resolved Auction, cached within a commitLots batch. */
interface ResolvedAuction {
	sectionId: number;
	created: boolean;
}

/** Resolves the Auction for ONE lot against a batch-shared cache, keyed on
 * (house, number) — a distinct auction resolves once no matter how many
 * lots in the batch share it. */
async function resolveAuctionCached(
	context: ToolActionContext,
	cache: Map<string, ResolvedAuction>,
	auctionHouse: string,
	auctionNumber: string,
	title: string | null,
	companySelection: CompanySelection,
): Promise<ResolvedAuction> {
	const key = `${auctionHouse} ${auctionNumber}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const resolved = await findOrCreateAuction(context, companySelection, auctionNumber, title);
	cache.set(key, resolved);
	return resolved;
}

/**
 * Biddr's and sixbid's search results label each lot's real auction as
 * "<House>, <Auction title>" (confirmed live for both). Splits it into a
 * per-lot Company + Number&title override so a search batch resolves each
 * lot against ITS OWN auction rather than the batch-level pseudo-auction.
 * The "number" half is really the title text (not always a bare digit), used
 * as both dedup key and display text.
 */
function splitSearchAuctionCategory(category: string): { house: string; label: string } | null {
	const idx = category.indexOf(', ');
	if (idx === -1) return null;
	const house = category.slice(0, idx).trim();
	const label = category.slice(idx + 2).trim();
	if (house === '' || label === '') return null;
	return { house, label };
}

/** The Type a lot's description cites, looked up (never linked) - read-only, so commitOneLot runs
 * it BEFORE the lot's birth transaction and links the result inside it. Best-effort: a failed
 * lookup is reported in `typeError` and leaves the lot unlinked, never fails it. */
async function matchLotType(
	context: ToolActionContext,
	description: string | null,
	catalogueIndex: CatalogueIndex,
): Promise<{
	typeSectionId: number | null;
	typeCitation: string | null;
	typeError: ApiErrorBody | null;
}> {
	let typeCitation: string | null = null;
	try {
		const citation = extractCatalogueCitation(description, catalogueIndex);
		if (citation === null) return { typeSectionId: null, typeCitation, typeError: null };
		typeCitation = `${citation.catalogueName}-${citation.code}`;
		const typeSectionId = await findExistingType(
			citation.catalogueSectionId,
			citation.code,
			context,
		);
		return { typeSectionId, typeCitation, typeError: null };
	} catch (error) {
		return { typeSectionId: null, typeCitation, typeError: toErrorBody(toDedaloError(error)) };
	}
}

/**
 * Creates a numisdata4 record from one previewed lot, writes its fields, and
 * resolves/links Auction, Type, and image. Auction RESOLUTION and Type LOOKUP
 * are best-effort and run before the record exists (a failure is surfaced in
 * the result and the lot is created unlinked); the LINKS are written in the
 * record's own birth transaction. The image import runs after it, best-effort
 * against a record that already exists with real fields on it.
 *
 * For most batches every lot shares the same batch-level auction info; for a
 * Biddr/sixbid search batch, each lot's own `category` overrides it (see
 * splitSearchAuctionCategory) so it resolves against its real auction.
 */
async function commitOneLot(
	context: ToolActionContext,
	lot: Record<string, unknown>,
	auctionHouse: string,
	auctionNumber: string,
	auctionTitle: string | null,
	auctionSourceDomain: string,
	// The operator's picker choice for the BATCH's own auction house — used
	// as-is when a lot doesn't override it (the common case). A biddr/sixbid
	// per-lot override (below) has no picker in the loop, so it auto-resolves
	// by exact name instead (still a real relation, never free text again).
	batchCompanySelection: CompanySelection,
	auctionCache: Map<string, ResolvedAuction>,
	catalogueIndex: CatalogueIndex,
	// The lot's canonical URL (commitLots: canonicalLotUrlKey) when its source can rebuild one
	// from the lot's own identity, else null. Stored in `sourceUri` and used as the
	// auction-independent dedup key.
	lotUrlKey: string | null,
): Promise<CommitOneLotResult> {
	const l = lot;
	// Hoisted out of the transaction below - extractCatalogueCitation (Type
	// matching, outside the transaction) needs it too.
	const description = typeof l.description === 'string' ? l.description : null;
	// Hoisted for the dedup check below, which needs it BEFORE the transaction - the write path
	// further down still reads `l.lotNumber` directly (untrimmed), unchanged.
	const lotNumber = typeof l.lotNumber === 'string' ? l.lotNumber.trim() : '';

	let effectiveAuctionHouse = auctionHouse;
	let effectiveAuctionNumber = auctionNumber;
	let effectiveAuctionTitle = auctionTitle;
	// Gated on domain alone, this fired for an ORDINARY sixbid listing too: its
	// normal (non-search) lots also populate `category`, just with the coin's
	// own category name ("Roman Provincial, Asia Minor") - which also contains
	// a comma, so splitSearchAuctionCategory "succeeded" on it, silently
	// creating a bogus Entity/Auction and discarding the operator's actual
	// picked company (review item C3). `auctionHouse` is the batch's own
	// ExtractedAuction, unmodified from preview_url - both search parsers
	// (parseSearchAuction, parseSixbidSearchAuction) stamp it with this exact
	// sentinel, a real signal "this batch IS a search", not a domain guess.
	const isSearchCategorySource =
		(auctionSourceDomain === 'biddr.com' || auctionSourceDomain === 'sixbid.com') &&
		auctionHouse === 'Multiple auction houses';
	if (isSearchCategorySource) {
		// A search batch has no single real auction at all - 'Multiple auction houses' and the
		// search hash (auctionNumber) are SENTINELS, not a real auction, so this lot's own category
		// is the ONLY source of truth for it. A lot whose category doesn't split into a real (house,
		// number) pair gets NO auction here, rather than falling through to the sentinels and
		// inventing an Entity literally named "Multiple auction houses" and an Auction titled with
		// the search hash (review item: "search batches create junk records").
		const split =
			typeof l.category === 'string' && l.category !== ''
				? splitSearchAuctionCategory(l.category)
				: null;
		effectiveAuctionHouse = split?.house ?? '';
		effectiveAuctionNumber = split?.label ?? '';
		effectiveAuctionTitle = split?.label ?? null;
	}

	// Resolved BEFORE the lot record (review item G: "re-committing the same lots duplicates
	// them") - a re-commit needs the Auction's section_id to check whether THIS lot already
	// exists under it, below, before writing anything new.
	let auctionSectionId: number | null = null;
	let auctionCreated: boolean | null = null;
	let auctionError: ApiErrorBody | null = null;
	if (effectiveAuctionHouse !== '' && effectiveAuctionNumber !== '') {
		try {
			// No picker ever ran for a per-lot override (it's only known after
			// parsing THIS lot) — auto-resolve it the same safe way the picker's
			// own fallback does, rather than leaving it as free text again.
			const companySelection =
				effectiveAuctionHouse === auctionHouse
					? batchCompanySelection
					: await resolveCompanySelectionByName(effectiveAuctionHouse, context);
			const resolved = await resolveAuctionCached(
				context,
				auctionCache,
				effectiveAuctionHouse,
				effectiveAuctionNumber,
				effectiveAuctionTitle,
				companySelection,
			);
			auctionSectionId = resolved.sectionId;
			auctionCreated = resolved.created;
		} catch (error) {
			auctionError = toErrorBody(toDedaloError(error));
		}
	}

	// The Type is LOOKED UP here, before the transaction (read-only, best-effort: a failed lookup
	// leaves the lot unlinked and reports why) - and LINKED inside it, below.
	const typeMatch = await matchLotType(context, description, catalogueIndex);
	const typeSectionId = typeMatch.typeSectionId;

	// One transaction for the dedup check + the record + its own core fields + its Auction and
	// Type links (the record's whole birth): a writeField throw used to escape uncaught, leaving a
	// half-written record behind with no way to report it (review item C1), and links written
	// after the commit left a window in which a curator's edit of the just-born record could be
	// replaced by them. A link that fails now rolls the whole lot back (reported in `error`,
	// retried on the next commit) - there is no savepoint to keep the record without it. Only
	// the image import stays OUTSIDE: it runs the media pipeline (files on disk, its own
	// all-or-nothing cleanup) against a record that, past this point, is real and complete. Locked and
	// RE-CHECKED under the lock (review item G/C4): findExistingLot below ran with no lock, so two
	// concurrent commits of the SAME lot would otherwise both miss it and both create one.
	//
	// Two dedup keys, each with its own lock, checked under BOTH locks before anything is created:
	// (Auction, lot number) where the lot has both, and the canonical lot URL where its source
	// can rebuild one from the lot's own identity (review item: "dedup gaps" - a search-batch lot, an unresolved auction or
	// an empty lot number used to skip dedup entirely). Either match means "already imported".
	// Lock ORDER is fixed (lot key, then URL key) in every transaction that takes both, and a
	// transaction taking only one cannot close a cycle - so two commits never deadlock on them.
	const lotKeyAvailable = auctionSectionId !== null && lotNumber !== '';
	const { sectionId, fieldsWritten, skipped } = await withTransaction(async () => {
		if (lotKeyAvailable) {
			await acquireDedupLock(`numisdata4:lot:${auctionSectionId}:`, lotNumber);
		}
		if (lotUrlKey !== null) {
			await acquireDedupLock('numisdata4:url:', lotUrlKey);
		}
		const existingLotSectionId =
			(lotKeyAvailable && auctionSectionId !== null
				? await findExistingLot(auctionSectionId, lotNumber, context)
				: null) ?? (lotUrlKey !== null ? await findExistingLotByUrl(lotUrlKey, context) : null);
		if (existingLotSectionId !== null) {
			return {
				sectionId: existingLotSectionId,
				fieldsWritten: [] as string[],
				skipped: true as const,
			};
		}
		const newSectionId = await createSectionRecord(T().object, context.userId);

		const written: string[] = [];
		const weight = parseLeadingNumber(l.weight);
		if (weight !== null) {
			await writeField(newSectionId, T().object, T().weight, weight, context.userId);
			written.push(T().weight);
		}
		const diameter = parseLeadingNumber(l.diameter);
		if (diameter !== null) {
			await writeField(newSectionId, T().object, T().diameter, diameter, context.userId);
			written.push(T().diameter);
		}
		if (lotNumber !== '') {
			// Writes the SAME trimmed value findExistingLot's dedup lookup matches on - writing the
			// untrimmed l.lotNumber here (while the lookup compared against the trimmed one) meant a
			// lot number with incidental whitespace never matched its own stored value on a
			// re-commit's exact '==' search, duplicating the lot (review item: dedup gaps).
			await writeField(newSectionId, T().object, T().inventoryNumber, lotNumber, context.userId);
			written.push(T().inventoryNumber);
		}
		if (typeof l.datePeriod === 'string' && l.datePeriod.trim() !== '') {
			await writeField(
				newSectionId,
				T().object,
				T().dateText,
				l.datePeriod,
				context.userId,
				currentDataLang(),
			);
			written.push(T().dateText);
		}
		const { obverse: obverseDesign, reverse: reverseDesign } = splitJesusvicoDesign(description);
		if (obverseDesign !== null) {
			await writeField(
				newSectionId,
				T().object,
				T().obverseDesign,
				obverseDesign,
				context.userId,
				currentDataLang(),
			);
			written.push(T().obverseDesign);
		}
		if (reverseDesign !== null) {
			await writeField(
				newSectionId,
				T().object,
				T().reverseDesign,
				reverseDesign,
				context.userId,
				currentDataLang(),
			);
			written.push(T().reverseDesign);
		}
		if (
			obverseDesign === null &&
			reverseDesign === null &&
			description !== null &&
			description.trim() !== ''
		) {
			await writeField(
				newSectionId,
				T().object,
				T().publicRemark,
				description,
				context.userId,
				currentDataLang(),
			);
			written.push(T().publicRemark);
		}
		if (lotUrlKey !== null) {
			// Written in the SAME canonical form findExistingLotByUrl matches on, inside the same
			// transaction as the record: a lot is never committed without the key that dedups it.
			await writeIriField(newSectionId, T().object, T().sourceUri, lotUrlKey, context.userId);
			written.push(T().sourceUri);
		}
		// The links, in the birth transaction (see above). The Auction was resolved before it
		// (auctionSectionId is null when it failed - auction_error says why).
		if (auctionSectionId !== null) {
			await linkAuction(context, newSectionId, auctionSectionId);
			written.push(T().auctionRelation);
		}
		if (typeSectionId !== null) {
			await linkType(context, newSectionId, typeSectionId);
			written.push(T().typeRelation);
		}
		return { sectionId: newSectionId, fieldsWritten: written, skipped: false as const };
	});

	if (skipped) {
		return {
			lot_identifier: l.lotIdentifier,
			section_tipo: T().object,
			section_id: sectionId,
			error: null,
			skipped: true,
			fields_written: [],
			auction_section_id: auctionSectionId,
			auction_created: auctionCreated,
			auction_error: auctionError,
			type_section_id: null,
			type_citation: null,
			type_error: null,
			images_created: null,
			images_error: null,
			images_orphaned: [],
		};
	}

	let imagesCreated: string[] | null = null;
	let imagesError: ApiErrorBody | null = null;
	let imagesOrphaned: number[] = [];
	const imageImport = await importImagesForLot(context, l, sectionId);
	if (imageImport.imported) {
		const portalLabels = await fieldLabels(imageImport.created.map((image) => image.portalTipo));
		imagesCreated = imageImport.created.map(
			(image, index) => `${portalLabels[index]} #${image.sectionId}`,
		);
	} else {
		imagesError = toErrorBody(toDedaloError(imageImport.cause));
		imagesOrphaned = imageImport.orphaned;
	}

	return {
		lot_identifier: l.lotIdentifier,
		section_tipo: T().object,
		section_id: sectionId,
		error: null,
		skipped: false,
		fields_written: await fieldLabels(fieldsWritten),
		auction_section_id: auctionSectionId,
		auction_created: auctionCreated,
		auction_error: auctionError,
		type_section_id: typeSectionId,
		type_citation: typeMatch.typeCitation,
		type_error: typeMatch.typeError,
		images_created: imagesCreated,
		images_error: imagesError,
		images_orphaned: imagesOrphaned,
	};
}

/**
 * The lot's canonical URL key, rebuilt by the BATCH's source adapter from the lot's own identity
 * (SourceAdapter.canonicalLotUrl), or null when that source has none (aureo) or the lot's identity
 * cannot be established - then the lot dedups on (Auction, lot number) only. The adapter is picked
 * server-side by the batch's source domain, and the builder re-validates every client-sent field.
 */
function canonicalLotUrlKey(
	adapter: SourceAdapter | undefined,
	lot: Record<string, unknown>,
): string | null {
	return (
		adapter?.canonicalLotUrl?.({
			lotIdentifier: lot.lotIdentifier,
			lotNumber: lot.lotNumber,
			sourceUrl: lot.sourceUrl,
		}) ?? null
	);
}

/**
 * The canonical URL keys that are AMBIGUOUS within this batch: one key carried by two or more
 * DIFFERENT lots (by lotIdentifier). A key is rebuilt from the lot's identity, so this should
 * never happen; if it ever does (a parser defect, a tampered payload), deduplicating on it would
 * collapse distinct lots into the first one - so such a key is no key at all for this batch. A lot
 * with no identifier never reaches here: canonicalLotUrl gives it no key in the first place.
 */
function ambiguousLotUrlKeys(
	keyedLots: readonly { key: string; lotIdentifier: string }[],
): Set<string> {
	const lotIdsByKey = new Map<string, Set<string>>();
	for (const { key, lotIdentifier } of keyedLots) {
		const ids = lotIdsByKey.get(key) ?? new Set<string>();
		ids.add(lotIdentifier);
		lotIdsByKey.set(key, ids);
	}
	const ambiguous = new Set<string>();
	for (const [key, ids] of lotIdsByKey) if (ids.size > 1) ambiguous.add(key);
	return ambiguous;
}

/** Each lot's canonical URL key for this batch (index-aligned with `lots`; null = no URL key):
 * canonicalLotUrlKey, minus the keys ambiguousLotUrlKeys finds. */
function batchLotUrlKeys(lots: readonly unknown[], sourceDomain: string): (string | null)[] {
	const adapter = ADAPTERS.find((candidate) => candidate.sourceDomain === sourceDomain);
	const keys = lots.map((lot) =>
		lot !== null && typeof lot === 'object'
			? canonicalLotUrlKey(adapter, lot as Record<string, unknown>)
			: null,
	);
	const keyed: { key: string; lotIdentifier: string }[] = [];
	keys.forEach((key, index) => {
		const lotIdentifier = (lots[index] as Record<string, unknown> | null)?.lotIdentifier;
		// canonicalLotUrl only ever keys a lot with a non-empty string identifier.
		if (key !== null && typeof lotIdentifier === 'string') {
			keyed.push({ key, lotIdentifier: lotIdentifier.trim() });
		}
	});
	const ambiguous = ambiguousLotUrlKeys(keyed);
	return keys.map((key) => (key !== null && !ambiguous.has(key) ? key : null));
}

/**
 * Commits a curated batch of lots from the review screen. Runs as a
 * background job — a real batch (dozens to hundreds of lots, each a record
 * create + several field writes + an image download/crop/link) is easily
 * minutes, long enough to hit the client's retry window. Progress is
 * published per lot.
 */
async function commitLots(context: ToolActionContext): Promise<ToolResponse> {
	const lots = context.options.lots;
	if (!Array.isArray(lots) || lots.length === 0) {
		throw new DedaloError('request.invalid_options', {
			message:
				'commit_lots requires a non-empty "lots" array (from preview_url, minus any excluded).',
			publicMessage: 'No lots to import — run Preview first, then keep at least one lot.',
		});
	}
	// Defense in depth against a malformed/adversarial payload (preview_url/preview_html already
	// cap at MAX_LOTS, so a normal client never sends more than that): refuse rather than silently
	// truncate, since this is a WRITE action — truncating would commit a batch the operator never
	// reviewed as "the whole thing".
	if (lots.length > MAX_LOTS) {
		throw new DedaloError('request.invalid_options', {
			message: `commit_lots received ${lots.length} lots, over the ${MAX_LOTS} cap.`,
			publicMessage: `Too many lots in one batch (${lots.length} > ${MAX_LOTS}). Split the import into smaller batches.`,
		});
	}
	const auction = context.options.auction;
	const a =
		auction !== null && typeof auction === 'object' ? (auction as Record<string, unknown>) : null;
	const auctionHouse = typeof a?.auctionHouse === 'string' ? a.auctionHouse.trim() : '';
	// Falls back to the adapter's own auctionIdentifier when auctionNumber is
	// empty — numisbids' sale page exposes no separate human-facing number,
	// which was silently skipping Auction resolution for every numisbids lot.
	const rawAuctionNumber = typeof a?.auctionNumber === 'string' ? a.auctionNumber.trim() : '';
	const auctionNumber =
		rawAuctionNumber !== ''
			? rawAuctionNumber
			: typeof a?.auctionIdentifier === 'string'
				? a.auctionIdentifier.trim()
				: '';
	const auctionTitle =
		typeof a?.title === 'string' && a.title.trim() !== '' ? a.title.trim() : null;
	const auctionSourceDomain = typeof a?.sourceDomain === 'string' ? a.sourceDomain : '';

	// The client's picker resolution for the batch's OWN auction house (search
	// → confirm existing / create new — never a bare string). A missing or
	// malformed selection falls back to the same auto-resolve-by-name the
	// biddr/sixbid per-lot override uses, rather than hard-failing a commit
	// whose picker search hadn't finished — still a real relation either way.
	const rawSelection = context.options.company_selection;
	const s =
		rawSelection !== null && typeof rawSelection === 'object'
			? (rawSelection as Record<string, unknown>)
			: null;
	// A client-sent section_id is trusted with no existence/read check -
	// review item B2. isRecordInScope runs the SAME principal-scoped
	// existence search the permission gate itself uses (src/core/security/
	// record_scope.ts), so a fabricated or out-of-scope id is caught here
	// instead of linking the Auction's Company to a record the caller can't
	// even see.
	const candidateEntityId =
		s !== null && Number.isInteger(s.section_id) && Number(s.section_id) > 0
			? Number(s.section_id)
			: null;
	const candidateEntityReadable =
		candidateEntityId !== null &&
		(context.principal.isGlobalAdmin ||
			(await isRecordInScope(T().entitySection, candidateEntityId, context.principal)));
	let companySelection: CompanySelection;
	if (candidateEntityId !== null && candidateEntityReadable) {
		companySelection = { sectionId: candidateEntityId };
	} else if (
		s !== null &&
		s.create === true &&
		typeof s.name === 'string' &&
		s.name.trim() !== ''
	) {
		companySelection = { create: true, name: s.name.trim() };
	} else if (auctionHouse !== '') {
		companySelection = await resolveCompanySelectionByName(auctionHouse, context);
	} else {
		// No company info in the batch's own auction at all — commitOneLot's
		// `effectiveAuctionHouse !== ''` guard means this value is never read.
		companySelection = { create: true, name: '' };
	}

	const auctionCache = new Map<string, ResolvedAuction>();
	const catalogueIndex = await loadCatalogueIndex(context);
	const lotUrlKeys = batchLotUrlKeys(lots, auctionSourceDomain);
	const results: CommitOneLotResult[] = [];
	let counter = 0;
	let stopped = false;
	for (const [lotIndex, lot] of lots.entries()) {
		// Checked at the loop boundary, same idiom as tool_import_files: a lot is committed whole or
		// not at all (C1's own transaction already guarantees that per lot), so stopping HERE never
		// leaves a half-written record - it just leaves the REST of the batch uncommitted, reported
		// back as a partial summary rather than running to completion regardless of Stop (review item:
		// "the cancel signal is never read" - a 3000-lot import at >=3s/request otherwise runs 2.5h+
		// and holds its media lane slot the whole time, impossible to end).
		if (context.signal?.aborted) {
			stopped = true;
			break;
		}
		if (lot === null || typeof lot !== 'object') continue;
		counter += 1;
		const l = lot as Record<string, unknown>;
		const lotUrlKey = lotUrlKeys[lotIndex] ?? null;
		context.publishProgress?.({
			msg: `Creating record for lot ${typeof l.lotNumber === 'string' ? l.lotNumber : counter}`,
			counter,
			total: lots.length,
		});
		// Never narrow scope silently: a commitOneLot throw (e.g. its own
		// transaction rolling back) must not abort the rest of the batch, or
		// every lot already committed goes unreported and gets duplicated on
		// retry (review item C1).
		try {
			results.push(
				await commitOneLot(
					context,
					l,
					auctionHouse,
					auctionNumber,
					auctionTitle,
					auctionSourceDomain,
					companySelection,
					auctionCache,
					catalogueIndex,
					lotUrlKey,
				),
			);
		} catch (error) {
			results.push({
				lot_identifier: l.lotIdentifier,
				section_tipo: T().object,
				section_id: null,
				error: toErrorBody(toDedaloError(error)),
				skipped: false,
				fields_written: [],
				auction_section_id: null,
				auction_created: null,
				auction_error: null,
				type_section_id: null,
				type_citation: null,
				type_error: null,
				images_created: null,
				images_error: null,
				images_orphaned: [],
			});
		}
	}

	return ok({ results, stopped, lots_total: lots.length }, { requestId: toolRequestId(context) });
}

export const tool: ToolServerModule = {
	name: 'tool_numisdata_acquisition',
	apiActions: {
		// Read-only: fetches external data + a read-only Auction check, writes nothing.
		// 'targets' (not 'section'): previewUrl's own `options.section_tipo`, if the client sends
		// one at all, is NEVER what actually gets touched - the handler always fetches/parses
		// against numisdata4. A 'section' gate reading the client's OWN field let any user who can
		// read ANY section start a live outbound fetch (review item: "preview actions are gated on
		// any section"), since nothing stopped them sending an unrelated but readable section_tipo.
		preview_url: {
			permission: 'targets',
			minLevel: 1,
			targets: () => [{ section_tipo: T().object }],
			handler: previewUrl,
		},
		// Same gate - no network request (parses HTML the operator already fetched), but still
		// never gated on a client-sent section_tipo for the same reason as preview_url.
		preview_html: {
			permission: 'targets',
			minLevel: 1,
			targets: () => [{ section_tipo: T().object }],
			handler: previewHtml,
		},
		// Write: resolves Auction/Type, creates one record per kept lot, imports images.
		// 'targets' (not 'section'): the handler always writes numisdata4/
		// numisdata224/rsc170/rsc106 regardless of what options.section_tipo says,
		// so the gate must name those fixed targets rather than trust the client's
		// value. Each (section, component) PAIR is named too, not just the bare
		// section - a section grant is not authority over a component the profile
		// denies (review item B1), so e.g. a profile allowed to edit numisdata4 but
		// denied numisdata147 (the Auction relation) or rsc29 (the image) must not
		// be able to have this tool write them anyway.
		commit_lots: {
			permission: 'targets',
			minLevel: 2,
			targets: () => [
				{ section_tipo: T().object },
				{ section_tipo: T().object, tipo: T().weight },
				{ section_tipo: T().object, tipo: T().diameter },
				{ section_tipo: T().object, tipo: T().inventoryNumber },
				{ section_tipo: T().object, tipo: T().dateText },
				{ section_tipo: T().object, tipo: T().obverseDesign },
				{ section_tipo: T().object, tipo: T().reverseDesign },
				{ section_tipo: T().object, tipo: T().publicRemark },
				{ section_tipo: T().object, tipo: T().sourceUri },
				{ section_tipo: T().object, tipo: T().auctionRelation },
				{ section_tipo: T().object, tipo: T().typeRelation },
				{ section_tipo: T().object, tipo: T().obversePortal },
				{ section_tipo: T().object, tipo: T().reversePortal },
				{ section_tipo: T().auctionSection },
				{ section_tipo: T().auctionSection, tipo: T().auctionCompany },
				{ section_tipo: T().auctionSection, tipo: T().auctionNumberTitle },
				{ section_tipo: T().auctionSection, tipo: T().auctionCode },
				// Company may now resolve to a NEW rsc106 Entity (review item 9's
				// fix), not just an existing one linked read-only.
				{ section_tipo: T().entitySection },
				{ section_tipo: T().entitySection, tipo: T().entityName },
				{ section_tipo: T().imageSection },
				{ section_tipo: T().imageSection, tipo: T().imageComponent },
			],
			handler: commitLots,
		},
	},
	// Both run in the background — each is slow enough that the client drives
	// them as jobs with live progress rather than one synchronous request.
	backgroundRunnable: ['preview_url', 'commit_lots'],
	// preview_url scrapes the auction site; commit_lots downloads/crops lot
	// images, so it spends the media budget (PERF-11 lane declaration).
	backgroundLanes: { preview_url: 'maintenance', commit_lots: 'media' },
	// Scopes the toolbar button to numisdata4 only (register.json's
	// affected_models:["section"] has no narrower scope of its own).
	isAvailable: (availabilityContext) => availabilityContext.sectionTipo === T().object,
};
