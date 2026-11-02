/**
 * PUBLICATION API BUNDLES — the bytes phase 4 pushes to a publication host's agent
 * (engineering/PUBLICATION_HOST_SPEC.md §3; phase-4 plan L1–L3).
 *
 * SOURCE = THE INSTALLED TREE. The verified release zip is deleted after the swap. What
 * carries "what was verified is what ships" across the restart is the extract-time
 * manifest (src/core/update/publication_manifest.ts, its ONE reader:
 * readPublicationManifest). Every build re-proves the tree against it (await
 * verifyPublicationTree, also on a cache hit), and the packer re-hashes every file it
 * reads against the same manifest. A file edited between the check and the read is a
 * refusal naming it, never a shipped edit.
 *
 * A BUNDLE IS EXACTLY THE MANIFEST'S FILES for that API (manifestFilesFor), never a
 * directory walk of the tree, plus, for v2, the production node_modules built HERE with
 * the pinned Bun (phase-2 D6: the publication host never needs registry egress). A path
 * Task 2 tolerates (.env, server_config_api.php, node_modules …) is never manifested and so
 * never shipped. The agent-reserved names Task 2 does NOT tolerate are refused here
 * (ENGINE_RESERVED_BUNDLE_PATHS); the gate holds the union equal to the agent's D8 set.
 *
 * ORDER: entries are sorted with the writer's own compareBundlePaths (bundle_writer.ts).
 * The writer refuses any other order, and a whole-path byte sort is NOT that order
 * (`a-b` < `a/x`, `fp.js` < `fp/a.js`).
 *
 * READS NEVER FOLLOW A LINK: readBundleFile opens O_NOFOLLOW|O_NONBLOCK and stats THE
 * HANDLE, so a link swapped in after the walk is refused and a FIFO never blocks. Honest
 * limit: O_NOFOLLOW guards the LAST component only. An intermediate directory replaced
 * by a link after the walk would be followed. The deps tree is written only by the
 * install child, which has exited by then, and source bytes are re-hashed whatever path
 * they came from.
 *
 * v2 DEPENDENCIES: the VERIFIED bytes of package.json + bun.lock (+ bunfig.toml, release
 * input) are written to <backupRoot>/.pubapi_build/<release>/v2/ and installed with
 * `process.execPath install --frozen-lockfile --production --linker hoisted --ignore-scripts`
 * (measured 2026-10-03, Bun 1.4.2):
 *   - frozen + bun.lock REQUIRED: bun accepts --frozen-lockfile with NO lockfile and then
 *     floats every version;
 *   - hoisted: the isolated linker's tree is a symlink farm the bundle format (ustar types
 *     0/5 only, phase-2 D7) cannot carry;
 *   - ignore-scripts: v2 declares no lifecycle scripts; none may run on the work host.
 * The child runs with a MINIMAL environment (v2DepsInstallEnv): PATH, TMPDIR and the
 * standard proxy keys only. HOME is the build dir, so no operator ~/.bunfig.toml or
 * ~/.npmrc is read. The install cache is shared under the build root and never pruned. No
 * DB password, DEDALO_* secret or token reaches it. This egress is recorded in
 * engineering/OUTBOUND_SPEC.md §5. Only node_modules/.bin is dropped; ANY other symlink (a
 * `file:` dependency installs as symlinked files) is a refusal. The deps tree is deleted
 * after packing.
 *
 * CACHE: <backupRoot>/.pubapi_build/<release>/<api>.tar.gz + <api>.json. The sidecar is
 * written LAST, and only after the on-disk bundle re-hashed to the writer's sha256. A hit
 * needs the sidecar's release + digest AND the bundle re-hashing to its sha256. The newest
 * API_BUNDLE_CACHE_KEEP release dirs survive a build. The backup root is the updater's
 * (outside the code tree by its own refusal), so the cache survives a swap.
 *
 * ASYNC ONLY: reached from the panel's push action, so no unbounded sync I/O
 * (sync_io_on_request_path_tripwire).
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { envSnapshot, projectRoot } from '../../config/env.ts';
import { lockTupleProblems, parseLockPackages } from '../security/lockfile_provenance.ts';
import { resolveCodeBackupRoot } from '../update/code_update.ts';
import { INSTALLED_DIGEST } from '../update/install_stamp.ts';
import {
	manifestFilesFor,
	PUBLICATION_API_ROOT,
	type PublicationApi,
	type PublicationManifest,
	readPublicationManifest,
	verifyPublicationTree,
} from '../update/publication_manifest.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../update/version.ts';
import { compareBundlePaths, writeBundle } from './bundle_writer.ts';

export type { PublicationApi };

/** Phase-2 D9 — the agent's RELEASE_ID: `<version>_<digest7>`. */
export const PUBLICATION_RELEASE_ID = /^\d+(\.\d+){1,3}_[0-9a-f]{7}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `<backupRoot>/.pubapi_build/<release>/` — the build cache (L3). */
export const API_BUILD_DIR = '.pubapi_build';
/** `<backupRoot>/.pubapi_build/.bun_install_cache` — shared by every release; the prune never matches it. */
export const API_BUN_CACHE_DIR = '.bun_install_cache';
/** Release dirs kept after a build (the agent keeps 3 releases as well). */
export const API_BUNDLE_CACHE_KEEP = 3;

