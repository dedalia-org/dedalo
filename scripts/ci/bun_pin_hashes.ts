/**
 * THE BUN HASH TABLE, FROM A SIGNATURE (spec provision init §1.3, owner decision Q3).
 *
 * `.bun-sha256` (repo root) is what the publication host's trampoline
 * (publication/host_agent/deploy/install.sh) and `provision init`
 * (publication/host_agent/src/provision/init/bun_asset.ts) verify a downloaded Bun against
 * before it ever runs as root. This script is the ONLY writer of that table, and it writes it only from
 * the SIGNED PAYLOAD of Bun's clearsigned `SHASUMS256.txt.asc`, after that signature verified
 * against the pinned release-key fingerprint below.
 *
 *   bun scripts/ci/bun_pin_hashes.ts            # after bumping .bun-version (network, gpg + gpgv)
 *   bun scripts/ci/bun_pin_hashes.ts --verify   # offline: re-verify the committed pair
 *
 * HOW IT VERIFIES (each rule a refusal, not a warning):
 *   1. the `.asc` is a clearsigned document with NOTHING outside its armour (ascShapeProblem) —
 *      text after the signature is unsigned, and a file carrying any is refused outright;
 *   2. the key `ci/bun/release_key.asc` holds exactly ONE primary key whose v4 fingerprint,
 *      computed HERE in TS from the dearmored packet, equals BUN_RELEASE_KEY_FINGERPRINT
 *      (and, on the bump, `gpg --show-keys` agrees: exactly one `pub`, the `fpr` right after it);
 *   3. the key is dearmored in TS (CRC-24 checked) into a fresh 0700 `/tmp/dd_bun_pin_<8 hex>`
 *      homedir — short, so no socket path limit, and `gpgv` starts no agent;
 *   4. `gpgv --status-fd 1 --keyring <h>/key.gpg --output <h>/signed.txt <asc>` exits 0 with
 *      exactly one NEWSIG, one GOODSIG, one VALIDSIG whose LAST field (the primary key's
 *      fingerprint) is the constant, and none of BADSIG/ERRSIG/EXPSIG/EXPKEYSIG/KEYEXPIRED/
 *      KEYREVOKED/REVKEYSIG/NO_PUBKEY;
 *   5. the hashes are parsed from `signed.txt` ONLY (gpgv's output of what the signature covers).
 * The bump writes `.bun-sha256` and commits the `.asc` as `ci/bun/SHASUMS256.txt.asc`, the ONLY
 * committed copy (there is no `ci/bun/SHASUMS256.txt`: a second file is a second thing to keep
 * equal). `test/unit/ops_runtime_pin.test.ts` re-runs steps 1-5 in CI with gpgv (no gpg).
 *
 * RESIDUAL: the signed payload names assets without a version; the download URL binds it to
 * the pin here, and the post-verify `bun --version` = pin on the publication host closes it.
 *
 * Exit codes: 0 ok; 1 verification failed; 2 usage, or a needed tool (gpgv / gpg) is missing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BUN_ASSETS } from '../../publication/host_agent/src/provision/exec_contract.ts';

const ROOT = resolve(import.meta.dir, '../..');
export const KEY_PATH = join(ROOT, 'ci/bun/release_key.asc');
export const ASC_PATH = join(ROOT, 'ci/bun/SHASUMS256.txt.asc');
export const TABLE_PATH = join(ROOT, '.bun-sha256');
/**
 * The macOS assets' table — a SECOND file of the SAME signed payload, never a second
 * derivation: the bootstrap (install.sh) verifies a Darwin Bun against it for the
 * docker and trial routes on a Mac with Docker Desktop. A separate file because
 * `.bun-sha256` is held to the publication host's three Linux assets
 * (publication/host_agent/src/provision/init/bun_asset.ts counts its lines).
 */
export const DARWIN_TABLE_PATH = join(ROOT, '.bun-sha256-darwin');
export const DARWIN_ASSETS = Object.freeze([
	'bun-darwin-aarch64',
	'bun-darwin-x64-baseline',
	'bun-darwin-x64',
] as const);
export const PIN_PATH = join(ROOT, '.bun-version');

