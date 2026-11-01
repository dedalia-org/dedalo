import * as cheerio from 'cheerio';
import type { AuctionStatus, ExtractedAuction } from '../../domain/auction.ts';
import type { ExtractedImage, ExtractedLot } from '../../domain/lot.ts';
import {
	cleanText,
	extractDenomination,
	extractMaterial,
	extractRulerAndDate,
	parseEuropeanDateText,
	parseEuropeanPrice,
} from '../../extraction/parser-utils.ts';
import {
	jesusvicoLotIdentifier,
	parseJesusvicoAuctionNumber,
	parseJesusvicoLotNumber,
} from './identifiers.ts';

function absoluteUrl(href: string | undefined | null, base: string): string | null {
	if (!href) return null;
	try {
		return new URL(href, base).toString();
	} catch {
		return null;
	}
}

/**
 * jesusvico serves lot photos through a "/thumbs/838/" bucket by default; the full-resolution
 * original lives at the same path with that segment removed (confirmed live: 838x425px thumbnail
 * vs. 2659x1350px original for the same photo).
 */
function toFullResolutionUrl(url: string): string {
	return url.replace(/\/thumbs\/838\//, '/');
}

/** Total pagination pages: the max page number found among ?page=N links (no dedicated "last
 * page" control exists). */
export function parseJesusvicoTotalPages(html: string): number {
	const $ = cheerio.load(html);
	let max = 1;
	$("a[href*='page=']").each((_, el) => {
		const href = $(el).attr('href');
		if (!href) return;
		try {
			const page = Number.parseInt(
				new URL(href, 'https://www.jesusvico.com').searchParams.get('page') ?? '',
				10,
			);
			if (Number.isFinite(page) && page > max) max = page;
		} catch {
			// ignore malformed hrefs
		}
	});
	return max;
}

/**
 * jesusvico.com weight/diameter appear as bare "26.92 g. 36.7 mm." with no "weight:"/"diameter:"
 * label the shared parser-utils.ts heuristics require, so these stay jesusvico-scoped rather than
 * loosening the shared ones. Matches both a period decimal (English locale, "26.92 g.") and a
 * comma decimal (Spanish locale, "6,75 g.") - a period-only pattern would silently match the wrong
 * number out of a comma value (e.g. "75g" out of "6,75 g.").
 */
function extractJesusvicoWeight(text: string | null | undefined): string | null {
	if (!text) return null;
	// A lookahead, not a literal trailing \s: text has been through cleanText
	// (trimmed), so "... 6,75 g." at the very end of the string has nothing
	// after the dot, and \s required there matched nothing at all.
	const value = text.match(/(\d+(?:[.,]\d+)?)\s*g\.?(?=\s|$|[,;)])/i)?.[1];
	return value !== undefined ? `${value.replace(',', '.')}g` : null;
}

function extractJesusvicoDiameter(text: string | null | undefined): string | null {
	if (!text) return null;
	const value = text.match(/(\d+(?:[.,]\d+)?)\s*mm\.?/i)?.[1];
	return value !== undefined ? `${value.replace(',', '.')}mm` : null;
}

/**
 * jesusvico.com's lot-detail description opens with "<Ruler/issuer> (<date range>)." - a
 * parenthesized date, not the comma form the shared extractRulerAndDate expects (Biddr's
 * "Ruler, 1475-1603"), so this stays local rather than loosening that heuristic. Scoped to the
 * first period-delimited segment only.
 */
function extractJesusvicoRulerAndDate(text: string | null | undefined): {
	ruler: string | null;
	datePeriod: string | null;
} {
	if (!text) return { ruler: null, datePeriod: null };
	const firstSegment = text.split('.')[0]?.trim() ?? '';
	const match = firstSegment.match(/^(.+?)\s*\(([^)]+)\)$/);
	const ruler = match?.[1];
	const datePeriod = match?.[2];
	if (ruler === undefined || datePeriod === undefined) return { ruler: null, datePeriod: null };
	return { ruler: ruler.trim(), datePeriod: datePeriod.trim() };
}

