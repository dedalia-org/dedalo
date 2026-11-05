/**
 * PUBLISHED FILES — the ONE producer of where a file-format publication lands
 * (audit 2026-08-26 PUB-03 / P1-12).
 *
 * THE DEFECT THIS CLOSES. Publish (src/diffusion/writers/files.ts) resolved the
 * root as `DEDALO_DIFFUSION_FILES_ROOT → MEDIA_PATH`; delete
 * (diffusion_delete.ts) read `MEDIA_PATH` alone — and NEITHER read
 * `config.media.rootPath`, which is where the media root actually comes from on
 * an ordinary install (MEDIA_PATH is a DERIVED default, normally unset). So on
 * the shipped configuration the delete side resolved NO root, every file
 * element went 'pending' forever; with the override set it resolved the WRONG
 * root, found nothing, and reported the unpublish as done while the document
 * stayed public. The rdf file name diverged a second way: publish took the
 * owl:Class label as the first NON-EMPTY term value, delete took the FIRST.
 *
 * WHAT THIS IS. Pure path grammar + the root resolution, in core so BOTH sides
 * import it (diffusion → core is the legal direction, DIFFUSION_SPEC §2.5).
 * `src/diffusion/writers/files.ts` re-exports the root resolver; the rdf writer
 * imports the sanitizer; the delete side imports everything. The lockstep is
 * then an IMPORT, not a prose promise pinned by a test that compares two copies
 * — and `diffusion_scope_tripwire` proves it behaviourally: for every file
 * writer the registry serves, a file planted at THIS module's path is the file
 * the writer's own removeRecords unlinks.
 *
 * Root precedence: `DEDALO_DIFFUSION_FILES_ROOT` (operator override) →
 * `config.media.rootPath` (which already honours DEDALO_TEST_MEDIA_ROOT and the
 * derived default). Neither → MissingDiffusionFilesRootError on BOTH sides: the
 * writer refuses at open(), the delete ledgers 'pending' (never 'unpublished').
 *
 * This module RESOLVES a root that gets written under, so it asks the
 * test-media guard (core/media/test_media_root.ts) like every other resolver.
 */

import { config } from '../../config/config.ts';
import { readEnv } from '../../config/env.ts';
import { DedaloError } from '../errors/index.ts';
import { assertTestMediaRoot } from '../media/test_media_root.ts';

/**
 * Thrown when no file root is configured (loud config gate). A thin
 * DedaloError family with a fixed code; the sentence stays log-only.
 */
export class MissingDiffusionFilesRootError extends DedaloError {
	constructor() {
		super('diffusion.files_root_missing', {
			message:
				'No diffusion files root configured: set MEDIA_PATH (PHP DEDALO_MEDIA_PATH) ' +
				'or the DEDALO_DIFFUSION_FILES_ROOT override.',
		});
		this.name = 'MissingDiffusionFilesRootError';
	}
}

/**
 * The published-files root — publish and delete call THIS and nothing else.
 * `DEDALO_DIFFUSION_FILES_ROOT` overrides (ops: a volume the public web server
 * exposes); otherwise the media root the rest of the engine resolves.
 */
export function diffusionFilesRoot(): string {
	const override = readEnv('DEDALO_DIFFUSION_FILES_ROOT');
	if (override !== undefined && override !== '') {
		return assertTestMediaRoot(override, 'diffusionFilesRoot');
	}
	const mediaRoot = config.media.rootPath;
	if (mediaRoot !== null && mediaRoot !== '') {
		return assertTestMediaRoot(mediaRoot, 'diffusionFilesRoot');
	}
	throw new MissingDiffusionFilesRootError();
}

/**
 * The formats that land ONE FILE PER RECORD — the only ones a per-record
 * unpublish can act on. csv/json are FULL-EXPORT formats (one file per table):
 * a record leaves them only when the element is re-published, so a delete-side
 * debt against them is TERMINAL — reported, never retried (PUB-02).
 */
