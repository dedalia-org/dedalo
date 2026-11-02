/**
 * "NEW PUBLICATION HOST" — the panel half of the guided install
 * (src/core/area_maintenance/widgets/publication_host_setup.ts; drafts.ts, kit_build.ts,
 * pair_flow.ts; engineering/PUBLICATION_HOST_SPEC.md §9.14).
 *
 * Pinned:
 *  1. DRAFTS — the form's draft is read field by field (every shape issue named), judged by the
 *     agent's OWN derive() and siblings rules on a stand-in declaration, and against the siblings
 *     on its machine: other drafts (users, v2 port/unit, listener) and the paired hosts there
 *     (instance, listener). A draft on another machine is no sibling. Proposals: the instance by
 *     the domain convention, init's account defaults, the next free v2 and TLS ports.
 *  2. THE STORE — root only (every action refuses a non-root admin before any load), 0600 in the
 *     declared scratch private dir, never the registry; a corrupt file is `drafts_invalid` on the
 *     panel and on every action, never "no drafts"; a draft is removable; its state is derived
 *     (paired once the registry holds its instance at its address).
 *  3. THE KIT — built from a tree the updater verified (the publication manifest's kit census):
 *     the agent's tracked files minus test material, the production install (seamed), the draft
 *     judged by the agent's REAL parseDraft in a child Bun; deterministic; cached per release +
 *     draft bytes; a drifted file, a dev checkout, a manifest without the kit census: refused.
 *  4. THE UPLOAD — wrong passphrase, tampered package, a package for another instance, another
 *     address, a fingerprint the agent does not publish, a one-machine draft, a non-root caller:
 *     each refused with its reason and NOTHING stored (registry + secrets unchanged, no dial
 *     where the refusal precedes it); the happy path pairs through the shared path (live mTLS
 *     /health proof against a mock agent, no bearer), stores the secrets 0600, audits a row
 *     without a secret; no response, log line or audit row carries the token, the passphrase,
 *     a PEM or the fingerprint.
 *
 * Hermetic: a declared scratch publication-hosts base, scratch trees and backup roots under the
 * OS temp dir, a loopback mock agent; the audit is a recorder (no database).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
	newPassphrase,
	sealPairingPackage,
} from '../../publication/host_agent/src/provision/pairing_package.ts';
import { extractBundle } from '../../publication/host_agent/src/releases/ustar.ts';
import {
	createSetupActions,
	draftRows,
	loadDefaultSetupDeps,
	packageBinding,
	type SetupDeps,
} from '../../src/core/area_maintenance/widgets/publication_host_setup.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import {
	DraftInvalid,
	draftJson,
	draftsPath,
	instanceFromDomain,
	type PanelDraft,
	proposeDraft,
	readPanelDraft,
	type StoredDraft,
	validateDraft,
} from '../../src/core/publication_host/drafts.ts';
import {
	buildPanelKit,
	cachedPanelKit,
	KitBuildError,
	type KitBuildSeams,
	removePanelKit,
} from '../../src/core/publication_host/kit_build.ts';
import { FRAGMENT_KEYS } from '../../src/core/publication_host/pair_flow.ts';
import { publicationHostFingerprint } from '../../src/core/publication_host/pairing.ts';
import {
	loadRegistry,
	type PublicationHostRecord,
	registryPath,
	saveRegistry,
} from '../../src/core/publication_host/registry.ts';
import { hostSecretDir } from '../../src/core/publication_host/secrets.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { INSTALL_STAMP_PATH } from '../../src/core/update/install_stamp.ts';
import { writePublicationManifest } from '../../src/core/update/publication_manifest.ts';
import {
	mintTestPki,
	type TestPki,
	useScratchPublicationHostsBase,
} from '../helpers/publication_host_fixtures.ts';
import { type MockAgent, startMockAgent } from '../helpers/publication_host_mock_agent.ts';

const REPO = resolve(import.meta.dir, '../..');
const ROOT: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const ADMIN: Principal = { userId: 7, isGlobalAdmin: true, isDeveloper: false };
const TOKEN = 'SETUP-TOKEN-0f1e2d3c4b5a69788796a5b4c3d2e1f0aabbccdd';
const OTHER_TOKEN = 'OTHER-TOKEN-ffeeddccbbaa99887766554433221100aabbccdd';
const DIGEST = `b2c3d4e${'1'.repeat(57)}`;

const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'dd_pubhost_setup_'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		return (error as DedaloError).code;
	}
	throw new Error('expected a rejection');
}
async function errorOf(promise: Promise<unknown>): Promise<DedaloError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		return error as DedaloError;
	}
	throw new Error('expected a rejection');
}

function v2Draft(over: Partial<PanelDraft> = {}): PanelDraft {
	return {
		instance: 'museum_org',
		layout: 'home',
		apis: 'v2_only',
		listen: { kind: 'tls', host: '127.0.0.1', port: 8471 },
		agent_user: 'museum_org_agent',
		web: { server: 'apache' },
		site: { domain: 'museum.org' },
		media: { mode: 'copy', root: '/srv/dedalo_pub/museum_org' },
		v2: { unit: 'dedalo-publication-api-v2-museum_org', user: 'museum_org_v2', port: 3100 },
		...over,
	};
}
function stored(name: string, draft: PanelDraft): StoredDraft {
	return { name, created_at: '2026-10-09T00:00:00.000Z', created_by: -1, draft };
}
function host(
	name: string,
	instance: string,
	address: PublicationHostRecord['address'],
): PublicationHostRecord {
	return {
		name,
		instance,
		fingerprint: 'a'.repeat(64),
		address,
		public_url: null,
		qualities: null,
		probe: { published: null, unpublished: null },
		paired_at: '2026-10-09T00:00:00.000Z',
	};
}
function issuesOf(fn: () => unknown): { field: string; message: string }[] {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(DraftInvalid);
		return [...(error as DraftInvalid).issues];
	}
	throw new Error('expected DraftInvalid');
}
const EMPTY = { drafts: [] as StoredDraft[], registry: { version: 1 as const, hosts: [] } };

// ---------------------------------------------------------------------------------- 1. drafts

describe('drafts: read, judged by the agent rules, siblings on the machine', () => {
	test('the shape is read field by field: every issue named at once', () => {
		const issues = issuesOf(() =>
			readPanelDraft({
				...v2Draft(),
				instance: 'Bad Name',
				listen: { kind: 'tls', host: 'pub.example.org', port: 70000 },
				v2: { unit: 'x.service ok', user: 'museum_org_v2', port: 3100 },
				extra: 1,
			}),
		);
		const fields = issues.map((i) => i.field);
		expect(fields).toContain('instance');
		expect(fields).toContain('listen.host');
		expect(fields).toContain('listen.port');
		expect(fields).toContain('v2.unit');
		// a v1 key on a v2-only draft, an engine group on two machines: named
		const more = issuesOf(() =>
			readPanelDraft({ ...v2Draft(), v1: { user: 'x_v1' }, engine_group: 'dedalo' }),
		);
		expect(more.map((i) => i.field).sort()).toEqual(['engine_group', 'v1.user']);
		// a one-machine draft needs its engine group; v1_and_v2 needs its v1 user
		const one = issuesOf(() =>
			readPanelDraft({ ...v2Draft(), apis: 'v1_and_v2', listen: { kind: 'unix' } }),
		);
		expect(one.map((i) => i.field).sort()).toEqual(['engine_group', 'v1.user']);
		expect(readPanelDraft(v2Draft())).toEqual(v2Draft());
	});

	test("derive() is the judge: its field refusal names the form's field", () => {
		// the agent and the v2 user may never be one account (layout.ts derive)
		const same = issuesOf(() =>
			validateDraft(
				'museum_org',
				v2Draft({ v2: { ...v2Draft().v2, user: 'museum_org_agent' } }),
				EMPTY,
			),
		);
		expect(same.map((i) => i.field)).toEqual(['v2.user']);
		// a v1 user that is a web account
		const web = issuesOf(() =>
			validateDraft('museum_org', v2Draft({ apis: 'v1_and_v2', v1: { user: 'www-data' } }), EMPTY),
		);
		expect(web.map((i) => i.field)).toEqual(['v1.user']);
		// copy mode needs its root (readPanelDraft accepts '' as no path: refused there)
		expect(
			issuesOf(() => readPanelDraft({ ...v2Draft(), media: { mode: 'copy', root: '' } })).map(
				(i) => i.field,
			),
		).toEqual(['media.root']);
		expect(validateDraft('museum_org', v2Draft(), EMPTY)).toEqual(v2Draft());
	});

	test('the registry name: grammar, the reserved prefix, a paired host or a draft already holding it', () => {
		expect(
			issuesOf(() => validateDraft('pairing_x', v2Draft(), EMPTY)).map((i) => i.field),
		).toEqual(['name']);
		const paired = {
			...EMPTY,
			registry: {
				version: 1 as const,
				hosts: [host('museum_org', 'other', { kind: 'unix', socket: '/run/x.sock' })],
			},
		};
		expect(
			issuesOf(() => validateDraft('museum_org', v2Draft(), paired)).map((i) => i.field),
		).toEqual(['name']);
		const drafted = {
			...EMPTY,
			drafts: [
				stored('museum_org', v2Draft({ listen: { kind: 'tls', host: '10.0.0.9', port: 8471 } })),
			],
		};
		expect(
			issuesOf(() => validateDraft('museum_org', v2Draft(), drafted)).map((i) => i.field),
		).toEqual(['name']);
	});

	test('MULTI-INSTANCE: siblings on the same machine are refused field by field; another machine is no sibling', () => {
		const other = v2Draft({
			instance: 'archive_org',
			site: { domain: 'archive.org' },
			agent_user: 'archive_org_agent',
			v2: { unit: 'dedalo-publication-api-v2-archive_org', user: 'archive_org_v2', port: 3101 },
			listen: { kind: 'tls', host: '127.0.0.1', port: 8472 },
			media: { mode: 'copy', root: '/srv/dedalo_pub/archive_org' },
		});
		const context = { ...EMPTY, drafts: [stored('archive_org', other)] };
		expect(validateDraft('museum_org', v2Draft(), context)).toEqual(v2Draft()); // disjoint: fine
		// the same v2 port, the same agent account, the same listener: each named
		const clash = v2Draft({
			agent_user: 'archive_org_agent',
			v2: { ...v2Draft().v2, port: 3101 },
			listen: { kind: 'tls', host: '127.0.0.1', port: 8472 },
		});
		const fields = issuesOf(() => validateDraft('museum_org', clash, context)).map((i) => i.field);
		expect(fields).toContain('agent_user');
		expect(fields).toContain('v2.port');
		expect(fields).toContain('listen.port');
		// the same clash on ANOTHER machine (another IPv4): no sibling, accepted
		const elsewhere = { ...clash, listen: { kind: 'tls' as const, host: '10.20.0.2', port: 8472 } };
		expect(validateDraft('museum_org', elsewhere, context)).toEqual(elsewhere);
		// one machine: every socket draft is on THIS machine
		const oneA = v2Draft({ listen: { kind: 'unix' }, engine_group: 'dedalo' });
		const oneB = {
			...other,
			listen: { kind: 'unix' as const },
			engine_group: 'dedalo',
			v2: { ...other.v2, port: 3100 },
		};
		const sameMachine = { ...EMPTY, drafts: [stored('archive_org', oneB)] };
		expect(
			issuesOf(() => validateDraft('museum_org', oneA, sameMachine)).map((i) => i.field),
		).toEqual(['v2.port']);
	});

	test('MULTI-INSTANCE: a paired host on that machine (no draft) — its instance and its listener', () => {
		const registry = {
			version: 1 as const,
			hosts: [host('old_site', 'museum_org', { kind: 'tls', host: '127.0.0.1', port: 8471 })],
		};
		const fields = issuesOf(() =>
			validateDraft('museum_new', v2Draft(), { drafts: [], registry }),
		).map((i) => i.field);
		expect(fields.sort()).toEqual(['instance', 'listen.port']);
		// at another address it is another machine
		const away = {
			version: 1 as const,
			hosts: [host('old_site', 'museum_org', { kind: 'tls', host: '10.9.9.9', port: 8471 })],
		};
		expect(validateDraft('museum_new', v2Draft(), { drafts: [], registry: away })).toEqual(
			v2Draft(),
		);
		// a draft with that instance on ANOTHER machine does not hide the host on this one
		const elsewhere = stored(
			'museum_far',
			v2Draft({ listen: { kind: 'tls', host: '10.9.9.9', port: 8471 } }),
		);
		const shadowed = issuesOf(() =>
			validateDraft('museum_new', v2Draft(), { drafts: [elsewhere], registry }),
		).map((i) => i.field);
		expect(shadowed).toContain('instance');
	});

	test('proposals: the domain convention, init defaults, the next free v2 and TLS ports, the work group', () => {
		expect(instanceFromDomain('museum.org')).toBe('museum_org');
		expect(instanceFromDomain('my-museum.example.org')).toBe('my_museum_example_org');
		expect(instanceFromDomain('9museum.org')).toBe(''); // not an instance name: the operator types one
		const context = {
			drafts: [
				stored(
					'a',
					v2Draft({
						v2: { ...v2Draft().v2, port: 3100 },
						listen: { kind: 'tls', host: '10.0.0.5', port: 8471 },
					}),
				),
			],
			registry: {
				version: 1 as const,
				hosts: [host('b', 'b', { kind: 'tls', host: '10.0.0.5', port: 8472 })],
			},
		};
		const two = proposeDraft(
			{
				domain: 'archive.org',
				machines: 'two',
				listenHost: '10.0.0.5',
				apis: 'v1_and_v2',
				engineGroup: null,
				mediaRoot: null,
			},
			context,
		);
		expect(two.name).toBe('archive_org');
		expect(two.draft).toMatchObject({
			instance: 'archive_org',
			layout: 'home',
			apis: 'v1_and_v2',
			listen: { kind: 'tls', host: '10.0.0.5', port: 8473 },
			agent_user: 'archive_org_agent',
			v1: { user: 'archive_org_v1' },
			v2: { unit: 'dedalo-publication-api-v2-archive_org', user: 'archive_org_v2', port: 3101 },
			media: { mode: 'copy' },
		});
		expect(two.draft.engine_group).toBeUndefined();
		const one = proposeDraft(
			{
				domain: 'archive.org',
				machines: 'one',
				listenHost: '',
				apis: 'v2_only',
				engineGroup: 'dedalo',
				mediaRoot: '/srv/dedalo/media',
			},
			context,
		);
		expect(one.draft).toMatchObject({
			listen: { kind: 'unix' },
			engine_group: 'dedalo',
			media: { mode: 'shared', root: '/srv/dedalo/media' },
			v2: { port: 3100 }, // the TLS draft is another machine
		});
		expect(one.draft.v1).toBeUndefined();
		// a proposal is a valid draft once the operator has nothing to add
		expect(validateDraft('archive_org', one.draft, context)).toEqual(one.draft);
	});

	test('the draft file the kit carries is the panel draft, nothing added', () => {
		expect(JSON.parse(draftJson(v2Draft()))).toEqual(v2Draft());
	});
});

// --------------------------------------------------------------------------- 2. the actions

interface Harness {
	deps: SetupDeps;
	actions: ReturnType<typeof createSetupActions>;
	audits: Record<string, unknown>[];
	kitBuilds: string[];
}

async function harness(over: Partial<SetupDeps> = {}): Promise<Harness> {
	const real = await loadDefaultSetupDeps();
	const audits: Record<string, unknown>[] = [];
	const kitBuilds: string[] = [];
	const deps: SetupDeps = {
		...real,
		engineGroup: async () => 'dedalo',
		engineMediaRoot: () => '/srv/dedalo/media',
		audit: async (_principal, what, data) => {
			audits.push({ what, ...data });
		},
		buildKit: async (name) => {
			kitBuilds.push(name);
			throw new KitBuildError('no_verified_release', 'kit refused (no_verified_release): test');
		},
		cachedKit: async () => null,
		removeKit: async () => undefined,
		answerWithinMs: () => 2_000,
		...over,
	};
	return { deps, actions: createSetupActions(async () => deps), audits, kitBuilds };
}

describe('the actions: root only, the store, the panel rows', () => {
	let base: ReturnType<typeof useScratchPublicationHostsBase>;
	beforeEach(() => {
		base?.dispose();
		base = useScratchPublicationHostsBase();
	});
	afterAll(() => base?.dispose());

	test('every action refuses a non-root admin FIRST — nothing loaded, nothing written', async () => {
		let loads = 0;
		const actions = createSetupActions(async () => {
			loads += 1;
			throw new Error('must not load');
		});
		for (const [action, run] of Object.entries(actions)) {
			expect(
				await codeOf(
					run(
						{ name: 'museum_org', draft: v2Draft(), package_base64: 'AA==', passphrase: 'x' },
						ADMIN,
					),
				),
				action,
			).toBe('perm.denied');
		}
		expect(loads).toBe(0);
		expect(existsSync(draftsPath())).toBe(false);
	});

	test('save_draft stores 0600 in the private dir (never the registry), audits; remove_draft drops it', async () => {
		const h = await harness();
		const saved = await h.actions.save_draft({ name: 'museum_org', draft: v2Draft() }, ROOT);
		expect(saved.data).toEqual({ name: 'museum_org', draft: v2Draft() });
		expect(draftsPath().startsWith(base.base)).toBe(true);
		expect(statSync(draftsPath()).mode & 0o777).toBe(0o600);
		expect(existsSync(registryPath())).toBe(false); // a draft is not a paired host
		expect(h.audits).toEqual([
			expect.objectContaining({
				what: 'SAVE',
				action: 'publication_hosts.save_draft',
				draft: 'museum_org',
				listen: '127.0.0.1:8471',
			}),
		]);
		// the same name twice: the field is named
		const again = await errorOf(
			h.actions.save_draft({ name: 'museum_org', draft: v2Draft() }, ROOT),
		);
		expect(again.code).toBe('publication_host_setup.draft_invalid');
		expect(again.details).toEqual({ fields: 'name' });
		// the panel lists it, awaiting installation
		const rows = await draftRows(h.deps, loadRegistry());
		expect(rows.state).toBe('ok');
		expect(rows.drafts?.map((r) => [r.name, r.state, r.kit])).toEqual([
			['museum_org', 'awaiting', null],
		]);
		await h.actions.remove_draft({ name: 'museum_org' }, ROOT);
		expect((await draftRows(h.deps, loadRegistry())).drafts).toEqual([]);
		expect(h.audits.at(-1)).toMatchObject({ what: 'DELETE', draft: 'museum_org' });
		expect(await codeOf(h.actions.remove_draft({ name: 'museum_org' }, ROOT))).toBe(
			'maintenance.action_refused',
		);
	});

	test('a refused draft names its fields in details and its sentences in the message; nothing stored', async () => {
		const h = await harness();
		const error = await errorOf(
			h.actions.save_draft(
				{
					name: 'museum_org',
					draft: { ...v2Draft(), v2: { ...v2Draft().v2, user: 'museum_org_agent' } },
				},
				ROOT,
			),
		);
		expect(error.code).toBe('publication_host_setup.draft_invalid');
		expect(error.details).toEqual({ fields: 'v2.user' });
		expect(error.publicMessage).toContain('v2.user');
		expect(existsSync(draftsPath())).toBe(false);
		expect(h.audits).toEqual([]);
		// a bad name is refused before anything loads
		expect(
			(await errorOf(h.actions.save_draft({ name: '../x', draft: v2Draft() }, ROOT))).details,
		).toEqual({ fields: 'name' });
	});

	test('a corrupt drafts file is LOUD: drafts_invalid on the panel and on the actions, never "no drafts"', async () => {
		writeFileSync(draftsPath(), '{"version":1,"drafts":[{"name":"x"}]}\n', { mode: 0o600 });
		const h = await harness();
		expect(await draftRows(h.deps, loadRegistry())).toEqual({
			state: 'drafts_invalid',
			drafts: null,
		});
		expect(await codeOf(h.actions.save_draft({ name: 'museum_org', draft: v2Draft() }, ROOT))).toBe(
			'publication_host_setup.drafts_invalid',
		);
		expect(await codeOf(h.actions.propose_draft({ domain: 'museum.org' }, ROOT))).toBe(
			'publication_host_setup.drafts_invalid',
		);
		// a widened mode is refused like the registry's (unreadable), never trusted
		writeFileSync(draftsPath(), '{"version":1,"drafts":[]}\n');
		chmodSync(draftsPath(), 0o644);
		expect(await draftRows(h.deps, loadRegistry())).toEqual({
			state: 'drafts_invalid',
			drafts: null,
		});
	});

	test('propose_draft: the convention + the work group + the media root (one machine)', async () => {
		const h = await harness();
		const answer = await h.actions.propose_draft({ domain: ' Museum.Org ', machines: 'one' }, ROOT);
		expect(answer.data).toMatchObject({
			name: 'museum_org',
			draft: {
				instance: 'museum_org',
				listen: { kind: 'unix' },
				engine_group: 'dedalo',
				media: { mode: 'shared', root: '/srv/dedalo/media' },
			},
		});
	});

	test('build_kit maps a refusal to publication_host_setup.kit_refused with its reason; download needs a built kit', async () => {
		const h = await harness();
		await h.actions.save_draft({ name: 'museum_org', draft: v2Draft() }, ROOT);
		const error = await errorOf(h.actions.build_kit({ name: 'museum_org' }, ROOT));
		expect(error.code).toBe('publication_host_setup.kit_refused');
		expect(error.details).toEqual({ reason: 'no_verified_release' });
		expect(error.publicMessage).toContain('hostagent:pack');
		expect(h.kitBuilds).toEqual(['museum_org']);
		expect(await codeOf(h.actions.download_kit({ name: 'museum_org' }, ROOT))).toBe(
			'maintenance.action_refused',
		);
		expect(await codeOf(h.actions.build_kit({ name: 'nobody' }, ROOT))).toBe(
			'maintenance.action_refused',
		);
	});
});

// ------------------------------------------------------------------------------ 3. the kit

const AGENT_REL = 'publication/host_agent';

/** An INSTALLED tree: the checkout's tracked kit source, the install stamp, the manifest. */
async function installedTree(withManifest = true): Promise<string> {
	const root = mkdtempSync(join(scratch, 'tree_'));
	const listed = Bun.spawnSync(
		[
			'git',
			'ls-files',
			'-z',
			'--',
			AGENT_REL,
			'.bun-version',
			'.bun-sha256',
			'publication/server_api/v2/.env.example',
			'publication/server_api/v1/config_api/sample.server_config_api.php',
		],
		{ cwd: REPO },
	);
	for (const rel of listed.stdout.toString().split('\0').filter(Boolean)) {
		if (!existsSync(join(REPO, rel))) continue;
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		cpSync(join(REPO, rel), join(root, rel));
	}
	mkdirSync(dirname(join(root, INSTALL_STAMP_PATH)), { recursive: true });
	writeFileSync(
		join(root, INSTALL_STAMP_PATH),
		JSON.stringify({ digest: DIGEST, channel: 'master' }),
	);
	if (withManifest) await writePublicationManifest(root, DIGEST);
	return root;
}

