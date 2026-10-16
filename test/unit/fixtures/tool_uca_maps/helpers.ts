/**
 * Plumbing shared by the tool_uca_maps unit gates: the loaded tool and its
 * actions, a caller context on the generic `test` map record, and readers for
 * a refusal or a success envelope.
 */

import { expect } from 'bun:test';
import { DedaloError } from '../../../../src/core/errors/index.ts';
import { getLoadedTool } from '../../../../src/core/tools/loader.ts';
import type {
	ToolActionContext,
	ToolActionSpec,
	ToolServerModule,
} from '../../../../src/core/tools/module.ts';
import { mustGet } from '../../../helpers/assert.ts';

/** The map record every map-bound action names: test2's component_geolocation. */
export const MAP_RECORD = { section_tipo: 'test2', tipo: 'test52', section_id: 905101 } as const;

export async function loadTool(): Promise<ToolServerModule> {
	return mustGet(await getLoadedTool('tool_uca_maps'), 'tool_uca_maps').module;
}

export async function loadAction(name: string): Promise<ToolActionSpec> {
	return mustGet((await loadTool()).apiActions[name], name);
}

/** An admin caller on MAP_RECORD; `options` may override any of its keys. */
export function contextOf(options: Record<string, unknown> = {}, userId = -1): ToolActionContext {
	return {
		principal: { userId, isGlobalAdmin: true, isDeveloper: true },
		userId,
		options: { ...MAP_RECORD, ...options },
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

export function expectCode(error: unknown, code: DedaloError['code']): void {
	expect(error).toBeInstanceOf(DedaloError);
	expect((error as DedaloError).code).toBe(code);
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