/** After `process.execPath` — the PINNED bun, never a floating one. */
export const V2_DEPS_INSTALL_ARGS: readonly string[] = Object.freeze([
	'install',
	'--frozen-lockfile',
	'--production',
	'--linker',
	'hoisted',
	'--ignore-scripts',
]);
export const V2_DEPS_INSTALL_TIMEOUT_MS = 600_000;
/** Copied (as verified bytes) into the deps build dir; bunfig.toml is optional. */
export const V2_DEPS_INPUTS: readonly string[] = Object.freeze([
	'package.json',
	'bun.lock',
	'bunfig.toml',
]);
const V2_DEPS_REQUIRED: readonly string[] = Object.freeze(['package.json', 'bun.lock']);
/** The only ambient keys the install child sees (the proxy keys the engine already documents). */
export const V2_DEPS_ENV_PASSTHROUGH: readonly string[] = Object.freeze([
	'PATH',
	'TMPDIR',
	'HTTPS_PROXY',
	'HTTP_PROXY',
	'NO_PROXY',
	'https_proxy',
	'http_proxy',
	'no_proxy',
]);
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * Agent-reserved paths (equal or under) that Task 2 does NOT tolerate, so a release can
 * manifest them. The tolerated ones (.env, config_api/server_config_api.php) are never
 * manifested and so never shipped. The gate holds tolerated ∪ this list ⊇ the agent's D8 set.
 */
export const ENGINE_RESERVED_BUNDLE_PATHS: Readonly<Record<PublicationApi, readonly string[]>> =
	Object.freeze({
		v1: Object.freeze(['.bundle_sha256']),
		v2: Object.freeze(['.bundle_sha256', '.env.local', '.env.production', '.env.production.local']),
	});

/** node_modules/.bin at any depth: package-binary symlinks v2 never runs (phase-2 D6). */
const BIN_DIR = /(^|\/)node_modules\/\.bin$/;
const NAMED_PATHS_MAX = 20;
const STDERR_TAIL_LINES = 20;
const OPEN_NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface ApiBundle {
	releaseId: string;
	file: string;
	sha256: string;
}

export type ApiBundleReason =
	| 'no_verified_release'
	| 'unsafe_seams'
	| 'missing_manifest'
	| 'digest_mismatch'
	| 'drift'
	| 'empty_api'
	| 'reserved_path'
	| 'not_regular_file'
	| 'lockfile_missing'
	| 'deps_install_failed'
	| 'deps_symlink'
	| 'deps_unpinned'
	| 'write_mismatch';

/** A refused build. `paths` names the offending files (tree keys or bundle paths). */
export class ApiBundleError extends Error {
	readonly reason: ApiBundleReason;
	readonly paths: readonly string[];
	constructor(reason: ApiBundleReason, message: string, paths: readonly string[] = []) {
		super(message);
		this.name = 'ApiBundleError';
		this.reason = reason;
		this.paths = Object.freeze([...paths]);
	}
}

