/**
 * THE THESAURUS MANIFEST FORMAT — `install/import/hierarchy/hierarchy.json`,
 * the one file that says which thesauri a release (or a master's export)
 * offers, what each one IS, and which data files carry its terms
 * (WC-2026-10-10-hierarchy-json-manifest).
 *
 * It replaces the three hand-written vendored metadata files (named in the WC
 * entry above): the content is now
 * EXPORTED from the hierarchy1 registry of a master (hierarchy_census.ts
 * buildHierarchyManifest), shaped like the ontology side's ontology.json:
 *
 *   {
 *     version, date, entity_id, entity, entity_label, host,  // data_io.ts manifestEnvelope
 *     typologies: [{ typology_id, name, name_data }],        // the hierarchy13 records
 *     active_hierarchies: [{
 *       tld,                          // hierarchy6, lowercased
 *       name, name_data,              // hierarchy5 (app-lang pick + every item)
 *       typology_id, typology_name,   // hierarchy9 → hierarchy13/<id>
 *       lang: { section_id, label },  // hierarchy8 → lg1/<section_id> (int); label for humans only
 *       real_section_tipo,            // hierarchy109; null = the row names none (provisioning default applies)
 *       active_in_thesaurus,          // hierarchy125 → boolean
 *       scope_note_data,              // hierarchy61 items; [] when the row holds none (never absent)
 *       dependencies?,                // hierarchy60 via THE shared normalizer; ABSENT = not declared
 *       data_files: [{ file, sha256 }] // <tld>1.copy.gz / <tld>2.copy.gz; [] = empty thesaurus by design
 *     }]
 *   }
 *
 * THIS MODULE IS A PURE LEAF: the types, the strict reader and the digest
 * helper. The export (DB census, hierarchy_census.ts) and the installer
 * (src/core/install/) both import it, so a manifest the export writes is by
 * construction one the installer accepts — the census runs its own output
 * through {@link parseHierarchyManifest} before it is returned. It imports only
 * zod, the error leaf and the dependency normalizer (itself a leaf): never
 * config, never the DB, never the filesystem.
 *
 * THE READER IS STRICT AND LOUD. A wrong type, a missing required field, a
 * duplicate tld or typology, an entry naming an unlisted typology, a data file
 * that is not `<own tld>1|2.copy.gz`, a non-hex digest, a non-int
 * `lang.section_id` or a dependency the normalizer would drop → the WHOLE file
 * is refused with `install.manifest_invalid` naming the JSON path and the rule.
 * Nothing is ever silently skipped: a release whose manifest lies must not
 * install half a thesaurus. Unknown keys are ignored (a newer exporter may add
 * fields; every field this engine reads is typed).
 *
 * THE WRITER CHECKS RECORD BY RECORD. The census builds an entry per registry
 * row and must not lose every thesaurus to one malformed operator value, so
 * the SAME rules are exposed per record (validateHierarchyEntry /
 * validateHierarchyTypology): a record that breaks one is that record's error
 * line, and the whole-file parse stays a census-bug backstop.
 *
 * What the format does NOT decide (the installer's rules, applied by its
 * consumers): CORE hierarchies (`lg`, hierarchy_meta.ts CORE_HIERARCHIES) are
 * listed as metadata with `data_files: []` and never imported; the bytes of a
 * data file are verified against `sha256` BEFORE anything is written.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DedaloError } from '../errors/dedalo_error.ts';
import { normalizeOntologyDependencies, type OntologyDependency } from './ontology_dependencies.ts';

/** The manifest's file name inside the vendored hierarchy dir (HIERARCHY_IMPORT_DIR). */
export const HIERARCHY_MANIFEST_FILE = 'hierarchy.json';

/** A thesaurus TLD: 2+ lowercase ascii letters (the safe_tld grammar). */
const TLD_RE = /^[a-z]{2,}$/;
/** A section tipo `<tld><n>` (concepts/ontology.ts TIPO_PATTERN). */
const TIPO_RE = /^[a-z]+[0-9]+$/;
/** A data lang (`lg-spa`, `lg-nolan`). */
const LANG_RE = /^lg-[a-z]+$/;
/** A lowercase hex SHA-256 digest. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/** One multilingual component item as stored (`{id?, lang, value}`); extra keys kept. */
const langItemSchema = z.looseObject({
	lang: z.string().regex(LANG_RE, 'expected a data lang like lg-spa'),
	value: z.unknown(),
});

