/**
 * publication_hosts — "New publication host": the panel half of the guided install
 * (engineering/PUBLICATION_HOST_SPEC.md §9.14; WC-2026-10-09-publication-host-panel-setup).
 * The actions below are wired into the publication_hosts widget (publication_hosts.ts); this
 * module holds them so that widget stays the paired hosts' view.
 *
 *   propose_draft   the form's starting values for a domain (init's own proposals, drafts.ts)
 *   save_draft      judge a draft with the agent's zero-dependency rules + the siblings on its
 *                   machine, then store it (root-only store in the private dir, NOT the registry)
 *   remove_draft    drop a draft (and its cached kit)
 *   build_kit       build the kit for a saved draft (kit_build.ts) — bounded answer like push_apis
 *   download_kit    the built kit's bytes (base64) + its sha256
 *   pair_package    the sealed pairing package provision init wrote, with its passphrase: opened
 *                   IN MEMORY, required to complete a saved draft (its name, instance and
 *                   listener address), then THE pairing (pair_flow.ts pairWith — the CLI's own
 *                   path: live fingerprint proof, then commit) — audited
 *
 * EVERY ACTION IS ROOT-ONLY (the widget's E10 rule), checked FIRST, before any module loads.
 *
 * WHY THE PANEL MAY PAIR NOW, AND STILL TAKES NO ADDRESS. A typed agent address could send the
 * engine's credentials anywhere; that is why the panel had no pairing form. pair_package takes
 * no address: the address comes from INSIDE the package, it must equal the listener of a draft
 * this panel created (root, earlier, for that very host), and the agent there must prove the
 * package's fingerprint live before anything is stored. A package for another draft, another
 * instance or another address is refused before anything is dialled.
 *
 * SECRETS. The passphrase and the package arrive in the request body only. They are never
 * logged, never echoed, never stored: the package bytes are zeroed after the open, the parts go
 * straight into the shared pairing path (whose secrets store writes them 0600 under the host's
 * name). JS strings cannot be zeroed — the passphrase and the decrypted token/bundle strings are
 * dropped with the request; that is the honest limit. Log and audit lines name the draft, the
 * instance and the address, never a token, a key, a PEM or a fingerprint.
 *
 * TESTABILITY: every outside effect is in SetupDeps (createSetupActions(loadDeps)); production
 * passes loadDefaultSetupDeps. Gate: test/unit/publication_host_setup_native.test.ts.
 */

import type { PairingParts } from '../../../../publication/host_agent/src/provision/pairing_package.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import type {
	DraftContext,
	DraftsFile,
	PanelDraft,
	StoredDraft,
} from '../../publication_host/drafts.ts';
import type { PanelKit } from '../../publication_host/kit_build.ts';
import type {
	Address,
	FragmentFields,
	PairInputs,
	PairOutcome,
	PairRefusalReason,
	PairRequest,
} from '../../publication_host/pair_flow.ts';
import { HOST_NAME, RegistryError, type RegistryFile } from '../../publication_host/registry.ts';
import { registryError } from '../../publication_host/wire.ts';
import { type Principal, SUPERUSER_ID } from '../../security/permissions.ts';
import { refuseAction, type WidgetResponse } from './support.ts';

/** The most base64 characters a package upload may carry (MAX_PACKAGE_BYTES = 1 MiB, + padding). */
export const PACKAGE_BASE64_MAX = Math.ceil((1024 * 1024) / 3) * 4;
/** A passphrase is 24 characters plus separators; anything longer is not one. */
export const PASSPHRASE_MAX = 128;
/** The largest kit download answered through the API (a kit is a few MiB). */
export const KIT_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

/** The package's own refusals, mapped onto the panel's closed reasons (details.reason). */
const PACKAGE_REASONS: Readonly<Record<string, string>> = Object.freeze({
	auth: 'package_auth',
	passphrase_shape: 'passphrase_shape',
});

/**
 * The closed `details.reason` list of publication_host_setup.pairing_refused: the shared path's
 * reasons (pair_flow.ts PAIR_REFUSAL_REASONS) plus the package's and the secrets store's.
 */
