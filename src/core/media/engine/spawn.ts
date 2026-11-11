/**
 * SPAWN DISCIPLINE — the one place media binaries are executed.
 *
 * Every media transform shells out to an external binary (ImageMagick, ffmpeg,
 * pdftotext, …). PHP built shell strings and relied on escapeshellarg/cmd. This
 * rewrite uses `Bun.spawn` with ARGV ARRAYS and NO SHELL — arguments never
 * traverse a shell parser, so there is nothing to escape and injection is
 * structurally impossible (engineering/MEDIA_SPEC.md §5.3, categorically stronger than
 * PHP). No `sh -c`, no `.sh` files, no string interpolation of user values.
 *
 * `nice -n 19` is preserved (shared-host courtesy — the PHP server, the DB and
 * this process share the box). Outputs are written to a temp name and atomically
 * renamed by callers so a coexisting PHP reader never sees a partial derivative.
 *
 * INTEGRITY LAW (audit 2026-08 B2): a command that was killed — by the timeout
 * cap or by any signal — DID NOT SUCCEED. `SpawnResult.ok` is the single truth,
 * `assertSpawnOk` is the gate, and no caller may AND a timeout away to reach a
 * success path (gated in `test/unit/media_encode_integrity_native.test.ts`, and
 * widened to every media runner by invariant 7 of
 * `test/unit/media_writer_discipline_tripwire.test.ts`).
 *
 * TWO TIMEOUT POLICIES, because "long" and "hung" are different things.
 * A wall-clock budget is the right instrument for a BOUNDED command (a header
 * probe, a page count): it is expected to finish in milliseconds, so any minute
 * scale runtime is a wedge. It is the WRONG instrument for a TRANSCODE: this is
 * an oral-history archive whose masters are hour-long interviews, and how long a
 * two-pass x264 encode of one legitimately takes is a function of the source's
 * duration, the box and how many lanes are busy — no constant can separate "still
 * encoding" from "stuck". PHP capped nothing at all (it wrote a `.sh` and ran it
 * detached, class.Ffmpeg.php:786-793); making the 10-minute cap a HARD failure
 * without changing what it measures would have turned B2's silent corruption into
 * a guaranteed failure for exactly the content it was measured on.
 *
 * So a producer runs under `idleTimeoutMs`: the cap measures SILENCE, not work.
 * Every chunk on stdout or stderr re-arms it, and `engine/ffmpeg.ts` gives every
 * ffmpeg run its own `-progress pipe:1` liveness channel so a live encode is
 * never silent. An encode that emits nothing for ten minutes is wedged whatever
 * its source's duration; one that reports progress runs to completion.
 */

import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

/** Result of a spawned command. */
export interface SpawnResult {
	/** Process exit code, or null when a SIGNAL killed the child (timeout included). */
	exitCode: number | null;
	/**
	 * The signal that killed the child — `SIGKILL` when a cap fired — or null on a
	 * normal exit. (Signal names are written in backticks here, never single-quoted
	 * after a word and an open paren: the shared env-key scanner in
	 * `test/helpers/env_key_scan.ts` deliberately over-collects any uppercase-snake
	 * literal in first-argument position — prose included — so a quoted signal name
	 * reads as an undocumented config key and reddens both config census gates.
	 * Kept out of that scanner's suppression list on purpose: the list is what
	 * stands between the scanner and a genuinely undocumented key.) A signal with no
	 * name (a Linux real-time signal) is its number — Bun 1.4.3 reports it so.
	 */
	signal: string | number | null;
	/**
	 * The ONE truth about whether the command did its job: exit 0, no signal, no
	 * timeout. Every runner that produces a FILE must branch on this — audit
	 * 2026-08 B2: the ffmpeg runners asked `exitCode !== 0 && !timedOut`, so the
	 * 10-minute cap became the excuse that SKIPPED the failure branch, and the
	 * partial, moov-less temp was renamed over the master derivative while the job
	 * reported 'done'. A timeout is the worst outcome a media command has, never a
	 * pass. Read-only probes may still degrade on their own terms (probe.ts returns
	 * 'unknown'), but they must not claim an output exists.
	 */
	ok: boolean;
	/** Captured stdout (utf-8). */
	stdout: string;
	/** Captured stderr (utf-8). */
	stderr: string;
	/** True when the TIMEOUT is what killed the command (a subset of `signal`). */
	timedOut: boolean;
	/**
	 * WHICH cap fired: 'total' (a wall-clock budget was spent) or 'idle' (the
	 * command produced no output for the whole inactivity window), null when it
	 * was not a timeout. The distinction is the operator's first diagnosis — a
	 * spent budget means "raise it or split the work", silence means "wedged".
	 */
	timeoutKind: 'total' | 'idle' | null;
}

