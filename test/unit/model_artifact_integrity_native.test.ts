/**
 * A DOWNLOADED MODEL ARTIFACT IS PINNED AND VERIFIED (P1-25 / CARRY-06 / ROUTE-01).
 *
 * A model artifact writes the transcript of an oral-history recording straight
 * into the catalogue. Until 2026-09-04 it was fetched from the hub's MUTABLE
 * `main` head, the only post-condition was byte LENGTH, and the in-code reason
 * ("the hub ships no per-file hash") was measurably false. This gate drives the
 * REAL downloader, the REAL serving door and the REAL verification helpers
 * against a LOOPBACK fixture hub — never the network — and asserts:
 *
 *   (a) bytes that do not hash to the pin are REFUSED: nothing recorded, the
 *       target absent, the evidence quarantined under `<store>/.quarantine`;
 *   (b) bytes that do are accepted, recorded with size + sha256 + revision, and
 *       were fetched at `/resolve/<revision>/` — never `/resolve/main/`;
 *   (c) a model with NO pin is refused before the hub receives a request;
 *   (d) a stored file tampered AFTER download (a byte flipped, size kept) is
 *       refused at the serving door, quarantined, and the verdict cache does
 *       not mask it; a file under a CATALOG id whose bytes disagree with the
 *       REPO pin is refused even with no manifest at all; the digest is looked
 *       up by the REQUESTED name and the bytes judged are what that name
 *       RESOLVES to, so a SYMLINK planted under a pinned name (a file, or the
 *       whole model directory) pointing at an unpinned store file is refused
 *       and the link quarantined — and a link at the right bytes still serves;
 *   (e) nothing under `.quarantine` is servable, whatever its extension;
 *   (f) a pre-existing UNHASHED file (a store seeded before pins) is hashed
 *       against the pin: accepted and recorded when it matches, refused when
 *       it does not — no hub request either way;
 *   (g) the REPO pin file covers every catalog model (derived from
 *       tools/tool_transcription/register.json, floored) with a 40-hex revision,
 *       a date, a reason and a well-formed pin for every required file; the
 *       `unpinned` block is reasoned and SHRINK-ONLY;
 *   (h) the geoip database gets a rest-integrity sidecar at download, and a
 *       mismatch at boot is quarantined and reported absent;
 *   (i) the pin PROCEDURE itself (scripts/pin_ai_models.ts) derives the digests
 *       from the hub's tree API and cross-checks sizes, and reads the licence
 *       record from the card;
 *   (j) the TRANSLATION catalogue (tools/tool_lang/register.json,
 *       browser_transformer.models — 2026-11-22) is first-class: every
 *       translator is pinned, the one-model-per-pair template carries a
 *       reproducible expansion record whose ids ARE the catalogue, a
 *       decoder-only translator's external-data chunks are pinned with its
 *       weights, and EVERY pin carries a valid licence record (a pin without
 *       one is red);
 *   (k) the engine's per-kind file set (modelFilesForConfig) EQUALS what the
 *       VENDORED transformers.js runtime names for the same config + dtype,
 *       for every translator shape — external-data chunks included;
 *   (l) the store serves and evidences external-data chunks past the first
 *       (`…onnx_data_1`): servable, and a missing chunk is `incomplete`.
 *
 * HERMETIC: mkdtemp store, Bun.serve on port 0, no database — (j) reads the
 * repo's committed pin file, (k) runs the vendored runtime offline (the config
 * is passed in, nothing is fetched).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	allFetchTargets,
	commonFilesFor,
	expandTemplate,
	filesFor,
	notOfferedMark,
	readRegisterCatalog,
	readTranslationCatalog,
	readTranslationTemplates,
} from '../../scripts/lib/ai_model_register.ts';
import { checkTable, pinModel, runtimeModelFiles } from '../../scripts/pin_ai_models.ts';
import { downloadModel, HUB_BASE } from '../../src/core/ai/model_fetch.ts';
import { QUARANTINE_DIR, SHA256_HEX, verifiedDigest } from '../../src/core/ai/model_integrity.ts';
import {
	MANIFEST_FILE,
	readManifest,
	recordFileComplete,
} from '../../src/core/ai/model_manifest.ts';
import {
	licenceProblems,
	type PinTable,
	pinnedRevision,
	REVISION_HEX,
	readPinTable,
} from '../../src/core/ai/model_pins.ts';
import {
	AI_MODEL_URL_PREFIX,
	knownDigestFor,
	type ModelKind,
	modelFilesForConfig,
	modelState,
	resolveModelPath,
	serveModelRequest,
} from '../../src/core/ai/model_store.ts';
import {
	DB_BASENAME,
	downloadCountryDb,
	sidecarPath,
	verifyCountryDb,
} from '../../src/core/geoip/download.ts';
import { verifiedCacheState } from '../../src/core/geoip/ensure.ts';

const sha256 = (bytes: string | Uint8Array): string =>
	createHash('sha256').update(bytes).digest('hex');

/** The fixture model: diarization-shaped (three files), never a real hub id. */
const MODEL = 'fixture-org/segmentation-FIXTURE';
const REVISION = '0123456789abcdef0123456789abcdef01234567';
const FILES: Record<string, string> = {
	'preprocessor_config.json': '{"feature_size":1}',
	'config.json': '{"model_type":"pyannote"}',
	// 0x08 first byte: what an ONNX ModelProto starts with (headerPlausible).
	'onnx/model.onnx': `FIXTURE-ONNX-BYTES-${'x'.repeat(64)}`,
};
const DIARIZATION = {
	commonFiles: ['preprocessor_config.json'],
	optionalFiles: [] as string[],
	kind: 'diarization' as const,
	dtype: { model: 'fp32' },
};

function pinsWith(files: Record<string, { sha256: string; size: number }>): PinTable {
	return {
		models: {
			[MODEL]: { revision: REVISION, pinned_at: '2026-09-04', reason: 'gate fixture', files },
		},
		unpinned: {},
	};
}

/** The truthful pins for FILES. */
function truePins(): PinTable {
	return pinsWith(
		Object.fromEntries(
			Object.entries(FILES).map(([file, bytes]) => [
				file,
				{ sha256: sha256(bytes), size: Buffer.byteLength(bytes) },
			]),
		),
	);
}

/** The LOOPBACK HUB: serves FILES at `/<model>/resolve/<rev>/<file>` and logs every path. */
let hub: ReturnType<typeof Bun.serve>;
let hubBase = '';
const hubSeen: string[] = [];
/** Model API answers for leg (i): revision + recursive tree. */
let treeSizeOverride: number | null = null;

