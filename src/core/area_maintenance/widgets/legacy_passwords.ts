/**
 * legacy_passwords widget — the accounts still on a Dédalo v6 password, and the
 * conversion, FROM THE SERVER (owner ruling 2026-11-19, T2 B1 follow-up D08-a:
 * "we need a way in the server to update the passwords").
 *
 * v6 stored passwords as reversible AES ciphertext; the v7 login accepts
 * Argon2id only. Until now the only fix was a command line on the server
 * (`bun run dedalo:migrate-passwords`), and the only place that said how many
 * accounts were affected was the boot log. This panel:
 *   - `get_value`  how many accounts hold a password, and how many of them are
 *                  still legacy — to a logged-in maintenance admin only
 *                  (`/health` answers anyone, so it keeps its number-less notice);
 *   - `migrate`    runs THE SAME DOOR as the command line
 *                  (core/security/legacy_password_migration.ts) with the v6 key
 *                  material the admin types, dry unless `execute: true`, in
 *                  batches, and answers a per-run report. Every batch, dry
 *                  or executed, is recorded in the activity log by the door
 *                  (the admin, the converted user ids, the counts, dry/execute
 *                  — owner ruling 2026-11-20).
 *
 * NEVER ON THE WIRE, IN A LOG OR IN A REPORT: a stored password value (old or
 * new), a plaintext, or the key material that was typed (it is read from the
 * request, handed to the door, and dropped — never echoed back, never part of a
 * refusal sentence).
 *
 * IT NEEDS AN ADMINISTRATOR WHO CAN LOG IN. On a database straight from v6
 * every password is a v6 value — `root`'s included — so nobody reaches this
 * panel and the command line does the first conversion; the panel serves what
 * is left (accounts set under another key, restored later, never finished).
 *
 * After a read or a run the count is handed to the boot state, so `/health`'s
 * notice follows at once instead of at its next 60 s recount.
 *
 * TS-only (no PHP twin): WC-2026-11-19-maintenance-legacy-passwords-widget.
 */

import { config } from '../../../config/config.ts';
import type { Principal } from '../../security/permissions.ts';
import { refuseAction, type WidgetModule, type WidgetResponse } from './support.ts';

/** Accounts examined per `migrate` request unless the caller asks for fewer. */
export const LEGACY_PASSWORDS_BATCH = 25;
/** A typed key longer than this is no v6 define. */
const KEY_MAX_LENGTH = 1024;

/** One optional key option: a non-empty string, or absent (→ the default). */
function keyOption(options: Record<string, unknown>, name: string): string | undefined {
	const value = options[name];
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string' || value.length > KEY_MAX_LENGTH) {
		// The NAME of the option, never its value.
		refuseAction(`Error. '${name}' must be a text of at most ${KEY_MAX_LENGTH} characters.`);
	}
	return value;
}

/** One optional non-negative integer option. */
function integerOption(options: Record<string, unknown>, name: string): number | undefined {
	const value = options[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		refuseAction(`Error. '${name}' must be a non-negative whole number.`);
	}
	return value;
}

/**
 * The panel: the census plus what the form needs to say. `default_info_key` is
 * this installation's entity name — v6's DEDALO_INFO_KEY defaulted to
 * DEDALO_ENTITY, so it is what an empty "info key" field stands for.
 */
async function legacyPasswordsGetValue(): Promise<WidgetResponse> {
	const { legacyPasswordCensus } = await import('../../security/legacy_password_migration.ts');
	const { MIGRATE_PASSWORDS_COMMAND } = await import('../../security/legacy_password_command.ts');
	const { recordLegacyPasswordAccounts } = await import('../../update/boot_state.ts');
	const census = await legacyPasswordCensus();
	recordLegacyPasswordAccounts(census.legacy);
	return {
		data: {
			accounts: census.accounts,
			argon2: census.argon2,
			legacy: census.legacy,
			command: MIGRATE_PASSWORDS_COMMAND,
			default_info_key: config.entity,
			batch: LEGACY_PASSWORDS_BATCH,
		},
	};
}

/**
 * One batch of the migration. Options: `information` / `info_key` (the v6
 * DEDALO_INFORMATION / DEDALO_INFO_KEY; empty = v6's own defaults), `execute`
 * (true writes; anything else is a dry run), `after` (the previous batch's
 * `next_after`), `limit` (≤ {@link LEGACY_PASSWORDS_BATCH}).
 */
async function legacyPasswordsMigrate(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { DEFAULT_INFORMATION } = await import('../../security/legacy_password.ts');
	const { migrateLegacyPasswords } = await import('../../security/legacy_password_migration.ts');
	const { recordLegacyPasswordAccounts } = await import('../../update/boot_state.ts');
	const { hostFromClientIp } = await import('../../api/handlers/activity_log.ts');
	const { currentRequestContext } = await import('../../security/request_context.ts');
	const material = {
		information: keyOption(options, 'information') ?? DEFAULT_INFORMATION,
		infoKey: keyOption(options, 'info_key') ?? config.entity,
	};
	const after = integerOption(options, 'after');
	const limit = Math.min(
		Math.max(integerOption(options, 'limit') ?? LEGACY_PASSWORDS_BATCH, 1),
		LEGACY_PASSWORDS_BATCH,
	);
	// The door records the run (dry or executed) in the activity log, under this actor.
	const actor = {
		userId: principal.userId,
		host: hostFromClientIp(currentRequestContext()?.clientIp),
		via: 'panel' as const,
	};
	const report = await migrateLegacyPasswords(material, actor, {
		execute: options.execute === true,
		limit,
		...(after === undefined ? {} : { afterSectionId: after }),
	});
	recordLegacyPasswordAccounts(report.remaining);
	return {
		data: {
			execute: report.execute,
			accounts: report.accounts,
			argon2: report.argon2,
			legacy: report.legacy,
			examined: report.examined,
			recoverable: report.recoverable,
			converted: report.converted,
			failed: report.failed,
			skipped: report.skipped,
			remaining: report.remaining,
			next_after: report.next_after,
			// WHO could not be converted — the accounts an admin has to reset by hand.
			failed_accounts: report.failed_accounts,
		},
	};
}

export const widget: WidgetModule = {
	spec: {
		id: 'legacy_passwords',
		category: 'migration',
		class: 'width_100',
		label: { kind: 'label', key: 'legacy_passwords' },
	},
	apiActions: {
		migrate: legacyPasswordsMigrate,
	},
	getValue: legacyPasswordsGetValue,
};
