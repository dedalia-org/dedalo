/**
 * publication_hosts CLIENT LABELS: the keys the publication_hosts widget resolves
 * DYNAMICALLY. labels_tripwire scans only static `get_label.x` /
 * `get_label['x']` references, so these keys are invisible to it:
 *   - `publication_hosts_check_<id>` through check_row(…, 'publication_hosts') — for every
 *     fixed check id AND every decorator check id (phase 5: media_copy);
 *   - `publication_hosts_lead` through the System Map's map_tool_desc;
 *   - the phase-6 probe fact labels through probe_view.js probe_facts (its own keys,
 *     read off a full probe — never copied here).
 * Each key must be defined in master.json and translated in every catalog except
 * the master-source lang. CHECK_IDS IS host_status.ts HOST_CHECK_IDS (imported, never
 * copied): a new id ships red here until its label exists.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { probe_facts } from '../../client/dedalo/core/area_maintenance/widgets/publication_hosts/js/probe_view.js';
import { MASTER_SOURCE_LANG } from '../../src/core/labels/catalog.ts';
import {
	DECORATOR_CHECK_IDS,
	HOST_CHECK_IDS,
} from '../../src/core/publication_host/host_status.ts';

const LABELS_DIR = resolve(import.meta.dir, '../../src/core/labels');

// THE engine's lists, imported: a new HostCheck id without its label reds this gate.
const CHECK_IDS = [...HOST_CHECK_IDS, ...DECORATOR_CHECK_IDS];
const PROBE_FACT_KEYS = probe_facts({
	public_probe: { state: 'failed', at: 'x', detail: 'y' },
}).map(([key]) => key);
const DYNAMIC_KEYS = [
	...CHECK_IDS.map((id) => `publication_hosts_check_${id}`),
	'publication_hosts_lead',
	...PROBE_FACT_KEYS,
];

const readJson = (path: string): Record<string, string> =>
	JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;

describe('publication_hosts client labels', () => {
	const master = readJson(join(LABELS_DIR, 'master.json'));

	test('every dynamically resolved key is defined in the master', () => {
		// corpus floor: at least the 11 phase-3 check ids + media_copy + the lead, so an emptied list cannot pass vacuously
		expect(CHECK_IDS.length).toBeGreaterThanOrEqual(12);
		expect(CHECK_IDS).toContain('media_copy');
		expect(PROBE_FACT_KEYS).toHaveLength(2);
		expect(DYNAMIC_KEYS).toHaveLength(CHECK_IDS.length + 1 + PROBE_FACT_KEYS.length);
		expect(DYNAMIC_KEYS.filter((key) => master[key] === undefined)).toEqual([]);
	});

	test('every dynamically resolved key is translated in every non-master catalog', () => {
		const gaps: string[] = [];
		const scanned: string[] = [];
		for (const name of readdirSync(join(LABELS_DIR, 'catalog')).sort()) {
			const lang = name.replace('.json', '');
			if (lang === MASTER_SOURCE_LANG) continue;
			const catalog = readJson(join(LABELS_DIR, 'catalog', name));
			scanned.push(lang);
			for (const key of DYNAMIC_KEYS) {
				if (catalog[key] === undefined) gaps.push(`${lang}:${key}`);
			}
		}
		// corpus floor: the 17 non-master catalogs exist and were read
		expect(scanned.length).toBeGreaterThanOrEqual(17);
		expect(gaps).toEqual([]);
	});

	test('the widget resolves check labels through the publication_hosts prefix (anti-vacuity)', () => {
		const area = resolve(import.meta.dir, '../../client/dedalo/core/area_maintenance');
		const render = readFileSync(
			join(area, 'widgets/publication_hosts/js/render_publication_hosts.js'),
			'utf8',
		);
		expect(render).toContain("check_row(facts, check, 'publication_hosts')");
		const shared = readFileSync(
			join(area, 'widgets/update_code/js/render_update_status.js'),
			'utf8',
		);
		expect(shared).toContain("get_label[label_prefix + '_check_' + check.id]");
	});

	test('the System Map resolves the lead through map_tool_desc', () => {
		const map = readFileSync(
			resolve(
				import.meta.dir,
				'../../client/dedalo/core/area_maintenance/js/render_area_maintenance.js',
			),
			'utf8',
		);
		expect(map).toMatch(/publication_hosts\s*:\s*get_label\.publication_hosts_lead\b/);
	});
});
