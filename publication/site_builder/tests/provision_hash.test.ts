/**
 * THE STAMP GATE — the properties `src/provision/hash.ts` has to keep for the provisioner
 * to be safe to run twice.
 *
 * The provisioner writes only on drift, as root, on a host with a museum's live public site
 * on it. Every one of those words rests on the stamp: the first line of each generated file
 * carries the sha256 of everything below it, so a later run can tell "we changed the
 * renderer" (safe: rewrite) from "somebody edited this file" (not safe: report, refuse).
 * Four properties make that distinction real, and each has a test below:
 *
 *   1. ROUND TRIP — what `stamp()` writes, `parseStamp()` reads back, body byte for byte.
 *      Without it every artifact is a hand edit the moment it is read.
 *   2. THE STAMP LINE IS NOT IN THE HASH. It cannot be (the line holds the hash), and the
 *      consequence is load-bearing: renaming a kind or moving an instance leaves the file's
 *      CONTENT unchanged, so it must not read as drift.
 *   3. DRIFT IS DETECTED — any change to the body, and any tampering with the recorded
 *      hash. This is the only mechanism protecting a hand-tuned vhost from being silently
 *      overwritten.
 *   4. AN UNSTAMPED OR CORRUPT FILE RETURNS null, NEVER A THROW. The caller is walking a
 *      real host: a hand-written vhost from before this subsystem existed, a truncated
 *      file, a binary blob at a path the declaration now claims. Those are the normal
 *      contents of a host, and the answer needed is "not ours" — actionable, not thrown.
 *
 * Pure gate over pure functions: nothing here touches the filesystem.
 */

import { describe, expect, test } from 'bun:test';
import { INSTANCE_PATTERN } from '../src/provision/layout';
import { STAMP_TOKEN, bodyHash, hasDrifted, parseStamp, stamp } from '../src/provision/hash';

/** A representative artifact body: several lines, a trailing newline, a non-ASCII character. */
const BODY = ['[Service]', 'User=dedalo-site-myentity', '# My Institution — drafts', ''].join('\n');

const INSTANCE = 'myentity';
const KIND = 'unit';

