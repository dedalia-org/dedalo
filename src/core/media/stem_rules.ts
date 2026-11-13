/**
 * THE IMAGE_ID STEM RULES (T1-10 OD-1 / OD-3, owner rulings 2026-11-13;
 * WC-2026-11-12-image-id-media-file-stem, addendum 2026-11-13).
 *
 * A `component_image` declaring `properties.image_id` names its FILES by a
 * sibling component's value on the record (ontology_path.ts
 * resolveFileIdOverride, PHP component_image::get_id). PHP wrote that value
 * verbatim and let two records share a stem — and then an upload to one
 * overwrote the other's master, a delete of one moved the other's files away,
 * and every duplicate of a stem-named record copied a file onto itself. Two
 * rules close that, both on the SIBLING's write (every door reaches the record-
 * write chokepoint, record_write.ts §3i) and the first one again at the upload
 * door (ingest/process_uploaded_file.ts), before anything is written:
 *
 *   C20 (c) UNIQUE — a stem another record of the same section stores on that
 *       sibling is refused (`media.stem_in_use`, naming the record). ONE
 *       indexed containment probe (db/matrix.ts readOtherSectionIdsHoldingValue).
 *   C22 (c) LOCKED — a NON-EMPTY sibling is not CHANGED while any managed file
 *       (file_ops.ts managedFileSlots — the delete/restore/duplicate census)
 *       exists under its current stem (`media.stem_locked`, naming the files and
 *       the remedy: delete the media first). PHP orphaned them.
 *
 * Both run INSIDE the write's transaction, the stored value read under the
 * owner's row lock (readMatrixKeyForUpdate), so the verdict judges the row the
 * UPDATE replaces and a refusal rolls everything back. The duplicate does not
 * reach them: it CLEARS the clone's sibling instead (C20 b, stripImageIdSiblings)
 * so the clone's files land under its own identifier.
 *
 * Which siblings are ruled is an ontology fact: every component_image the
 * section declares (section/record/declared_components.ts — own ∪ real subtree)
 * whose `image_id` names the key. Cached per section until the ontology changes
 * (createOntologyCache), so the hot path of every other key write pays one Map
 * lookup. Any other model's `image_id` is inert (PHP: image-only).
 *
 * Gate: test/unit/media_image_id_native.test.ts L12 (unique: save + upload),
 * L13 (locked), L8 (duplicate clears).
 */

import { existsSync } from 'node:fs';
import { config } from '../../config/config.ts';
import { mediaTypeOf } from '../concepts/media.ts';
import { type MatrixJsonbColumn, readOtherSectionIdsHoldingValue } from '../db/matrix.ts';
import { type MatrixWriteValues, readMatrixKeyForUpdate } from '../db/matrix_write.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getNode,
} from '../ontology/resolver.ts';
import {
	type DeclaredComponent,
	declaredSectionComponents,
} from '../section/record/declared_components.ts';
import { managedFileSlots } from './file_ops.ts';
import {
	flatItemsValue,
	resolveAdditionalPathOverride,
	resolveMediaPathOptions,
} from './ontology_path.ts';
import {
	buildMediaLocation,
	isMediaFileStemName,
	type MediaIdentity,
	type MediaPathOptions,
} from './path.ts';

/** A sibling component a section's component_image(s) name their files by. */
export interface ImageIdSibling {
	/** The sibling's tipo (the `image_id` value). */
	tipo: string;
	/** The matrix column the sibling stores in (its model's). */
	column: MatrixJsonbColumn;
	/** Every component_image of the section declaring `image_id: <tipo>`. */
	imageTipos: string[];
}

/** The record a rule judges (RecordWriteTarget's shape, restated to stay a leaf). */
export interface StemRuleOwner {
	table: string;
	sectionTipo: string;
	sectionId: number;
}

/** A key of a savePath that is an image_id sibling, with the value it will store. */
export interface StemRuledKey {
	sibling: ImageIdSibling;
	value: unknown;
}

