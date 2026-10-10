/**
 * Named ontology/hierarchy tipo constants — a single source of truth shared by
 * the parser, write drivers, provisioning and the tree.
 *
 * These are verbatim ports of the PHP `DEDALO_*` defines (config + core/base).
 * They are the component tipos the parser reads off a matrix_ontology record to
 * build a dd_ontology row, plus the structural tipos (relation types, the si/no
 * section, the section model) the pipeline writes. Keeping them here — not
 * inline strings scattered across modules — means a tipo change is a one-line
 * edit and every consumer stays in lockstep.
 */

import { config } from '../../config/config.ts';

// --- Ontology definition components (read off a matrix_ontology record) ---
/** ontology3 — properties.publication flag (DEDALO_ONTOLOGY_PUBLICATION_TIPO). */
export const ONTOLOGY_PUBLICATION = 'ontology3';
/** ontology4 — is_descriptor flag (DEDALO_ONTOLOGY_IS_DESCRIPTOR_TIPO). */
export const ONTOLOGY_IS_DESCRIPTOR = 'ontology4';
/** ontology5 — term (multilingual node label) (DEDALO_ONTOLOGY_TERM_TIPO). */
export const ONTOLOGY_TERM = 'ontology5';
/** ontology6 — model locator (DEDALO_ONTOLOGY_MODEL_TIPO). */
export const ONTOLOGY_MODEL = 'ontology6';
/** ontology7 — TLD (DEDALO_ONTOLOGY_TLD_TIPO). */
export const ONTOLOGY_TLD = 'ontology7';
/** ontology8 — translatable flag (DEDALO_ONTOLOGY_TRANSLATABLE_TIPO). */
export const ONTOLOGY_TRANSLATABLE = 'ontology8';
/** ontology10 — connected-to (relations) (DEDALO_ONTOLOGY_CONNECTED_TO_TIPO). */
export const ONTOLOGY_CONNECTED_TO = 'ontology10';
/** ontology42 — overwrite: a localontology0 record's link to the node it overrides. */
export const ONTOLOGY_OVERWRITE = 'ontology42';
/** ontology15 — parent locator (DEDALO_ONTOLOGY_PARENT_TIPO). */
export const ONTOLOGY_PARENT = 'ontology15';
/** ontology16 — properties.css. */
export const ONTOLOGY_CSS = 'ontology16';
/** ontology17 — properties.source (RQO / request_config). */
export const ONTOLOGY_SOURCE = 'ontology17';
/** ontology18 — properties (general JSON blob). */
export const ONTOLOGY_PROPERTIES = 'ontology18';
/** ontology19 — propiedades (v5 legacy JSON text, DEPRECATED). */
export const ONTOLOGY_PROPIEDADES_V5 = 'ontology19';
/** ontology30 — is_model flag, canonical-only (DEDALO_ONTOLOGY_IS_MODEL_TIPO). */
export const ONTOLOGY_IS_MODEL = 'ontology30';
/** ontology41 — order number (DEDALO_ONTOLOGY_ORDER_TIPO). */
export const ONTOLOGY_ORDER = 'ontology41';

// --- Ontology registry structure ---
/** ontology35 — the ontology main section (a virtual section of hierarchy1). */
export const ONTOLOGY_MAIN_SECTION = 'ontology35';
/** ontology14 — the ontology children relation tipo (ontology::$children_tipo). */
export const ONTOLOGY_CHILDREN = 'ontology14';
/** ontology40 — the ontology-typologies grouper instances node. */
export const ONTOLOGY_TYPE_GROUP = 'ontology40';
/** The grouper TLD namespace for ontology typologies. */
export const ONTOLOGY_TYPE_TLD = 'ontologytype';