export const PANEL_PAIR_REASONS = Object.freeze([
	'fragment_invalid',
	'fragment_pending',
	'address_invalid',
	'token_invalid',
	'bundle_invalid',
	'fingerprint_mismatch',
	'name_taken',
	'name_unknown',
	'agent_registered',
	'partial_write',
	'draft_unknown',
	'draft_paired',
	'draft_mismatch',
	'address_mismatch',
	'socket_package',
	'package_auth',
	'package_invalid',
	'passphrase_shape',
	'secret_refused',
	'input',
] as const);
export type PanelPairReason = (typeof PANEL_PAIR_REASONS)[number];

/** What a person reads for each pairing refusal (engine-authored; the label names the reason). */
export const PAIR_REASON_SENTENCES: Readonly<Record<PanelPairReason, string>> = Object.freeze({
	fragment_invalid:
		"The package's engine fragment is not one this engine reads (an agent newer than this engine?). Nothing was stored.",
	fragment_pending:
		"The package was written before the agent's service token existed. Run provision init on the publication host again. Nothing was stored.",
	address_invalid:
		"The package's agent address is not a plain https address of the agent. Nothing was stored.",
	token_invalid:
		"The package's service token is not in the shape the agent uses. Nothing was stored.",
	bundle_invalid:
		"The package's engine TLS bundle is not the three PEM blocks provision init writes. Nothing was stored.",
	fingerprint_mismatch:
		"The package's token and instance do not match its fingerprint: the package was assembled from two installs. Nothing was stored.",
	name_taken: 'A publication host with this name is already paired. Nothing was stored.',
	name_unknown: 'No publication host with this name is paired. Nothing was stored.',
	agent_registered:
		'This agent is already paired under another name: one agent, one entry. Nothing was stored.',
	partial_write:
		"The host's credentials were replaced but the registry was not. The panel shows it as not paired until it is paired again.",
	draft_unknown:
		'There is no saved draft with this name. Create the draft first, then build its kit.',
	draft_paired: 'This draft is already paired.',
	draft_mismatch:
		"The package is not this draft's: it names another instance. Upload the package written for this draft. Nothing was stored.",
	address_mismatch:
		"The package's agent address is not the address this draft declares. Nothing was dialled and nothing was stored.",
	socket_package:
		'A one-machine draft pairs itself while provision init runs: there is no package to upload.',
	package_auth:
		'The passphrase is wrong, or the package was altered (the two cannot be told apart). Nothing was stored.',
	package_invalid:
		'The file is not a pairing package provision init wrote (or is damaged). Nothing was stored.',
	passphrase_shape:
		'The passphrase is 24 characters of the pairing alphabet, in six groups of four. Nothing was stored.',
	secret_refused:
		"The engine's secrets store refused the credentials (its directory's owner or mode). Nothing usable was stored.",
	input: 'The upload is not a package and a passphrase. Nothing was stored.',
});

/** Everything the actions touch outside this module. One object, so a test can replace all of it. */
export interface SetupDeps {
	loadRegistry(): RegistryFile;
	loadDrafts(): DraftsFile;
	updateDrafts(fn: (current: DraftsFile) => DraftsFile): DraftsFile;
	readPanelDraft(value: unknown): PanelDraft;
	validateDraft(name: unknown, draft: PanelDraft, context: DraftContext): PanelDraft;
	proposeDraft(
		input: Parameters<typeof import('../../publication_host/drafts.ts').proposeDraft>[0],
		context: DraftContext,
	): { name: string; draft: PanelDraft };
	pairedRecord: typeof import('../../publication_host/drafts.ts').pairedRecord;
	/** The work system's own group (one machine), or null. */
	engineGroup(): Promise<string | null>;
	/** The work system's media root (one machine, shared mode), or null. */
	engineMediaRoot(): string | null;
	buildKit(name: string, draft: PanelDraft): Promise<PanelKit>;
	cachedKit(name: string, draft: PanelDraft): Promise<PanelKit | null>;
	readKit(kit: PanelKit): Promise<Uint8Array | null>;
	removeKit(name: string): Promise<void>;
	openPackage(bytes: Uint8Array, passphrase: string): Promise<PairingParts>;
	parseFragment(text: string): FragmentFields;
	resolvePackageBundle(
		kind: Address['kind'],
		fragmentBundle: string | null,
		pem: string,
	): string | null;
	pairWith(request: PairRequest, inputs: PairInputs): Promise<PairOutcome>;
	sweepStaleStaging(now: number, notes: string[], tag: string): Promise<void>;
	forgetPairing(name: string): void;
	addressLabel(address: Address): string;
	/**
	 * One activity-log row (never a secret). SAVE for what the panel stores (a draft, a pairing),
	 * DELETE for what it drops — never NEW: dd42's NEW is the birth of a SECTION RECORD, written
	 * only by the record-birth engines (write_obligations_tripwire), and neither a draft nor a
	 * pairing is one.
	 */
	audit(principal: Principal, what: AuditVerb, data: Record<string, unknown>): Promise<void>;
	/** push_apis's bounded wait (the server idle timeout's half, capped). */
	answerWithinMs(): number;
}

