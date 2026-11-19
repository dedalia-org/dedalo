/**
 * Plumbing shared by the tool_uca_maps unit gates: the loaded tool and its
 * actions, a caller context on the generic `test` map record, readers for a
 * refusal or a success envelope, staged uploads and fixture binaries.
 */

import { expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { config } from '../../../../src/config/config.ts';
import { DedaloError } from '../../../../src/core/errors/index.ts';
import { requireTestMediaRoot } from '../../../../src/core/media/test_media_root.ts';
import { getLoadedTool } from '../../../../src/core/tools/loader.ts';
import type {
	ToolActionContext,
	ToolActionSpec,
	ToolServerModule,
} from '../../../../src/core/tools/module.ts';
import type { ReasonKey } from '../../../../tools/tool_uca_maps/server/reasons.ts';
import { mustGet } from '../../../helpers/assert.ts';

/** The map record every map-bound action names: test2's component_geolocation. */
export const MAP_RECORD = { section_tipo: 'test2', tipo: 'test52', section_id: 905101 } as const;

export async function loadTool(): Promise<ToolServerModule> {
	return mustGet(await getLoadedTool('tool_uca_maps'), 'tool_uca_maps').module;
}

export async function loadAction(name: string): Promise<ToolActionSpec> {
	return mustGet((await loadTool()).apiActions[name], name);
}

/**
 * A caller on MAP_RECORD; `options` may override any of its keys. `record: false`
 * leaves MAP_RECORD out (a refusal of a missing id must not get one), and
 * `admin: false` is a caller with no global grant.
 */
export function contextOf(
	options: Record<string, unknown> = {},
	userId = -1,
	{ record = true, admin = true }: { record?: boolean; admin?: boolean } = {},
): ToolActionContext {
	return {
		principal: { userId, isGlobalAdmin: admin, isDeveloper: admin },
		userId,
		options: record ? { ...MAP_RECORD, ...options } : options,
		background: false,
	};
}

/** The DedaloError a promise expected to reject carried. */
export async function failureOf(promise: Promise<unknown>): Promise<DedaloError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		return error as DedaloError;
	}
	throw new Error('expected a rejection');
}

/** What `run` threw, or undefined: the caller asserts its class and code. */
export function thrownBy(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

export function expectCode(error: unknown, code: DedaloError['code']): void {
	expect(error).toBeInstanceOf(DedaloError);
	expect((error as DedaloError).code).toBe(code);
}

/**
 * A refusal the user reads: its code, and the reason_key the browser turns into
 * the sentence they see (the message only goes to the log). `run` is a promise
 * expected to reject or a function expected to throw.
 */
export async function refusal(
	run: Promise<unknown> | (() => unknown),
	code: DedaloError['code'],
	reason: ReasonKey,
): Promise<DedaloError> {
	const error = typeof run === 'function' ? thrownBy(run) : await failureOf(run);
	expectCode(error, code);
	expect((error as DedaloError).details?.reason_key).toBe(reason);
	return error as DedaloError;
}

/** The envelope's `data` of a response that must be a success. */
export function dataOf<T = Record<string, unknown>>(response: unknown): T {
	expect((response as { ok: boolean }).ok).toBe(true);
	return (response as { data: T }).data;
}

/** All or none: a partial install would fail a gate instead of skipping it. */
export function haveGdal(...binaries: string[]): boolean {
	return binaries.every((binary) => Bun.which(binary) !== null);
}

/** The staging dir of a scratch uploader: each file picks user ids of its own. */
export function stagingOf(userId: number): string {
	return resolve(config.media.rootPath ?? '', config.media.upload.tmpSubdir, String(userId));
}

/** `bytes` staged as `name` for `userId` (under `keyDir`), where the upload door leaves a file. */
export function stageFile(
	userId: number,
	name: string,
	bytes: string | Uint8Array,
	keyDir = '',
): void {
	requireTestMediaRoot(config.media.rootPath ?? '', 'tool_uca_maps staged upload');
	const staging = resolve(stagingOf(userId), keyDir);
	mkdirSync(staging, { recursive: true });
	writeFileSync(resolve(staging, name), bytes);
}

/** `value` staged as JSON under `keyDir` for `userId` (contextOf's caller by
 * default): the `file_data` the action that reads that key_dir takes. */
export function stagedJson(
	keyDir: string,
	value: unknown,
	userId = -1,
): { key_dir: string; tmp_name: string } {
	const tmp_name = `payload_${crypto.randomUUID()}.geojson`;
	stageFile(userId, tmp_name, JSON.stringify(value), keyDir);
	return { key_dir: keyDir, tmp_name };
}

/**
 * A fixture binary run to exit 0, its stdout answered. The env is spread as
 * `spawn.ts` does: Bun.spawn's default misses a change made at run time.
 */
export async function runFixtureBinary(argv: string[]): Promise<string> {
	const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
	const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(code).toBe(0);
	return stdout;
}

/** `body` run in a fresh OS temp dir, removed afterwards. */
export async function withTempDir<T>(
	prefix: string,
	body: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	try {
		return await body(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
