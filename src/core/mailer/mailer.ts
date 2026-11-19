/**
 * Outbound email — the single place in the engine that knows how mail is sent
 * (TS port of the PHP dd_mailer contract). Relays through an EXISTING mailbox
 * over SMTP (nodemailer); Dédalo deliberately does not run its own mail server.
 * Callers (security/password_reset.ts) depend only on sendMail(), so the
 * transport can be swapped without touching them.
 *
 * Security posture (mirrors dd_mailer, one deliberate tightening):
 * - recipient cleaned (CR/LF and header-injection payloads stripped) and
 *   validated; subject CR/LF-stripped;
 * - TLS certificate verification is ALWAYS on — the PHP
 *   DEDALO_SMTP_VERIFY_PEER=false escape hatch is NOT ported (WC-023 D1: peer
 *   verification is never disableable; pin a private CA via NODE_EXTRA_CA_CERTS);
 * - never throws to the caller; returns a SendMailResult (an internal outcome,
 *   never a wire body) and logs failures server-side. Email CONTENT (recovery
 *   codes…) is never logged here.
 *
 * Config: DEDALO_SMTP_* (catalog domain `mailer`). An empty DEDALO_SMTP_HOST
 * means "mailer disabled" — sendMail refuses without touching the network.
 * No module-level transport singleton: the connection is built per send (a
 * recovery email is rare; correctness over connection reuse).
 */

import nodemailer from 'nodemailer';
import { readNumber, readString } from '../../config/readers.ts';
import type { ErrorCode } from '../errors/index.ts';

export interface SendMailOptions {
	/** Recipient address (required). */
	to: string;
	/** Message subject (required; CR/LF are stripped). */
	subject: string;
	/** Plain-text body (required). */
	bodyText: string;
	/** Optional HTML body (bodyText becomes the alt part). */
	bodyHtml?: string;
	/** Optional recipient display name. */
	toName?: string;
	/** Optional Reply-To address. */
	replyTo?: string;
	/** Optional attachments. `filename` must be an engine-chosen constant, never caller data. */
	attachments?: readonly MailAttachment[];
}

/** One attachment, handed to the transport as-is. */
export interface MailAttachment {
	filename: string;
	content: string | Buffer;
	contentType: string;
}

/**
 * The send outcome — an INTERNAL object, never a wire body (ERRORS_SPEC §4):
 * the only caller (security/password_reset.ts) logs it and answers the user
 * generically, so a mail failure must not become the caller's own failure.
 * `code` is the registered mailer.* code for the log/metric, not a token.
 */
export interface SendMailResult {
	/** Was the message handed to the relay? */
	ok: boolean;
	/** The registered failure code (absent on success). */
	code?: ErrorCode;
	/** Operator sentence for the server log. */
	msg: string;
}

/**
 * Strip everything that could smuggle an extra header into an address field
 * (PHP component_email::clean_email): CR/LF, NUL, and any leading/trailing
 * whitespace. Angle-bracket display forms are reduced to the bare address.
 */
export function cleanEmail(value: string): string {
	const stripped = value.replace(/[\r\n\0]/g, '').trim();
	const angled = /<([^<>]+)>\s*$/.exec(stripped);
	return (angled?.[1] ?? stripped).trim();
}

/** Pragmatic single-address shape check (PHP component_email::is_valid_email). */
export function isValidEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** The nodemailer message for already-validated From/To (headers CR/LF-stripped). */
function buildMessage(options: SendMailOptions, from: string, to: string): Record<string, unknown> {
	const fromName = readString('DEDALO_SMTP_FROM_NAME');
	const toName = options.toName?.replace(/[\r\n]/g, '').trim() ?? '';
	const replyTo = options.replyTo !== undefined ? cleanEmail(options.replyTo) : '';
	const html = options.bodyHtml ?? '';
	const attachments = options.attachments ?? [];
	return {
		from: fromName !== '' ? { name: fromName, address: from } : from,
		to: toName !== '' ? { name: toName, address: to } : to,
		...(replyTo !== '' && isValidEmail(replyTo) ? { replyTo } : {}),
		subject: options.subject.replace(/[\r\n]/g, '').trim(),
		text: options.bodyText,
		...(html !== '' ? { html } : {}),
		...(attachments.length > 0 ? { attachments: attachments.map((item) => ({ ...item })) } : {}),
	};
}

/**
 * Send one email through the configured SMTP relay. Never throws; a failure is
 * logged (without the message content) and reported as `{ok:false, code}`.
 */
export async function sendMail(options: SendMailOptions): Promise<SendMailResult> {
	const host = readString('DEDALO_SMTP_HOST');
	if (host === '') {
		console.error('[mailer] not configured (DEDALO_SMTP_HOST missing) — mail not sent');
		return {
			ok: false,
			code: 'mailer.not_configured',
			msg: 'Error. Mailer is not configured (DEDALO_SMTP_HOST missing)',
		};
	}

	const to = cleanEmail(options.to);
	if (to === '' || !isValidEmail(to)) {
		return {
			ok: false,
			code: 'mailer.invalid_recipient',
			msg: 'Error. Invalid recipient address',
		};
	}

	const smtpUser = readString('DEDALO_SMTP_USER');
	const from = readString('DEDALO_SMTP_FROM') !== '' ? readString('DEDALO_SMTP_FROM') : smtpUser;
	if (from === '') {
		console.error(
			'[mailer] no From address configured (DEDALO_SMTP_FROM / DEDALO_SMTP_USER missing)',
		);
		return {
			ok: false,
			code: 'mailer.not_configured',
			msg: 'Error. Mailer From address not configured (DEDALO_SMTP_FROM missing)',
		};
	}

	const secure = readString('DEDALO_SMTP_SECURE').toLowerCase();

	try {
		const transporter = nodemailer.createTransport({
			host,
			port: readNumber('DEDALO_SMTP_PORT'),
			// 'ssl' = implicit TLS (SMTPS); 'tls' = STARTTLS upgrade; 'none' = plain.
			secure: secure === 'ssl',
			requireTLS: secure !== 'ssl' && secure !== 'none',
			ignoreTLS: secure === 'none',
			// nodemailer defaults wait up to 2 min to connect and 10 min on a silent
			// socket — a stalled relay would hold the caller's request that long.
			connectionTimeout: 10_000,
			greetingTimeout: 10_000,
			socketTimeout: 30_000,
			...(smtpUser !== ''
				? { auth: { user: smtpUser, pass: readString('DEDALO_SMTP_PASS') } }
				: {}),
		});
		await transporter.sendMail(buildMessage(options, from, to));
		return { ok: true, msg: 'OK. Mail sent' };
	} catch (error) {
		// Log the transport error only — never the message content.
		console.error('[mailer] send failed:', (error as Error).message ?? error);
		return { ok: false, code: 'mailer.send_failed', msg: 'Error. Mail send failed' };
	}
}