let scratch = '';
let store = '';
let priorStoreEnv: string | undefined;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'dd_model_integrity_'));
	store = join(scratch, 'store');
	mkdirSync(store, { recursive: true });
	priorStoreEnv = process.env.DEDALO_AI_MODEL_STORE;
	process.env.DEDALO_AI_MODEL_STORE = store;

	hub = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(request) {
			const path = new URL(request.url).pathname;
			hubSeen.push(path);
			if (path === `/api/models/${MODEL}/revision/main`) {
				return Response.json({ sha: REVISION, cardData: { license: 'mit' } });
			}
			if (path === `/api/models/${MODEL}/tree/${REVISION}`) {
				return Response.json(
					Object.entries(FILES).map(([file, bytes]) => {
						const size = treeSizeOverride ?? Buffer.byteLength(bytes);
						return file.endsWith('.onnx')
							? { type: 'file', path: file, size, lfs: { oid: sha256(bytes), size } }
							: { type: 'file', path: file, size };
					}),
				);
			}
			const prefix = `/${MODEL}/resolve/`;
			if (!path.startsWith(prefix)) return new Response('not found', { status: 404 });
			const [revision, ...rest] = path.slice(prefix.length).split('/');
			const file = rest.join('/');
			if (revision !== REVISION || FILES[file] === undefined) {
				return new Response('not found', { status: 404 });
			}
			return new Response(FILES[file], { headers: { 'Content-Type': 'application/octet-stream' } });
		},
	});
	hubBase = `http://127.0.0.1:${hub.port}`;
});

afterAll(() => {
	hub?.stop(true);
	if (priorStoreEnv === undefined) delete process.env.DEDALO_AI_MODEL_STORE;
	else process.env.DEDALO_AI_MODEL_STORE = priorStoreEnv;
	if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

const requestsSince = (mark: number): string[] => hubSeen.slice(mark);
const quarantined = (root: string): string[] => {
	const dir = join(root, QUARANTINE_DIR);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true }).map(String);
};
const download = (pins: PinTable, storeDir = store) =>
	downloadModel(MODEL, DIARIZATION.dtype, {
		store: storeDir,
		quiet: true,
		pins,
		hubBase,
		kind: DIARIZATION.kind,
		commonFiles: DIARIZATION.commonFiles,
		optionalFiles: DIARIZATION.optionalFiles,
	});

describe('(a) bytes that do not hash to the pin are refused, recorded nowhere, quarantined', () => {
	test('a wrong digest → ok:false, target absent, manifest empty, evidence under .quarantine', async () => {
		const wrongStore = join(scratch, 'store_wrong');
		const pins = truePins();
		// The weights' pin says the bytes must be something else (same size, so
		// the LENGTH post-condition of the old code would have passed).
		pins.models[MODEL]!.files['onnx/model.onnx']!.sha256 = sha256('not the same object');
		const mark = hubSeen.length;
		const report = await download(pins, wrongStore);

		expect(report.ok).toBe(false);
		expect(report.refused.some((why) => /onnx\/model\.onnx/.test(why) && /sha256/.test(why))).toBe(
			true,
		);
		expect(existsSync(join(wrongStore, MODEL, 'onnx/model.onnx'))).toBe(false);
		expect(readManifest(wrongStore, MODEL).files['onnx/model.onnx']).toBeUndefined();
		// The bytes were really fetched (this is a transport-level refusal, not a
		// short-circuit) and the evidence is kept, never deleted.
		expect(requestsSince(mark)).toContain(`/${MODEL}/resolve/${REVISION}/onnx/model.onnx`);
		const evidence = quarantined(wrongStore).filter((name) => name.includes('model.onnx'));
		expect(evidence.length).toBe(1);
		expect(readFileSync(join(wrongStore, QUARANTINE_DIR, evidence[0]!), 'utf8')).toBe(
			FILES['onnx/model.onnx']!,
		);
		// The files whose pins were right are unaffected.
		expect(report.files).toContain('config.json');
	});
});

describe('(b) matching bytes are accepted at the immutable revision', () => {
	test('recorded with size + sha256 + revision; fetched at /resolve/<sha>/, never /resolve/main/', async () => {
		const mark = hubSeen.length;
		const report = await download(truePins());
		expect(report.ok).toBe(true);
		expect(report.refused).toEqual([]);
		expect(report.files.sort()).toEqual(Object.keys(FILES).sort());

		const manifest = readManifest(store, MODEL);
		for (const [file, bytes] of Object.entries(FILES)) {
			expect(manifest.files[file]).toEqual({
				size: Buffer.byteLength(bytes),
				sha256: sha256(bytes),
				revision: REVISION,
			});
		}
		const seen = requestsSince(mark);
		expect(seen.length).toBeGreaterThanOrEqual(Object.keys(FILES).length);
		for (const path of seen) {
			expect(path).toContain(`/resolve/${REVISION}/`);
			expect(path).not.toContain('/resolve/main/');
		}
	});
});

describe('(c) a model with no pin is refused before a byte', () => {
	test('the hub receives NO request, the report names the missing pin', async () => {
		const mark = hubSeen.length;
		const report = await download({ models: {}, unpinned: {} }, join(scratch, 'store_unpinned'));
		expect(report.ok).toBe(false);
		expect(report.refused.length).toBe(1);
		expect(report.refused[0]).toMatch(/no revision pin/);
		expect(requestsSince(mark)).toEqual([]);
		expect(existsSync(join(scratch, 'store_unpinned', MODEL))).toBe(false);
	});

	test('a required file with no digest pin is refused too; an optional one is skipped', async () => {
		const pins = truePins();
		const { 'config.json': _unpinned, ...rest } = pins.models[MODEL]!.files;
		pins.models[MODEL]!.files = rest;
		const mark = hubSeen.length;
		const report = await download(pins, join(scratch, 'store_partial_pin'));
		expect(report.ok).toBe(false);
		expect(report.refused.some((why) => /config\.json: no digest pin/.test(why))).toBe(true);
		expect(requestsSince(mark)).not.toContain(`/${MODEL}/resolve/${REVISION}/config.json`);
	});
});

