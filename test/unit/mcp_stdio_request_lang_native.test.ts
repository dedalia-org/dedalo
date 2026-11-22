/**
 * THE STDIO MCP SERVER SPEAKS ITS SERVICE ACCOUNT'S LANGUAGES (owner ruling
 * 2026-11-22, R1).
 *
 * `src/ai/mcp/server.ts` used to open no request-lang scope, so every tool
 * default (`describe_section` / `list_sections` labels, `read_record`,
 * `search_section`, link targets) read `currentDataLang()`'s SCOPE-LESS
 * fallback — the install `DATA_LANG_DEFAULT` — whatever the account. The
 * ruling: each call runs in a scope seeded from the ACCOUNT's own langs,
 * resolved the way a web login of that account resolves them (the ONE seed,
 * `seedRequestLangs`, core/resolve/request_lang.ts). A web login stores no
 * per-account preference, so that is the seed's menu rung (`DEDALO_DATA_LANG`), which
 * is NOT `DATA_LANG_DEFAULT`.
 *
 * To tell the two apart this file is an ISOLATED GATE with `DEDALO_DATA_LANG` pinned
 * to lg-eng (`ISOLATED_GATE_ENV`, test/helpers/isolated_gate.ts — config is
 * read once at module load) while the suite's `DATA_LANG_DEFAULT` stays lg-spa;
 * the floor proves they differ and that the probed section's term differs in
 * the two, or a missing scope would be invisible.
 *
 * The call goes through the REAL server: `buildMcpServer` + the SDK's
 * in-memory transport + an MCP client — the same callback the stdio transport
 * drives, not the handler called directly. Principal: the superuser, read-only
 * (no write tools registered). Reads only: the repo-owned `test3` section node.
 */

import { describe, expect, test } from 'bun:test';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file needs DEDALO_DATA_LANG
// pinned at boot (ISOLATED_GATE_ENV) — in the tier's process it only MIRRORS a
// child run of itself; its body below registers in that child alone.
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
	const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
	const { config } = await import('../../src/config/config.ts');
	const { buildMcpServer, serviceAccountLangs } = await import('../../src/ai/mcp/server.ts');
	const { getTermByTipo } = await import('../../src/core/ontology/resolver.ts');
	const { seedRequestLangs } = await import('../../src/core/resolve/request_lang.ts');

	const SECTION = 'test3';
	const MENU = config.menu.dataLang;
	const MAIN = config.lang.dataLangDefault;

	/** One describe_section call through a real McpServer + MCP client. */
	const describeOverTheWire = async (): Promise<{ ok: boolean; data?: { label?: unknown } }> => {
		const server = buildMcpServer({ userId: -1, isGlobalAdmin: true, isDeveloper: true });
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'mcp-lang-gate', version: '0.0.1' });
		await server.connect(serverSide);
		await client.connect(clientSide);
		try {
			const result = await client.callTool({
				name: 'dedalo_describe_section',
				arguments: { section: SECTION },
			});
			return result.structuredContent as { ok: boolean; data?: { label?: unknown } };
		} finally {
			await client.close();
			await server.close();
		}
	};

	describe('floor: the situation can tell the account langs from the scope-less default', () => {
		test('DEDALO_DATA_LANG (pinned) ≠ DATA_LANG_DEFAULT', () => {
			expect(MENU).toBe('lg-eng');
			expect(MAIN).not.toBe(MENU);
		});

		test('test3 has a distinct term in both langs', async () => {
			const inMenu = await getTermByTipo(SECTION, MENU);
			const inMain = await getTermByTipo(SECTION, MAIN);
			expect(typeof inMenu).toBe('string');
			expect(typeof inMain).toBe('string');
			expect(inMenu).not.toBe(inMain);
		});
	});

	describe('the service account langs ARE the web-login seed', () => {
		test('= what a fresh web session (no stored lang, no pre-auth cookie) is served', () => {
			const freshWebSession = seedRequestLangs({
				session: { applicationLang: null, dataLang: null },
				preauthLang: null,
			});
			expect(serviceAccountLangs()).toEqual(freshWebSession);
			expect(serviceAccountLangs().dataLang).toBe(MENU);
		});
	});

	describe('a stdio tool default follows the account, not DATA_LANG_DEFAULT', () => {
		test('describe_section without lang: the label is the account data-lang term', async () => {
			const result = await describeOverTheWire();
			expect(result.ok).toBe(true);
			expect(result.data?.label).toBe(await getTermByTipo(SECTION, MENU));
			expect(result.data?.label).not.toBe(await getTermByTipo(SECTION, MAIN));
		});
	});
}