export const PER_RECORD_FILE_FORMATS: ReadonlySet<string> = new Set(['rdf', 'xml', 'markdown']);

/** The file extension of a per-record format (PHP get_record_file_path). */
export function perRecordFileExtension(type: string): string | null {
	switch (type) {
		case 'rdf':
			return 'rdf';
		case 'xml':
			return 'xml';
		case 'markdown':
			return 'md';
		default:
			return null;
	}
}

/** PHP sanitize_file_name + beautify (delete-side subset: dash-safe names). */
export function sanitizePublishedFileName(name: string): string {
	let out = name.replace(/[^\w\s\d\-_~,;[\]().]/gu, '');
	out = out.replace(/\.{2,}/g, '');
	out = out.toLowerCase().replace(/[^a-z0-9.]+/g, '-');
	out = out.replace(/[\s_]+/g, '-').replace(/-+/g, '-');
	out = out.replace(/-*\.-*/g, '.').replace(/\.{2,}/g, '.');
	return out.replace(/^[-.]+|[-.]+$/g, '');
}

/**
 * Per-record file NAME of a per-record format. rdf names carry the owl:Class
 * label (PHP class.diffusion_rdf.php:324-328); xml/markdown are
 * `<st>_<id>.<ext>` (PHP class.diffusion_xml.php:565 / markdown
 * get_record_file_path). Null for a full-export format, or an rdf without its
 * class label.
 */
export function publishedRecordFileName(
	type: string,
	sectionTipo: string,
	sectionId: number | string,
	rdfName?: string | null,
): string | null {
	const extension = perRecordFileExtension(type);
	if (extension === null) return null;
	if (type === 'rdf') {
		if (rdfName === undefined || rdfName === null || rdfName === '') return null;
		return `${sanitizePublishedFileName(`${rdfName}_${sectionTipo}_${sectionId}`)}.${extension}`;
	}
	return `${sectionTipo}_${sectionId}.${extension}`;
}

/** `<root>/<type>/<dirLabel>` — the directory one file target publishes into. */
export function publishedTargetDir(root: string, type: string, dirLabel: string): string {
	return `${root}/${type}/${dirLabel}`;
}

/**
 * The full per-record path — `<root>/<type>/<dirLabel>/<name>` — or null when
 * the format has no per-record file. `dirLabel` is the element's service_name
 * for a 'files' target (the only kind the compiler admits for these formats).
 */
export function publishedRecordFilePath(spec: {
	root: string;
	type: string;
	dirLabel: string;
	sectionTipo: string;
	sectionId: number | string;
	rdfName?: string | null;
}): string | null {
	const name = publishedRecordFileName(spec.type, spec.sectionTipo, spec.sectionId, spec.rdfName);
	if (name === null) return null;
	return `${publishedTargetDir(spec.root, spec.type, spec.dirLabel)}/${name}`;
}

/**
 * The inverse of publishedRecordFileName for the reconcile: which record a
 * file in a per-record target directory belongs to. rdf names end in
 * `-<st>-<id>` after sanitization (tipos are lowercase alphanumerics, so the
 * sanitizer leaves them intact); xml/md are `<st>_<id>`. Null for anything else
 * (merged documents, zips, temp files).
 */
export function parsePublishedRecordFileName(
	type: string,
	name: string,
): { sectionTipo: string; sectionId: number } | null {
	const extension = perRecordFileExtension(type);
	if (extension === null || !name.endsWith(`.${extension}`)) return null;
	const stem = name.slice(0, -(extension.length + 1));
	const match =
		type === 'rdf' ? /-([a-z0-9]+)-([0-9]+)$/.exec(stem) : /^([a-z0-9]+)_([0-9]+)$/.exec(stem);
	if (match === null) return null;
	const sectionId = Number(match[2]);
	if (!Number.isSafeInteger(sectionId)) return null;
	return { sectionTipo: match[1] as string, sectionId };
}
