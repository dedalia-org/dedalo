/**
 * THE PUBLICATION-HOST WIRE VOCABULARY — the ONE mapping from an agent answer, or an
 * engine-side refusal about a host, onto the registered `publication_host.*` codes
 * (src/core/errors/registry.ts; phase-3 plan E7; PUBLICATION_HOST_SPEC §2).
 *
 * The agent (publication/host_agent) answers every failure as RFC 9457 problem+json with a
 * stable `type` and, for every refusal it can name, a machine `reason` from a CLOSED list
 * (its src/errors.ts REASON_CODES ∪ RELEASE_REFUSAL_REASONS). This module branches on the
 * HTTP status and that reason — never on prose.
 *
 * TWO KINDS OF SENTENCE, the same boundary as tools/tool_sitebuilder/server/wire.ts:
 *  - the agent's `detail` is ANOTHER SERVICE'S prose. It is LOG-ONLY: it goes in the throw's
 *    `message` (capped, flattened to one line) and never into `publicMessage`;
 *  - the sentence a person reads for a refusal is written HERE (AGENT_REASON_SENTENCES for an
 *    agent reason, ENGINE_REASON_SENTENCES for the engine's own) and rides `publicMessage`
 *    only on `publication_host.rejected` (the one public-disclosure code of the family).
 *
 * THE REASON ON THE WIRE. `rejected` and `failed` carry `details.reason` because the client
 * renders the LABEL first (render_api_error.js error_text) and the label says which refusal
 * it was. The value is always a member of DETAIL_REASONS — an agent can never put text of
 * its own in it, and never an engine reason either (agentReason reads the agent table only).
 * Their label has a `${reason}` placeholder, so they are minted ONLY here:
 * agentResponseError, engineFailure, engineRefusal. hostError's type excludes both, and
 * publication_host_wire_native holds the source law (no other file spells either literal;
 * AGENT_ANSWER_CODES is read only by declared classifiers that construct no DedaloError).
 *
 * THE AGENT TABLE IS A TWIN. AGENT_REASON_SENTENCES' key set must EQUAL the agent's closed
 * lists; the gate imports the agent's errors.ts and fails on any difference. The engine
 * table is disjoint from it, by the same gate.
 *
 * A leaf: imports only the error pair. Coordinates (host name, agent status/reason) are
 * LOG-ONLY; no secret ever reaches this module (callers pass names, never tokens).
 */

import { DedaloError } from '../errors/dedalo_error.ts';
import type { ErrorCode } from '../errors/registry.ts';

export type PublicationHostCode = Extract<ErrorCode, `publication_host.${string}`>;

/** The two codes whose label needs `${reason}`: minted only by this module. */
export type AgentAnswerCode = 'publication_host.rejected' | 'publication_host.failed';

/** The codes an engine-side site may throw through hostError. */
export type HostErrorCode = Exclude<PublicationHostCode, AgentAnswerCode>;

/** The whole family, in registry order (the gate holds it equal to the registry's prefix set). */
export const PUBLICATION_HOST_CODES = Object.freeze([
	'publication_host.unconfigured',
	'publication_host.registry_invalid',
	'publication_host.unreachable',
	'publication_host.timeout',
	'publication_host.pairing_mismatch',
	'publication_host.auth',
	'publication_host.rejected',
	'publication_host.failed',
	'publication_host.busy',
] as const satisfies readonly PublicationHostCode[]);

/**
 * The two answer codes, for CLASSIFICATION only (host_status.ts maps "the agent answered
 * after the proof"). A reader of this constant may not construct a DedaloError — the
 * source law in publication_host_wire_native keeps the readers declared and minting-free.
 */
export const AGENT_ANSWER_CODES = Object.freeze([
	'publication_host.rejected',
	'publication_host.failed',
] as const satisfies readonly AgentAnswerCode[]);

/** The agent's problem+json fields this module reads. Every field is agent-supplied text. */
export interface AgentProblem {
	type?: string;
	detail?: string;
	reason?: string;
	bundle_reason?: string;
	store_reason?: string;
}

/** What an engine-side throw may add: a LOG line, a cause, LOG-only coordinates. */
export interface HostErrorFields {
	message?: string;
	cause?: unknown;
	coordinates?: Readonly<Record<string, string | number>>;
}

/**
 * The `stage` coordinate of a failure minted BEFORE anything was dialled (the registry lock,
 * the local token-vs-registry pairing check). The panel reads it (host_status
 * statusOutcomeFromError) so such a failure never renders as "the agent answered".
 */
export const LOCAL_STAGE = 'local';

/** Why the engine itself refuses an agent's 2xx answer (→ `failed`). */
export type EngineFailureReason = 'body_cap' | 'unreadable_body';
/** Why the engine refuses to send a request at all (→ `rejected`). */
export type EngineRefusalReason = 'input_invalid';

