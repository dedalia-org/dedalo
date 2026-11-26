/**
 * init/diff.ts — the unified diffs init shows before it writes (spec §2.1, §4.1 `Item.diff`).
 *
 * Proved by OUTCOME, not by spelling: every diff is applied back by an independent patcher and
 * must turn `before` into `after`, and its edit count must equal the LCS minimum (Myers finds a
 * shortest script). Exact bytes are pinned only where `diff -u` fixes them (headers, ranges, the
 * no-newline marker).
 */
import { describe, expect, test } from 'bun:test';
import { lineEditDiff, unifiedDiff } from '../src/provision/init/diff';

/** Applies a unified diff (as written by unifiedDiff) to `before`; throws on any context mismatch. */
function applyDiff(before: string, diff: string): string {
  if (diff === '') return before;
  const lines = before === '' ? [] : before.split('\n');
  let eolBefore = true;
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  else if (before !== '') eolBefore = false;
  const rows = diff.split('\n');
  expect(rows[rows.length - 1]).toBe('');
  rows.pop();
  expect(rows[0]?.startsWith('--- ')).toBe(true);
  expect(rows[1]?.startsWith('+++ ')).toBe(true);
  const out: string[] = [];
  let cursor = 0;
  let eolAfter = true;
  let index = 2;
  while (index < rows.length) {
    const header = rows[index] as string;
    const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/);
    if (match === null) throw new Error(`bad hunk header '${header}'`);
    const aCount = match[2] === undefined ? 1 : Number(match[2]);
    const aStart = aCount === 0 ? Number(match[1]) : Number(match[1]) - 1;
    while (cursor < aStart) out.push(lines[cursor++] as string);
    index += 1;
    while (index < rows.length && !(rows[index] as string).startsWith('@@')) {
      const row = rows[index] as string;
      const text = row.slice(1);
      if (row === '\\ No newline at end of file') {
        const previous = rows[index - 1] as string;
        if (previous.startsWith('+') || previous.startsWith(' ')) eolAfter = false;
        index += 1;
        continue;
      }
      if (row.startsWith(' ')) {
        if (lines[cursor] !== text) throw new Error(`context mismatch at ${cursor}: '${lines[cursor]}' vs '${text}'`);
        out.push(text);
        cursor += 1;
      } else if (row.startsWith('-')) {
        if (lines[cursor] !== text) throw new Error(`removal mismatch at ${cursor}: '${lines[cursor]}' vs '${text}'`);
        cursor += 1;
      } else if (row.startsWith('+')) {
        out.push(text);
      } else throw new Error(`bad row '${row}'`);
      index += 1;
    }
  }
  if (cursor < lines.length) eolAfter = eolBefore; // the unchanged tail keeps before's last line
  while (cursor < lines.length) out.push(lines[cursor++] as string);
  if (out.length === 0) return '';
  return `${out.join('\n')}${eolAfter ? '\n' : ''}`;
}

function lcs(a: readonly string[], b: readonly string[]): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      (table[i] as number[])[j] = a[i] === b[j] ? ((table[i + 1] as number[])[j + 1] as number) + 1 : Math.max((table[i + 1] as number[])[j] as number, (table[i] as number[])[j + 1] as number);
    }
  }
  return (table[0] as number[])[0] as number;
}

function editCount(diff: string): number {
  return diff.split('\n').filter(row => (row.startsWith('-') || row.startsWith('+')) && !row.startsWith('---') && !row.startsWith('+++')).length;
}

