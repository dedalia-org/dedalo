/**
 * Pure URL-identifier parsing for jesusvico.com — split out of acquisition.ts so that both
 * acquisition.ts (needs them to resolve what to fetch) and parser.ts (needs them to label a
 * parsed lot/auction) can import them without creating a two-file import cycle
 * (acquisition.ts -> parser.ts -> acquisition.ts, review item: import_scc_tripwire, PR #114
 * 2026-10-06 follow-up). No network, no DedaloError — just string parsing.
 */

/**
 * jesusvico.com auction URLs embed the auction number as "I{n}" in the path (e.g.
 * ".../subasta-180-coleccion-segarra-vol-iii_I180-001" -> "180"). The same prefix also appears on
 * every lot's own detail-page URL, but shared across all lots on that auction, not per-lot.
 */
export function parseJesusvicoAuctionNumber(rawUrl: string): string | null {
	try {
		const url = new URL(rawUrl);
		const match = url.pathname.match(/I(\d+)/i);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

/**
 * jesusvico.com lot detail URLs are "/{locale}/lot(e)?/I{auction}-X-X/{lotNumber}-Y-slug" - both
 * the English ("lot") and Spanish ("lote") segments are matched. The lot number is the leading
 * digits of the final path segment.
 */
export function parseJesusvicoLotNumber(rawUrl: string): string | null {
	try {
		const url = new URL(rawUrl);
		const match = url.pathname.match(/\/lote?\/[^/]+\/(\d+)/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

/** A stable identifier for a single-lot retrieval, distinct from the full auction's own number. */
export function jesusvicoLotIdentifier(rawUrl: string): string | null {
	const auctionNumber = parseJesusvicoAuctionNumber(rawUrl);
	const lotNumber = parseJesusvicoLotNumber(rawUrl);
	if (!auctionNumber || !lotNumber) return null;
	return `lot-${auctionNumber}-${lotNumber}`;
}