export interface ApiBundleSeams {
	treeRoot?: string;
	backupRoot?: string;
	digest?: string | null;
	version?: string;
	installDeps?: (depsDir: string) => Promise<void>;
}

interface BuildContext {
	treeRoot: string;
	backupRoot: string;
	digest: string | null;
	version: string;
	installDeps: (depsDir: string) => Promise<void>;
}

export interface ApiBuildPaths {
	buildRoot: string;
	releaseDir: string;
	bundle: string;
	sidecar: string;
	depsDir: string;
}

export type BundleFileRead =
	| { kind: 'file'; data: Uint8Array; mode: number }
	| { kind: 'symlink' }
	| { kind: 'not_regular' };

interface SourceFile {
	key: string;
	rel: string;
	sha256: string;
}

interface LoadedFile {
	data: Uint8Array;
	mode: number;
}

type PlannedEntry =
	| { path: string; type: 'dir' }
	| { path: string; type: 'file'; load: () => Promise<LoadedFile> };

interface WriterEntry {
	path: string;
	type: 'file' | 'dir';
	mode: number;
	data?: Uint8Array;
	size?: number;
}

interface BundleSidecar {
	version: 1;
	api: PublicationApi;
	release: string;
	digest: string;
	sha256: string;
	built_at: string;
}

interface PackFailure {
	error: unknown;
}

/**
 * Builds in flight, keyed backupRoot + release + api — never request identity — so the
 * confirm hook and a panel push of the same release share one `bun install`. Deleted the
 * moment the build settles (module_state_tripwire row).
 */
const buildsInFlight = new Map<string, Promise<ApiBundle>>();

/** L2: `<version>_<digest7>`; no 64-hex digest = no verified release. */
export function publicationReleaseId(version: string, digest: string | null): string {
	if (digest === null || !SHA256_HEX.test(digest)) {
		throw new ApiBundleError(
			'no_verified_release',
			'Publication API bundle refused (no_verified_release): this tree has no verified install digest (dev checkout or pre-stamp install)',
		);
	}
	const id = `${version}_${digest.slice(0, 7)}`;
	if (!PUBLICATION_RELEASE_ID.test(id)) {
		throw new ApiBundleError(
			'no_verified_release',
			`Publication API bundle refused (no_verified_release): '${id}' is not <version>_<digest7>`,
		);
	}
	return id;
}

export function apiBuildPaths(
	backupRoot: string,
	releaseId: string,
	api: PublicationApi,
): ApiBuildPaths {
	const buildRoot = join(backupRoot, API_BUILD_DIR);
	const releaseDir = join(buildRoot, releaseId);
	return {
		buildRoot,
		releaseDir,
		bundle: join(releaseDir, `${api}.tar.gz`),
		sidecar: join(releaseDir, `${api}.json`),
		depsDir: join(releaseDir, api),
	};
}

export function apiTreePrefix(api: PublicationApi): string {
	return `${PUBLICATION_API_ROOT}/${api}/`;
}

export function isReservedBundlePath(api: PublicationApi, rel: string): boolean {
	return ENGINE_RESERVED_BUNDLE_PATHS[api].some(
		(reserved) => rel === reserved || rel.startsWith(`${reserved}/`),
	);
}

function errnoOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

/** One file, opened WITHOUT following a final link and without blocking; stat + read on the same handle. */
export async function readBundleFile(abs: string): Promise<BundleFileRead> {
	let handle: FileHandle;
	try {
		handle = await open(abs, OPEN_NO_FOLLOW);
	} catch (error) {
		return errnoOf(error) === 'ELOOP' ? { kind: 'symlink' } : { kind: 'not_regular' };
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) return { kind: 'not_regular' };
		return { kind: 'file', data: await handle.readFile(), mode: modeOf(info.mode) };
	} finally {
		await handle.close();
	}
}