/**
 * The primary-key fingerprint of Bun's release-signing key ("Robobun <robobun@oven.sh>",
 * ed25519, created 2023-01-25). Source: Bun's own official images verify their download with
 * `gpg --assert-signer F3DCC08A8572C0749B3E18888EAB4D40A7B22B59` and embed the public key
 * verbatim — https://github.com/oven-sh/bun/blob/c7b06d94bac19817ba34b6677bb1099fb4f6d2be/dockerhub/debian-slim/Dockerfile
 * (retrieved 2026-10-08; `ci/bun/release_key.asc` is that block, byte for byte). Cross-checked
 * the same day against https://keys.openpgp.org/vks/v1/by-fingerprint/F3DCC08A8572C0749B3E18888EAB4D40A7B22B59
 * (same key material, same fingerprint). A key rotation is a deliberate edit of this constant
 * AND the key file, with the new source recorded here.
 */
export const BUN_RELEASE_KEY_FINGERPRINT = 'F3DCC08A8572C0749B3E18888EAB4D40A7B22B59';

/**
 * The Linux kernel floor held WITH the pin (spec S8): the census
 * (test/unit/ops_runtime_pin.test.ts) requires `pin` = `.bun-version` and `floor` =
 * layout.ts BUN_KERNEL_FLOOR, so a bump that does not re-read Bun's requirement is red.
 *
 * `documented` is what Bun's page says, read 2026-10-08 (bun-v1.4.2 current), re-read 2026-10-14 for bun-v1.4.3: unchanged,
 * https://bun.com/docs/installation: "We recommend kernel version 5.6 or higher. Bun runs on
 * kernels as old as 3.10 (RHEL 7) with graceful degradation of newer syscalls."
 * (!) `floor` = 5.1 is the spec's reading of Bun's EARLIER wording ("5.1 or later"), which the
 * page no longer states. It is kept in lockstep with layout.ts, not silently changed: whether
 * the floor becomes 3.10 (making the EL 8 4.18 kernel exemption moot) or stays a stricter
 * project floor is an owner decision recorded next to BUN_KERNEL_FLOOR.
 */
export interface KernelFloorRecord {
	readonly pin: string;
	readonly floor: string;
	readonly documented: { readonly minimum: string; readonly recommended: string };
}
export const BUN_PIN_KERNEL_FLOOR: KernelFloorRecord = Object.freeze({
	pin: '1.4.3',
	floor: '5.1',
	documented: Object.freeze({ minimum: '3.10', recommended: '5.6' }),
});

export const RELEASE_BASE = 'https://github.com/oven-sh/bun/releases/download';

export const GPGV_MISSING = 'gpgv is needed on the machine that bumps the Bun pin';

const FORBIDDEN_STATUS = Object.freeze([
	'BADSIG',
	'ERRSIG',
	'EXPSIG',
	'EXPKEYSIG',
	'KEYEXPIRED',
	'KEYREVOKED',
	'REVKEYSIG',
	'NO_PUBKEY',
]);

export class PinVerifyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PinVerifyError';
	}
}

/* ── armour ─────────────────────────────────────────────────────────────────────── */

/** RFC 4880 §6.1 CRC-24. */
export function crc24(bytes: Uint8Array): number {
	let crc = 0xb704ce;
	for (const byte of bytes) {
		crc ^= byte << 16;
		for (let bit = 0; bit < 8; bit += 1) {
			crc <<= 1;
			if (crc & 0x1000000) crc ^= 0x1864cfb;
		}
	}
	return crc & 0xffffff;
}

/** An ASCII-armoured PUBLIC KEY BLOCK → its binary packets. The CRC line must be present and right. */
export function dearmorPublicKey(text: string): Uint8Array {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const begin = lines.indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----');
	const end = lines.indexOf('-----END PGP PUBLIC KEY BLOCK-----');
	if (begin < 0 || end < begin)
		throw new PinVerifyError('release key: not one ASCII-armoured public key block');
	if (
		lines.slice(0, begin).some((l) => l.trim() !== '') ||
		lines.slice(end + 1).some((l) => l.trim() !== '')
	) {
		throw new PinVerifyError('release key: text outside the armour');
	}
	let index = begin + 1;
	while (index < end && lines[index] !== '') {
		if (!/^[A-Za-z]+: /.test(lines[index] ?? ''))
			throw new PinVerifyError('release key: malformed armour header');
		index += 1;
	}
	if (index >= end) throw new PinVerifyError('release key: the armour has no body');
	const body: string[] = [];
	let crcLine: string | null = null;
	for (index += 1; index < end; index += 1) {
		const line = lines[index] ?? '';
		if (line.startsWith('=')) {
			crcLine = line;
			if (index !== end - 1) throw new PinVerifyError('release key: text after the CRC line');
			break;
		}
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(line))
			throw new PinVerifyError('release key: a body line is not base64');
		body.push(line);
	}
	if (crcLine === null || !/^=[A-Za-z0-9+/]{4}$/.test(crcLine))
		throw new PinVerifyError('release key: the CRC-24 line is missing');
	const bytes = new Uint8Array(Buffer.from(body.join(''), 'base64'));
	const want = Buffer.from(crcLine.slice(1), 'base64');
	const crc = ((want[0] ?? 0) << 16) | ((want[1] ?? 0) << 8) | (want[2] ?? 0);
	if (crc24(bytes) !== crc)
		throw new PinVerifyError('release key: CRC-24 mismatch (the armour was altered)');
	return bytes;
}