const typologySchema = z.object({
	typology_id: z.number().int().positive(),
	name: z.string().nullable(),
	name_data: z.array(langItemSchema),
});

const dataFileSchema = z.object({
	file: z.string(),
	sha256: z.string().regex(SHA256_RE, 'expected a lowercase hex sha256'),
});

const entrySchema = z.object({
	tld: z.string().regex(TLD_RE, 'expected a lowercase TLD'),
	name: z.string().nullable(),
	name_data: z.array(langItemSchema),
	typology_id: z.number().int().positive(),
	typology_name: z.string().nullable(),
	lang: z.object({
		section_id: z.number().int().positive(),
		label: z.string().nullable(),
	}),
	real_section_tipo: z.string().regex(TIPO_RE, 'expected a section tipo').nullable(),
	active_in_thesaurus: z.boolean(),
	scope_note_data: z.array(langItemSchema),
	// Checked by THE shared normalizer (below), strictly: any dropped item refuses.
	dependencies: z.array(z.unknown()).optional(),
	data_files: z.array(dataFileSchema),
});

const manifestSchema = z.object({
	version: z.string(),
	date: z.string(),
	entity_id: z.number().nullable(),
	entity: z.string().nullable(),
	entity_label: z.string().nullable(),
	host: z.string().nullable(),
	typologies: z.array(typologySchema),
	active_hierarchies: z.array(entrySchema),
});

/** One multilingual item (`name_data`, `scope_note_data`). */
export type HierarchyLangItem = z.infer<typeof langItemSchema>;
/** One `typologies` item. */
export type HierarchyTypology = z.infer<typeof typologySchema>;
/** One `data_files` item. */
export type HierarchyDataFile = z.infer<typeof dataFileSchema>;

/** One `active_hierarchies` item (see the module header). */
export interface HierarchyManifestEntry extends Omit<z.infer<typeof entrySchema>, 'dependencies'> {
	/** Present only when the registry row DECLARES them; absent = not declared. */
	dependencies?: OntologyDependency[];
}

/** The whole manifest. */
export interface HierarchyManifest
	extends Omit<z.infer<typeof manifestSchema>, 'active_hierarchies'> {
	active_hierarchies: HierarchyManifestEntry[];
}

/** The refusal every rule of this reader throws. */
function refuse(path: string, why: string): never {
	const sentence = `${HIERARCHY_MANIFEST_FILE}: ${path}: ${why}`;
	throw new DedaloError('install.manifest_invalid', {
		message: sentence,
		publicMessage: sentence,
		coordinates: { file: HIERARCHY_MANIFEST_FILE, path },
	});
}

/** The first schema issue as `path: message` (never the payload itself); `prefix` roots the path. */
function refuseShape(error: z.ZodError, prefix = ''): never {
	const issue = error.issues[0];
	const path = [prefix, ...(issue?.path ?? []).map(String)].filter((part) => part !== '').join('.');
	return refuse(path || '(root)', issue?.message ?? 'invalid');
}

/** The data-file names an entry may carry: its own `<tld>1` / `<tld>2` dumps. */
export function hierarchyDataFileNames(tld: string): readonly [string, string] {
	return [`${tld}1.copy.gz`, `${tld}2.copy.gz`];
}

/** Each data file is one of the entry's own two dumps, listed once. */
function checkDataFiles(entry: z.infer<typeof entrySchema>, at: string): void {
	const allowed = hierarchyDataFileNames(entry.tld);
	const seen = new Set<string>();
	for (const [index, item] of entry.data_files.entries()) {
		if (!allowed.includes(item.file)) {
			refuse(`${at}.data_files.${index}.file`, `expected ${allowed.join(' or ')}`);
		}
		if (seen.has(item.file)) refuse(`${at}.data_files.${index}.file`, 'listed twice');
		seen.add(item.file);
	}
}

/** The declared list through THE shared normalizer — any warning refuses (strict). */
function strictDependencies(
	entry: z.infer<typeof entrySchema>,
	at: string,
): OntologyDependency[] | undefined {
	if (entry.dependencies === undefined) return undefined;
	const warnings: string[] = [];
	const normalized = normalizeOntologyDependencies(entry.tld, entry.dependencies, warnings);
	if (warnings.length > 0) refuse(`${at}.dependencies`, warnings[0] as string);
	return normalized ?? [];
}

