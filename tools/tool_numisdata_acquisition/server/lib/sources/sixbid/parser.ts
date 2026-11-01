import type { AuctionStatus, ExtractedAuction } from '../../domain/auction.ts';
import type { ExtractedImage, ExtractedLot } from '../../domain/lot.ts';
import {
	cleanMultilineText,
	cleanText,
	extractDenomination,
	extractDiameter,
	extractMaterial,
	extractRulerAndDate,
	extractWeight,
} from '../../extraction/parser-utils.ts';
import { sixbidLotIdentifier, sixbidSearchIdentifier } from './api.ts';
import { sixbidImageUrl } from './image.ts';

interface SixbidLotItem {
	companySlug: string;
	companyName: string | null;
	auctionId: number;
	auctionName: string | null;
	auctionDescription: string | null;
	auctionStart: string | null;
	auctionEnd: string | null;
	auctionOnlineEnd: string | null;
	auctionCurrency: string | null;
	auctionSlug: string | null;
	categoryName: string | null;
	categorySlug: string | null;
	lotId: number;
	lotNumber: number | string;
	lotNumberAffix: string | null;
	lotSlug: string | null;
	lotDescription: string | null;
	lotShortDescription: string | null;
	lotEstimate: number | null;
	lotStartingPrice: number | null;
	lotPriceRealised: number | null;
	googleBucketImagePath: string | null;
	hasImage: number;
}

interface SixbidApiPage {
	total_items: number;
	items: SixbidLotItem[];
}

/** One group in a site-wide search response - every lot in `lots` belongs to this real auction.
 * Confirmed live: a search lot item doesn't itself carry `auctionName` - only the group does - so
 * parseSixbidSearchLots threads it down. */
interface SixbidSearchGroup {
	auctionId: number;
	auctionName: string | null;
	companyName: string | null;
	lots: SixbidLotItem[];
}

interface SixbidSearchResponse {
	terms?: string[];
	total_items: number;
	items: SixbidSearchGroup[];
}

/**
 * sixbid's single-lot endpoint (`/v2/{company}/{auction}/{lotId}/`) returns the lot's fields
 * directly at the top level rather than wrapped in `{items: [...]}` like a listing page - detected
 * by a numeric `lotId` with no `items` array, and normalized to the same shape so
 * parseSixbidAuction/parseSixbidLots don't need their own separate single-lot logic.
 */
function parsePage(rawJson: string): SixbidApiPage {
	const parsed = JSON.parse(rawJson);
	if (
		parsed &&
		typeof parsed === 'object' &&
		!Array.isArray(parsed.items) &&
		typeof parsed.lotId === 'number'
	) {
		return { total_items: 1, items: [parsed as SixbidLotItem] };
	}
	return parsed as SixbidApiPage;
}

/**
 * sixbid's `auctionStatus` field exists but its enum values weren't confirmed from live sampling
 * - rather than guess, derive status from dates the same way Biddr's own parseTimetable does.
 */
function deriveStatus(startDate: string | null, endDate: string | null): AuctionStatus {
	const now = Date.now();
	const start = startDate ? new Date(startDate).getTime() : Number.NaN;
	const end = endDate ? new Date(endDate).getTime() : Number.NaN;
	if (!Number.isNaN(end) && end <= now) return 'closed';
	if (!Number.isNaN(start) && start > now) return 'upcoming';
	if (!Number.isNaN(start) || !Number.isNaN(end)) return 'live';
	return 'unknown';
}