/** section tipo → sibling tipo → the sibling (cleared on every ontology write). */
const SIBLINGS_BY_SECTION = createOntologyCache<string, Map<string, ImageIdSibling>>();

/**
 * Every image_id sibling a section declares, keyed by the sibling's tipo. A
 * section with no component_image declaring the property has an empty map (the
 * common case — cached too, so the lookup stays one Map read).
 */
export async function imageIdSiblingsOf(sectionTipo: string): Promise<Map<string, ImageIdSibling>> {
	const cached = SIBLINGS_BY_SECTION.get(sectionTipo);
	if (cached !== undefined) return cached;
	const siblings = new Map<string, ImageIdSibling>();
	for (const component of await declaredSectionComponents(sectionTipo)) {
		const siblingTipo = await declaredImageIdOf(component);
		if (siblingTipo !== null) await enrolSibling(siblings, siblingTipo, component.tipo);
	}
	SIBLINGS_BY_SECTION.set(sectionTipo, siblings);
	return siblings;
}

/** The `image_id` a component_image declares (a non-empty tipo), or null for any other node. */
async function declaredImageIdOf(component: DeclaredComponent): Promise<string | null> {
	if (component.model !== 'component_image') return null;
	const properties = ((await getNode(component.tipo))?.properties ?? {}) as { image_id?: unknown };
	const siblingTipo = properties.image_id;
	return typeof siblingTipo === 'string' && siblingTipo !== '' ? siblingTipo : null;
}

/**
 * Record one image → sibling declaration. A sibling the ontology does not resolve
 * (no model, no column) stores nothing a rule can read — the resolver answers the
 * identifier for it (resolveFileIdOverride) — and is not enrolled.
 */
async function enrolSibling(
	siblings: Map<string, ImageIdSibling>,
	siblingTipo: string,
	imageTipo: string,
): Promise<void> {
	const known = siblings.get(siblingTipo);
	if (known !== undefined) {
		known.imageTipos.push(imageTipo);
		return;
	}
	const model = await getModelByTipo(siblingTipo);
	const column = model === null ? null : getColumnNameByModel(model);
	if (column === null) return;
	siblings.set(siblingTipo, {
		tipo: siblingTipo,
		column: column as MatrixJsonbColumn,
		imageTipos: [imageTipo],
	});
}

/** Whether `key` is an image_id sibling on `sectionTipo` (the save door's routing question). */
export async function isImageIdSibling(sectionTipo: string, key: string): Promise<boolean> {
	return (await imageIdSiblingsOf(sectionTipo)).has(key);
}

/** The items of a savePath (or bag) that write an image_id sibling, with the value as it will be stored. */
export async function stemRuledKeys(
	sectionTipo: string,
	items: readonly { key: string; value: unknown }[],
): Promise<StemRuledKey[]> {
	if (items.length === 0) return [];
	const siblings = await imageIdSiblingsOf(sectionTipo);
	if (siblings.size === 0) return [];
	const ruled: StemRuledKey[] = [];
	for (const item of items) {
		const sibling = siblings.get(item.key);
		if (sibling !== undefined) ruled.push({ sibling, value: item.value });
	}
	return ruled;
}

/** The stem a stored (or to-be-stored) sibling value names: the resolver's flat rule, trimmed. */
function stemOf(value: unknown): string {
	return flatItemsValue(value).trim();
}

/**
 * §3i — THE STEM RULES over one write's ruled keys, inside the write's
 * transaction (the row lock is the writer's; a refusal rolls the write back):
 * C22 (a non-empty stored stem is not changed while files exist under it), then
 * C20 (the new stem is held by no other record of the section).
 */
