/**
 * THE DOMAIN-ONTOLOGY CHOICE of an install (installer unification A4/A5/A6) —
 * which ontologies an installation carries beyond the core the seed ships, the
 * ORDER they are imported in, and the THESAURI their declarations require.
 * PURE AND CONFIG-FREE, like the plan that uses it (install_plan.ts): it imports
 * only the core TLD list, the dependency normalizer (a leaf), the install paths
 * and the vendored thesaurus manifest reader (hierarchy_meta.ts), so the CLI can decide its plan before
 * it seeds the process environment config.ts freezes.
 *
 * THE MODEL:
 *  - CORE (core_tlds.ts) is the seed's, always installed, never a choice: a core
 *    TLD in the answer is dropped with a note.
 *  - A DOMAIN ontology is an answer (`ontologies`, >= 1 required, default `oh`).
 *    `oh` is VENDORED (VENDORED_DOMAIN_TLDS): the installer reads ONE file of the
 *    vendored ontology dir, `oh.copy.gz` (+ the `oh` entry of its `ontology.json`
 *    for the metadata AND the declared dependencies) — nothing else there; the
 *    rest of that dir belongs to the ontology-server role. Every other TLD comes
 *    from the selected SOURCE: an ontology server's manifest, or a local
 *    `--ontology-source` directory/archive.
 *  - DEPENDENCIES ARE DECLARED, NEVER COMPUTED (hierarchy60,
 *    WC-2026-10-10-ontology-dependencies-hierarchy60). Each catalog entry carries
 *    `{tld, main, mandatory}` items (ontology_dependencies.ts) or null (NOT
 *    declared — an older server, or a vendored ontology.json that predates the
 *    field: installed alone, with a loud warning):
 *     · `main: 'ontology35'` → the ONTOLOGY closure (deps first, depth-first
 *       post-order; core and the engine-owned TLD are fixed and never followed);
 *     · `main: 'hierarchy1'` → the THESAURUS set the install_hierarchies step
 *       imports + activates (a CORE hierarchy, `lg`, is activation-only and
 *       always done — never a dependency to install);
 *     · ONTOLOGY (`main: 'ontology35'`): `mandatory: true` → always installed,
 *       never declinable; `false` → offered PRE-TICKED: installed unless the
 *       operator DECLINES it (`declined_dependencies` — a TLD, or `<tld>:<main>`).
 *       An optional ontology the source does not offer is a warning; a
 *       mandatory one is an error.
 *     · THESAURUS (`main: 'hierarchy1'`, owner decision 2026-10-10): a thesaurus
 *       dependency NEVER blocks an install — an operator can work without it,
 *       define a thesaurus of their own under another name, or install it any
 *       time later. BOTH kinds are offered PRE-TICKED and BOTH are declinable;
 *       `mandatory: true` is a STRONG RECOMMENDATION: declining one is a
 *       WARNING naming dependant + dependency and where to install it later
 *       ({@link THESAURUS_INSTALL_LATER}), declining an optional one a note. A
 *       thesaurus with NO ENTRY in the vendored hierarchy.json is a warning and
 *       is skipped, mandatory or not (an entry without a DATA FILE installs as
 *       an empty thesaurus).
 *  - PRECEDENCE per TLD: a local source > the vendored file > a server.
 *
 * describeOntologyCatalog is the ONE view of a catalog: the wizard's
 * get_ontology_catalog answers it and the CLI's --list-ontologies prints it.
 * Gates: test/unit/install_ontology_choice.test.ts (+ the plan parity tripwire,
 * vendored_ontology_closure_tripwire).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DedaloError } from '../errors/dedalo_error.ts';
import { CORE_ONTOLOGY_TLDS, isCoreOntologyTld } from '../ontology/core_tlds.ts';
import {
	normalizeOntologyDependencies,
	ONTOLOGY_DEPENDENCY_MAINS,
	type OntologyDependency,
} from '../ontology/ontology_dependencies.ts';
import { isCoreHierarchyTld, offeredHierarchyTlds } from './hierarchy_meta.ts';
import { VENDORED_ONTOLOGY_DIR } from './paths.ts';

/** The domain ontologies an install gets when the answer is absent or `default`. */
export const DEFAULT_DOMAIN_ONTOLOGIES: readonly string[] = Object.freeze(['oh']);

/**
 * The domain ontologies the installer reads from the vendored ontology dir
 * (`<tld>.copy.gz`). Their DEPENDENCIES are never declared here: they are the
 * vendored ontology.json `active_ontologies` entry's (see header).
 */
export const VENDORED_DOMAIN_TLDS: readonly string[] = Object.freeze(['oh']);

/** The label key of the explanatory note the front ends show under a TLD. */
export const ONTOLOGY_NOTE_LABELS: Readonly<Record<string, string>> = Object.freeze({
	oh: 'installation_ontology_note_oh',
	tch: 'installation_ontology_note_tch',
});

/**
 * The engine-owned TLD (engine_ontology.ts ENGINE_TLD — gated equal by
 * install_ontology_choice): materialized by the engine itself, never a choice,
 * never a dependency to install. Not imported: engine_ontology.ts reaches the db.
 */
const ENGINE_OWNED_TLD = 'ddengine';

const TLD_RE = /^[a-z]{2,}$/;

export interface OntologyServerRef {
	name: string;
	url: string;
	code: string;
}
export type OntologySource =
	| { kind: 'none' }
	| { kind: 'local'; path: string }
	| { kind: 'server'; server: OntologyServerRef };
/** A source as a front end may see it — never the server's access code. */
export type OntologySourceView =
	| { kind: 'none' }
	| { kind: 'local'; path: string }
	| { kind: 'server'; server: { name: string; url: string } };

export type OntologyOrigin = 'vendored' | 'local' | 'server';