/** The value `details.reason` takes when the agent named no reason, or one outside its closed list. */
const UNSPECIFIED = 'unspecified';

/** Longest agent-supplied text that reaches a LOG line. */
const LOG_TEXT_CAP = 300;

/**
 * WHAT A PERSON READS FOR EACH AGENT REASON — engine-authored, one per member of the agent's
 * closed lists (twin-gated). Used as `publicMessage` only when the code is `rejected`; for
 * `failed`/`busy` the label (with `${reason}`) is the text, and the sentence stays here as the
 * documented meaning of the reason.
 */
export const AGENT_REASON_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
	actor_missing:
		'The publication host refused a request that did not name the acting user. This is a fault of this server; nothing was changed.',
	body_invalid: 'The publication host could not read the request it was sent. Nothing was changed.',
	bundle_refused:
		'The publication host refused the release bundle: its contents failed the shape check. The previous release still serves.',
	hash_mismatch:
		'The publication host received content that does not match its checksum (the media rules against their hash stamp, or a media file against its sha256). Nothing was changed.',
	release_id_invalid:
		'The publication host refused the release name it was sent. Nothing was changed.',
	no_previous_release: 'There is no previous release on the publication host to return to.',
	configtest_failed:
		"The publication host's web server rejected the media rules in its configuration test. The previous rules remain active.",
	reload_failed:
		'The web server on the publication host refused to reload. An operator must inspect it on that host.',
	restart_failed:
		'The publication API service on the publication host could not be restarted. An operator must inspect it on that host.',
	health_failed:
		'The new release failed its health check after the switch, and the publication host returned to the previous release.',
	v2_env_missing:
		"The publication host is missing the publication API's environment file. An operator must create it on that host.",
	busy: 'The publication host is already carrying out an operation of this kind. Try again when it finishes.',
	server_mismatch:
		'The media rules were rendered for a different web server than the one the publication host runs. Nothing was changed.',
	hash_invalid: 'The publication host refused the rules hash it was sent. Nothing was changed.',
	rules_too_large:
		'The media rules exceed the size the publication host accepts. Nothing was changed.',
	rules_nul_byte:
		'The media rules contain a byte the publication host refuses. Nothing was changed.',
	stamp_missing:
		'The media rules carry no hash stamp, so the publication host refused them. Nothing was changed.',
	directive_refused:
		'The media rules contain a directive the publication host does not allow. Nothing was changed.',
	sha_mismatch:
		'The release bundle the publication host received does not match its checksum. The previous release still serves.',
	release_unverified:
		'The publication host cannot verify the release involved, so it refused to switch to it. The current release still serves.',
	shared_config_missing:
		"The publication host is missing the publication API's shared configuration. An operator must create it on that host; the previous release still serves.",
	shared_config_exposed:
		"The publication API's shared configuration on the publication host is readable by other accounts, so the host refused the release. An operator must restrict it to its owner on that host; the previous release still serves.",
	api_not_served:
		'This publication host does not serve the Publication API v1 (it is a v2-only site), so it refused the v1 release. Nothing was changed.',
	php_lint_failed:
		'A PHP file in the release failed the syntax check on the publication host. The previous release still serves.',
	node_modules_missing:
		'The release bundle lacks its dependencies, which the publication host never installs itself. The previous release still serves.',
	scratch_health_failed:
		'The new release did not answer its health check when started on the side. The previous release still serves.',
	rollback_unhealthy:
		'The new release failed its health check, and the previous release failed it too after the return. An operator must act on the publication host now.',
	no_current_release: 'There is no current release on the publication host for that API.',
	store_refused:
		"The publication host's release store is not in a state it can change safely. An operator must inspect it on that host.",
	trust_failed:
		"The publication host's application allowlist (fapolicyd) did not admit the release, so it never ran. An operator must inspect the trust record on that host; the previous release still serves.",
	scratch_start_failed:
		'The publication host could not start the new release on the side for its health check. An operator must inspect the service manager on that host; the previous release still serves.',
	scratch_stop_failed:
		'The publication host could not stop the side copy of the new release after its health check. An operator must inspect the service manager on that host.',
	// copy-mode media commands (publication/host_agent/src/media/copy.ts)
	media_mode:
		'This publication host is not in copy mode: it takes no media copy. Nothing was changed.',
	media_path_refused:
		'The publication host refused a media path (outside its copy root, or not a public media file). Nothing was changed.',
	size_mismatch:
		'The publication host received a different number of bytes than announced. Nothing was replaced.',
	key_unpublished:
		'The publication host refused a media file whose record is not marked published there. Nothing was changed.',
	key_invalid:
		'The publication host refused a publication marker key outside the media grammar. Nothing was changed.',
	media_level_foreign:
		"A folder under the publication host's media copy is owned by another user and its permissions do not fit: published folders must be open to the web server, the agent's own working folder closed to others. The agent never changes a folder it does not own, so an operator must fix that folder's owner or permissions on the host. Nothing was copied.",
	// the host web lock around every configtest and reload (publication/host_agent/src/rules/apply.ts)
	host_busy:
		'Another configuration test or reload is running on the publication host. Try again when it finishes; nothing was changed.',
	host_lock_missing:
		"The publication host's shared web-server lock is missing. An operator must run 'provision apply' for this instance on that host; nothing was changed.",
	// rules.map, the host-wide nginx media map (publication/host_agent/src/rules/map.ts)
	map_unmanaged:
		"This publication host's nginx media map is placed by hand, not managed by the publication host. An operator keeps it current on that host; nothing was changed.",
	map_refused:
		'The publication host refused the nginx media map: it is not in the shape the host accepts. Nothing was changed.',
	map_contribution_foreign:
		"The publication host found this instance's media map contribution owned by another account. An operator must run 'provision apply' for this instance on that host; nothing was changed.",
	map_contribution_newer:
		"Another instance on the publication host contributes a newer media map than the host's map renderer understands, so the shared map was left as it is. An operator must run 'provision apply' for that newer instance on the host.",
	map_envelope_rebind:
		"The media folders changed since this instance's media map was first accepted on the publication host. The previous map stays in force until an operator runs 'provision apply' for this instance on that host.",
	map_renderer_missing:
		"The publication host's media map renderer is not installed, or does not know this instance. An operator must run 'provision apply' for this instance on that host; nothing was changed.",
});