describe('(d) the serving door re-verifies what it is about to serve', () => {
	const url = (file: string) => `${AI_MODEL_URL_PREFIX}${MODEL}/${file}`;
	const serve = (file: string) =>
		serveModelRequest(url(file), new Request(`http://localhost${url(file)}`), true);

	test('an intact, verified file serves 200 with a PRIVATE immutable cache', async () => {
		const response = await serve('onnx/model.onnx');
		expect(response?.status).toBe(200);
		const cacheControl = response?.headers.get('Cache-Control') ?? '';
		expect(cacheControl).toContain('private');
		expect(cacheControl).toContain('immutable');
		expect(cacheControl).not.toMatch(/\bpublic\b/);
	});

	test('a byte flipped after download (size kept) → 404, file quarantined, cache not fooled', async () => {
		const target = join(store, MODEL, 'onnx/model.onnx');
		// The verdict cache now holds a MATCH for this path (served above).
		expect(await verifiedDigest(target)).toBe(sha256(FILES['onnx/model.onnx']!));
		const tampered = Buffer.from(FILES['onnx/model.onnx']!);
		tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
		await Bun.sleep(5); // a distinct mtime, whatever the filesystem's resolution
		writeFileSync(target, tampered);

		const response = await serve('onnx/model.onnx');
		expect(response?.status).toBe(404);
		expect(existsSync(target)).toBe(false);
		expect(quarantined(store).some((name) => name.includes('model.onnx'))).toBe(true);
		// …and the manifest no longer claims it.
		expect(readManifest(store, MODEL).files['onnx/model.onnx']).toBeUndefined();
	});

	test('a file under a CATALOG id that disagrees with the REPO pin is refused with no manifest', async () => {
		const table = readPinTable();
		const [catalogId, pin] = Object.entries(table.models)[0]!;
		const file = 'config.json';
		expect(pin.files[file]).toBeDefined();
		const target = join(store, catalogId, file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, '{"model_type":"not-the-pinned-bytes"}');
		expect(existsSync(join(store, catalogId, MANIFEST_FILE))).toBe(false);
		expect(knownDigestFor(join(catalogId, file))?.source).toBe('pin');

		const path = `${AI_MODEL_URL_PREFIX}${catalogId}/${file}`;
		const response = await serveModelRequest(path, new Request(`http://localhost${path}`), true);
		expect(response?.status).toBe(404);
		expect(existsSync(target)).toBe(false);
		expect(quarantined(store).some((name) => name.startsWith(catalogId))).toBe(true);
	});

	test('a file the store knows NO digest for is still served (an operator-owned model)', async () => {
		const own = 'fixture-org/operator-own-model';
		const target = join(store, own, 'config.json');
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, '{"model_type":"mine"}');
		expect(knownDigestFor(join(own, 'config.json'))).toBeNull();
		const path = `${AI_MODEL_URL_PREFIX}${own}/config.json`;
		const response = await serveModelRequest(path, new Request(`http://localhost${path}`), true);
		expect(response?.status).toBe(200);
	});

	// A symlink INSIDE the store (rsync -a carries them) under a pinned name: the
	// digest is the one the REQUESTED name is pinned to, the bytes hashed are the
	// link target's. Keying the lookup on the realpath instead let a link to an
	// unpinned store file serve under the pinned name with no check (refuted
	// 2026-09-04).
	test('a symlink under a pinned name → the pin of THAT name judges the target bytes', async () => {
		const file = 'preprocessor_config.json';
		const linkPath = join(store, MODEL, file);
		expect(knownDigestFor(join(MODEL, file))).not.toBeNull();
		rmSync(linkPath);
		// Positive control: a link at the RIGHT bytes (an unpinned copy elsewhere
		// in the store) serves — the lookup is by name, the hash by target.
		const goodCopy = join(store, 'fixture-org/operator-own-model', 'good_copy.json');
		writeFileSync(goodCopy, FILES[file]!);
		symlinkSync(goodCopy, linkPath);
		expect((await serve(file))?.status).toBe(200);
		rmSync(linkPath);

		// The evasion: the same pinned name, a link to POISONED unpinned bytes.
		const poisoned = join(store, 'fixture-org/operator-own-model', 'poisoned.json');
		writeFileSync(poisoned, '{"poisoned":true}');
		symlinkSync(poisoned, linkPath);
		expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
		const before = quarantined(store).length;
		const response = await serve(file);
		expect(response?.status).toBe(404);
		// The LINK is the evidence, quarantined; the operator's own file is untouched.
		expect(existsSync(linkPath)).toBe(false);
		expect(quarantined(store).length).toBe(before + 1);
		expect(quarantined(store).some((name) => name.includes(file))).toBe(true);
		expect(readFileSync(poisoned, 'utf8')).toBe('{"poisoned":true}');
		// …and the manifest no longer claims the name.
		expect(readManifest(store, MODEL).files[file]).toBeUndefined();
	});

	test('a whole model DIRECTORY symlinked under a catalog id: the repo pin judges what it hides', async () => {
		const table = readPinTable();
		const [catalogId, pin] = Object.entries(table.models)[1]!;
		const file = 'config.json';
		expect(pin.files[file]).toBeDefined();
		expect(existsSync(join(store, catalogId))).toBe(false);
		const evil = join(store, 'fixture-org/evil-tree');
		mkdirSync(join(evil, dirname(file)), { recursive: true });
		writeFileSync(join(evil, file), '{"model_type":"four-byte-substitute"}');
		mkdirSync(dirname(join(store, catalogId)), { recursive: true });
		symlinkSync(evil, join(store, catalogId));
		expect(lstatSync(join(store, catalogId)).isSymbolicLink()).toBe(true);

		const path = `${AI_MODEL_URL_PREFIX}${catalogId}/${file}`;
		const response = await serveModelRequest(path, new Request(`http://localhost${path}`), true);
		expect(response?.status).toBe(404);
		expect(quarantined(store).some((name) => name.startsWith(catalogId))).toBe(true);
		// Positive control: the same bytes are served under the evil tree's OWN
		// (unpinned) name — the refusal was the pinned name's, not the bytes'.
		writeFileSync(join(evil, file), '{"model_type":"four-byte-substitute"}');
		const ownPath = `${AI_MODEL_URL_PREFIX}fixture-org/evil-tree/${file}`;
		const own = await serveModelRequest(ownPath, new Request(`http://localhost${ownPath}`), true);
		expect(own?.status).toBe(200);
	});

	// A manifest planted ONE DIRECTORY UP (`<store>/<org>/.dedalo_model.json`
	// claiming `<name>/config.json`) is store-writable — exactly what a
	// compromised rsync controls. Taking the first split with ANY digest let it
	// answer before the repo pin of `<org>/<name>` was consulted (refuted
	// 2026-09-04): the pin must win at every depth.
	test('a parent-level manifest claiming poisoned bytes does NOT shadow the repo pin', async () => {
		const table = readPinTable();
		const [catalogId, pin] = Object.entries(table.models)[0]!;
		const file = 'config.json';
		expect(pin.files[file]).toBeDefined();
		const [org, ...nameParts] = catalogId.split('/');
		const name = nameParts.join('/');
		expect(name).not.toBe('');
		const poisoned = '{"model_type":"POISONED"}';
		const target = join(store, catalogId, file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, poisoned);
		const shadow = join(store, org!, MANIFEST_FILE);
		writeFileSync(
			shadow,
			JSON.stringify({
				files: {
					[`${name}/${file}`]: {
						size: Buffer.byteLength(poisoned),
						sha256: sha256(poisoned),
						revision: 'x',
					},
				},
			}),
		);
		const known = knownDigestFor(join(catalogId, file));
		expect(known?.source).toBe('pin');
		expect(known?.modelId).toBe(catalogId);
		expect(known?.sha256).toBe(pin.files[file]!.sha256);

		const path = `${AI_MODEL_URL_PREFIX}${catalogId}/${file}`;
		const response = await serveModelRequest(path, new Request(`http://localhost${path}`), true);
		expect(response?.status).toBe(404);
		expect(existsSync(target)).toBe(false);
		expect(
			quarantined(store).filter((entry) => entry.startsWith(catalogId)).length,
		).toBeGreaterThan(1);
		rmSync(shadow);
	});

	// The artifact that MATTERS is the nested weight (`onnx/*.onnx`), and its
	// path splits at TWO depths: `<org>/<name>/onnx` + `file` (no pin) before
	// `<org>/<name>` + `onnx/file` (the pin). A pin pass restricted to the
	// deepest split served poisoned catalog weights with every top-level leg
	// green (refuted 2026-09-04, review of P1-25).
	const nestedCatalogPin = (): { catalogId: string; file: string; sha256: string } => {
		for (const [catalogId, pin] of Object.entries(readPinTable().models)) {
			const file = Object.keys(pin.files).find((name) => name.includes('/'));
			if (file !== undefined) return { catalogId, file, sha256: pin.files[file]!.sha256 };
		}
		throw new Error('the pin table pins no nested file — the census below cannot run');
	};

	test("poisoned bytes under a catalog id's NESTED pinned weight are refused by the pin", async () => {
		const { catalogId, file, sha256: pinned } = nestedCatalogPin();
		expect(file.split('/').length).toBeGreaterThan(1);
		const target = join(store, catalogId, file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, 'POISONED-WEIGHTS');
		expect(existsSync(join(store, catalogId, MANIFEST_FILE))).toBe(false);
		const known = knownDigestFor(join(catalogId, ...file.split('/')));
		expect(known?.source).toBe('pin');
		expect(known?.modelId).toBe(catalogId);
		expect(known?.file).toBe(file);
		expect(known?.sha256).toBe(pinned);

		const path = `${AI_MODEL_URL_PREFIX}${catalogId}/${file}`;
		const response = await serveModelRequest(path, new Request(`http://localhost${path}`), true);
		expect(response?.status).toBe(404);
		expect(existsSync(target)).toBe(false);
		expect(quarantined(store).some((name) => name.startsWith(join(catalogId, file)))).toBe(true);
	});

	test('a manifest planted in the nested directory itself cannot shadow the pin of the weight', async () => {
		const { catalogId, file, sha256: pinned } = nestedCatalogPin();
		const dir = dirname(file);
		const leaf = file.slice(dir.length + 1);
		const poisoned = 'POISONED-WEIGHTS-2';
		const target = join(store, catalogId, file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, poisoned);
		// The DEEPEST manifest — the one the manifest pass would honour first.
		const shadow = join(store, catalogId, dir, MANIFEST_FILE);
		writeFileSync(
			shadow,
			JSON.stringify({
				files: {
					[leaf]: { size: Buffer.byteLength(poisoned), sha256: sha256(poisoned), revision: 'x' },
				},
			}),
		);
		const known = knownDigestFor(join(catalogId, ...file.split('/')));
		expect(known?.source).toBe('pin');
		expect(known?.sha256).toBe(pinned);

		const path = `${AI_MODEL_URL_PREFIX}${catalogId}/${file}`;
		const response = await serveModelRequest(path, new Request(`http://localhost${path}`), true);
		expect(response?.status).toBe(404);
		expect(existsSync(target)).toBe(false);
		rmSync(shadow);
	});

	// A case-insensitive filesystem (macOS APFS) resolves `xenova/…/CONFIG.json`
	// to the pinned bytes; keyed on the requested spelling the door served them
	// unverified (review of P1-25, 2026-09-04). The lookup is what is gated —
	// the filesystem's case behaviour is not the suite's to choose.
	test('a differently-CASED request for a pinned name is judged by that pin', async () => {
		const { catalogId, file, sha256: pinned } = nestedCatalogPin();
		const variant = join(catalogId.toUpperCase(), ...file.split('/')).replace(/\.([a-z]+)$/, (m) =>
			m.toUpperCase(),
		);
		expect(variant).not.toBe(join(catalogId, ...file.split('/')));
		const known = knownDigestFor(variant);
		expect(known?.source).toBe('pin');
		expect(known?.modelId).toBe(catalogId);
		expect(known?.file).toBe(file);
		expect(known?.sha256).toBe(pinned);
		// Poisoned bytes reached through the variant are refused, whatever the FS.
		const target = join(store, variant);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, 'POISONED-BY-CASE');
		const path = `${AI_MODEL_URL_PREFIX}${variant}`;
		const response = await serveModelRequest(path, new Request(`http://localhost${path}`), true);
		expect(response?.status).toBe(404);
		expect(existsSync(target)).toBe(false);
	});

	// Positive control for the manifest pass: an UNPINNED model's OWN manifest
	// is honoured, and it is the DEEPEST manifest that speaks for a file — an
	// ancestor's claim about a directory that carries its own manifest is not
	// consulted.
	test('an unpinned model is judged by its OWN manifest; an ancestor manifest cannot speak for it', async () => {
		const own = 'fixture-org/operator-own-model';
		const file = 'config.json';
		const target = join(store, own, file);
		const bytes = readFileSync(target, 'utf8');
		expect(knownDigestFor(join(own, file))).toBeNull();
		recordFileComplete(store, own, file, Buffer.byteLength(bytes), {
			sha256: sha256(bytes),
			revision: 'local',
		});
		const known = knownDigestFor(join(own, file));
		expect(known).toEqual({ modelId: own, file, sha256: sha256(bytes), source: 'manifest' });
		const path = `${AI_MODEL_URL_PREFIX}${own}/${file}`;
		expect(
			(await serveModelRequest(path, new Request(`http://localhost${path}`), true))?.status,
		).toBe(200);

		// An ancestor manifest with a DISAGREEING digest for the same name: ignored.
		const ancestor = join(store, 'fixture-org', MANIFEST_FILE);
		writeFileSync(
			ancestor,
			JSON.stringify({
				files: {
					[`operator-own-model/${file}`]: {
						size: 1,
						sha256: sha256('not these bytes'),
						revision: 'x',
					},
				},
			}),
		);
		expect(knownDigestFor(join(own, file))?.modelId).toBe(own);
		expect(
			(await serveModelRequest(path, new Request(`http://localhost${path}`), true))?.status,
		).toBe(200);
		expect(existsSync(target)).toBe(true);
		rmSync(ancestor);

		// …and the own manifest is a REAL check: rewrite the bytes, refused.
		await Bun.sleep(5);
		writeFileSync(target, '{"model_type":"mine-rewritten"}');
		expect(
			(await serveModelRequest(path, new Request(`http://localhost${path}`), true))?.status,
		).toBe(404);
		expect(existsSync(target)).toBe(false);
		expect(readManifest(store, own).files[file]).toBeUndefined();
		// Later legs use this model as the operator-owned, unpinned tree.
		writeFileSync(target, bytes);
	});
});

