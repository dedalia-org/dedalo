/**
 * add_hierarchy widget — import additional thesaurus/hierarchy packages into a
 * RUNNING install, the same operation the install wizard's hierarchy step
 * performs (render_hierarchies_import_block, shared with the installer client).
 *
 * Post-cutover (2026-07-11) the TS engine is the single engine and OWNS the
 * install tree (install/import/hierarchy). So the widget serves the real
 * offered list (get_value) and executes the import natively (apiActions.
 * install_hierarchies) — the same code paths install/context.ts and
 * install/engine.ts drive during the wizard. The wizard's own EXECUTE route
 * (dd_utils_api:install) is install-window-gated and 404s once sealed, so a
 * configured server MUST reach the importer through this widget action.
 *
 * get_value shape: {hierarchies, installed_hierarchies (each {tld}),
 * hierarchy_files_dir_path, hierarchy_typologies}. `hierarchies` /
 * `hierarchy_typologies` are THE client view of the vendored thesaurus manifest
 * (hierarchy.json — install/hierarchy_meta.ts hierarchyChoiceView, the same the
 * wizard renders): `{tld, label, typology, has_data}` / `{typology, label}`.
 */

import { sql } from '../../db/postgres.ts';
import { hierarchyChoiceView } from '../../install/hierarchy_meta.ts';
import { HIERARCHY_IMPORT_DIR } from '../../install/paths.ts';
import { currentApplicationLang } from '../../resolve/request_lang.ts';
import type { Principal } from '../../security/permissions.ts';
import { activeHierarchyRows } from './export_hierarchy.ts';
import { fromOutcome, type WidgetModule, type WidgetResponse } from './support.ts';

/**
 * The importer SEAM (test injection only; production always takes the default).
 *
 * The install and the reset handler differ by EXACTLY one thing — the options
 * object they construct — so that argument IS the behaviour: swap them and the
 * non-destructive "Install" button silently DELETEs and re-seeds an already
 * installed thesaurus, discarding operator edits irreversibly. Injecting the
 * importer lets a gate pin which handler carries `{replace:true}` without ever
 * running the destructive import.
 */
export type HierarchiesImporter =
	typeof import('../../install/hierarchy_import.ts').installHierarchies;

async function realImporter(): Promise<HierarchiesImporter> {
	const { installHierarchies } = await import('../../install/hierarchy_import.ts');
	return installHierarchies;
}

/**
 * The tld of a hierarchy TERM section tipo, or null when the tipo is not one.
 *
 * The anchoring is the whole point: a term section is `<tld>1` EXACTLY —
 * `hierarchy1` → `hierarchy`, but `hierarchy125`, `test3` and `dd1758` are
 * not term sections at all. Loosen the trailing `$` (or the leading `^`) and
 * the installed set re-inflates the way the registry read once did — ~269
 * hierarchies marked installed when ~14 were — and the panel again offers to
 * skip imports that never happened.
 *
 * Pure on purpose: this used to be a `substring(… from …)` + `~` pair inside
 * the SQL, i.e. two copies of one predicate that no gate could reach.
 */
export function installedTldFromSectionTipo(sectionTipo: string): string | null {
	const match = /^([a-z]+)1$/.exec(sectionTipo);
	return match === null ? null : (match[1] as string);
}

/**
 * The INSTALLED set, pure: a tld is installed when its `<tld>1` term section has
 * rows (`termSectionTipos`), OR (2026-10-10) when it is an EMPTY thesaurus by
 * design (its manifest entry lists no data files — `emptyByDesign`) whose
 * registry row is ACTIVE (`activeRegistryTlds`). The second arm is not the
 * common case: an activation MINTS the General Term root in the term section
 * (hierarchy_state.ts ensureRootTerm), so an empty thesaurus activated into
 * `<tld>1` already has a row there. It covers the row whose hierarchy53 names
 * another section, where `<tld>1` stays empty and the marker would otherwise
 * offer the install forever. An active row of a thesaurus that HAS data files is
 * NOT installed by its flag alone — its terms are what count. Note the marker is
 * a hint: the importer decides on the LISTED sections' rows
 * (hierarchy_import.ts classifyListedSections), and a term section holding only
 * that minted root while the release now ships data is refused there naming
 * Reset. Unique, in first-seen order.
 */
