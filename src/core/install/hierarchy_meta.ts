/**
 * The vendored THESAURUS MANIFEST, as the installer reads it —
 * `install/import/hierarchy/hierarchy.json` (format + strict reader:
 * ontology/hierarchy_manifest_format.ts; WC-2026-10-10-hierarchy-json-manifest).
 * ONE reader, shared by every consumer that must agree: the wizard's checkbox
 * list (install/context.ts), the add_hierarchy maintenance widget, the plan's
 * thesaurus choice and dependency rule (install_plan.ts, ontology_choice.ts),
 * and the import + activation that run on the tlds they return
 * (hierarchy_import.ts, hierarchy_activate.ts). A second copy of this lookup
 * would let the wizard offer a hierarchy the activator cannot describe.
 *
 * It replaced (2026-10-10) the three hand-written vendored metadata files
 * (named in WC-2026-10-10-hierarchy-json-manifest): the manifest is
 * EXPORTED from a master's hierarchy1 registry (maintenance → Export hierarchy
 * → "Export hierarchy.json") and carries everything a new registry row needs.
 *
 * TWO KINDS OF HIERARCHY (2026-10-08, installer unification A7):
 *  - CORE (`CORE_HIERARCHIES`): ALWAYS activated by the seed restore, never
 *    imported, never offered as a choice. Today only `lg`: its 21,705 `lg1`
 *    terms ship IN THE SEED, in `matrix_langs` — the table the engine reads
 *    (getMatrixTableFromTipo('lg1') = 'matrix_langs') — and the seed ships its
 *    registry row (the ONLY registry row the seed carries). The manifest lists
 *    it as metadata with `data_files: []`; the descriptor that activates it
 *    lives HERE, so a manifest can never make it importable.
 *  - OPTIONAL (every non-core manifest entry, WITH OR WITHOUT data files): the
 *    thesauri an operator chooses. An entry without data files installs as an
 *    EMPTY thesaurus (registry row + provisioned sections, no terms).
 *
 * NO DEFAULT SELECTION (owner decision 2026-10-10). The old per-descriptor
 * default flag is gone: what an install front end pre-selects
 * comes ONLY from the declared dependencies (hierarchy60 — every declared
 * thesaurus pre-ticked; a mandatory one is STRONGLY RECOMMENDED but declinable,
 * owner decision 2026-10-10). No country's toponymy is ever pre-selected; the front
 * ends show a SUGGESTION to import the operator's own country's toponymy
 * ({@link TOPONYMY_TYPOLOGY_ID}).
 *
 * STRICT. A missing or invalid manifest is refused (`install.manifest_invalid`,
 * naming the file and the rule) — never read as "nothing to offer": a release
 * whose manifest is broken must not install silently without its thesauri.
 * Sync IO by design: install-time and a maintenance panel read of one small
 * repo-owned file (sync_io_on_request_path_tripwire names this file).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DedaloError } from '../errors/dedalo_error.ts';
import {
	HIERARCHY_MANIFEST_FILE,
	type HierarchyManifest,
	type HierarchyManifestEntry,
	parseHierarchyManifestText,
} from '../ontology/hierarchy_manifest_format.ts';
import { pickLangValue } from '../ontology/manifest_lang_pick.ts';
import { HIERARCHY_IMPORT_DIR } from './paths.ts';

/** What the installer knows about one OPTIONAL thesaurus: its manifest entry. */
export type HierarchyMeta = HierarchyManifestEntry;

/** A CORE hierarchy: activated by the seed restore against its seed-shipped registry row. */
export interface CoreHierarchy {
	readonly tld: string;
	readonly label: string;
	readonly active_in_thesaurus: boolean;
}

/** The hierarchies every install activates, whatever the operator picks (see header). */
export const CORE_HIERARCHIES: readonly CoreHierarchy[] = Object.freeze([
	Object.freeze({ tld: 'lg', label: 'Languages', active_in_thesaurus: true }),
]);

/**
 * hierarchy13/2 — the Toponymy typology. Never pre-selected: the install front
 * ends only SUGGEST importing the operator's own country (see header).
 */
export const TOPONYMY_TYPOLOGY_ID = 2;

/** Is `tld` a CORE hierarchy (always activated, never imported)? Case/space-insensitive. */
export function isCoreHierarchyTld(tld: string): boolean {
	const wanted = tld.trim().toLowerCase();
	return CORE_HIERARCHIES.some((meta) => meta.tld === wanted);
}

