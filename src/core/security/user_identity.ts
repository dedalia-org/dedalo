/**
 * USER IDENTITY — the display name behind a user id.
 *
 * Extracted from `area_maintenance/user_stats.ts`, which owned the only copy,
 * when a SECOND caller appeared: the record-scoped job listing has to say WHOSE
 * transcode is holding a tier, or an operator whose build button is disabled
 * has no way to learn why. A private copy in `core/api/` would have been a
 * second source of truth for "what is this user called".
 *
 * `dd132` is the users section's name component (USERS_SECTION dd128).
 */

/** The users section (PHP DEDALO_SECTION_USERS_TIPO). */
export const USERS_SECTION = 'dd128';

/** The users section's name component. */
const USER_NAME_COMPONENT = 'dd132';

/**
 * A users-section record id read off a stored locator / stamp, or null.
 * Any non-zero integer: root is a REAL user record at -1 (it stamps every
 * install-time and superuser edit), so a `> 0` test silently erases it.
 */
export function userRecordId(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const id = Number(value);
	return Number.isInteger(id) && id !== 0 ? id : null;
}

/**
 * The user's display name, or null when the record or the component has none.
 *
 * Null is a real answer, not a failure: a user record whose name component was
 * never filled has no name to show, and callers render the id or nothing rather
 * than inventing a label.
 *
 * COVERAGE-EXEMPT (coverage plan §5.1; reason registered in
 * engineering/crap_coverage_exempt.json): three dynamic imports and one component
 * read turning a dd128 id into a display name — every branch is null-vs-value on
 * its own read. Its callers INJECT it as a function into the gated fold
 * (`foldStatsRows`, area_maintenance/user_stats.ts), which is where the label
 * behaviour is actually asserted.
 */
export async function resolveUserName(
	userId: string | number,
	lang: string,
): Promise<string | null> {
	const { readMatrixRecord } = await import('../db/matrix.ts');
	const record = await readMatrixRecord('matrix_users', USERS_SECTION, Number(userId));
	if (record === null) return null;
	const { resolveComponentValue } = await import('../resolve/component_data.ts');
	const { getModelByTipo } = await import('../ontology/resolver.ts');
	const model = (await getModelByTipo(USER_NAME_COMPONENT)) ?? 'component_input_text';
	const { value, fallbackValue } = await resolveComponentValue(
		record,
		USER_NAME_COMPONENT,
		model,
		lang,
	);
	const first = (value ?? fallbackValue)?.[0] as { value?: unknown } | undefined;
	return typeof first?.value === 'string' ? first.value : null;
}

/** The users section's "Default section" component (TODO-070). */
const USER_DEFAULT_SECTION_COMPONENT = 'dd1603';

/**
 * The tipo the user lands on after login when the URL names none (dd1603
 * "Default section", e.g. 'numisdata6'), or null when the record has none.
 * Only a shape check here: the caller decides whether that tipo is a page the
 * user may open, because a stale or ungranted default must never block a login.
 */
export async function resolveUserDefaultSection(userId: number): Promise<string | null> {
	const { readMatrixRecord } = await import('../db/matrix.ts');
	const record = await readMatrixRecord('matrix_users', USERS_SECTION, userId);
	if (record === null) return null;
	const { resolveComponentValue } = await import('../resolve/component_data.ts');
	const { getModelByTipo } = await import('../ontology/resolver.ts');
	const { currentDataLang } = await import('../resolve/request_lang.ts');
	const model = (await getModelByTipo(USER_DEFAULT_SECTION_COMPONENT)) ?? 'component_input_text';
	const { value, fallbackValue } = await resolveComponentValue(
		record,
		USER_DEFAULT_SECTION_COMPONENT,
		model,
		currentDataLang(),
	);
	const tipo = firstItemText(value ?? fallbackValue);
	return /^[a-z]+[0-9]+$/.test(tipo) ? tipo : null;
}