export type SetupDepsLoader = () => Promise<SetupDeps>;

/** The activity verbs the panel writes (see SetupDeps.audit). */
export type AuditVerb = 'SAVE' | 'DELETE';

/** The production dependencies, imported on first use. */
export async function loadDefaultSetupDeps(): Promise<SetupDeps> {
	const drafts = await import('../../publication_host/drafts.ts');
	const kits = await import('../../publication_host/kit_build.ts');
	const flow = await import('../../publication_host/pair_flow.ts');
	const registry = await import('../../publication_host/registry.ts');
	const pkg = await import('../../../../publication/host_agent/src/provision/pairing_package.ts');
	const { forgetPairing } = await import('../../publication_host/agent_client.ts');
	const { config } = await import('../../../config/config.ts');
	const { assertTestMediaRoot } = await import('../../media/test_media_root.ts');
	const { pushAnswerWithinMs } = await import('./publication_hosts.ts');
	return {
		loadRegistry: registry.loadRegistry,
		loadDrafts: drafts.loadDrafts,
		updateDrafts: drafts.updateDrafts,
		readPanelDraft: drafts.readPanelDraft,
		validateDraft: drafts.validateDraft,
		proposeDraft: drafts.proposeDraft,
		pairedRecord: drafts.pairedRecord,
		engineGroup: ownGroupName,
		// The shared media tree a one-machine draft proposes: it goes into a draft, then a kit,
		// and the publication host built from it serves files out of it — so under the suite's
		// test-media seam it must be the MARKED suite root, never an installation's tree (the
		// guard is inert outside the seam).
		engineMediaRoot: () => {
			const root = config.media.rootPath;
			return root === null
				? null
				: assertTestMediaRoot(root, 'publication_host_setup.engineMediaRoot');
		},
		buildKit: (name, draft) => kits.buildPanelKit(name, draft),
		cachedKit: (name, draft) => kits.cachedPanelKit(name, draft),
		readKit: kits.readPanelKit,
		removeKit: (name) => kits.removePanelKit(name),
		openPackage: pkg.openPairingPackageAsync,
		parseFragment: flow.parseFragment,
		resolvePackageBundle: flow.resolvePackageBundle,
		pairWith: flow.pairWith,
		sweepStaleStaging: flow.sweepStaleStaging,
		forgetPairing,
		addressLabel: flow.addressLabel,
		audit: auditActivity,
		answerWithinMs: () => pushAnswerWithinMs(config.ops.idleTimeoutSeconds),
	};
}

/** This process's group name (/etc/group by gid), or null when it cannot be named. */
async function ownGroupName(): Promise<string | null> {
	const gid = process.getgid?.();
	if (gid === undefined) return null;
	try {
		const { readFile } = await import('node:fs/promises');
		return groupNameIn(await readFile('/etc/group', 'utf8'), gid);
	} catch {
		// no /etc/group (not a Unix host): the operator names the group
		return null;
	}
}

/** The name of group `gid` in an /etc/group text, or null. */
function groupNameIn(text: string, gid: number): string | null {
	for (const line of text.split('\n')) {
		const [name, , id] = line.split(':');
		if (name !== undefined && id !== undefined && Number(id) === gid) return name;
	}
	return null;
}

/** The activity row: WHAT on the maintenance area (dd88), the payload names no secret. */
async function auditActivity(
	principal: Principal,
	what: AuditVerb,
	data: Record<string, unknown>,
): Promise<void> {
	const { logActivity, hostFromClientIp } = await import('../../api/handlers/activity_log.ts');
	const { AREA_MAINTENANCE_TIPO } = await import('../../concepts/area.ts');
	const { currentRequestContext } = await import('../../security/request_context.ts');
	await logActivity({
		what,
		tipo: AREA_MAINTENANCE_TIPO,
		userId: principal.userId,
		host: hostFromClientIp(currentRequestContext()?.clientIp),
		data,
	});
}

