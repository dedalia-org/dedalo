/**
 * Files planted in one image slot of the suite's MARKED media root, for the
 * gates that read an image component's tiers (get_image_file,
 * get_image_overlay). The slot must be empty before and after: a leftover
 * would be blamed on the engine.
 */

import { expect } from 'bun:test';
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../../../src/config/config.ts';
import { scanContextFromItem, scanFilesInfo } from '../../../../src/core/media/files_info.ts';
import { buildMediaLocation } from '../../../../src/core/media/path.ts';
import { requireTestMediaRoot } from '../../../../src/core/media/test_media_root.ts';
import { resolveMediaToolContext } from '../../../../src/core/media/tool_support.ts';

/** An image slot: test99 is the generic TLD's component_image. */
export interface ImageSlot {
	section_tipo: string;
	tipo: string;
	section_id: number;
}

/** `larger` is the tier listed just above the default, so it is scanned first. */
export type Tier = 'original' | 'larger' | 'default';

async function slotResidue(slot: ImageSlot): Promise<string[]> {
	const { spec, identity, pathOpts, items } = await resolveMediaToolContext({ ...slot });
	const files = scanFilesInfo(spec, identity, pathOpts, scanContextFromItem(items[0]))
		.filter((entry) => entry.file_exist)
		.map((entry) => String(entry.file_path));
	return items.length === 0 ? files : [...files, `${items.length} stored media item(s)`];
}

/** Plant `files` (with `bytes`, default a marker text) in `slot`, run `body`, remove them. */
export async function withImageFiles<T>(
	slot: ImageSlot,
	files: ReadonlyArray<{ quality: Tier; extension: string; bytes?: string | Uint8Array }>,
	body: (planted: string[]) => Promise<T>,
): Promise<T> {
	const where = `${slot.section_tipo}/${slot.tipo}/${slot.section_id}`;
	requireTestMediaRoot(config.media.rootPath ?? '', 'tool_uca_maps image slot');
	expect(await slotResidue(slot), `residue in ${where} before planting`).toHaveLength(0);
	const { spec, identity, pathOpts } = await resolveMediaToolContext({ ...slot });
	const tiers: Record<Tier, string | undefined> = {
		original: spec.originalQuality,
		larger: spec.qualities[spec.qualities.indexOf(spec.defaultQuality) - 1],
		default: spec.defaultQuality,
	};
	const planted = files.map(({ quality, extension }) =>
		buildMediaLocation(spec, identity, tiers[quality] ?? '', extension, pathOpts),
	);
	// the first directory each plant created, if any: removed in reverse order
	const created: Array<{ leaf: string; top: string | undefined }> = [];
	try {
		for (const [index, location] of planted.entries()) {
			const leaf = dirname(location.absolutePath);
			created.push({ leaf, top: mkdirSync(leaf, { recursive: true }) });
			writeFileSync(location.absolutePath, files[index]?.bytes ?? 'planted by a gate');
		}
		return await body(planted.map((location) => location.relativePath));
	} finally {
		for (const location of planted) rmSync(location.absolutePath, { force: true });
		for (const { leaf, top } of created.reverse()) {
			for (let dir = leaf; top !== undefined; dir = dirname(dir)) {
				rmdirSync(dir);
				if (dir === top) break;
			}
		}
		expect(await slotResidue(slot), `residue in ${where} after the test`).toHaveLength(0);
	}
}