describe('bodyHash', () => {
  /**
   * ANCHORED TO THE ALGORITHM, not to itself. Two published sha256 vectors, so a change of
   * digest or of input encoding reddens here — rather than silently making every artifact
   * on every existing host read as drift on the next release.
   */
  test('is sha256 over utf8, lowercase hex', () => {
    expect(bodyHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(bodyHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('is stable, and separates bodies that differ by one byte', () => {
    expect(bodyHash(BODY)).toBe(bodyHash(BODY));
    expect(bodyHash(BODY)).not.toBe(bodyHash(`${BODY} `));
  });
});

describe('stamp / parseStamp round trip', () => {
  test('the first line is the stamp and the rest is the body, verbatim', () => {
    const text = stamp(KIND, INSTANCE, BODY);
    const [first, ...rest] = text.split('\n');

    expect(first).toBe(`# ${STAMP_TOKEN} ${INSTANCE} ${KIND} ${bodyHash(BODY)}`);
    // Byte for byte, trailing newline included: the body is what the renderer produced and
    // the file is what apply writes, so any reflow here is a file that never matches again.
    expect(rest.join('\n')).toBe(BODY);
  });

  test('parseStamp returns the kind, the instance, the recorded hash and the body', () => {
    const parsed = parseStamp(stamp(KIND, INSTANCE, BODY));
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe(KIND);
    expect(parsed!.instance).toBe(INSTANCE);
    expect(parsed!.hash).toBe(bodyHash(BODY));
    expect(parsed!.body).toBe(BODY);
  });

  test('the comment prefix is the caller-s, because only the caller knows the syntax', () => {
    const text = stamp(KIND, INSTANCE, BODY, '//');
    expect(text.startsWith(`// ${STAMP_TOKEN} `)).toBe(true);
    // The prefix is not part of the identity: the same artifact parses the same either way.
    expect(parseStamp(text)!.body).toBe(BODY);
    expect(parseStamp(text)!.hash).toBe(parseStamp(stamp(KIND, INSTANCE, BODY))!.hash);
  });

  test('an empty body is an artifact, not a failure', () => {
    const parsed = parseStamp(stamp(KIND, INSTANCE, ''));
    expect(parsed!.body).toBe('');
    expect(hasDrifted(stamp(KIND, INSTANCE, ''))).toBe(false);
  });

  test('a body with no trailing newline survives the round trip', () => {
    const body = 'MAX_SITES=8';
    expect(parseStamp(stamp('env', INSTANCE, body))!.body).toBe(body);
    expect(hasDrifted(stamp('env', INSTANCE, body))).toBe(false);
  });

  test('a CRLF stamp line still parses, and the body stays byte-exact', () => {
    // CR on the FIRST line break only (the stamp line), spelled out: the body keeps LF.
    const stamped = stamp(KIND, INSTANCE, BODY);
    const firstBreak = stamped.indexOf('\n');
    const text = `${stamped.slice(0, firstBreak)}\r\n${stamped.slice(firstBreak + 1)}`;
    const parsed = parseStamp(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.instance).toBe(INSTANCE);
    // Only the STAMP LINE tolerates the carriage return. A body converted to CRLF was
    // changed, and must read as changed.
    expect(hasDrifted(text)).toBe(false);
    expect(hasDrifted(stamp(KIND, INSTANCE, BODY).replace(/\n/g, '\r\n'))).toBe(true);
  });

  /**
   * A stamp is written into a root-owned config file whose first line must be a comment.
   * These three inputs would each produce a line that is unparseable, or a DIRECTIVE — and
   * `derive()` is a second entry point (an adopted host's manifest is built from disk, with
   * no declaration ever validated), so they are refused rather than trusted.
   */
  test('refuses a kind, an instance or a prefix that would corrupt the line', () => {
    expect(() => stamp('not a kind', INSTANCE, BODY)).toThrow(/kind/);
    expect(() => stamp(KIND, 'Not_An_Instance', BODY)).toThrow(/instance/);
    expect(() => stamp(KIND, INSTANCE, BODY, 'listen 80;')).toThrow(/comment prefix/);
    // The instance grammar has ONE owner; this asserts the refusal is that grammar and not
    // a second opinion about instance names living in hash.ts.
    expect(INSTANCE_PATTERN.test('Not_An_Instance')).toBe(false);
    expect(INSTANCE_PATTERN.test(INSTANCE)).toBe(true);
  });
});

describe('the stamp line is excluded from the hash', () => {
  /**
   * Property 2, stated the only way that cannot be faked: the SAME body under different
   * stamps records the SAME hash. If the line were part of what is hashed, renaming a kind
   * would look exactly like an operator having edited the file.
   */
  test('the same body records the same hash under any kind, instance or prefix', () => {
    const recorded = (text: string) => parseStamp(text)!.hash;
    expect(recorded(stamp('env', INSTANCE, BODY))).toBe(recorded(stamp('unit', INSTANCE, BODY)));
    expect(recorded(stamp(KIND, 'other', BODY))).toBe(recorded(stamp(KIND, INSTANCE, BODY)));
    expect(recorded(stamp(KIND, INSTANCE, BODY, '//'))).toBe(recorded(stamp(KIND, INSTANCE, BODY)));
  });

  test('rewriting the stamp line alone is not drift — the content did not change', () => {
    const text = stamp(KIND, INSTANCE, BODY).replace(` ${KIND} `, ' env ');
    expect(hasDrifted(text)).toBe(false);
    expect(parseStamp(text)!.kind).toBe('env');
  });
});

describe('hasDrifted', () => {
  test('is false for what stamp() just produced', () => {
    expect(hasDrifted(stamp(KIND, INSTANCE, BODY))).toBe(false);
  });

  test('catches an appended line, a deleted line and a one-character edit', () => {
    const text = stamp(KIND, INSTANCE, BODY);
    expect(hasDrifted(`${text}Restart=no\n`)).toBe(true);
    expect(hasDrifted(text.replace('User=dedalo-site-myentity\n', ''))).toBe(true);
    expect(hasDrifted(text.replace('User=dedalo-site-myentity', 'User=root'))).toBe(true);
  });

  test('catches a recorded hash that was edited to match nothing', () => {
    // The obvious attempt to make a hand edit look official: change the body, then change
    // the digits. It fails unless the editor recomputes sha256 over the exact bytes.
    const tampered = stamp(KIND, INSTANCE, BODY)
      .replace('User=dedalo-site-myentity', 'User=root')
      .replace(bodyHash(BODY), 'f'.repeat(64));
    expect(hasDrifted(tampered)).toBe(true);
  });

  test('treats an unstamped file as drift, because nothing else writes that line', () => {
    expect(hasDrifted(BODY)).toBe(true);
    expect(hasDrifted('')).toBe(true);
    // The commonest hand edit of all: delete the header that says not to edit the file.
    expect(hasDrifted(stamp(KIND, INSTANCE, BODY).split('\n').slice(1).join('\n'))).toBe(true);
  });
});

describe('parseStamp refuses rather than throws', () => {
  /**
   * Property 4. Every one of these is something a real host holds at a path the declaration
   * now claims, and the caller's response to all of them is the same: this file is not
   * ours, do not overwrite it. A throw here would turn "the host has a pre-existing vhost"
   * into a crashed provisioning run.
   */
  const notOurs: Record<string, string> = {
    'an empty file': '',
    'a hand-written vhost': 'server {\n    listen 80;\n}\n',
    'a plain comment header': '# generated by hand, 2019\nkey=value\n',
    'our marker, no fields': `# ${STAMP_TOKEN}\n${BODY}`,
    'our marker, missing the hash': `# ${STAMP_TOKEN} ${INSTANCE} ${KIND}\n${BODY}`,
    'a truncated hash': `# ${STAMP_TOKEN} ${INSTANCE} ${KIND} ${bodyHash(BODY).slice(0, 63)}\n${BODY}`,
    'a hash that is not hex': `# ${STAMP_TOKEN} ${INSTANCE} ${KIND} ${'z'.repeat(64)}\n${BODY}`,
    'an uppercase hash': `# ${STAMP_TOKEN} ${INSTANCE} ${KIND} ${bodyHash(BODY).toUpperCase()}\n${BODY}`,
    'an instance name that cannot exist': `# ${STAMP_TOKEN} Museu_MIB ${KIND} ${bodyHash(BODY)}\n${BODY}`,
    'a kind that cannot exist': `# ${STAMP_TOKEN} ${INSTANCE} Unit! ${bodyHash(BODY)}\n${BODY}`,
    'the stamp on the second line': `# header\n# ${STAMP_TOKEN} ${INSTANCE} ${KIND} ${bodyHash(BODY)}\n`,
    'a prefix that is a directive': `listen 80; ${STAMP_TOKEN} ${INSTANCE} ${KIND} ${bodyHash(BODY)}\n`,
    'one space': ' ',
  };

  for (const [what, text] of Object.entries(notOurs)) {
    test(`returns null for ${what}`, () => {
      expect(parseStamp(text)).toBeNull();
      // And the drift answer for all of them is the safe one.
      expect(hasDrifted(text)).toBe(true);
    });
  }
});