/** Extracts auction-level metadata from a jesusvico.com auction listing page. Single auction-house
 * site (unlike sixbid), so auctionHouse is fixed. */
export function parseJesusvicoAuction(html: string, sourceUrl: string): ExtractedAuction {
	const $ = cheerio.load(html);

	const title = cleanText($('h1.text-uppercase b').first().text());
	const auctionNumber = parseJesusvicoAuctionNumber(sourceUrl);

	const dataClosed = $('[data-closed]').first().attr('data-closed');
	const dateText = $('.filters-auction-countdown .filter-title p').last().text();
	const startDate = parseEuropeanDateText(dateText);

	const status = deriveStatus(dataClosed, startDate);

	const lotCount = $('.lot-card').length;

	return {
		sourceUrl,
		sourceDomain: 'jesusvico.com',
		auctionIdentifier: auctionNumber ?? '',
		auctionHouse: 'Jesús Vico',
		title,
		auctionNumber,
		description: null,
		location: null,
		startDate,
		endDate: null,
		status,
		lotCount: lotCount > 0 ? lotCount : null,
		categories: [],
		raw: {},
	};
}

/**
 * data-closed is the primary signal, but its exact semantics weren't fully confirmed live (a
 * "data-closed=0" was observed on an auction where every sampled lot was already SOLD) - cross-
 * checked against the parsed start date so a stale flag can't produce "upcoming" for an auction
 * that has clearly already happened.
 */
function deriveStatus(dataClosed: string | undefined, startDate: string | null): AuctionStatus {
	const startMs = startDate ? new Date(startDate).getTime() : NaN;
	const startIsPast = !Number.isNaN(startMs) && startMs <= Date.now();

	if (dataClosed === '1' || startIsPast) return 'closed';
	if (!Number.isNaN(startMs)) return 'upcoming';
	return 'unknown';
}

/**
 * Builds a pseudo-auction for a single-lot URL. A prior version assumed the lot detail page had
 * no reusable auction header and synthesized a "Auction N, Lot M" title - WRONG, confirmed live:
 * the page's own breadcrumb (`.lot-ficha-title`) carries the real auction title server-rendered
 * in the raw HTML. Reads it directly; falls back to null (never a synthesized title) if absent.
 */
export function parseJesusvicoSingleLotAuction(html: string, sourceUrl: string): ExtractedAuction {
	const $ = cheerio.load(html);
	const auctionNumber = parseJesusvicoAuctionNumber(sourceUrl);
	const title = cleanText($('.lot-ficha-title b a').first().text());

	return {
		sourceUrl,
		sourceDomain: 'jesusvico.com',
		auctionIdentifier: jesusvicoLotIdentifier(sourceUrl) ?? '',
		auctionHouse: 'Jesús Vico',
		title,
		auctionNumber,
		description: null,
		location: null,
		startDate: null,
		endDate: null,
		status: 'unknown',
		lotCount: 1,
		categories: [],
		raw: {},
	};
}

/**
 * Extracts every lot card from a jesusvico.com listing page. detailFetched is still false: the
 * card text itself isn't truncated, but the detail page adds a real multi-image gallery the
 * listing doesn't have (confirmed 4 images vs. 1 thumbnail).
 */
