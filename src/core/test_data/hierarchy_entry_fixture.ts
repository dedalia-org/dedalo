/**
 * A thesaurus MANIFEST ENTRY built by a gate or a suite fixture — the
 * `active_hierarchies` item of hierarchy.json
 * (ontology/hierarchy_manifest_format.ts) that the installer's activation
 * (install/hierarchy_activate.ts activateHierarchy) creates a registry row from.
 *
 * WHY A BUILDER. Since 2026-10-10 a new registry row is described ENTIRELY by
 * the entry (name items, typology, hierarchy8 lang, hierarchy109, scope note,
 * declared dependencies), so every caller that activates a scratch thesaurus
 * needs a complete, VALID entry — and one place that knows the shape keeps the
 * fixtures from drifting from the format. The result is run through THE strict
 * reader (parseHierarchyManifest), so a builder that falls behind the format
 * fails here, loudly, not in an activation.
 *
 * The language is RESOLVED, never a hard-coded lg1 id: the caller passes the
 * id it resolved from the installation (ontology_write.ts resolveRegistryLangId)
 * — a guessed id would file the row under whatever language owns it.
 *
 * PURE: no DB, no config. Writes nothing.
 */

import {
	type HierarchyDataFile,
	type HierarchyLangItem,
	type HierarchyManifestEntry,
	parseHierarchyManifest,
} from '../ontology/hierarchy_manifest_format.ts';
import type { OntologyDependency } from '../ontology/ontology_dependencies.ts';

export interface ScratchHierarchyEntryOptions {
	tld: string;
	/** The lg-eng name (also the `name` pick). */
	name: string;
	/** The lg1 record id of the row's language — resolved by the caller from the installation. */
	langSectionId: number;
	/** hierarchy13 id; default 2 (Toponymy — the typology the General Term roots are gated on). */
	typologyId?: number;
	/** hierarchy109; default `hierarchy20`; null = the row names none (provisioning default). */
	realSectionTipo?: string | null;
	activeInThesaurus?: boolean;
	/** Every name item; default one lg-eng item of `name`. */
	nameData?: HierarchyLangItem[];
	/** One lg-eng scope-note item (shorthand of `scopeNoteData`). */
	scopeNote?: string;
	/** Every scope-note item; wins over `scopeNote`. */
	scopeNoteData?: HierarchyLangItem[];
	/** Absent = not declared. */
	dependencies?: OntologyDependency[];
	dataFiles?: HierarchyDataFile[];
}

/** One lg-eng item of a multilingual component. */
function engItem(value: string): HierarchyLangItem {
	return { id: 1, lang: 'lg-eng', value };
}

/** The entry fields an option may default (each default in ONE place). */
function entryDefaults(options: ScratchHierarchyEntryOptions) {
	return {
		typologyId: options.typologyId ?? 2,
		realSectionTipo:
			options.realSectionTipo === undefined ? 'hierarchy20' : options.realSectionTipo,
		nameData: options.nameData ?? [engItem(options.name)],
		scopeNote:
			options.scopeNoteData ??
			(options.scopeNote === undefined ? [] : [engItem(options.scopeNote)]),
	};
}

/** A complete, reader-valid manifest entry (see the header). */
export function scratchHierarchyEntry(
	options: ScratchHierarchyEntryOptions,
): HierarchyManifestEntry {
	const defaults = entryDefaults(options);
	const entry: HierarchyManifestEntry = {
		tld: options.tld,
		name: options.name,
		name_data: defaults.nameData,
		typology_id: defaults.typologyId,
		typology_name: null,
		lang: { section_id: options.langSectionId, label: null },
		real_section_tipo: defaults.realSectionTipo,
		active_in_thesaurus: options.activeInThesaurus ?? true,
		scope_note_data: defaults.scopeNote,
		data_files: options.dataFiles ?? [],
		...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
	};
	// THE reader validates it (throws install.manifest_invalid on a broken entry).
	const parsed = parseHierarchyManifest({
		version: 'scratch',
		date: 'scratch',
		entity_id: null,
		entity: null,
		entity_label: null,
		host: null,
		typologies: [{ typology_id: defaults.typologyId, name: null, name_data: [] }],
		active_hierarchies: [entry],
	});
	return parsed.active_hierarchies[0] as HierarchyManifestEntry;
}
