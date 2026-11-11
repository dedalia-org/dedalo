/**
 * THE SCREEN AN EXPORT IS COMPARED WITH (owner decision D4,
 * WC-2026-11-09-export-relation-display): the EDIT section read of one host
 * record, through the real API door (dispatchRqo, a real session), as the
 * principal. The export of a plain relation column must carry exactly what
 * this read embeds for it — gates cross-check against it instead of trusting
 * a second notion of "display".
 */

import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { clearFrontierIdentityCaches } from './export_frontier_identity.ts';

/** One item of the read's data list (only the fields the gates read). */
export interface HostReadItem {
	typo?: unknown;
	tipo?: unknown;
	section_tipo?: unknown;
	section_id?: unknown;
	entries?: unknown;
	from_component_tipo?: unknown;
}

/** The request context of a fresh real session for `principal` (swept by registerSessionCleanup). */
export function hostReadContext(principal: Principal, requestId: string) {
	const token = createSession(principal.userId, `${requestId}_${principal.userId}`, false);
	const session = getSession(token);
	return {
		requestId,
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal,
	};
}

/** One context entry of the read (only the fields the gates read). */
export interface HostReadContextEntry {
	tipo?: unknown;
	section_tipo?: unknown;
	request_config?: { sqo?: { section_tipo?: { tipo?: unknown; existence_only?: unknown }[] } }[];
}

/** The edit section read of `host`#`sectionId` as `principal` — its data items, sections row dropped. */
export async function hostSectionReadItems(
	principal: Principal,
	host: string,
	sectionId: number,
	lang: string,
	requestId: string,
): Promise<HostReadItem[]> {
	return (await hostSectionRead(principal, host, sectionId, lang, requestId)).data;
}

/** The edit section read of `host`#`sectionId` as `principal` — data items (sections row dropped) AND context. */
export async function hostSectionRead(
	principal: Principal,
	host: string,
	sectionId: number,
	lang: string,
	requestId: string,
): Promise<{ data: HostReadItem[]; context: HostReadContextEntry[] }> {
	clearFrontierIdentityCaches();
	const rqo = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: host,
			section_tipo: host,
			action: 'search',
			mode: 'edit',
			lang,
			session_save: false,
		},
		sqo: {
			section_tipo: [host],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: host, section_id: String(sectionId) }],
		},
	};
	const result = await dispatchRqo(rqo as never, hostReadContext(principal, requestId) as never);
	const body = result.body as {
		data?: { data?: HostReadItem[]; context?: HostReadContextEntry[] };
		error?: { code?: string };
	};
	if (body.error !== undefined) throw new Error(`section read refused: ${body.error.code}`);
	return {
		data: (body.data?.data ?? []).filter((item) => item.typo !== 'sections'),
		context: body.data?.context ?? [],
	};
}

/** Every literal value an item carries (input_text entries: {value}). */
export function hostReadItemValues(item: HostReadItem): string[] {
	const entries = Array.isArray(item.entries) ? item.entries : [];
	return entries
		.map((entry) => (entry as { value?: unknown })?.value)
		.filter((value): value is string => typeof value === 'string' && value !== '');
}

/**
 * The column's DISPLAY as the section read embeds it: walk the read's own
 * output from the column's item — its locators lead to the target records, the
 * items emitted AT a reached record are what the read shows there, and a
 * relation item among them leads one level deeper. Every literal value met is
 * displayed — so are the column's frame targets (its dataframe slot at the
 * host). (Only records the read EXPANDED carry items; a locator to a record it
 * did not expand reaches nothing.)
 */
export function hostColumnDisplayedValues(
	items: readonly HostReadItem[],
	column: string,
	host: string,
	hostId: number,
): string[] {
	const at = (sectionTipo: unknown, sectionId: unknown) =>
		items.filter(
			(item) => item.section_tipo === sectionTipo && String(item.section_id) === String(sectionId),
		);
	const locatorsOf = (item: HostReadItem) =>
		(Array.isArray(item.entries) ? item.entries : []).filter(
			(entry): entry is { section_tipo: string; section_id: unknown } =>
				typeof (entry as { section_tipo?: unknown })?.section_tipo === 'string' &&
				(entry as { section_id?: unknown }).section_id !== undefined,
		);
	const values = new Set<string>();
	const seen = new Set<string>();
	// the column's own item, plus its dataframe slot at the host (frames paired
	// to the column's items: `main_component_tipo` names the column)
	const ofColumn = (item: HostReadItem) =>
		item.tipo === column ||
		locatorsOf(item).some(
			(entry) => (entry as { main_component_tipo?: unknown }).main_component_tipo === column,
		);
	let frontier = at(host, hostId).filter(ofColumn).flatMap(locatorsOf);
	while (frontier.length > 0) {
		const next: { section_tipo: string; section_id: unknown }[] = [];
		for (const locator of frontier) {
			const key = `${locator.section_tipo}#${String(locator.section_id)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			for (const item of at(locator.section_tipo, locator.section_id)) {
				for (const value of hostReadItemValues(item)) values.add(value);
				next.push(...locatorsOf(item));
			}
		}
		frontier = next;
	}
	return [...values].sort();
}
