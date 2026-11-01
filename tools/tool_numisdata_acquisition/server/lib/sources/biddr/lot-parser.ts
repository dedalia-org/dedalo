import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
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
	parsePriceRange,
} from '../../extraction/parser-utils.ts';

function absoluteUrl(href: string | undefined | null, base: string): string | null {
	if (!href) return null;
	try {
		return new URL(href, base).toString();
	} catch {
		return null;
	}
}

/** A listing card's title starts "Lot N. ..." - matched anywhere in the leading text rather than
 * anchored to position 0. */
function parseLotNumberAndTitle(rawTitle: string | null): {
	lotNumber: string | null;
	title: string | null;
} {
	if (!rawTitle) return { lotNumber: null, title: null };
	const match = rawTitle.match(/\blot\s+(\d+)\.\s*/i);
	const lotNumber = match?.[1];
	if (!match || lotNumber === undefined) return { lotNumber: null, title: rawTitle.trim() || null };
	const title = rawTitle.slice((match.index ?? 0) + match[0].length).trim();
	return { lotNumber, title: title.length > 0 ? title : null };
}

/**
 * A listing card's `.lot-image` block carries both a thumbnail (`<img>`, the `.l.jpg` downsized
 * variant) and a full-resolution PhotoSwipe lightbox link (`<a data-pswp-width>`, plain `.jpg`).
 * Prefers the full-resolution link so an image is never downgraded needlessly.
 */
function extractCardImage(
	$card: cheerio.Cheerio<AnyNode>,
	sourceUrl: string,
): ExtractedImage | null {
	const fullLink = $card.find('.lot-image a[data-pswp-width]').first();
	if (fullLink.length > 0) {
		const abs = absoluteUrl(fullLink.attr('href'), sourceUrl);
		if (abs) {
			return {
				sourceUrl: abs,
				order: 0,
				width: Number.parseInt(fullLink.attr('data-pswp-width') ?? '', 10) || null,
				height: Number.parseInt(fullLink.attr('data-pswp-height') ?? '', 10) || null,
			};
		}
	}
	// Fallback to the thumbnail if the full-resolution link is ever absent.
	const abs = absoluteUrl($card.find('.lot-image img').first().attr('src'), sourceUrl);
	return abs ? { sourceUrl: abs, order: 0, width: null, height: null } : null;
}

/**
 * Per-card extraction for one `.catalog-lot` block - shared between a normal listing
 * (parseLotListing) and search results (parseSearchResultLots). `categoryOverride` lets search
 * results attach the lot's real originating auction into `category`; null for a normal listing.
 */
function parseLotCard(
	container: cheerio.Cheerio<AnyNode>,
	sourceUrl: string,
	categoryOverride: string | null = null,
): ExtractedLot | null {
	const $card = container.find('.catalog-lot').first();
	const idAttr = container.attr('id') ?? '';
	const lotIdentifier = idAttr.replace(/^lot/, '');
	if (!lotIdentifier) return null;

	const linkHref =
		$card.find('.lot-description a').first().attr('href') ??
		$card.find('.lot-image a').first().attr('href');
	const lotUrl = absoluteUrl(linkHref, sourceUrl);

	const rawTitle = cleanMultilineText($card.find('.lot-description a').first().text());
	const { lotNumber, title } = parseLotNumberAndTitle(rawTitle);

	const image = extractCardImage($card, sourceUrl);
	const images: ExtractedImage[] = image ? [image] : [];

	const priceLabel = cleanText($card.find('.lot-price').first().children().first().text());
	const priceValueText = cleanText($card.find('.lot-price').first().children().eq(1).text());
	const parsedPrice = parsePrice(priceValueText);

	let startingPrice: number | null = null;
	let realizedPrice: number | null = null;
	let currency: string | null = null;
	if (parsedPrice) {
		currency = parsedPrice.currency;
		if (priceLabel && /realized/i.test(priceLabel)) {
			realizedPrice = parsedPrice.amount;
		} else {
			startingPrice = parsedPrice.amount;
		}
	}

	const { ruler, datePeriod } = extractRulerAndDate(title);

	return {
		sourceUrl: lotUrl,
		lotIdentifier,
		lotNumber,
		title,
		description: rawTitle,
		descriptionHtml: null,
		category: categoryOverride,
		estimateLow: null,
		estimateHigh: null,
		startingPrice,
		realizedPrice,
		currency,
		weight: extractWeight(rawTitle),
		diameter: extractDiameter(rawTitle),
		material: extractMaterial(rawTitle),
		mint: null,
		ruler,
		denomination: extractDenomination(rawTitle ?? title),
		datePeriod,
		condition: null,
		referenceNumber: null,
		detailFetched: false,
		images,
		raw: {},
	};
}

/**
 * Extracts lot cards from a Biddr catalogue listing page (`.catalog-lot` blocks). Listing cards
 * carry a truncated description, one thumbnail image, and a single price field whose label
 * ("Starting price" vs "Price realized") tells us the auction's state.
 */