/**
 * THE reader: the vendored manifest of `dir` (default the release's
 * HIERARCHY_IMPORT_DIR), validated. Throws `install.manifest_invalid` when the
 * file is missing or breaks a format rule — never a partial or empty fallback.
 */
export function readHierarchyManifest(dir: string = HIERARCHY_IMPORT_DIR): HierarchyManifest {
	const path = join(dir, HIERARCHY_MANIFEST_FILE);
	if (!existsSync(path)) {
		const sentence = `${HIERARCHY_MANIFEST_FILE}: missing from the vendored hierarchy directory — the release ships it; nothing can be offered or installed without it`;
		throw new DedaloError('install.manifest_invalid', {
			message: `${sentence} (${path})`,
			publicMessage: sentence,
			coordinates: { file: HIERARCHY_MANIFEST_FILE, path: '(file)' },
		});
	}
	return parseHierarchyManifestText(readFileSync(path, 'utf8'));
}

/** The thesauri an install may choose: every NON-CORE manifest entry, with or without data. */
export function offeredHierarchies(dir?: string): HierarchyMeta[] {
	return readHierarchyManifest(dir).active_hierarchies.filter(
		(entry) => !isCoreHierarchyTld(entry.tld),
	);
}

/** The TLDs of {@link offeredHierarchies}. */
export function offeredHierarchyTlds(dir?: string): ReadonlySet<string> {
	return new Set(offeredHierarchies(dir).map((entry) => entry.tld));
}

/**
 * The manifest entry of ONE tld (case/space-insensitive) — core entries
 * included, as metadata — or null when the manifest does not list it.
 */
export function hierarchyMetaByTld(tld: string, dir?: string): HierarchyMeta | null {
	const wanted = tld.trim().toLowerCase();
	return (
		readHierarchyManifest(dir).active_hierarchies.find((entry) => entry.tld === wanted) ?? null
	);
}

/** One row of the client's thesaurus checkbox list (wizard + add_hierarchy widget). */
export interface HierarchyChoiceView {
	tld: string;
	/** The name in the READER's language (picked from `name_data`), or the tld when it has none. */
	label: string;
	typology: number;
	/** false = an EMPTY thesaurus by design (no data files): installs with no terms. */
	has_data: boolean;
	/**
	 * The THESAURI this entry declares (its hierarchy60 `main: 'hierarchy1'`
	 * items, core excluded): ticking it pre-ticks them in the client, a
	 * mandatory one marked strongly recommended — never locked (2026-10-10).
	 */
	dependencies: { tld: string; mandatory: boolean }[];
}

/** One typology group of the client's list. */
export interface HierarchyTypologyView {
	typology: number;
	label: string;
}

/**
 * A display label in `lang`: picked from every item (`nameData` — THE manifest
 * pick rule, manifest_lang_pick.ts), else the export-time `name`, else
 * `fallback`. The `name` was picked in the EXPORTING installation's
 * application language; a reader in another language must not inherit it.
 */
function labelIn(
	nameData: readonly { lang?: string; value?: unknown }[],
	name: string | null,
	lang: string,
	fallback: string,
): string {
	const picked = pickLangValue(nameData, lang);
	return picked !== '' ? picked : (name ?? fallback);
}

/**
 * THE client view of the offer — the `{tld, label, typology}` /
 * `{typology, label}` shape render_hierarchies_import_block groups by (shared
 * by the wizard context and the add_hierarchy widget), derived from the
 * manifest in this ONE place. Labels are picked in `lang` — the requesting
 * user's application language (the caller passes currentApplicationLang()).
 */
export function hierarchyChoiceView(
	lang: string,
	dir?: string,
): {
	hierarchies: HierarchyChoiceView[];
	hierarchy_typologies: HierarchyTypologyView[];
} {
	const manifest = readHierarchyManifest(dir);
	return {
		hierarchies: manifest.active_hierarchies
			.filter((entry) => !isCoreHierarchyTld(entry.tld))
			.map((entry) => ({
				tld: entry.tld,
				label: labelIn(entry.name_data, entry.name, lang, entry.tld),
				typology: entry.typology_id,
				has_data: entry.data_files.length > 0,
				dependencies: (entry.dependencies ?? [])
					.filter((item) => item.main === 'hierarchy1' && !isCoreHierarchyTld(item.tld))
					.map((item) => ({ tld: item.tld, mandatory: item.mandatory })),
			})),
		hierarchy_typologies: manifest.typologies.map((item) => ({
			typology: item.typology_id,
			label: labelIn(item.name_data, item.name, lang, String(item.typology_id)),
		})),
	};
}
