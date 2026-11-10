/**
 * publication_hosts client — the public-URL probe (phase 6). The pure decision (which probe
 * facts a host row shows) is imported and exercised; the render wiring is pinned at the
 * source level (vanilla JS, no DOM here — the DOM behaviour is
 * client/dedalo/test/client/js/test_publication_hosts.js, `bun run test:client`).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probe_facts } from '../../client/dedalo/core/area_maintenance/widgets/publication_hosts/js/probe_view.js';
import { isMediaProbe } from '../../src/core/publication_host/agent_client.ts';

const DIR = join(
	import.meta.dir,
	'../../client/dedalo/core/area_maintenance/widgets/publication_hosts/js',
);
const render = readFileSync(join(DIR, 'render_publication_hosts.js'), 'utf8');

describe('public probe client', () => {
	test('probe_facts: when it was probed, and the detail only when there is one', () => {
		const probe = {
			state: 'failed',
			at: '2026-10-05T10:00:00.000Z',
			published_status: 200,
			unpublished_status: 200,
			detail: 'the gate is OPEN',
		};
		expect(probe_facts({ public_probe: probe })).toEqual([
			['publication_hosts_probe_at', 'Last public probe', '2026-10-05T10:00:00.000Z'],
			['publication_hosts_probe_detail', 'Public gate detail', 'the gate is OPEN'],
		]);
		expect(probe_facts({ public_probe: { ...probe, detail: null, at: null } })).toEqual([
			['publication_hosts_probe_at', 'Last public probe', ''],
		]);
		expect(probe_facts({ public_probe: null })).toEqual([]);
		expect(probe_facts({ probe: { published: 'a', unpublished: 'b' } })).toEqual([]);
		expect(probe_facts(null)).toEqual([]);
	});

	test('render shows the facts as TEXT (fact_row) and mounts the button through the ONE action path, no confirm', () => {
		expect(render).toContain("from './probe_view.js'");
		expect(render).toContain('probe_facts(host)');
		expect(render).toContain('render_probe_public(self, host, actions, body_response)');
		const start = render.indexOf('const render_probe_public');
		const block = render.slice(start, render.indexOf('//end render_probe_public', start));
		expect(start).toBeGreaterThan(0);
		expect(block.length).toBeGreaterThan(200);
		expect(block).toContain('run_action(self, {');
		expect(block).toContain("action: 'probe_public'");
		expect(block).toContain('options: { name: host.name }');
		expect(block).toContain('confirm_text: null');
		expect(block).not.toContain('innerHTML');
	});
});

/**
 * The agent's media.probe shape guard (agent_client.ts isMediaProbe). `web_traversable`
 * (T0-6): every dir from the media root to `.publication/pub` has o+x, so the web server
 * can stat a marker — `false` means every published file 404s. REQUIRED: the agent channel
 * has no skew window to carry (TS-era beta, engine + agent ship from one tree — the
 * `served_apis` precedent, WC-2026-10-09-publication-host-v2-only-site).
 */
describe('media.probe shape guard: web_traversable', () => {
	const probe = {
		mode: 'copy',
		root: '/srv/pub_media',
		present: true,
		read_only: false,
		pub_readable: true,
		web_traversable: true,
		pub_markers: 3,
		problems: [],
	};

	test('true, false and null (unmeasured) are accepted', () => {
		for (const web_traversable of [true, false, null]) {
			expect(isMediaProbe({ ...probe, web_traversable })).toBe(true);
		}
	});

	test('absent (an agent that predates it) and a non-boolean are refused', () => {
		const { web_traversable: _absent, ...older } = probe;
		expect(isMediaProbe(older)).toBe(false);
		for (const web_traversable of ['yes', 1, 0, {}, undefined]) {
			expect(isMediaProbe({ ...probe, web_traversable })).toBe(false);
		}
	});
});