/** The install child's whole environment (see the header): passthrough keys + HOME + cache. */
export function v2DepsInstallEnv(
	depsDir: string,
	ambient: Readonly<Record<string, string | undefined>> = envSnapshot(),
): Record<string, string> {
	const env: Record<string, string> = { PATH: DEFAULT_PATH };
	for (const key of V2_DEPS_ENV_PASSTHROUGH) {
		const value = ambient[key];
		if (value !== undefined && value !== '') env[key] = value;
	}
	return {
		...env,
		HOME: depsDir,
		BUN_INSTALL_CACHE_DIR: join(dirname(dirname(depsDir)), API_BUN_CACHE_DIR),
	};
}

/**
 * The verified bundle of `api` for the installed release: re-proves the tree, then serves
 * the cache or builds. Throws ApiBundleError on every refusal; nothing unverified is packed.
 */
export async function buildApiBundle(
	api: PublicationApi,
	seams: ApiBundleSeams = {},
): Promise<ApiBundle> {
	const ctx = resolveContext(seams);
	const releaseId = publicationReleaseId(ctx.version, ctx.digest);
	const key = `${ctx.backupRoot}\u0000${releaseId}\u0000${api}`;
	const running = buildsInFlight.get(key);
	if (running !== undefined) return running;
	const job = verifyThenBuild(api, releaseId, ctx).finally(() => buildsInFlight.delete(key));
	buildsInFlight.set(key, job);
	return job;
}

function resolveRoots(seams: ApiBundleSeams): { treeRoot: string; backupRoot: string } {
	if (seams.treeRoot !== undefined && seams.backupRoot === undefined) {
		throw new ApiBundleError(
			'unsafe_seams',
			'Publication API bundle refused (unsafe_seams): a scratch treeRoot must name its own backupRoot',
		);
	}
	return {
		treeRoot: seams.treeRoot ?? projectRoot,
		backupRoot: seams.backupRoot ?? resolveCodeBackupRoot(),
	};
}

function resolveContext(seams: ApiBundleSeams): BuildContext {
	return {
		...resolveRoots(seams),
		digest: seams.digest === undefined ? INSTALLED_DIGEST : seams.digest,
		version: seams.version ?? formatVersion(DEDALO_DATA_VERSION),
		installDeps: seams.installDeps ?? installV2DepsReal,
	};
}

async function verifyThenBuild(
	api: PublicationApi,
	releaseId: string,
	ctx: BuildContext,
): Promise<ApiBundle> {
	const manifest = await verifiedManifest(api, ctx);
	const paths = apiBuildPaths(ctx.backupRoot, releaseId, api);
	const cached = await cachedBundle(paths, api, releaseId, manifest.digest);
	if (cached !== null) return cached;
	const built = await buildFresh(api, releaseId, manifest, ctx, paths);
	await pruneBuildCache(paths.buildRoot, releaseId);
	return built;
}

async function verifiedManifest(
	api: PublicationApi,
	ctx: BuildContext,
): Promise<PublicationManifest> {
	const verdict = await verifyPublicationTree(ctx.treeRoot, api, ctx.digest ?? undefined);
	if (!verdict.ok) throw bundleRefusal(verdict.reason, verdict.drift);
	const manifest = await readPublicationManifest(ctx.treeRoot);
	if (manifest === null) throw bundleRefusal('missing_manifest', []);
	if (manifest.digest !== ctx.digest) {
		throw new ApiBundleError(
			'digest_mismatch',
			`Publication API bundle refused (digest_mismatch): the manifest was written for ${manifest.digest.slice(0, 7)}, the running release is ${String(ctx.digest).slice(0, 7)}`,
		);
	}
	return manifest;
}

function refusalSentence(reason: ApiBundleReason, paths: readonly string[]): string {
	const more = paths.length > NAMED_PATHS_MAX ? ` (+${paths.length - NAMED_PATHS_MAX} more)` : '';
	const named = paths.length === 0 ? '' : `: ${paths.slice(0, NAMED_PATHS_MAX).join(', ')}${more}`;
	return `Publication API bundle refused (${reason})${named}`;
}

function bundleRefusal(reason: ApiBundleReason, paths: readonly string[]): ApiBundleError {
	return new ApiBundleError(reason, refusalSentence(reason, paths), paths);
}

