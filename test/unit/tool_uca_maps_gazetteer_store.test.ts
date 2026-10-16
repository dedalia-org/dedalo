/**
 * tool_uca_maps — the local gazetteer store. The directory is an install
 * setting, but the DATASET NAME arrives from the browser: a name can only ever
 * resolve inside the configured directory, and an absent file reads as absent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	gazetteerFilePath,
	PELAGIOS_DATASETS,
	pelagiosDatasetPath,
	pleiadesIndexPath,
} from '../../tools/tool_uca_maps/server/gazetteer_store.ts';

/**
 * A store with one dataset, the index and a file the closed list does not name,
 * plus a file OUTSIDE it to escape to. Canonical, as `resolveGazetteerDir` hands
 * it over (a tmpdir behind a symlink, as on macOS, would fail the prefix check).
 */
function buildStore(): { root: string; store: string; outside: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'uca_gazetteer_')));
	const store = join(root, 'store');
	mkdirSync(join(store, 'pelagios'), { recursive: true });
	writeFileSync(join(store, 'pleiades.json'), '[]');
	writeFileSync(join(store, 'pelagios', 'provinces.geojson'), '{"features":[]}');
	writeFileSync(join(store, 'pelagios', 'extra.geojson'), '{"features":[]}');
	const outside = join(root, 'secret.geojson');
	writeFileSync(outside, '{"features":[]}');
	return { root, store, outside };
}

describe('gazetteer store paths', () => {
	let root = '';
	let store = '';
	let outside = '';
	beforeEach(() => {
		({ root, store, outside } = buildStore());
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test('resolves the index and a known dataset inside the store', () => {
		expect(pleiadesIndexPath(store)).toBe(join(store, 'pleiades.json'));
		expect(pelagiosDatasetPath(store, 'provinces')).toBe(
			join(store, 'pelagios', 'provinces.geojson'),
		);
	});

	test('an absent file is null, never a throw from deeper down', () => {
		expect(pelagiosDatasetPath(store, 'roads_high')).toBeNull();
	});

	test('a dataset name outside the closed list is refused, even for a file the store holds', () => {
		expect(pelagiosDatasetPath(store, 'extra')).toBeNull();
		expect(pelagiosDatasetPath(store, '../secret')).toBeNull();
		expect(pelagiosDatasetPath(store, 'provinces.geojson')).toBeNull();
		expect(PELAGIOS_DATASETS).toContain('provinces');
	});

	test('traversal out of the store is refused', () => {
		expect(gazetteerFilePath(store, '../secret.geojson')).toBeNull();
	});

	test('a SYMLINK pointing out of the store is refused too', () => {
		symlinkSync(outside, join(store, 'pelagios', 'roads_low.geojson'));
		expect(pelagiosDatasetPath(store, 'roads_low')).toBeNull();
	});
});
