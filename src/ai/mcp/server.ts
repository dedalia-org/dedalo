/**
 * Dédalo MCP server — exposes the ontology-typed read/search core to LLM tools
 * over the Model Context Protocol (REWRITE_SPEC §8, greenfield). This is a THIN
 * transport shell: every tool comes from the shared registry (registry.ts) and
 * delegates to the pure, ACL-gated handlers in tools/*.ts. The server itself
 * holds no business logic and no privilege — it takes ONE service identity at
 * startup (from DEDALO_MCP_USER_ID) and runs every tool call under it, so the
 * MCP surface can never see more than the configured Dédalo user would through
 * the web client.
 *
 * THE IDENTITY IS FIXED; THE GRANTS ARE NOT. `DEDALO_MCP_USER_ID` names the user
 * for the life of the process and no tool can change it — but WHAT that user may
 * do is re-asked on every call (`currentServicePrincipal`), because this process
 * is long-lived and holds no session. A revocation reaches a web client by ending
 * its sessions; there is nothing here to end, so a deactivated, deleted or
 * downgraded service account would otherwise keep its startup grants until an
 * operator happened to restart the server.
 *
 * Run it (stdio transport, the MCP default for a locally-spawned server):
 *   DEDALO_MCP_USER_ID=<dd128 section_id> bun run src/ai/mcp/server.ts
 *   # add DEDALO_MCP_ALLOW_WRITE=true to also register the write tools
 *   # optionally DEDALO_MCP_WRITE_SECTIONS=oh1,rsc25 to allowlist writable sections
 *
 * Security posture: the principal is server-authoritative and fixed for the
 * process lifetime; there is no tool to change identity. The server is
 * READ-ONLY unless DEDALO_MCP_ALLOW_WRITE=true explicitly registers the write
 * tools (which enforce the same level>=2 permission gate as the human API and
 * audit every change in the Time Machine). A misconfigured or missing
 * DEDALO_MCP_USER_ID is a hard startup error — the server never silently
 * falls back to a privileged identity.
 *
 * WRITE MODE requires a LEAST-PRIVILEGE principal: because the same LLM also
 * reads untrusted, lower-trust record data, a prompt injected into that data
 * could steer a write/delete (a confused deputy). If the write tools ran under
 * an ambient global-admin/superuser they would execute those under full
 * authority. So write mode is REFUSED for a global-admin principal (a hard
 * error) and can be further narrowed to an allowlist of writable sections
 * (DEDALO_MCP_WRITE_SECTIONS). The superuser (-1) is fine for READ-ONLY.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readEnv } from '../../config/env.ts';
import { readOptionalList } from '../../config/readers.ts';
import { toStructuredErr } from '../../core/errors/convert.ts';
import { DedaloError } from '../../core/errors/dedalo_error.ts';
import {
	type RequestLangs,
	runWithRequestLangs,
	seedRequestLangs,
} from '../../core/resolve/request_lang.ts';
import { readAccountStateById } from '../../core/security/auth.ts';
import { resolvePrincipal } from '../../core/security/permissions.ts';
import { asToolResult } from './envelope.ts';
import { type RegistryGates, registeredTools, runTool } from './registry.ts';
import { STRUCTURED_OUTPUT_SHAPE } from './tool_spec.ts';

/** Options for buildMcpServer. */
export interface McpServerOptions {
	/**
	 * Register the WRITE tools (save/create/delete). Default false — the server
	 * is read-only unless the deployment explicitly opts in via
	 * DEDALO_MCP_ALLOW_WRITE=true (fail-closed). REFUSED (throws) when the
	 * principal is a global admin — write mode demands a least-privilege user.
	 */
	allowWrite?: boolean;
	/**
	 * When non-empty, write tools may ONLY target these section tipos (an
	 * allowlist checked before the per-record permission gate). Sourced from
	 * DEDALO_MCP_WRITE_SECTIONS; empty/undefined ⇒ no extra section restriction.
	 */
	writableSections?: Set<string>;
}

/**
 * Build the MCP server for a given principal. Exposed as a function (rather than
 * run at import) so tests can construct a server with a test principal and so
 * the identity resolution stays explicit and injectable.
 */