describe('(e) nothing under .quarantine is servable', () => {
	test('a servable-extension file planted under .quarantine 404s and does not resolve', async () => {
		const planted = join(store, QUARANTINE_DIR, MODEL, 'config.json');
		mkdirSync(dirname(planted), { recursive: true });
		writeFileSync(planted, '{"model_type":"quarantined"}');
		const rel = `${QUARANTINE_DIR}/${MODEL}/config.json`;
		expect(resolveModelPath(rel)).toBeNull();
		// …including through a traversal that lands there after normalisation.
		expect(resolveModelPath(`${MODEL}/../../${rel}`)).toBeNull();
		const path = `${AI_MODEL_URL_PREFIX}${rel}`;
		const response = await serveModelRequest(path, new Request(`http://localhost${path}`), true);
		expect(response?.status).toBe(404);
		// Positive control: the same name OUTSIDE the quarantine resolves.
		expect(resolveModelPath(`${MODEL}/config.json`)).not.toBeNull();
	});

	// The REALPATH half of the confinement (MODEL-02): the requested name is
	// inside the store, the link target is not. An unpinned name has no digest
	// to refuse it by, so the re-confinement is the only thing between this
	// session-gated route and an arbitrary file.
	test('a symlink under an unpinned name → OUTSIDE the store neither resolves nor serves', async () => {
		const outside = join(scratch, 'outside_secret.json');
		writeFileSync(outside, '{"secret":"not in the store"}');
		const own = 'fixture-org/operator-own-model';
		const link = join(store, own, 'outside.json');
		symlinkSync(outside, link);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(knownDigestFor(join(own, 'outside.json'))).toBeNull();
		expect(resolveModelPath(`${own}/outside.json`)).toBeNull();
		const path = `${AI_MODEL_URL_PREFIX}${own}/outside.json`;
		const response = await serveModelRequest(path, new Request(`http://localhost${path}`), true);
		expect(response?.status).toBe(404);
		expect(readFileSync(outside, 'utf8')).toContain('secret');
		// Positive control: the same link shape to an IN-STORE file resolves to it.
		const inside = join(store, own, 'inside_target.json');
		writeFileSync(inside, '{"inside":true}');
		const goodLink = join(store, own, 'inside.json');
		symlinkSync(inside, goodLink);
		expect(resolveModelPath(`${own}/inside.json`)).toBe(realpathSync(inside));
		const okPath = `${AI_MODEL_URL_PREFIX}${own}/inside.json`;
		expect(
			(await serveModelRequest(okPath, new Request(`http://localhost${okPath}`), true))?.status,
		).toBe(200);
	});

	test('a symlink under an unpinned name → a file INSIDE .quarantine neither resolves nor serves', async () => {
		const evidence = join(store, QUARANTINE_DIR, MODEL, 'config.json');
		expect(existsSync(evidence)).toBe(true); // planted by the leg above
		const own = 'fixture-org/operator-own-model';
		const link = join(store, own, 'evidence.json');
		symlinkSync(evidence, link);
		expect(resolveModelPath(`${own}/evidence.json`)).toBeNull();
		const path = `${AI_MODEL_URL_PREFIX}${own}/evidence.json`;
		const response = await serveModelRequest(path, new Request(`http://localhost${path}`), true);
		expect(response?.status).toBe(404);
	});
});

