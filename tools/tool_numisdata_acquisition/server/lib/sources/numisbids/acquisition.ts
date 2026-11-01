/**
 * numisbids.com's own robots.txt explicitly names and blocks ClaudeBot (Anthropic's own crawler),
 * alongside Bytespider, confirmed from multiple independent networks (HTTP 403 from every one). No
 * automated fetch is made here - preview_html (the operator's own saved page) is the only path.
 * These are the pure URL-parsing helpers `parseAuctionIdentifier` still needs; everything that used
 * to fetch live was removed with the tool's old acquisition/ layer (PR #114 review, 2026-09-29).
 */

/**
 * numisbids.com sale URLs are `/sale/{saleId}` (optionally with a `?pg=N` the site itself adds for
 * pagination, which we ignore and drive ourselves).
 */
export function parseNumisbidsSaleId(rawUrl: string): string | null {
	try {
		const url = new URL(rawUrl);
		if (!/numisbids\.com$/i.test(url.hostname)) return null;
		const match = url.pathname.match(/^\/sale\/(\d+)/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

/**
 * numisbids.com lot detail URLs are `/sale/{saleId}/lot/{lotNumber}` - the sale-scoped lot number
 * (resets per sale, unlike numisbids' own internal `lid` the page itself carries), used only to
 * build a stable single-lot retrieval identifier here.
 */
export function parseNumisbidsLotUrl(rawUrl: string): { saleId: string; lotNumber: string } | null {
	try {
		const url = new URL(rawUrl);
		if (!/numisbids\.com$/i.test(url.hostname)) return null;
		const match = url.pathname.match(/^\/sale\/(\d+)\/lot\/(\d+)/);
		const saleId = match?.[1];
		const lotNumber = match?.[2];
		if (saleId === undefined || lotNumber === undefined) return null;
		return { saleId, lotNumber };
	} catch {
		return null;
	}
}

/** A stable identifier for a single-lot retrieval, distinct from the full sale's own numeric id. */
export function numisbidsLotIdentifier(rawUrl: string): string | null {
	const parsed = parseNumisbidsLotUrl(rawUrl);
	return parsed ? `lot-${parsed.saleId}-${parsed.lotNumber}` : null;
}
