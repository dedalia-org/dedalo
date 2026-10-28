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
	const first = (value ?? fallbackValue)?.[0] as { value?: unknown } | string | undefined;
	const tipo = (typeof first === 'string' ? first : first?.value)?.toString().trim() ?? '';
	return /^[a-z]+[0-9]+$/.test(tipo) ? tipo : null;
}