describe('(f) a pre-existing unhashed file is judged against the pin, without the hub', () => {
	test('matching bytes: accepted and recorded; disagreeing bytes of the same size: refused', async () => {
		const seeded = join(scratch, 'store_seeded');
		for (const [file, bytes] of Object.entries(FILES)) {
			const target = join(seeded, MODEL, file);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, bytes);
		}
		// One file with the RIGHT length and the WRONG bytes (the CARRY-06 shape).
		const config = FILES['config.json']!;
		writeFileSync(join(seeded, MODEL, 'config.json'), config.replace('pyannote', 'pyanNOTE'));
		expect(existsSync(join(seeded, MODEL, MANIFEST_FILE))).toBe(false);

		const mark = hubSeen.length;
		const report = await download(truePins(), seeded);
		// The two intact files were accepted from disk and RECORDED as verified…
		expect(readManifest(seeded, MODEL).files['onnx/model.onnx']).toEqual({
			size: Buffer.byteLength(FILES['onnx/model.onnx']!),
			sha256: sha256(FILES['onnx/model.onnx']!),
			revision: REVISION,
		});
		expect(requestsSince(mark)).not.toContain(`/${MODEL}/resolve/${REVISION}/onnx/model.onnx`);
		// …the wrong one was quarantined, then re-fetched from the hub at the
		// pinned revision and verified — which is exactly what a repair is.
		expect(quarantined(seeded).some((name) => name.includes('config.json'))).toBe(true);
		expect(requestsSince(mark)).toContain(`/${MODEL}/resolve/${REVISION}/config.json`);
		expect(report.ok).toBe(true);
		expect(readFileSync(join(seeded, MODEL, 'config.json'), 'utf8')).toBe(config);
	});

	test('a manifest that already carries the pinned digest is trusted without a re-hash or a request', async () => {
		const twice = join(scratch, 'store_twice');
		expect((await download(truePins(), twice)).ok).toBe(true);
		const mark = hubSeen.length;
		const again = await download(truePins(), twice);
		expect(again.ok).toBe(true);
		expect(again.files.sort()).toEqual(Object.keys(FILES).sort());
		expect(requestsSince(mark)).toEqual([]);
	});

	test('a manifest digest that disagrees with the pin is not trusted', async () => {
		const other = join(scratch, 'store_stale_manifest');
		const target = join(other, MODEL, 'config.json');
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, FILES['config.json']!);
		recordFileComplete(other, MODEL, 'config.json', Buffer.byteLength(FILES['config.json']!), {
			sha256: 'e'.repeat(64),
			revision: 'f'.repeat(40),
		});
		const pins = truePins();
		pins.models[MODEL]!.files = { 'config.json': pins.models[MODEL]!.files['config.json']! };
		const report = await downloadModel(MODEL, undefined, {
			store: other,
			pins,
			hubBase,
			files: ['config.json'],
		});
		expect(report.ok).toBe(true);
		expect(readManifest(other, MODEL).files['config.json']?.sha256).toBe(
			sha256(FILES['config.json']!),
		);
	});
});