/** The production install's stand-in: this checkout's zod, copied (the real install is the drill's). */
const fakeInstall =
	(calls: string[]) =>
	async (agentDir: string): Promise<void> => {
		calls.push(agentDir);
		cpSync(join(REPO, 'node_modules/zod'), join(agentDir, 'node_modules/zod'), { recursive: true });
	};

async function unpack(file: string): Promise<string> {
	const dest = mkdtempSync(join(scratch, 'kit_'));
	await extractBundle(
		Bun.file(file).stream(),
		dest,
		{ maxBytes: 1 << 28, maxEntries: 50_000, maxPathLength: 1024 },
		[],
	);
	return dest;
}

describe('the kit: verified source, the agent judges the draft, deterministic, cached', () => {
	let tree: string;
	beforeAll(async () => {
		tree = await installedTree();
	});

	test('built from the verified tree: MANIFEST + draft.json + install.sh + source/ (no tests, no v1 sample for v2-only)', async () => {
		const installs: string[] = [];
		const seams: KitBuildSeams = {
			treeRoot: tree,
			backupRoot: mkdtempSync(join(scratch, 'backup_')),
			digest: DIGEST,
			version: '7.0.0',
			installDeps: fakeInstall(installs),
		};
		const kit = await buildPanelKit('museum_org', v2Draft(), seams);
		expect(kit).toMatchObject({
			name: 'museum_org',
			instance: 'museum_org',
			release: '7.0.0_b2c3d4e',
			file_name: 'dedalo_publication_host_kit_museum_org.tar.gz',
		});
		expect(kit.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(kit.file).mode & 0o777).toBe(0o600);
		const dest = await unpack(kit.file);
		expect(JSON.parse(readFileSync(join(dest, 'draft.json'), 'utf8'))).toEqual(v2Draft());
		expect(readFileSync(join(dest, 'install.sh'), 'utf8')).toBe(
			readFileSync(join(REPO, AGENT_REL, 'deploy/install.sh'), 'utf8'),
		);
		expect(existsSync(join(dest, 'source', AGENT_REL, 'src/provision/layout.ts'))).toBe(true);
		expect(existsSync(join(dest, 'source', AGENT_REL, 'node_modules/zod/package.json'))).toBe(true);
		expect(existsSync(join(dest, 'source', AGENT_REL, 'tests'))).toBe(false);
		expect(existsSync(join(dest, 'source', AGENT_REL, '.env.test'))).toBe(false);
		expect(
			existsSync(
				join(dest, 'source/publication/server_api/v1/config_api/sample.server_config_api.php'),
			),
		).toBe(false);
		expect(existsSync(join(dest, 'source/.bun-version'))).toBe(true);
		const manifest = readFileSync(join(dest, 'MANIFEST'), 'utf8');
		expect(manifest.split('\n')[0]).toBe('# dedalo publication-host kit 1');
		expect(manifest).toContain('  draft.json\n');
		// cached: the same draft is the same kit, no second install; the sha is the file's
		expect(await cachedPanelKit('museum_org', v2Draft(), seams)).toMatchObject({
			sha256: kit.sha256,
		});
		expect((await buildPanelKit('museum_org', v2Draft(), seams)).sha256).toBe(kit.sha256);
		expect(installs).toHaveLength(1);
		// another draft is another kit (the cache is keyed on the draft bytes)
		expect(
			await cachedPanelKit('museum_org', v2Draft({ agent_user: 'other_agent' }), seams),
		).toBeNull();
		// deterministic: a fresh build root gives the same bytes
		const again = await buildPanelKit('museum_org', v2Draft(), {
			...seams,
			backupRoot: mkdtempSync(join(scratch, 'backup_')),
		});
		expect(again.sha256).toBe(kit.sha256);
		// v1 + v2: the v1 sample is carried
		const v1 = await buildPanelKit(
			'museum_v1',
			v2Draft({ apis: 'v1_and_v2', v1: { user: 'museum_org_v1' } }),
			seams,
		);
		expect(
			existsSync(
				join(
					await unpack(v1.file),
					'source/publication/server_api/v1/config_api/sample.server_config_api.php',
				),
			),
		).toBe(true);
	}, 120_000);

	test("the AGENT'S parseDraft judges the draft in the kit's copy (a refusal is draft_refused)", async () => {
		const seams: KitBuildSeams = {
			treeRoot: tree,
			backupRoot: mkdtempSync(join(scratch, 'backup_')),
			digest: DIGEST,
			version: '7.0.0',
			installDeps: fakeInstall([]),
		};
		// a key the agent's strict draft schema does not know: the panel's reader never sends one,
		// so the gate builds the draft past it — what the judge must catch on its own
		const smuggled = {
			...v2Draft(),
			paths: { config_base: 'relative/path' },
		} as unknown as PanelDraft;
		const error = await buildPanelKit('museum_org', smuggled, seams).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(KitBuildError);
		expect((error as KitBuildError).reason).toBe('draft_refused');
	}, 120_000);

	test('an agent lockfile entry outside the registry is deps_unpinned, before any install', async () => {
		const unpinned = await installedTree(false);
		const lock = join(unpinned, AGENT_REL, 'bun.lock');
		writeFileSync(
			lock,
			readFileSync(lock, 'utf8').replace(
				'"packages": {',
				'"packages": {\n    "zz_local": ["zz_local@file:../zz_local", {}],',
			),
		);
		await writePublicationManifest(unpinned, DIGEST);
		const installs: string[] = [];
		const error = await buildPanelKit('museum_org', v2Draft(), {
			treeRoot: unpinned,
			backupRoot: mkdtempSync(join(scratch, 'backup_')),
			digest: DIGEST,
			version: '7.0.0',
			installDeps: fakeInstall(installs),
		}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(KitBuildError);
		expect((error as KitBuildError).reason).toBe('deps_unpinned');
		expect((error as KitBuildError).paths).toEqual(['bun.lock:zz_local']);
		expect(installs).toEqual([]);
	}, 120_000);

	test('a file changed after the update, a dev checkout, a manifest without the kit census: refused, no kit', async () => {
		const backupRoot = mkdtempSync(join(scratch, 'backup_'));
		const drifted = await installedTree();
		writeFileSync(
			join(drifted, AGENT_REL, 'src/provision/layout.ts'),
			'// edited after the update\n',
			{ flag: 'a' },
		);
		const reasonOf = async (seams: KitBuildSeams) =>
			(await buildPanelKit('museum_org', v2Draft(), seams).then(
				() => null,
				(e: unknown) => e,
			)) as KitBuildError | null;
		const drift = await reasonOf({
			treeRoot: drifted,
			backupRoot,
			digest: DIGEST,
			version: '7.0.0',
			installDeps: fakeInstall([]),
		});
		expect(drift?.reason).toBe('drift');
		expect(drift?.paths.join(' ')).toContain('src/provision/layout.ts');
		expect(
			(await reasonOf({ treeRoot: tree, backupRoot, digest: null, version: '7.0.0' }))?.reason,
		).toBe('no_verified_release');
		const noManifest = await installedTree(false);
		expect(
			(await reasonOf({ treeRoot: noManifest, backupRoot, digest: DIGEST, version: '7.0.0' }))
				?.reason,
		).toBe('missing_manifest');
		// a manifest an older updater wrote (APIs only): the kit census is missing → refused
		const oldManifest = await installedTree(false);
		writeFileSync(
			join(oldManifest, 'src/core/update/publication_manifest.json'),
			JSON.stringify({ version: 1, digest: DIGEST, files: {} }),
		);
		const old = await reasonOf({
			treeRoot: oldManifest,
			backupRoot,
			digest: DIGEST,
			version: '7.0.0',
		});
		expect(old?.reason).toBe('drift');
		expect(
			readdirSync(backupRoot, { recursive: true }).some((f) => String(f).endsWith('.tar.gz')),
		).toBe(false);
	}, 120_000);

	test("a build in flight is the DRAFT's: another draft under the same name is its own build; a removal waits for it", async () => {
		const seams: KitBuildSeams = {
			treeRoot: tree,
			backupRoot: mkdtempSync(join(scratch, 'backup_')),
			digest: DIGEST,
			version: '7.0.0',
			installDeps: fakeInstall([]),
		};
		const first = buildPanelKit('museum_org', v2Draft(), seams);
		const second = buildPanelKit('museum_org', v2Draft({ agent_user: 'other_agent' }), seams);
		const [a, b] = await Promise.all([first, second]);
		expect(a.sha256).not.toBe(b.sha256);
		// a removal issued while a build runs still leaves no kit behind
		const third = buildPanelKit('museum_x', v2Draft(), seams);
		await removePanelKit('museum_x', seams); // waits for `third`, then deletes what it wrote
		await third;
		expect(await cachedPanelKit('museum_x', v2Draft(), seams)).toBeNull();
	}, 120_000);

	test('the read-time re-hash: a file changed AFTER the tree check (during the install) is refused, named', async () => {
		const swapped = await installedTree();
		const edit = async (agentDir: string) => {
			await fakeInstall([])(agentDir);
			writeFileSync(join(swapped, '.bun-version'), '9.9.9\n'); // the tree check already passed
		};
		const error = await buildPanelKit('museum_org', v2Draft(), {
			treeRoot: swapped,
			backupRoot: mkdtempSync(join(scratch, 'backup_')),
			digest: DIGEST,
			version: '7.0.0',
			installDeps: edit,
		}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(KitBuildError);
		expect((error as KitBuildError).reason).toBe('drift');
		expect((error as KitBuildError).paths).toEqual(['.bun-version']);
	}, 120_000);
});

// --------------------------------------------------------------------------- 4. the upload

describe('pair_package: the sealed package completes a saved draft, through the shared path', () => {
	let pki: TestPki;
	let agent: MockAgent;
	let base: ReturnType<typeof useScratchPublicationHostsBase>;
	let passphrase: string;

	beforeAll(() => {
		pki = mintTestPki('dedalo-setup-test');
		agent = startMockAgent({ kind: 'tls', pki }, 'museum_org', TOKEN);
	});
	afterAll(() => {
		agent.stop();
		base?.dispose();
	});
	beforeEach(() => {
		base?.dispose();
		base = useScratchPublicationHostsBase();
		agent.reset();
		passphrase = newPassphrase();
	});

	const draftAt = (port: number, over: Partial<PanelDraft> = {}) =>
		v2Draft({ listen: { kind: 'tls', host: '127.0.0.1', port }, ...over });
	const fragment = (instance: string, port: number, token = TOKEN) =>
		[
			`${FRAGMENT_KEYS.instance}="${instance}"`,
			`${FRAGMENT_KEYS.url}="https://127.0.0.1:${port}/publication/host_agent"`,
			`${FRAGMENT_KEYS.fingerprint}="${publicationHostFingerprint(instance, token)}"`,
			'',
		].join('\n');
	const sealed = (instance = 'museum_org', port = agent.port, token = TOKEN) =>
		Buffer.from(
			sealPairingPackage(
				{ fragment: fragment(instance, port, token), token, bundle: pki.bundlePem },
				passphrase,
			),
		).toString('base64');

	async function withDraft(draft: PanelDraft = draftAt(agent.port)): Promise<Harness> {
		const h = await harness();
		await h.actions.save_draft({ name: 'museum_org', draft }, ROOT);
		h.audits.length = 0;
		return h;
	}
	const nothingStored = () => {
		expect(loadRegistry().hosts).toEqual([]);
		expect(existsSync(hostSecretDir('museum_org'))).toBe(false);
	};
	const reasonOf = async (promise: Promise<unknown>) => {
		const error = await errorOf(promise);
		return error.code === 'publication_host_setup.pairing_refused'
			? String(error.details?.reason)
			: error.code;
	};

	test('the happy path: bound to the draft, proved live over mTLS (no bearer), committed, audited, draft paired', async () => {
		const h = await withDraft();
		const logs: string[] = [];
		const spies = (['info', 'warn', 'error', 'log'] as const).map((level) =>
			spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logs.push(args.map(String).join(' '));
			}),
		);
		let answer: Awaited<ReturnType<Harness['actions']['pair_package']>>;
		try {
			answer = await h.actions.pair_package(
				{ name: 'museum_org', package_base64: sealed(), passphrase },
				ROOT,
			);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		expect(answer.data).toEqual({
			name: 'museum_org',
			instance: 'museum_org',
			address_label: `https://127.0.0.1:${agent.port}`,
		});
		const [record] = loadRegistry().hosts;
		expect(record).toMatchObject({
			name: 'museum_org',
			instance: 'museum_org',
			address: { kind: 'tls', host: '127.0.0.1', port: agent.port },
		});
		expect(record?.fingerprint).toBe(publicationHostFingerprint('museum_org', TOKEN));
		for (const file of readdirSync(hostSecretDir('museum_org'))) {
			expect(statSync(join(hostSecretDir('museum_org'), file)).mode & 0o777, file).toBe(0o600);
		}
		// the proof: /health only, never a bearer
		expect(agent.requests.map((r) => r.path)).toEqual(['/publication/host_agent/health']);
		expect(
			agent.requests.every((r) => r.authorization === null || r.authorization === undefined),
		).toBe(true);
		expect(h.audits).toEqual([
			expect.objectContaining({
				what: 'SAVE',
				action: 'publication_hosts.pair_package',
				host: 'museum_org',
				instance: 'museum_org',
			}),
		]);
		// the draft now reads paired (derived from the registry)
		const rows = await draftRows(h.deps, loadRegistry());
		expect(rows.drafts?.map((r) => [r.state, r.paired_as])).toEqual([['paired', 'museum_org']]);
		expect(
			await reasonOf(
				h.actions.pair_package({ name: 'museum_org', package_base64: sealed(), passphrase }, ROOT),
			),
		).toBe('draft_paired');
		// NO SECRET anywhere it could leak: the answer, the log lines, the audit rows
		const visible = JSON.stringify([answer, logs, h.audits]);
		for (const secret of [
			TOKEN,
			passphrase,
			passphrase.replace(/-/g, ''),
			'PRIVATE KEY',
			'BEGIN CERTIFICATE',
			publicationHostFingerprint('museum_org', TOKEN),
		]) {
			expect(visible.includes(secret), secret).toBe(false);
		}
	});

	test('a wrong passphrase and a tampered package: one refusal (package_auth), nothing stored, nothing dialled', async () => {
		const h = await withDraft();
		const other = newPassphrase();
		expect(
			await reasonOf(
				h.actions.pair_package(
					{ name: 'museum_org', package_base64: sealed(), passphrase: other },
					ROOT,
				),
			),
		).toBe('package_auth');
		const bytes = Buffer.from(sealed(), 'base64');
		bytes.writeUInt8(bytes.readUInt8(bytes.length - 20) ^ 0x01, bytes.length - 20);
		expect(
			await reasonOf(
				h.actions.pair_package(
					{ name: 'museum_org', package_base64: bytes.toString('base64'), passphrase },
					ROOT,
				),
			),
		).toBe('package_auth');
		expect(
			await reasonOf(
				h.actions.pair_package(
					{
						name: 'museum_org',
						package_base64: Buffer.from('not a package').toString('base64'),
						passphrase,
					},
					ROOT,
				),
			),
		).toBe('package_invalid');
		expect(
			await reasonOf(
				h.actions.pair_package(
					{ name: 'museum_org', package_base64: sealed(), passphrase: 'short' },
					ROOT,
				),
			),
		).toBe('passphrase_shape');
		expect(
			await reasonOf(
				h.actions.pair_package({ name: 'museum_org', package_base64: '***', passphrase }, ROOT),
			),
		).toBe('input');
		nothingStored();
		expect(agent.requests).toEqual([]);
	});

	test('a package for ANOTHER instance, or naming ANOTHER address than the draft: refused before any dial', async () => {
		const h = await withDraft();
		expect(
			await reasonOf(
				h.actions.pair_package(
					{ name: 'museum_org', package_base64: sealed('archive_org'), passphrase },
					ROOT,
				),
			),
		).toBe('draft_mismatch');
		// the package points at another listener (an attacker's agent, or another install)
		const decoy = startMockAgent({ kind: 'tls', pki }, 'museum_org', TOKEN);
		try {
			expect(
				await reasonOf(
					h.actions.pair_package(
						{ name: 'museum_org', package_base64: sealed('museum_org', decoy.port), passphrase },
						ROOT,
					),
				),
			).toBe('address_mismatch');
			expect(decoy.requests).toEqual([]);
		} finally {
			decoy.stop();
		}
		nothingStored();
		expect(agent.requests).toEqual([]);
	});

	test('the agent at the draft address publishes ANOTHER fingerprint: pairing_mismatch, nothing stored, no bearer', async () => {
		const h = await withDraft();
		agent.setToken(OTHER_TOKEN); // re-provisioned: /health publishes another fingerprint
		// the failure names the host being paired, never the throwaway staging dir
		const named = await errorOf(
			h.actions.pair_package({ name: 'museum_org', package_base64: sealed(), passphrase }, ROOT),
		);
		expect(named.code).toBe('publication_host.pairing_mismatch');
		expect(named.coordinates?.publication_host).toBe('museum_org');
		agent.reset();
		agent.setToken(OTHER_TOKEN);
		expect(
			await reasonOf(
				h.actions.pair_package({ name: 'museum_org', package_base64: sealed(), passphrase }, ROOT),
			),
		).toBe('publication_host.pairing_mismatch');
		nothingStored();
		expect(agent.requests.map((r) => r.path)).toEqual(['/publication/host_agent/health']);
		expect(h.audits).toEqual([]);
		// the staging copy is gone too
		expect(
			existsSync(join(base.base, 'publication_hosts'))
				? readdirSync(join(base.base, 'publication_hosts'))
				: [],
		).toEqual([]);
	});

	test('no draft, a one-machine draft, a non-root caller: refused, nothing stored', async () => {
		const h = await harness();
		expect(
			await reasonOf(
				h.actions.pair_package({ name: 'museum_org', package_base64: sealed(), passphrase }, ROOT),
			),
		).toBe('draft_unknown');
		await h.actions.save_draft(
			{ name: 'museum_org', draft: v2Draft({ listen: { kind: 'unix' }, engine_group: 'dedalo' }) },
			ROOT,
		);
		expect(
			await reasonOf(
				h.actions.pair_package({ name: 'museum_org', package_base64: sealed(), passphrase }, ROOT),
			),
		).toBe('socket_package');
		expect(
			await codeOf(
				h.actions.pair_package({ name: 'museum_org', package_base64: sealed(), passphrase }, ADMIN),
			),
		).toBe('perm.denied');
		nothingStored();
		expect(agent.requests).toEqual([]);
	});

	test('packageBinding is the check (unit): instance, then host and port', () => {
		const bind = packageBinding(draftAt(8471));
		const fields = {
			instance: 'museum_org',
			fingerprint: 'f'.repeat(64),
			url: null,
			socket: null,
			tlsBundle: null,
			token: null,
		};
		expect(() => bind(fields, { kind: 'tls', host: '127.0.0.1', port: 8471 })).not.toThrow();
		for (const [f, address] of [
			[
				{ ...fields, instance: 'other' },
				{ kind: 'tls', host: '127.0.0.1', port: 8471 },
			],
			[fields, { kind: 'tls', host: '127.0.0.2', port: 8471 }],
			[fields, { kind: 'tls', host: '127.0.0.1', port: 8472 }],
			[fields, { kind: 'unix', socket: '/run/x.sock' }],
		] as const) {
			expect(() => bind(f, address as never)).toThrow(DedaloError);
		}
	});

	test('a saved registry entry under the draft name: name_taken from the shared slot check', async () => {
		const h = await withDraft();
		saveRegistry({
			version: 1,
			hosts: [host('museum_org', 'unrelated', { kind: 'tls', host: '10.1.1.1', port: 9000 })],
		});
		expect(
			await reasonOf(
				h.actions.pair_package({ name: 'museum_org', package_base64: sealed(), passphrase }, ROOT),
			),
		).toBe('name_taken');
		expect(loadRegistry().hosts.map((x) => x.instance)).toEqual(['unrelated']);
	});
});