// ── guards and helpers ──────────────────────────────────────────────────────

const TAG = '[publication_hosts]';

function requireRoot(principal: Principal, action: string): void {
	if (principal.userId !== SUPERUSER_ID) {
		throw new DedaloError('perm.denied', {
			message: `only the root user can run publication_hosts.${action}`,
		});
	}
}

function draftName(options: Record<string, unknown>): string {
	const name = options.name;
	if (typeof name !== 'string' || !HOST_NAME.test(name)) refuseAction('Error. Invalid draft name.');
	return name;
}

function draftRefusal(error: unknown): unknown {
	const issues = (error as { issues?: readonly { field: string; message: string }[] }).issues;
	if ((error as Error | null)?.name !== 'DraftInvalid' || issues === undefined) return error;
	return new DedaloError('publication_host_setup.draft_invalid', {
		publicMessage: `Error. The draft was refused:\n${issues.map((issue) => `${issue.field}: ${issue.message}`).join('\n')}`,
		details: { fields: issues.map((issue) => issue.field).join(',') },
	});
}

function storeFailure(error: unknown): unknown {
	if ((error as Error | null)?.name !== 'DraftsStoreError') return error;
	const reason = (error as { reason?: string }).reason;
	if (reason === 'locked')
		return new DedaloError('publication_host.busy', { message: (error as Error).message });
	return new DedaloError('publication_host_setup.drafts_invalid', {
		message: (error as Error).message,
	});
}

function registryFailure(error: unknown): unknown {
	return error instanceof RegistryError ? registryError(error.reason) : error;
}

/** What a person reads for each kit refusal (engine-authored; kit_build.ts KitBuildReason). */
export const KIT_REASON_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
	no_verified_release:
		'This engine runs from a checkout, not a verified release: the panel ships only what the updater verified. Build the kit on the checkout with bun run hostagent:pack.',
	unsafe_seams: 'The kit build was asked for an unsafe location. This is a fault of this server.',
	missing_manifest:
		'This release has no publication manifest (installed before it existed): update the engine, or build the kit on a checkout with bun run hostagent:pack.',
	digest_mismatch:
		'The publication manifest is not the running release (an update is waiting for its restart): restart, then build again.',
	drift:
		"Files of the agent's package differ from what the updater verified (or the release predates the kit census): restore them by updating the engine, or build the kit on a checkout with bun run hostagent:pack.",
	source_missing: 'A file the kit needs is not in this release.',
	not_regular_file: 'A file the kit needs is not a regular file.',
	deps_install_failed:
		"The agent's production dependencies could not be installed (the package registry is unreachable, or the lockfile does not match).",
	deps_symlink: "The agent's dependencies hold a symbolic link, which a kit cannot carry.",
	deps_unpinned:
		"The agent's lockfile names a dependency that does not come from the package registry with an integrity hash (a file, link, git or URL dependency).",
	dev_dependency: "The agent's dependencies hold a development dependency.",
	draft_refused:
		"The agent's own draft check refused this draft (see the server log): remove it and create it again.",
	kit_refused: 'The kit would carry a file the kit format refuses (see the server log).',
	write_mismatch: 'The kit file on disk is not what was written: build it again.',
});

function kitFailure(error: unknown): unknown {
	if ((error as Error | null)?.name !== 'KitBuildError') return error;
	const reason = (error as { reason: string }).reason;
	const paths = (error as { paths?: readonly string[] }).paths ?? [];
	const named =
		paths.length === 0
			? ''
			: ` (${paths.slice(0, 10).join(', ')}${paths.length > 10 ? ', …' : ''})`;
	console.warn(`${TAG} build_kit refused: ${(error as Error).message}`);
	return new DedaloError('publication_host_setup.kit_refused', {
		message: `kit refused: ${reason}`,
		publicMessage: `Error. ${KIT_REASON_SENTENCES[reason] ?? 'The kit could not be built.'}${named}`,
		details: { reason },
		cause: error,
	});
}

