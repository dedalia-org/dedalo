/**
 * serve_ontology widget — the PROVIDER-side readout (TS-only,
 * WC-2026-09-28-maintenance-serve-ontology-widget).
 *
 * Split out of update_ontology (2026-09-28). The answer to "can OTHER
 * installations pull their ontology from here?" is spread over three unrelated
 * .env keys (IS_AN_ONTOLOGY_SERVER, the ONTOLOGY_SERVERS codes,
 * DEDALO_CORS_ALLOWED_ORIGINS); the client renders one checklist row per key, so
 * the contract gated here is:
 *
 *   1. registration + display-only surface (no apiActions);
 *   2. the three booleans + the endpoint clients register, each boolean tracking
 *      ITS key (a checklist that lies is worse than none);
 *   3. the access CODE ITSELF never rides the wire — only whether one is set;
 *   4. update_ontology no longer carries the readout (one home, no drift).
 *
 * `config` and CORS_ENABLED are both frozen at import time, so every env case
 * boots a REAL subprocess: re-importing in-process would assert nothing about
 * how the server actually reads its configuration.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ALL_WIDGET_MODULES } from '../../src/core/area_maintenance/widgets/registry.ts';
import { widget } from '../../src/core/area_maintenance/widgets/serve_ontology.ts';

const ROOT = join(import.meta.dir, '..', '..');

/**
 * The panel payload as the client receives it, from a child booted with a given
 * env — plus the update_ontology payload's key set (leg 4).
 */
const READ_PANEL_SERVING =
	"const { dispatchGetWidgetValue } = await import('./src/core/area_maintenance/widgets/registry.ts');" +
	'const ADMIN = { userId: -1, isGlobalAdmin: true, isDeveloper: true };' +
	"const body = await dispatchGetWidgetValue(ADMIN, { model: 'serve_ontology' });" +
	"const pull = await dispatchGetWidgetValue(ADMIN, { model: 'update_ontology' });" +
	'console.log(JSON.stringify({ ...body.data, update_ontology_keys: Object.keys(pull.data) }));';

/**
 * Every test here SPAWNS A FULL ENGINE BOOT (config graph + a Postgres
 * connection) and reads its stdout, which costs ~0.5 s warm but seconds on a
 * cold transpile cache or a cold pool. Under bun's DEFAULT 5 s budget that made
 * the suite intermittently red with a flat "timed out after 5000ms" — a timing
 * flake wearing a logic failure's clothes, and the kind of red that teaches a
 * reader to re-run instead of to look. Hence the explicit per-test timeouts
 * below, the same convention the other spawn-heavy gates use
 * (activity_log_native, activity_deep_offset_flip). The budget is generous ON
 * PURPOSE: it bounds a hang, it does not measure performance.
 */
