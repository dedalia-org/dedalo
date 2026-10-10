/**
 * INSTALL STEP ROUTER — runInstallStep (src/core/install/engine.ts).
 *
 * The wizard's one entry point had no gate at all: the unknown-step arm, the
 * per-step session requirement on the two record-WRITING steps, and the
 * required-field guard the db probe answers with all lived untested. Nothing
 * here needs a seam — every arm below is hermetic (the default arm imports
 * nothing, install_hierarchies/register_tools THROW auth.not_logged BEFORE their
 * dynamic import, test_db_connection stops at the db_probe field guard before
 * any spawn).
 *
 * P1 error sweep: a refusing arm THROWS a registered code (the dispatch catch
 * converts it), and a returning arm answers envelope v2 — the step's own value
 * in `data`, with `msg`/`dirs`/the db-probe booleans as extension keys. The
 * compat mirror (`result`) was DELETED on 2026-08-16
 * (WC-2026-08-16-error-envelope-compat-removal): `data` is the only channel.
 *
 * THE ONTOLOGY STEPS (installer unification A4, 2026-10-09): get_ontology_catalog
 * / stage_ontologies / install_ontologies are routable WITHOUT a session (they
 * run before the in-wizard login); the probe with the update-server box off
 * answers the built-in view with no network; the two actions refuse
 * install.state_conflict on an unconfigured / unstaged install (a CHILD with a
 * scratch private dir — never the live one).
 *
 * Scratch namespace: zzi. No DB writes; the one filesystem-touching arm
 * (check_directories) runs in a CHILD process pointed at a scratch private/
 * media/backup root, and is SKIPPED unless every resolved directory is under it
 * — dirIsWritable does a real write+unlink and must never touch real user data.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { INSTALL_ROUTER_ACTIONS, runInstallStep } from '../../src/core/install/engine.ts';
import { buildInstallPlan, cliBootEnv } from '../../src/core/install/install_plan.ts';
import {
	describeOntologyCatalog,
	vendoredOntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';

/** The DedaloError a step threw, or null when it returned a body. */
async function refusalOf(
	options?: Record<string, unknown>,
): Promise<{ code: string; message: string } | null> {
	try {
		await runInstallStep(stepRqo(options), anonContext());
		return null;
	} catch (error) {
		return isDedaloError(error) ? { code: error.code, message: error.message } : null;
	}
}

const ROOT = join(import.meta.dir, '..', '..');

/** A no-session install request context (the pre-login wizard state). */
function anonContext(): ApiRequestContext {
	return {
		requestId: 'zzi-install-router',
		clientIp: '127.0.0.1',
		session: null,
		csrfCandidate: null,
	};
}

/** An RQO carrying only the install step options bag. */
function stepRqo(options?: Record<string, unknown>): Rqo {
	return { action: 'install', options } as Rqo;
}

describe('runInstallStep — unknown steps', () => {
	test('an unrecognised action THROWS install.unknown_step (404-free, 400 from the registry)', async () => {
		const refusal = await refusalOf({ action: 'nope' });
		expect(refusal?.code).toBe('install.unknown_step');
		// the step name is LOG-side only (the code's disclosure is 'operator')
		expect(refusal?.message).toBe("Unknown install step 'nope'");
	});

	test('a missing options bag falls to the same arm with an EMPTY step name', async () => {
		// quirk: pinned, not fixed — `options.action ?? ''` means "no action" is
		// reported as the unknown step '' rather than as a distinct error.
		const refusal = await refusalOf();
		expect(refusal?.code).toBe('install.unknown_step');
		expect(refusal?.message).toBe("Unknown install step ''");
	});
});

describe('runInstallStep — per-step session requirement', () => {
	// The two record-WRITING steps; every other step is reachable pre-login.
	for (const step of ['install_hierarchies', 'register_tools']) {
		test(`${step} refuses a session-less request with auth.not_logged`, async () => {
			const refusal = await refusalOf({ action: step });
			// WC-051: the code the client's re-login recovery dispatches on (401).
			expect(refusal?.code).toBe('auth.not_logged');
		});
	}
});

/**
 * A logged-in wizard context. Only `userId` is read by the arms exercised here;
 * every case below stops before a database write (a refusal, or an empty list).
 */