export function parseJesusvicoLots(html: string, sourceUrl: string): ExtractedLot[] {
	const $ = cheerio.load(html);
	const lots: ExtractedLot[] = [];
	const auctionNumber = parseJesusvicoAuctionNumber(sourceUrl) ?? '';

	$('.lot-card').each((_, el) => {
		const card = $(el);
		const lotUrl = absoluteUrl(card.find('a.stretched-link').first().attr('href'), sourceUrl);

		const lotNumberText = cleanText(card.find('.card-lot-title').first().text());
		// "Lot 215" (English) or "Lote 215" (Spanish) - both matched literally.
		const lotNumberMatch = lotNumberText?.match(/Lote?\s+(\S+)/i);
		const lotNumber = lotNumberMatch?.[1] ?? null;
		if (!lotNumber) return;

		const title = cleanText(card.find('.card-title').first().text());

		const startingPriceText = cleanText(card.find('.lot-salida-price-value').first().text());
		const startingPrice = parseEuropeanPrice(startingPriceText);

		const realizedEl = card.find('.lot-buy-to-value').first();
		const realizedPrice =
			realizedEl.length > 0 ? parseEuropeanPrice(cleanText(realizedEl.text())) : null;

		const rawImageUrl = absoluteUrl(card.find('.card-img-top').first().attr('src'), sourceUrl);
		const imageUrl = rawImageUrl ? toFullResolutionUrl(rawImageUrl) : null;
		const images: ExtractedImage[] = [];
		if (imageUrl) images.push({ sourceUrl: imageUrl, order: 0, width: null, height: null });

		const { ruler, datePeriod } = extractRulerAndDate(title);

		lots.push({
			sourceUrl: lotUrl,
			lotIdentifier: `jesusvico:${auctionNumber}:${lotNumber}`,
			lotNumber,
			title,
			description: title,
			descriptionHtml: null,
			category: null,
			estimateLow: null,
			estimateHigh: null,
			startingPrice: startingPrice?.amount ?? null,
			realizedPrice: realizedPrice?.amount ?? null,
			currency: realizedPrice?.currency ?? startingPrice?.currency ?? null,
			weight: extractJesusvicoWeight(title),
			diameter: extractJesusvicoDiameter(title),
			material: extractMaterial(title),
			mint: null,
			ruler,
			denomination: extractDenomination(title),
			datePeriod,
			condition: null,
			referenceNumber: null,
			detailFetched: false,
			images,
			raw: {},
		});
	});

	return lots;
}

/**
 * Parses a jesusvico.com lot detail page - adds the full image gallery (the listing only has one
 * thumbnail). Price fields are left null: LotRepository.upsert's mergeLot already keeps the
 * listing's own values whenever a merge input is null, so re-parsing them here would only risk
 * drift for no gain.
 */
export function parseJesusvicoLotDetail(html: string, sourceUrl: string): ExtractedLot | null {
	const $ = cheerio.load(html);
	if ($('.long-description').length === 0) return null;

	const auctionNumber = parseJesusvicoAuctionNumber(sourceUrl);
	const lotNumber = parseJesusvicoLotNumber(sourceUrl);
	if (!auctionNumber || !lotNumber) return null;

	const description = cleanText($('.long-description').text());
	const { ruler, datePeriod } = extractJesusvicoRulerAndDate(description);

	const images: ExtractedImage[] = [];
	const seen = new Set<string>();
	// The "/thumbs/838/" bucket reliably marks just the gallery photos; upgraded to full-res below.
	$("img[src*='/thumbs/838/']").each((_i, el) => {
		const rawSrc = absoluteUrl($(el).attr('src'), sourceUrl);
		const src = rawSrc ? toFullResolutionUrl(rawSrc) : null;
		if (src && !seen.has(src)) {
			seen.add(src);
			images.push({ sourceUrl: src, order: images.length, width: null, height: null });
		}
	});

	return {
		sourceUrl,
		lotIdentifier: `jesusvico:${auctionNumber}:${lotNumber}`,
		lotNumber,
		title: null,
		description,
		descriptionHtml: null,
		category: null,
		estimateLow: null,
		estimateHigh: null,
		startingPrice: null,
		realizedPrice: null,
		currency: null,
		weight: extractJesusvicoWeight(description),
		diameter: extractJesusvicoDiameter(description),
		material: extractMaterial(description),
		mint: null,
		ruler,
		denomination: null,
		datePeriod,
		condition: null,
		referenceNumber: null,
		detailFetched: true,
		images,
		raw: {},
	};
}