function panelServingWith(env: Record<string, string | undefined>): {
	exitCode: number;
	serving: Record<string, unknown>;
	stdout: string;
	stderr: string;
} {
	const child = Bun.spawnSync(['bun', '-e', READ_PANEL_SERVING], {
		cwd: ROOT,
		env: {
			...process.env,
			// No configured masters: update_ontology (read for leg 4) probes every
			// one of them over the network.
			ONTOLOGY_SERVERS: '[]',
			...env,
		} as Record<string, string>,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	// The child may log boot noise; the payload is the LAST line it prints.
	const stdout = (child.stdout.toString().trim().split('\n').pop() ?? '').trim();
	return {
		exitCode: child.exitCode,
		serving: stdout.startsWith('{') ? JSON.parse(stdout) : {},
		stdout,
		stderr: child.stderr.toString().trim(),
	};
}

describe('serve_ontology widget — serving readout', () => {
	test('is registered, config category, display-only', () => {
		expect(ALL_WIDGET_MODULES.find((m) => m.spec.id === 'serve_ontology')).toBe(widget);
		expect(widget.spec.category).toBe('config');
		expect(widget.spec.label).toEqual({ kind: 'label', key: 'serve_ontology' });
		expect(widget.apiActions).toBeUndefined();
		expect(typeof widget.getValue).toBe('function');
	});

	test('reports every serving key as unset when none is configured', () => {
		// Explicit empty values, never `undefined`: the installation's own
		// ../private/.env is still read by the child, so a key is only OFF for
		// this case if the overlay says so.
		const boot = panelServingWith({
			IS_AN_ONTOLOGY_SERVER: 'false',
			ONTOLOGY_SERVERS: '[]',
			DEDALO_CORS_ALLOWED_ORIGINS: '[]',
		});
		expect(boot.exitCode).toBe(0);
		expect(boot.serving.enabled).toBe(false);
		expect(boot.serving.has_server_code).toBe(false);
		expect(boot.serving.cors_enabled).toBe(false);
		// The endpoint is reported whatever the state — it is what a client must
		// register, and the admin needs it BEFORE turning serving on.
		expect(String(boot.serving.url)).toContain('/dedalo/core/api/v1/json/');
		// leg 4: the pull panel no longer carries a second copy of the readout
		expect(boot.serving.update_ontology_keys).toContain('servers');
		expect(boot.serving.update_ontology_keys).not.toContain('serving');
	}, 30000);

	test('each flag tracks its own key', () => {
		const boot = panelServingWith({
			IS_AN_ONTOLOGY_SERVER: 'true',
			// the retired key set ALONE does not count as an accepted code
			ONTOLOGY_SERVER_CODE: 'zzretiredwidget',
			ONTOLOGY_SERVERS: '[]',
			DEDALO_CORS_ALLOWED_ORIGINS: '["https://client.example.org"]',
		});
		expect(boot.exitCode).toBe(0);
		expect(boot.serving.enabled).toBe(true);
		expect(boot.serving.has_server_code).toBe(false);
		expect(boot.serving.cors_enabled).toBe(true);
	}, 30000);

	test('the access code is reported as CONFIGURED, never echoed', () => {
		const secret = 'xx-myspecialcode-xxx';
		const boot = panelServingWith({
			IS_AN_ONTOLOGY_SERVER: 'true',
			// a code-only entry (no tlds): it is not probed as a pull source
			ONTOLOGY_SERVERS: JSON.stringify([
				{ name: 'client', url: 'https://client.example.org/api/', code: secret },
			]),
			DEDALO_CORS_ALLOWED_ORIGINS: '["*"]',
		});
		expect(boot.exitCode).toBe(0);
		expect(boot.serving.has_server_code).toBe(true);
		expect(boot.serving.cors_enabled).toBe(true);
		// A shared secret on an admin panel is still a secret: the whole payload
		// must not carry it.
		expect(boot.stdout).not.toContain(secret);
	}, 30000);

	test('update_ontology (on an ontology server) lists the provider, never the code-only entry', () => {
		const CODE_ONLY = 'https://client.example.org/api/';
		const PROVIDER = 'https://provider.invalid/api/';
		const script =
			"const { dispatchGetWidgetValue } = await import('./src/core/area_maintenance/widgets/registry.ts');" +
			'const ADMIN = { userId: -1, isGlobalAdmin: true, isDeveloper: true };' +
			"const pull = await dispatchGetWidgetValue(ADMIN, { model: 'update_ontology' });" +
			'console.log(JSON.stringify({ urls: (pull.data.servers ?? []).map((s) => s.url) }));';
		const child = Bun.spawnSync(['bun', '-e', script], {
			cwd: ROOT,
			env: {
				...process.env,
				IS_AN_ONTOLOGY_SERVER: 'true',
				DEDALO_CORS_ALLOWED_ORIGINS: '[]',
				ONTOLOGY_SERVERS: JSON.stringify([
					{ name: 'client', url: CODE_ONLY, code: 'zzclientcode' },
					{ name: 'provider', url: PROVIDER, code: 'zzprovcode', tlds: ['dd'] },
				]),
			} as Record<string, string>,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(child.exitCode).toBe(0);
		const last = (child.stdout.toString().trim().split('\n').pop() ?? '').trim();
		const urls = (JSON.parse(last) as { urls: string[] }).urls;
		expect(urls).toContain(PROVIDER);
		expect(urls).not.toContain(CODE_ONLY);
		// the built-in Local files source is still there on an ontology server
		expect(urls.length).toBeGreaterThanOrEqual(2);
	}, 60000);
});
