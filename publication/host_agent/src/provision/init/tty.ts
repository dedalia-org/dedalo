/**
 * THE OPERATOR'S TERMINAL (spec §1.2 TTY) — init's only way to ask.
 *
 *   - Interactive means stdin AND stdout are TTYs. Otherwise every question answers `null` (the
 *     caller turns that into "not a terminal: re-run with --yes / --decide …" or a REFUSED secret).
 *   - Everything is read in RAW mode, one character at a time: visible answers are echoed by this
 *     module, hidden ones never are. Backspace edits, Enter ends, an escape sequence (a cursor
 *     key) is discarded whole, Ctrl-C / Ctrl-D abort (null:
 *     "aborted by operator; nothing was written for this item"). Raw mode is restored in `finally`
 *     and on SIGINT (a signal sent from outside while a question is open).
 *   - A secret is asked twice and must match; three mismatches abort.
 *   - A decision shows its options. How it is answered is decision_class.ts classifyDecision's
 *     (the one rule): Enter takes the shown default of an ordinary decision; a `typed` one (it edits
 *     an operator file, replaces a pairing, removes something, sets an SELinux boolean or a mount
 *     option) must be TYPED — an empty answer asks again, naming why. A decision with no default
 *     takes nothing on Enter either. (run.ts never asks a `needs_action` or `auto` decision.)
 *   - Prompts are our own sentences; an item's title and option labels pass sanitizeLine.
 *
 * `scriptedPrompter(answers)` is the same contract with answers given in advance (init_run's
 * gates, and any future non-TTY front end that already holds the operator's answers).
 *
 * I/O: the streams are injected (production: process.stdin/stdout); nothing else is touched.
 */
import { classifyDecision } from './decision_class';
import { sanitizeLine } from './report';
import type { Item, Prompter } from './types';

/** The input side of a terminal (process.stdin's shape). */
export interface TtyInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The output side (process.stdout's shape). */
export interface TtyOutput {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

/** Signal registration (process's shape); a gate passes a fake to deliver SIGINT. */
export interface TtySignals {
  on(signal: 'SIGINT', listener: () => void): unknown;
  removeListener(signal: 'SIGINT', listener: () => void): unknown;
}

export interface TtyStreams {
  readonly input: TtyInput;
  readonly output: TtyOutput;
  readonly signals?: TtySignals;
}

const CTRL_C = '\x03';
const CTRL_D = '\x04';
const BACKSPACE = new Set(['\x7f', '\b']);
const ENTER = new Set(['\r', '\n']);
/** Secrets: how many times a mismatching pair is asked again before the item is aborted. */
export const SECRET_ATTEMPTS = 3;

/** Thrown inside the reader when the operator aborts; becomes `null` at the API. */
class Aborted extends Error {}

/**
 * One raw-mode session: characters arrive through the `data` listener into a queue; `nextChar`
 * awaits the next one. Raw mode is on only while a question is open.
 */
class RawReader {
  private readonly queue: string[] = [];
  private waiter: ((char: string) => void) | null = null;
  /**
   * ONE streaming decoder for the whole session: a UTF-8 character split across two `data` chunks
   * (a paste, an SSH frame) is held until its last byte arrives. Decoding each chunk alone turns
   * both halves into U+FFFD — and a secret typed twice with the same split would MATCH and be written.
   */
  private readonly decoder = new TextDecoder('utf-8');
  private readonly onData = (chunk: Buffer | string): void => {
    for (const char of typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })) {
      if (this.waiter !== null) {
        const resolve = this.waiter;
        this.waiter = null;
        resolve(char);
      } else this.queue.push(char);
    }
  };
  private readonly onSignal = (): void => {
    this.restore();
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(CTRL_C);
    } else this.queue.unshift(CTRL_C);
  };
  private raw = false;

  constructor(private readonly streams: TtyStreams) {}

  open(): void {
    this.streams.input.setRawMode?.(true);
    this.raw = true;
    this.streams.input.on('data', this.onData);
    this.streams.signals?.on('SIGINT', this.onSignal);
    this.streams.input.resume();
  }

  restore(): void {
    if (this.raw) {
      this.streams.input.setRawMode?.(false);
      this.raw = false;
    }
  }

  close(): void {
    this.restore();
    this.streams.input.removeListener('data', this.onData);
    this.streams.signals?.removeListener('SIGINT', this.onSignal);
    this.streams.input.pause();
  }

  nextChar(): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise(resolve => {
      this.waiter = resolve;
    });
  }
}

