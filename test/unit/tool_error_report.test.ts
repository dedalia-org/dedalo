/**
 * tool_error_report server half (WC-019; transport per
 * WC-2026-11-19-error-report-email-transport) — the send_report handler through
 * its injectable seams (sendMail / storeLocally / throttled / release / recipient; no real
 * SMTP, no real table):
 *  - non-admin refused (defense in depth over the registry non-grant);
 *  - invalid submission refused (shared strict schema);
 *  - throttled send refused BEFORE anything is mailed or stored; a send that
 *    delivers nothing (no mail, store failed) gives its throttle slot back;
 *  - SERVER-STAMPED identity (user_id/entity/version/report_version);
 *  - ALWAYS stored locally; mailed only when a recipient is set;
 *  - the mail is PLAIN TEXT only (no bodyHtml) with engine-constant attachment
 *    names (report.json, screenshot.<ext>);
 *  - a mail failure is NOT a submit failure (stored, `mailed: false`);
 *  - size fitting drops the OLDEST captured errors, never the description.
 */
// Generic `test` TLD: the submitted report is opaque payload; its section tipo names `test3`.

import { describe, expect, spyOn, test } from 'bun:test';
import { warnRetiredErrorReportKeys } from '../../src/config/readers.ts';
import type { ReportWire } from '../../src/core/error_report/schema.ts';
import type { SendMailOptions, SendMailResult } from '../../src/core/mailer/mailer.ts';
import { clearAttempts, releaseAttempt } from '../../src/core/security/session_store.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import { DEDALO_ENGINE_VERSION } from '../../src/core/update/build_stamp.ts';
import {
	buildSendReportHandler,
	type MailOutcome,
	SEND_MAX_PER_WINDOW,
	type SendReportDeps,
	sendThrottled,
	THROTTLE_KEY,
	tool,
} from '../../tools/tool_error_report/server/index.ts';
import { refusalOf } from '../helpers/refusal.ts';

function adminContext(options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId: 7, isGlobalAdmin: true, isDeveloper: false },
		userId: 7,
		options,
		background: false,
	};
}

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		description: 'Saving a record wipes the toolbar.',
		page_url: '/dedalo/core/page/?tipo=test3',
		section_tipo: 'test3',
		section_id: '42',
		user_agent: 'test-agent',
		js_errors: [],
		client_globals: null,
		...overrides,
	};
}

/** A 1×1 PNG as the schema-shaped data URL. */
const PNG_DATA_URL =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface Harness {
	deps: SendReportDeps;
	mails: SendMailOptions[];
	stored: { report: ReportWire; mail: MailOutcome }[];
	released: () => number;
}

function harness(
	options: { recipient?: string; mailResult?: SendMailResult; throttled?: boolean } = {},
): Harness {
	const mails: SendMailOptions[] = [];
	const stored: { report: ReportWire; mail: MailOutcome }[] = [];
	let released = 0;
	return {
		mails,
		stored,
		released: () => released,
		deps: {
			sendMail: async (mail) => {
				mails.push(mail);
				return options.mailResult ?? { ok: true, msg: 'OK' };
			},
			storeLocally: async (report, mail) => {
				stored.push({ report, mail });
				return 31;
			},
			throttled: () => options.throttled === true,
			release: () => {
				released += 1;
			},
			recipient: () => options.recipient,
		},
	};
}