export interface OntologyCatalogEntry {
	tld: string;
	name: string;
	name_data: unknown;
	typology_id: number | string | null;
	typology_name: string | null;
	/** Declared dependencies (`{tld, main, mandatory}`, core included); null = NOT declared. */
	dependencies: OntologyDependency[] | null;
	origin: OntologyOrigin;
	/** An absolute path (vendored/local) or a URL (server). */
	file: string;
}
export interface OntologyMatrixDd {
	origin: 'local' | 'server';
	file: string;
}
export interface OntologyCatalog {
	source: OntologySource;
	entries: OntologyCatalogEntry[];
	matrixDd: OntologyMatrixDd | null;
	warnings: string[];
}
export interface OntologyInstallItem {
	tld: string;
	origin: OntologyOrigin;
	file: string;
	typology_id: number | string | null;
	name_data: unknown;
	dependencies: OntologyDependency[] | null;
}
export interface OntologyInstallRequest {
	source: OntologySourceView;
	/** Deps first. */
	items: OntologyInstallItem[];
	matrixDd: OntologyMatrixDd | null;
}
export interface OntologyCatalogViewEntry {
	tld: string;
	name: string;
	typology_id: number | string | null;
	typology_name: string | null;
	origin: OntologyOrigin;
	is_default: boolean;
	note_key: string | null;
	dependencies: OntologyDependency[] | null;
	/** The domain ontologies ticking this entry also installs (its closure, every optional dependency accepted). */
	also_installs: string[];
	/** The thesauri that closure declares (`main: 'hierarchy1'`), core hierarchies excluded. */
	hierarchy_dependencies: HierarchyDependency[];
}
export interface OntologyCatalogView {
	source: OntologySourceView;
	default: string[];
	core: string[];
	entries: OntologyCatalogViewEntry[];
	warnings: string[];
}

/**
 * One THESAURUS a closure requires (a `main: 'hierarchy1'` dependency): its
 * TLD, whether ANY declarer made it mandatory (mandatory wins), and the TLDs
 * that declared it, in declaration order.
 */
export interface HierarchyDependency {
	tld: string;
	mandatory: boolean;
	dependants: string[];
}

/**
 * How a walk treats the declinable dependencies: every THESAURUS dependency
 * (mandatory = strongly recommended, still declinable) and every OPTIONAL
 * ontology dependency. `accept` answers whether one is installed; the default
 * accepts every one (pre-ticked). A MANDATORY ONTOLOGY dependency is never
 * asked: it is always installed.
 */
export interface DependencyPolicy {
	accept?: (dependency: OntologyDependency) => boolean;
}

/** Something that declares dependencies: a catalog entry, a vendored core entry, a stored registry row. */
export interface DependencyDeclarer {
	tld: string;
	dependencies: readonly OntologyDependency[] | null;
}

// ── the vendored catalog ─────────────────────────────────────────────────────

export interface VendoredInfoEntry {
	tld?: unknown;
	name?: unknown;
	name_data?: unknown;
	typology_id?: unknown;
	typology_name?: unknown;
	/** hierarchy60 as the export writes it; absent = not declared. */
	dependencies?: unknown;
}

/** The vendored ontology.json `active_ontologies` entries, by TLD. */
export type VendoredInfo = ReadonlyMap<string, VendoredInfoEntry>;

/**
 * A parsed ontology.json → its `active_ontologies` by TLD (the FIRST entry of a
 * TLD wins). PURE — the module reads the vendored file once through it, and a
 * gate feeds it a DECLARING release (the vendored one may predate hierarchy60)
 * to prove the declaration is read, never carried by the installer.
 */
export function vendoredInfoFrom(parsed: unknown): VendoredInfo {
	const byTld = new Map<string, VendoredInfoEntry>();
	const entries = (parsed as { active_ontologies?: unknown } | null)?.active_ontologies;
	for (const entry of Array.isArray(entries) ? (entries as VendoredInfoEntry[]) : []) {
		if (typeof entry?.tld === 'string' && !byTld.has(entry.tld)) byTld.set(entry.tld, entry);
	}
	return byTld;
}

/**
 * The vendored ontology.json, by TLD. Empty when the file is absent or
 * unreadable — every entry then falls back to its TLD as its name.
 */
async function readVendoredInfo(): Promise<VendoredInfo> {
	try {
		return vendoredInfoFrom(
			JSON.parse(await readFile(join(VENDORED_ONTOLOGY_DIR, 'ontology.json'), 'utf8')),
		);
	} catch {
		// absent or malformed: names fall back to the TLD (vendoredEntry)
		return new Map();
	}
}

/**
 * Read ONCE, at module load, asynchronously: the file is release content (~120 KB,
 * replaced only WITH the tree, and a code update restarts the process), and the
 * wizard's catalog routes are served from the one event loop — a synchronous
 * read per entry per call stalled every request (sync_io_on_request_path_tripwire).
 */
const VENDORED_INFO: VendoredInfo = await readVendoredInfo();

