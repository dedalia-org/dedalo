/**
 * WRITE tools — save a component value, create/delete a record.
 *
 * Each handler reuses the exact engines and permission gates the human API
 * dispatch applies (level >= 2, server-authoritative, per the dd774 matrix)
 * PLUS the per-record projects scope gate (foundation audit AI-01) — an LLM
 * can never write where its configured user could not, and never a record the
 * user cannot see (cross-project IDOR). Every change is audited in the Time
 * Machine (deletes snapshot the full record first, so they stay recoverable).
 *
 * The transport-level CSRF of the browser API does not apply here (no cookie
 * session to ride); its role is played by the fixed service principal plus the
 * explicit DEDALO_MCP_ALLOW_WRITE opt-in that gates whether these specs are
 * registered AT ALL (read-only by default, fail-closed — see server.ts).
 */

import { z } from 'zod';
import { DedaloError } from '../../../core/errors/dedalo_error.ts';
import { resolveDataTipo } from '../../../core/ontology/alias.ts';
import { getModelByTipo } from '../../../core/ontology/resolver.ts';
import { currentDataLang } from '../../../core/resolve/request_lang.ts';
import { assertValidTipo } from '../../../core/search/identifier_gate.ts';
import type { Principal } from '../../../core/security/permissions.ts';
import { defineTool, type ToolSpec } from '../tool_spec.ts';

/**
 * THE WRITE DOOR (closure Step 3; WC-2026-09-30-write-door) — the ONE
 * authorization every record-addressed write shares with the human API
 * dispatch: grammar (an INTEGER id — 1.5 is refused, never floored), the
 * SECTION floor 1 (new on this door: a profile holding 0 on the section is
 * refused, as the human read refuses it), the (section, component) pair with
 * the dd128 own-record rule, then the per-record projects scope with the
 * non-positive-id refusal ahead of the admin bypass (foundation audit AI-01:
 * the level gate alone would let the service principal mutate a record it can
 * never see). The effect is addressed by the returned grant.
 */
async function authorizeWrite(
	principal: Principal,
	raw: { section_tipo: string; component_tipo: string; section_id: unknown },
	door: string,
) {
	const { authorizeRecordAccess } = await import('../../../core/security/write_door.ts');
	return authorizeRecordAccess(principal, raw, {
		mode: 'write',
		level: 2,
		sectionFloor: 1,
		door,
	});
}

/** A create: no record named, so the consultation-capped SECTION level is its whole authorization. */
async function authorizeSectionCreate(principal: Principal, sectionTipo: string, door: string) {
	const { authorizeSectionTarget } = await import('../../../core/security/write_door.ts');
	return authorizeSectionTarget(principal, { section_tipo: sectionTipo }, { level: 2, door });
}

/**
 * A whole-record effect (delete): the consultation-capped section level + the
 * scope of the record, whose id the DOOR requires — an absent one is
 * `request.invalid`, never read as a create (the zod `inputShape` is not the
 * authorization; a caller that skips it must not reach a null target).
 */
async function authorizeSectionRecordWrite(
	principal: Principal,
	raw: { section_tipo: string; section_id: unknown },
	door: string,
) {
	const { authorizeSectionRecord } = await import('../../../core/security/write_door.ts');
	return authorizeSectionRecord(principal, raw, { level: 2, door });
}

/**
 * Update/insert/remove/clear one item of a component's value, as the principal —
 * the same saveComponentData path (and TM audit) the human save action uses.
 */
/**
 * REMOVE NAMES ITS ITEM, ON THIS DOOR TOO (DATA-06, 2026-08-30).
 *
 * The schema cannot express "required only when action is remove" — zod validates one
 * field at a time — so `item_id` stays optional there and the conditional requirement
 * lives here, in the handler, where an agent's omission is refused before anything is
 * written. This is the door the defect was CONFIRMED at: `item_id` was optional,
 * omission mapped straight onto `id: null`, and an agent asked to "remove the English
 * title" deleted every other language and was told ok.
 */