function pairRefused(reason: PanelPairReason, cause?: unknown): DedaloError {
	return new DedaloError('publication_host_setup.pairing_refused', {
		message: `pair_package refused: ${reason}`,
		publicMessage: `Error. ${PAIR_REASON_SENTENCES[reason]}`,
		details: { reason },
		...(cause === undefined ? {} : { cause }),
	});
}

function loadContext(deps: SetupDeps): DraftContext {
	let registry: RegistryFile;
	try {
		registry = deps.loadRegistry();
	} catch (error) {
		throw registryFailure(error);
	}
	try {
		return { registry, drafts: deps.loadDrafts().drafts };
	} catch (error) {
		throw storeFailure(error);
	}
}

function requireDraft(context: DraftContext, name: string): StoredDraft {
	const stored = context.drafts.find((draft) => draft.name === name);
	if (stored === undefined) refuseAction(`Error. No draft named '${name}'.`, { draft: name });
	return stored;
}

/** The wire row of one draft (root only): the draft itself, its derived state, its kit. */
export interface DraftRow {
	name: string;
	created_at: string;
	draft: PanelDraft;
	state: 'awaiting' | 'paired';
	paired_as: string | null;
	kit: Omit<PanelKit, 'file'> | null;
}

function kitSummary(kit: PanelKit | null): Omit<PanelKit, 'file'> | null {
	if (kit === null) return null;
	const { file: _serverPath, ...summary } = kit;
	return summary;
}

/** The drafts the panel lists (root's get_value); a corrupt store is a state, never an empty list. */
export async function draftRows(
	deps: SetupDeps,
	registry: RegistryFile | null,
): Promise<{ state: 'ok' | 'drafts_invalid'; drafts: DraftRow[] | null }> {
	let file: DraftsFile;
	try {
		file = deps.loadDrafts();
	} catch (error) {
		if ((error as Error | null)?.name !== 'DraftsStoreError') throw error;
		console.error(`${TAG} drafts unusable: ${(error as Error).message}`);
		return { state: 'drafts_invalid', drafts: null };
	}
	const rows = await Promise.all(
		file.drafts.map(async (stored): Promise<DraftRow> => {
			const paired = registry === null ? null : deps.pairedRecord(stored, registry);
			const kit = await deps.cachedKit(stored.name, stored.draft).catch(() => null);
			return {
				name: stored.name,
				created_at: stored.created_at,
				draft: stored.draft,
				state: paired === null ? 'awaiting' : 'paired',
				paired_as: paired?.name ?? null,
				kit: kitSummary(kit),
			};
		}),
	);
	return { state: 'ok', drafts: rows };
}

function logLine(action: string, name: string, principal: Principal, detail: string): void {
	console.info(`${TAG} ${action} draft=${name} user=${principal.userId} ${detail}`);
}

// ── the actions ─────────────────────────────────────────────────────────────

type Action = (
	options: Record<string, unknown>,
	principal: Principal,
	loadDeps: SetupDepsLoader,
) => Promise<WidgetResponse>;

/** propose_draft's request options, each closed to its known values (never an error). */
function proposalOptions(options: Record<string, unknown>): {
	domain: string;
	machines: 'one' | 'two';
	apis: 'v1_and_v2' | 'v2_only';
	listenHost: string;
} {
	return {
		domain: typeof options.domain === 'string' ? options.domain.trim().toLowerCase() : '',
		machines: options.machines === 'two' ? 'two' : 'one',
		apis: options.apis === 'v1_and_v2' ? 'v1_and_v2' : 'v2_only',
		listenHost: typeof options.listen_host === 'string' ? options.listen_host.trim() : '',
	};
}

const proposeDraftAction: Action = async (options, principal, loadDeps) => {
	requireRoot(principal, 'propose_draft');
	const { domain, machines, apis, listenHost } = proposalOptions(options);
	const deps = await loadDeps();
	const context = loadContext(deps);
	const proposal = deps.proposeDraft(
		{
			domain,
			machines,
			listenHost,
			apis,
			engineGroup: machines === 'one' ? await deps.engineGroup() : null,
			mediaRoot: machines === 'one' ? deps.engineMediaRoot() : null,
		},
		context,
	);
	return { data: proposal };
};