/** Options for a single spawn. */
export interface SpawnOptions {
	/**
	 * TOTAL wall-clock cap in ms (default 10 min). For BOUNDED commands only —
	 * probes, header reads, page counts. Mutually exclusive with `idleTimeoutMs`;
	 * passing both throws, because a command cannot be governed by two policies
	 * and silently picking one is how a policy decision goes unmade.
	 */
	timeoutMs?: number;
	/**
	 * INACTIVITY cap in ms: the child is killed only after this long with NO byte
	 * on stdout OR stderr. THE policy for anything that produces a file (see the
	 * module header) — it bounds a wedge without bounding the work.
	 */
	idleTimeoutMs?: number;
	/** Prefix the command with `nice -n 19` (default true; matches PHP). */
	nice?: boolean;
	/** Working directory. */
	cwd?: string;
	/** Called with each stdout chunk (for ffmpeg -progress streaming). */
	onStdout?: (chunk: string) => void;
	/** Extra environment variables merged OVER process.env (e.g. MAGICK_CONFIGURE_PATH). */
	env?: Record<string, string>;
	/**
	 * A directory put FIRST on the child's inherited PATH (the rest kept), so a
	 * binary the child itself looks up resolves to the configured one — ocrmypdf
	 * finds `tesseract` by PATH, and must find the one system_info probed
	 * (config.media.binaries.tesseract, T0-11). Composed HERE because this is the
	 * one allowlisted reader of the inherited env.
	 */
	pathPrepend?: string;
}

/**
 * The default TOTAL budget — for the bounded commands that take it (`ffprobe`,
 * `identify`, `pdfinfo`). Deliberately generous: `probeMetaChannels` is measured
 * at 7.23 s on a 40000x30000 TIFF and an OCR pass is minutes, so a tight number
 * here would fail real work. It is not, and must never become, a transcode's cap
 * (module header).
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The child's environment: the inherited env (allowlisted passthrough,
 * config_env_tripwire S2-21), per-call overrides on top, and `pathPrepend` put
 * first on PATH with the rest kept.
 */
function childEnv(options: SpawnOptions): Record<string, string> {
	const baseEnv = process.env as Record<string, string>;
	const merged = options.env !== undefined ? { ...baseEnv, ...options.env } : baseEnv;
	const prepend = options.pathPrepend;
	if (prepend === undefined || prepend === '') return merged;
	const inherited = merged.PATH ?? '';
	return { ...merged, PATH: inherited === '' ? prepend : `${prepend}${delimiter}${inherited}` };
}

/**
 * Run a binary with an argv array. `argv[0]` is the absolute binary path; the
 * rest are literal arguments (never shell-parsed). Returns the captured output.
 * Never throws on a non-zero exit — the caller inspects `ok`/`stderr` (PHP's
 * media commands treat some non-zero exits as advisory, keying on output text),
 * and a caller that produces a FILE uses `assertSpawnOk`.
 */