export async function assertImageIdStemRules(
	owner: StemRuleOwner,
	ruled: readonly StemRuledKey[],
	door: string,
): Promise<void> {
	for (const { sibling, value } of ruled) {
		const after = stemOf(value);
		const stored = await readMatrixKeyForUpdate(
			owner.table,
			owner.sectionTipo,
			owner.sectionId,
			sibling.column,
			sibling.tipo,
		);
		const before = stemOf(stored);
		if (before !== '' && before !== after) {
			await assertNoFilesUnderStem(owner, sibling, before, door);
		}
		if (after !== '' && after !== before) {
			await assertStemNotHeldElsewhere(owner, sibling, after, door);
		}
	}
}

/**
 * C22 — every managed file of every image the sibling names, under the STORED
 * stem, must be gone before the stem changes. The remedy is in the sentence.
 */
async function assertNoFilesUnderStem(
	owner: StemRuleOwner,
	sibling: ImageIdSibling,
	storedStem: string,
	door: string,
): Promise<void> {
	const found = await filesUnderStem(owner, sibling, storedStem);
	if (found.length === 0) return;
	const files = found.join(', ');
	const sentence =
		`The file name '${storedStem}' cannot be changed while media files exist under it ` +
		`(${files}): delete the media first, then rename`;
	throw new DedaloError('media.stem_locked', {
		message: `${door}: ${owner.sectionTipo}/${owner.sectionId} ${sibling.tipo} → ${sentence}`,
		publicMessage: sentence,
		details: { files },
		coordinates: {
			section_tipo: owner.sectionTipo,
			section_id: owner.sectionId,
			tipo: sibling.tipo,
			stem: storedStem,
			door,
		},
	});
}

/**
 * The managed files (media-root-relative) that exist under `stem` for every
 * component_image naming the sibling, on the configured media root. The stored
 * stem is NOT put through the stem law: a value that is no file name has no
 * files (and a curator must be able to replace one); one that names another
 * record's files is that record's problem, not this rename's. The options are
 * the SECTION-scoped ones completed with the record's own bucket and the stored
 * stem itself — the record-scoped resolver would re-assert the very value being
 * replaced (SECTION_SCOPED_PATH_OPTION_CALLERS names this site).
 */
async function filesUnderStem(
	owner: StemRuleOwner,
	sibling: ImageIdSibling,
	stem: string,
): Promise<string[]> {
	const spec = mediaTypeOf('component_image');
	if (config.media.rootPath === null || !isMediaFileStemName(stem) || spec === null) return [];
	const found: string[] = [];
	for (const imageTipo of sibling.imageTipos) {
		const pathOpts = {
			...(await resolveMediaPathOptions(imageTipo, owner.sectionTipo)),
			additionalPathOverride: await resolveAdditionalPathOverride(
				imageTipo,
				owner.sectionTipo,
				owner.sectionId,
			),
			fileIdOverride: stem,
		};
		// A stem has NO lang suffix (PHP get_id): one identity per image.
		const identity: MediaIdentity = {
			componentTipo: imageTipo,
			sectionTipo: owner.sectionTipo,
			sectionId: owner.sectionId,
			lang: null,
		};
		found.push(...existingSlotFiles(spec, identity, pathOpts));
	}
	return found;
}

/** The managed slots of one identity that exist on disk, media-root-relative. */
function existingSlotFiles(
	spec: NonNullable<ReturnType<typeof mediaTypeOf>>,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): string[] {
	const existing: string[] = [];
	for (const [quality, extension] of managedFileSlots(spec)) {
		const location = buildMediaLocation(spec, identity, quality, extension, pathOpts);
		if (existsSync(location.absolutePath)) existing.push(location.relativePath);
	}
	return existing;
}

/**
 * C20 (c) — the stem is held by NO other record of the section on this sibling.
 * One indexed probe; the first holder is named (the curator fixes one record at
 * a time — the others are listed in the log coordinates).
 */
