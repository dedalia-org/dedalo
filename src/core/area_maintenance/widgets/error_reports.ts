/**
 * error_reports widget — browse the error reports THIS installation's admins
 * sent (WC-018; transport per WC-2026-11-19-error-report-email-transport: each
 * report is stored here and, when DEDALO_ERROR_REPORT_EMAIL is set, mailed).
 *
 * Listed on every installation. Admin-only by construction:
 * dispatchWidgetRequest/dispatchGetWidgetValue refuse non-global-admins before
 * any handler runs. Report fields are user/browser-supplied text — the client
 * render must emit every report-derived string via textContent, never
 * inner_html (DS-1).
 */

import { config } from '../../../config/config.ts';
import { countErrorReports, listErrorReports } from '../../error_report/store.ts';
import type { WidgetModule, WidgetResponse } from './support.ts';

/** Where this installation's reports go (the widget's target display). */
function reportTarget(): string {
	const email = config.errorReport.email;
	if (email !== undefined) return `${email} (by email; also stored here)`;
	return 'Stored on this installation only (DEDALO_ERROR_REPORT_EMAIL not set)';
}

/** Panel load: totals only (the rows load on demand via get_reports). */
async function errorReportsGetValue(): Promise<WidgetResponse> {
	try {
		const [total, latest] = await Promise.all([
			countErrorReports(),
			listErrorReports({ limit: 1 }),
		]);
		return {
			data: { total, latest_received_at: latest[0]?.received_at ?? null, target: reportTarget() },
		};
	} catch (error) {
		// getValue is fail-soft by contract (a missing table must not break
		// the whole dashboard).
		console.warn('[error_reports widget] get_value failed', error);
		return { data: { total: null, latest_received_at: null, target: reportTarget() } };
	}
}

/** Newest-first page of reports. The store clamps limit to 100. */
async function errorReportsGetReports(options: Record<string, unknown>): Promise<WidgetResponse> {
	const offset = typeof options.offset === 'number' ? options.offset : 0;
	const limit = typeof options.limit === 'number' ? options.limit : 25;
	const [reports, total] = await Promise.all([
		listErrorReports({ offset, limit }),
		countErrorReports(),
	]);
	return { data: { reports, total, offset } };
}

export const widget: WidgetModule = {
	spec: {
		id: 'error_reports',
		category: 'system',
		// Full-width card (the system_info pattern) — reports render as wide rows.
		class: 'width_100',
		// TS-only widget: a literal label, no dictionary term (the
		// diffusion_server_control WC-005 precedent).
		label: { kind: 'literal', text: 'Error reports' },
	},
	getValue: errorReportsGetValue,
	apiActions: {
		get_reports: errorReportsGetReports,
	},
};