export function buildMcpServer(
	principal: {
		userId: number;
		isGlobalAdmin: boolean;
		isDeveloper: boolean;
	},
	options: McpServerOptions = {},
): McpServer {
	// SECURITY INVARIANT (confused-deputy defense): write mode must run under a
	// LEAST-PRIVILEGE user, never an ambient global-admin/superuser. The agent
	// also ingests untrusted record data, so a prompt injected there could drive
	// a write/delete; under a broad principal that would execute with full
	// authority. Refuse to register write tools rather than widen access.
	if (options.allowWrite === true && principal.isGlobalAdmin) {
		throw new Error(
			'DEDALO_MCP_ALLOW_WRITE refused: the MCP service principal is a global admin/superuser. ' +
				'Write mode requires a scoped, least-privilege dd128 user — set DEDALO_MCP_USER_ID to a ' +
				'non-admin user carrying exactly the grants the agent needs.',
		);
	}

	const server = new McpServer({
		name: 'dedalo-core',
		version: '0.0.1',
	});

	const gates: RegistryGates = {
		allowWrite: options.allowWrite === true,
		writableSections: options.writableSections,
	};

	for (const spec of registeredTools(gates)) {
		server.registerTool(
			spec.name,
			{
				title: spec.title,
				description: spec.description,
				inputSchema: spec.inputShape,
				outputSchema: STRUCTURED_OUTPUT_SHAPE,
				annotations: spec.annotations,
			},
			// A refused call (permission, scope, allowlist) comes back as a
			// structured {ok:false, error} envelope with a model-facing hint —
			// never a transport-level crash the model cannot act on.
			//
			// Every call runs inside the SERVICE ACCOUNT's request-lang scope (owner
			// ruling 2026-11-22): a tool default (`describe_section` labels,
			// `read_record`, `search_section`, link targets) follows the account's
			// langs, exactly as the same account's web session would — not the
			// scope-less DATA_LANG_DEFAULT fallback.
			async (args: Record<string, unknown>) =>
				runWithRequestLangs(serviceAccountLangs(), async () => {
					const current = await currentServicePrincipal(principal, gates);
					if (current instanceof DedaloError) return asToolResult(toStructuredErr(current));
					return asToolResult(await runTool(spec, current, args, gates));
				}),
		);
	}

	return server;
}

/**
 * THE SERVICE ACCOUNT'S REQUEST LANGUAGES — resolved the way a web login of the
 * same account resolves them, through the ONE seed (`seedRequestLangs`,
 * core/resolve/request_lang.ts), never a copy of it.
 *
 * A web login stores NO per-account language preference: the session's lang
 * columns start NULL (session_store.ts `createSession`) and the only thing a
 * login adopts is the browser's pre-auth cookie, which a stdio process does not
 * have. So the account's langs are the seed's last rung — the install MENU
 * langs (`DEDALO_APPLICATION_LANG` / `DEDALO_DATA_LANG`) — which is exactly what that
 * account's fresh web session is served. When a stored per-account preference
 * exists (an owner decision: no store is defined today), it enters HERE (as the
 * seed's `session` rung), and both doors keep agreeing through the seed.
 *
 * Exported for its gate: test/unit/mcp_stdio_request_lang_native.test.ts.
 */
export function serviceAccountLangs(): RequestLangs {
	return seedRequestLangs({ session: null, preauthLang: null });
}

/**
 * RE-ASK THE SERVICE ACCOUNT'S STANDING, once per tool call.
 *
 * Three transitions have to reach this surface, and none of them can arrive by the
 * usual route — ending the account's sessions — because a stdio server has none:
 *
 *   deactivated (dd131 = No)  the login door refuses it; so must this one, or the
 *                             operator's one non-destructive revocation is a no-op here.
 *   deleted (record absent)   the account no longer exists; its grants must not outlive
 *                             it just because a process cached them.
 *   promoted to global admin  the write-mode confused-deputy refusal is enforced at
 *                             BUILD time. A user granted dd244 after startup would slip
 *                             past it, which is the one direction that refusal exists to
 *                             stop, so it is re-checked here too.
 *
 * `resolvePrincipal` is cached and the cache is cleared by the write seam
 * (`clearPrincipalCache`, permissions.ts), so a re-ask normally costs nothing; the dd131
 * read is one indexed row. Returns the refusal rather than throwing: a transport-level
 * crash gives the model nothing it can act on, and `toStructuredErr` is the same
 * converter every other MCP refusal goes through.
 *
 * Exported for its gate: test/unit/account_revocation_native.test.ts drives it against
 * a real deactivated and a real deleted account (GATE-24 — an authorization decision may
 * not rest on a source-substring assertion).
 */