function apiSourceFiles(manifest: PublicationManifest, api: PublicationApi): SourceFile[] {
	const prefix = apiTreePrefix(api);
	return manifestFilesFor(manifest, api).map((key) => ({
		key,
		rel: key.slice(prefix.length),
		sha256: manifest.files[key] as string,
	}));
}

function assertBundleable(api: PublicationApi, sources: readonly SourceFile[]): void {
	if (sources.length === 0) throw bundleRefusal('empty_api', [apiTreePrefix(api)]);
	const reserved = sources
		.filter((source) => isReservedBundlePath(api, source.rel))
		.map((source) => source.key);
	if (reserved.length > 0) throw bundleRefusal('reserved_path', reserved);
}

async function buildFresh(
	api: PublicationApi,
	releaseId: string,
	manifest: PublicationManifest,
	ctx: BuildContext,
	paths: ApiBuildPaths,
): Promise<ApiBundle> {
	const sources = apiSourceFiles(manifest, api);
	assertBundleable(api, sources);
	await mkdir(paths.releaseDir, { recursive: true });
	await rm(paths.sidecar, { force: true });
	await sweepStaleTemps(paths.releaseDir, api);
	try {
		const deps = api === 'v2' ? await buildV2Deps(ctx, sources, paths.depsDir) : [];
		const sha256 = await packBundle(
			planEntries(sourceEntries(ctx.treeRoot, sources), deps),
			paths.bundle,
		);
		await writeSidecar(paths.sidecar, {
			version: 1,
			api,
			release: releaseId,
			digest: manifest.digest,
			sha256,
			built_at: new Date().toISOString(),
		});
		return { releaseId, file: paths.bundle, sha256 };
	} finally {
		await rm(paths.depsDir, { recursive: true, force: true });
	}
}

/** Temps a dead process left behind (this process's own are removed in packBundle). */
async function sweepStaleTemps(releaseDir: string, api: PublicationApi): Promise<void> {
	for (const name of await readdir(releaseDir)) {
		if (name.startsWith(`${api}.tar.gz.tmp-`) || name.startsWith(`${api}.json.tmp-`)) {
			await rm(join(releaseDir, name), { force: true });
		}
	}
}

/** One manifest file, read without following a link and RE-HASHED against the manifest (the TOCTOU half of L1). */
async function readVerifiedSource(treeRoot: string, source: SourceFile): Promise<LoadedFile> {
	const read = await readBundleFile(join(treeRoot, source.key));
	if (read.kind !== 'file') throw bundleRefusal('not_regular_file', [source.key]);
	if (sha256Hex(read.data) !== source.sha256) throw bundleRefusal('drift', [source.key]);
	return { data: read.data, mode: read.mode };
}

/** One dependency file, re-checked at READ time: a link swapped in after the walk is refused. */
async function readDepFile(base: string, path: string): Promise<LoadedFile> {
	const read = await readBundleFile(join(base, path));
	if (read.kind === 'symlink') throw bundleRefusal('deps_symlink', [path]);
	if (read.kind !== 'file') throw bundleRefusal('not_regular_file', [path]);
	return { data: read.data, mode: read.mode };
}

function modeOf(mode: number): number {
	return (mode & 0o111) !== 0 ? 0o755 : 0o644;
}