export function mergeInstalledTlds(
	termSectionTipos: readonly string[],
	activeRegistryTlds: readonly string[],
	emptyByDesign: ReadonlySet<string>,
): string[] {
	const tlds = new Set<string>();
	for (const sectionTipo of termSectionTipos) {
		const tld = installedTldFromSectionTipo(sectionTipo);
		if (tld !== null) tlds.add(tld);
	}
	for (const raw of activeRegistryTlds) {
		const tld = raw.trim().toLowerCase();
		if (emptyByDesign.has(tld)) tlds.add(tld);
	}
	return [...tlds];
}

/**
 * The hierarchies actually INSTALLED, as unique {tld} objects ({@link mergeInstalledTlds}).
 *
 * (Earlier this read the hierarchy1 REGISTRY alone — but a seed declared a registry
 * record for ~every country whether its terms were imported or not, so it marked all
 * ~269 declared hierarchies "installed" when only ~14 actually were.) Fail-soft: a read
 * error must not break the panel.
 */
async function installedHierarchies(
	emptyByDesign: ReadonlySet<string>,
): Promise<{ tld: string }[]> {
	try {
		const rows = (await sql.unsafe(`SELECT DISTINCT section_tipo FROM matrix_hierarchy`, [])) as {
			section_tipo: string | null;
		}[];
		const active = emptyByDesign.size === 0 ? [] : await activeHierarchyRows();
		return mergeInstalledTlds(
			rows.map((row) => String(row.section_tipo ?? '')),
			active.map((row) => String(row.tld ?? '')),
			emptyByDesign,
		).map((tld) => ({ tld }));
	} catch (error) {
		console.error('add_hierarchy: installed_hierarchies read failed:', error);
		return [];
	}
}

async function addHierarchyGetValue(): Promise<WidgetResponse> {
	const view = hierarchyChoiceView(currentApplicationLang());
	const emptyByDesign = new Set(
		view.hierarchies.filter((item) => !item.has_data).map((item) => item.tld),
	);
	return {
		data: {
			hierarchies: view.hierarchies,
			installed_hierarchies: await installedHierarchies(emptyByDesign),
			hierarchy_typologies: view.hierarchy_typologies,
			hierarchy_files_dir_path: HIERARCHY_IMPORT_DIR,
		},
	};
}

/**
 * Import + activate the selected TLDs (installHierarchies: vendored `.copy.gz`
 * → matrix_hierarchy → consolidate counter → activate). Native to the engine:
 * the writes land in the CONFIGURED database through the runtime connection,
 * audited to the acting admin. An already-installed tld is SKIPPED (the import is
 * additive; `replace` stays false) — and the importer closes the selection over
 * the chosen thesauri's own MANDATORY declared dependencies (hierarchy.json)
 * first, exactly as the wizard and the CLI do. ENGINE_NATIVE in
 * update_ownership_tripwire.
 */
export async function addHierarchyInstall(
	options: Record<string, unknown>,
	principal: Principal,
	importer?: HierarchiesImporter,
): Promise<WidgetResponse> {
	const tlds = Array.isArray(options.hierarchies) ? options.hierarchies.map(String) : [];
	const installHierarchies = importer ?? (await realImporter());
	// NO fourth argument on purpose: `replace` stays false, i.e. additive.
	const r = await installHierarchies(tlds, undefined, principal.userId);
	return fromOutcome({ ok: r.ok, msg: r.msg, errors: r.errors });
}

/**
 * DESTRUCTIVE reset: DELETE each selected tld's existing rows, then re-import from the
 * vendored seed and re-activate (installHierarchies with replace:true — the PHP behavior).
 * Discards any operator edits/additions to those hierarchies' terms; reached only through
 * the explicit, confirmed "Reset to seed" control. ENGINE_NATIVE in update_ownership_tripwire.
 */
export async function addHierarchyReset(
	options: Record<string, unknown>,
	principal: Principal,
	importer?: HierarchiesImporter,
): Promise<WidgetResponse> {
	const tlds = Array.isArray(options.hierarchies) ? options.hierarchies.map(String) : [];
	const installHierarchies = importer ?? (await realImporter());
	const r = await installHierarchies(tlds, undefined, principal.userId, { replace: true });
	return fromOutcome({ ok: r.ok, msg: r.msg, errors: r.errors });
}

export const widget: WidgetModule = {
	spec: {
		id: 'add_hierarchy',
		category: 'data',
		class: 'success width_100',
		label: { kind: 'label_concat', keys: ['install', 'hierarchies'] },
	},
	// A thesaurus import / reset writes every term of a hierarchy: maintenance (PERF-11).
	unboundedActions: ['install_hierarchies', 'reset_hierarchies'],
	getValue: addHierarchyGetValue,
	apiActions: {
		install_hierarchies: addHierarchyInstall,
		reset_hierarchies: addHierarchyReset,
	},
};