function typologyIdOf(value: unknown): number | string | null {
	return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function stringOr<T>(value: unknown, fallback: T): string | T {
	return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * The DECLARED dependencies of a vendored ontology.json entry — through THE
 * normalizer the manifest reader and the registry export use (absent → null:
 * not declared; malformed items dropped, each a warning).
 */
function vendoredDependencies(
	tld: string,
	warnings: string[],
	info: VendoredInfo,
): OntologyDependency[] | null {
	const lines: string[] = [];
	const dependencies = normalizeOntologyDependencies(tld, info.get(tld)?.dependencies, lines);
	for (const line of lines) warnings.push(`the built-in ontology.json: ${line}`);
	return dependencies;
}

/** One vendored entry: metadata AND declared dependencies from the vendored ontology.json. */
function vendoredEntry(tld: string, warnings: string[], info: VendoredInfo): OntologyCatalogEntry {
	const meta = info.get(tld) ?? {};
	return {
		tld,
		name: stringOr(meta.name, tld),
		name_data: meta.name_data ?? null,
		typology_id: typologyIdOf(meta.typology_id),
		typology_name: stringOr(meta.typology_name, null),
		dependencies: vendoredDependencies(tld, warnings, info),
		origin: 'vendored',
		file: join(VENDORED_ONTOLOGY_DIR, `${tld}.copy.gz`),
	};
}

/**
 * The built-in catalog: the vendored domain ontologies whose file is present
 * (a missing file is a warning, and the TLD is not offered). `info` defaults to
 * the vendored ontology.json (a gate passes its own — vendoredInfoFrom).
 */
export function vendoredOntologyCatalog(info: VendoredInfo = VENDORED_INFO): OntologyCatalog {
	const entries: OntologyCatalogEntry[] = [];
	const warnings: string[] = [];
	for (const tld of VENDORED_DOMAIN_TLDS) {
		const entry = vendoredEntry(tld, warnings, info);
		if (existsSync(entry.file)) entries.push(entry);
		else warnings.push(`the built-in ontology file ${tld}.copy.gz is missing`);
	}
	return { source: { kind: 'none' }, entries, matrixDd: null, warnings };
}

/**
 * The CORE TLDs as the vendored ontology.json declares them. The seed is
 * compiled from that same release, so these are the dependencies its core
 * registry rows hold — the thesauri they declare are part of every plan.
 * Malformed items are dropped (warned through `warnings`).
 */
export function vendoredCoreDeclarers(
	warnings: string[] = [],
	info: VendoredInfo = VENDORED_INFO,
): DependencyDeclarer[] {
	return CORE_ONTOLOGY_TLDS.map((tld) => ({
		tld,
		dependencies: vendoredDependencies(tld, warnings, info),
	}));
}

const ORIGIN_RANK: Readonly<Record<OntologyOrigin, number>> = { local: 3, vendored: 2, server: 1 };

/**
 * A source's catalog merged with the vendored one — per TLD the higher-ranked
 * origin wins (local > vendored > server). Idempotent: merging an already merged
 * catalog again changes nothing.
 */
export function mergeOntologyCatalogs(
	sourceCatalog: OntologyCatalog | undefined,
	vendored: OntologyCatalog,
): OntologyCatalog {
	if (sourceCatalog === undefined) return vendored;
	const byTld = new Map<string, OntologyCatalogEntry>();
	for (const entry of [...sourceCatalog.entries, ...vendored.entries]) {
		const held = byTld.get(entry.tld);
		if (held === undefined || ORIGIN_RANK[entry.origin] > ORIGIN_RANK[held.origin]) {
			byTld.set(entry.tld, entry);
		}
	}
	return {
		source: sourceCatalog.source,
		entries: [...byTld.values()],
		matrixDd: sourceCatalog.matrixDd,
		warnings: [...new Set([...sourceCatalog.warnings, ...vendored.warnings])],
	};
}

// ── the answer ───────────────────────────────────────────────────────────────

const NONE_ERROR = 'at least one domain ontology is required (the default is oh)';

/** The requested TLDs before the core filter (absent / 'default' → the default set). */
function requestedOntologies(value: unknown): string[] {
	if (value === undefined || value === null || value === 'default') {
		return [...DEFAULT_DOMAIN_ONTOLOGIES];
	}
	if (value === 'none') return [];
	const items = Array.isArray(value) ? value : String(value).split(',');
	return items.map((item) => String(item).trim().toLowerCase()).filter((item) => item !== '');
}

/** One requested TLD → kept, noted (core) or refused (grammar). */
function admitOntology(tld: string, picked: string[], notes: string[], errors: string[]): void {
	if (!TLD_RE.test(tld)) errors.push(`ontologies: '${tld}' is not a TLD`);
	else if (isCoreOntologyTld(tld)) {
		notes.push(`${tld} is a core ontology (always installed) — dropped from the list`);
	} else if (!picked.includes(tld)) picked.push(tld);
}

/**
 * The `ontologies` answer normalized: lowercased, de-duplicated, a core TLD
 * dropped with a note, a non-TLD refused; at least one domain ontology left.
 */
export function normalizeOntologyChoice(value: unknown): {
	ontologies: string[];
	notes: string[];
	errors: string[];
} {
	const ontologies: string[] = [];
	const notes: string[] = [];
	const errors: string[] = [];
	for (const tld of requestedOntologies(value)) admitOntology(tld, ontologies, notes, errors);
	if (ontologies.length === 0 && errors.length === 0) errors.push(NONE_ERROR);
	return { ontologies, notes, errors };
}

/**
 * Whether the choice needs a catalog RESOLVED beyond the vendored one: a local
 * source always (its files win over the vendored `oh`), a server when a chosen
 * TLD — or an installed dependency the vendored set declares — is not vendored.
 * Never for `none` — there is nothing else to resolve, and the vendored catalog
 * answers (an unvendored TLD is then "not offered").
 */
export function ontologyCatalogNeeded(
	chosen: readonly string[],
	source: OntologySource,
	policy: DependencyPolicy = {},
): boolean {
	if (source.kind === 'none') return false;
	if (source.kind === 'local') return true;
	const walk = newWalk(vendoredOntologyCatalog(), policy);
	for (const tld of chosen) {
		if (walk.byTld.has(tld)) visitOntology(walk, tld);
		else walk.unoffered.push(tld);
	}
	return walk.unoffered.length > 0;
}

// ── declined dependencies ────────────────────────────────────────────────────

const MAIN_SET: ReadonlySet<string> = new Set(ONTOLOGY_DEPENDENCY_MAINS);

/** One `declined_dependencies` token → its normalized form, or null when it is not one. */
function declineToken(raw: string): string | null {
	const [tld = '', main, ...rest] = raw.trim().toLowerCase().split(':');
	if (rest.length > 0 || !TLD_RE.test(tld)) return null;
	if (main === undefined) return tld;
	return MAIN_SET.has(main) ? `${tld}:${main}` : null;
}

/**
 * The `declined_dependencies` answer normalized: the dependencies the
 * operator declines — a TLD (both mains) or `<tld>:<main>` (`ontology35` /
 * `hierarchy1`); lowercased, de-duplicated. Absent / '' / 'none' → [] (every
 * declinable dependency installed: they are offered pre-ticked). A malformed
 * token is refused. Any THESAURUS can be declined (a mandatory one with a
 * warning — strongly recommended); declining a MANDATORY ONTOLOGY has no
 * effect.
 */
export function normalizeDeclinedDependencies(value: unknown): {
	declined: string[];
	errors: string[];
} {
	const declined: string[] = [];
	const errors: string[] = [];
	for (const item of declineItems(value)) {
		const token = declineToken(item);
		if (token === null) errors.push(declineError(item));
		else if (!declined.includes(token)) declined.push(token);
	}
	return { declined, errors };
}

/** The raw, non-blank items of a `declined_dependencies` answer (absent / '' / 'none' → none). */
function declineItems(value: unknown): string[] {
	if (value === undefined || value === null || value === 'none') return [];
	const items = Array.isArray(value) ? value : String(value).split(',');
	return items.map((raw) => String(raw)).filter((raw) => raw.trim() !== '');
}

function declineError(item: string): string {
	return `declined_dependencies: '${item.trim()}' is not a TLD or <tld>:ontology35|hierarchy1`;
}

/** Is `dependency` named by a normalized decline list (its TLD, or its TLD + main)? */
function isDeclined(declined: ReadonlySet<string>, dependency: OntologyDependency): boolean {
	return declined.has(dependency.tld) || declined.has(`${dependency.tld}:${dependency.main}`);
}

/** The policy of a decline list: every optional dependency it does not name is accepted. */
export function declinePolicy(declined: readonly string[]): DependencyPolicy {
	const set = new Set(declined);
	return { accept: (dependency) => !isDeclined(set, dependency) };
}

/** The words that name a catalog's source in a refusal. */
export function ontologySourceLabel(source: OntologySource | OntologySourceView): string {
	if (source.kind === 'server') return `the ontology server '${source.server.name}'`;
	if (source.kind === 'local') return `--ontology-source ${source.path}`;
	return 'the built-in set (air-gapped: only oh is available offline)';
}

/** A source without its access code. */
export function ontologySourceView(source: OntologySource): OntologySourceView {
	if (source.kind !== 'server') return source;
	return { kind: 'server', server: { name: source.server.name, url: source.server.url } };
}

// ── the closure ──────────────────────────────────────────────────────────────

/** A TLD the closure never follows: core (the seed's) or engine-owned. */
function isFixedTld(tld: string): boolean {
	return isCoreOntologyTld(tld) || tld === ENGINE_OWNED_TLD;
}

interface ClosureWalk {
	byTld: ReadonlyMap<string, OntologyCatalogEntry>;
	label: string;
	accept: (dependency: OntologyDependency) => boolean;
	state: Map<string, 'visiting' | 'done'>;
	order: string[];
	/** Optional ontology dependencies NOT followed (declined), `<tld> ← <dependant>`. */
	declined: { tld: string; dependant: string }[];
	/** Every TLD the walk needed and the catalog does not offer (mandatory or optional). */
	unoffered: string[];
	warnings: string[];
	errors: string[];
}

/**
 * THE not-declared warning (one text for the closure and the stager): a
 * vendored entry's ontology.json predates the declaration; any other source is
 * an older ontology server.
 */
export function undeclaredWarning(entry: { tld: string; origin: OntologyOrigin }): string {
	const who =
		entry.origin === 'vendored'
			? 'the built-in ontology.json declares'
			: 'the ontology source declares';
	const why =
		entry.origin === 'vendored' ? 'a release that predates them' : 'an older ontology server';
	return `${who} no dependencies for '${entry.tld}' (${why}) — '${entry.tld}' is installed alone; anything it references in other ontologies stays unresolved`;
}

/**
 * Visit one declared ONTOLOGY dependency of `tld`: fixed → skipped; offered →
 * visited; not offered → an ERROR when mandatory, a WARNING (skipped) when
 * optional.
 */
function visitDependency(walk: ClosureWalk, tld: string, dependency: OntologyDependency): void {
	if (isFixedTld(dependency.tld)) return;
	if (walk.byTld.has(dependency.tld)) {
		visitOntology(walk, dependency.tld);
		return;
	}
	walk.unoffered.push(dependency.tld);
	if (dependency.mandatory) {
		walk.errors.push(
			`'${dependency.tld}', declared as a dependency of '${tld}', is not offered by ${walk.label}`,
		);
	} else {
		walk.warnings.push(
			`'${dependency.tld}', declared as an optional dependency of '${tld}', is not offered by ${walk.label} — skipped`,
		);
	}
}

/**
 * Depth-first, post-order (deps first); a TLD being visited is skipped (cycles
 * tolerated). The ONTOLOGY closure follows `main: 'ontology35'` dependencies
 * only — mandatory always, optional when the policy accepts them.
 */
function visitOntology(walk: ClosureWalk, tld: string): void {
	if (walk.state.has(tld)) return;
	walk.state.set(tld, 'visiting');
	const entry = walk.byTld.get(tld) as OntologyCatalogEntry;
	if (entry.dependencies === null) walk.warnings.push(undeclaredWarning(entry));
	else followOntologyDependencies(walk, tld, entry.dependencies);
	walk.state.set(tld, 'done');
	walk.order.push(tld);
}

/**
 * The `main: 'ontology35'` dependencies of `tld`: mandatory followed, optional
 * when accepted. A FIXED TLD (core / engine-owned — always installed from the
 * seed) is never put to the policy: it can be neither declined nor noted as
 * "declined — not installed" (that note would be false).
 */
function followOntologyDependencies(
	walk: ClosureWalk,
	tld: string,
	dependencies: readonly OntologyDependency[],
): void {
	const followed = dependencies.filter(
		(item) => item.main === 'ontology35' && !isFixedTld(item.tld),
	);
	for (const dependency of followed) {
		if (dependency.mandatory || walk.accept(dependency)) visitDependency(walk, tld, dependency);
		else walk.declined.push({ tld: dependency.tld, dependant: tld });
	}
}

const ACCEPT_ALL = (): boolean => true;

function newWalk(catalog: OntologyCatalog, policy: DependencyPolicy = {}): ClosureWalk {
	return {
		byTld: new Map(catalog.entries.map((entry) => [entry.tld, entry])),
		label: ontologySourceLabel(catalog.source),
		accept: policy.accept ?? ACCEPT_ALL,
		state: new Map(),
		order: [],
		declined: [],
		unoffered: [],
		warnings: [],
		errors: [],
	};
}

/** The transitive declared dependencies of `tld` (core and itself excluded), in install order. */
function closureOf(tld: string, catalog: OntologyCatalog, policy: DependencyPolicy): string[] {
	const walk = newWalk(catalog, policy);
	if (walk.byTld.has(tld)) visitOntology(walk, tld);
	return walk.order;
}

/**
 * Where a thesaurus left out of an install is installed later — the
 * maintenance panel (add_hierarchy widget, labelled "Install hierarchies").
 */
export const THESAURUS_INSTALL_LATER = 'Maintenance › Install hierarchies';

/**
 * THE warning of a MANDATORY (= strongly recommended) thesaurus dependency an
 * install leaves out — declined by the operator, or without an entry in the
 * vendored hierarchy.json. Never an error: a thesaurus never blocks an install
 * (owner decision 2026-10-10). Names the dependency, its dependants and where
 * to install it later.
 */
export function recommendedThesaurusWarning(
	tld: string,
	dependants: readonly string[],
	reason: 'declined' | 'no_entry',
): string {
	const who = `the thesaurus '${tld}' (declared mandatory by ${dependants.map((item) => `'${item}'`).join(', ')})`;
	const what =
		reason === 'declined'
			? 'is declined — not installed'
			: 'has no entry in hierarchy.json — skipped';
	return `${who} ${what}; it is strongly recommended and can be installed later from ${THESAURUS_INSTALL_LATER}`;
}

/** Is `dependency` a thesaurus the collection lists (not an ontology, not a core hierarchy)? */
function isListedThesaurus(dependency: OntologyDependency): boolean {
	return dependency.main === 'hierarchy1' && !isCoreHierarchyTld(dependency.tld);
}

/** Merge one admitted thesaurus of `dependant` into `byTld` (mandatory wins, dependants accumulate). */
function mergeHierarchyDependency(
	byTld: Map<string, HierarchyDependency>,
	dependency: OntologyDependency,
	dependant: string,
): void {
	const held = byTld.get(dependency.tld);
	if (held === undefined) {
		byTld.set(dependency.tld, {
			tld: dependency.tld,
			mandatory: dependency.mandatory,
			dependants: [dependant],
		});
		return;
	}
	held.mandatory = held.mandatory || dependency.mandatory;
	if (!held.dependants.includes(dependant)) held.dependants.push(dependant);
}

/** A dependency the policy declined, with the dependant that declared it. */
export interface DeclinedDependency {
	tld: string;
	dependant: string;
	mandatory: boolean;
}

/** One declarer's thesaurus dependencies merged into `byTld`; declined ones (either kind) recorded. */
function addHierarchyDependencies(
	declarer: DependencyDeclarer,
	accept: (dependency: OntologyDependency) => boolean,
	byTld: Map<string, HierarchyDependency>,
	declined: DeclinedDependency[],
): void {
	for (const dependency of (declarer.dependencies ?? []).filter(isListedThesaurus)) {
		if (accept(dependency)) mergeHierarchyDependency(byTld, dependency, declarer.tld);
		else {
			declined.push({
				tld: dependency.tld,
				dependant: declarer.tld,
				mandatory: dependency.mandatory,
			});
		}
	}
}

/**
 * THE thesaurus set a group of declarers requires: every `main: 'hierarchy1'`
 * dependency the policy accepts (mandatory OR optional — a thesaurus is
 * always declinable, mandatory = strongly recommended) merged per TLD
 * (mandatory wins), in first-declaration order. A CORE hierarchy (`lg`) is
 * never listed: every install activates it. `declined` lists the ones the
 * policy refused, each with its `mandatory` flag (the caller warns for a
 * mandatory one — declinedFindings). Shared by the plan (catalog entries + the
 * vendored core), the wizard's install_hierarchies step (the installed
 * registry rows) and the catalog view.
 */
export function collectHierarchyDependencies(
	declarers: readonly DependencyDeclarer[],
	policy: DependencyPolicy = {},
): { dependencies: HierarchyDependency[]; declined: DeclinedDependency[] } {
	const byTld = new Map<string, HierarchyDependency>();
	const declined: DeclinedDependency[] = [];
	for (const declarer of declarers) {
		addHierarchyDependencies(declarer, policy.accept ?? ACCEPT_ALL, byTld, declined);
	}
	return { dependencies: [...byTld.values()], declined };
}

/** The declarers of an install order (its catalog entries). */
export function declarersOf(
	order: readonly string[],
	catalog: OntologyCatalog,
): DependencyDeclarer[] {
	const byTld = new Map(catalog.entries.map((entry) => [entry.tld, entry]));
	return order.flatMap((tld) => {
		const entry = byTld.get(tld);
		return entry === undefined ? [] : [{ tld, dependencies: entry.dependencies }];
	});
}

/** The notes of the optional dependencies declined and REALLY left out. */
function declinedNotes(
	declined: readonly { tld: string; dependant: string }[],
	installed: ReadonlySet<string>,
	kind: 'ontology' | 'thesaurus',
): string[] {
	const notes = declined
		.filter((item) => !installed.has(item.tld))
		.map(
			(item) =>
				`the ${kind} '${item.tld}' (an optional dependency of '${item.dependant}') is declined — not installed`,
		);
	return [...new Set(notes)];
}

/**
 * The declined THESAURI really left out: a TLD some declarer made MANDATORY →
 * ONE warning (recommendedThesaurusWarning, its mandatory dependants); a TLD
 * only optional declarers named → a note per declarer (declinedNotes).
 */
function declinedThesaurusFindings(
	declined: readonly DeclinedDependency[],
	installed: ReadonlySet<string>,
): { notes: string[]; warnings: string[] } {
	const left = declined.filter((item) => !installed.has(item.tld));
	const mandatoryBy = new Map<string, string[]>();
	for (const item of left.filter((entry) => entry.mandatory)) {
		const dependants = mandatoryBy.get(item.tld) ?? [];
		if (!dependants.includes(item.dependant)) dependants.push(item.dependant);
		mandatoryBy.set(item.tld, dependants);
	}
	return {
		notes: declinedNotes(
			left.filter((item) => !mandatoryBy.has(item.tld)),
			installed,
			'thesaurus',
		),
		warnings: [...mandatoryBy].map(([tld, dependants]) =>
			recommendedThesaurusWarning(tld, dependants, 'declined'),
		),
	};
}

export interface OntologyClosure {
	/** The domain ontologies to import, deps first. */
	order: string[];
	/** The thesauri the ordered ontologies declare (core hierarchies excluded). */
	hierarchies: HierarchyDependency[];
	notes: string[];
	warnings: string[];
	errors: string[];
}

/** What else a closure is told: declarers beyond the order, thesauri installed anyway. */
export interface ClosureContext {
	/** Declarers OUTSIDE the order whose thesauri join the set (the plan: the vendored core). */
	coreDeclarers?: readonly DependencyDeclarer[];
	/** Thesauri the install carries whatever the policy says (the answer's own) — never "declined". */
	chosenThesauri?: readonly string[];
}

/**
 * The install order of the chosen TLDs: the closure over their DECLARED
 * ONTOLOGY dependencies, deps first (depth-first post-order), core and
 * engine-owned TLDs skipped, cycles tolerated (first finish wins; the
 * installer's re-derive pass settles them), an optional dependency followed
 * unless the policy declines it. Undeclared → warning; a chosen TLD or a
 * mandatory dependency the catalog does not offer → error (an optional one →
 * warning). `hierarchies` = the thesauri the core declarers + the ordered TLDs
 * declare and the policy accepts; a declined MANDATORY thesaurus is a warning
 * (strongly recommended), never an error.
 */
export function closeOntologyChoice(
	chosen: readonly string[],
	catalog: OntologyCatalog,
	policy: DependencyPolicy = {},
	context: ClosureContext = {},
): OntologyClosure {
	const walk = newWalk(catalog, policy);
	for (const tld of chosen) {
		if (walk.byTld.has(tld)) visitOntology(walk, tld);
		else walk.errors.push(`unknown ontology '${tld}' — not offered by ${walk.label}`);
	}
	const thesauri = collectHierarchyDependencies(
		[...(context.coreDeclarers ?? []), ...declarersOf(walk.order, catalog)],
		policy,
	);
	const hierarchyTlds = new Set([
		...thesauri.dependencies.map((item) => item.tld),
		...(context.chosenThesauri ?? []),
	]);
	const declinedThesauri = declinedThesaurusFindings(thesauri.declined, hierarchyTlds);
	const notes = [
		...chosen
			.filter((tld) => walk.byTld.has(tld))
			.map((tld) => ({
				tld,
				extra: closureOf(tld, catalog, policy).filter((item) => item !== tld),
			}))
			.filter((item) => item.extra.length > 0)
			.map((item) => `${item.tld} also installs: ${item.extra.join(', ')}`),
		...declinedNotes(walk.declined, new Set(walk.order), 'ontology'),
		...declinedThesauri.notes,
	];
	return {
		order: walk.order,
		hierarchies: thesauri.dependencies,
		notes,
		warnings: [...walk.warnings, ...declinedThesauri.warnings],
		errors: walk.errors,
	};
}

/**
 * The TLDs of the vendored optional thesauri — every non-core entry of the
 * thesaurus manifest (hierarchy.json), with or without data files. Re-exported
 * from THE reader (hierarchy_meta.ts), never re-derived.
 */
export { offeredHierarchyTlds };

function dependantsText(item: HierarchyDependency): string {
	return item.dependants.map((tld) => `'${tld}'`).join(', ');
}

/**
 * The thesauri a closure requires → what install_hierarchies installs. THE
 * RULE (2026-10-10, WC-2026-10-10-hierarchy-json-manifest): a thesaurus is
 * installable when the vendored manifest (hierarchy.json) has an ENTRY for it
 * — a data file is not required (an entry without one installs as an empty
 * thesaurus). No entry → a WARNING, skipped, mandatory or not: a thesaurus
 * never blocks an install (owner decision 2026-10-10 — a mandatory one is
 * strongly recommended, recommendedThesaurusWarning). `offered` is read only
 * when there is something to check (an empty list never touches the manifest).
 */
export function hierarchyDependencyPlan(
	dependencies: readonly HierarchyDependency[],
	offered?: ReadonlySet<string>,
): { install: string[]; warnings: string[] } {
	const install: string[] = [];
	const warnings: string[] = [];
	if (dependencies.length === 0) return { install, warnings };
	const listed = offered ?? offeredHierarchyTlds();
	for (const item of dependencies) {
		if (listed.has(item.tld)) install.push(item.tld);
		else if (item.mandatory) {
			warnings.push(recommendedThesaurusWarning(item.tld, item.dependants, 'no_entry'));
		} else {
			warnings.push(
				`the thesaurus '${item.tld}', an optional dependency of ${dependantsText(item)}, has no entry in hierarchy.json — skipped`,
			);
		}
	}
	return { install, warnings };
}

/** The matrix_dd file travels only with an item of the same origin (it is that source's lists). */
function requestMatrixDd(
	items: readonly OntologyInstallItem[],
	catalog: OntologyCatalog,
): OntologyMatrixDd | null {
	const matrixDd = catalog.matrixDd;
	if (matrixDd === null) return null;
	return items.some((item) => item.origin === matrixDd.origin) ? matrixDd : null;
}

/** The ordered TLDs → what the installer stages and imports. */
export function ontologyInstallRequest(
	order: readonly string[],
	catalog: OntologyCatalog,
): OntologyInstallRequest {
	const byTld = new Map(catalog.entries.map((entry) => [entry.tld, entry]));
	const items = order.flatMap((tld) => {
		const entry = byTld.get(tld);
		return entry === undefined ? [] : [installItem(entry)];
	});
	return {
		source: ontologySourceView(catalog.source),
		items,
		matrixDd: requestMatrixDd(items, catalog),
	};
}

function installItem(entry: OntologyCatalogEntry): OntologyInstallItem {
	return {
		tld: entry.tld,
		origin: entry.origin,
		file: entry.file,
		typology_id: entry.typology_id,
		name_data: entry.name_data,
		dependencies: entry.dependencies,
	};
}

/** The ACTIVE_ONTOLOGY_TLDS an install writes: core, then the installed domains in install order. */
export function activeOntologyTldsOf(order: readonly string[]): string[] {
	return [...CORE_ONTOLOGY_TLDS, ...order];
}

/**
 * The install request a written ACTIVE_ONTOLOGY_TLDS stands for (the wizard
 * path: persist_config wrote the key, the restarted process stages from it).
 * The closure of its domain part must be exactly that part — a hand-edited list
 * missing a declared dependency is refused, never silently extended.
 */
export function ontologyRequestFromActive(
	active: readonly string[],
	catalog: OntologyCatalog,
): { request: OntologyInstallRequest | null; errors: string[] } {
	const domain = [...new Set(active.map((tld) => tld.trim().toLowerCase()))].filter(
		(tld) => tld !== '' && !isFixedTld(tld),
	);
	if (domain.length === 0) return { request: null, errors: [NONE_ERROR] };
	// The written list IS the operator's choice: an optional dependency it does
	// not carry was declined; a MANDATORY one it lacks refuses (closureMismatch).
	const closure = closeOntologyChoice(domain, catalog, listedPolicy(domain));
	const errors = [...closure.errors, ...closureMismatch(domain, closure.order)];
	if (errors.length > 0) return { request: null, errors };
	return { request: ontologyInstallRequest(closure.order, catalog), errors: [] };
}

/** The policy of a written list: an optional dependency is accepted only when the list carries it. */
export function listedPolicy(listed: readonly string[]): DependencyPolicy {
	const set = new Set(listed);
	return { accept: (dependency) => set.has(dependency.tld) };
}

function closureMismatch(domain: readonly string[], order: readonly string[]): string[] {
	const missing = order.filter((tld) => !domain.includes(tld));
	if (missing.length === 0) return [];
	return [
		`ACTIVE_ONTOLOGY_TLDS lacks ${missing.join(', ')}, declared as mandatory dependencies of its ontologies — save the configuration again`,
	];
}

// ── the one view ─────────────────────────────────────────────────────────────

function viewEntry(
	entry: OntologyCatalogEntry,
	catalog: OntologyCatalog,
): OntologyCatalogViewEntry {
	return {
		tld: entry.tld,
		name: entry.name,
		typology_id: entry.typology_id,
		typology_name: entry.typology_name,
		origin: entry.origin,
		is_default: DEFAULT_DOMAIN_ONTOLOGIES.includes(entry.tld),
		note_key: ONTOLOGY_NOTE_LABELS[entry.tld] ?? null,
		dependencies: entry.dependencies,
		also_installs: closureOf(entry.tld, catalog, {}).filter((tld) => tld !== entry.tld),
		hierarchy_dependencies: collectHierarchyDependencies(
			declarersOf(closureOf(entry.tld, catalog, {}), catalog),
		).dependencies,
	};
}

/** Default first, then by typology name (unnamed last), then by TLD. */
function compareViewEntries(a: OntologyCatalogViewEntry, b: OntologyCatalogViewEntry): number {
	if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
	const byTypology = (a.typology_name ?? '￿').localeCompare(b.typology_name ?? '￿');
	return byTypology !== 0 ? byTypology : a.tld.localeCompare(b.tld);
}

/** THE view of a catalog (wizard get_ontology_catalog ≡ CLI --list-ontologies). */
export function describeOntologyCatalog(catalog: OntologyCatalog): OntologyCatalogView {
	return {
		source: ontologySourceView(catalog.source),
		default: [...DEFAULT_DOMAIN_ONTOLOGIES],
		core: [...CORE_ONTOLOGY_TLDS],
		entries: catalog.entries
			.filter((entry) => !isFixedTld(entry.tld))
			.map((entry) => viewEntry(entry, catalog))
			.sort(compareViewEntries),
		warnings: [...catalog.warnings],
	};
}

/**
 * The default domain ontologies from the vendored catalog alone — what an
 * offline install gets, and what the suite database is built with
 * (scripts/test_db_setup.ts). Throws when the vendored set cannot serve it.
 */
export function defaultOfflineOntologyRequest(): OntologyInstallRequest {
	const catalog = vendoredOntologyCatalog();
	const closure = closeOntologyChoice(DEFAULT_DOMAIN_ONTOLOGIES, catalog);
	const errors = [...catalog.warnings, ...closure.errors];
	if (errors.length > 0) {
		throw new DedaloError('internal.invariant', {
			message: `the built-in ontology set cannot serve the default (${errors.join('; ')})`,
		});
	}
	return ontologyInstallRequest(closure.order, catalog);
}

/** A declared ONTOLOGY dependency of a thesaurus: fine when installed (or core), else a finding. */
function thesaurusOntologyFinding(
	thesaurus: string,
	dependency: OntologyDependency,
	installedOntologies: ReadonlySet<string>,
): { warning?: string; error?: string } {
	if (isCoreOntologyTld(dependency.tld) || installedOntologies.has(dependency.tld)) return {};
	const kind = dependency.mandatory ? 'a mandatory' : 'an optional';
	const sentence = `the ontology '${dependency.tld}', ${kind} dependency of the thesaurus '${thesaurus}', is not part of this install`;
	return dependency.mandatory
		? { error: `${sentence} — add it to the ontologies` }
		: { warning: `${sentence} — skipped` };
}

/** What closing a thesaurus choice over its own declarations answers. */
export interface ThesaurusChoiceClosure {
	/** The chosen thesauri, then every one their declarations add (first-declaration order). */
	hierarchies: string[];
	/**
	 * The thesauri the set declares (merged per tld, mandatory wins) that it
	 * installs or that have no entry — a declined one with an entry is not here.
	 */
	dependencies: HierarchyDependency[];
	notes: string[];
	/** Every thesaurus left out (declined mandatory, no entry) and every optional ontology missing. */
	warnings: string[];
	/** ONLY a declared MANDATORY ONTOLOGY the install lacks — a thesaurus never errors. */
	errors: string[];
}

/**
 * THE THESAURI A THESAURUS DECLARES (2026-10-10 review). A hierarchy.json
 * entry carries its registry row's hierarchy60 (`entries` — the manifest's
 * declarers), and the hierarchy60 law does not depend on who declares. Closes
 * `chosen` TRANSITIVELY over the declarations of every thesaurus in the set: a
 * declared thesaurus WITH an entry joins when the policy accepts it (mandatory
 * or optional — both pre-ticked, both declinable, owner decision 2026-10-10).
 * What stays out never blocks: a declined MANDATORY one is a warning
 * (recommendedThesaurusWarning — strongly recommended, installable later), a
 * declined optional one is silent (the posted list answered it), one with no
 * entry is a warning (THE entry rule, hierarchyDependencyPlan). A declared
 * ONTOLOGY (`main: 'ontology35'`) keeps the ontology law: it must be part of
 * the install (`installedOntologies`, core always is) — mandatory missing →
 * error, optional → warning; a thesaurus cannot pull an ontology in at this
 * stage. Shared by the plan (CLI) and the install_hierarchies door. Pure.
 */
export function closeThesaurusChoice(
	chosen: readonly string[],
	entries: readonly DependencyDeclarer[],
	installedOntologies: ReadonlySet<string>,
	policy: DependencyPolicy = {},
): ThesaurusChoiceClosure {
	const byTld = new Map(entries.map((entry) => [entry.tld, entry]));
	const accept = policy.accept ?? ACCEPT_ALL;
	const hierarchies = [...chosen];
	const declarers: DependencyDeclarer[] = [];
	const findings = { warnings: [] as string[], errors: [] as string[] };
	// A fixed-point walk: every added thesaurus's own declarations are read too.
	for (let index = 0; index < hierarchies.length; index++) {
		const declarer = byTld.get(hierarchies[index] as string);
		if (declarer === undefined) continue;
		declarers.push(declarer);
		addThesaurusOntologyFindings(declarer, installedOntologies, findings);
		hierarchies.push(...acceptedThesauri(declarer, byTld, hierarchies, accept));
	}
	// Every declared thesaurus left out: no entry → THE entry rule's warning;
	// with an entry → declined (a mandatory one warned, an optional one silent).
	const declared = collectHierarchyDependencies(declarers).dependencies;
	const left = declared.filter((item) => !hierarchies.includes(item.tld));
	const unlisted = hierarchyDependencyPlan(
		left.filter((item) => !byTld.has(item.tld)),
		new Set(byTld.keys()),
	);
	const declined = left
		.filter((item) => item.mandatory && byTld.has(item.tld))
		.map((item) => recommendedThesaurusWarning(item.tld, item.dependants, 'declined'));
	return {
		hierarchies,
		dependencies: declared.filter((item) => hierarchies.includes(item.tld) || !byTld.has(item.tld)),
		notes: addedNotes(hierarchies.slice(chosen.length), declared),
		warnings: [...findings.warnings, ...unlisted.warnings, ...declined],
		errors: findings.errors,
	};
}

/** The thesauri `declarer` declares that have an entry, are not in the set yet and are accepted, in order. */
function acceptedThesauri(
	declarer: DependencyDeclarer,
	byTld: ReadonlyMap<string, DependencyDeclarer>,
	hierarchies: readonly string[],
	accept: (dependency: OntologyDependency) => boolean,
): string[] {
	const added: string[] = [];
	for (const dependency of (declarer.dependencies ?? []).filter(isListedThesaurus)) {
		const known = [...hierarchies, ...added];
		if (joinsThesaurusSet(dependency, byTld, known, accept)) added.push(dependency.tld);
	}
	return added;
}

/** A declared thesaurus joins the set when it is new, has an entry, and the policy accepts it. */
function joinsThesaurusSet(
	dependency: OntologyDependency,
	byTld: ReadonlyMap<string, DependencyDeclarer>,
	known: readonly string[],
	accept: (dependency: OntologyDependency) => boolean,
): boolean {
	return !known.includes(dependency.tld) && byTld.has(dependency.tld) && accept(dependency);
}

/** The declared ONTOLOGIES of one thesaurus, each one judged by thesaurusOntologyFinding. */
function addThesaurusOntologyFindings(
	declarer: DependencyDeclarer,
	installedOntologies: ReadonlySet<string>,
	findings: { warnings: string[]; errors: string[] },
): void {
	for (const dependency of declarer.dependencies ?? []) {
		if (dependency.main !== 'ontology35') continue;
		const finding = thesaurusOntologyFinding(declarer.tld, dependency, installedOntologies);
		if (finding.warning !== undefined) findings.warnings.push(finding.warning);
		if (finding.error !== undefined) findings.errors.push(finding.error);
	}
}

/** One note per thesaurus the closure added, naming who requires it and how. */
function addedNotes(
	added: readonly string[],
	dependencies: readonly HierarchyDependency[],
): string[] {
	const byTld = new Map(dependencies.map((item) => [item.tld, item]));
	return added.map((tld) => {
		const item = byTld.get(tld) as HierarchyDependency;
		const kind = item.mandatory ? 'a mandatory' : 'an optional';
		return `the thesaurus '${tld}' is ${kind} dependency of ${dependantsText(item)} — installed`;
	});
}

/**
 * Two dependency lists as ONE (per tld: mandatory wins, dependants
 * accumulate — the collector's merge), first-seen order.
 */
export function mergeHierarchyDependencyLists(
	...lists: readonly (readonly HierarchyDependency[])[]
): HierarchyDependency[] {
	const byTld = new Map<string, HierarchyDependency>();
	for (const item of lists.flat()) {
		for (const dependant of item.dependants) {
			mergeHierarchyDependency(
				byTld,
				{ tld: item.tld, main: 'hierarchy1', mandatory: item.mandatory },
				dependant,
			);
		}
	}
	return [...byTld.values()];
}

/**
 * What a POSTED thesaurus choice leaves out of the declared set — the wizard's
 * install_hierarchies step runs after the restart, without the plan, so it
 * re-derives the declared set (hierarchy_dependencies.ts) and reports here.
 * NOTHING is added and nothing refuses (owner decision 2026-10-10): the posted
 * list IS the operator's answer on every thesaurus, mandatory ones included
 * (the client pre-ticks them; unticking declines). A MANDATORY one left out →
 * a warning (recommendedThesaurusWarning: declined, or no hierarchy.json
 * entry); an optional one left out → nothing (an optional one without an
 * entry was already a plan warning at persist_config).
 */
export function unmetHierarchyDependencies(
	chosen: readonly string[],
	dependencies: readonly HierarchyDependency[],
	offered?: ReadonlySet<string>,
): { warnings: string[] } {
	const left = dependencies.filter((item) => item.mandatory && !chosen.includes(item.tld));
	if (left.length === 0) return { warnings: [] };
	const listed = offered ?? offeredHierarchyTlds();
	return {
		warnings: left.map((item) =>
			recommendedThesaurusWarning(
				item.tld,
				item.dependants,
				listed.has(item.tld) ? 'declined' : 'no_entry',
			),
		),
	};
}
