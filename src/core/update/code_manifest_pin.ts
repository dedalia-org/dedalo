/**
 * THE CODE UPDATE'S MANIFEST, held by the SERVER (update audit 2026-10-29,
 * U-41; design §5 1.6).
 *
 * The panel asks the master for its manifest and posts the chosen item back
 * (`options.file` — version, url, sha256, channel, release). Until now the
 * engine checked the URL's origin and then verified the archive against the
 * sha256 THE BROWSER sent: the digest that decides what is installed was
 * server-to-server trust data relayed through a page. Now, before anything is
 * downloaded, the engine asks the selected master for the same manifest
 * ITSELF — same ask the panel makes (data version, release identity, channel)
 * — and the requested item must be one the master offers, at that URL, with
 * that sha256. The browser selects; the master's own answer authorizes.
 *
 * A manifest the engine cannot read refuses the update (fail closed). The
 * fetch is the guarded transport of this module's address policy:
 * `assertConfiguredMasterUrl` (the URL is EXACTLY a configured CODE_SERVERS
 * entry, never request text) then `fetchBoundedText` (outbound_fetch_tripwire).
 */

import { config } from '../../config/config.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { assertConfiguredMasterUrl } from '../ontology/ontology_manifest.ts';
import { fetchBoundedText } from '../security/ssrf_guard.ts';
import { RELEASE_IDENTITY } from './build_stamp.ts';
import type { CodeReleaseItem } from './code_manifest.ts';
import { refuseUpdate } from './refuse.ts';
import { type ReadWirePlans, readWirePlans } from './release_plans_wire.ts';
import { DEDALO_DATA_VERSION, formatVersion } from './version.ts';

const MANIFEST_TIMEOUT_MS = 60_000;
const MANIFEST_MAX_BYTES = 1024 * 1024;

/** The item the request names (what the browser posted back). */
export interface RequestedArchive {
	url: string;
	declaredSha: string;
	channel?: string | null;
}

/** One configured code master. */
export interface CodeMaster {
	url: string;
	code: string;
}

/**
 * Read the master's offered items for this install's ask; throws on any
 * failure. `requested` is passed for a test stand-in only (the production
 * reader never looks at it — the master's answer must not depend on the ask's
 * archive).
 */
export type CodeManifestReader = (
	master: CodeMaster,
	channel: string,
	requested: RequestedArchive,
) => Promise<readonly CodeReleaseItem[]>;

/** The channel token the panel sends for an item (code_update.js channel_token). */
function channelOf(item: RequestedArchive): string {
	return item.channel === 'dev' || item.channel === 'prerelease' ? item.channel : 'master';
}

/**
 * The production reader: POST `get_code_update_info` to the configured master
 * with the ask the panel makes, through the guarded transport.
 */
export const fetchCodeManifestItems: CodeManifestReader = async (master, channel) =>
	itemsOf(await fetchManifestText(master, channel));

/**
 * The master's manifest for this install's ask, read by the SERVER: its items
 * and the walk's release plans (release_plans_wire.ts) — what the update run
 * plans from. Throws on any failure, including a malformed `plans`.
 */
export async function fetchCodeManifest(
	master: CodeMaster,
	channel: string,
): Promise<{ items: readonly CodeReleaseItem[]; plans: ReadWirePlans }> {
	const text = await fetchManifestText(master, channel);
	const plans = readWirePlans((JSON.parse(text) as { data?: { plans?: unknown } }).data?.plans);
	if (plans === null) {
		throw new DedaloError('internal.invariant', {
			message: 'code manifest: the master answered malformed release plans',
		});
	}
	return { items: itemsOf(text), plans };
}

/** POST `get_code_update_info` to a configured master, through the guarded transport. */
async function fetchManifestText(master: CodeMaster, channel: string): Promise<string> {
	assertConfiguredMasterUrl(master.url, config.update.codeServers);
	const body = JSON.stringify({
		dd_api: 'dd_utils_api',
		action: 'get_code_update_info',
		options: {
			version: formatVersion(DEDALO_DATA_VERSION),
			release: RELEASE_IDENTITY.version,
			code: master.code,
			channel,
		},
	});
	return fetchBoundedText(master.url, {
		init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
		timeoutMs: MANIFEST_TIMEOUT_MS,
		maxBytes: MANIFEST_MAX_BYTES,
	});
}

/** An envelope-v2 manifest body → its `files`; throws on anything else. */
function itemsOf(text: string): readonly CodeReleaseItem[] {
	const envelope = JSON.parse(text) as { ok?: unknown; data?: { files?: unknown } };
	const files = envelope?.ok === true ? envelope.data?.files : undefined;
	if (!Array.isArray(files)) {
		throw new DedaloError('internal.invariant', {
			message: 'code manifest: the master answered no file list',
		});
	}
	return files as CodeReleaseItem[];
}

function sameUrl(a: string, b: string): boolean {
	try {
		return new URL(a).href === new URL(b).href;
	} catch {
		return false;
	}
}

/**
 * Refuse unless the master's OWN manifest offers `requested` — same URL, same
 * sha256. Called before the download; nothing is fetched but the manifest.
 */
export async function pinToMasterManifest(
	requested: RequestedArchive,
	master: CodeMaster,
	read: CodeManifestReader = fetchCodeManifestItems,
): Promise<void> {
	let items: readonly CodeReleaseItem[];
	try {
		items = await read(master, channelOf(requested), requested);
	} catch (error) {
		refuseUpdate(
			'update.refused',
			'Error. The code server’s release list could not be read — refusing to install an archive it has not confirmed',
			error,
		);
	}
	const offered = items.find((item) => sameUrl(item.url, requested.url));
	if (offered === undefined) {
		refuseUpdate(
			'update.refused',
			'Error. The code server does not offer that release to this installation',
		);
	}
	if (offered.sha256 !== requested.declaredSha) {
		refuseUpdate(
			'update.refused',
			'Error. The release checksum does not match the one the code server publishes — refusing to install',
		);
	}
}