async function assertRemoveNamesItem(
	action: string,
	itemId: number | string | null | undefined,
	sectionTipo: string,
	componentTipo: string,
): Promise<void> {
	if (action !== 'remove') return;
	if (itemId !== undefined && itemId !== null) return;
	// THE ONE MODEL WHOSE REMOVE NAMES A RECORD, NOT AN ITEM (user decision
	// 2026-09-27, plan item 2): component_relation_children owns no items — its
	// entries are computed per read and carry no id — so a child is removed BY
	// LOCATOR (`value`). The engine routes that model to the write-through
	// (relations/children_write.ts) AHEAD of its own remove sentinel; the
	// write-through authorizes every child, records each child's TM row and
	// refuses a remove whose value names no record (request.invalid_data, never a
	// wipe). Same test as the engine (the DATA tipo, after the alias hop), so the
	// door can never let past what the engine would not route there. Every OTHER
	// model is still refused here, before the permission probe.
	if (await isChildrenField(componentTipo)) return;
	throw new DedaloError('record.remove_without_id', {
		publicMessage:
			"remove needs item_id: the id of the ONE item to remove (read the component first to get it). To empty the component in every language, send action 'clear' instead.",
		coordinates: { section_tipo: sectionTipo, tipo: componentTipo },
	});
}

/** Whether the tipo's DATA tipo (alias-resolved, as the engine resolves it) is a children field. */
async function isChildrenField(componentTipo: string): Promise<boolean> {
	const dataTipo = await resolveDataTipo(componentTipo);
	return (await getModelByTipo(dataTipo)) === 'component_relation_children';
}

export async function saveComponentValue(
	principal: Principal,
	input: {
		section_tipo: string;
		tipo: string;
		section_id: number;
		lang?: string;
		action: 'update' | 'insert' | 'remove' | 'clear';
		/** The item value ({id, value, lang} literal or a locator); omit for remove/clear — except a children remove, whose value IS the child locator. */
		value?: unknown;
		/** Target item id — REQUIRED for remove, except on a children field (removed BY LOCATOR in `value`). */
		item_id?: number | null;
	},
): Promise<{ ok: boolean; message?: string; data: unknown }> {
	const sectionTipo = assertValidTipo(input.section_tipo, 'mcp.save.section_tipo');
	const componentTipo = assertValidTipo(input.tipo, 'mcp.save.tipo');
	// THE REMOVE SENTINEL AT THE AGENT DOOR (DATA-06, 2026-08-30). `item_id` is
	// OPTIONAL in the schema — zod validates one field at a time, so the
	// requirement is conditional and lives here — and an omitted one used to map
	// onto id:null, which the write engine read as "empty the component in every
	// language" and reported as a success. An agent told to "remove the English
	// title" therefore deleted every other language and answered ok:true. The
	// engine now refuses that shape; this refusal is the same law stated where the
	// agent can act on it, BEFORE any permission probe or write is attempted.
	await assertRemoveNamesItem(input.action, input.item_id, sectionTipo, componentTipo);
	const grant = await authorizeWrite(
		principal,
		{ section_tipo: sectionTipo, component_tipo: componentTipo, section_id: input.section_id },
		'mcp.save_component',
	);

	// THE WRITE LANGUAGE (audit DATA-24). This door defaulted every omitted lang
	// to 'lg-nolan', which saveComponentData stamps verbatim: a TRANSLATABLE
	// component then held an item no language ever serves as its value — it
	// renders as a marked fallback in every language, forever, and a later
	// genuine save leaves the nolan orphan in place. A translatable component
	// takes the session's data language; a non-translatable one is lg-nolan by
	// definition, whatever the caller asked for — EXCEPT a TRANSLITERABLE one
	// (with_lang_versions / component_iri), which keeps an EXPLICIT input.lang
	// (its per-language version) and defaults to its lg-nolan base. The one
	// instance-lang rule (resolver.ts elementLang).
	const { elementLang } = await import('../../../core/ontology/resolver.ts');
	const lang = await elementLang(componentTipo, (await getModelByTipo(componentTipo)) ?? '', {
		requested: input.lang ?? null,
		ambient: currentDataLang(),
	});

	const { saveComponentData } = await import('../../../core/section/record/save_component.ts');
	const outcome = await saveComponentData({
		componentTipo: grant.componentTipo,
		sectionTipo: grant.sectionTipo,
		sectionId: grant.sectionId,
		lang,
		changedData: [{ action: input.action, id: input.item_id ?? null, value: input.value }],
		userId: principal.userId,
		principal,
	});
	return { ok: outcome.ok, message: outcome.ok ? undefined : outcome.message, data: outcome.data };
}

/** Create a new record in a section (counter-allocated id + audit metadata). */
export async function createRecord(
	principal: Principal,
	input: { section_tipo: string },
): Promise<{ section_id: number }> {
	const sectionTipo = assertValidTipo(input.section_tipo, 'mcp.create.section_tipo');
	// No record named: the (consultation-capped) section level is the whole
	// authorization of a create.
	const grant = await authorizeSectionCreate(principal, sectionTipo, 'mcp.create');
	const { createSectionRecord } = await import('../../../core/section/record/create_record.ts');
	const sectionId = await createSectionRecord(grant.sectionTipo, principal.userId);
	return { section_id: sectionId };
}

