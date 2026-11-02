import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { AuctionStatus, ExtractedAuction } from '../../domain/auction.ts';
import type { ExtractedImage, ExtractedLot } from '../../domain/lot.ts';
import {
	cleanMultilineText,
	cleanText,
	extractDenomination,
	extractMaterial,
	extractRulerAndDate,
	parseEuropeanDateText,
	parseEuropeanPrice,
} from '../../extraction/parser-utils.ts';
import { parseAureoAuctionId } from './acquisition.ts';

function absoluteUrl(href: string | undefined | null, base: string): string | null {
	if (!href) return null;
	try {
		return new URL(href, base).toString();
	} catch {
		return null;
	}
}

/**
 * aureo.com's descriptions use "7,14 g." (comma decimal, no "weight:" label) - same bare-pattern
 * gap jesusvico has, so kept as its own extractor, but matches both a comma and a period decimal
 * (`[.,]`, not just `,`): a period-decimal weight like "7.14 g." otherwise had its `\d+` run stop
 * at the dot, so the regex re-matched starting from "14" and silently read the weight as 14, not
 * 7.14. The lookahead (not a literal trailing `\s`) is the same review item 11 already fixed for
 * jesusvico: a weight at the very end of a trimmed string has nothing after the dot to match.
 */
function extractAureoWeight(text: string | null): string | null {
	if (!text) return null;
	const value = text.match(/(\d+(?:[.,]\d+)?)\s*g\.?(?=\s|$|[,;)])/i)?.[1];
	return value !== undefined ? `${value.replace(',', '.')}g` : null;
}

/**
 * aureo.com's diameter is present on only a minority of lots (confirmed live: 47 of 2193 in one
 * real auction), written "Ø27 mm" - the Ø symbol, not a "diameter:" label the shared
 * extractDiameter requires, so it was always null for every lot (review item D2).
 */
function extractAureoDiameter(text: string | null): string | null {
	if (!text) return null;
	const value = text.match(/Ø\s*(\d+(?:[.,]\d+)?)\s*mm\b/i)?.[1];
	return value !== undefined ? `${value.replace(',', '.')}mm` : null;
}

/**
 * Spanish numismatic grading scale (worst to best: RC, BC, MBC, EBC, SC/FDC), confirmed live in
 * lot descriptions right after the weight - kept as its own `condition` field rather than mapped
 * onto an English equivalent.
 */
function extractAureoCondition(text: string | null): string | null {
	if (!text) return null;
	// A trailing \b fails right after "MBC-" (neither side of "-" is a word char); a negative
	// lookahead for another letter/digit gives the same "don't match mid-word" guard instead.
	const match = text.match(
		/\b(FDC|SC\+|SC-|SC|EBC\+|EBC-|EBC|MBC\+|MBC-|MBC|BC\+|BC-|BC|RC)(?![A-Za-z0-9])/,
	);
	return match?.[1] ?? null;
}

interface AureoPriceInfo {
	startingPrice: number | null;
	realizedPrice: number | null;
	currency: string | null;
}

/**
 * A card always shows "Start: N€"; "Hammer price: N€" only appears once a lot has sold (confirmed
 * by reading the site's own script.js) - its presence/absence is itself the sold/open signal.
 */
function extractAureoPriceInfo(priceText: string): AureoPriceInfo {
	const startSegment = priceText.match(/Start:\s*([^\n]*)/i)?.[1] ?? null;
	const hammerSegment = priceText.match(/Hammer price:\s*([^\n]*)/i)?.[1] ?? null;
	const startParsed = parseEuropeanPrice(startSegment);
	const hammerParsed = parseEuropeanPrice(hammerSegment);
	return {
		startingPrice: startParsed?.amount ?? null,
		realizedPrice: hammerParsed?.amount ?? null,
		currency: hammerParsed?.currency ?? startParsed?.currency ?? null,
	};
}