interface Packet {
	readonly tag: number;
	readonly body: Uint8Array;
}

/** OpenPGP packet framing (old and new format, definite lengths only — a key block has no partials). */
export function parsePackets(bytes: Uint8Array): Packet[] {
	const packets: Packet[] = [];
	let at = 0;
	while (at < bytes.length) {
		const header = bytes[at] ?? 0;
		if ((header & 0x80) === 0)
			throw new PinVerifyError('release key: not an OpenPGP packet stream');
		let tag: number;
		let length: number;
		at += 1;
		if (header & 0x40) {
			tag = header & 0x3f;
			const first = bytes[at] ?? 0;
			if (first < 192) {
				length = first;
				at += 1;
			} else if (first < 224) {
				length = ((first - 192) << 8) + (bytes[at + 1] ?? 0) + 192;
				at += 2;
			} else if (first === 255) {
				length = new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4).getUint32(0);
				at += 5;
			} else {
				throw new PinVerifyError('release key: partial-length packet in a key block');
			}
		} else {
			tag = (header >> 2) & 0x0f;
			const kind = header & 0x03;
			if (kind === 3)
				throw new PinVerifyError('release key: indeterminate-length packet in a key block');
			const size = 1 << kind;
			length = 0;
			for (let i = 0; i < size; i += 1) length = length * 256 + (bytes[at + i] ?? 0);
			at += size;
		}
		if (at + length > bytes.length) throw new PinVerifyError('release key: truncated packet');
		packets.push({ tag, body: bytes.subarray(at, at + length) });
		at += length;
	}
	return packets;
}

/** The ONE primary key's v4 fingerprint (RFC 4880 §12.2: SHA-1 of 0x99 ‖ len16 ‖ body). */
export function primaryFingerprint(keyBytes: Uint8Array): string {
	const primaries = parsePackets(keyBytes).filter((p) => p.tag === 6);
	if (primaries.length !== 1)
		throw new PinVerifyError(
			`release key: ${primaries.length} primary keys (exactly one required)`,
		);
	const body = (primaries[0] as Packet).body;
	if (body[0] !== 4) throw new PinVerifyError(`release key: version ${body[0]} key (v4 expected)`);
	const prefix = new Uint8Array([0x99, (body.length >> 8) & 0xff, body.length & 0xff]);
	return createHash('sha1').update(prefix).update(body).digest('hex').toUpperCase();
}

/** `gpg --with-colons --show-keys`: exactly one `pub`, and the `fpr` directly after it. */
export function showKeysProblem(colons: string, fingerprint: string): string | null {
	const lines = colons.split('\n').filter((l) => l !== '');
	const pubs = lines.flatMap((l, i) => (l.startsWith('pub:') ? [i] : []));
	if (pubs.length !== 1)
		return `gpg --show-keys lists ${pubs.length} pub records (exactly one required)`;
	const fpr = lines[(pubs[0] as number) + 1] ?? '';
	if (!fpr.startsWith('fpr:')) return 'gpg --show-keys: no fpr record directly after pub';
	const value = fpr.split(':')[9] ?? '';
	if (value !== fingerprint)
		return `gpg --show-keys: the primary key is ${value}, the pin is ${fingerprint}`;
	return null;
}

/* ── the signed document ────────────────────────────────────────────────────────── */

/** The committed `.asc` is exactly one clearsigned document: nothing before, nothing after. */
export function ascShapeProblem(text: string): string | null {
	if (!text.startsWith('-----BEGIN PGP SIGNED MESSAGE-----\n'))
		return 'the .asc does not start with a clearsigned-message armour line';
	const endLine = '-----END PGP SIGNATURE-----';
	const at = text.indexOf(endLine);
	if (at < 0) return 'the .asc has no signature end line';
	if (text.indexOf(endLine, at + 1) >= 0) return 'the .asc holds more than one signature block';
	const tail = text.slice(at + endLine.length);
	if (tail !== '\n' && tail !== '')
		return 'the .asc carries text after its signature (unsigned lines are refused)';
	if (text.split('-----BEGIN PGP SIGNED MESSAGE-----').length !== 2)
		return 'the .asc holds more than one signed message';
	return null;
}

