/**
 * dd_component_info handlers (PHP core/api/v1/common/class.dd_component_info.php,
 * API_ACTIONS = ['get_widget_data'] — SEC-024 allowlist).
 *
 * The single-widget compute channel of the component_info framework: the
 * byte-identical client's widget_common.js build(autoload=true) POSTs
 * {action:'get_widget_data', dd_api:'dd_component_info', source:{tipo,
 * section_tipo, section_id, mode}, options:{widget_name}} — the delivery
 * path for ASYNC widgets (user_activity) and any lazily-built widget slot.
 *
 * ENVELOPE v2 (engineering/ERRORS_SPEC.md): the PHP `{result:false, msg:[…]}`
 * refusals are now THROWN registry codes — `perm.denied` (forbidden record),
 * `widget.empty` (the component defines no widgets) and `widget.not_defined`
 * (the named widget is not one of them). Those are exactly the codes the parity
 * reconciler maps the frozen PHP bodies to (test/parity/normalize.ts
 * FROZEN_ERROR_BODIES). Success is `ok(widget_data)`.
 * READ DOOR (WC-2026-11-10-widget-data-read-door — STRICTER than PHP, which had
 * NO gate at all: frozen class.dd_component_info.php computed for any
 * coordinates a logged-in user named). Before any compute, the write door's
 * READ mode (write_door.authorizeRecordAccess, the composition AV reads use via
 * media_action_context.ts): the section grant >= 1 → the info component's own
 * pair grant (read_door.authorizeComponentRead) → the record scope
 * (`perm.out_of_scope`). The widget's `ipo` INPUTS pass "as displayed" (owner
 * decision 2026-11-10): a widget is a derived value of the info component, so
 * the info component's grant is the whole question — no per-input grant.
 * A section_id that is not a record address is refused BY NAME
 * (`request.invalid_source`), never folded into a permission refusal; the
 * compute receives the GRANT's coordinates (an int id), never the rqo's.
 */

import { coerceSectionId } from '../../concepts/section_id.ts';
import { ok } from '../../errors/convert.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { getNode } from '../../ontology/resolver.ts';
import { currentDataLang } from '../../resolve/request_lang.ts';
import { authorizeRecordAccess, parseRecordId } from '../../security/write_door.ts';
import type { ActionHandler } from '../handler_context.ts';
import { requirePrincipal } from '../handler_context.ts';

interface WidgetDefWire {
	widget_name?: string;
	path?: string;
	ipo?: unknown[];
}

/**
 * The widget host's record address. A non-address id is REFUSED BY NAME (the
 * get_tags_info pattern) — never folded into a permission refusal, which would
 * hide a client sending the wrong kind of id. The string form is a counted,
 * deprecable coercion (WC-2026-08-10-section-id-int-canonical); a safe integer
 * outside int4 is no matrix address either (the write door's id grammar).
 */
function widgetSectionId(raw: unknown, sectionTipo: string): number {
	const refuse = (cause?: unknown): DedaloError =>
		new DedaloError('request.invalid_source', {
			...(cause === undefined ? {} : { cause }),
			// The offending value is LOG-ONLY (coordinates), never public.
			coordinates: { section_id: JSON.stringify(raw ?? null), section_tipo: sectionTipo },
		});
	let sectionId: number;
	try {
		sectionId = coerceSectionId(raw, 'rqo.dd_component_info.get_widget_data.section_id');
	} catch (error) {
		throw refuse(error);
	}
	if (parseRecordId(sectionId).kind !== 'id') throw refuse();
	return sectionId;
}

/**
 * An absent tipo would make the door authorize the SECTION as the target
 * (write door: absent component = the section itself) — both are mandatory.
 */
function assertWidgetTipos(tipo: string, sectionTipo: string): void {
	if (tipo !== '' && sectionTipo !== '') return;
	throw new DedaloError('request.invalid_source', {
		message: 'get_widget_data: source.tipo and source.section_tipo are mandatory',
	});
}

/** dd_component_info action handlers, keyed by action (registered in dispatch.ts). */
export const componentInfoApiActions: Record<string, ActionHandler> = {
	get_widget_data: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const source = (rqo.source ?? {}) as {
			tipo?: unknown;
			section_tipo?: unknown;
			section_id?: unknown;
			mode?: unknown;
		};
		const options = (rqo.options ?? {}) as { widget_name?: unknown };
		const tipo = String(source.tipo ?? '');
		const sectionTipo = String(source.section_tipo ?? '');
		const mode = String(source.mode ?? 'list');
		const widgetName = String(options.widget_name ?? '');

		const rawSectionId = widgetSectionId(source.section_id, sectionTipo);
		assertWidgetTipos(tipo, sectionTipo);

		// The read door: section >= 1 → info component pair grant → record scope.
		const grant = await authorizeRecordAccess(
			principal,
			{ section_tipo: sectionTipo, component_tipo: tipo, section_id: rawSectionId },
			{ mode: 'read', level: 1, sectionFloor: 1, door: 'dd_component_info.get_widget_data' },
		);

		// The component's ontology widget definitions (PHP resolves the instance
		// in mode 'list' / lang NOLAN — only properties are needed here).
		const node = await getNode(grant.componentTipo);
		const widgets = (node?.properties as { widgets?: WidgetDefWire[] } | null)?.widgets;
		if (!Array.isArray(widgets) || widgets.length === 0) {
			// PHP: ' Empty defined widgets for dd_component_info : <label> [<tipo>] '.
			// The label is resolved for the LOG line only — the wire carries the code.
			const { termByTipo } = await import('../../ontology/labels.ts');
			const { currentApplicationLang } = await import('../../resolve/request_lang.ts');
			const label = await termByTipo(tipo, currentApplicationLang());
			throw new DedaloError('widget.empty', {
				message: `Empty defined widgets for dd_component_info : ${label} [${tipo}]`,
				coordinates: { tipo, section_tipo: sectionTipo },
			});
		}

		// PHP array_find by widget_name — first match.
		const widgetDef = widgets.find((widget) => widget.widget_name === widgetName);
		if (widgetDef === undefined) {
			throw new DedaloError('widget.not_defined', {
				message: `Empty widget_obj for widget ${widgetName}`,
				coordinates: { tipo, widget_name: widgetName },
			});
		}

		// Registry compute (fail-loud on unknown/unported — the dispatch catch
		// converts the throw into the v2 failure envelope).
		// This channel computes ASYNC widgets too: it is their only delivery.
		const { getInfoWidget, widgetComputeData } = await import(
			'../../components/component_info/widgets/registry.ts'
		);
		const descriptor = getInfoWidget(widgetName);
		const ipo = Array.isArray(widgetDef.ipo) ? widgetDef.ipo : [];
		const widgetData = await widgetComputeData(descriptor)(ipo, {
			sectionTipo: grant.sectionTipo,
			sectionId: grant.sectionId,
			mode,
			lang: currentDataLang(),
			userId: principal.userId,
			isAdmin: principal.isGlobalAdmin,
		});

		return { status: 200, body: ok(widgetData, { requestId: context.requestId }) };
	},
};
