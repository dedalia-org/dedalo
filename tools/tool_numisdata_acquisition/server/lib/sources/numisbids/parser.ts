import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
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
	parsePrice,
	stripDigitGroupingSpaces,
} from '../../extraction/parser-utils.ts';
import { numisbidsLotIdentifier, parseNumisbidsSaleId } from './acquisition.ts';

function absoluteUrl(href: string | undefined | null, base: string): string | null {
	if (!href) return null;
	try {
		return new URL(href, base).toString();
	} catch {
		return null;
	}
}

/**
 * cheerio's plain `.text()` concatenates text nodes with nothing between them, so markup like
 * `Lot 3001<br><a>Bid on this lot...</a>` (confirmed live, no whitespace around the `<br>`)
 * collapses into "Lot 3001Bid on this lot...", corrupting both lot-number and description
 * extraction. Converting `<br>` to a real newline first avoids that.
 */
function textWithLineBreaks(el: cheerio.Cheerio<AnyNode>): string {
	const withBreaks = (el.html() ?? '').replace(/<br\s*\/?>/gi, '\n');
	return cheerio.load(withBreaks).root().text();
}

/** "Page 1 of 21" - a direct text scan rather than a selector, confirmed stable across both an
 * open and a closed sale. */
export function parseNumisbidsTotalPages(html: string): number {
	const totalPages = html.match(/Page\s+\d+\s+of\s+(\d+)/i)?.[1];
	return totalPages !== undefined ? Number.parseInt(totalPages, 10) : 1;
}

interface PriceInfo {
	startingPrice: number | null;
	realizedPrice: number | null;
	currency: string | null;
	currentBid: number | null;
}

/**
 * numisbids.com always shows "Starting price: N CUR" regardless of sale state - the closed/open
 * signal is a separate "Price realized: N CUR" or literal "Lot unsold" once closed. Large amounts
 * use a narrow-no-break-space thousands separator (e.g. "250 000 USD"), normalized up front.
 */
function extractPriceInfo(rawContainerText: string): PriceInfo {
	const containerText = stripDigitGroupingSpaces(rawContainerText);
	const startingMatch = containerText.match(/Starting price:\s*([\d.,]+\s*[A-Z]{3})/i);
	const startingParsed = startingMatch ? parsePrice(startingMatch[1]) : null;

	if (/lot unsold/i.test(containerText)) {
		return {
			startingPrice: startingParsed?.amount ?? null,
			realizedPrice: null,
			currency: startingParsed?.currency ?? null,
			currentBid: null,
		};
	}

	const realizedMatch = containerText.match(/Price realized:\s*([\d.,]+\s*[A-Z]{3})/i);
	const realizedParsed = realizedMatch ? parsePrice(realizedMatch[1]) : null;
	const bidMatch = containerText.match(/Current bid:\s*([\d.,]+\s*[A-Z]{3})/i);
	const bidParsed = bidMatch ? parsePrice(bidMatch[1]) : null;

	return {
		startingPrice: startingParsed?.amount ?? null,
		realizedPrice: realizedParsed?.amount ?? null,
		currency: realizedParsed?.currency ?? startingParsed?.currency ?? bidParsed?.currency ?? null,
		currentBid: bidParsed?.amount ?? null,
	};
}

/**
 * numisbids' own stable, sale-independent lot id - more reliable than the sale-scoped lot number,
 * which resets per sale. Confirmed against a real page (2026-09): the watchlist control is now
 * `<button class="watchlot" data-lotid="NNN">`, not the `<a href="...?lid=NNN">` link the original
 * scraper targeted (site markup drifted - every lot was silently dropped as a result). Tries
 * data-lotid first, falls back to the old href pattern for pages that might still use it.
 */
function extractLid(watchEl: cheerio.Cheerio<AnyNode>): string | null {
	const dataLotId = watchEl.attr('data-lotid');
	if (dataLotId && /^\d+$/.test(dataLotId)) return dataLotId;
	const href = watchEl.attr('href');
	const match = href?.match(/[?&]lid=(\d+)/);
	return match?.[1] ?? null;
}

/**
 * Extracts auction-level metadata from a numisbids.com sale page. Status has no explicit flag -
 * the countdown/"Session N begins closing in" block is present on an open sale and absent on a
 * closed one (confirmed live against both), cross-checked against parsed dates.
 */