export async function currentServicePrincipal(
	startup: { userId: number; isGlobalAdmin: boolean; isDeveloper: boolean },
	gates: RegistryGates,
): Promise<{ userId: number; isGlobalAdmin: boolean; isDeveloper: boolean } | DedaloError> {
	const state = await readAccountStateById(startup.userId);
	if (state === 'absent' || state === 'inactive') {
		return new DedaloError('perm.denied', {
			publicMessage:
				state === 'absent'
					? 'The MCP service account no longer exists. Point DEDALO_MCP_USER_ID at a live dd128 user and restart the server.'
					: "The MCP service account is deactivated (dd131 'Active account' = No). Reactivate it, or point DEDALO_MCP_USER_ID at another user.",
			coordinates: { user_id: startup.userId },
		});
	}
	const current = await resolvePrincipal(startup.userId);
	if (gates.allowWrite === true && current.isGlobalAdmin) {
		return new DedaloError('perm.denied', {
			publicMessage:
				'The MCP service account has become a global admin while the server was running. Write mode requires a least-privilege user (confused-deputy defense) and is refused until the grant is removed or the server is restarted read-only.',
			coordinates: { user_id: startup.userId },
		});
	}
	return current;
}

/**
 * Resolve the configured service principal from the environment. Hard-fails on a
 * missing/invalid DEDALO_MCP_USER_ID rather than defaulting to a privileged
 * identity — a fail-closed startup, per §7's "never silently widen access".
 */
async function resolveServicePrincipal() {
	// readEnv, NOT process.env: the documented precedence includes
	// ../private/.env (audit S2-21) — a raw read silently drops that half.
	const raw = readEnv('DEDALO_MCP_USER_ID');
	if (raw === undefined || raw.trim() === '') {
		throw new Error(
			'DEDALO_MCP_USER_ID is required: the MCP server runs every tool as this Dédalo user. ' +
				'Set it to a dd128 user section_id (or -1 for the superuser in trusted local dev — ' +
				'READ-ONLY only; write mode refuses a global-admin/superuser principal).',
		);
	}
	const userId = Number(raw);
	if (!Number.isInteger(userId)) {
		throw new Error(`DEDALO_MCP_USER_ID must be an integer user id, got: ${raw}`);
	}
	return resolvePrincipal(userId);
}

// Entry point: only run the stdio transport when invoked directly (not on import
// from a test). Bun sets import.meta.main for the entry module.
if (import.meta.main) {
	const principal = await resolveServicePrincipal();
	// Write tools require the explicit opt-in; anything else is read-only.
	const allowWrite = readEnv('DEDALO_MCP_ALLOW_WRITE') === 'true';
	// readList, NOT a hand-rolled readEnv().split(','): the key is declared
	// `string_list` in the catalog, whose grammar is a JSON array OR a comma
	// list. The v6->v7 migration JSON-encodes v6 PHP arrays, so a raw split
	// would shred `["oh1","rsc25"]` into tokens matching no section tipo —
	// this allowlist would silently narrow to nothing.
	// readOptionalList, not readList: it is the ONLY reader that tells UNSET
	// (null -> no narrowing) apart from PRESENT-BUT-EMPTY ([] -> nothing
	// writable). Collapsing the two would silently open every section.
	const configuredSections = readOptionalList('DEDALO_MCP_WRITE_SECTIONS');
	const writableSections = configuredSections === null ? undefined : new Set(configuredSections);
	const server = buildMcpServer(principal, { allowWrite, writableSections });
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
