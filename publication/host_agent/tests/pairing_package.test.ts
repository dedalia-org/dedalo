/**
 * src/provision/pairing_package.ts — the sealed pairing package's format, end to end: the round
 * trip, every refusal the reader makes BEFORE the KDF (magic, version, parameters, size), the
 * authenticated body AND header (GCM with the header as additional data), the exact plaintext key
 * set, and the passphrase grammar.
 */
import { describe, expect, test } from 'bun:test';
import { createCipheriv, scryptSync } from 'node:crypto';
import {
  HEADER_BYTES,
  MAX_PACKAGE_BYTES,
  newPassphrase,
  normalizePassphrase,
  openPairingPackage,
  openPairingPackageAsync,
  PACKAGE_MAGIC,
  PairingPackageRefused,
  PASSPHRASE_ALPHABET,
  packageHeaderProblem,
  PLAINTEXT_FORMAT,
  sealPairingPackage,
  SCRYPT_MAXMEM,
  TAG_BYTES,
} from '../src/provision/pairing_package';

const PARTS = Object.freeze({
  fragment: 'DEDALO_PUBLICATION_HOST_INSTANCE=museum\nDEDALO_PUBLICATION_HOST_URL=https://pub.example:8443/publication/host_agent\n',
  token: 'T'.repeat(48),
  bundle: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
});

const PASS = newPassphrase();
const SEALED = sealPairingPackage(PARTS, PASS);

function reason(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PairingPackageRefused) return error.reason;
    throw error;
  }
  return 'accepted';
}

function flip(bytes: Uint8Array, at: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[at] = (copy[at] as number) ^ 0x01;
  return copy;
}

/** A package sealed with ANY plaintext (the writer refuses bad parts, so a hostile one is built by hand). */
function sealRaw(plaintext: string, passphrase: string): Uint8Array {
  const head = Uint8Array.from(SEALED.subarray(0, HEADER_BYTES));
  const salt = head.subarray(PACKAGE_MAGIC.length + 5, PACKAGE_MAGIC.length + 21);
  const nonce = head.subarray(PACKAGE_MAGIC.length + 21, HEADER_BYTES);
  const key = scryptSync(normalizePassphrase(passphrase) as string, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: SCRYPT_MAXMEM });
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(head);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return Uint8Array.from(Buffer.concat([head, body, cipher.getAuthTag()]));
}

