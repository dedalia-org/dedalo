/**
 * tool_uca_maps — the local gazetteer store (hito 18, fila #14). The store's
 * directory is an install setting, but the DATASET NAME arrives from the
 * browser: these gates pin that a name can only ever resolve inside the
 * configured directory, and that an absent file reads as absent rather than
 * throwing somewhere deeper.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	gazetteerFilePath,
	PELAGIOS_DATASETS,
	pelagiosDatasetPath,
	pleiadesIndexPath,
} from '../../tools/tool_uca_maps/server/gazetteer_store.ts';

/** A store with one dataset and the index, plus a file OUTSIDE it to escape to. */
function buildStore(): { root: string; store: string; outside: string } {
	const root = mkdtempSync(join(tmpdir(), 'uca_gazetteer_'));
	const store = join(root, 'store');
	mkdirSync(join(store, 'pelagios'), { recursive: true });
	writeFileSync(join(store, 'pleiades.json'), '[]');
	writeFileSync(join(store, 'pelagios', 'provinces.geojson'), '{"features":[]}');
	const outside = join(root, 'secret.geojson');
	writeFileSync(outside, '{"features":[]}');
	return { root, store, outside };
}

describe('gazetteer store paths', () => {
	test('resolves the index and a known dataset inside the store', () => {
		const { root, store } = buildStore();
		try {
			expect(pleiadesIndexPath(store)).toBe(join(store, 'pleiades.json'));
			expect(pelagiosDatasetPath(store, 'provinces')).toBe(
				join(store, 'pelagios', 'provinces.geojson'),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('an absent file is null, never a throw from deeper down', () => {
		const { root, store } = buildStore();
		try {
			expect(pelagiosDatasetPath(store, 'roads_high')).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a dataset name outside the closed list is refused before touching disk', () => {
		const { root, store } = buildStore();
		try {
			expect(pelagiosDatasetPath(store, '../secret')).toBeNull();
			expect(pelagiosDatasetPath(store, 'provinces.geojson')).toBeNull();
			expect(PELAGIOS_DATASETS).toContain('provinces');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('traversal out of the store is refused', () => {
		const { root, store } = buildStore();
		try {
			expect(gazetteerFilePath(store, '../secret.geojson')).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a SYMLINK pointing out of the store is refused too', () => {
		const { root, store, outside } = buildStore();
		try {
			symlinkSync(outside, join(store, 'pelagios', 'roads_low.geojson'));
			expect(pelagiosDatasetPath(store, 'roads_low')).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