describe('(g) the repo pin file covers the catalog', () => {
	/**
	 * SHRINK-ONLY: catalog models the hub does not serve at all. Each needs a
	 * reason in the pin file; a new one here is a catalog defect, not a pin gap.
	 * (2026-09-04: `onnx-community/parakeet-tdt-0.6b-v3-ONNX` answers 404/401
	 * on the hub's model API — the register.json entry names a repository that
	 * does not exist there.)
	 */
	const UNPINNED_CEILING = 1;
	const catalog = readRegisterCatalog();
	const table = readPinTable();

	test('the catalog census has a floor', () => {
		// 8 transcription + 4 translators + 19 opus-mt pairs (2026-11-22).
		expect(catalog.length).toBeGreaterThanOrEqual(31);
	});

	test('every catalog model is pinned, or reasoned as unpinned (shrink-only)', () => {
		expect(checkTable(table, catalog)).toEqual([]);
		const unpinned = Object.keys(table.unpinned);
		expect(unpinned.length).toBeLessThanOrEqual(UNPINNED_CEILING);
		for (const id of unpinned) {
			expect(
				catalog.some((model) => model.id === id),
				`${id} is not a catalog model`,
			).toBe(true);
			expect(table.models[id], `${id} cannot be both pinned and unpinned`).toBeUndefined();
			expect(table.unpinned[id]!.reason.length).toBeGreaterThan(20);
		}
	});

	test('every pin is well-formed: 40-hex revision, ISO date, reason, sha256 + size per file', () => {
		const pinned = Object.entries(table.models);
		expect(pinned.length).toBeGreaterThanOrEqual(catalog.length - UNPINNED_CEILING);
		let files = 0;
		for (const [id, pin] of pinned) {
			expect(REVISION_HEX.test(pin.revision), `${id}: revision`).toBe(true);
			expect(pinnedRevision(id)).toBe(pin.revision);
			expect(pin.pinned_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(pin.reason.trim().length, `${id}: reason`).toBeGreaterThan(12);
			for (const [file, entry] of Object.entries(pin.files)) {
				expect(SHA256_HEX.test(entry.sha256), `${id}/${file}: sha256`).toBe(true);
				expect(Number.isInteger(entry.size) && entry.size > 0, `${id}/${file}: size`).toBe(true);
				files++;
			}
			// Every REQUIRED file of the catalog entry is pinned (optional ones may be unpublished).
			const model = catalog.find((entry) => entry.id === id)!;
			const { optional } = commonFilesFor(model.kind ?? 'asr');
			for (const file of filesFor(model)) {
				if (optional.includes(file)) continue;
				expect(pin.files[file], `${id}: ${file} has no pin`).toBeDefined();
			}
		}
		expect(files).toBeGreaterThanOrEqual(180);
	});

	test('positive control: the census sees a missing pin', () => {
		const broken: PinTable = { models: { ...table.models }, unpinned: {} };
		const [first] = Object.keys(broken.models);
		delete broken.models[first!];
		expect(checkTable(broken, catalog)).toContain(`${first}: no pin and not in unpinned`);
	});
});

describe('(h) the geoip database carries a rest-integrity sidecar', () => {
	test('written at download; a mismatch is quarantined and reported absent', async () => {
		const dir = join(scratch, 'geoip');
		const bytes = 'MMDB-FIXTURE-BYTES';
		const result = await downloadCountryDb(dir, 'https://mirror.test/db.gz', {
			streamToFile: async (_url, dest) => {
				writeFileSync(dest, 'gz');
				return 2;
			},
			gunzipWithCaps: async (_src, dest) => {
				writeFileSync(dest, bytes);
				return bytes.length;
			},
		});
		expect(result.ok).toBe(true);
		const mmdb = join(dir, DB_BASENAME);
		expect(readFileSync(sidecarPath(mmdb), 'utf8').split(/\s+/)[0]).toBe(sha256(bytes));
		expect(await verifyCountryDb(mmdb)).toBe('ok');
		expect((await verifiedCacheState(mmdb)).present).toBe(true);

		writeFileSync(mmdb, 'MMDB-FIXTURE-BYTEZ'); // same length, one byte off
		expect(await verifyCountryDb(mmdb)).toBe('mismatch');
		const reconciled = await verifiedCacheState(mmdb);
		expect(reconciled.present).toBe(false);
		expect(existsSync(mmdb)).toBe(false);
		expect(quarantined(dir).some((name) => name.includes(DB_BASENAME))).toBe(true);
	});

	test('a cache with no sidecar (pre-sidecar install) loads as-is and says so', async () => {
		const dir = join(scratch, 'geoip_legacy');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, DB_BASENAME), 'LEGACY');
		expect(await verifyCountryDb(join(dir, DB_BASENAME))).toBe('unpinned');
		expect((await verifiedCacheState(join(dir, DB_BASENAME))).present).toBe(true);
	});
});

describe('(i) the pin procedure derives digests from the hub tree and cross-checks', () => {
	const fixtureCatalog = {
		id: MODEL,
		label: 'fixture',
		note: '',
		kind: 'diarization' as const,
		dtype: { model: 'fp32' },
	};

	test('pinModel: lfs.oid for the weights, download-and-hash for the plain files', async () => {
		const pin = await pinModel(hubBase, fixtureCatalog, 'gate fixture reason', '2026-09-04');
		expect(pin).not.toBeNull();
		expect(pin?.revision).toBe(REVISION);
		expect(pin?.files).toEqual(truePins().models[MODEL]!.files);
		// The licence is the card's own, cited at the PUBLIC hub page whatever
		// hub answered (the record is evidence for a human).
		expect(pin?.licence).toEqual({
			name: 'mit',
			url: `${HUB_BASE}/${MODEL}`,
			declared_by: 'card',
			card: { license: 'mit', url: `${HUB_BASE}/${MODEL}` },
			upstream: null,
		});
		expect(licenceProblems(MODEL, pin!)).toEqual([]);
	});

	test('a tree size that disagrees with the hashed bytes is refused', async () => {
		treeSizeOverride = 1;
		try {
			await expect(
				pinModel(hubBase, fixtureCatalog, 'gate fixture reason', '2026-09-04'),
			).rejects.toThrow(/tree says/);
		} finally {
			treeSizeOverride = null;
		}
	});

	test('production fetches from the pinned https hub', () => {
		expect(HUB_BASE).toBe('https://huggingface.co');
	});
});