function sessionContext(): ApiRequestContext {
	return {
		...anonContext(),
		session: { userId: -1 } as unknown as NonNullable<ApiRequestContext['session']>,
	};
}

describe('runInstallStep — install_hierarchies takes the PLAN normalization', () => {
	// The wizard posts its own ticked list AFTER persist_config, so the router —
	// not persist_config — is where the CLI ≡ wizard thesaurus rule must hold.
	test('a tld hierarchy.json does not list refuses install.invalid_input BEFORE any import', async () => {
		let refusal: { code: string; message: string } | null = null;
		try {
			await runInstallStep(
				stepRqo({ action: 'install_hierarchies', hierarchies: ['zzibogus'] }),
				sessionContext(),
			);
		} catch (error) {
			if (isDedaloError(error)) refusal = { code: error.code, message: error.message };
		}
		expect(refusal?.code).toBe('install.invalid_input');
		expect(refusal?.message).toContain("unknown hierarchy 'zzibogus' (no entry in hierarchy.json)");
	});

	test('a core tld, in any case and repeated, is dropped with the note — nothing is imported', async () => {
		const r = await runInstallStep(
			stepRqo({ action: 'install_hierarchies', hierarchies: ['LG', 'lg'] }),
			sessionContext(),
		);
		const body = r.body as unknown as { data: unknown; msg: string; responses: unknown[] };
		expect(body.data).toBe(true);
		expect(body.responses).toEqual([]);
		expect(body.msg).toContain('lg is a core hierarchy (always activated) — dropped from the list');
	});
});

describe('runInstallStep — the ontology steps', () => {
	test('the three ontology steps are routable', () => {
		for (const step of ['get_ontology_catalog', 'stage_ontologies', 'install_ontologies']) {
			expect(INSTALL_ROUTER_ACTIONS).toContain(step);
		}
	});

	test('get_ontology_catalog with the update-server box off: the built-in view, no network, no session', async () => {
		const r = await runInstallStep(
			stepRqo({ action: 'get_ontology_catalog', update_servers: false }),
			anonContext(),
		);
		const body = r.body as unknown as {
			ok: boolean;
			data: unknown;
			msg: string;
			catalog: { entries: { tld: string }[] };
			warnings: string[];
		};
		expect(body.ok).toBe(true);
		expect(body.data).toBe(true);
		expect(body.msg).toBe('Air-gapped: only the built-in ontologies are offered');
		expect(body.catalog).toEqual(describeOntologyCatalog(vendoredOntologyCatalog()) as never);
		expect(body.catalog.entries.map((entry) => entry.tld)).toEqual(['oh']);
		expect(body.warnings).toEqual([]);
	});

	test('stage_ontologies / install_ontologies refuse an unconfigured, unstaged install — no session asked', () => {
		const outcome = runOntologyStepsChild();
		expect(outcome.stage).toEqual({
			code: 'install.state_conflict',
			message: 'ACTIVE_ONTOLOGY_TLDS was not written — save the configuration first',
		});
		expect(outcome.install).toEqual({
			code: 'install.state_conflict',
			message: 'No staged ontology files — run stage_ontologies first',
		});
	});
});

describe('runInstallStep — persist_config never takes a server path from the wizard', () => {
	// `ontology_source` names a path on the SERVER (a directory read, an archive
	// gunzipped + walked): CLI-only. The post deliberately omits the database
	// fields and chooses a non-vendored TLD, so even an unguarded door would
	// reach the path read (the oracle) and then refuse at the plan — never write.
	const post = (ontologySource: unknown) => ({
		action: 'persist_config',
		ontologies: ['zzi'],
		update_servers: false,
		ontology_source: ontologySource,
	});

	test('refused install.invalid_input with ONE text, whatever the path is', async () => {
		const missing = await refusalOf(post('/zzi_nonexistent_ontology_source'));
		const directory = await refusalOf(post(ROOT));
		const file = await refusalOf(post(join(ROOT, 'package.json')));
		expect(missing?.code).toBe('install.invalid_input');
		expect(missing?.message).toContain('ontology_source is a command-line answer');
		// no file-existence / file-type oracle: the three answers are identical
		expect(directory).toEqual(missing);
		expect(file).toEqual(missing);
		expect(missing?.message).not.toContain('no such file or directory');
		expect(missing?.message).not.toContain('/zzi_nonexistent_ontology_source');
	});

	test('a non-string value is refused the same way', async () => {
		const refusal = await refusalOf(post({ path: '/tmp' }));
		expect(refusal?.code).toBe('install.invalid_input');
		expect(refusal?.message).toContain('ontology_source is a command-line answer');
	});
});