const saveDraftAction: Action = async (options, principal, loadDeps) => {
	requireRoot(principal, 'save_draft');
	const name = options.name;
	if (typeof name !== 'string' || !HOST_NAME.test(name)) {
		throw new DedaloError('publication_host_setup.draft_invalid', {
			publicMessage: `Error. The draft was refused:\nname: must match ${HOST_NAME.source}`,
			details: { fields: 'name' },
		});
	}
	const deps = await loadDeps();
	let draft: PanelDraft;
	try {
		draft = deps.readPanelDraft(options.draft);
	} catch (error) {
		throw draftRefusal(error);
	}
	const registry = loadContext(deps).registry;
	let saved: StoredDraft | undefined;
	try {
		deps.updateDrafts((current) => {
			// judged UNDER the lock, against the store as it is now (a concurrent save of the same
			// name or a sibling on that machine is seen)
			const judged = deps.validateDraft(name, draft, { registry, drafts: current.drafts });
			saved = {
				name,
				created_at: new Date().toISOString(),
				created_by: principal.userId,
				draft: judged,
			};
			return { ...current, drafts: [...current.drafts, saved] };
		});
	} catch (error) {
		throw storeFailure(draftRefusal(error));
	}
	const stored = saved as StoredDraft;
	logLine(
		'save_draft',
		stored.name,
		principal,
		`instance=${draft.instance} listen=${draft.listen.kind}`,
	);
	await deps.audit(principal, 'SAVE', {
		msg: `Publication host draft '${stored.name}' saved`,
		action: 'publication_hosts.save_draft',
		draft: stored.name,
		instance: draft.instance,
		listen: draft.listen.kind === 'tls' ? `${draft.listen.host}:${draft.listen.port}` : 'unix',
	});
	return {
		data: { name: stored.name, draft: stored.draft },
		msg: `OK. Draft '${stored.name}' saved. Build its kit, install the publication host from it, then pair the host.`,
	};
};

const removeDraftAction: Action = async (options, principal, loadDeps) => {
	requireRoot(principal, 'remove_draft');
	const name = draftName(options);
	const deps = await loadDeps();
	try {
		deps.updateDrafts((current) => {
			if (!current.drafts.some((draft) => draft.name === name)) {
				refuseAction(`Error. No draft named '${name}'.`, { draft: name });
			}
			return { ...current, drafts: current.drafts.filter((draft) => draft.name !== name) };
		});
	} catch (error) {
		throw storeFailure(error);
	}
	await deps.removeKit(name);
	logLine('remove_draft', name, principal, 'removed');
	await deps.audit(principal, 'DELETE', {
		msg: `Publication host draft '${name}' removed`,
		action: 'publication_hosts.remove_draft',
		draft: name,
	});
	return {
		data: { name, removed: true },
		msg: `OK. Draft '${name}' removed (a paired host stays paired).`,
	};
};

const STILL_RUNNING = Symbol('still_running');