export async function runBinary(
	argv: readonly string[],
	options: SpawnOptions = {},
): Promise<SpawnResult> {
	if (argv.length === 0) {
		throw new Error('runBinary: empty argv');
	}
	// MEDIA-05 argument-as-flag guard: every media file arg is an ABSOLUTE path
	// under MEDIA_ROOT today, so a positional file never starts with '-'. If a
	// future caller ever passes a '-'-leading path that actually exists, a
	// converter would parse it as an OPTION (e.g. ImageMagick -write, ffmpeg -vf).
	// Real flags ('-density', '-i') do not exist as files, so this never fires for them.
	for (const token of argv.slice(1)) {
		if (token.startsWith('-') && existsSync(token)) {
			throw new Error(
				`runBinary: refusing a '-'-leading argv token that is an existing path (argument-injection guard): ${token}`,
			);
		}
	}
	const nice = options.nice ?? true;
	// `nice -n 19 <binary> <args…>` — nice is a real argv prefix, not a shell string.
	const finalArgv = nice ? ['nice', '-n', '19', ...argv] : [...argv];
	const policy = resolveTimeoutPolicy(options);

	// Subprocess env passthrough (allowlisted, config_env_tripwire S2-21): media
	// binaries inherit the whole env, plus any per-call overrides (MAGICK_CONFIGURE_PATH).
	const env = childEnv(options);
	const child = Bun.spawn(finalArgv as string[], {
		stdout: 'pipe',
		stderr: 'pipe',
		cwd: options.cwd,
		env,
	});

	let capExpired = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// ARM/RE-ARM. Under the 'total' policy this runs exactly once, so the cap is a
	// wall-clock budget. Under 'idle' every output chunk re-arms it, so the cap
	// measures the longest SILENCE — see the module header for why a transcode may
	// only ever be governed that way.
	const arm = (): void => {
		if (settled) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			capExpired = true;
			child.kill(9);
		}, policy.ms);
	};
	arm();
	const tick = policy.kind === 'idle' ? arm : undefined;

	try {
		const onStdoutChunk = options.onStdout;
		const stdoutPromise = readAll(child.stdout as ReadableStream<Uint8Array>, (text) => {
			tick?.();
			if (text !== '') onStdoutChunk?.(text);
		});
		const stderrPromise = readAll(child.stderr as ReadableStream<Uint8Array>, tick);
		const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
		await child.exited;
		// Read the OUTCOME off the child, never the timer flag alone: `child.exited`
		// resolves 128+n for a signalled process (137 for SIGKILL), which is
		// indistinguishable from a real exit code, and a cap that expires in the
		// gap between a clean exit and this line must not turn a good encode into a
		// failure. `exitCode` is null exactly when a signal ended the process.
		const exitCode = child.exitCode;
		const signal = child.signalCode;
		const timedOut = capExpired && signal !== null;
		return {
			exitCode,
			signal,
			ok: exitCode === 0 && signal === null,
			stdout,
			stderr,
			timedOut,
			timeoutKind: timedOut ? policy.kind : null,
		};
	} finally {
		settled = true;
		clearTimeout(timer);
	}
}

/** The one cap governing a spawn — see `SpawnOptions` for why they are exclusive. */
interface TimeoutPolicy {
	kind: 'total' | 'idle';
	ms: number;
}

/**
 * Pick the ONE cap for this spawn. Both caps at once is a caller bug, not a
 * precedence question: it means two policies were written for one command and
 * nobody decided which governs, so it throws instead of quietly choosing.
 */
function resolveTimeoutPolicy(options: SpawnOptions): TimeoutPolicy {
	if (options.timeoutMs !== undefined && options.idleTimeoutMs !== undefined) {
		throw new Error(
			'runBinary: timeoutMs and idleTimeoutMs are mutually exclusive — a total wall-clock budget and an inactivity cap are different policies, pick one',
		);
	}
	if (options.idleTimeoutMs !== undefined) return { kind: 'idle', ms: options.idleTimeoutMs };
	return { kind: 'total', ms: options.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

/**
 * Throw unless the command actually succeeded. THE gate for every runner that
 * produces a file: `context` names the operation, and the message carries the
 * full diagnosis (exit code / signal / timeout / stderr tail) so a failed job is
 * readable from the panel without going to the server log.
 */
export function assertSpawnOk(result: SpawnResult, context: string): void {
	if (result.ok) return;
	throw new Error(`${context}: ${describeSpawnFailure(result)}`);
}

/** One-line diagnosis of a failed spawn (exit/signal/timeout + stderr tail). */
export function describeSpawnFailure(result: SpawnResult): string {
	const cause = result.timedOut
		? `TIMED OUT — ${
				result.timeoutKind === 'idle'
					? 'produced no output for the whole inactivity window (wedged, not slow)'
					: 'the wall-clock budget was spent'
			} (killed with ${result.signal ?? 'a signal'})`
		: result.signal !== null
			? `killed by ${result.signal}`
			: `exit ${String(result.exitCode)}`;
	const stderr = result.stderr.trim();
	return stderr === '' ? cause : `${cause}: ${stderr.slice(-2000)}`;
}

/**
 * Read a whole readable stream to a utf-8 string, invoking `onChunk` per decoded
 * chunk. BOTH streams are read through here, and the chunk callback is what feeds
 * the idle watchdog — a command is "alive" when it says anything at all, on
 * either channel, which is why this is one function and not a stdout-only
 * progress hook.
 */
async function readAll(
	stream: ReadableStream<Uint8Array>,
	onChunk?: (chunk: string) => void,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			// BYTES ARRIVED is the liveness fact, not "decoded to a non-empty string":
			// a chunk that splits a multi-byte character decodes to '' and would
			// otherwise look like silence to the watchdog.
			const text = decoder.decode(value, { stream: true });
			out += text;
			onChunk?.(text);
		}
	}
	const tail = decoder.decode();
	if (tail !== '') {
		out += tail;
		onChunk?.(tail);
	}
	return out;
}
