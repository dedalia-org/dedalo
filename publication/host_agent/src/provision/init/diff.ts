/**
 * The unified diffs `provision init` shows before it writes anything (spec §2.1, §4.1 `Item.diff`):
 * the declaration rewrite (`declaration.write`, both sides canonicalDeclaration) and the operator
 * vhost edits (`web.manual_lines.*`, `web.vhost.*`). Context stays 3 lines (spec "Rejected
 * critiques": operators need context to approve a vhost edit); report.ts redacts every line
 * before printing.
 *
 * Myers' O((N+M)·D) shortest edit script, so a large operator file with a two-line change costs
 * little. Lines keep their `\r` (CRLF files diff as they are); a side that does not end in `\n`
 * gets the `\ No newline at end of file` marker, as `diff -u` prints it.
 *
 * PURE, ZERO-DEPENDENCY (tests/provision_zero_dep.test.ts candidate: no imports at all).
 */

interface Side {
  readonly lines: readonly string[];
  /** The text ended with '\n' (or was empty). */
  readonly eol: boolean;
}

function split(text: string): Side {
  if (text === '') return { lines: [], eol: true };
  const lines = text.split('\n');
  const eol = lines[lines.length - 1] === '';
  if (eol) lines.pop();
  return { lines, eol };
}

/**
 * The compared form of a side: a last line without its newline differs from the same text with
 * one (`diff -u` prints it `-x`, the marker, `+x`). '\n' never occurs inside a line, so the
 * suffix cannot collide with real text.
 */
function keys(side: Side): readonly string[] {
  if (side.eol || side.lines.length === 0) return side.lines;
  return [...side.lines.slice(0, -1), `${side.lines[side.lines.length - 1]}\n\0`];
}

/** One edit-script step: keep a line of both sides, delete one of `a`, insert one of `b`. */
type Op = { readonly kind: ' ' | '-' | '+'; readonly a: number; readonly b: number };

/** Myers' greedy forward search with the per-D trace, then a backtrack to the edit script. */
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    v = next;
  }
  // Backtrack from (n, m) through the recorded traces.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const prev = trace[d] as Int32Array;
    const k = x - y;
    const down = k === -d || (k !== d && (prev[offset + k - 1] ?? 0) < (prev[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: ' ', a: x, b: y });
    }
    if (d === 0) break;
    if (down) {
      y -= 1;
      ops.push({ kind: '+', a: x, b: y });
    } else {
      x -= 1;
      ops.push({ kind: '-', a: x, b: y });
    }
  }
  return ops.reverse();
}

/** GNU's hunk range: `start,count`, the start being the line before an empty range. */
function range(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  return count === 1 ? `${start + 1}` : `${start + 1},${count}`;
}

const NO_EOL = '\\ No newline at end of file';