export function parseLotListing(html: string, sourceUrl: string): ExtractedLot[] {
	const $ = cheerio.load(html);
	const lots: ExtractedLot[] = [];

	$(".catalog-grid > [id^='lot']").each((_, el) => {
		const lot = parseLotCard($(el), sourceUrl);
		if (lot) lots.push(lot);
	});

	return lots;
}

/**
 * Extracts lot cards from a Biddr search-results page. Same card markup as a normal listing, but
 * results are grouped by originating auction via sibling `.search-divider` blocks - walks
 * `.catalog-grid`'s children in order, tracking the most recent divider's label and attaching it
 * to every lot card until the next divider.
 */
export function parseSearchResultLots(html: string, sourceUrl: string): ExtractedLot[] {
	const $ = cheerio.load(html);
	const lots: ExtractedLot[] = [];
	let currentGroup: string | null = null;

	$('.catalog-grid')
		.first()
		.children()
		.each((_, el) => {
			const node = $(el);
			const divider = node.find('.search-divider').first();
			if (divider.length > 0) {
				const heading = divider.find('h2.h4').first().clone();
				heading.find('div').remove();
				currentGroup = cleanText(heading.text());
				return;
			}

			const idAttr = node.attr('id') ?? '';
			if (!idAttr.startsWith('lot')) return;
			const lot = parseLotCard(node, sourceUrl, currentGroup);
			if (lot) lots.push(lot);
		});

	return lots;
}

/**
 * Extracts full detail for a single lot from its dedicated page (`?a=...&l=...`) - the untruncated
 * description and full image carousel, so the numismatic-field heuristics re-run against complete
 * text.
 */
export function parseLotDetail(html: string, sourceUrl: string): ExtractedLot | null {
	const $ = cheerio.load(html);

	const lotIdMatch = sourceUrl.match(/[?&]l=(\d+)/);
	const lotIdentifier = lotIdMatch?.[1] ?? null;
	if (!lotIdentifier) return null;

	const lotNumberText = cleanText($('.lot-navigation h2').first().text());
	const lotNumber = lotNumberText ? (lotNumberText.match(/(\d+)/)?.[1] ?? null) : null;

	const titleText = cleanText($('title').text());
	const title = titleText
		? cleanText(titleText.replace(/^biddr\.com\s*-\s*.*?,\s*lot\s*\d+\.\s*/i, ''))
		: null;

	const $description = $('.lot-details .lot-description').first().clone();
	$description.find('.truncatable-expand').remove();
	const descriptionHtml = $description.html();
	const description = cleanMultilineText($description.text());

	const images: ExtractedImage[] = [];
	$('.single-lot .carousel-item a[data-pswp-width]').each((i, el) => {
		const href = $(el).attr('href');
		const abs = absoluteUrl(href, sourceUrl);
		if (abs) {
			images.push({
				sourceUrl: abs,
				order: i,
				width: Number.parseInt($(el).attr('data-pswp-width') ?? '', 10) || null,
				height: Number.parseInt($(el).attr('data-pswp-height') ?? '', 10) || null,
			});
		}
	});

	// A price is normally <b><span class="highlight-u">...</span></b>, but a "pre-bidding" lot
	// renders a plain <b>15 EUR</b> with no .highlight-u - matching either selector finds the right
	// text either way, since .find() returns the outer <b> first regardless.
	const startingPriceText = cleanText(
		$('.lot-bidding-info-starting-price').find('.highlight-u, b').first().text(),
	);
	const startingPrice = parsePrice(startingPriceText)?.amount ?? null;

	const estimateLabel = $('.lot-bidding')
		.find('*')
		.filter((_, el) => /^Estimate$/i.test($(el).text().trim()));
	const estimateText = cleanText(
		estimateLabel.first().parent().find('.highlight-u, b').first().text(),
	);
	const estimateRange = parsePriceRange(estimateText);

	const realizedLabel = $('.lot-bidding')
		.find('*')
		.filter((_, el) => /price realized/i.test($(el).text()));
	const realizedText = cleanText(
		realizedLabel.first().closest('.hstack').find('.highlight-u, b').last().text(),
	);
	const realizedPrice = parsePrice(realizedText)?.amount ?? null;

	const currency =
		parsePrice(startingPriceText)?.currency ??
		estimateRange?.currency ??
		parsePrice(realizedText)?.currency ??
		null;

	const { ruler, datePeriod } = extractRulerAndDate(title ?? description);

	return {
		sourceUrl,
		lotIdentifier,
		lotNumber,
		title,
		description,
		descriptionHtml: descriptionHtml ?? null,
		category: null,
		estimateLow: estimateRange?.low ?? null,
		estimateHigh: estimateRange?.high ?? null,
		startingPrice,
		realizedPrice,
		currency,
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
		raw: {},
	};
}