async function settledWithin<T>(job: Promise<T>, ms: number): Promise<T | typeof STILL_RUNNING> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof STILL_RUNNING>((done) => {
		timer = setTimeout(() => done(STILL_RUNNING), ms);
	});
	try {
		return await Promise.race([job, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * build_kit: the kit of a saved draft for the installed release (kit_build.ts — the cache, or a
 * build: verified source + the production install + the draft judged by the kit's own code).
 * BOUNDED ANSWER like push_apis: a first build installs the agent's dependencies; one still going
 * after answerWithinMs answers `running` and finishes detached — the next panel load shows it.
 */
const buildKitAction: Action = async (options, principal, loadDeps) => {
	requireRoot(principal, 'build_kit');
	const name = draftName(options);
	const deps = await loadDeps();
	const stored = requireDraft(loadContext(deps), name);
	const job = deps.buildKit(name, stored.draft);
	const kit = await settledWithin(job, deps.answerWithinMs()).catch((error: unknown) => {
		throw kitFailure(error);
	});
	if (kit === STILL_RUNNING) {
		void job.catch((error) => console.error(`${TAG} build_kit draft=${name} failed:`, error));
		logLine('build_kit', name, principal, 'running');
		return {
			data: null,
			msg: `The kit of '${name}' is still being built (the first build installs the agent's dependencies). Reload this panel in a moment.`,
			extend: { running: true },
		};
	}
	logLine('build_kit', name, principal, `sha256=${kit.sha256} release=${kit.release}`);
	return {
		data: kitSummary(kit),
		msg: `OK. Kit ${kit.file_name} built for release ${kit.release}: sha256 ${kit.sha256}.`,
		extend: { running: false },
	};
};

/** download_kit: the built kit's bytes (base64), re-hashed at read time, with its sha256. */
const downloadKitAction: Action = async (options, principal, loadDeps) => {
	requireRoot(principal, 'download_kit');
	const name = draftName(options);
	const deps = await loadDeps();
	const stored = requireDraft(loadContext(deps), name);
	const kit = await deps.cachedKit(name, stored.draft);
	if (kit === null)
		refuseAction(`Error. The kit of '${name}' is not built for this release: build it first.`, {
			draft: name,
		});
	if (kit.size > KIT_DOWNLOAD_MAX_BYTES) {
		refuseAction(
			`Error. The kit of '${name}' is larger than the panel serves; build it on the checkout with bun run hostagent:pack.`,
		);
	}
	const bytes = await deps.readKit(kit);
	if (bytes === null)
		refuseAction(
			`Error. The kit of '${name}' changed on disk since it was built: build it again.`,
			{ draft: name },
		);
	logLine('download_kit', name, principal, `sha256=${kit.sha256}`);
	return { data: { ...kitSummary(kit), kit_base64: Buffer.from(bytes).toString('base64') } };
};

/** The upload's two strings, shape-checked (never echoed). */
function uploadInput(options: Record<string, unknown>): { bytes: Uint8Array; passphrase: string } {
	const encoded = options.package_base64;
	const passphrase = options.passphrase;
	if (!isPackageBase64(encoded) || !isPassphraseInput(passphrase)) throw pairRefused('input');
	return { bytes: new Uint8Array(Buffer.from(encoded, 'base64')), passphrase };
}

/** A non-empty base64 string no longer than a package can be. */
function isPackageBase64(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= PACKAGE_BASE64_MAX &&
		/^[A-Za-z0-9+/]*={0,2}$/.test(value)
	);
}

/** A non-empty string no longer than a passphrase can be (its shape is the package's check). */
function isPassphraseInput(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= PASSPHRASE_MAX;
}

function packageReason(error: unknown): PanelPairReason | null {
	if ((error as Error | null)?.name !== 'PairingPackageRefused') return null;
	const reason = (error as { reason?: string }).reason ?? '';
	return (PACKAGE_REASONS[reason] as PanelPairReason | undefined) ?? 'package_invalid';
}

/**
 * The binding check the panel adds to the shared path: the package must be THIS draft's —
 * same instance, and the agent address inside it equal to the draft's listener. Runs before the
 * token is looked at and before anything is dialled.
 */
export function packageBinding(
	draft: PanelDraft,
): (fields: FragmentFields, address: Address) => void {
	return (fields, address) => {
		if (fields.instance !== draft.instance) throw pairRefused('draft_mismatch');
		const listen = draft.listen;
		if (
			listen.kind !== 'tls' ||
			address.kind !== 'tls' ||
			address.host !== listen.host ||
			address.port !== listen.port
		) {
			throw pairRefused('address_mismatch');
		}
	};
}

function pairFailure(error: unknown): unknown {
	if (error instanceof DedaloError) return error;
	const name = (error as Error | null)?.name;
	if (name === 'PairRefusal') {
		return pairRefused(panelReason((error as { reason: PairRefusalReason }).reason), error);
	}
	if (name === 'SecretError') {
		const reason = (error as { reason?: string }).reason ?? '';
		return pairRefused(SECRET_REASONS[reason] ?? 'secret_refused', error);
	}
	return registryFailure(error);
}

/** A shared-path refusal reason as the panel's own (an unknown one reads as `input`). */
function panelReason(reason: PairRefusalReason): PanelPairReason {
	return (PANEL_PAIR_REASONS as readonly string[]).includes(reason)
		? (reason as PanelPairReason)
		: 'input';
}

/** The secrets store's refusals that name the package's part; any other is secret_refused. */
const SECRET_REASONS: Readonly<Record<string, PanelPairReason>> = Object.freeze({
	bad_bundle: 'bundle_invalid',
	bad_token: 'token_invalid',
});

/** The saved, not yet paired, TLS-listener draft `name` — or the refusal that says which it is not. */
function pairableDraft(deps: SetupDeps, name: string): StoredDraft {
	const context = loadContext(deps);
	const stored = context.drafts.find((draft) => draft.name === name);
	if (stored === undefined) throw pairRefused('draft_unknown');
	if (deps.pairedRecord(stored, context.registry) !== null) throw pairRefused('draft_paired');
	if (stored.draft.listen.kind !== 'tls') throw pairRefused('socket_package');
	return stored;
}

/** The package opened in memory; its own refusals (wrong passphrase, altered) mapped. */
async function openUploadedPackage(
	deps: SetupDeps,
	bytes: Uint8Array,
	passphrase: string,
): Promise<PairingParts> {
	try {
		return await deps.openPackage(bytes, passphrase);
	} catch (error) {
		const reason = packageReason(error);
		if (reason !== null) throw pairRefused(reason);
		throw error;
	}
}

/**
 * pair_package: complete a saved draft with the sealed package provision init wrote on the
 * publication host (two machines). Order: root → the upload's shape → the draft (saved, not yet
 * paired, a TLS listener) → the package opened in memory (wrong passphrase / altered: one
 * refusal) → the fragment parsed → THE pairing (pair_flow.ts pairWith, as `add <draft name>`):
 * the binding (instance + address = the draft's) before the token is read and before any dial,
 * the token ⇒ fingerprint check, the registry slot, the LIVE fingerprint proof over mTLS, the
 * commit under the registry lock → audit.
 */
const pairPackageAction: Action = async (options, principal, loadDeps) => {
	requireRoot(principal, 'pair_package');
	const name = draftName(options);
	const { bytes, passphrase } = uploadInput(options);
	try {
		const deps = await loadDeps();
		const stored = pairableDraft(deps, name);
		const parts = await openUploadedPackage(deps, bytes, passphrase);
		const fields = deps.parseFragment(parts.fragment);
		const notes: string[] = [];
		await deps.sweepStaleStaging(Date.now(), notes, TAG);
		const outcome = await deps.pairWith(
			{
				command: 'add',
				name,
				dryRun: false,
				tag: TAG,
				assertBinding: packageBinding(stored.draft),
			},
			{
				fields,
				supplied: parts.token,
				bundle: (kind) => deps.resolvePackageBundle(kind, fields.tlsBundle, parts.bundle),
			},
		);
		deps.forgetPairing(name);
		const label = deps.addressLabel(outcome.record.address);
		for (const note of [...notes, ...outcome.notes]) console.warn(note);
		logLine(
			'pair_package',
			name,
			principal,
			`paired instance=${outcome.record.instance} address=${label}`,
		);
		await deps.audit(principal, 'SAVE', {
			msg: `Publication host '${name}' paired from the panel (sealed package, live fingerprint proof)`,
			action: 'publication_hosts.pair_package',
			host: name,
			instance: outcome.record.instance,
			address: label,
		});
		return {
			data: { name, instance: outcome.record.instance, address_label: label },
			msg: `OK. '${name}' is paired (${label}): the agent proved the package's fingerprint over mTLS. Delete the package on the publication host now; its passphrase opens nothing else.`,
		};
	} catch (error) {
		const failure = pairFailure(error);
		const code = failure instanceof DedaloError ? failure.code : 'internal';
		logLine('pair_package', name, principal, `refused code=${code}`);
		throw failure;
	} finally {
		bytes.fill(0);
	}
};

/** The bound actions the publication_hosts widget lists (apiActions). */
export const SETUP_ACTIONS = Object.freeze([
	'propose_draft',
	'save_draft',
	'remove_draft',
	'build_kit',
	'download_kit',
	'pair_package',
] as const);
export type SetupActionName = (typeof SETUP_ACTIONS)[number];

export function createSetupActions(
	loadDeps: SetupDepsLoader,
): Record<
	SetupActionName,
	(options: Record<string, unknown>, principal: Principal) => Promise<WidgetResponse>
> {
	const bind =
		(action: Action) =>
		(options: Record<string, unknown>, principal: Principal): Promise<WidgetResponse> =>
			action(options, principal, loadDeps);
	return {
		propose_draft: bind(proposeDraftAction),
		save_draft: bind(saveDraftAction),
		remove_draft: bind(removeDraftAction),
		build_kit: bind(buildKitAction),
		download_kit: bind(downloadKitAction),
		pair_package: bind(pairPackageAction),
	};
}
