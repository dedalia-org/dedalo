/**
 * tool_error_report — server half (WC-019, transport per
 * WC-2026-11-19-error-report-email-transport). ONE action, `send_report`: the
 * tool's client posts the admin's report here (authenticated tool_request), and
 * this handler validates, SERVER-STAMPS identity, STORES the report on this
 * installation, and — when DEDALO_ERROR_REPORT_EMAIL is set — mails it through
 * the one mailer (src/core/mailer/mailer.ts).
 *
 * Trust model (RT-1/RT-2): the browser supplies only client-observable context
 * (description, page path, section locator, captured JS errors, screenshot);
 * this handler stamps user_id/entity/version/langs/sent_at itself from
 * principal + config — the browser can never spoof who reported or from where.
 *
 * Mail discipline: the body is PLAIN TEXT only (never bodyHtml — report text is
 * untrusted and must not become markup in a mail client); the full report rides
 * as `report.json`, the screenshot as `screenshot.<ext>`, both under
 * engine-constant filenames. A mail failure is NOT a submit failure: the report
 * is already stored, the admin is told it was not mailed. Sends are throttled
 * per installation so a hijacked admin session cannot turn it into a spammer.
 *
 * Ordering: mail FIRST, then store with the mail outcome in `context.mail` — the
 * store is append-only (no UPDATE door), so the outcome must be known at insert.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../../src/config/config.ts';
import {
	type ReportWire,
	reportPayloadTooLarge,
	reportSubmissionSchema,
} from '../../../src/core/error_report/schema.ts';
import {
	ensureErrorReportsTable,
	insertErrorReport,
} from '../../../src/core/error_report/store.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import {
	type MailAttachment,
	type SendMailOptions,
	type SendMailResult,
	sendMail,
} from '../../../src/core/mailer/mailer.ts';
import { currentApplicationLang, currentDataLang } from '../../../src/core/resolve/request_lang.ts';
import {
	buildThrottleKey,
	isThrottled,
	recordFailedAttempt,
	releaseAttempt,
} from '../../../src/core/security/session_store.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { DEDALO_ENGINE_VERSION } from '../../../src/core/update/build_stamp.ts';

/** Sends one installation may make per throttle window (session_store LOGIN_ATTEMPT_WINDOW). */
export const SEND_MAX_PER_WINDOW = 10;

/** Captured JS errors quoted in the plain-text body (all of them ride in report.json). */
const BODY_MAX_JS_ERRORS = 5;

/** What the store records about the mail attempt (inside `context`; no DDL). */
export interface MailOutcome {
	readonly status: 'sent' | 'failed' | 'not_configured';
	readonly code?: string;
	readonly ref: string;
}

/** Injectable seams for tests (mail / local store / throttle / recipient). */
export interface SendReportDeps {
	sendMail: (options: SendMailOptions) => Promise<SendMailResult>;
	storeLocally: (report: ReportWire, mail: MailOutcome) => Promise<number>;
	/** true = refuse this send; false = a slot is reserved for it. */
	throttled: () => boolean;
	/** Give the reserved slot back (the send delivered nothing). */
	release: () => void;
	recipient: () => string | undefined;
}

/** The per-installation send budget key (exported for its gate). */
export const THROTTLE_KEY = buildThrottleKey('error_report_send', '', 'install');

/** true = refuse this send; otherwise a slot is reserved in the same sync step
 * (no await between check and count, so parallel sends cannot overshoot). */
export function sendThrottled(): boolean {
	if (isThrottled(THROTTLE_KEY, SEND_MAX_PER_WINDOW)) return true;
	recordFailedAttempt(THROTTLE_KEY);
	return false;
}

const defaultDeps: SendReportDeps = {
	sendMail,
	storeLocally: async (report, mail) => {
		await ensureErrorReportsTable();
		return insertErrorReport({
			source_ip: 'local',
			entity: report.entity,
			dedalo_version: report.dedalo_version,
			user_id: report.user_id,
			section_tipo: report.section_tipo,
			section_id: report.section_id,
			page_url: report.page_url,
			description: report.description,
			js_errors: report.js_errors,
			context: {
				entity_label: report.entity_label,
				langs: report.langs,
				sent_at: report.sent_at,
				user_agent: report.user_agent,
				client_globals: report.client_globals,
				report_version: report.report_version,
				screenshot: report.screenshot ?? null,
				mail,
			},
		});
	},
	throttled: sendThrottled,
	release: () => releaseAttempt(THROTTLE_KEY),
	recipient: () => config.errorReport.email,
};

/** Screenshot data URL (schema-validated) → attachment; null when absent. */
function screenshotAttachment(dataUrl: string | null | undefined): MailAttachment | null {
	if (typeof dataUrl !== 'string') return null;
	const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl);
	if (match === null) return null;
	const [, type, base64] = match;
	return {
		filename: `screenshot.${type === 'jpeg' ? 'jpg' : type}`,
		content: Buffer.from(base64 ?? '', 'base64'),
		contentType: `image/${type}`,
	};
}