export function parseNumisbidsAuction(html: string, sourceUrl: string): ExtractedAuction {
	const $ = cheerio.load(html);
	const textBlock = $('.salestatus .text').first();

	const auctionHouse = cleanText(textBlock.find('.name').first().text());
	const title = cleanText(textBlock.find('b').first().text());

	const datesClone = textBlock.clone();
	datesClone.find('.name').remove();
	datesClone.find('b').first().remove();
	datesClone.find('.closing').remove();
	const { startDate, endDate } = parseNumisbidsDates(cleanText(datesClone.text()));

	const hasCountdown = $('.salestatus .closing').length > 0;
	const status = deriveStatus(hasCountdown, endDate);

	const saleId = parseNumisbidsSaleId(sourceUrl) ?? '';
	const lotCount = $('.browse').length;

	return {
		sourceUrl,
		sourceDomain: 'numisbids.com',
		auctionIdentifier: saleId,
		auctionHouse,
		title,
		auctionNumber: null,
		description: null,
		location: null,
		startDate,
		endDate,
		status,
		lotCount: lotCount > 0 ? lotCount : null,
		categories: [],
		raw: {},
	};
}

/**
 * Builds a pseudo-auction for a single-lot URL (`/sale/{id}/lot/{n}`). A lot's own detail page
 * renders the identical `.salestatus` header a sale listing page does, so this reuses
 * parseNumisbidsAuction's extraction wholesale, only overriding the identifier and lotCount
 * (always 1).
 */
export function parseNumisbidsSingleLotAuction(html: string, sourceUrl: string): ExtractedAuction {
	const base = parseNumisbidsAuction(html, sourceUrl);
	return {
		...base,
		auctionIdentifier: numisbidsLotIdentifier(sourceUrl) ?? base.auctionIdentifier,
		lotCount: 1,
	};
}