/**
 * Delete one record (delete_record mode: Time Machine snapshot first, then row
 * removal — recoverable through the TM history, like the human delete action).
 */
export async function deleteRecord(
	principal: Principal,
	input: { section_tipo: string; section_id: number },
): Promise<{ deleted: number[] }> {
	const sectionTipo = assertValidTipo(input.section_tipo, 'mcp.delete.section_tipo');
	const grant = await authorizeSectionRecordWrite(
		principal,
		{ section_tipo: sectionTipo, section_id: input.section_id },
		'mcp.delete',
	);
	const { deleteSectionRecord } = await import('../../../core/section/record/delete_record.ts');
	const outcome = await deleteSectionRecord(grant.sectionTipo, grant.sectionId, principal.userId);
	// THE REVOCATION SEAM (P1-4, SEC-08): deleting a user record ends that account's
	// sessions, media markers and pending recovery codes. A no-op for any other section.
	if (outcome.deleted.length > 0) {
		const { revokeDeletedAccountAccess } = await import('../../../core/security/revocation.ts');
		for (const deletedId of outcome.deleted) {
			revokeDeletedAccountAccess(sectionTipo, deletedId, 'mcp delete_record');
		}
	}
	return { deleted: outcome.deleted };
}

// ---------------------------------------------------------------------------
// Specs — registered only under the fail-closed write opt-in (registry/server).
// ---------------------------------------------------------------------------

export const RECORDS_WRITE_SPECS: ToolSpec[] = [
	defineTool({
		name: 'dedalo_save_component',
		title: 'Save a component value',
		description:
			'Update, insert, or remove one item of a component value on a record (or clear it), ' +
			'as the configured user (write permission enforced server-side; every ' +
			'change is audited in the Time Machine).',
		tier: 'primitive',
		write: true,
		annotations: {
			readOnlyHint: false,
			// DESTRUCTIVE, and said so 2026-08-30 (DATA-06): 'remove' deletes an
			// item and 'clear' empties the component in every language. The hint is
			// what a host consults before asking a human to confirm, so a save door
			// that can delete curated values must not advertise itself as additive.
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputShape: {
			section_tipo: z.string().describe('The record section tipo, e.g. "oh1".'),
			tipo: z.string().describe('The component tipo to modify, e.g. "oh23".'),
			section_id: z.number().describe('The record id.'),
			lang: z
				.string()
				.optional()
				.describe(
					'Language of the value, e.g. "lg-eng". Default: the session\'s data language for a ' +
						'translatable component, "lg-nolan" for every other. A non-translatable component ' +
						'with language versions (with_lang_versions, IRI) keeps an explicit lang; any other ' +
						'non-translatable one is always "lg-nolan".',
				),
			action: z
				.enum(['update', 'insert', 'remove', 'clear'])
				.describe(
					"The item operation. 'remove' deletes the ONE item named by item_id " +
						'(on a children field — component_relation_children — the ONE child named by the ' +
						'locator in value: children carry no item ids); ' +
						"'clear' empties the component in EVERY language — it is the only way to do that, " +
						'and it is never implied by an omitted item_id.',
				),
			value: z
				.unknown()
				.optional()
				.describe(
					'The item value ({id, value, lang} literal or a locator); omit for remove and clear — ' +
						'except a remove on a children field, whose value is the child record locator ' +
						'({section_tipo, section_id}).',
				),
			item_id: z
				.number()
				.optional()
				.describe(
					'Target item id. REQUIRED for remove (except on a children field, removed by the ' +
						'locator in value); ignored by clear.',
				),
		},
		handler: saveComponentValue,
	}),
	defineTool({
		name: 'dedalo_create_record',
		title: 'Create a record',
		description:
			'Create a new empty record in a section as the configured user ' +
			'(write permission enforced server-side). Returns the new section_id.',
		tier: 'primitive',
		write: true,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputShape: {
			section_tipo: z.string().describe('The section to create the record in, e.g. "oh1".'),
		},
		handler: createRecord,
	}),
	defineTool({
		name: 'dedalo_delete_record',
		title: 'Delete a record',
		description:
			'Delete one record as the configured user (write permission enforced ' +
			'server-side). A full Time Machine snapshot is stored first, so the ' +
			'record remains recoverable.',
		tier: 'primitive',
		write: true,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputShape: {
			section_tipo: z.string().describe('The record section tipo, e.g. "oh1".'),
			section_id: z.number().describe('The record id to delete.'),
		},
		handler: deleteRecord,
	}),
];