/** gpgv's `--status-fd` text against the rules of §1.3 step 3. null = good. */
export function statusProblem(status: string, fingerprint: string): string | null {
	const records = status
		.split('\n')
		.filter((l) => l.startsWith('[GNUPG:] '))
		.map((l) => l.slice('[GNUPG:] '.length).split(' '));
	const count = (token: string): number => records.filter((r) => r[0] === token).length;
	for (const token of FORBIDDEN_STATUS) if (count(token) > 0) return `gpgv reported ${token}`;
	for (const token of ['NEWSIG', 'GOODSIG', 'VALIDSIG']) {
		const n = count(token);
		if (n !== 1) return `gpgv reported ${n} ${token} (exactly one required)`;
	}
	const valid = records.find((r) => r[0] === 'VALIDSIG') as string[];
	const primary = valid[valid.length - 1] ?? '';
	if (primary !== fingerprint)
		return `the signature's primary key is ${primary}, the pin is ${fingerprint}`;
	return null;
}

export interface VerifyTools {
	/** Absolute path of gpgv. */
	readonly gpgv: string;
}

/**
 * gpgv's private home: created ATOMICALLY with an unpredictable name and mode 0700
 * (mkdtemp). Under `/tmp`, not `$TMPDIR`: gpg's agent socket path must stay short.
 */
function scratchHome(): string {
	return mkdtempSync(join('/tmp', 'dd_bun_pin_'));
}

/**
 * Steps 1-5: the signed payload of `ascText`, verified. Throws PinVerifyError naming the rule
 * that failed. The key's fingerprint is computed in TS; gpgv gets the TS-dearmored keyring.
 */
export function verifiedPayload(
	ascText: string,
	keyText: string,
	tools: VerifyTools,
	fingerprint = BUN_RELEASE_KEY_FINGERPRINT,
): string {
	const shape = ascShapeProblem(ascText);
	if (shape !== null) throw new PinVerifyError(shape);
	const keyBytes = dearmorPublicKey(keyText);
	const keyFpr = primaryFingerprint(keyBytes);
	if (keyFpr !== fingerprint)
		throw new PinVerifyError(
			`release key: the primary key is ${keyFpr}, the pin is ${fingerprint}`,
		);
	const home = scratchHome();
	try {
		writeFileSync(join(home, 'key.gpg'), keyBytes, { mode: 0o600 });
		writeFileSync(join(home, 'SHASUMS256.txt.asc'), ascText, { mode: 0o600 });
		const run = spawnSync(
			tools.gpgv,
			[
				'--homedir',
				home,
				'--status-fd',
				'1',
				'--keyring',
				join(home, 'key.gpg'),
				'--output',
				join(home, 'signed.txt'),
				join(home, 'SHASUMS256.txt.asc'),
			],
			{
				encoding: 'utf8',
				env: { LC_ALL: 'C' },
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 30_000,
			},
		);
		if (run.error) throw new PinVerifyError(`gpgv could not run: ${run.error.message}`);
		const problem = statusProblem(run.stdout ?? '', fingerprint);
		if (problem !== null) throw new PinVerifyError(problem);
		if (run.status !== 0) throw new PinVerifyError(`gpgv exited ${run.status}`);
		return readFileSync(join(home, 'signed.txt'), 'utf8');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

/** The three `<sha>  <asset>.zip` lines of the signed payload, in BUN_ASSETS order (each exactly once). */
export function payloadAssetLines(
	payload: string,
	assets: readonly string[] = BUN_ASSETS,
): string[] {
	const lines = payload.split('\n');
	return assets.map((asset) => {
		const named = lines.filter(
			(l) => l.endsWith(`  ${asset}.zip`) && /^[0-9a-f]{64} {2}\S+$/.test(l),
		);
		if (named.length !== 1)
			throw new PinVerifyError(`the signed payload names ${asset}.zip ${named.length} times`);
		return named[0] as string;
	});
}

export function renderShaTable(
	pin: string,
	fingerprint: string,
	assetLines: readonly string[],
): string {
	return `# bun-v${pin}\n# signed-by: ${fingerprint}\n${assetLines.join('\n')}\n`;
}

/** `.bun-sha256`'s asset lines (lines 3..). */
export function tableAssetLines(table: string): string[] {
	return table.replace(/\n$/, '').split('\n').slice(2);
}

/* ── the CLI ─────────────────────────────────────────────────────────────────────── */

function readPin(): string {
	const pin = readFileSync(PIN_PATH, 'utf8').trim();
	if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pin))
		throw new PinVerifyError(`.bun-version '${pin}' is not a concrete semver`);
	return pin;
}