/** "31 Aug - 5 Sep 2026" (range) or "9 Jul 2026" (single date). */
function parseNumisbidsDates(text: string | null): {
	startDate: string | null;
	endDate: string | null;
} {
	if (!text) return { startDate: null, endDate: null };

	const rangeMatch = text.match(/(\d{1,2}\s+[A-Za-z]+)\s*-\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
	const rangeStart = rangeMatch?.[1];
	const rangeEnd = rangeMatch?.[2];
	if (rangeStart !== undefined && rangeEnd !== undefined) {
		const year = rangeEnd.match(/\d{4}/)?.[0] ?? '';
		const start = new Date(`${rangeStart} ${year}`);
		const end = new Date(rangeEnd);
		return {
			startDate: Number.isNaN(start.getTime()) ? null : start.toISOString(),
			endDate: Number.isNaN(end.getTime()) ? null : end.toISOString(),
		};
	}

	const singleMatch = text.match(/\d{1,2}\s+[A-Za-z]+\s+\d{4}/);
	if (singleMatch) {
		const parsed = new Date(singleMatch[0]);
		const iso = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
		return { startDate: iso, endDate: iso };
	}

	return { startDate: null, endDate: null };
}

/**
 * The printed date range (e.g. "31 Aug - 5 Sep 2026") describes when each bidding session
 * *closes*, not when the sale starts - confirmed live: a sale with an active "closing in 12 days"
 * countdown had a start date still 12 days out, meaning bidding was already open despite the
 * printed date. So the countdown's presence is authoritative for "currently open"; the end date is
 * only a cross-check against a stale countdown.
 */
function deriveStatus(hasCountdown: boolean, endDate: string | null): AuctionStatus {
	if (!hasCountdown) return 'closed';
	const endMs = endDate ? new Date(endDate).getTime() : Number.NaN;
	if (!Number.isNaN(endMs) && endMs <= Date.now()) return 'closed';
	return 'live';
}

/** Parses one `.browse` card from a numisbids.com sale listing page. */
function parseNumisbidsLotCard(
	card: cheerio.Cheerio<AnyNode>,
	sourceUrl: string,
): ExtractedLot | null {
	const lotLink = card.find('.browsetext-top .left .lot a').first();
	const lotNumberMatch = cleanText(lotLink.text())?.match(/Lot\s+(\d+)/i);
	const lotNumber = lotNumberMatch?.[1] ?? null;
	const lotUrl = absoluteUrl(lotLink.attr('href'), sourceUrl);

	const lid = extractLid(card.find('.watchlot').first());
	if (!lid) return null; // no stable id available - skip rather than guess one.

	const rawTitle = cleanMultilineText(card.find('.browsetext .summary a').first().text());

	// Starting price and the closed/open signal (Price realized / Lot unsold) live in separate
	// blocks - combined so extractPriceInfo can match either regardless of sale state.
	const topPriceText = cleanText(card.find('.browsetext-top .right').first().text()) ?? '';
	const bottomPriceText = cleanText(card.find('.browsetext .bottom .right').first().text()) ?? '';
	const priceInfo = extractPriceInfo(`${topPriceText} ${bottomPriceText}`);

	const fullImageHref = card.find('.browseimg a.imgenlarge_overlay').first().attr('href');
	const thumbSrc = card.find('.browseimg img').first().attr('src');
	const imageUrl = absoluteUrl(fullImageHref, sourceUrl) ?? absoluteUrl(thumbSrc, sourceUrl);
	const images: ExtractedImage[] = imageUrl
		? [{ sourceUrl: imageUrl, order: 0, width: null, height: null }]
		: [];

	const { ruler, datePeriod } = extractRulerAndDate(rawTitle);

	return {
		sourceUrl: lotUrl,
		lotIdentifier: `numisbids:${lid}`,
		lotNumber,
		title: rawTitle,
		description: rawTitle,
		descriptionHtml: null,
		category: null,
		estimateLow: null,
		estimateHigh: null,
		startingPrice: priceInfo.startingPrice,
		realizedPrice: priceInfo.realizedPrice,
		currency: priceInfo.currency,
		weight: extractWeight(rawTitle),
		diameter: extractDiameter(rawTitle),
		material: extractMaterial(rawTitle),
		mint: null,
		ruler,
		denomination: extractDenomination(rawTitle),
		datePeriod,
		condition: null,
		referenceNumber: null,
		detailFetched: false,
		images,
		raw: priceInfo.currentBid !== null ? { currentBid: priceInfo.currentBid } : {},
	};
}

/** Extracts lot cards from a numisbids.com sale listing page (`.browse` blocks). */
export function parseNumisbidsLots(html: string, sourceUrl: string): ExtractedLot[] {
	const $ = cheerio.load(html);
	const lots: ExtractedLot[] = [];

	$('.browse').each((_, el) => {
		const lot = parseNumisbidsLotCard($(el), sourceUrl);
		if (lot) lots.push(lot);
	});

	return lots;
}

/**
 * Parses a numisbids.com lot detail page - adds the full untruncated description and the real
 * multi-image gallery (the listing's own description is truncated with "..." and has one thumbnail).
 */
export function parseNumisbidsLotDetail(html: string, sourceUrl: string): ExtractedLot | null {
	const $ = cheerio.load(html);
	const viewlot = $('.viewlot').first();
	if (viewlot.length === 0) return null;

	const lid = extractLid(viewlot.find('.watchlot').first());
	if (!lid) return null;

	const lotNumberMatch = textWithLineBreaks(viewlot.find('.viewlottext .left').first()).match(
		/Lot\s+(\d+)/i,
	);
	const lotNumber = lotNumberMatch?.[1] ?? null;

	// The page has two other elements sharing the "description" class (#postbid, #watchnote), both
	// empty/unrelated to the lot's own text - excluded by id rather than relying on class alone.
	const descriptionEl = $('.description')
		.filter((_, el) => {
			const id = $(el).attr('id');
			return id !== 'postbid' && id !== 'watchnote';
		})
		.first();
	const description = cleanMultilineText(textWithLineBreaks(descriptionEl));

	const images: ExtractedImage[] = [];
	const seen = new Set<string>();
	$('.viewlotimgnav li a[href]').each((_, el) => {
		const abs = absoluteUrl($(el).attr('href'), sourceUrl);
		if (abs && !seen.has(abs)) {
			seen.add(abs);
			images.push({ sourceUrl: abs, order: images.length, width: null, height: null });
		}
	});

	const priceText = cleanText(viewlot.find('.viewlottext .estimate').first().text()) ?? '';
	const priceInfo = extractPriceInfo(priceText);

	const { ruler, datePeriod } = extractRulerAndDate(description);

	return {
		sourceUrl,
		lotIdentifier: `numisbids:${lid}`,
		lotNumber,
		title: description,
		description,
		descriptionHtml: null,
		category: null,
		estimateLow: null,
		estimateHigh: null,
		startingPrice: priceInfo.startingPrice,
		realizedPrice: priceInfo.realizedPrice,
		currency: priceInfo.currency,
		weight: extractWeight(description),
		diameter: extractDiameter(description),
		material: extractMaterial(description),
		mint: null,
		ruler,
		denomination: extractDenomination(description),
		datePeriod,
		condition: null,
		referenceNumber: null,
		detailFetched: true,
		images,
		raw: priceInfo.currentBid !== null ? { currentBid: priceInfo.currentBid } : {},
	};
}