// --- Hierarchy registry components (read off a hierarchy1 / matrix_hierarchy_main record) ---
/** hierarchy1 — the hierarchy main (thesaurus definitions) section. */
export const HIERARCHY_MAIN_SECTION = 'hierarchy1';
/** hierarchy4 — active flag (locator into dd64) (DEDALO_HIERARCHY_ACTIVE_TIPO). */
export const HIERARCHY_ACTIVE = 'hierarchy4';
/** hierarchy5 — name/term (DEDALO_HIERARCHY_TERM_TIPO). */
export const HIERARCHY_TERM = 'hierarchy5';
/** hierarchy6 — TLD (DEDALO_HIERARCHY_TLD2_TIPO). */
export const HIERARCHY_TLD = 'hierarchy6';
/** hierarchy8 — lang (DEDALO_HIERARCHY_LANG_TIPO). */
export const HIERARCHY_LANG = 'hierarchy8';
/** hierarchy9 — typology (locator into hierarchy13) (DEDALO_HIERARCHY_TYPOLOGY_TIPO). */
export const HIERARCHY_TYPOLOGY = 'hierarchy9';
/** hierarchy13 — the hierarchy typologies section (DEDALO_HIERARCHY_TYPES_SECTION_TIPO). */
export const HIERARCHY_TYPES_SECTION = 'hierarchy13';
/** hierarchy16 — typology name (DEDALO_HIERARCHY_TYPES_NAME_TIPO). */
export const HIERARCHY_TYPES_NAME = 'hierarchy16';
/** hierarchy45 — General Term root portal (DEDALO_HIERARCHY_CHILDREN_TIPO). */
export const HIERARCHY_GENERAL_TERM = 'hierarchy45';
/** hierarchy48 — main order number (DEDALO_HIERARCHY_ORDER_TIPO). */
export const HIERARCHY_ORDER = 'hierarchy48';
/** hierarchy53 — target section tipo `<tld>1` (DEDALO_HIERARCHY_TARGET_SECTION_TIPO). */
export const HIERARCHY_TARGET_SECTION = 'hierarchy53';
/** hierarchy54 — projects filter (DEDALO_HIERARCHY_FILTER_TIPO). */
export const HIERARCHY_FILTER = 'hierarchy54';
/** hierarchy56 — hierarchy-typologies grouper (descriptor). */
export const HIERARCHY_TYPE_GROUP = 'hierarchy56';
/** hierarchy57 — hierarchy-model-typologies grouper. */
export const HIERARCHY_MODEL_TYPE_GROUP = 'hierarchy57';
/** hierarchy58 — target section MODEL tipo `<tld>2` (DEDALO_HIERARCHY_TARGET_SECTION_MODEL_TIPO). */
export const HIERARCHY_TARGET_SECTION_MODEL = 'hierarchy58';
/** hierarchy59 — General Term Model root portal (DEDALO_HIERARCHY_CHILDREN_MODEL_TIPO). */
export const HIERARCHY_GENERAL_TERM_MODEL = 'hierarchy59';
/** hierarchy109 — source real section (schema template) (DEDALO_HIERARCHY_SOURCE_REAL_SECTION_TIPO). */
export const HIERARCHY_SOURCE_REAL_SECTION = 'hierarchy109';
/** hierarchy125 — active-in-thesaurus flag (DEDALO_HIERARCHY_ACTIVE_IN_THESAURUS_TIPO). */
export const HIERARCHY_ACTIVE_IN_THESAURUS = 'hierarchy125';
/** hierarchy61 — scope note of the registry row (component_input_text_large, `string` column). */
export const HIERARCHY_SCOPE_NOTE = 'hierarchy61';
/**
 * hierarchy60 — declared dependencies (component_json, raw `misc` key of the
 * registry row). Defined in the leaf ontology_dependencies.ts (the installer
 * closure imports it config-free); re-exported here with its siblings.
 */
export { HIERARCHY_DEPENDENCIES } from './ontology_dependencies.ts';
/** hierarchytype — grouper TLD namespace for hierarchy typologies. */
export const HIERARCHY_TYPE_TLD = 'hierarchytype';
/** hierarchymtype — grouper TLD namespace for hierarchy model typologies. */
export const HIERARCHY_MODEL_TYPE_TLD = 'hierarchymtype';

// --- Thesaurus tree area buttons / sections ---
/** hierarchy11 — hierarchy-root new button (DEDALO_HIERARCHY_BUTTON_NEW_TIPO). */
export const HIERARCHY_BUTTON_NEW = 'hierarchy11';
/** hierarchy12 — hierarchy-root delete button (DEDALO_HIERARCHY_BUTTON_DELETE_TIPO). */
export const HIERARCHY_BUTTON_DELETE = 'hierarchy12';
/** hierarchy20 — the thesaurus template section (DEDALO_THESAURUS_SECTION_TIPO). */
export const THESAURUS_SECTION = 'hierarchy20';
/** hierarchy38 — thesaurus node new button (DEDALO_THESAURUS_BUTTON_NEW_TIPO). */
export const THESAURUS_BUTTON_NEW = 'hierarchy38';
/** hierarchy39 — thesaurus node delete button (DEDALO_THESAURUS_BUTTON_DELETE_TIPO). */
export const THESAURUS_BUTTON_DELETE = 'hierarchy39';

// --- Structural constants ---
/** dd6 — the section model tipo (SECTION_MODEL). */
export const SECTION_MODEL_TIPO = 'dd6';
/**
 * dd1226 — the `diffusion` model grouper: every model under it (the diffusion
 * domain/element/table/field models, table_alias…) defines PUBLICATION
 * structure. A relation FROM a node of such a model names what is published,
 * not what the node needs to work — the reference classifier
 * (ontology_references.ts) treats it as soft (`diffusion`), never a dependency.
 */
export const DIFFUSION_MODEL_ROOT = 'dd1226';
/** dd64 — the si/no (yes/no) section (DEDALO_SECTION_SI_NO_TIPO). */
export const YES_NO_SECTION = 'dd64';
/** The si/no record ids: 1 = yes, 2 = no. */
export const SI_NO_YES = 1;
export const SI_NO_NO = 2;
/** dd47 — the parent relation type (DEDALO_RELATION_TYPE_PARENT_TIPO). */
export const RELATION_TYPE_PARENT = 'dd47';
/** dd48 — the children relation type (DEDALO_RELATION_TYPE_CHILDREN_TIPO). */
export const RELATION_TYPE_CHILDREN = 'dd48';
/** dd151 — the link relation type (DEDALO_RELATION_TYPE_LINK). */
export const RELATION_TYPE_LINK = 'dd151';
/** dd96 — the index relation type (DEDALO_RELATION_TYPE_INDEX_TIPO). */
export const RELATION_TYPE_INDEX = 'dd96';
/** dd153 — the projects section (DEDALO_SECTION_PROJECTS_TIPO). */
export const PROJECTS_SECTION = 'dd153';
/** dd128 — the users section (DEDALO_SECTION_USERS_TIPO). */
export const USERS_SECTION = 'dd128';
/** The ontology STRUCTURE language (model terms are read strictly in this lang;
 * config DEDALO_STRUCTURE_LANG — only lg-spa is accepted upstream). */
export const STRUCTURE_LANG = config.lang.structureLang;
/** lg-nolan — the no-language marker (nolan values). */
export const DATA_NOLAN = 'lg-nolan';
