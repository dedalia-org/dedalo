/**
 * download_answer — what every server-side download shares: the download name
 * read from the client, and the one answer shape `js/` turns into a file.
 */

import { ok } from '../../../src/core/errors/index.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { sanitize_download_name } from '../js/download_filename.js';
import { invalidOptions } from './reasons.ts';

/**
 * The download name, sanitized here whatever the client did with it
 * (`js/download_filename.js` is the one rule both sides run). Absent takes
 * `fallback`; a name that sanitizes to nothing is refused, never quietly
 * renamed. It never becomes a path: the scratch files keep fixed names.
 */
export function downloadBaseName(value: unknown, fallback: string): string {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'string') {
		throw invalidOptions('file_name must be a string');
	}
	const base = sanitize_download_name(value);
	if (base === '') {
		throw invalidOptions('file_name has no usable characters', 'file_name_unusable');
	}
	return base;
}

/** The file the browser saves: its bytes as base64, its name and its MIME. */
export function downloadAnswer(
	ctx: ToolActionContext,
	contentBase64: string,
	filename: string,
	mime: string,
): ToolResponse {
	return ok({ content_base64: contentBase64, filename, mime }, { requestId: toolRequestId(ctx) });
}