/** A tiny deterministic PRNG (xorshift) so the property rows are reproducible. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

describe('unifiedDiff', () => {
  test('equal texts give the empty string', () => {
    expect(unifiedDiff('/x', 'a\nb\n', 'a\nb\n')).toBe('');
    expect(unifiedDiff('/x', '', '')).toBe('');
  });

  test('a one-line change carries diff -u headers, ranges and three lines of context', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const after = 'a\nb\nc\nd\nE\nf\ng\nh\n';
    expect(unifiedDiff('/etc/x.json', before, after)).toBe(
      ['--- /etc/x.json', '+++ /etc/x.json', '@@ -2,7 +2,7 @@', ' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h', ''].join('\n'),
    );
  });

  test('a new file is one hunk from -0,0', () => {
    expect(unifiedDiff('/n', '', 'x\ny\n')).toBe(['--- /n', '+++ /n', '@@ -0,0 +1,2 @@', '+x', '+y', ''].join('\n'));
  });

  test('distant changes make two hunks; near ones merge', () => {
    const before = `${Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')}\n`;
    const far = before.replace('l1\n', 'L1\n').replace('l18\n', 'L18\n');
    expect(unifiedDiff('/f', before, far).match(/^@@/gm)?.length).toBe(2);
    const near = before.replace('l1\n', 'L1\n').replace('l6\n', 'L6\n');
    expect(unifiedDiff('/f', before, near).match(/^@@/gm)?.length).toBe(1);
  });

  test('hunks merge exactly when their context windows touch (GNU: a gap of 2×context lines)', () => {
    const before = `${Array.from({ length: 21 }, (_, i) => `l${i}`).join('\n')}\n`;
    const touching = before.replace('l1\n', 'L1\n').replace('l8\n', 'L8\n');
    expect(unifiedDiff('/f', before, touching).match(/^@@.*@@$/gm)).toEqual(['@@ -1,12 +1,12 @@']);
    const apart = before.replace('l1\n', 'L1\n').replace('l9\n', 'L9\n');
    expect(unifiedDiff('/f', before, apart).match(/^@@.*@@$/gm)).toEqual(['@@ -1,5 +1,5 @@', '@@ -7,7 +7,7 @@']);
  });

  test('a missing final newline gets the marker, on the side that lacks it', () => {
    const diff = unifiedDiff('/f', 'a\nb', 'a\nb\n');
    expect(diff).toBe(['--- /f', '+++ /f', '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b', ''].join('\n'));
    expect(applyDiff('a\nb', diff)).toBe('a\nb\n');
    expect(applyDiff('a\nb\n', unifiedDiff('/f', 'a\nb\n', 'a\nb'))).toBe('a\nb');
  });

  test('CRLF lines stay CRLF: a line ending change is a change', () => {
    const diff = unifiedDiff('/v', 'a\r\nb\r\n', 'a\r\nB\r\n');
    expect(diff).toContain('-b\r\n+B\r\n');
    expect(applyDiff('a\r\nb\r\n', diff)).toBe('a\r\nB\r\n');
  });

  test('lineOffset shifts every number (a fragment of a longer file)', () => {
    expect(unifiedDiff('/f', 'a\n', 'b\n', 3, 40)).toContain('@@ -41 +41 @@');
  });

  test('a bad context or offset throws', () => {
    expect(() => unifiedDiff('/f', 'a', 'b', -1)).toThrow(/context/);
    expect(() => unifiedDiff('/f', 'a', 'b', 1.5)).toThrow(/context/);
    expect(() => unifiedDiff('/f', 'a', 'b', 3, -2)).toThrow(/lineOffset/);
  });

  test('property: 400 random edits apply back exactly, with a minimal edit count', () => {
    const random = prng(0x5eed);
    const alphabet = ['a', 'b', 'c', 'd', '', 'x y', 'a'];
    const pick = () => alphabet[Math.floor(random() * alphabet.length)] as string;
    for (let round = 0; round < 400; round += 1) {
      const a = Array.from({ length: Math.floor(random() * 14) }, pick);
      const b = a.filter(() => random() > 0.25).flatMap(line => (random() > 0.8 ? [line, pick()] : [line]));
      if (random() > 0.7) b.splice(Math.floor(random() * (b.length + 1)), 0, pick());
      const before = a.length === 0 ? '' : `${a.join('\n')}${random() > 0.2 ? '\n' : ''}`;
      const after = b.length === 0 ? '' : `${b.join('\n')}${random() > 0.2 ? '\n' : ''}`;
      const context = Math.floor(random() * 4);
      const diff = unifiedDiff('/p', before, after, context);
      expect(applyDiff(before, diff)).toBe(after);
      // A last line without its newline is its own line (as diff -u treats it).
      const split = (text: string) => {
        if (text === '') return [];
        const rows = text.replace(/\n$/, '').split('\n');
        if (!text.endsWith('\n')) rows[rows.length - 1] = `${rows[rows.length - 1]}<no eol>`;
        return rows;
      };
      const sa = split(before);
      const sb = split(after);
      expect(editCount(diff)).toBe(sa.length + sb.length - 2 * lcs(sa, sb));
    }
  });
});

describe('lineEditDiff', () => {
  test('several insertions (address-family twins in one file): each hunk shifted by the ones before it; two at one point refused', () => {
    const lines = ['# marker', 'IncludeOptional /x'];
    expect(lineEditDiff('/v', { inserted: [{ after: 20, lines }, { after: 2, lines }] })).toBe(
      ['--- /v', '+++ /v', '@@ -2,0 +3,2 @@', '+# marker', '+IncludeOptional /x', '@@ -20,0 +23,2 @@', '+# marker', '+IncludeOptional /x', ''].join('\n'),
    );
    expect(lineEditDiff('/v', { inserted: [{ after: 2, lines }] })).toBe(lineEditDiff('/v', { inserted: { after: 2, lines } }));
    expect(lineEditDiff('/v', { inserted: [] })).toBe('');
    expect(() => lineEditDiff('/v', { inserted: [{ after: 2, lines }, { after: 2, lines }] })).toThrow('two insertions at one point');
    expect(() => lineEditDiff('/v', { inserted: [{ after: -1, lines }] })).toThrow('must be ≥ 0');
  });

  const file = ['<VirtualHost *:443>', '  ServerName example.org', '  Alias /x /y', '  <Directory /y>', '  </Directory>', '</VirtualHost>'].join('\n');

  test('inserted lines land after their line, numbered on both sides', () => {
    const diff = lineEditDiff('/v', { inserted: { after: 1, lines: ['# ref', 'IncludeOptional /etc/x.conf'] } });
    expect(diff).toBe(['--- /v', '+++ /v', '@@ -1,0 +2,2 @@', '+# ref', '+IncludeOptional /etc/x.conf', ''].join('\n'));
    expect(applyDiff(`${file}\n`, diff)).toBe(`${file.split('\n')[0]}\n# ref\nIncludeOptional /etc/x.conf\n${file.split('\n').slice(1).join('\n')}\n`);
  });

  test('removed lines (not contiguous) each get a hunk and apply back', () => {
    const diff = lineEditDiff('/v', { removed: [{ line: 5, text: '  </Directory>' }, { line: 3, text: '  Alias /x /y' }] });
    expect(diff.match(/^@@/gm)?.length).toBe(2);
    expect(applyDiff(`${file}\n`, diff)).toBe(`${['<VirtualHost *:443>', '  ServerName example.org', '  <Directory /y>', '</VirtualHost>'].join('\n')}\n`);
  });

  test('removals before an insertion shift its new-side number', () => {
    const diff = lineEditDiff('/v', { removed: [{ line: 2, text: '  ServerName example.org' }], inserted: { after: 4, lines: ['N'] } });
    expect(diff.match(/^@@.*@@$/gm)).toEqual(['@@ -2 +1,0 @@', '@@ -4,0 +4 @@']);
    expect(applyDiff(`${file}\n`, diff)).toBe(`${['<VirtualHost *:443>', '  Alias /x /y', '  <Directory /y>', 'N', '  </Directory>', '</VirtualHost>'].join('\n')}\n`);
  });

  test('nothing to do is empty; bad rows throw', () => {
    expect(lineEditDiff('/v', {})).toBe('');
    expect(lineEditDiff('/v', { inserted: { after: 2, lines: [] } })).toBe('');
    expect(() => lineEditDiff('/v', { removed: [{ line: 0, text: 'x' }] })).toThrow(/≥ 1/);
    expect(() => lineEditDiff('/v', { removed: [{ line: 2, text: 'a\nb' }] })).toThrow(/newline/);
    expect(() => lineEditDiff('/v', { removed: [{ line: 2, text: 'a' }, { line: 2, text: 'a' }] })).toThrow(/twice/);
    expect(() => lineEditDiff('/v', { inserted: { after: -1, lines: ['x'] } })).toThrow(/insertion point/);
  });
});