/**
 * THE ENGINE'S OWN REASONS — disjoint from the agent's (gated). `input_invalid` is the public
 * sentence of engineRefusal; the two failure reasons ride `failed`'s label.
 */
export const ENGINE_REASON_SENTENCES: Readonly<
	Record<EngineFailureReason | EngineRefusalReason, string>
> = Object.freeze({
	body_cap:
		'The publication host sent an answer larger than this server accepts, so this server stopped reading it.',
	unreadable_body:
		'The publication host answered with a body this server cannot read. Check that the agent and this server run matching versions.',
	input_invalid:
		'This server refused to send a request it could not build correctly. Nothing was sent to the publication host.',
});

/** Every value `details.reason` can take on `rejected` / `failed`. */
export const DETAIL_REASONS: ReadonlySet<string> = new Set([
	...Object.keys(AGENT_REASON_SENTENCES),
	...Object.keys(ENGINE_REASON_SENTENCES),
	UNSPECIFIED,
]);

/** Fixed status → code (the rest is derived from the status class). */
const STATUS_CODES: Readonly<Record<number, PublicationHostCode>> = Object.freeze({
	401: 'publication_host.auth',
	403: 'publication_host.auth',
	404: 'publication_host.failed',
	405: 'publication_host.failed',
});

/**
 * REASON BEFORE STATUS: the reasons whose code does not depend on the status that carried
 * them. `busy` is retryable; the copy-mode refusals (publication/host_agent/src/media/copy.ts)
 * are refusals a retry cannot fix — a 409 `key_unpublished` / `media_mode` is never the
 * transient `busy`, and no status turns one into `failed`.
 */
const REASON_CODES: Readonly<Record<string, PublicationHostCode>> = Object.freeze({
	busy: 'publication_host.busy',
	// a configtest or reload of another instance holds the host web lock: retryable, like busy
	host_busy: 'publication_host.busy',
	media_mode: 'publication_host.rejected',
	media_path_refused: 'publication_host.rejected',
	size_mismatch: 'publication_host.rejected',
	hash_mismatch: 'publication_host.rejected',
	key_unpublished: 'publication_host.rejected',
	key_invalid: 'publication_host.rejected',
	media_level_foreign: 'publication_host.rejected',
});