async function assertStemNotHeldElsewhere(
	owner: StemRuleOwner,
	sibling: ImageIdSibling,
	stem: string,
	door: string,
): Promise<void> {
	const holders = await readOtherSectionIdsHoldingValue(
		owner.table,
		owner.sectionTipo,
		sibling.column,
		sibling.tipo,
		stem,
		owner.sectionId,
	);
	const holder = holders[0];
	if (holder === undefined) return;
	const sentence =
		`The file name '${stem}' is already used by record ${owner.sectionTipo}/${holder} ` +
		'of this section: choose another one';
	throw new DedaloError('media.stem_in_use', {
		message: `${door}: ${owner.sectionTipo}/${owner.sectionId} ${sibling.tipo} → ${sentence}`,
		publicMessage: sentence,
		details: { section_id: holder },
		coordinates: {
			section_tipo: owner.sectionTipo,
			section_id: owner.sectionId,
			tipo: sibling.tipo,
			stem,
			holders: holders.join(','),
			door,
		},
	});
}

/**
 * THE UPLOAD DOOR's half of C20 (c): the stem the ingest is about to write under
 * (the record-scoped `fileIdOverride`) is held by no other record of the
 * section. Asserted BEFORE the staged file is moved, so a refused upload leaves
 * the staging dir and the media tree as they were. A PHP-era pair that already
 * shares a stem is refused HERE — the save rule never saw it stored.
 */
export async function assertUploadStemFree(identity: MediaIdentity, stem: string): Promise<void> {
	const siblings = await imageIdSiblingsOf(identity.sectionTipo);
	const sibling = [...siblings.values()].find((entry) =>
		entry.imageTipos.includes(identity.componentTipo),
	);
	// No declared sibling: the stem cannot have come from a record value.
	if (sibling === undefined) return;
	const table = await getMatrixTableFromTipo(identity.sectionTipo);
	if (table === null) return;
	await assertStemNotHeldElsewhere(
		{ table, sectionTipo: identity.sectionTipo, sectionId: identity.sectionId },
		sibling,
		stem,
		'processUploadedFile',
	);
}

/** What the duplicate cleared on its clone (C20 b): one entry per stripped sibling. */
export interface ClearedStem {
	/** The sibling tipo whose value the clone does NOT carry. */
	siblingTipo: string;
	/** The source's stem (trimmed flat value) — what the clone's files are NOT named by. */
	stem: string;
	/** The component_image(s) whose files the clone names by its identifier instead. */
	imageTipos: string[];
}

/**
 * C20 (b) — the DUPLICATE strips the clone's image_id sibling(s) from the copied
 * columns, in place, so `duplicateMediaFiles` lands the clone's files under its
 * own identifier (never onto the source's). Returns what was cleared (the
 * duplicate reports it); an empty sibling is not reported. A sibling whose
 * column the copy did not carry is nothing to clear.
 */
export async function stripImageIdSiblings(
	sectionTipo: string,
	values: MatrixWriteValues,
): Promise<ClearedStem[]> {
	const cleared: ClearedStem[] = [];
	for (const sibling of (await imageIdSiblingsOf(sectionTipo)).values()) {
		const bag = keyedBagOf(values[sibling.column]);
		if (bag === null || !(sibling.tipo in bag)) continue;
		const stem = stemOf(bag[sibling.tipo]);
		const { [sibling.tipo]: _dropped, ...kept } = bag;
		if (Object.keys(kept).length === 0) delete values[sibling.column];
		else values[sibling.column] = kept;
		if (stem !== '') {
			cleared.push({ siblingTipo: sibling.tipo, stem, imageTipos: [...sibling.imageTipos] });
		}
	}
	return cleared;
}

/** A copied column as a keyed bag (tipo → items), or null when it is none (absent, null, pre-encoded text). */
function keyedBagOf(column: unknown): Record<string, unknown> | null {
	if (column === null || column === undefined) return null;
	if (typeof column !== 'object' || Array.isArray(column)) return null;
	return column as Record<string, unknown>;
}
