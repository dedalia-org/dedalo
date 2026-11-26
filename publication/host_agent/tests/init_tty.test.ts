/**
 * init/tty.ts — the operator's terminal (spec §1.2 TTY), on fake streams: raw mode on only while a
 * question is open and ALWAYS restored (Enter, Ctrl-C, Ctrl-D, SIGINT); a hidden answer is never
 * echoed and must be typed twice; a decision's default is taken by Enter unless the decision is
 * `typed` (decision_class.ts) or has no default; no TTY answers null.
 * Seam: TtyStreams (input/output/signals); scriptedPrompter is the same contract, scripted.
 */
import { describe, expect, test } from 'bun:test';
import type { TtyInput, TtyOutput, TtySignals } from '../src/provision/init/tty';
import { enterAnswer, SCRIPTED_ENTER, SECRET_ATTEMPTS, scriptedPrompter, ttyPrompter } from '../src/provision/init/tty';
import type { Item } from '../src/provision/init/types';

class FakeInput implements TtyInput {
  isTTY = true;
  raw: boolean[] = [];
  private listener: ((chunk: Buffer | string) => void) | null = null;
  private readonly pending: (string | Buffer)[] = [];
  /** A string chunk arrives as its UTF-8 bytes; a Buffer chunk arrives as given (a split character). */
  constructor(...chunks: (string | Buffer)[]) {
    this.pending.push(...chunks);
  }
  setRawMode(mode: boolean): void {
    this.raw.push(mode);
  }
  get rawNow(): boolean {
    return this.raw.at(-1) === true;
  }
  on(_event: 'data', listener: (chunk: Buffer | string) => void): void {
    this.listener = listener;
  }
  removeListener(): void {
    this.listener = null;
  }
  resume(): void {
    const chunks = this.pending.splice(0);
    queueMicrotask(() => {
      for (const chunk of chunks) this.listener?.(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
  }
  pause(): void {}
  type(chunk: string): void {
    this.listener?.(chunk);
  }
}

class FakeOutput implements TtyOutput {
  isTTY = true;
  text = '';
  write(chunk: string): void {
    this.text += chunk;
  }
}

class FakeSignals implements TtySignals {
  listeners: (() => void)[] = [];
  on(_signal: 'SIGINT', listener: () => void): void {
    this.listeners.push(listener);
  }
  removeListener(_signal: 'SIGINT', listener: () => void): void {
    this.listeners = this.listeners.filter(row => row !== listener);
  }
}

function terminal(...chunks: (string | Buffer)[]) {
  const input = new FakeInput(...chunks);
  const output = new FakeOutput();
  const signals = new FakeSignals();
  return { input, output, signals, prompter: ttyPrompter({ input, output, signals }) };
}

const DECISION: Item = {
  id: 'declaration.layout',
  list: 'decision',
  area: 'declaration',
  title: 'layout \x1b[31mred\x1b[0m',
  facts: [],
  commands: [],
  options: [
    { id: 'home', label: 'the per-site home', resolves: 'act' },
    { id: 'system', label: '/srv and /opt', resolves: 'relocate' },
  ],
  defaultOption: 'home',
  after: [],
  blocking: false,
  optional: false,
  operatorFile: false,
  hostWide: false,
};

/** The same decision with a typed option (an operator file edit): Enter takes nothing. */
const TYPED: Item = {
  ...DECISION,
  id: 'web.vhost.0123abcd',
  title: 'add the include',
  options: [
    { id: 'act', label: 'do it', resolves: 'act', confirm: 'typed' },
    { id: 'manual', label: 'by hand', resolves: 'manual' },
  ],
  defaultOption: 'act',
  operatorFile: true,
};

describe('ttyPrompter', () => {
  test('interactive only when stdin and stdout are TTYs with raw mode', () => {
    expect(terminal().prompter.interactive).toBe(true);
    const t = terminal();
    t.output.isTTY = false;
    expect(ttyPrompter({ input: t.input, output: t.output }).interactive).toBe(false);
    const noRaw = { ...new FakeInput(), isTTY: true, on() {}, removeListener() {}, resume() {}, pause() {} } as TtyInput;
    expect(ttyPrompter({ input: noRaw, output: new FakeOutput() }).interactive).toBe(false);
  });

  test('no TTY: every question answers null / false, and nothing is written to the terminal', async () => {
    const t = terminal('y\r');
    t.input.isTTY = false;
    const prompter = ttyPrompter({ input: t.input, output: t.output });
    expect(await prompter.confirm('Apply?')).toBe(false);
    expect(await prompter.choose(DECISION)).toBeNull();
    expect(await prompter.visible('host', 'localhost')).toBeNull();
    expect(await prompter.secret('password')).toBeNull();
    expect(t.output.text).toBe('');
    expect(t.input.raw).toEqual([]);
  });

  test('confirm: y/yes is true, anything else false; raw mode on while asking, restored after', async () => {
    for (const [typed, answer] of [['y\r', true], ['YES\r', true], ['n\r', false], ['\r', false], ['yes please\r', false]] as const) {
      const t = terminal(typed);
      expect(await t.prompter.confirm('Apply these 3 changes?')).toBe(answer);
      expect(t.input.raw).toEqual([true, false]);
      expect(t.output.text).toStartWith('Apply these 3 changes? [y/N] ');
    }
  });

  test('choose: an unknown option asks again; a typed option is taken; the title is sanitized', async () => {
    const t = terminal('nope\r', 'system\r');
    expect(await t.prompter.choose(DECISION)).toBe('system');
    expect(t.output.text).toContain('home: the per-site home (default)');
    expect(t.output.text).toContain("'nope' is not one of home, system");
    expect(t.output.text).not.toContain('\x1b');
  });

  test('choose (class choose): Enter takes the shown default, and the prompt says so', async () => {
    const t = terminal('\r');
    expect(await t.prompter.choose(DECISION)).toBe('home');
    expect(t.output.text).toContain('choose home | system (default home — Enter takes it): ');
    expect(t.input.raw).toEqual([true, false]);
  });

  test('choose (class typed): Enter is refused, naming why; only a typed option answers', async () => {
    const t = terminal('\r', '\r', 'act\r');
    expect(await t.prompter.choose(TYPED)).toBe('act');
    expect(t.output.text).toContain('choose act | manual (default act — type it): ');
    expect(t.output.text.split('this decision changes your files or the whole host: Enter takes nothing, type an option')).toHaveLength(3);
    const manual = terminal('\r', 'manual\r');
    expect(await manual.prompter.choose(TYPED)).toBe('manual');
  });

  test('choose without a default: Enter takes nothing', async () => {
    const t = terminal('\r', 'system\r');
    expect(await t.prompter.choose({ ...DECISION, defaultOption: undefined })).toBe('system');
    expect(t.output.text).toContain('this decision has no default: type an option');
    expect(t.output.text).toContain('choose home | system: ');
  });

  test('visible: echoed, backspace edits, an empty answer takes the shown default', async () => {
    const t = terminal('dbx\x7f\x7fb\r');
    expect(await t.prompter.visible('v2 database user', null)).toBe('db');
    expect(t.output.text).toContain('dbx\b \b\b \bb');
    const d = terminal('\r');
    expect(await d.prompter.visible('v2 database host', 'localhost')).toBe('localhost');
    expect(d.output.text).toContain('v2 database host [localhost]: ');
  });

  test('secret: never echoed, typed twice, must match', async () => {
    const t = terminal('s3cret-pw\r', 's3cret-pw\r');
    expect(await t.prompter.secret('v2 database password')).toBe('s3cret-pw');
    expect(t.output.text).not.toContain('s3cret');
    expect(t.output.text).toContain('v2 database password (hidden): ');
    expect(t.output.text).toContain('v2 database password again: ');
  });

  test('secret: a UTF-8 character split across two data chunks is decoded whole (never U+FFFD)', async () => {
    const secret = 'Contraseña-ç🔑';
    const bytes = Buffer.from(`${secret}\r`);
    // Split INSIDE 'ñ' (2 bytes) and inside the emoji (4 bytes), in both entries alike: decoding
    // each chunk alone turned both halves into U+FFFD and the two corrupted entries MATCHED.
    const n = bytes.indexOf(Buffer.from('ñ')) + 1;
    const k = bytes.indexOf(Buffer.from('🔑')) + 2;
    const parts = [bytes.subarray(0, n), bytes.subarray(n, k), bytes.subarray(k)];
    const t = terminal(...parts, ...parts);
    expect(await t.prompter.secret('v2 database password')).toBe(secret);
  });

  test('backspace removes one character: an emoji whole, never half a surrogate pair', async () => {
    const t = terminal('abc🔑\x7fd\r');
    const answer = await t.prompter.visible('v2 database user', null);
    expect(answer).toBe('abcd');
    expect(answer).not.toMatch(/[\uD800-\uDFFF]/);
  });

  test('secret: a mismatch asks again; three mismatches abort (null)', async () => {
    const once = terminal('aaaaaaaa\r', 'bbbbbbbb\r', 'cccccccc\r', 'cccccccc\r');
    expect(await once.prompter.secret('pw')).toBe('cccccccc');
    expect(once.output.text).toContain('the two entries differ; type it again');
    const chunks = Array.from({ length: SECRET_ATTEMPTS }, (_, i) => [`first${i}xx\r`, `other${i}xx\r`]).flat();
    const never = terminal(...chunks);
    expect(await never.prompter.secret('pw')).toBeNull();
    expect(never.output.text).toContain(`the entries did not match ${SECRET_ATTEMPTS} times; aborted`);
    expect(never.input.rawNow).toBe(false);
  });

  test('Ctrl-C and Ctrl-D abort the item (null) and restore the terminal', async () => {
    for (const key of ['\x03', '\x04']) {
      const t = terminal(`abc${key}`);
      expect(await t.prompter.secret('pw')).toBeNull();
      expect(t.output.text).toContain('aborted by operator; nothing was written for this item');
      expect(t.input.raw).toEqual([true, false]);
    }
    const c = terminal('\x03');
    expect(await c.prompter.choose(DECISION)).toBeNull();
    expect(await terminal('\x03').prompter.confirm('Apply?')).toBe(false);
  });

  test('SIGINT while a question is open restores raw mode and aborts the item', async () => {
    const t = terminal();
    const pending = t.prompter.secret('pw');
    await Promise.resolve();
    expect(t.signals.listeners).toHaveLength(1);
    t.signals.listeners[0]?.();
    expect(await pending).toBeNull();
    expect(t.input.rawNow).toBe(false);
    expect(t.signals.listeners).toEqual([]); // the handler is removed with the question
  });

  test('control keys are not part of an answer', async () => {
    // The cursor key's sequence goes whole (it once left '[A' in the answer: init_tty_escape.test.ts).
    const t = terminal('a\x1b[Ab\tc\r');
    expect(await t.prompter.visible('x', null)).toBe('abc');
  });
});

describe('scriptedPrompter', () => {
  test('answers from its script and records every question', async () => {
    const p = scriptedPrompter({ confirm: true, choices: { 'declaration.layout': 'system' }, visible: { host: 'db1' }, secrets: { pw: 'x' } });
    expect(p.interactive).toBe(true);
    expect(await p.confirm('Apply?')).toBe(true);
    expect(await p.choose(DECISION)).toBe('system');
    expect(await p.choose({ ...DECISION, id: 'other' })).toBeNull();
    expect(await p.visible('host', 'localhost')).toBe('db1');
    expect(await p.visible('port', '3306')).toBe('3306');
    expect(await p.secret('pw')).toBe('x');
    expect(await p.secret('other')).toBeNull();
    expect(p.asked).toEqual(['confirm Apply?', 'choose declaration.layout', 'choose other', 'visible host', 'visible port', 'secret pw', 'secret other']);
  });

  test('SCRIPTED_ENTER is the terminal\'s Enter: the default of a choose decision; nothing for a typed one', async () => {
    const p = scriptedPrompter({ choices: { [DECISION.id]: SCRIPTED_ENTER, [TYPED.id]: SCRIPTED_ENTER } });
    expect(await p.choose(DECISION)).toBe('home');
    expect(await p.choose(TYPED)).toBeNull();
    expect(p.asked).toEqual([`choose ${DECISION.id}`, `enter ${DECISION.id}=home`, `choose ${TYPED.id}`, `enter refused ${TYPED.id}`]);
    // The one rule both prompters read.
    expect([enterAnswer(DECISION), enterAnswer(TYPED), enterAnswer({ ...DECISION, defaultOption: undefined })]).toEqual(['home', null, null]);
  });

  test('not interactive: nothing is answered', async () => {
    const p = scriptedPrompter({ interactive: false, confirm: true, choices: { a: 'b' }, secrets: { pw: 'x' } });
    expect(await p.confirm('Apply?')).toBe(false);
    expect(await p.choose(DECISION)).toBeNull();
    expect(await p.visible('host', 'localhost')).toBeNull();
    expect(await p.secret('pw')).toBeNull();
  });
});

describe('showOnce (the pairing package passphrase)', () => {
  test('a terminal: the lines are written, sanitized, without raw mode; not a terminal: nothing', () => {
    const t = terminal();
    t.prompter.showOnce(['  the passphrase:', '      ABCD-EFGH\x1b[2J']);
    expect(t.output.text).toBe('  the passphrase:\n      ABCD-EFGH\n');
    expect(t.input.raw).toEqual([]);
    const pipe = terminal();
    pipe.output.isTTY = false;
    const notTty = ttyPrompter({ input: pipe.input, output: pipe.output, signals: pipe.signals });
    notTty.showOnce(['secret']);
    expect(pipe.output.text).toBe('');
    const scripted = scriptedPrompter();
    scripted.showOnce(['a']);
    expect(scripted.shown).toEqual(['a']);
    const quiet = scriptedPrompter({ interactive: false });
    quiet.showOnce(['a']);
    expect(quiet.shown).toEqual([]);
  });
});