describe('tool_error_report send_report (WC-019, email transport)', () => {
	test('the registered action surface is exactly send_report (permission: null + in-handler gate)', () => {
		expect(Object.keys(tool.apiActions)).toEqual(['send_report']);
		expect(tool.apiActions.send_report?.permission).toBeNull();
	});

	test('non-admin principal is refused before anything runs', async () => {
		const h = harness({ recipient: 'reports@example.org' });
		const context = adminContext(submission());
		context.principal = { userId: 7, isGlobalAdmin: false, isDeveloper: true };
		const refusal = await refusalOf(buildSendReportHandler(h.deps)(context));
		expect(refusal.code).toBe('perm.denied');
		expect(h.mails.length + h.stored.length).toBe(0);
	});

	test('invalid submission (unknown field) is refused by the shared strict schema', async () => {
		const h = harness({ recipient: 'reports@example.org' });
		const refusal = await refusalOf(
			buildSendReportHandler(h.deps)(adminContext(submission({ csrf_token: 'leak-me' }))),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.publicMessage).toBe('Invalid error report submission');
		expect(h.mails.length + h.stored.length).toBe(0);
	});

	test('throttled → rate.limited, nothing mailed or stored', async () => {
		const h = harness({ recipient: 'reports@example.org', throttled: true });
		const refusal = await refusalOf(buildSendReportHandler(h.deps)(adminContext(submission())));
		expect(refusal.code).toBe('rate.limited');
		expect(h.mails.length + h.stored.length).toBe(0);
	});

	test('recipient set: server-stamped report is mailed (text only, constant attachments) AND stored', async () => {
		const h = harness({ recipient: 'reports@example.org' });
		const response = await buildSendReportHandler(h.deps)(
			adminContext(
				submission({ screenshot: PNG_DATA_URL, description: '<img src=x onerror=alert(1)>' }),
			),
		);
		const data = response.data as {
			delivered: boolean;
			report_id: number;
			ref: string;
			mailed: boolean;
		};
		expect(data.delivered).toBe(true);
		expect(data.report_id).toBe(31);
		expect(data.mailed).toBe(true);
		expect(data.ref).toMatch(/^[0-9a-f]{8}$/);

		expect(h.mails).toHaveLength(1);
		const mail = h.mails[0] as SendMailOptions;
		expect(mail.to).toBe('reports@example.org');
		expect(mail.bodyHtml).toBeUndefined();
		expect(mail.subject).toContain(data.ref);
		// untrusted text is carried verbatim as TEXT, never interpreted
		expect(mail.bodyText).toContain('<img src=x onerror=alert(1)>');
		expect(mail.attachments?.map((item) => item.filename)).toEqual([
			'report.json',
			'screenshot.png',
		]);
		expect(mail.attachments?.[1]?.contentType).toBe('image/png');
		expect(Buffer.isBuffer(mail.attachments?.[1]?.content)).toBe(true);

		const json = JSON.parse(String(mail.attachments?.[0]?.content)) as Record<string, unknown>;
		expect(json.screenshot).toBeUndefined();
		expect(json.user_id).toBe(7);
		expect(json.dedalo_version).toBe(DEDALO_ENGINE_VERSION);
		expect(json.report_version).toBe(1);
		expect(typeof json.entity).toBe('string');

		expect(h.stored).toHaveLength(1);
		expect(h.stored[0]?.mail).toEqual({ status: 'sent', ref: data.ref });
		expect(h.stored[0]?.report.user_id).toBe(7);
		expect(h.stored[0]?.report.section_tipo).toBe('test3');
	});

	test('no recipient → stored only, nothing mailed, mailed:false', async () => {
		const h = harness();
		const response = await buildSendReportHandler(h.deps)(adminContext(submission()));
		expect((response.data as { mailed: boolean }).mailed).toBe(false);
		expect(h.mails).toHaveLength(0);
		expect(h.stored[0]?.mail.status).toBe('not_configured');
	});

	test('mail failure is NOT a submit failure: stored with the failure code, mailed:false', async () => {
		const h = harness({
			recipient: 'reports@example.org',
			mailResult: { ok: false, code: 'mailer.send_failed', msg: 'Error. Mail send failed' },
		});
		const response = await buildSendReportHandler(h.deps)(adminContext(submission()));
		const data = response.data as { delivered: boolean; mailed: boolean };
		expect(data).toMatchObject({ delivered: true, mailed: false });
		expect(h.stored[0]?.mail).toMatchObject({ status: 'failed', code: 'mailer.send_failed' });
	});

	test('store failure AFTER a sent mail → delivered (no resend, no duplicate email)', async () => {
		const h = harness({ recipient: 'reports@example.org' });
		h.deps.storeLocally = async () => {
			throw new Error('db down');
		};
		const response = await buildSendReportHandler(h.deps)(adminContext(submission()));
		expect(response.data).toMatchObject({ delivered: true, mailed: true, report_id: null });
		expect(h.mails).toHaveLength(1);
		expect(h.released()).toBe(0); // the mail went out: the slot stays spent
	});

	test('the REAL send throttle (session store): the budget admits SEND_MAX_PER_WINDOW, refuses the next', () => {
		clearAttempts(THROTTLE_KEY);
		try {
			for (let index = 0; index < SEND_MAX_PER_WINDOW; index += 1) {
				expect(sendThrottled(), `send ${index + 1}`).toBe(false);
			}
			expect(sendThrottled()).toBe(true);
			// A released slot (a send that delivered nothing) is admitted again.
			releaseAttempt(THROTTLE_KEY);
			expect(sendThrottled()).toBe(false);
			expect(sendThrottled()).toBe(true);
		} finally {
			clearAttempts(THROTTLE_KEY);
		}
	});

	test('store failure → honest tool.action_failed', async () => {
		const h = harness();
		h.deps.storeLocally = async () => {
			throw new Error('no table');
		};
		const refusal = await refusalOf(buildSendReportHandler(h.deps)(adminContext(submission())));
		expect(refusal.code).toBe('tool.action_failed');
		expect(h.released()).toBe(1); // nothing delivered: the throttle slot is given back
	});

	test('size fitting drops the OLDEST errors first; the description always survives', async () => {
		const bigError = (index: number) => ({
			type: 'error',
			msg: `err_${index}_${'m'.repeat(1990)}`,
			source: 's'.repeat(1024),
			line: 1,
			col: 1,
			stack: 'x'.repeat(6000),
			time: '2026-07-10T10:00:00.000Z',
			count: 1,
		});
		const h = harness();
		const fifty = Array.from({ length: 50 }, (_, index) => bigError(index));
		await buildSendReportHandler(h.deps)(adminContext(submission({ js_errors: fifty })));

		const sent = h.stored[0]?.report.js_errors ?? [];
		expect(sent.length).toBeLessThan(50);
		expect(sent.length).toBeGreaterThan(0);
		expect((sent[0] as { msg: string }).msg.startsWith('err_0_')).toBe(false);
		expect((sent[sent.length - 1] as { msg: string }).msg.startsWith('err_49_')).toBe(true);
		expect(h.stored[0]?.report.description).toBe('Saving a record wipes the toolbar.');
	});
});

describe('retired transport keys (MASTER_URL / RECEIVER) are loud, never silent', () => {
	test('one boot line naming each set key, never its value; nothing when unset', () => {
		const spy = spyOn(console, 'error').mockImplementation(() => {});
		try {
			warnRetiredErrorReportKeys(undefined, '  ');
			expect(spy).not.toHaveBeenCalled();
			warnRetiredErrorReportKeys('https://secret-master.example/api', 'true');
			expect(spy).toHaveBeenCalledTimes(1);
			const line = String(spy.mock.calls[0]?.[0]);
			expect(line).toContain('DEDALO_ERROR_REPORT_MASTER_URL');
			expect(line).toContain('DEDALO_ERROR_REPORT_RECEIVER');
			expect(line).toContain('DEDALO_ERROR_REPORT_EMAIL');
			expect(line).not.toContain('secret-master');
		} finally {
			spy.mockRestore();
		}
	});
});