/** The users section's image component (component_image dd522). */
const USER_IMAGE_COMPONENT = 'dd522';

/**
 * The user's avatar WEB URL (dd522), or null when the account has no image on
 * disk — the login panel then keeps its bundled icon.
 *
 * DISK IS THE TRUTH, exactly like the other server-emitted media URLs
 * (media/component_emit.ts posterframe/base_svg_url): the location comes from
 * the path grammar and the URL is only returned for a file that EXISTS. A URL
 * emitted by grammar alone 404s, and the client's preload turns that into a
 * login circle with no image at all — worse than the fallback.
 *
 * Quality order is the LIST ladder (default quality, then thumb): the login
 * circle is 160 px but the same URL backs the root user's full-screen
 * background (login.less `--user_login_image`).
 */
export async function resolveUserImageUrl(userId: number): Promise<string | null> {
	// The media grammar names files by a POSITIVE section id, so root (-1) has no
	// media file at all (buildMediaIdentifier refuses it). Null, never a throw:
	// a login must not fail over a decorative image.
	if (!Number.isInteger(userId) || userId <= 0) return null;
	const { mediaTypeOf } = await import('../concepts/media.ts');
	const spec = mediaTypeOf('component_image');
	if (spec === null) return null;
	const { scanFilesInfo } = await import('../media/files_info.ts');
	const { resolveMediaPathOptions } = await import('../media/ontology_path.ts');
	const { versionedMediaUrl } = await import('../media/url_version.ts');
	const { config } = await import('../../config/config.ts');
	const pathOpts = await resolveMediaPathOptions(USER_IMAGE_COMPONENT, USERS_SECTION, userId);
	// image is not translatable: no lang suffix on the identifier
	const entries = scanFilesInfo(
		spec,
		{
			componentTipo: USER_IMAGE_COMPONENT,
			sectionTipo: USERS_SECTION,
			sectionId: userId,
			lang: null,
		},
		pathOpts,
	);
	for (const quality of spec.listQualities) {
		const entry = entries.find((el) => el.quality === quality);
		if (entry?.file_path) return versionedMediaUrl(`${config.media.webBase}${entry.file_path}`);
	}
	return null;
}

/** The users section's "User interface preferences" component (component_json). */
const USER_UI_PREFERENCES_COMPONENT = 'dd1206';

/** Above this the stored document is not a preference set: never shipped to every page. */
const UI_PREFERENCES_MAX_BYTES = 4096;

/**
 * The user's own UI preferences (dd1206, e.g. `{ active_style: 'lift' }`), or null.
 * The client owns the meaning of every key (an unknown value falls back to its
 * default), so the server only guarantees a small plain object.
 */
export async function resolveUserUiPreferences(
	userId: number,
): Promise<Record<string, unknown> | null> {
	const { readMatrixRecord } = await import('../db/matrix.ts');
	const record = await readMatrixRecord('matrix_users', USERS_SECTION, userId);
	if (record === null) return null;
	const { resolveComponentValue } = await import('../resolve/component_data.ts');
	const { value } = await resolveComponentValue(
		record,
		USER_UI_PREFERENCES_COMPONENT,
		'component_json',
		'lg-nolan',
	);
	return pickUiPreferences(value);
}

/** The first item's `value` when it is a plain object within the size cap; else null. */
export function pickUiPreferences(
	items: readonly unknown[] | null | undefined,
): Record<string, unknown> | null {
	const value = (items?.[0] as { value?: unknown } | undefined)?.value;
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	return JSON.stringify(value).length <= UI_PREFERENCES_MAX_BYTES
		? (value as Record<string, unknown>)
		: null;
}

/** The first item's text — a bare string or a `{ value }` item — trimmed; '' when none. */
function firstItemText(items: readonly unknown[] | null | undefined): string {
	const first = items?.[0] as { value?: unknown } | string | undefined;
	return (typeof first === 'string' ? first : first?.value)?.toString().trim() ?? '';
}