/** Agent-supplied text for a LOG line: control characters flattened, capped. Never for the wire. */
export function capLogText(text: string | undefined): string {
	const flat = (text ?? '').replace(/\p{Cc}+/gu, ' ').trim();
	return flat.length > LOG_TEXT_CAP ? `${flat.slice(0, LOG_TEXT_CAP - 1)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' ? value : undefined;
}

function pickProblem(record: Record<string, unknown>): AgentProblem {
	return {
		type: stringField(record, 'type'),
		detail: stringField(record, 'detail'),
		reason: stringField(record, 'reason'),
		bundle_reason: stringField(record, 'bundle_reason'),
		store_reason: stringField(record, 'store_reason'),
	};
}

/** The agent's problem body. Never throws: a non-JSON or non-object body is `{}`. */
export function parseAgentProblem(text: string): AgentProblem {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? pickProblem(parsed) : {};
	} catch {
		return {};
	}
}

/** The agent's machine reason if it is a member of the AGENT closed list, else 'unspecified'. */
export function agentReason(problem: AgentProblem): string {
	const reason = problem.reason;
	return typeof reason === 'string' && Object.hasOwn(AGENT_REASON_SENTENCES, reason)
		? reason
		: UNSPECIFIED;
}

function codeForStatus(status: number): PublicationHostCode {
	const fixed = STATUS_CODES[status];
	if (fixed !== undefined) return fixed;
	return status >= 400 && status < 500 ? 'publication_host.rejected' : 'publication_host.failed';
}

/**
 * A non-2xx agent answer → its code. A REASON_CODES reason wins over the status (`busy`, the
 * copy-mode refusals); otherwise 401/403 are credentials; 404/405 behind a valid bearer are
 * version skew (`failed`); any other 4xx is a refusal of the request's content (`rejected`);
 * the rest is `failed`. MODULE-PRIVATE:
 * its value can be an answer code, and only agentResponseError may pair it with a reason
 * (publication_host_wire_native source law).
 */
function codeForAgentResponse(status: number, problem: AgentProblem): PublicationHostCode {
	const reason = problem.reason;
	if (typeof reason === 'string' && Object.hasOwn(REASON_CODES, reason))
		return REASON_CODES[reason] as PublicationHostCode;
	return codeForStatus(status);
}

function publicSentence(code: PublicationHostCode, reason: string): string | undefined {
	return code === 'publication_host.rejected' ? AGENT_REASON_SENTENCES[reason] : undefined;
}

/**
 * A non-2xx agent answer → the typed refusal. The agent's `detail` (and a bundle/store
 * sub-reason) go to the log-only `message`; the wire gets the registry English, the engine
 * sentence (rejected only) and the closed `reason`.
 */
export function agentResponseError(
	hostName: string,
	status: number,
	bodyText: string,
): DedaloError {
	const problem = parseAgentProblem(bodyText);
	const code = codeForAgentResponse(status, problem);
	const reason = agentReason(problem);
	const sub = capLogText(problem.bundle_reason ?? problem.store_reason);
	return new DedaloError(code, {
		message: `publication host '${hostName}': agent answered ${status} (${reason}${sub === '' ? '' : `/${sub}`}): ${capLogText(problem.detail)}`,
		details: { reason },
		publicMessage: publicSentence(code, reason),
		coordinates: { publication_host: hostName, agent_status: status, agent_reason: reason },
	});
}

/**
 * Is `error` the agent's refusal (`rejected`) for the closed agent `reason`? The one reader
 * of an answer error's reason (agentResponseError writes it), so no caller spells the code.
 */
export function isAgentRefusal(error: unknown, reason: string): boolean {
	return (
		error instanceof DedaloError &&
		error.code === 'publication_host.rejected' &&
		error.coordinates?.agent_reason === reason
	);
}

/** The engine refuses an agent's 2xx answer (oversized, unreadable): `failed` + the engine reason. */
export function engineFailure(
	hostName: string,
	reason: EngineFailureReason,
	fields: HostErrorFields = {},
): DedaloError {
	return new DedaloError('publication_host.failed', {
		message: fields.message,
		cause: fields.cause,
		details: { reason },
		coordinates: { ...fields.coordinates, publication_host: hostName, reason },
	});
}

/** The engine refuses to send a request (bad input): `rejected` + its own public sentence. */
export function engineRefusal(
	hostName: string,
	reason: EngineRefusalReason,
	fields: HostErrorFields = {},
): DedaloError {
	return new DedaloError('publication_host.rejected', {
		message: fields.message,
		cause: fields.cause,
		details: { reason },
		publicMessage: ENGINE_REASON_SENTENCES[reason],
		coordinates: { ...fields.coordinates, publication_host: hostName, reason },
	});
}

/**
 * An engine-side refusal about a host (transport, pairing, missing registration/secrets).
 * `message` is the LOG line (an errno, an address) — never the wire; the host name and any
 * extra coordinates are log-only. The host name always wins over a caller's coordinate.
 */
export function hostError(
	code: HostErrorCode,
	hostName: string,
	fields: HostErrorFields = {},
): DedaloError {
	return new DedaloError(code, {
		message: fields.message,
		cause: fields.cause,
		coordinates: { ...fields.coordinates, publication_host: hostName },
	});
}

/**
 * A registry load/save that refused (Task 1's RegistryError.reason). A held lock clears by
 * itself (`busy`); every other fault means the file cannot be trusted (`registry_invalid`) —
 * never "no hosts" (Review Focus 2).
 */
export function registryError(reason: string): DedaloError {
	const code = reason === 'locked' ? 'publication_host.busy' : 'publication_host.registry_invalid';
	const safe = capLogText(reason);
	return new DedaloError(code, {
		message: `publication host registry refused: ${safe}`,
		coordinates: { registry_reason: safe, stage: LOCAL_STAGE },
	});
}