function toIso(dateText: string | null | undefined): string | null {
	if (!dateText) return null;
	const parsed = new Date(dateText.replace(' ', 'T'));
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Extracts auction-level metadata from a sixbid lots-API page. Unlike Biddr (where auction
 * metadata and lot listings come from the same server-rendered HTML page), sixbid's JSON API
 * denormalizes the auction's fields onto every lot item - we just read them off the first one.
 */
export function parseSixbidAuction(rawJson: string, sourceUrl: string): ExtractedAuction {
	const page = parsePage(rawJson);
	const first = page.items[0];
	if (!first) {
		return {
			sourceUrl,
			sourceDomain: 'sixbid.com',
			auctionIdentifier: '',
			auctionHouse: null,
			title: null,
			auctionNumber: null,
			description: null,
			location: null,
			startDate: null,
			endDate: null,
			status: 'unknown',
			lotCount: page.total_items ?? 0,
			categories: [],
			raw: {},
		};
	}

	const startDate = toIso(first.auctionStart);
	const endDate = toIso(first.auctionOnlineEnd ?? first.auctionEnd);
	const auctionNumberMatch = first.auctionName?.match(/(\d+)/);

	return {
		sourceUrl,
		sourceDomain: 'sixbid.com',
		auctionIdentifier: String(first.auctionId),
		auctionHouse: cleanText(first.companyName),
		title: cleanText(first.auctionName),
		auctionNumber: auctionNumberMatch?.[1] ?? null,
		description: cleanText(first.auctionDescription),
		location: null,
		startDate,
		endDate,
		status: deriveStatus(startDate, endDate),
		lotCount: page.total_items ?? null,
		categories: [],
		raw: { companySlug: first.companySlug, auctionSlug: first.auctionSlug },
	};
}

/**
 * Builds a pseudo-auction for a single-lot URL - reuses parseSixbidAuction's field extraction
 * wholesale (the single-lot endpoint denormalizes the same auction fields onto its one lot),
 * overriding auctionIdentifier to the lot-scoped one and lotCount to 1.
 */
export function parseSixbidSingleLotAuction(rawJson: string, sourceUrl: string): ExtractedAuction {
	const base = parseSixbidAuction(rawJson, sourceUrl);
	return {
		...base,
		auctionIdentifier: sixbidLotIdentifier(sourceUrl) ?? base.auctionIdentifier,
		lotCount: 1,
	};
}

/**
 * Builds the pseudo-auction representing one sixbid site-wide search. Deliberately not framed as
 * a single real auction (auctionHouse/dates don't apply to a search spanning many companies' own
 * auctions) - same honest-labeling approach as Biddr's parseSearchAuction.
 */
export function parseSixbidSearchAuction(rawJson: string, sourceUrl: string): ExtractedAuction {
	const page = JSON.parse(rawJson) as SixbidSearchResponse;

	let term = page.terms?.[0] ?? '';
	if (!term) {
		try {
			term = new URL(sourceUrl).searchParams.get('term') ?? '';
		} catch {
			// sourceUrl is validated well before this point - defensive only.
		}
	}

	const lotCount = page.total_items ?? 0;

	return {
		sourceUrl,
		sourceDomain: 'sixbid.com',
		auctionIdentifier: sixbidSearchIdentifier(sourceUrl) ?? '',
		auctionHouse: 'Multiple auction houses',
		title: `Search: "${term}"`,
		auctionNumber: null,
		description: null,
		location: null,
		startDate: null,
		endDate: null,
		status: 'unknown',
		lotCount: lotCount > 0 ? lotCount : null,
		categories: [],
		raw: { term },
	};
}

/** Maps one raw lot item (from either the listing or single-lot endpoint) into our domain shape.
 * `categoryOverride` lets a search response attach the lot's real originating auction into
 * `category` instead of its coin category - null for a normal listing/single-lot lot. */
function mapSixbidLotItem(
	item: SixbidLotItem,
	categoryOverride: string | null = null,
): ExtractedLot {
	const description = cleanMultilineText(item.lotDescription);
	const title = cleanText(item.lotShortDescription) ?? description;

	const images: ExtractedImage[] = [];
	if (item.hasImage && item.googleBucketImagePath) {
		images.push({
			sourceUrl: sixbidImageUrl(item.googleBucketImagePath, 'o'),
			order: 0,
			width: null,
			height: null,
		});
	}

	const { ruler, datePeriod } = extractRulerAndDate(title);
	// lotEstimate uses 0 to mean "no estimate given" (observed on lots with no traditional
	// estimate range) rather than a literal $0 estimate.
	const estimate = item.lotEstimate && item.lotEstimate > 0 ? item.lotEstimate : null;

	// Confirmed live: .../en/{companySlug}/{auctionId}/{categorySlug}/{lotId}/{lotSlug} is a real,
	// working per-lot page, built from fields the API already denormalizes onto every item. Left
	// null only if categorySlug is missing, rather than guessing at an unconfirmed URL shape.
	const sourceUrl =
		item.categorySlug && item.lotSlug
			? `https://www.sixbid.com/en/${item.companySlug}/${item.auctionId}/${item.categorySlug}/${item.lotId}/${item.lotSlug}`
			: null;

	return {
		sourceUrl,
		lotIdentifier: `sixbid:${item.lotId}`,
		lotNumber: `${item.lotNumber}${item.lotNumberAffix ?? ''}`,
		title,
		description,
		descriptionHtml: null,
		category: categoryOverride ?? cleanText(item.categoryName),
		estimateLow: estimate,
		estimateHigh: estimate,
		startingPrice: item.lotStartingPrice ?? null,
		realizedPrice: item.lotPriceRealised ?? null,
		currency: item.auctionCurrency ?? null,
		weight: extractWeight(description),
		diameter: extractDiameter(description),
		material: extractMaterial(description),
		mint: null,
		ruler,
		denomination: extractDenomination(description ?? title),
		datePeriod,
		condition: null,
		referenceNumber: null,
		detailFetched: true,
		images,
		raw: {
			companySlug: item.companySlug,
			auctionSlug: item.auctionSlug,
			lotSlug: item.lotSlug,
			categorySlug: item.categorySlug,
		},
	};
}

/**
 * Extracts every lot from one sixbid lots-API page. The API already provides full per-lot detail
 * (unlike Biddr, no separate lot-detail-page fetch is needed) - detailFetched is always true.
 */
export function parseSixbidLots(rawJson: string): ExtractedLot[] {
	const page = parsePage(rawJson);
	return page.items.map((item) => mapSixbidLotItem(item));
}

/**
 * Extracts every lot from one page of a sixbid site-wide search - unlike a normal listing page's
 * flat `items[]`, a search response groups lots under the real auction each belongs to, so this
 * flattens that grouping back out. `category` is formatted "<Company>, <Auction title>" - the same
 * convention Biddr's own search-divider text uses, confirmed live for both independently.
 */
export function parseSixbidSearchLots(rawJson: string): ExtractedLot[] {
	const page = JSON.parse(rawJson) as SixbidSearchResponse;
	const lots: ExtractedLot[] = [];
	for (const group of page.items ?? []) {
		const company = cleanText(group.companyName);
		const title = cleanText(group.auctionName);
		const groupLabel = company && title ? `${company}, ${title}` : (company ?? title);
		for (const item of group.lots ?? []) {
			lots.push(mapSixbidLotItem(item, groupLabel));
		}
	}
	return lots;
}