const ESC = '\x1b';

/** True when `char` is one code point in [low, high]. */
function inRange(char: string, low: number, high: number): boolean {
  const code = char.codePointAt(0) ?? -1;
  return char.length === 1 && code >= low && code <= high;
}

/**
 * Consumes the rest of an escape sequence whose ESC was just read, as ONE unit (a cursor key is not
 * part of an answer, and neither is any byte of it): CSI `ESC [` parameter (0x30-0x3F) and
 * intermediate (0x20-0x2F) bytes then one final byte (0x40-0x7E); SS3 `ESC O` then one final byte;
 * otherwise ESC + one printable byte (Alt+key, a two-byte escape). Returns null when the sequence
 * ended normally, or the character that broke it (Enter, Ctrl-C, Backspace… typed after a lone
 * ESC) for the line to handle — a line control is never swallowed by a sequence.
 */
async function skipEscape(reader: RawReader): Promise<string | null> {
  const intro = await reader.nextChar();
  if (intro === '[') {
    for (;;) {
      const char = await reader.nextChar();
      if (inRange(char, 0x20, 0x3f)) continue;
      return inRange(char, 0x40, 0x7e) ? null : char;
    }
  }
  if (intro === 'O') {
    const char = await reader.nextChar();
    return inRange(char, 0x40, 0x7e) ? null : char;
  }
  return inRange(intro, 0x20, 0x7e) ? null : intro;
}

/** Reads one line in raw mode. `echo`: print what is typed (visible) or nothing (hidden). */
async function readLine(reader: RawReader, output: TtyOutput, echo: boolean): Promise<string> {
  let text = '';
  /** A character an escape sequence handed back (it broke the sequence): handled before the next read. */
  let pending: string | null = null;
  for (;;) {
    let char: string = pending ?? (await reader.nextChar());
    pending = null;
    if (char === ESC) {
      const broke = await skipEscape(reader);
      if (broke === null) continue;
      char = broke;
      if (char === ESC) {
        pending = char;
        continue;
      }
    }
    if (char === CTRL_C || char === CTRL_D) {
      output.write('\n');
      throw new Aborted();
    }
    if (ENTER.has(char)) {
      output.write('\n');
      return text;
    }
    if (BACKSPACE.has(char)) {
      if (text.length > 0) {
        // One CHARACTER (code point), never half a surrogate pair: an emoji is one key, one backspace.
        text = Array.from(text).slice(0, -1).join('');
        if (echo) output.write('\b \b');
      }
      continue;
    }
    // Any other control character (a tab; an escape sequence was consumed whole above) is not part of an answer.
    if (char < ' ' || char === '\x7f') continue;
    text += char;
    if (echo) output.write(char);
  }
}

/** The production prompter on process.stdin/stdout. */
export function ttyPrompter(streams: TtyStreams = { input: process.stdin, output: process.stdout, signals: process }): Prompter {
  const interactive = streams.input.isTTY === true && streams.output.isTTY === true && typeof streams.input.setRawMode === 'function';
  const ask = async <T>(body: (reader: RawReader) => Promise<T>): Promise<T | null> => {
    if (!interactive) return null;
    const reader = new RawReader(streams);
    reader.open();
    try {
      return await body(reader);
    } catch (error) {
      if (error instanceof Aborted) {
        streams.output.write('aborted by operator; nothing was written for this item\n');
        return null;
      }
      throw error;
    } finally {
      reader.close();
    }
  };
  const write = (text: string) => streams.output.write(sanitizeLine(text));
  return {
    interactive,
    showOnce: lines => {
      if (!interactive) return;
      for (const line of lines) write(`${line}\n`);
    },
    confirm: async question => {
      const answer = await ask(async reader => {
        write(`${question} [y/N] `);
        return readLine(reader, streams.output, true);
      });
      return answer !== null && /^(y|yes)$/i.test(answer.trim());
    },
    choose: (item: Item) =>
      ask(async reader => {
        const options = item.options ?? [];
        write(`[${item.id}] ${item.title}\n`);
        for (const option of options) {
          write(`  ${option.id}: ${option.label}${option.id === item.defaultOption ? ' (default)' : ''}\n`);
        }
        const ids = options.map(option => option.id);
        const enter = enterAnswer(item);
        // The prompt's wording is a contract: scripts/publication_host_init_drill.ts PROMPTS reads
        // `(default <id> — type it)` and `(default <id> — Enter takes it)`.
        const hint =
          item.defaultOption === undefined ? '' : enter === null ? ` (default ${item.defaultOption} — type it)` : ` (default ${enter} — Enter takes it)`;
        for (;;) {
          write(`choose ${ids.join(' | ')}${hint}: `);
          const answer = (await readLine(reader, streams.output, true)).trim();
          if (ids.includes(answer)) return answer;
          if (answer === '' && enter !== null) return enter;
          write(answer === '' ? `${enterRefusedLine(item)}\n` : `'${answer}' is not one of ${ids.join(', ')}\n`);
        }
      }),
    visible: (label, defaultValue) =>
      ask(async reader => {
        write(`${label}${defaultValue === null ? '' : ` [${defaultValue}]`}: `);
        const answer = (await readLine(reader, streams.output, true)).trim();
        return answer === '' && defaultValue !== null ? defaultValue : answer;
      }),
    secret: label =>
      ask(async reader => {
        for (let attempt = 1; attempt <= SECRET_ATTEMPTS; attempt += 1) {
          write(`${label} (hidden): `);
          const first = await readLine(reader, streams.output, false);
          write(`${label} again: `);
          const second = await readLine(reader, streams.output, false);
          if (first === second) return first;
          write('the two entries differ; type it again\n');
        }
        write(`the entries did not match ${SECRET_ATTEMPTS} times; aborted\n`);
        throw new Aborted();
      }),
  };
}