/** Parses one `.card.lot-item` card from an aureo.com auction listing (a loaditems.php response). */
function parseAureoLotCard(card: cheerio.Cheerio<AnyNode>, pageUrl: string): ExtractedLot | null {
	const topCols = card.find('.row.my-0.small .col-4');
	const lotNumberMatch = cleanText(topCols.eq(0).text())?.match(/Lot\s+(\d+)/i);
	const lotNumber = lotNumberMatch?.[1] ?? null;
	if (!lotNumber) return null;

	const dateText = cleanText(topCols.eq(1).text());
	const auctionMatch = cleanText(topCols.eq(2).text())?.match(/Auction\s+(\d+)/i);
	const auctionNumber = auctionMatch?.[1] ?? null;

	const thumbLink = card.find('.item-thumb a').first();
	const auctionIdPadded = thumbLink.attr('data-auction');
	const numcatalog = thumbLink.attr('data-numcatalog') ?? lotNumber;
	const imageUrl =
		auctionIdPadded && numcatalog
			? absoluteUrl(
					`https://media.aureo.com/images/subastas/${auctionIdPadded}/${numcatalog}.jpg`,
					pageUrl,
				)
			: absoluteUrl(card.find('.item-thumb img').first().attr('src'), pageUrl);
	const images: ExtractedImage[] = imageUrl
		? [{ sourceUrl: imageUrl, order: 0, width: null, height: null }]
		: [];

	const description = cleanMultilineText(card.find('.item-text').text());
	const priceText = card.find('.row .col-12.small').first().text();
	const priceInfo = extractAureoPriceInfo(priceText);

	const { ruler, datePeriod } = extractRulerAndDate(description);
	const lotIdentifierAuction = auctionIdPadded ?? auctionNumber ?? '';

	// aureo.com has no bookmarkable per-lot URL (pure client-side AJAX nav, every lot link is "#"),
	// so the most useful honest link is that lot's own auction page.
	const lotSourceUrl = auctionIdPadded
		? `https://www.aureo.com/en/subasta/${auctionIdPadded}`
		: pageUrl;

	return {
		sourceUrl: lotSourceUrl,
		lotIdentifier: `aureo:${lotIdentifierAuction}:${numcatalog}`,
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
		weight: extractAureoWeight(description),
		diameter: extractAureoDiameter(description),
		material: extractMaterial(description),
		mint: null,
		ruler,
		denomination: extractDenomination(description),
		datePeriod,
		condition: extractAureoCondition(description),
		referenceNumber: null,
		detailFetched: true,
		images,
		raw: dateText ? { closingDate: dateText } : {},
	};
}

/** Extracts lot cards from an aureo.com auction listing page (a loaditems.php response). */
export function parseAureoLots(html: string, sourceUrl: string): ExtractedLot[] {
	const $ = cheerio.load(html);
	const lots: ExtractedLot[] = [];
	$('.card.lot-item').each((_, el) => {
		const lot = parseAureoLotCard($(el), sourceUrl);
		if (lot) lots.push(lot);
	});
	return lots;
}

/**
 * Builds auction-level metadata for a single aureo.com auction from its first loaditems.php page.
 * The shell page at `/en/subasta/{id}` carries no title/date itself (lots load entirely via AJAX),
 * so this reads the auction number from the breadcrumb and the closing date from the first card.
 */
export function parseAureoAuction(html: string, sourceUrl: string): ExtractedAuction {
	const $ = cheerio.load(html);
	const auctionId = parseAureoAuctionId(sourceUrl) ?? '';
	const breadcrumbMatch = html.match(/AUCTION\s+(\d+)/i);
	const auctionNumber = breadcrumbMatch?.[1] ?? String(Number.parseInt(auctionId, 10) || auctionId);

	const firstCard = $('.card.lot-item').first();
	const dateText = cleanText(firstCard.find('.row.my-0.small .col-4').eq(1).text());
	const closingDate = parseEuropeanDateText(dateText);

	const hasAnyHammerPrice = /Hammer price:/i.test(html);
	const status = deriveAureoStatus(hasAnyHammerPrice, closingDate);

	const lotCount = $('.card.lot-item').length;

	return {
		sourceUrl,
		sourceDomain: 'aureo.com',
		auctionIdentifier: auctionId,
		auctionHouse: 'Aureo & Calicó',
		title: `Auction ${auctionNumber}`,
		auctionNumber,
		description: null,
		location: null,
		startDate: closingDate,
		endDate: closingDate,
		status,
		lotCount: lotCount > 0 ? lotCount : null,
		categories: [],
		raw: {},
	};
}

/**
 * No explicit open/closed flag is exposed - a "Hammer price" only appears once a lot has sold (see
 * extractAureoPriceInfo), so its presence anywhere on the page is a reliable closed signal; its
 * absence falls back to comparing the closing date against now.
 */
function deriveAureoStatus(hasAnyHammerPrice: boolean, closingDate: string | null): AuctionStatus {
	if (hasAnyHammerPrice) return 'closed';
	if (!closingDate) return 'unknown';
	const dateMs = new Date(closingDate).getTime();
	if (Number.isNaN(dateMs)) return 'unknown';
	return dateMs > Date.now() ? 'upcoming' : 'closed';
}