/** One entry's cross-field rules (`at` = its JSON path); returns it with its normalized dependencies. */
function checkEntry(
	entry: z.infer<typeof entrySchema>,
	at: string,
	typologyIds: ReadonlySet<number>,
): HierarchyManifestEntry {
	if (!typologyIds.has(entry.typology_id)) {
		refuse(`${at}.typology_id`, `typology ${entry.typology_id} is not listed in typologies`);
	}
	checkDataFiles(entry, at);
	const { dependencies: _raw, ...rest } = entry;
	const dependencies = strictDependencies(entry, at);
	return dependencies === undefined ? rest : { ...rest, dependencies };
}

/** The values of `key` must be unique across `items`. */
function checkUnique<T>(items: readonly T[], key: (item: T) => unknown, at: string): void {
	const seen = new Set<unknown>();
	for (const [index, item] of items.entries()) {
		if (seen.has(key(item))) refuse(`${at}.${index}`, 'duplicate');
		seen.add(key(item));
	}
}

/**
 * THE reader: validate a parsed `hierarchy.json` value and return it typed,
 * dependencies normalized. Throws `install.manifest_invalid` on the first
 * broken rule (see the module header) — never returns a partial manifest.
 */
export function parseHierarchyManifest(raw: unknown): HierarchyManifest {
	const parsed = manifestSchema.safeParse(raw);
	if (!parsed.success) refuseShape(parsed.error);
	const manifest = parsed.data;
	checkUnique(manifest.typologies, (item) => item.typology_id, 'typologies');
	checkUnique(manifest.active_hierarchies, (item) => item.tld, 'active_hierarchies');
	const typologyIds = new Set(manifest.typologies.map((item) => item.typology_id));
	return {
		...manifest,
		active_hierarchies: manifest.active_hierarchies.map((entry, index) =>
			checkEntry(entry, `active_hierarchies.${index}`, typologyIds),
		),
	};
}

/** The rule a refusal names, without the file prefix (`<path>: <why>`). */
function refusalRule(error: unknown): string {
	if (!(error instanceof DedaloError) || error.code !== 'install.manifest_invalid') throw error;
	return error.message.slice(`${HIERARCHY_MANIFEST_FILE}: `.length);
}

/**
 * ONE entry against the reader's rules, for a WRITER that must skip a bad
 * record instead of refusing the whole file (the census: one malformed
 * registry row is that row's error line, never a failed export). The SAME
 * schema and cross-field rules {@link parseHierarchyManifest} applies, so an
 * entry this admits is one the reader admits (tld uniqueness aside — a
 * whole-file rule the caller keeps). Answers the normalized entry, or the
 * broken rule as `entry.<path>: <why>`.
 */
export function validateHierarchyEntry(
	raw: unknown,
	typologyIds: ReadonlySet<number>,
): { entry: HierarchyManifestEntry } | { problem: string } {
	const parsed = entrySchema.safeParse(raw);
	try {
		if (!parsed.success) refuseShape(parsed.error, 'entry');
		return { entry: checkEntry(parsed.data, 'entry', typologyIds) };
	} catch (error) {
		return { problem: refusalRule(error) };
	}
}

/** ONE `typologies` item against the reader's schema (see {@link validateHierarchyEntry}). */
export function validateHierarchyTypology(
	raw: unknown,
): { typology: HierarchyTypology } | { problem: string } {
	const parsed = typologySchema.safeParse(raw);
	try {
		if (!parsed.success) refuseShape(parsed.error, 'typology');
		return { typology: parsed.data };
	} catch (error) {
		return { problem: refusalRule(error) };
	}
}

/** {@link parseHierarchyManifest} over the file's TEXT (a JSON syntax error refuses too). */
export function parseHierarchyManifestText(text: string): HierarchyManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		refuse('(root)', `not valid JSON (${(error as Error).message})`);
	}
	return parseHierarchyManifest(raw);
}

/**
 * The manifest as the file's bytes: pretty JSON, 4-space indent (the
 * ontology.json convention, data_io.ts exportOntologyInfo), trailing newline.
 */
export function serializeHierarchyManifest(manifest: HierarchyManifest): string {
	return `${JSON.stringify(manifest, null, 4)}\n`;
}

/** Lowercase hex SHA-256 of a data file's bytes — the `data_files[].sha256` digest. */
export function sha256Hex(bytes: Uint8Array | ArrayBuffer): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return createHash('sha256').update(view).digest('hex');
}
