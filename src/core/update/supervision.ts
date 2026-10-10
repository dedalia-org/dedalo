/**
 * Is this process supervised — will something restart it after a planned exit?
 *
 * A code update swaps the installation tree and then EXITS so the server comes
 * back on the new code. Under no supervisor that exit is a dead server, so the
 * swap refuses (code_update.ts assertSwapPreconditions) and the panel's
 * readiness readout (status.ts) asks this same function — one reader, never a
 * second copy of the rule.
 *
 * THE RULE: supervision is DECLARED by the thing that restarts the process, as
 * `DEDALO_SUPERVISED=true` in the PROCESS environment — a systemd unit's
 * `Environment=`, a compose service's `environment:`, or the package.json
 * `start:supervised` / `dev` / `dev:server` scripts. Every shipped runtime
 * definition carries it (gate: test/unit/supervision_declaration_tripwire.test.ts).
 *
 * Two things are deliberately NOT evidence:
 *  - `../private/.env`. That file is read by every launch method, including the
 *    unsupervised `bun run start`, so a value there would declare supervision
 *    for a process nothing restarts. It is ignored, and the refusal says so.
 *  - systemd's own markers (INVOCATION_ID / JOURNAL_STREAM). They are inherited
 *    by every descendant of a unit — including shells inside terminal emulators
 *    that desktop sessions run as systemd user units — so inferring from them
 *    turned an unsupervised `bun run start` into "supervised", and the update
 *    then swapped, exited and left the server down. With every shipped
 *    definition declaring the key, inference bought nothing but that false
 *    positive (removed 2026-10-08, installer unification C).
 */

import { privateFileValue, processEnvValue } from '../../config/env.ts';

// The key is spelled out at each call (not hoisted into a constant): the config census
// (test/helpers/env_key_scan.ts) finds the keys the engine reads by their literal.

/** True only when the process environment declares `DEDALO_SUPERVISED=true`. */
export function isSupervised(): boolean {
	return processEnvValue('DEDALO_SUPERVISED') === 'true';
}

/** The operator wrote the key into ../private/.env but no launch declared it —
 * the one mistake worth naming in the refusal. */
export function supervisionDeclaredOnlyInPrivateEnv(): boolean {
	return (
		processEnvValue('DEDALO_SUPERVISED') === undefined &&
		privateFileValue('DEDALO_SUPERVISED') !== undefined
	);
}

/** The text a code update refuses with when no supervisor is declared. */
export function supervisorRefusalMessage(): string {
	const base =
		'Error. No supervisor declared; the server would not restart onto the new tree. Declare DEDALO_SUPERVISED=true in the process manager that restarts it (systemd unit Environment=, compose environment:, or the start:supervised / dev / dev:server scripts) — see docs/install/production.md, "Mandatory: a supervisor that declares itself".';
	if (!supervisionDeclaredOnlyInPrivateEnv()) return base;
	return `${base} DEDALO_SUPERVISED in ../private/.env is IGNORED — that file is read by every launch method, including the unsupervised \`bun run start\`.`;
}
