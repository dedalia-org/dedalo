/**
 * tool_posterframe server module (PHP tool_posterframe).
 *
 * create_identifying_image: extract a frame from an AV record at a timecode and
 *   store it as the identifying image of a NEW record created through a portal on
 *   the host record. Three permission targets: READ on the AV source (the
 *   declarative record_tipo/1 gate), WRITE on the host portal of the host record
 *   (THE WRITE DOOR, in the handler — the grant addresses the portal save) and
 *   WRITE on the new record's image component (its section target).
 * get_ar_identifying_image: for a section record, return the identifying-image
 *   descriptors of every record that inversely references it.
 *
 * The media half (frame extract + derivative regen) lives in the tested
 * posterframe core; this module wires the DB portal-create + ontology walk.
 */

import { mediaTypeOf } from '../../../src/core/concepts/media.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { resolveMediaPathOptions } from '../../../src/core/media/ontology_path.ts';
import type { MediaIdentity } from '../../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../../src/core/media/tool_support.ts';
import { createIdentifyingImageCore } from '../../../src/core/media/tools/posterframe.ts';
import { termByTipo } from '../../../src/core/ontology/labels.ts';
import { getTranslatableByTipo } from '../../../src/core/ontology/resolver.ts';
import { editScopeComponents } from '../../../src/core/ontology/virtual_scope.ts';
import { getElementTargetSectionTipos } from '../../../src/core/relations/request_config/build.ts';
import { toolAddNewElementAccess } from '../../../src/core/relations/save.ts';
import { currentApplicationLang, currentDataLang } from '../../../src/core/resolve/request_lang.ts';
import { findInverseReferences } from '../../../src/core/search/search_related.ts';
import { saveComponentData } from '../../../src/core/section/record/save_component.ts';
import {
	authorizeRecordAccess,
	authorizeSectionTarget,
} from '../../../src/core/security/write_door.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

/** The caller-supplied portal host locator (`options.item_value`). */
interface ItemValue {
	component_portal?: string;
	component_image?: string;
	/** Union kept: the client echoes back the locator it was SERVED, so an
	 * install whose jsonb is not yet swept still sends the legacy string form
	 * (WC-2026-08-10-section-id-int-canonical); coerced below and re-checked as
	 * an integer before the scope gate. Narrows at contraction. */
	section_id?: number | string;
	section_tipo?: string;
}

/** A posterframe step that could not complete — operator-facing, never the wire. */
function posterframeFailed(reason: string): DedaloError {
	return new DedaloError('tool.action_failed', {
		coordinates: { tool: 'tool_posterframe' },
		message: reason,
	});
}

/**
 * create_identifying_image — declarative gate covers the AV source (record/1);
 * the portal WRITE gate is imperative here (PHP asserts level 2 on the portal).
 */
