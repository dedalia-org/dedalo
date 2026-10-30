/**
 * MEDIA URL VERSION — the ONE `?v=<mtime ms>-<size>` token every server-emitted
 * media URL carries (WC-2026-10-29-posterframe-url-version): versioned by the
 * FILE, not the render, so the browser reuses its HTTP cache across renders and
 * a re-published file (every producer publishes by atomic rename) gets a new
 * URL. Size too: some media mounts keep mtime to the second only.
 *
 * The client builds the same token for files_info entries
 * (client/dedalo/core/component_media_common/js/media_url.js); this side covers
 * the URLs files_info does not carry: av/3d `posterframe_url`, image
 * `base_svg_url`, the indexation grid's media cells.
 */
import { statSync } from 'node:fs';
import { config } from '../../config/config.ts';
import { absoluteFromRelative } from './path.ts';

/**
 * `<mtime ms>-<size>` of the file, or null when it cannot be stat'd. ANY stat
 * error (missing, EACCES, ENOTDIR, a flaky mount) is "no file": one unreadable
 * file must never fail a whole read.
 */
export function fileVersionToken(absolutePath: string): string | null {
	try {
		const stat = statSync(absolutePath);
		return `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
	} catch {
		return null;
	}
}

/**
 * A media web URL + `?v=<token>` of the file it names; returned bare when it
 * names no readable file inside the media root (no file, no media root, a path
 * escaping the root, or not a media-web-base URL at all).
 */
export function versionedMediaUrl(url: string): string {
	const base = config.media.webBase;
	if (!url.startsWith(base)) return url;
	let absolutePath: string;
	try {
		absolutePath = absoluteFromRelative(url.slice(base.length));
	} catch {
		return url;
	}
	const token = fileVersionToken(absolutePath);
	return token === null ? url : `${url}?v=${token}`;
}
