import { DedaloError } from '../../../../../../src/core/errors/dedalo_error.ts';
import { harvestFetch } from '../../../../../../src/core/harvest/harvest.ts';
import { looksBlocked } from '../../acquisition/block-signals.ts';
import type { AcquisitionProgress, MultiPageAcquisition, RawSource } from '../types.ts';

/** A Cloudflare/CAPTCHA interstitial is commonly served as a plain 2xx, so response.ok alone does
 * not mean "this is the real page" (review item: "block-signals.ts is never imported"). */
function assertNotBlocked(
	source: string,
	url: string,
	response: { headers: Readonly<Record<string, string>> },
	html: string,
): void {
	if (response.headers['cf-mitigated'] || looksBlocked(html)) {
		throw new DedaloError('external.protocol', {
			coordinates: { source, url, cf_mitigated: response.headers['cf-mitigated'] ?? '' },
		});
	}
}

/** Thrown when a page fetched fine (2xx) but its HTML has none of the markers this adapter relies
 * on for extraction - a URL that resolves to something other than an auction/search catalogue. */
function unsupportedPageError(): DedaloError {
	return new DedaloError('tool.unsupported_target', {
		publicMessage: 'This page does not appear to contain an auction catalogue.',
	});
}

const MAX_PAGES = 50;
const LOTS_PER_PAGE = 96;
const AUREO_HOSTS = ['aureo.com'];

/**
 * aureo.com auction URLs are `/en/subasta/{id}`. Most ids are a plain 4-digit number ("0466"), but
 * a multi-session auction's id has a hyphenated session suffix ("0200-1", confirmed live via
 * `data-auction="0200-1"` in the site's own AJAX calls) - both shapes are accepted.
 */
