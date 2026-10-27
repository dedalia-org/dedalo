/**
 * RUNNING AND SHOWING A HOST STEP'S COMMANDS (terminal installer phase 4,
 * 2026-10-12) — the one place a HostCommand becomes an effect (through the
 * runner or the HostFs) and the one place it becomes a Review line. Both read
 * the SAME list (contract.ts: review equals run).
 *
 *  - `as: instance|postgres` becomes a `runuser -u <user> [-g <group>] --`
 *    prefix: the argv the runner logs is the argv that ran. A command's
 *    `env.HOME` follows it as `/usr/bin/env HOME=<dir>` (runuser resets
 *    HOME to the account's home). The instance runs with its SERVICE GROUP named (`-g`): runuser would otherwise take the
 *    account's primary group, and an existing account's primary group is not
 *    necessarily the instance's (owner decisions 2026-10-12).
 *  - a `mkdir` the INSTANCE makes (`as: 'instance'` — a directory inside the
 *    install folder, which root never creates by path: critique B1) runs as
 *    `install -d -m <mode> <path>` under that prefix.
 *  - `stdin: {secrets}` is ONE JSON object of the named secrets, built here
 *    from the run's secrets; the Review shows only the keys.
 *  - an `unless` probe that exits 0 skips its command (already done).
 *  - a failed command refuses the step with its label, its exit code and the
 *    stderr line that says why — the last `fatal:`/`error:` line and the last
 *    line (redacted by the runner) — never the whole output.
 */

import type { Secrets } from '../run_files_core.ts';
import type { ExecCommand, HostCommand, HostCtx, MkdirCommand } from './contract.ts';
import { sha256Text } from './fs.ts';
import { binaryOf, type OsRow } from './os_support.ts';
import { shellLine } from './quote.ts';
import { hostRefuse } from './refuse.ts';
import type { RunRequest, RunResult } from './runner.ts';

/** The service account an `instance` command runs as. */
export interface ServiceIdentity {
	readonly user: string;
	readonly group: string;
}

/** The runuser identity flags of a command ([] = this process). */
function identityFlags(command: ExecCommand, identity: ServiceIdentity): string[] {
	if (command.as === 'instance') return ['-u', identity.user, '-g', identity.group];
	return command.as === 'postgres' ? ['-u', 'postgres'] : [];
}

/**
 * `setpriv --pdeathsig KILL --` (campaign 3 C3-29): the process it execs into
 * is killed when its parent dies. runuser FORKS the command it runs, so a
 * command that must die with the installer carries it at both ends of the
 * chain: outside (runuser dies with the installer) and inside (the command
 * dies with runuser).
 */
function deathPrefix(command: ExecCommand, row: OsRow): string[] {
	return command.pdeathsig === true ? [binaryOf(row, 'setpriv'), '--pdeathsig', 'KILL', '--'] : [];
}

/** The argv as it is run: a runuser prefix for another user. */
export function effectiveArgv(
	command: ExecCommand,
	row: OsRow,
	identity: ServiceIdentity,
): string[] {
	const flags = identityFlags(command, identity);
	const death = deathPrefix(command, row);
	if (flags.length === 0) return [...death, ...command.argv];
	// runuser (no --login) keeps the environment but RESETS HOME to the
	// account's home: a command's own HOME rides argv (`env HOME=…`), or an
	// existing hosting account's home collects Bun's caches (2026-10-12).
	const home = command.env?.HOME;
	const withHome =
		home === undefined ? command.argv : [binaryOf(row, 'env'), `HOME=${home}`, ...command.argv];
	return [...death, binaryOf(row, 'runuser'), ...flags, '--', ...death, ...withHome];
}

/** The exec an instance-made directory runs as (`install -d`, as the service user). */
export function instanceMkdirExec(command: MkdirCommand, row: OsRow): ExecCommand {
	return {
		kind: 'exec',
		argv: [binaryOf(row, 'install'), '-d', '-m', octal(command.mode), command.path],
		as: 'instance',
		label: command.label,
		mutates: true,
	};
}

/** The named secrets as one JSON object (only the given ones). */
function secretsJson(keys: readonly string[], secrets: Secrets): string {
	const picked: Record<string, string> = {};
	for (const key of keys) {
		const value = secrets[key as keyof Secrets];
		if (value !== undefined && value !== '') picked[key] = value;
	}
	return JSON.stringify(picked);
}

/** The stdin a command is fed. */
function stdinOf(command: ExecCommand, secrets: Secrets): string | undefined {
	const stdin = command.stdin;
	if (stdin === undefined) return undefined;
	if (!('secrets' in stdin)) return stdin.text;
	const picked = secretsJson(stdin.secrets, secrets);
	return stdin.with === undefined
		? picked
		: JSON.stringify({ ...stdin.with, secrets: JSON.parse(picked) as unknown });
}

/** The runner request of an exec command. */
export function requestOf(command: ExecCommand, ctx: HostCtx): RunRequest {
	const stdin = stdinOf(command, ctx.secrets);
	return {
		argv: effectiveArgv(command, ctx.row, ctx.paths),
		...(stdin === undefined ? {} : { stdin }),
		...(command.cwd === undefined ? {} : { cwd: command.cwd }),
		...(command.env === undefined ? {} : { env: command.env }),
		...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
	};
}

