/**
 * dd_core_api::relation_targets — THE "Open relationships" CENSUS DOOR
 * (WC-2026-10-30-search-referenced-by-leaf). TS-only; no PHP counterpart.
 *
 * Answers "which sections do the records of this source set point at, and how
 * many records of each" so the modal can offer one window per target section,
 * each opened with `{referenced_by: <the same source>}` in its filter.
 *
 * Wire (the read_raw precedent: action-specific input in `rqo.options`, no
 * `rqo.sqo`, so no client page clamp — the source set is the WHOLE found set):
 *
 *   request  { dd_api:'dd_core_api', action:'relation_targets',
 *              options:{ source:{ <exactly a referenced_by source object> } } }
 *   response ok([{ tipo, label, total }, …])  ordered by tipo; [] = no targets
 *
 * The door's steps, in order (every refusal typed, nothing narrowed silently):
 *   1. requirePrincipal — an authenticated read.
 *   2. STRICT envelope: `options` holds exactly `source`; a `sqo` is refused
 *      (it would be ignored, and an ignored filter is a silently widened one).
 *   3. sanitizeClientReferencedBySource — the server-only strip, the strict
 *      source schema, the nesting bound (request.invalid_options).
 *   4. read >= 1 on EVERY source section (the read_raw rule) → perm.denied.
 *      buildOwnerRelationScope re-asserts it under the census; this one is the
 *      door's own, before any SQL runs.
 *   5. countRelationTargets — owner-scoped exactly like the leaf (row set +
 *      SEC-1 component key + from_component_tipo), each target kept only when
 *      the caller may read it, totals EXACT (the target's own full_count with
 *      the leaf, so the number equals what the opened window paginates).
 *   6. Labels in the request's application language (labelByTipo, the
 *      resolver structure-context uses); an unlabelled tipo shows its tipo.
 *   7. notices: `perm.out_of_scope` when the component key hid locators
 *      (readDoorNotices — one per request, never a count).
 */

import { sanitizeClientReferencedBySource } from '../../concepts/sqo.ts';
import { ok } from '../../errors/convert.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { labelByTipo } from '../../ontology/labels.ts';
import { assertValidTipo } from '../../search/identifier_gate.ts';
import { countRelationTargets } from '../../search/relation_targets.ts';
import { getPermissions, type Principal } from '../../security/permissions.ts';
import { readDoorNotices } from '../../security/read_door.ts';
import { type ApiRequestContext, requirePrincipal } from '../handler_context.ts';
import type { ApiResult } from '../response.ts';

/** The only key `rqo.options` may carry on this door. */
const OPTIONS_KEYS: ReadonlySet<string> = new Set(['source']);

/** One target section of the census, as the client renders it. */
export interface RelationTargetEntry {
	tipo: string;
	label: string;
	total: number;
}

function invalidOptions(message: string): never {
	throw new DedaloError('request.invalid_options', {
		message: `relation_targets: ${message}`,
		publicMessage: `Invalid relation_targets request: ${message}`,
	});
}

/** `options` must be a plain object whose every key is allowlisted. */
function strictOptions(options: unknown): Record<string, unknown> {
	if (options === null || typeof options !== 'object' || Array.isArray(options)) {
		invalidOptions('options must be an object holding source');
	}
	for (const key of Object.keys(options)) {
		if (!OPTIONS_KEYS.has(key)) invalidOptions(`unknown options key '${key}'`);
	}
	return options as Record<string, unknown>;
}

/** Step 2: `options` is a plain object holding exactly `source`; no `sqo`. */
function untrustedSource(rqo: unknown): unknown {
	const envelope = rqo as { options?: unknown; sqo?: unknown };
	if (envelope.sqo !== undefined) {
		invalidOptions('the source set rides options.source, not sqo');
	}
	return strictOptions(envelope.options).source;
}

/**
 * Step 4: every source section a valid tipo (request.invalid_tipo — the search
 * identifier gate, so a malformed name is never answered as perm.denied), then
 * read >= 1 on each, or perm.denied naming the first refused.
 */
async function authorizeSources(principal: Principal, sections: readonly string[]): Promise<void> {
	for (const candidate of sections) {
		const sectionTipo = assertValidTipo(candidate, 'relation_targets.source.section_tipo');
		if ((await getPermissions(principal, sectionTipo, sectionTipo)) < 1) {
			throw new DedaloError('perm.denied', { coordinates: { section_tipo: sectionTipo } });
		}
	}
}

export async function relationTargetsAction(
	rqo: unknown,
	context: ApiRequestContext,
): Promise<ApiResult> {
	const principal = requirePrincipal(context);
	const source = sanitizeClientReferencedBySource(untrustedSource(rqo));
	await authorizeSources(principal, source.section_tipo);
	// One census per SESSION (not per tab): a newer one — a scope flip, a reopen,
	// or the modal in another tab of the same session — supersedes it.
	const supersessionKey = context.session?.tokenHash;
	const targets = await countRelationTargets(source, {
		principal,
		...(supersessionKey === undefined ? {} : { supersessionKey }),
	});
	const entries: RelationTargetEntry[] = [];
	for (const target of targets) {
		entries.push({
			tipo: target.tipo,
			label: (await labelByTipo(target.tipo)) ?? target.tipo,
			total: target.total,
		});
	}
	const notices = readDoorNotices();
	return {
		status: 200,
		body: ok(entries, {
			requestId: context.requestId,
			...(notices === undefined ? {} : { notices }),
		}),
	};
}