export function parseAureoAuctionId(rawUrl: string): string | null {
	try {
		const url = new URL(rawUrl);
		if (!/(^|\.)aureo\.com$/i.test(url.hostname)) return null;
		const match = url.pathname.match(/^\/en\/subasta\/(\d+(?:-\d+)?)\/?$/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

/** GET against a public aureo.com page, through the harvesting door. */
async function fetchAureoPage(
	url: string,
	onWait?: (ms: number, origin: string) => void,
): Promise<RawSource> {
	const response = await harvestFetch({
		url,
		hosts: AUREO_HOSTS,
		requireHttps: true,
		headers: { Accept: 'text/html,application/xhtml+xml' },
		onWait,
	});
	if (!response.ok) {
		throw new DedaloError('external.http_status', {
			coordinates: { source: 'aureo', url, status: response.status },
		});
	}
	const html = response.text();
	assertNotBlocked('aureo', url, response, html);
	return {
		html,
		finalUrl: response.url,
		httpStatus: response.status,
		contentType: response.contentType,
	};
}

/**
 * aureo.com's lot listing isn't in the auction page's own HTML - the page ships an empty
 * `#auction-content` div and an inline script that POSTs to this endpoint to fill it in (confirmed
 * live by reading the site's own script.js). A `URLSearchParams` body is sent by the door as a
 * form automatically.
 */
async function postAureoItems(
	params: Record<string, string>,
	onWait?: (ms: number, origin: string) => void,
): Promise<RawSource> {
	const response = await harvestFetch({
		url: 'https://www.aureo.com/modules/loaditems.php',
		hosts: AUREO_HOSTS,
		requireHttps: true,
		method: 'POST',
		body: new URLSearchParams(params),
		headers: { 'X-Requested-With': 'XMLHttpRequest' },
		onWait,
	});
	if (!response.ok) {
		throw new DedaloError('external.http_status', {
			coordinates: { source: 'aureo', url: 'loaditems.php', status: response.status },
		});
	}
	const html = response.text();
	assertNotBlocked('aureo', 'loaditems.php', response, html);
	return {
		html,
		finalUrl: response.url,
		httpStatus: response.status,
		contentType: response.contentType,
	};
}

/** The "View All" link on an auction's shell page carries the full catalog-number range and total lot count. */
interface AureoAuctionRange {
	from: string;
	to: string;
	totalLots: number | null;
}

async function fetchAureoAuctionRange(
	auctionId: string,
	onWait?: (ms: number, origin: string) => void,
): Promise<AureoAuctionRange> {
	const page = await fetchAureoPage(`https://www.aureo.com/en/subasta/${auctionId}`, onWait);
	const viewAllIdx = page.html.indexOf('id="viewall"');
	if (viewAllIdx === -1) {
		throw unsupportedPageError();
	}
	const tagEnd = page.html.indexOf('>', viewAllIdx);
	const tag = page.html.slice(viewAllIdx, tagEnd === -1 ? undefined : tagEnd);
	const from = tag.match(/data-from="(\d+)"/)?.[1];
	const to = tag.match(/data-to="(\d+)"/)?.[1];
	if (from === undefined || to === undefined) {
		throw unsupportedPageError();
	}
	const badgeCount = page.html
		.slice(viewAllIdx, viewAllIdx + 400)
		.match(/badge-light">(\d+)</)?.[1];
	return {
		from,
		to,
		totalLots: badgeCount !== undefined ? Number.parseInt(badgeCount, 10) : null,
	};
}

/** True once a loaditems.php response has no "LOAD MORE LOTS" button - the last page for that query. */
function hasMorePages(html: string): boolean {
	return /loadmore/.test(html);
}

function baseAureoParams(auctionId: string, from: string, to: string): Record<string, string> {
	return {
		auction: auctionId,
		from,
		to,
		year: '',
		epoca: '',
		searchtext1: '',
		searchtext2: '',
		searchtext3: '',
		searchtext4: '',
		lote: '',
		historic: '0',
	};
}

/**
 * Walks one auction's lot pages (`pagina=0` implicit, then `1,2,...` while the previous response
 * still had a "LOAD MORE LOTS" button, capped at MAX_PAGES) and returns every page's raw HTML.
 */
async function acquireAureoAuctionPages(
	auctionId: string,
	onProgress?: AcquisitionProgress,
): Promise<RawSource[]> {
	const onWait = (ms: number, origin: string): void => {
		onProgress?.(0, 0, `Waiting ${Math.round(ms / 1000)}s for ${origin}`);
	};

	const range = await fetchAureoAuctionRange(auctionId, onWait);
	const params = baseAureoParams(auctionId, range.from, range.to);

	const pages: RawSource[] = [];
	const estimatedPages = range.totalLots
		? Math.min(Math.ceil(range.totalLots / LOTS_PER_PAGE), MAX_PAGES)
		: MAX_PAGES;

	const first = await postAureoItems(params, onWait);
	pages.push(first);
	onProgress?.(1, estimatedPages);

	let more = hasMorePages(first.html);
	let pagina = 1;
	while (more && pagina < MAX_PAGES) {
		const page = await postAureoItems({ ...params, pagina: String(pagina) }, onWait);
		pages.push(page);
		onProgress?.(pages.length, Math.max(estimatedPages, pages.length));
		more = hasMorePages(page.html);
		pagina += 1;
	}

	return pages;
}

/**
 * Acquires a single aureo.com auction (`/en/subasta/{id}`). The historical-archive `/en/precios/
 * {brand}/{year}` search is deliberately NOT ported yet, same reasoning as Biddr's search URL -
 * add it once the single-auction path is proven against real data.
 */
export async function acquireAureoAuction(
	rawUrl: string,
	onProgress?: AcquisitionProgress,
): Promise<MultiPageAcquisition> {
	const auctionId = parseAureoAuctionId(rawUrl);
	if (!auctionId) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'Please provide a valid aureo.com auction URL.',
		});
	}
	const pages = await acquireAureoAuctionPages(auctionId, onProgress);
	return { auctionIdentifier: auctionId, pages, method: 'http' };
}
