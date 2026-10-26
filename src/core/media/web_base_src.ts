/**
 * Media `src` urls INSIDE rich text (TODO-067) — the two audiences of WC-042.
 *
 * A CKEditor image's url is persisted verbatim in the text, so it is STORED on
 * the same-origin relative root `/dedalo/<mediaDir>` (the publication shape: a
 * record must not embed this application's media origin), and SERVED to the
 * engine's own client on `config.media.webBase` (on a split-origin install the
 * relative url resolves against the app origin, which serves no media).
 * Both are no-ops when DEDALO_MEDIA_WEB_BASE is unset (webBase IS the root).
 */

import { config } from '../../config/config.ts';

function rebase(html: string, from: string, to: string): string {
	return from === to ? html : html.replaceAll(`src="${from}/`, `src="${to}/`);
}

/** Persisted form: `src="<webBase>/…"` → `src="/dedalo/<mediaDir>/…"` (the write gate). */
export function relativizeMediaSrc(html: string): string {
	return rebase(html, config.media.webBase, `/dedalo/${config.mediaDir}`);
}

/** App-served form: `src="/dedalo/<mediaDir>/…"` → `src="<webBase>/…"` (the emit hook). */
export function appServedMediaSrc(html: string): string {
	return rebase(html, `/dedalo/${config.mediaDir}`, config.media.webBase);
}

/** {@link appServedMediaSrc} over stored items' string `value` (the save echo, the read's twin). */
export function appServedMediaItems(items: unknown[]): unknown[] {
	return items.map((item) => {
		const value = (item as { value?: unknown } | null)?.value;
		return typeof value === 'string'
			? { ...(item as object), value: appServedMediaSrc(value) }
			: item;
	});
}