async function download(url: string): Promise<string> {
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.url.startsWith('https://'))
		throw new PinVerifyError(`the download left https (${response.url})`);
	if (!response.ok) throw new PinVerifyError(`GET ${url}: HTTP ${response.status}`);
	return await response.text();
}

function gpgShowKeys(gpg: string, keyPath: string): string {
	const home = scratchHome();
	try {
		const run = spawnSync(
			gpg,
			['--batch', '--no-autostart', '--homedir', home, '--with-colons', '--show-keys', keyPath],
			{
				encoding: 'utf8',
				env: { LC_ALL: 'C' },
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 30_000,
			},
		);
		if (run.error || run.status !== 0)
			throw new PinVerifyError(`gpg --show-keys failed: ${run.error?.message ?? run.stderr}`);
		return run.stdout;
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

export async function main(argv: readonly string[]): Promise<number> {
	const verifyOnly = argv.includes('--verify');
	if (argv.some((a) => a !== '--verify')) {
		console.error('usage: bun scripts/ci/bun_pin_hashes.ts [--verify]');
		return 2;
	}
	const gpgv = Bun.which('gpgv');
	if (gpgv === null) {
		console.error(GPGV_MISSING);
		return 2;
	}
	try {
		const pin = readPin();
		const keyText = readFileSync(KEY_PATH, 'utf8');
		if (BUN_PIN_KERNEL_FLOOR.pin !== pin) {
			throw new PinVerifyError(
				`BUN_PIN_KERNEL_FLOOR is for ${BUN_PIN_KERNEL_FLOOR.pin}: re-read Bun's kernel requirement for ${pin} and update it (and layout.ts BUN_KERNEL_FLOOR)`,
			);
		}
		if (verifyOnly) {
			const payload = verifiedPayload(readFileSync(ASC_PATH, 'utf8'), keyText, { gpgv });
			const want = renderShaTable(pin, BUN_RELEASE_KEY_FINGERPRINT, payloadAssetLines(payload));
			if (readFileSync(TABLE_PATH, 'utf8') !== want)
				throw new PinVerifyError(
					'.bun-sha256 does not equal the signed payload of ci/bun/SHASUMS256.txt.asc',
				);
			const darwin = renderShaTable(
				pin,
				BUN_RELEASE_KEY_FINGERPRINT,
				payloadAssetLines(payload, DARWIN_ASSETS),
			);
			if (readFileSync(DARWIN_TABLE_PATH, 'utf8') !== darwin)
				throw new PinVerifyError(
					'.bun-sha256-darwin does not equal the signed payload of ci/bun/SHASUMS256.txt.asc',
				);
			console.log(
				`ok: .bun-sha256 and .bun-sha256-darwin = the signed payload for bun-v${pin} (key ${BUN_RELEASE_KEY_FINGERPRINT})`,
			);
			return 0;
		}
		const gpg = Bun.which('gpg');
		if (gpg === null) {
			console.error('gpg is needed on the machine that bumps the Bun pin (--show-keys)');
			return 2;
		}
		const shown = showKeysProblem(gpgShowKeys(gpg, KEY_PATH), BUN_RELEASE_KEY_FINGERPRINT);
		if (shown !== null) throw new PinVerifyError(shown);
		const ascText = await download(`${RELEASE_BASE}/bun-v${pin}/SHASUMS256.txt.asc`);
		const payload = verifiedPayload(ascText, keyText, { gpgv });
		const table = renderShaTable(pin, BUN_RELEASE_KEY_FINGERPRINT, payloadAssetLines(payload));
		const darwin = renderShaTable(
			pin,
			BUN_RELEASE_KEY_FINGERPRINT,
			payloadAssetLines(payload, DARWIN_ASSETS),
		);
		writeFileSync(ASC_PATH, ascText);
		writeFileSync(TABLE_PATH, table);
		writeFileSync(DARWIN_TABLE_PATH, darwin);
		console.log(
			`wrote .bun-sha256, .bun-sha256-darwin and ci/bun/SHASUMS256.txt.asc for bun-v${pin}; commit all three`,
		);
		return 0;
	} catch (error) {
		if (error instanceof PinVerifyError) {
			console.error(`bun_pin_hashes: ${error.message}`);
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