/**
 * `diff -u` of two texts, labelled `path` on both header lines; '' when they are equal.
 * `lineOffset` shifts every line number (a fragment of a longer file, spec §4.3 web.*).
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3, lineOffset = 0): string {
  if (before === after) return '';
  if (!Number.isInteger(context) || context < 0) throw new Error(`diff: context ${context} must be an integer ≥ 0`);
  if (!Number.isInteger(lineOffset) || lineOffset < 0) throw new Error(`diff: lineOffset ${lineOffset} must be an integer ≥ 0`);
  const a = split(before);
  const b = split(after);
  const ops = editScript(keys(a), keys(b));
  const changed = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter(index => index >= 0);
  const out = [`--- ${path}`, `+++ ${path}`];
  let cursor = 0;
  while (cursor < changed.length) {
    const first = changed[cursor] as number;
    let last = first;
    while (cursor + 1 < changed.length && (changed[cursor + 1] as number) - last <= 2 * context + 1) {
      cursor += 1;
      last = changed[cursor] as number;
    }
    cursor += 1;
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    const slice = ops.slice(from, to + 1);
    const aStart = slice.find(op => op.kind !== '+')?.a ?? (slice[0] as Op).a;
    const bStart = slice.find(op => op.kind !== '-')?.b ?? (slice[0] as Op).b;
    const aCount = slice.filter(op => op.kind !== '+').length;
    const bCount = slice.filter(op => op.kind !== '-').length;
    out.push(`@@ -${range(aStart + lineOffset, aCount)} +${range(bStart + lineOffset, bCount)} @@`);
    for (const op of slice) {
      const text = op.kind === '+' ? (b.lines[op.b] as string) : (a.lines[op.a] as string);
      out.push(`${op.kind}${text}`);
      const lastOfA = op.kind !== '+' && op.a === a.lines.length - 1 && !a.eol;
      const lastOfB = op.kind !== '-' && op.b === b.lines.length - 1 && !b.eol;
      if ((op.kind === '-' && lastOfA) || (op.kind === '+' && lastOfB) || (op.kind === ' ' && (lastOfA || lastOfB))) {
        out.push(NO_EOL);
      }
    }
  }
  return `${out.join('\n')}\n`;
}

/** One insertion: `lines` after line `after` (0 = before the first line). */
export interface LineInsertion {
  readonly after: number;
  readonly lines: readonly string[];
}

/**
 * The hunks of an edit compare knows only by line (facts never carry an operator file's whole
 * text, spec §3.2): `removed` lines (1-based numbers, as discovered) and/or `inserted` lines after
 * line `after` (0 = before the first line) — one insertion, or several (a site's address-family
 * twins in one file each get the reference: compare web.vhost). No context lines — the file's other
 * lines are not in the facts; act re-reads the file and shows nothing it did not show here (beforeSha).
 */
export function lineEditDiff(
  path: string,
  edit: {
    readonly removed?: readonly { readonly line: number; readonly text: string }[];
    readonly inserted?: LineInsertion | readonly LineInsertion[];
  },
): string {
  const removed = [...(edit.removed ?? [])].sort((x, y) => x.line - y.line);
  for (const row of removed) {
    if (!Number.isInteger(row.line) || row.line < 1) throw new Error(`diff: line ${row.line} must be ≥ 1`);
    if (row.text.includes('\n')) throw new Error('diff: a removed line holds a newline');
  }
  if (new Set(removed.map(row => row.line)).size !== removed.length) throw new Error('diff: a line is removed twice');
  const insertions: readonly LineInsertion[] = edit.inserted === undefined ? [] : 'after' in edit.inserted ? [edit.inserted] : edit.inserted;
  for (const inserted of insertions) {
    if (!Number.isInteger(inserted.after) || inserted.after < 0) throw new Error(`diff: insertion point ${inserted.after} must be ≥ 0`);
  }
  if (new Set(insertions.map(inserted => inserted.after)).size !== insertions.length) throw new Error('diff: two insertions at one point');
  const added = insertions.filter(inserted => inserted.lines.length > 0);
  if (removed.length === 0 && added.length === 0) return '';
  const out = [`--- ${path}`, `+++ ${path}`];
  // Every hunk shifts the new side by the lines added minus removed before it.
  let shift = 0;
  const hunks: { at: number; delta: number; render: () => string[] }[] = [];
  for (const row of removed) hunks.push({ at: row.line, delta: -1, render: () => [`@@ -${row.line} +${row.line - 1 + shift},0 @@`, `-${row.text}`] });
  for (const inserted of added) {
    hunks.push({
      at: inserted.after + 0.5,
      delta: inserted.lines.length,
      render: () => [`@@ -${inserted.after},0 +${range(inserted.after + shift, inserted.lines.length)} @@`, ...inserted.lines.map(line => `+${line}`)],
    });
  }
  hunks.sort((x, y) => x.at - y.at);
  for (const hunk of hunks) {
    out.push(...hunk.render());
    shift += hunk.delta;
  }
  return `${out.join('\n')}\n`;
}