async function createIdentifyingImage(ctx: ToolActionContext): Promise<ToolResponse> {
	const itemValue = (ctx.options.item_value ?? {}) as ItemValue;
	const currentTime = String(ctx.options.current_time ?? '');
	const portalComponentTipo = String(itemValue.component_portal ?? '');
	const imageComponentTipo = String(itemValue.component_image ?? '');
	const hostSectionTipo = String(itemValue.section_tipo ?? '');
	if (portalComponentTipo === '' || imageComponentTipo === '' || hostSectionTipo === '') {
		throw new DedaloError('request.invalid_options', {
			publicMessage:
				'Missing required parameters: item_value.component_portal/component_image/section_tipo',
		});
	}

	// THE HOST IS A WRITE TARGET (closure Step 3 req 10 — the tool_posterframe
	// host scope; WC-2026-09-30-write-door). PHP asserted the portal pair at 2
	// (assert_tipo_permission) and the host record in the user's scope (SEC-024
	// §9.4). The port read the RAW pair level and asked the scope only for a
	// non-admin with a positive integer id — so a missing or non-positive host id
	// skipped the scope (a global admin's -1 reached root's record), the dd128
	// own-record downgrade never applied to the portal pair, and the section
	// floor was never asked. The write door asks all of it, in its one order, and
	// the portal write below is addressed by the GRANT, never by the payload.
	const host = await authorizeRecordAccess(
		ctx.principal,
		{
			section_tipo: itemValue.section_tipo,
			component_tipo: itemValue.component_portal,
			section_id: itemValue.section_id,
		},
		{ mode: 'write', level: 2, sectionFloor: 1, door: 'tool_posterframe.create_identifying_image' },
	);

	// AV source context (declarative record_tipo/1 gate already ran on options.section_tipo/section_id).
	const avContext = await resolveMediaToolContext(ctx.options);
	if (avContext.spec.model !== 'component_av') {
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: 'The source component is not a component_av',
			coordinates: { model: avContext.spec.model },
		});
	}

	// Resolve the portal's target section, then create + persist a new record
	// through the portal (PHP add_new_element + Save). The target is PHP
	// get_ar_target_section_tipo() in mode 'edit' — the portal's request_config
	// sqo.section_tipo (implicit relations walk for a config-less portal), the
	// SAME law the save's target_sections membership validates. Never the bare
	// ontology relations: a portal declaring its target only in request_config
	// (isad66) has none.
	const portalTargetSectionTipo =
		(await getElementTargetSectionTipos(host.componentTipo, host.sectionTipo, 'edit'))[0] ?? null;
	if (portalTargetSectionTipo === null) {
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: 'The portal has no target section',
			coordinates: { tipo: host.componentTipo },
		});
	}
	// The NEW record's image is written too: the (target section, image) pair at
	// write — a create names no record, so the level (consultation-capped) is its
	// whole authorization; the record itself is born under the portal's save.
	const imageTarget = await authorizeSectionTarget(
		ctx.principal,
		{ section_tipo: portalTargetSectionTipo, tipo: imageComponentTipo },
		{ level: 2, door: 'tool_posterframe.create_identifying_image.image' },
	);
	const saveResult = (await saveComponentData({
		componentTipo: host.componentTipo,
		sectionTipo: host.sectionTipo,
		sectionId: host.sectionId,
		lang: 'lg-nolan',
		changedData: [{ action: 'add_new_element', id: null, value: portalTargetSectionTipo }],
		userId: host.userId,
		principal: ctx.principal,
		// T0-2 / D3 REVISED: the portal create is a TOOL's — the server-minted
		// access asks the SECTION level + target_sections, not the New button.
		toolCreateAccess: toolAddNewElementAccess(ctx.principal, 'tool_posterframe'),
	})) as { ok: boolean; message: string; created_section_id?: number };
	if (!saveResult.ok || saveResult.created_section_id == null) {
		throw new DedaloError('record.save_failed', {
			coordinates: { tipo: host.componentTipo, section_tipo: host.sectionTipo },
			message: `unable to create portal record element: ${saveResult.message}`,
		});
	}
	const newSectionId = saveResult.created_section_id;

	// Build the IMAGE target context on the new record.
	const imageSpec = mediaTypeOf('component_image');
	if (imageSpec === null) throw posterframeFailed('component_image media spec unavailable');
	const translatable = await getTranslatableByTipo(imageTarget.componentTipo);
	const imageIdentity: MediaIdentity = {
		componentTipo: imageTarget.componentTipo,
		sectionTipo: portalTargetSectionTipo,
		sectionId: newSectionId,
		// currentDataLang(), NOT config.menu.dataLang (P0-7/DATA-01): this is the
		// MEDIA IDENTITY the poster frame is written under, so the install default
		// filed the frame against a language the operator was not looking at.
		lang: translatable ? currentDataLang() : null,
	};
	// Record-scoped (T1-10): the new record's bucket and image_id stem, both empty
	// on a fresh record unless the portal's defaults filled them.
	const imagePathOpts = await resolveMediaPathOptions(
		imageTarget.componentTipo,
		portalTargetSectionTipo,
		newSectionId,
	);

	const outcome = await createIdentifyingImageCore(
		{ spec: avContext.spec, identity: avContext.identity, pathOpts: avContext.pathOpts },
		{ spec: imageSpec, identity: imageIdentity, pathOpts: imagePathOpts },
		currentTime,
	);
	if (!outcome.created) {
		throw posterframeFailed('posterframe could not be created (no video stream?)');
	}

	// RECORD what was written. createIdentifyingImageCore only touches the DISK
	// (frame extraction + derivative regeneration) and RETURNS the files_info
	// scan; persisting it is a separate call. Returning it to the client is not
	// the same thing — without this the freshly created portal record has an
	// empty `media` key, tool_media_versions reports "Files info data is unsync",
	// and an image has no read-time rescan to repair it (component_av does).
	// Same defect the importer had; the two shipped it independently, which is
	// why the ingest→persist pairing now has a gate.
	//
	// The record was created moments ago through the portal, so there are no
	// existing items — persistUploadedMedia mints the first one.
	{
		const { persistUploadedMedia } = await import(
			'../../../src/core/media/tools/files_info_persist.ts'
		);
		const { buildMediaIdentifier } = await import('../../../src/core/media/path.ts');
		// Derived from the path actually written, not guessed: the extension is
		// whatever the frame extractor produced.
		const writtenName = outcome.posterframePath?.split('/').pop() ?? '';
		const posterName = writtenName !== '' ? writtenName : buildMediaIdentifier(imageIdentity);
		await persistUploadedMedia({
			sectionTipo: imageIdentity.sectionTipo,
			sectionId: imageIdentity.sectionId,
			componentTipo: imageIdentity.componentTipo,
			lang: imageIdentity.lang,
			filesInfo: outcome.filesInfo,
			originalFileName: posterName,
			originalNormalizedName: posterName,
		});
	}

	return ok(
		{ section_id: newSectionId, files_info: outcome.filesInfo },
		{ requestId: toolRequestId(ctx) },
	);
}