/** The plain-text body: a human summary; the full report is report.json. */
export function reportMailText(report: ReportWire, ref: string): string {
	const section = report.section_tipo
		? report.section_tipo + (report.section_id ? ` / ${report.section_id}` : '')
		: '-';
	const lines = [
		`Reference: ${ref}`,
		`Installation: ${report.entity ?? '-'}${report.entity_label ? ` (${report.entity_label})` : ''}`,
		`Version: ${report.dedalo_version ?? '-'}`,
		`Reported at: ${report.sent_at ?? '-'}`,
		`User id: ${report.user_id ?? '-'}`,
		`Section: ${section}`,
		`Page: ${report.page_url ?? '-'}`,
		'',
		'Description:',
		report.description,
		'',
		`JavaScript errors: ${report.js_errors.length}`,
	];
	for (const item of report.js_errors.slice(-BODY_MAX_JS_ERRORS)) {
		lines.push(`- [${item.type}] ${item.msg ?? '(no message)'}`);
	}
	lines.push('', 'Full report: report.json (attached).');
	return lines.join('\n');
}

/** The mail for one report (plain text + constant-named attachments). */
export function reportMail(report: ReportWire, ref: string, to: string): SendMailOptions {
	const { screenshot, ...withoutScreenshot } = report;
	const attachments: MailAttachment[] = [
		{
			filename: 'report.json',
			content: JSON.stringify(withoutScreenshot, null, 2),
			contentType: 'application/json',
		},
	];
	const image = screenshotAttachment(screenshot);
	if (image !== null) attachments.push(image);
	return {
		to,
		subject: `[Dédalo error report] ${report.entity ?? 'unknown'} ${ref}`,
		bodyText: reportMailText(report, ref),
		attachments,
	};
}

/** Build the send_report handler with injectable deps (tests mock the seams). */
export function buildSendReportHandler(deps: SendReportDeps = defaultDeps) {
	return async function sendReport(context: ToolActionContext): Promise<ToolResponse> {
		// Defense in depth over the registry non-grant: admins only.
		if (!context.principal.isGlobalAdmin) {
			throw new DedaloError('perm.denied', {
				coordinates: { tool: 'tool_error_report', action: 'send_report' },
				message: 'Error report is an administrators-only tool',
			});
		}

		// Validate the browser-supplied submission (shared schema; strict).
		const parsed = reportSubmissionSchema.safeParse(context.options);
		if (!parsed.success) {
			throw new DedaloError('request.invalid_options', {
				publicMessage: 'Invalid error report submission',
			});
		}

		// Server-stamp identity/time (never from the browser).
		const report: ReportWire = {
			...parsed.data,
			user_id: context.userId,
			entity: config.entity,
			entity_label: config.identity.entityLabel ?? null,
			dedalo_version: DEDALO_ENGINE_VERSION,
			langs: { application: currentApplicationLang(), data: currentDataLang() },
			sent_at: new Date().toISOString(),
			report_version: 1,
		};

		// Fit the size cap by dropping the OLDEST captured errors first — never
		// fail the admin's submit on size (the description always survives).
		while (reportPayloadTooLarge(report) && report.js_errors.length > 0) {
			report.js_errors = report.js_errors.slice(1);
		}
		if (reportPayloadTooLarge(report)) {
			throw new DedaloError('request.invalid_options', {
				publicMessage: 'Error report is too large',
			});
		}

		// Budget only sends that reach mail/store; a slot that delivers nothing is released.
		if (deps.throttled()) {
			throw new DedaloError('rate.limited');
		}

		const ref = randomUUID().slice(0, 8);
		const to = deps.recipient();
		let mail: MailOutcome = { status: 'not_configured', ref };
		if (to !== undefined && to !== '') {
			const result = await deps.sendMail(reportMail(report, ref, to));
			mail = result.ok
				? { status: 'sent', ref }
				: { status: 'failed', code: result.code ?? 'mailer.send_failed', ref };
			// The mailer logs transport failures; this line names the flow, never the content.
			if (!result.ok) console.warn('[tool_error_report] mail not sent', mail.code);
		}

		try {
			const id = await deps.storeLocally(report, mail);
			return ok(
				{ delivered: true, report_id: id, ref, mailed: mail.status === 'sent' },
				{ requestId: toolRequestId(context) },
			);
		} catch (error) {
			console.warn('[tool_error_report] local store failed', error);
			// Already mailed: the report reached the maintainers — a failure here
			// would make the admin resend and duplicate the email.
			if (mail.status === 'sent') {
				return ok(
					{ delivered: true, report_id: null, ref, mailed: true },
					{ requestId: toolRequestId(context) },
				);
			}
			deps.release();
			throw new DedaloError('tool.action_failed', {
				cause: error,
				coordinates: { tool: 'tool_error_report' },
				message: 'store_failed',
			});
		}
	};
}

export const tool: ToolServerModule = {
	name: 'tool_error_report',
	apiActions: {
		send_report: {
			permission: null,
			gatedInHandler:
				'context.principal.isGlobalAdmin — the first statement of the built sendReport handler, throwing perm.denied otherwise. Defense in depth over the registry non-grant that already hides the tool from non-admins; there is no section/record target (the payload is a browser error report stored locally and optionally mailed).',
			handler: buildSendReportHandler(),
		},
	},
};