/**
 * The two ontology ACTIONS in a child whose configuration is a FRESH machine:
 * an empty private dir (no .env → no ACTIVE_ONTOLOGY_TLDS) and an empty
 * installer private dir (nothing staged). Answers each step's refusal.
 */
function runOntologyStepsChild(): Record<string, unknown> {
	const scratch = join(tmpdir(), `dedalo_zzi_ontology_steps_${process.pid}`);
	const snippet = [
		"const { runInstallStep } = await import('./src/core/install/engine.ts');",
		"const ctx = { requestId: 'zzi', clientIp: '127.0.0.1', session: null, csrfCandidate: null };",
		'const refusal = async (action) => {',
		"  try { await runInstallStep({ action: 'install', options: { action } }, ctx); return null; }",
		'  catch (error) { return { code: error.code, message: error.message }; }',
		'};',
		"console.log(JSON.stringify({ stage: await refusal('stage_ontologies'), install: await refusal('install_ontologies') }));",
	].join('\n');
	const childEnv: Record<string, string | undefined> = { ...process.env };
	childEnv.ACTIVE_ONTOLOGY_TLDS = undefined;
	// A configured process's mandatory keys (the scratch private dir has no .env to
	// carry them): the plan's own boot environment for a database named `zzi` that
	// does not exist — both refusals must come before any query.
	const boot = cliBootEnv(
		buildInstallPlan({ db_database: 'zzi', db_username: 'zzi', entity: 'zzi' }),
	);
	const child = Bun.spawnSync(['bun', '-e', snippet], {
		cwd: ROOT,
		env: {
			...childEnv,
			...boot,
			DEDALO_PRIVATE_DIR: join(scratch, 'private'),
			DEDALO_INSTALL_PRIVATE_DIR: join(scratch, 'install_private'),
		} as Record<string, string>,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const lastLine = (child.stdout.toString().trim().split('\n').pop() ?? '').trim();
	if (child.exitCode !== 0 || lastLine === '') {
		throw new Error(`ontology steps child failed (${child.exitCode}): ${child.stderr.toString()}`);
	}
	return JSON.parse(lastLine) as Record<string, unknown>;
}

describe('runInstallStep — test_db_connection', () => {
	test('routes to the db probe and stops at the required-field guard', async () => {
		const r = await runInstallStep(stepRqo({ action: 'test_db_connection' }), anonContext());
		expect(r.status).toBe(200);
		// A PROBE ANSWER is an ok:true envelope: the four booleans + msg ride as
		// extension keys, and the verdict is `data` — the whole body, exactly.
		expect(r.body).toEqual({
			can_connect: false,
			db_exists: false,
			can_create: false,
			msg: 'Database name and user are required',
			ok: true,
			request_id: 'zzi-install-router',
			data: false,
		});
	});
});

/**
 * check_directories in a child process with the private/media/backup roots
 * pointed at a NON-EXISTENT scratch tree, so the write+unlink writability probe
 * can never reach real user data. The child refuses (prints `skip`) if any
 * resolved directory escapes the scratch root — e.g. if `config` had already
 * been frozen from the real environment.
 */
const SCRATCH_ROOT = join(tmpdir(), `dedalo_zzi_install_${process.pid}`);

const CHECK_DIRS_SNIPPET = [
	"const scratch = process.env.ZZI_SCRATCH_ROOT ?? '';",
	"const { installPrivateDir } = await import('./src/core/install/paths.ts');",
	"const { config } = await import('./src/config/config.ts');",
	'const roots = [installPrivateDir(), config.ops.backupDir, config.media.rootPath];',
	'const escaped = roots.filter((p) => typeof p !== "string" || !p.startsWith(scratch));',
	'if (escaped.length > 0) {',
	'  console.log(JSON.stringify({ skip: escaped }));',
	'} else {',
	"  const { runInstallStep } = await import('./src/core/install/engine.ts');",
	"  const ctx = { requestId: 'zzi', clientIp: '127.0.0.1', session: null, csrfCandidate: null };",
	"  const plain = await runInstallStep({ action: 'install', options: { action: 'check_directories' } }, ctx);",
	// A TRUTHY STRING — exactly what an HTML form posts for an unchecked box.
	"  const truthy = await runInstallStep({ action: 'install', options: { action: 'check_directories', create: 'false' } }, ctx);",
	"  const { existsSync } = await import('node:fs');",
	'  const created = truthy.body.dirs.filter((d) => existsSync(d.path)).map((d) => d.path);',
	'  console.log(JSON.stringify({ plain: plain.body, truthy: truthy.body, created }));',
	'}',
].join('\n');

function runCheckDirsChild(): Record<string, unknown> {
	// The child models a FRESH INSTALL, so it runs with the test-media seam OFF:
	// DEDALO_TEST_MEDIA_ROOT outranks MEDIA_PATH (src/config/config.ts), and the
	// suite's own root would therefore replace the scratch one this gate points at
	// — the child would report every path as "escaped" and the cases would SKIP.
	// Unsetting it is also the honest shape: this gate is about the installer on a
	// box with no suite anywhere, where the media guard is inert by construction.
	const childEnv: Record<string, string | undefined> = { ...process.env };
	childEnv.DEDALO_TEST_MEDIA_ROOT = undefined;
	const child = Bun.spawnSync(['bun', '-e', CHECK_DIRS_SNIPPET], {
		cwd: ROOT,
		env: {
			...childEnv,
			ZZI_SCRATCH_ROOT: SCRATCH_ROOT,
			DEDALO_INSTALL_PRIVATE_DIR: join(SCRATCH_ROOT, 'private'),
			MEDIA_PATH: join(SCRATCH_ROOT, 'media'),
			DEDALO_BACKUP_DIR: join(SCRATCH_ROOT, 'backups'),
		} as Record<string, string>,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const lastLine = (child.stdout.toString().trim().split('\n').pop() ?? '').trim();
	if (child.exitCode !== 0 || lastLine === '') {
		throw new Error(
			`check_directories child failed (${child.exitCode}): ${child.stderr.toString()}`,
		);
	}
	return JSON.parse(lastLine) as Record<string, unknown>;
}

const childResult = runCheckDirsChild();
const scratchConfirmed = childResult.skip === undefined;

describe('runInstallStep — check_directories', () => {
	test.if(scratchConfirmed)('reports one row per managed directory', () => {
		const body = childResult.plain as {
			ok: boolean;
			data: boolean;
			dirs: unknown[];
			msg: string;
		};
		expect(Array.isArray(body.dirs)).toBe(true);
		expect(body.dirs.length).toBeGreaterThan(0);
		// The ENVELOPE succeeded (the check ran); the check's own verdict is
		// `data`. Nothing exists under the scratch root, so the pre-flight must
		// say so.
		expect(body.ok).toBe(true);
		expect(body.data).toBe(false);
		expect(body.msg).toBe('One or more directories need attention');
	});

	test.if(scratchConfirmed)(
		"create:'false' — a TRUTHY STRING — creates nothing (=== true, not truthiness)",
		() => {
			const body = childResult.truthy as { dirs: { exists: boolean }[] };
			expect(body.dirs.length).toBeGreaterThan(0);
			expect(childResult.created).toEqual([]);
			expect(body.dirs.every((d) => d.exists === false)).toBe(true);
			// And the scratch tree really was never touched.
			expect(existsSync(SCRATCH_ROOT)).toBe(false);
		},
	);

	test.if(!scratchConfirmed)('SKIPPED: install dirs did not resolve under the scratch root', () => {
		// Audible: the write+unlink writability probe would have hit real paths.
		console.warn(
			`check_directories cases skipped — these escaped ${SCRATCH_ROOT}: ${JSON.stringify(childResult.skip)}`,
		);
		expect(childResult.skip).toBeDefined();
	});
});