/** Did the command succeed (its accepted exit codes, no timeout)? */
export function succeeded(command: ExecCommand, result: RunResult): boolean {
	return !result.timedOut && (command.okExit ?? [0]).includes(result.exitCode);
}

/**
 * The lines of stderr that say WHY: the last `fatal:`/`error:` line (or a
 * web server's `[emerg]`/`[alert]`/`[crit]`/`[error]` one), then the last line
 * when it is another one (git ends its refusal with a hint, `nginx -t` with
 * "test failed" — the line that said why came before and was lost: campaign
 * 3 C3-7 and its Debian drill). Never the whole output.
 */
export function tellingStderr(stderr: string): string {
	const lines = stderr
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '');
	const last = lines.at(-1) ?? '';
	const marked = lines
		.filter((line) => /^(fatal|error)\b/i.test(line) || /\[(emerg|alert|crit|error)\]/.test(line))
		.at(-1);
	if (marked === undefined || marked === last) return last;
	return `${marked} … ${last}`;
}

/** The refusal of a failed command: its label, exit and stderr's telling line(s). */
export function failedSentence(command: ExecCommand, result: RunResult): string {
	const said = tellingStderr(result.stderr);
	const why = result.timedOut ? 'timed out' : `exit ${result.exitCode}`;
	return `${command.label} failed (${why})${said === '' ? '' : `: ${said}`}`;
}

/** Run one exec command (its `unless` probe first); answers its result, or null when skipped. */
export async function runExec(command: ExecCommand, ctx: HostCtx): Promise<RunResult | null> {
	if (command.unless !== undefined) {
		const probe = await ctx.runner.run(requestOf(command.unless, ctx));
		if (succeeded(command.unless, probe)) return null;
	}
	const result = await ctx.runner.run(requestOf(command, ctx));
	if (!succeeded(command, result))
		hostRefuse('install.step_failed', failedSentence(command, result));
	return result;
}

/**
 * A directory: root's through the HostFs (mode and owner by descriptor); the
 * instance's as the service user. A SCRATCH root's recording runner executes
 * nothing, so the directory the user's `install -d` would create is mirrored
 * into the scratch tree with its owner (the gates read it there).
 */
async function applyMkdir(command: MkdirCommand, ctx: HostCtx): Promise<void> {
	if (command.as !== 'instance') {
		ctx.fs.mkdir(command.path, command.mode, command.owner, command.group);
		return;
	}
	await runExec(instanceMkdirExec(command, ctx.row), ctx);
	if (ctx.fs.root !== '') ctx.fs.mkdir(command.path, command.mode, command.owner, command.group);
}

/** Apply one command. */
async function applyCommand(command: HostCommand, ctx: HostCtx): Promise<void> {
	if (command.kind === 'exec') {
		await runExec(command, ctx);
	} else if (command.kind === 'write') {
		ctx.fs.write(command.path, command.content, command.mode, command.owner, command.group);
	} else if (command.kind === 'mkdir') {
		await applyMkdir(command, ctx);
	} else {
		ctx.fs.remove(command.path);
	}
}

/** Apply every command, in order (the first failure refuses the step). */
export async function executeCommands(
	commands: readonly HostCommand[],
	ctx: HostCtx,
): Promise<void> {
	for (const command of commands) await applyCommand(command, ctx);
}

/** A mode as 4 octal digits. */
function octal(mode: number): string {
	return mode.toString(8).padStart(4, '0');
}

/** The stdin part of a Review line (keys only for secrets). */
function stdinText(command: ExecCommand): string {
	const stdin = command.stdin;
	if (stdin === undefined) return '';
	if (!('secrets' in stdin)) return '  < text on stdin';
	const what = stdin.with === undefined ? '' : `${Object.keys(stdin.with).join(', ')} + `;
	return `  < {${what}secrets: ${stdin.secrets.join(', ') || 'none'}} on stdin`;
}

/** One exec as the Review shows it (the exact argv, the stdin keys, the `unless` probe). */
function execText(command: ExecCommand, row: OsRow, identity: ServiceIdentity): string {
	const unless =
		command.unless === undefined
			? ''
			: `  (unless: ${shellLine(effectiveArgv(command.unless, row, identity))})`;
	return `${shellLine(effectiveArgv(command, row, identity))}${stdinText(command)}${unless}`;
}

/** One command as the Review shows it (the exact argv; files by path, mode, owner and hash). */
export function commandText(command: HostCommand, row: OsRow, identity: ServiceIdentity): string {
	if (command.kind === 'exec') return execText(command, row, identity);
	if (command.kind === 'mkdir' && command.as === 'instance') {
		return execText(instanceMkdirExec(command, row), row, identity);
	}
	if (command.kind === 'write') {
		return `write ${command.path} (${octal(command.mode)} ${command.owner}:${command.group}, sha256 ${sha256Text(command.content).slice(0, 12)})`;
	}
	if (command.kind === 'mkdir') {
		return `mkdir ${command.path} (${octal(command.mode)} ${command.owner}:${command.group})`;
	}
	return `remove ${command.path}`;
}

/** The digest of a command list (what host_preflight freezes, what a resume compares). */
export function commandsDigest(
	commands: readonly HostCommand[],
	row: OsRow,
	identity: ServiceIdentity,
): string {
	return sha256Text(commands.map((command) => commandText(command, row, identity)).join('\n'));
}