describe('the sealed pairing package', () => {
  test('openPairingPackageAsync: the same parts and the SAME refusals as the sync reader (KDF off the event loop)', async () => {
    expect(await openPairingPackageAsync(SEALED, PASS)).toEqual(openPairingPackage(SEALED, PASS));
    const refusal = async (bytes: Uint8Array, pass: string): Promise<string> => {
      try {
        await openPairingPackageAsync(bytes, pass);
      } catch (error) {
        if (error instanceof PairingPackageRefused) return error.reason;
        throw error;
      }
      return 'opened';
    };
    expect(await refusal(SEALED, newPassphrase())).toBe('auth');
    const tampered = new Uint8Array(SEALED);
    tampered[HEADER_BYTES + 1] ^= 1;
    expect(await refusal(tampered, PASS)).toBe('auth');
    expect(await refusal(SEALED, 'short')).toBe('passphrase_shape');
    expect(await refusal(SEALED.subarray(0, 4), PASS)).toBe('truncated');
  });

  test('round trip: the three parts come back, the passphrase in any spacing/case', () => {
    expect(openPairingPackage(SEALED, PASS)).toEqual(PARTS);
    expect(openPairingPackage(SEALED, ` ${PASS.toLowerCase().replace(/-/g, ' ')} `)).toEqual(PARTS);
    const text = Buffer.from(SEALED).toString('latin1');
    for (const secret of [PARTS.token, 'BEGIN CERTIFICATE', 'DEDALO_PUBLICATION_HOST']) expect(text).not.toContain(secret);
  });

  test('two seals of the same parts differ (fresh salt and nonce every time)', () => {
    const again = sealPairingPackage(PARTS, PASS);
    expect(Buffer.from(again.subarray(PACKAGE_MAGIC.length + 5, HEADER_BYTES)).equals(Buffer.from(SEALED.subarray(PACKAGE_MAGIC.length + 5, HEADER_BYTES)))).toBe(false);
  });

  test('a wrong passphrase is `auth`', () => {
    let other = newPassphrase();
    while (other === PASS) other = newPassphrase();
    expect(reason(() => openPairingPackage(SEALED, other))).toBe('auth');
  });

  test('a changed ciphertext byte, tag byte or header salt/nonce byte is `auth` (the header is the AAD)', () => {
    expect(reason(() => openPairingPackage(flip(SEALED, HEADER_BYTES + 3), PASS))).toBe('auth');
    expect(reason(() => openPairingPackage(flip(SEALED, SEALED.length - 1), PASS))).toBe('auth');
    expect(reason(() => openPairingPackage(flip(SEALED, HEADER_BYTES - 1), PASS))).toBe('auth'); // nonce
    expect(reason(() => openPairingPackage(flip(SEALED, PACKAGE_MAGIC.length + 6), PASS))).toBe('auth'); // salt
  });

  test('the header is refused before the KDF: magic, version, every parameter, size', () => {
    expect(packageHeaderProblem(SEALED)).toBeNull();
    expect(reason(() => openPairingPackage(flip(SEALED, 0), PASS))).toBe('bad_magic');
    expect(reason(() => openPairingPackage(flip(SEALED, 8), PASS))).toBe('version');
    for (const at of [9, 10, 11, 12]) expect(reason(() => openPairingPackage(flip(SEALED, at), PASS))).toBe('params');
    // a huge N named by the file never reaches scrypt
    const greedy = Uint8Array.from(SEALED);
    greedy[10] = 30;
    expect(packageHeaderProblem(greedy)).toBe('params');
    expect(reason(() => openPairingPackage(SEALED.subarray(0, HEADER_BYTES + TAG_BYTES - 1), PASS))).toBe('truncated');
    expect(reason(() => openPairingPackage(SEALED.subarray(0, 4), PASS))).toBe('truncated');
    expect(reason(() => openPairingPackage(new Uint8Array(MAX_PACKAGE_BYTES + 1), PASS))).toBe('too_large');
  });

  // ~16 REAL scrypt derivations (8 seals + 8 opens at the production cost — the
  // cost is the property under test, never lowered): ~2.5 s on a desk, 5.4 s on a
  // GitLab shared runner (2026-10-11), past bun's 5 s default. The bound is explicit.
  test('the plaintext must hold EXACTLY format, version, fragment, token, bundle', () => {
    const base = { format: PLAINTEXT_FORMAT, version: 1, ...PARTS };
    expect(openPairingPackage(sealRaw(JSON.stringify(base), PASS), PASS)).toEqual(PARTS);
    expect(reason(() => openPairingPackage(sealRaw(JSON.stringify({ ...base, extra: 'x' }), PASS), PASS))).toBe('parts');
    const { bundle: _drop, ...missing } = base;
    expect(reason(() => openPairingPackage(sealRaw(JSON.stringify(missing), PASS), PASS))).toBe('parts');
    expect(reason(() => openPairingPackage(sealRaw(JSON.stringify({ ...base, token: 7 }), PASS), PASS))).toBe('parts');
    expect(reason(() => openPairingPackage(sealRaw(JSON.stringify({ ...base, format: 'other' }), PASS), PASS))).toBe('parts');
    expect(reason(() => openPairingPackage(sealRaw(JSON.stringify({ ...base, version: 2 }), PASS), PASS))).toBe('parts');
    expect(reason(() => openPairingPackage(sealRaw('[1,2]', PASS), PASS))).toBe('parts');
    expect(reason(() => openPairingPackage(sealRaw('not json', PASS), PASS))).toBe('parts');
    expect(reason(() => sealPairingPackage({ ...PARTS, token: '' }, PASS))).toBe('parts');
  }, 30_000);

  test('the passphrase: 24 characters of the alphabet, grouped by four; any other shape refused before the KDF', () => {
    expect(PASSPHRASE_ALPHABET).toHaveLength(32);
    expect(new Set(PASSPHRASE_ALPHABET).size).toBe(32);
    expect(PASS).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
    for (const char of PASS.replace(/-/g, '')) expect(PASSPHRASE_ALPHABET).toContain(char);
    expect(normalizePassphrase('0000-0000-0000-0000-0000-000')).toBeNull();
    expect(normalizePassphrase('0000-0000-0000-0000-0000-0000U')).toBeNull();
    expect(normalizePassphrase('oooo iiii llll 0000 1111 2222')).toBe('000011111111000011112222');
    expect(reason(() => openPairingPackage(SEALED, 'hunter2'))).toBe('passphrase_shape');
    expect(reason(() => sealPairingPackage(PARTS, 'hunter2'))).toBe('passphrase_shape');
    // uniform: every alphabet character is reachable from a random byte
    const seen = new Set(newPassphrase(n => Uint8Array.from({ length: n }, (_, i) => i * 7)).replace(/-/g, ''));
    expect(seen.size).toBeGreaterThan(16);
  });
});