/**
 * What an empty answer (Enter) takes for `item`: the shown default of a `choose` decision, else
 * null (a `typed` one, or one without a default). Both prompters use it, so the TTY and the scripted
 * gates cannot disagree.
 */
export function enterAnswer(item: Item): string | null {
  const prompt = classifyDecision(item);
  return prompt.kind === 'choose' ? prompt.enter : null;
}

/** Why Enter took nothing (the operator reads it before typing again). */
export function enterRefusedLine(item: Item): string {
  return classifyDecision(item).kind === 'typed'
    ? 'this decision changes your files or the whole host: Enter takes nothing, type an option'
    : 'this decision has no default: type an option';
}

/* ── scripted ─────────────────────────────────────────────────────────────────────── */

/** In ScriptedAnswers.choices: the operator pressed Enter (an empty answer). */
export const SCRIPTED_ENTER = '';

export interface ScriptedAnswers {
  /** The confirmation's answer ("Apply these N changes?"); default false. */
  readonly confirm?: boolean;
  /**
   * Decision id → option id. A decision not listed is aborted (null). SCRIPTED_ENTER ('') is Enter:
   * it takes what the terminal's Enter takes (enterAnswer), and where Enter takes nothing the
   * scripted operator gives up (null) — the terminal would ask again, a script cannot.
   */
  readonly choices?: Readonly<Record<string, string>>;
  /** Visible prompt label → value; a label not listed takes the default, or aborts without one. */
  readonly visible?: Readonly<Record<string, string>>;
  /** Hidden prompt label → value; a label not listed aborts. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Whether the scripted terminal counts as interactive (default true). */
  readonly interactive?: boolean;
}

/** A prompter that answers from `answers`, recording every question it was asked. */
export function scriptedPrompter(answers: ScriptedAnswers = {}): Prompter & { readonly asked: string[]; readonly shown: string[] } {
  const asked: string[] = [];
  const shown: string[] = [];
  const interactive = answers.interactive ?? true;
  return {
    asked,
    shown,
    interactive,
    showOnce: lines => {
      if (interactive) shown.push(...lines);
    },
    confirm: async question => {
      asked.push(`confirm ${question}`);
      return interactive && answers.confirm === true;
    },
    choose: async item => {
      asked.push(`choose ${item.id}`);
      if (!interactive) return null;
      const answer = answers.choices?.[item.id];
      if (answer === undefined) return null;
      if (answer === SCRIPTED_ENTER) {
        const enter = enterAnswer(item);
        asked.push(enter === null ? `enter refused ${item.id}` : `enter ${item.id}=${enter}`);
        return enter;
      }
      return answer;
    },
    visible: async (label, defaultValue) => {
      asked.push(`visible ${label}`);
      if (!interactive) return null;
      return answers.visible?.[label] ?? defaultValue;
    },
    secret: async label => {
      asked.push(`secret ${label}`);
      if (!interactive) return null;
      return answers.secrets?.[label] ?? null;
    },
  };
}
