/**
 * Guards the one core edit for the site-builder feature: dd_tools_api.tool_request must
 * merge a tool's `body.streamHeaders` into the response stream headers (so an SSE
 * pass-through can set `X-Accel-Buffering: no`), while keeping the tool's declared
 * streamContentType. The tool dispatch is mocked so this is a focused test of the merge,
 * not of any real tool.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
// Imported BEFORE any mock.module, then SNAPSHOT by spread (the code_update.test.ts
// convention): the namespace object is a LIVE view that reflects the mock once installed,
// so afterAll must re-install the snapshot, not the namespace. mock.restore() alone does
// NOT revert module mocks (the dedalo-ts-testing rule) — without the re-install every
// later test file in a full-suite run would receive this file's fake dispatchToolRequest.
import * as realDispatchModule from '../../src/core/tools/dispatch.ts';

const REAL_DISPATCH_MODULE = { ...realDispatchModule };

const PRINCIPAL: Principal = { userId: 7, isGlobalAdmin: false, isDeveloper: true };

function contextWith(): ApiRequestContext {
	return {
		principal: PRINCIPAL,
		session: { userId: 7 } as ApiRequestContext['session'],
	} as ApiRequestContext;
}

afterAll(() => {
	mock.module('../../src/core/tools/dispatch.ts', () => REAL_DISPATCH_MODULE);
	mock.restore();
});

describe('dd_tools_api.tool_request stream-header merge', () => {
	test('merges the tool streamHeaders over the default Content-Type', async () => {
		mock.module('../../src/core/tools/dispatch.ts', () => ({
			...REAL_DISPATCH_MODULE,
			dispatchToolRequest: async () => ({
				result: true,
				msg: 'OK',
				stream: new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(new TextEncoder().encode('data: hi\n\n'));
						c.close();
					},
				}),
				streamContentType: 'text/event-stream; charset=utf-8',
				streamHeaders: { 'X-Accel-Buffering': 'no' },
			}),
		}));

		const { toolsApiActions } = await import('../../src/core/api/handlers/dd_tools_api.ts');
		const outcome = await toolsApiActions.tool_request!(
			{ source: { model: 'tool_sitebuilder', action: 'session_stream' }, options: {} } as never,
			contextWith(),
		);

		expect(outcome.stream).toBeInstanceOf(ReadableStream);
		expect(outcome.streamHeaders?.['Content-Type']).toBe('text/event-stream; charset=utf-8');
		expect(outcome.streamHeaders?.['X-Accel-Buffering']).toBe('no');
		// The stream body payload must not leak into the JSON body.
		expect((outcome.body as { stream?: unknown }).stream).toBeUndefined();
	});

	test('falls back to ndjson Content-Type when the tool declares no streamContentType', async () => {
		mock.module('../../src/core/tools/dispatch.ts', () => ({
			...REAL_DISPATCH_MODULE,
			dispatchToolRequest: async () => ({
				result: true,
				msg: 'OK',
				stream: new ReadableStream<Uint8Array>({
					start(c) {
						c.close();
					},
				}),
			}),
		}));

		const { toolsApiActions } = await import('../../src/core/api/handlers/dd_tools_api.ts');
		const outcome = await toolsApiActions.tool_request!(
			{ source: { model: 'tool_export', action: 'x' }, options: {} } as never,
			contextWith(),
		);
		expect(outcome.streamHeaders?.['Content-Type']).toBe('application/x-ndjson; charset=utf-8');
	});
});