/** get_ar_identifying_image — descriptors for records inversely referencing this one. */
async function getArIdentifyingImage(ctx: ToolActionContext): Promise<ToolResponse> {
	const sectionTipo = String(ctx.options.section_tipo ?? '');
	const sectionId = Number(ctx.options.section_id);
	if (sectionTipo === '' || !Number.isInteger(sectionId) || sectionId <= 0) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'section_tipo and a positive section_id are required',
		});
	}

	const rawHits = await findInverseReferences(
		[{ section_tipo: sectionTipo, section_id: sectionId }],
		{
			order: 'section_id',
		},
	);
	// TOOLS-08 (2026-07-28 audit): scope the inverse-reference hits to the
	// caller's projects filter — the THIRD door of the AUTHZ-05 class the prior
	// audit's R4 fix wired into relation_list.ts / dd_core_api.ts but not here.
	// Without it, a non-admin enumerates the existence of records (in other
	// tenants' projects) that reference the target. Global admins are unscoped.
	const { scopeInverseReferenceHits } = await import('../../../src/core/security/record_scope.ts');
	const hits = await scopeInverseReferenceHits(rawHits, ctx.principal);
	// One scope walk per DISTINCT hit section (request-local — no module state):
	// every hit of a section answers the same portal + label.
	const bySection = new Map<string, Promise<IdentifyingPortal | null>>();
	const descriptors: Record<string, unknown>[] = [];
	for (const hit of hits) {
		let portal = bySection.get(hit.section_tipo);
		if (portal === undefined) {
			portal = identifyingPortalOfSection(hit.section_tipo);
			bySection.set(hit.section_tipo, portal);
		}
		const found = await portal;
		if (found === null) continue;
		descriptors.push({
			section_id: hit.section_id,
			section_tipo: hit.section_tipo,
			component_portal: found.componentPortal,
			component_image: found.componentImage,
			label: found.label,
		});
	}
	// An EMPTY selection is an empty ARRAY, not `false` (the legacy body's
	// "nothing found" sentinel): the client iterates `.length`.
	return ok(descriptors, { requestId: toolRequestId(ctx) });
}

/** A section's identifying portal: the portal, its image component, the section label. */
interface IdentifyingPortal {
	componentPortal: string;
	componentImage: string;
	label: string;
}

/**
 * The FIRST component_portal of the section's VIRTUAL EDIT SCOPE whose ontology
 * properties declare an identifying_image (PHP
 * get_ar_children_tipo_by_model_name_in_section(…, resolve_virtual=true),
 * class.tool_posterframe.php:462-467): for a virtual section (tch1, rsc197…)
 * the REAL section's portals minus its exclude_elements subtrees — never the
 * virtual's own children. The label stays the HIT section's (the virtual's) term.
 */
async function identifyingPortalOfSection(sectionTipo: string): Promise<IdentifyingPortal | null> {
	for (const node of await editScopeComponents(sectionTipo)) {
		if (node.model !== 'component_portal') continue;
		const props = (node.properties ?? null) as { identifying_image?: unknown } | null;
		const identifyingImage = props?.identifying_image;
		if (typeof identifyingImage === 'string' && identifyingImage !== '') {
			return {
				componentPortal: node.tipo,
				componentImage: identifyingImage,
				label: await termByTipo(sectionTipo, currentApplicationLang()),
			};
		}
	}
	return null;
}

export const tool: ToolServerModule = {
	name: 'tool_posterframe',
	apiActions: {
		create_identifying_image: {
			permission: 'record_tipo',
			minLevel: 1,
			handler: createIdentifyingImage,
		},
		// 'record', NOT 'record_tipo': this action's handler and client send only
		// section_tipo + section_id, and PHP gates it assert_section_permission(1) +
		// assert_record_in_user_scope (class.tool_posterframe.php:382-384). Gating a
		// component pair here makes it unsatisfiable for every caller.
		get_ar_identifying_image: { permission: 'record', minLevel: 1, handler: getArIdentifyingImage },
	},
};