function sha256Hex(data: Uint8Array): string {
	return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

async function fileSha256(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest('hex');
}

function sourceEntries(treeRoot: string, sources: readonly SourceFile[]): PlannedEntry[] {
	return sources.map(
		(source): PlannedEntry => ({
			path: source.rel,
			type: 'file',
			load: () => readVerifiedSource(treeRoot, source),
		}),
	);
}

function parentDirs(path: string): string[] {
	const segments = path.split('/');
	return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/'));
}

function addEntry(byPath: Map<string, PlannedEntry>, entry: PlannedEntry): void {
	const existing = byPath.get(entry.path);
	if (existing === undefined) {
		byPath.set(entry.path, entry);
		return;
	}
	if (existing.type !== 'dir' || entry.type !== 'dir')
		throw bundleRefusal('reserved_path', [entry.path]);
}

/** Every file's parent directories as explicit dir entries (mode 0755), deduplicated. */
function withParentDirs(entries: readonly PlannedEntry[]): PlannedEntry[] {
	const byPath = new Map<string, PlannedEntry>();
	for (const entry of entries) {
		addEntry(byPath, entry);
		for (const dir of parentDirs(entry.path)) addEntry(byPath, { path: dir, type: 'dir' });
	}
	return [...byPath.values()];
}

/** The writer's ONE order (compareBundlePaths): a parent, its contents, then its next sibling. */
function planEntries(
	sources: readonly PlannedEntry[],
	deps: readonly PlannedEntry[],
): PlannedEntry[] {
	return withParentDirs([...sources, ...deps]).sort((a, b) => compareBundlePaths(a.path, b.path));
}

async function materialize(entry: PlannedEntry): Promise<WriterEntry> {
	if (entry.type === 'dir') return { path: entry.path, type: 'dir', mode: 0o755 };
	const { data, mode } = await entry.load();
	return { path: entry.path, type: 'file', mode, data, size: data.length };
}

/** Lazily loads each file; the first failure is kept so the TYPED refusal survives the stream. */
async function* bundleEntries(
	entries: readonly PlannedEntry[],
	failure: PackFailure,
): AsyncGenerator<WriterEntry> {
	try {
		for (const entry of entries) yield await materialize(entry);
	} catch (error) {
		failure.error = error;
		throw error;
	}
}

/** Write → re-hash on disk → rename. A failed pack leaves no file. */
async function packBundle(entries: readonly PlannedEntry[], target: string): Promise<string> {
	const tmp = `${target}.tmp-${randomUUID()}`;
	const failure: PackFailure = { error: null };
	try {
		const { stream, sha256 } = await writeBundle(bundleEntries(entries, failure));
		sha256.catch(() => undefined); // awaited below; never unhandled when the write fails first
		await Bun.write(tmp, new Response(stream));
		const declared = await sha256;
		const onDisk = await fileSha256(tmp);
		if (onDisk !== declared) {
			throw new ApiBundleError(
				'write_mismatch',
				`Publication API bundle refused (write_mismatch): writer ${declared}, on disk ${onDisk}`,
			);
		}
		await rename(tmp, target);
		return declared;
	} catch (error) {
		throw failure.error ?? error;
	} finally {
		await rm(tmp, { force: true });
	}
}

function v2DepsInputs(sources: readonly SourceFile[]): SourceFile[] {
	const inputs = sources.filter((source) => V2_DEPS_INPUTS.includes(source.rel));
	const missing = V2_DEPS_REQUIRED.filter((name) => !inputs.some((source) => source.rel === name));
	if (missing.length > 0) {
		const keys = missing.map((name) => `${apiTreePrefix('v2')}${name}`);
		throw new ApiBundleError(
			'lockfile_missing',
			`${refusalSentence('lockfile_missing', keys)} — v2's production dependencies cannot be installed frozen without them`,
			keys,
		);
	}
	return inputs;
}

async function buildV2Deps(
	ctx: BuildContext,
	sources: readonly SourceFile[],
	depsDir: string,
): Promise<PlannedEntry[]> {
	const inputs = v2DepsInputs(sources);
	await rm(depsDir, { recursive: true, force: true });
	await mkdir(depsDir, { recursive: true });
	for (const source of inputs) {
		const { data } = await readVerifiedSource(ctx.treeRoot, source);
		await writeFile(join(depsDir, source.rel), data);
	}
	await assertRegistryLockfile(depsDir);
	await ctx.installDeps(depsDir);
	return walkDeps(depsDir);
}

async function walkDeps(depsDir: string): Promise<PlannedEntry[]> {
	const top = await lstat(join(depsDir, 'node_modules')).catch(() => null);
	if (top === null || !top.isDirectory()) {
		throw new ApiBundleError(
			'deps_install_failed',
			'Publication API bundle refused (deps_install_failed): bun install produced no node_modules directory',
		);
	}
	const walk: DepsWalk = { out: [{ path: 'node_modules', type: 'dir' }], links: [], irregular: [] };
	await walkDir(depsDir, 'node_modules', walk);
	// The WHOLE tree is walked before refusing, and the refusal names every offender in
	// the writer's one order: `readdir` order is the filesystem's (APFS sorts, ext4 and
	// overlayfs hash), so refusing at the first hit named a different file per machine.
	if (walk.links.length > 0)
		throw bundleRefusal('deps_symlink', walk.links.sort(compareBundlePaths));
	if (walk.irregular.length > 0) {
		throw bundleRefusal('not_regular_file', walk.irregular.sort(compareBundlePaths));
	}
	return walk.out;
}

/**
 * The FILES of an installed `node_modules` under `depsDir` (paths relative to it, in walk order),
 * each with a read-time re-check (a link swapped in after the walk is refused). The same walk and
 * the same refusals as the v2 bundle (deps_symlink, not_regular_file, deps_install_failed), for
 * the publication-host kit (kit_build.ts), which installs the agent's dependencies this same way.
 */
export async function dependencyFiles(
	depsDir: string,
): Promise<{ path: string; load: () => Promise<{ data: Uint8Array; mode: number }> }[]> {
	const entries = await walkDeps(depsDir);
	return entries.flatMap((entry) =>
		entry.type === 'file' ? [{ path: entry.path, load: entry.load }] : [],
	);
}

/** What one walk of node_modules found: the entries to pack, and every path it must refuse. */
interface DepsWalk {
	out: PlannedEntry[];
	links: string[];
	irregular: string[];
}

async function walkDir(base: string, rel: string, walk: DepsWalk): Promise<void> {
	// Sorted so the traversal (and so `out`) is the same on every filesystem.
	for (const name of (await readdir(join(base, rel))).sort()) {
		const path = `${rel}/${name}`;
		if (BIN_DIR.test(path)) continue;
		await visit(base, path, walk);
	}
}

async function visit(base: string, path: string, walk: DepsWalk): Promise<void> {
	const info = await lstat(join(base, path));
	if (info.isSymbolicLink()) {
		walk.links.push(path);
		return;
	}
	if (info.isDirectory()) {
		walk.out.push({ path, type: 'dir' });
		return walkDir(base, path, walk);
	}
	if (!info.isFile()) {
		walk.irregular.push(path);
		return;
	}
	walk.out.push({ path, type: 'file', load: () => readDepFile(base, path) });
}

/**
 * THE PROVENANCE RULE, checked on the lockfile BEFORE the install: every package `bun.lock`
 * pins resolves from the registry (an exact version) AND carries an integrity hash. A
 * `file:`, `link:`, git, tarball-URL or local-tarball dependency ships bytes from outside
 * the registry — a `file:` one copies whatever sits at that path outside the verified tree.
 * Until 2026-11-02 this was caught only by accident: Bun 1.4.3 materialised a `file:`
 * dependency as symlinks (deps_symlink); Bun 1.4.4 hardlinks its files, which the walk
 * reads as regular files, and the bundle built. The rule is now about where the bytes come
 * from, not how Bun lays them out, and refuses before anything is fetched. The law itself
 * is `security/lockfile_provenance.ts`, the ONE copy the repo's own lockfiles are held to
 * as well (dependency_integrity_tripwire). Used by the v2 bundle and the publication-host
 * kit (kit_build.ts), both of which install from a `bun.lock` in `depsDir`. Returns how
 * many entries it checked, so a caller (and its gate) can floor the census.
 */
export async function assertRegistryLockfile(depsDir: string): Promise<number> {
	const packages = await readLockPackages(join(depsDir, 'bun.lock'));
	const unpinned: string[] = [];
	for (const [name, tuple] of Object.entries(packages)) {
		if (lockTupleProblems(tuple).length > 0) unpinned.push(`bun.lock:${name}`);
	}
	if (unpinned.length > 0) throw bundleRefusal('deps_unpinned', unpinned.sort(compareBundlePaths));
	return Object.keys(packages).length;
}

/** `bun.lock`'s `packages` map; an unreadable or packages-less lockfile is deps_install_failed. */
async function readLockPackages(path: string): Promise<Record<string, unknown>> {
	let read: ReturnType<typeof parseLockPackages>;
	try {
		read = parseLockPackages(await Bun.file(path).text());
	} catch (error) {
		read = { error: (error as Error).message };
	}
	if ('error' in read) {
		throw new ApiBundleError(
			'deps_install_failed',
			`Publication API bundle refused (deps_install_failed): bun.lock ${read.error}`,
			['bun.lock'],
		);
	}
	return read.packages;
}

/** The PINNED bun, frozen, in the build dir, minimal env; bounded by V2_DEPS_INSTALL_TIMEOUT_MS. */
export async function installV2DepsReal(depsDir: string): Promise<void> {
	const child = Bun.spawn([process.execPath, ...V2_DEPS_INSTALL_ARGS], {
		cwd: depsDir,
		env: v2DepsInstallEnv(depsDir),
		stdout: 'ignore',
		stderr: 'pipe',
		signal: AbortSignal.timeout(V2_DEPS_INSTALL_TIMEOUT_MS),
	});
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (code !== 0) {
		const signal = child.signalCode === null ? '' : `, ${child.signalCode}`;
		throw new ApiBundleError(
			'deps_install_failed',
			`Publication API bundle refused (deps_install_failed): bun install exited ${code}${signal}: ${tailLines(stderr)}`,
		);
	}
}

function tailLines(text: string): string {
	return text.trim().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
}

async function writeSidecar(path: string, sidecar: BundleSidecar): Promise<void> {
	const tmp = `${path}.tmp-${randomUUID()}`;
	await Bun.write(tmp, `${JSON.stringify(sidecar, null, '\t')}\n`);
	await rename(tmp, path);
}

async function readSidecar(path: string): Promise<unknown> {
	try {
		return JSON.parse(await Bun.file(path).text());
	} catch {
		return null;
	}
}

function sidecarMatches(
	raw: unknown,
	api: PublicationApi,
	release: string,
	digest: string,
): raw is BundleSidecar {
	const sidecar = (raw ?? {}) as Partial<BundleSidecar>;
	return [
		sidecar.version === 1,
		sidecar.api === api,
		sidecar.release === release,
		sidecar.digest === digest,
		SHA256_HEX.test(String(sidecar.sha256)),
	].every(Boolean);
}

/** A hit needs the sidecar's identity AND the bundle re-hashing to it; touched so prune keeps it. */
async function cachedBundle(
	paths: ApiBuildPaths,
	api: PublicationApi,
	release: string,
	digest: string,
): Promise<ApiBundle | null> {
	const sidecar = await readSidecar(paths.sidecar);
	if (!sidecarMatches(sidecar, api, release, digest)) return null;
	if (!(await Bun.file(paths.bundle).exists())) return null;
	if ((await fileSha256(paths.bundle)) !== sidecar.sha256) return null;
	const now = new Date();
	await utimes(paths.releaseDir, now, now);
	return { releaseId: release, file: paths.bundle, sha256: sidecar.sha256 };
}

function byAgeDesc(
	a: { name: string; mtimeMs: number },
	b: { name: string; mtimeMs: number },
): number {
	return b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);
}

async function releaseDirsByAge(buildRoot: string): Promise<string[]> {
	const names = (await readdir(buildRoot)).filter((name) => PUBLICATION_RELEASE_ID.test(name));
	const aged = await Promise.all(
		names.map(async (name) => ({ name, mtimeMs: (await stat(join(buildRoot, name))).mtimeMs })),
	);
	return aged.sort(byAgeDesc).map((entry) => entry.name);
}

/** Keep the newest API_BUNDLE_CACHE_KEEP release dirs (and always `keep`); other names (the install cache) untouched. */
async function pruneBuildCache(buildRoot: string, keep: string): Promise<void> {
	const doomed = (await releaseDirsByAge(buildRoot))
		.slice(API_BUNDLE_CACHE_KEEP)
		.filter((name) => name !== keep);
	for (const name of doomed) await rm(join(buildRoot, name), { recursive: true, force: true });
}