describe('(j) the translation catalogue is first-class: pinned, expanded, licensed', () => {
	const table = readPinTable();
	const translators = readTranslationCatalog();
	const templates = readTranslationTemplates();
	const TRANSLATEGEMMA = 'onnx-community/translategemma-text-4b-it-ONNX';

	test('the translation catalogue has a floor and every entry is pinned', () => {
		// qwen, translategemma, nllb, madlad + the 19 opus-mt pairs the hub serves.
		expect(translators.length).toBeGreaterThanOrEqual(23);
		for (const model of translators) {
			expect(table.models[model.id], `${model.id}: not pinned`).toBeDefined();
			expect(model.kind === 'decoder_only' || model.kind === 'seq2seq').toBe(true);
		}
		// C54's recorded condition (registry.ts): the translategemma revision is pinned.
		expect(pinnedRevision(TRANSLATEGEMMA)).toMatch(REVISION_HEX);
	});

	test('every templated id carries a reproducible expansion whose ids ARE the catalogue', () => {
		expect(templates.map((model) => model.id)).toContain('Xenova/opus-mt-{src}-{tgt}');
		for (const template of templates) {
			const expansion = table.expansions?.[template.id];
			expect(expansion, `${template.id}: no expansion record`).toBeDefined();
			const { langs, probed, present } = expansion!;
			expect(langs.length).toBeGreaterThanOrEqual(2);
			expect(new Set(langs).size).toBe(langs.length);
			expect(probed).toBe(langs.length * (langs.length - 1));
			const candidates = new Set(
				langs.flatMap((src) =>
					langs.filter((tgt) => tgt !== src).map((tgt) => expandTemplate(template.id, src, tgt)),
				),
			);
			for (const id of present) expect(candidates.has(id), `${id}: not a probed pair`).toBe(true);
			expect(expansion!.reason.trim().length).toBeGreaterThan(20);
			expect(expansion!.computed_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			const expanded = translators.filter((model) => model.template === template.id);
			expect(expanded.map((model) => model.id).sort()).toEqual([...present].sort());
		}
	});

	test('a decoder-only translator pins its external-data chunks with its weights', () => {
		const gemma = translators.find((model) => model.id === TRANSLATEGEMMA)!;
		const wanted = filesFor(gemma, table);
		expect(wanted).toContain('onnx/model_q4.onnx');
		expect(wanted).toContain('onnx/model_q4.onnx_data');
		expect(wanted).toContain('onnx/model_q4.onnx_data_1');
		// No orphan chunk anywhere: every pinned `…onnx_data*` rides a pinned weight.
		for (const [id, pin] of Object.entries(table.models)) {
			for (const file of Object.keys(pin.files)) {
				const weight = /^(.*\.onnx)_data(?:_\d+)?$/.exec(file)?.[1];
				if (weight !== undefined) {
					expect(pin.files[weight], `${id}: ${file} has no pinned weight`).toBeDefined();
				}
			}
		}
	});

	test('EVERY pin carries a valid licence record', () => {
		for (const [id, pin] of Object.entries(table.models)) {
			expect(licenceProblems(id, pin), id).toEqual([]);
		}
	});

	test('positive controls: a pin without a licence, or with a forged one, is red in the census', () => {
		const catalog = readRegisterCatalog();
		const stripped = structuredClone(table) as PinTable;
		stripped.models[TRANSLATEGEMMA]!.licence = undefined;
		expect(checkTable(stripped, catalog)).toContain(`${TRANSLATEGEMMA}: no licence record`);
		const forged = structuredClone(table) as PinTable;
		forged.models[TRANSLATEGEMMA]!.licence!.name = 'apache-2.0';
		expect(checkTable(forged, catalog)).toContain(
			`${TRANSLATEGEMMA}: declared by the upstream, but it says gemma`,
		);
		const unexpanded = structuredClone(table) as PinTable;
		unexpanded.expansions = {};
		expect(checkTable(unexpanded, catalog)).toContain(
			'Xenova/opus-mt-{src}-{tgt}: a templated catalog id with no recorded expansion (run --expand)',
		);
	});
});

describe('(j2) a model the catalogue does NOT offer is never seeded by --all (A1-02 re-review)', () => {
	const NLLB = 'Xenova/nllb-200-distilled-600M';
	const REPO_ROOT = join(import.meta.dir, '..', '..');

	/** Run the seeder CLI with a scratch store (never downloads: --dry-run / --list / refusals only). */
	const spawnSeeder = (...args: string[]) => {
		const child = Bun.spawnSync(['bun', 'scripts/fetch_ai_models.ts', ...args], {
			cwd: REPO_ROOT,
			env: process.env,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return { exitCode: child.exitCode, out: child.stdout.toString() + child.stderr.toString() };
	};
	const runSeeder = (...args: string[]): string => {
		const { exitCode, out } = spawnSeeder(...args);
		expect(exitCode, out).toBe(0);
		return out;
	};

	test('the catalogue reader carries offered_by_default and its reason', () => {
		const translators = readTranslationCatalog();
		const nllb = translators.find((model) => model.id === NLLB)!;
		expect(nllb.offered_by_default).toBe(false);
		expect(nllb.not_offered_reason).toContain('CC-BY-NC');
		for (const model of translators.filter((entry) => entry.id !== NLLB)) {
			expect(model.offered_by_default, model.id).toBe(true);
		}
	});

	test('allFetchTargets: every offered model, the not-offered one skipped with its reason', () => {
		const catalog = readRegisterCatalog();
		const { ids, skipped } = allFetchTargets(catalog);
		expect(ids).not.toContain(NLLB);
		expect(skipped.map((entry) => entry.id)).toEqual([NLLB]);
		expect(skipped[0]!.reason).toContain('CC-BY-NC');
		expect(ids.length).toBe(catalog.length - 1);
		expect(notOfferedMark(catalog.find((model) => model.id === NLLB)!)).toMatch(
			/^ {2}\[not offered: CC-BY-NC/,
		);
	});

	test('the CLI refuses an unknown option and a --store without a directory — nothing fetched', () => {
		const scratch = mkdtempSync(join(tmpdir(), 'dd_seed_cli_'));
		try {
			for (const args of [
				['--dryrun', NLLB, '--store', scratch],
				['--all', '-n', '--store', scratch],
				[NLLB, '--store'],
			]) {
				const { exitCode, out } = spawnSeeder(...args);
				expect(exitCode, args.join(' ')).toBe(2);
				expect(out).toContain('nothing was fetched');
				expect(out).not.toContain('would fetch');
			}
			expect(readdirSync(scratch)).toEqual([]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('--dry-run refuses what a real run refuses: an id in no catalogue', () => {
		const { exitCode, out } = spawnSeeder('--dry-run', 'nobody/not-a-model');
		expect(exitCode).not.toBe(0);
		expect(out).toContain('nobody/not-a-model is in no in-browser model catalog');
		expect(out).not.toContain('would fetch');
	});

	test('the CLI: --all leaves it out and says so; naming it fetches it; --list marks it', () => {
		const all = runSeeder('--all', '--dry-run');
		expect(all).not.toContain(`would fetch: ${NLLB}`);
		expect(all).toContain(
			`skipped (not offered — fetch it by name only after checking): ${NLLB} — CC-BY-NC`,
		);
		expect(all).toContain('would fetch: onnx-community/Qwen3-4B-Instruct-2507-ONNX');
		expect(runSeeder(NLLB, '--dry-run')).toContain(`would fetch: ${NLLB}`);
		const listed = runSeeder('--list').split('\n');
		expect(listed.find((line) => line.includes(NLLB))).toContain('[not offered: CC-BY-NC');
		expect(listed.find((line) => line.includes('Qwen3-4B'))).not.toContain('not offered');
	});
});

describe("(k) the engine file set equals the vendored runtime's, for every translator shape", () => {
	/** Minimal configs of the five catalogue architectures (no fetch: passed in). */
	const CASES: { name: string; kind: ModelKind; dtype: string; config: Record<string, unknown> }[] =
		[
			{
				name: 'Qwen3 decoder-only, chunks keyed by full name',
				kind: 'decoder_only',
				dtype: 'q4f16',
				config: {
					architectures: ['Qwen3ForCausalLM'],
					model_type: 'qwen3',
					'transformers.js_config': {
						use_external_data_format: { 'model.onnx': 8, 'model_q4f16.onnx': 2 },
					},
				},
			},
			{
				name: 'Gemma3 decoder-only, one chunk count for every file',
				kind: 'decoder_only',
				dtype: 'q4',
				config: {
					architectures: ['Gemma3ForCausalLM'],
					model_type: 'gemma3_text',
					'transformers.js_config': { use_external_data_format: 3 },
				},
			},
			{
				name: 'Gemma3 decoder-only, chunks keyed by part',
				kind: 'decoder_only',
				dtype: 'q4',
				config: {
					architectures: ['Gemma3ForCausalLM'],
					model_type: 'gemma3_text',
					'transformers.js_config': { use_external_data_format: { model: 1 } },
				},
			},
			{
				name: 'M2M100 (NLLB) seq2seq',
				kind: 'seq2seq',
				dtype: 'q8',
				config: { architectures: ['M2M100ForConditionalGeneration'], model_type: 'm2m_100' },
			},
			{
				name: 'T5 (MADLAD) seq2seq',
				kind: 'seq2seq',
				dtype: 'q8',
				config: { architectures: ['T5ForConditionalGeneration'], model_type: 't5' },
			},
			{
				name: 'Marian (opus-mt) seq2seq',
				kind: 'seq2seq',
				dtype: 'q8',
				config: { architectures: ['MarianMTModel'], model_type: 'marian' },
			},
		];

	const engineSet = (kind: ModelKind, dtype: string, config: unknown): string[] =>
		[...modelFilesForConfig(dtype, kind, config), 'generation_config.json'].sort();

	for (const testCase of CASES) {
		test(testCase.name, async () => {
			const runtime = [
				...new Set(await runtimeModelFiles('fixture/x', testCase.config, testCase.dtype)),
			].sort();
			expect(engineSet(testCase.kind, testCase.dtype, testCase.config)).toEqual(runtime);
			expect(runtime.some((file) => file.startsWith('onnx/'))).toBe(true);
		});
	}

	test('positive control: the WRONG kind for an architecture disagrees with the runtime', async () => {
		const qwen = CASES[0]!;
		const runtime = [
			...new Set(await runtimeModelFiles('fixture/x', qwen.config, qwen.dtype)),
		].sort();
		expect(engineSet('seq2seq', qwen.dtype, qwen.config)).not.toEqual(runtime);
		// …and dropping the chunks (the pre-2026-11-22 file set) disagrees too.
		expect(engineSet('decoder_only', qwen.dtype, {})).not.toEqual(runtime);
	});
});

describe('(l) external-data chunks past the first are served and evidenced', () => {
	const GEMMA = 'onnx-community/translategemma-text-4b-it-ONNX';
	const ONNX_HEAD = '\u0008FIXTURE';

	test('`…onnx_data_1` is servable; a name that only resembles a chunk is not', async () => {
		const dir = join(store, 'fixture-org', 'decoder-FIXTURE', 'onnx');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'model_q4.onnx_data_1'), 'CHUNK-BYTES');
		writeFileSync(join(dir, 'model_q4.onnx_data_1x'), 'NOT-A-CHUNK');
		const request = (name: string) =>
			serveModelRequest(
				`${AI_MODEL_URL_PREFIX}fixture-org/decoder-FIXTURE/onnx/${name}`,
				new Request(`http://localhost${AI_MODEL_URL_PREFIX}x`),
				true,
			);
		expect((await request('model_q4.onnx_data_1'))?.status).toBe(200);
		expect((await request('model_q4.onnx_data_1x'))?.status).toBe(404);
	});

	test('a decoder-only translator missing its second chunk is `incomplete`, not ready', () => {
		const root = join(store, GEMMA);
		mkdirSync(join(root, 'onnx'), { recursive: true });
		writeFileSync(join(root, 'config.json'), '{"model_type":"gemma3_text"}');
		writeFileSync(join(root, 'onnx', 'model_q4.onnx'), ONNX_HEAD);
		writeFileSync(join(root, 'onnx', 'model_q4.onnx_data'), 'CHUNK-0');
		const partial = modelState(GEMMA, 'q4', 'decoder_only');
		expect(partial.files.map((entry) => entry.file)).toContain('onnx/model_q4.onnx_data_1');
		expect(partial.state).toBe('incomplete');
		writeFileSync(join(root, 'onnx', 'model_q4.onnx_data_1'), 'CHUNK-1');
		// Every file present, none recorded in a manifest: `unverified`, never `ready`.
		expect(modelState(GEMMA, 'q4', 'decoder_only').state).toBe('unverified');
	});
});
