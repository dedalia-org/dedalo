# Settings reference

> See also: [How configuration works](administration.md) · [What changed in v7](whats_changed_v7.md) · [Migrating from v6](../install/migrating_from_v6.md)

Every setting Dédalo v7 reads, what it means, and its default.

You set these in **`../private/.env`** — one `KEY=value` per line, outside the web
root, with nothing to edit inside the served tree. After changing a value,
**restart the server**.

```bash
# ../private/.env
ENTITY=my_museum
DEDALO_TIMEZONE=Europe/Madrid
ACTIVE_ONTOLOGY_TLDS=["dd","rsc","ontology","ontologytype","hierarchy","lg","oh"]
```

Lists and maps are **JSON** (simple lists also accept a comma list); booleans are
`true`/`false`; a key you leave out takes the default shown here — except the
**required** keys (the database, the entity and the four language keys), which have
no usable default: the installer writes them, and a configured server refuses to
boot without them. `install/sample.env` in the code tree carries the same catalogue
in copy-paste form; `../private/sample.env` is the copy the installer took, so it
lacks every key added since your install.

!!! note "Coming from v6?"
    The settings below are the v7 names. Several were renamed, a few changed shape,
    and many v6 constants no longer exist at all (paths the engine now derives, the
    old session mechanism, the logger…). [What changed in v7](whats_changed_v7.md) is
    the complete map, and `bun run dedalo:migrate-config` converts an old config for you.

<!-- BEGIN GENERATED — src/config/catalog/ · regenerate: bun run config:gen -->

## **Main variables:** Paths {#paths}

### Defining host

DEDALO_HOST `string`

The public domain or IP of this installation — the address **other machines** use to
reach it. Dédalo does not need it to serve you; it needs it to tell someone else where it
lives.

It matters when this install publishes to others: the ontology and code update manifests it
serves, and the "Local files" server entry in the update panel, are all built from
`<DEDALO_PROTOCOL><DEDALO_HOST>`. Leave it unset and that address falls back to
`localhost`, which is correct **only** when the client is on this same machine — a
developer box. A remote installation told to fetch from `localhost` will fetch from
itself. So: if this install serves ontology or code to any other machine, set it.

Where Dédalo merely reports its own hostname (the ontology manifest's `host` field), an
unset value is reported honestly as empty rather than as a false `localhost`.

```bash
DEDALO_HOST="dedalo.example.org"
```

*Default: (empty)*

---

### Defining protocol

DEDALO_PROTOCOL `string`

This parameter defines the internet protocol used to build absolute URLs. It is
recommended to use the HTTPS protocol for an installation with SSL certification —
it is not mandatory, but it ensures the connection is protected with encryption.
Defaults to `"http://"` when unset.

```bash
DEDALO_PROTOCOL="https://"
```

*Default: http://*

---

## Locale {#locale}

### Defining date order

DEDALO_DATE_ORDER `string`

Defines the default order for the date input by users and to be showed in component_date. By default Dédalo use dmy (European dates format).

Options:

* dmy : common way order day/moth/year
* mdy : USA way order moth/day/year
* ymd : China, Japan, Korean, Iran way year/month/day

```bash
DEDALO_DATE_ORDER="dmy"
```

*Default: dmy*

---

### Defining locale encoding

DEDALO_LOCALE `string`

Defines the UI locale used to format and encode text. By default Dédalo uses UTF-8
encoding for Spanish (`es-ES`).

```bash
DEDALO_LOCALE="es-ES"
```

*Default: es-ES*

---

### Defining time zone

DEDALO_TIMEZONE `string`

Used to defines the time zone of the project. It could be different of the server installation or the linux timezone. The time zone will be used to store the time stamp of the changes done by the users.

```bash
DEDALO_TIMEZONE="Europe/Madrid"
```

*Default: Europe/Madrid*

---

## Entity {#entity}

### Entity id

DEDALO_ENTITY_ID `int`

This parameter defines the normalized id for the entity. The id of the entity could be used to create a locator to obtain information between Dédalo installations, the id will be added to the locator with the key: "entity_id" when the locator point to external resource.

```bash
DEDALO_ENTITY_ID=0
```

*Default: 0*

---

### Defining entity label

DEDALO_ENTITY_LABEL `string`

Defines the entity label, the real name of the entity. Due the entity definition is use to encrypt passwords or access to databases, sometimes you will need define the real name of the entity with characters such as 'ñ' or accents.

```bash
DEDALO_ENTITY_LABEL="Museu de Prehistòria de València"
```

> When unset, `DEDALO_ENTITY_LABEL` defaults to the value of `ENTITY`.

*Default: the value of `ENTITY`*

---

### Defining entity

ENTITY `string`

This parameter defines the name of the entity proprietary of the Dédalo installation. Dédalo entity will be used to access to databases, to encrypt passwords or to publish data into the specific publication ontology and should NOT be changed after installation.

```bash
ENTITY="my_entity_name"
```

> Use secure characters to define the entity, without spaces, accents or other special characters that could create conflicts with other server parts, such as database connection. If you want define the full name of the entity, use DEDALO_ENTITY_LABEL definition.

*Default: install*

---

## Languages {#langs}

### Defining application language

APPLICATION_LANG `string`

This parameter defines the language will us Dédalo for the user interface.

This is a dynamic parameter and it can be changed when the user login, or in application menu. When the language is changed it is saved into the user's session and it is read to maintain coherence in the diary workflow. If the user's session does not have defined the application language then Dédalo will use the application default language definition.

```bash
APPLICATION_LANG="lg-spa"
```

> You can set this as a fixed value, but it is recommended you do not — to change the
> default interface language, use `DEDALO_APPLICATION_LANGS_DEFAULT` instead.

*Default: lg-spa*

---

### Defining data language

DATA_LANG `string`

It defines the data language used by Dédalo to process and render textual information.

This is a dynamic parameter that can be changed by the user in any moment. Dédalo is a real multi-language application, it can manage information in multiple languages and process it as unique information block (the field store any translated version of his data). The user can translate any information directly or using specific tools. This parameter define the current language used.

```bash
DATA_LANG="lg-spa"
```

> You can set this as a fixed value, but it is recommended you do not — to change the
> default data language, use [DEDALO_DATA_LANG_DEFAULT](#defining-default-data-language)
> instead.

*Default: lg-spa*

---

### Defining data language sync

DATA_LANG_SYNC `bool`

Defines whether the application language and data language selection remain synchronized.

When set to ' true', it forces to keep DEDALO_APPLICATION_LANG and DEDALO_DATA_LANG synchronized across changes.
The default value is 'false', which allows the application language and data language to be selected independently.

```bash
DATA_LANG_SYNC=false
```

*Default: false*

---

### Defining data without language (no lang)

DATA_NOLAN `string`

This parameter defines the tld used by Dédalo to tag data without translation possibility.

Dédalo is multi language by default, all information could be translated to other languages that the main lang, but some data is not susceptible to be translated, like numbers, dates or personal names. In these cases Dédalo defines this kind of data as "not translatable" with the specific tld define in this parameter.

By default and for global Dédalo definition for non translatable data this tld is: `lg-nolan`

```bash
DATA_NOLAN="lg-nolan"
```

*Default: lg-nolan*

---

### Defining application languages

DEDALO_APPLICATION_LANGS `object` (a JSON map of `lg-*` code → label)

This parameter defines the languages that Dédalo will use for the data and user interface. Dédalo is a true multi-language application, any text field can be defined as translatable and this configuration define the languages that the installation will use to store and translate text data. When the user select one of those languages Dédalo will change the data showed or the user interface, so it will render all data with this new language.

**Required** — the server refuses to boot without a non-empty value. The installer writes it from the working languages picked (`lg-eng` and `lg-spa` by default).

```bash
DEDALO_APPLICATION_LANGS={"lg-spa":"Castellano","lg-cat":"Català","lg-eus":"Euskara","lg-eng":"English","lg-fra":"French"}
```

> See the Dédalo structure lang for see the languages definitions.

*Default: **required, no default** — the installer writes it (working languages: default `lg-eng`, `lg-spa`; interface and data default: the first one picked); the value shown in sample.env is the install-mode stand-in, never a fallback*

---

### Defining default application language

DEDALO_APPLICATION_LANGS_DEFAULT `string`

Defines the main language will used in the user interface.

**Required** — the server refuses to boot without it. The installer writes it (default: the first working language picked, `lg-eng` by default).

Dédalo can be translated to any language, the translations of the interface are done in the ontology. The users can change the Dédalo interface to use it in his language. In Dédalo the user interface and the data language are separated concepts and it is possible have a interface in one language and the data in other. This main language will be used as primary option and as fall back language when the element does not have the translation available.

```bash
DEDALO_APPLICATION_LANGS_DEFAULT="lg-eng"
```

> See the Dédalo structure lang for see the languages definitions.

*Default: **required, no default** — the installer writes it (working languages: default `lg-eng`, `lg-spa`; interface and data default: the first one picked); the value shown in sample.env is the install-mode stand-in, never a fallback*

---

### Defining default data language

DEDALO_DATA_LANG_DEFAULT `string`

Defines the main language will used by Dédalo to manage and process data.

**Required** — the server refuses to boot without it. The installer writes it (default: the first working language picked, `lg-eng` by default).

The main language is the mandatory language for the text data in the catalog or inventory. Dédalo is a real multi-language application, it can manage multiple translation of the textual information.

In a multi-language situation, when you require some translated information but it is not present (because it is not done), Dédalo will need to use the main language to do a fall back process to main language to show the data. If the main language data is not present, Dédalo will use any other language to show those data.

```bash
DEDALO_DATA_LANG_DEFAULT="lg-spa"
```

*Default: **required, no default** — the installer writes it (working languages: default `lg-eng`, `lg-spa`; interface and data default: the first one picked); the value shown in sample.env is the install-mode stand-in, never a fallback*

---

### Declaring language equivalences

DEDALO_LANG_EQUIVALENCES `json`

Groups of language codes that are the same language under different names. The shipped
default declares Català and Valencià as one language, matching how earlier Dédalo versions
treated them.

The FIRST code of each group is the canonical *translation source*: ontology terms and
interface labels are authored there, and the other members read those translations (a
Valencian interface shows the Catalan term rather than an arbitrary language). For record
DATA the members are mutual preferred fallbacks in both directions: a user browsing in
Catalan sees a transcript that exists only in Valencian, and vice versa, before the
install-default fallback applies.

Add groups for other equivalences your collection needs; an empty array `[]` turns the
mechanism off entirely.

```bash
DEDALO_LANG_EQUIVALENCES='[["lg-cat","lg-vlca"]]'
```

*Default: [["lg-cat","lg-vlca"]]*

---

### Defining data language selector

DEDALO_DATA_LANG_SELECTOR `bool`

It defines if the menu show or hide the data language selector.

When the selector is showed the user can change the data language independently of the interface language. If the selector is hide the data language is synchronous to the interface language a change in the interface language will be a change in the data language.

```bash
DEDALO_DATA_LANG_SELECTOR=true
```

*Default: true*

---

### Defining diffusion languages

DEDALO_DIFFUSION_LANGS `array`

This parameter defines the languages that Dédalo will use to publish data.

It controls the amount of languages processed when data is published. Publishing builds one fixed rendition per language, falling back to the main languages' correspondences where a field has no value in the language being processed; this parameter narrows the set of languages that work is done for, so an installation can publish fewer languages than it edits in.

Unset (or empty) it DERIVES from the project languages: the value of DEDALO_PROJECTS_DEFAULT_LANGS is used verbatim, order included. Set it only to separate the published languages from the editing ones.

Accepted encodings: a JSON array or a plain comma-separated list — both parse to the same set. ORDER IS LOAD-BEARING: the first entry is the main publication language.

Every entry must be a `lg-xxx` code (the `all` sentinel is NOT a language and is refused here) and must be ONE OF the project languages: a language the installation does not edit in has no data to publish. An entry that fails either rule is reported at boot and REFUSES the publication plan — a wrong lang list silently publishes empty renditions, which is worse than not publishing.

```bash
DEDALO_DIFFUSION_LANGS=["lg-spa","lg-cat","lg-eng"]
```

>The parameter use the Dédalo tld definition for languages. See DEDALO_APPLICATION_LANGS definition to show some examples.

*Default: the project languages (DEDALO_PROJECTS_DEFAULT_LANGS)*

---

### Defining structure lang

DEDALO_STRUCTURE_LANG `string`

This parameter defines the default language that the ontology will use as main language. The ontology (abstracted structure) is the definition of areas, sections, fields, connections between data and definition models. All terms used in the ontology can be translated to any language, but this main language defined here will be use as mandatory language, if Dédalo is configured in other language that is not defined in the ontology translations Dédalo will do a fall back to this main language, if these main language is not present, Dédalo will use any other language to show the interface and explanations.

This parameter do not define the main data language, it only affect to the Dédalo interface and definitions in the ontology.

```bash
DEDALO_STRUCTURE_LANG="lg-spa"
```

>For the languages, Dédalo uses the pattern: `lg-xxx`
>lg : identify the term as language
>xxx : the ISO 639-2/T alpha-3 code of the language (e.g. spa, eng, cat). For language variants is used, ISO 639-6 (Alpha-4) code for comprehensive coverage of language variants.
>
>Some common languages:
>
>| Value | Diffusion language |
>| --- | --- |
>| lg-spa | Spanish |
>| lg-cat | Catalan |
>| lg-eus | Basque |
>| lg-eng | English |
>| lg-fra | French |
>| lg-ita | Italian |
>| lg-por | Portuguese |
>| lg-deu | German |
>| lg-ara | Arabian |
>| lg-ell | Greek |
>| lg-rus | Russian |
>| lg-ces | Czech |
>| lg-jpn | Japanese |

*Default: lg-spa*

---

### Defining default projects languages

PROJECTS_DEFAULT_LANGS `array`

This parameter defines the languages that will use for export and publish data.

**Required** — the server refuses to boot without it. The installer writes it, in its legacy spelling `DEDALO_PROJECTS_DEFAULT_LANGS`, from the working languages picked (`lg-eng`, `lg-spa` by default).

This definition control the amount of languages that will be processed to export data or publish data in the publication process.

When Dédalo export data or publish data, it check the languages of every field of every record to create a fixed version of the data with the language processed or his own correspondences of the main languages when the data is not available in the current language. This parameter reduce the amount languages used in those processes.

```bash
PROJECTS_DEFAULT_LANGS=[ "lg-spa", "lg-cat", "lg-eng"]
```

> The parameter use the Dédalo tld definition for languages. See DEDALO_APPLICATION_LANGS definition to show some examples.

*Default: **required, no default** — the installer writes it (working languages: default `lg-eng`, `lg-spa`; interface and data default: the first one picked); the value shown in sample.env is the install-mode stand-in, never a fallback*

---

## Default variables {#defaults}

### Defining active ontology TLDs

ACTIVE_ONTOLOGY_TLDS `array`

!!! info "Renamed in v7 — was `DEDALO_PREFIX_TIPOS`"
    The old name did not describe the value: this is the set of ontology
    **top-level domains** active in the installation. The old spelling is retired —
    if it is still in your `.env` the server refuses to boot and names the line to
    change.

This parameter defines the ontology TLDs to be used in the Dédalo installation.

Every tipo (typology of indirect programming object) defines a heritage field, a data model, a structuring tools and definitions. Dédalo is a multi heritage application with ontologies for Archeology, Ethnology, Oral History, Numismatics, etc. Every project or institution can add any tipos that it demands. An archaeologic museum will use the model for archeological catalogs, but it will not need the ethnological definitions. In the same way that Oral History project will don't use the archeological or numismatic definitions.

Every installation carries the **core** ontologies — they ship in the install database itself:

| **TLD** | **Definition** |
| --- | --- |
| **dd** | Dédalo. Definition of default list and common uses and tools such as translation tools. |
| **rsc** | Resources. Definition for areas and sections commons to all projects such as people, images, audiovisual files, publications, documents, bibliography, etc. |
| **ontology** | Ontology. Definition of the sections used as nodes of the ontology |
| **ontologytype** | Ontology typologies. The typologies the ontology registry groups the ontologies by. |
| **hierarchy** | Thesaurus. Definition for sections as toponymy, onomastic, chronologies, techniques, material, etc. |
| **lg** | Languages, Definition for the languages in the thesaurus (used for all application to translate data and interface) |

Besides, every installation chooses the **domain** ontologies it uses in its inventory or research — at install time (the installer installs at least one; `oh` is the default) or later, from the ontology update panel:

| **TLD** | **Definition** |
| --- | --- |
| **oh** | Oral History, the definition sections and tools to be used for oral history projects such as interviews, transcription, indexation, etc. |
| **ich** | Intangible Cultural Heritage, the definition sections and tools to use for intangible heritage, such as elements, processes, communities, symbolic acts, etc. |
| **tch** | Tangible heritage, the definition of sections and tools to use for tangible heritage, such as objects, collectors, informants, etc |
| **tchi** | Tangible heritage immovable, the definition of sections and tools to use for tangible heritage immovable, such as archeological sites, finds, alqueries, etc |
| **dmm** | Memory and documentary heritage, the definition of sections and tools to be used for the heritage of memory, such as graves, deportees, exiles, tortured, etc. |
| **numisdata** | Numismatic heritage, the definition sections and tools to use for numismatics project, such as mints, types, legends, hoards, finds, etc. |
| **isad** | Archives following the [ISAD(g) standard](https://www.ica.org/en/isadg-general-international-standard-archival-description-second-edition) (General International Standard Archival Description - Second edition), the definition of sections and tools to be used for cataloging documents with the standard structure, etc. |
| **actv** | Activities, the definition of section and fields of activities as exhibitions, workshops, didactics, conferences, etc. |
| **utoponymy** | Unofficial toponymy. Section definition for unofficial toponymy (unofficial places names), used to add places that are not inside the official toponymy of countries or the installation don't want import the official toponymy (use to point the place without the official term in some sections as Publications, to define any place of publication around the world) |
| **nexus** | Nexus, a standalone module with its own sections. |

The installer WRITES this key on every install: the core, then the chosen domain ontologies together with the ontologies they declare as dependencies (an optional one you declined is left out), in install order (each dependency before the ontology that needs it). An EXAMPLE for an oral-history + intangible-heritage installation — not the default:

```bash
ACTIVE_ONTOLOGY_TLDS=[ "dd", "rsc", "ontology", "ontologytype", "hierarchy", "lg", "oh", "ich" ]
```

!!! info "When the key is unset"
    The engine does NOT fall back to an empty list: it uses the core set
    `dd, rsc, ontology, ontologytype, hierarchy, lg`, and the update
    panel says so — it labels the reference list *Engine fallback (not configured)*
    instead of *Configured in this installation*. Domain TLDs (`oh`, `ich`, `tch`,
    `numisdata`, `utoponymy`, `nexus`, …) are never in that fallback: they are
    per-installation, so set the key to add them. An installation that relied on the
    old fallback for `utoponymy` or `nexus` adds them to the key.

!!! note "Dependencies"
    An ontology may need nodes of other ontologies (`tch` uses models and terms of `crm`, `tchi`, …). Those dependencies are DECLARED by the ontology server (its manifest lists them per TLD) and the installer installs them together with the chosen ontology. Thesaurus *hierarchies* are different: a `tch` installation still activates the `material`, `technique` or `objects` hierarchies itself, because hierarchies are created by the users. [See the table of dependencies](thesaurus_dependencies.md#dependencies).

!!! note "Applying changes in ACTIVE_ONTOLOGY_TLDS"
    Any change in `ACTIVE_ONTOLOGY_TLDS` will need a update of the ontology, this changes are not directly applied. Dédalo needs to get the ontology tld and install it, to do that update the ontology in [maintenance](../management/maintenance_status.md) control panel.

!!! note "Activities"
    The `actv` tld should be used as model to implement a virtual sections with more specific activities as hierarchies of toponymy does into the thesaurus using it as `hierarchy20`, the main section to implement in this way is `actv1` and his model `actv2`. The virtual sections should be defined with a prefix `actv` into the new tld, in this way:
    - for exhibitions section the tld could be: `actvexhibition`
    - for conferences section the tld could be: `actvconference`

*Default: ["dd","rsc","ontology","ontologytype","hierarchy","lg"]*

---

### Defining default project

DEDALO_DEFAULT_PROJECT `int`

This parameter defines the default project that Dédalo will use to create new sections (records in the DDBB).

Dédalo use the project component (component_filter) to group sections by the research criteria. The project field is mandatory in every section, because an user that can access to a project will no see the records of the other projects and, therefore, is necessary that all sections can be searchable by projects. If the user forget introduce project data, Dédalo will use this parameter to introduce it.

```bash
DEDALO_DEFAULT_PROJECT=1
```

*Default: 1*

---

### Defining filter section tipo default

DEDALO_FILTER_SECTION_TIPO_DEFAULT `string`

This parameter defines the section that has the projects information inside the ontology.

Dédalo will use this parameter to define the locator of the filter by projects to apply to any search of sections. By default Dédalo has a predefined section to store the projects that administrators users can enlarge. The default section_tipo is `dd153` and it is located below 'Administration' area in the menu. Every project field target this section to define the specific project of the current record.

```bash
DEDALO_FILTER_SECTION_TIPO_DEFAULT="dd153"
```

> Defaults to `dd153` (the Projects section). Do not change this param.

*Default: dd153*

---

### Defining maximum rows per page

DEDALO_MAX_ROWS_PER_PAGE `int`

It defines the maximum rows that will loaded in the lists.

This value is the default number of rows that Dédalo will load, but is possible to change this value directly in the filter by the users, when they make a search, if the user do not define the maximum rows, Dédalo will use the value of this parameter.

```bash
DEDALO_MAX_ROWS_PER_PAGE=10
```

*Default: 10*

---

### Defining the maximum rows a search may return

DEDALO_SEARCH_CLIENT_MAX_LIMIT `int`

This parameter defines the ceiling applied to the number of rows a search coming FROM THE CLIENT may ask for.

It is not the page size the user sees (that is DEDALO_MAX_ROWS_PER_PAGE): it is the hard limit above which a request from the browser cannot go, whatever it asks for. A request for "all" rows, for a negative number, or for more rows than this ceiling, all come back clamped to the ceiling — so no client can ask the server for an unbounded result set. Searches the server itself builds (exports, publications, counts) are not clamped and keep full access to the whole result.

The default is 1000. Raise it if your own interface legitimately pages in bigger windows; lower it to harden an installation exposed to the public. A value below 1 is raised to 1.

```bash
DEDALO_SEARCH_CLIENT_MAX_LIMIT=1000
```

*Default: 1000*

---

### Defining the users section tipo

DEDALO_SECTION_USERS_TIPO `string`

This parameter defines the section of the ontology that holds the USER records — the login names, the password hashes, the profile and the projects each user may reach.

Dédalo needs to know which section that is, because the section is treated differently everywhere it appears: the root user is never returned by a search, not even to an administrator, and the raw view of a record refuses to open it, so a password hash cannot be read through the interface.

The default is `dd128` and an installation should keep it. It is a parameter rather than a fixed value only so that an installation whose ontology places the users section elsewhere keeps those protections instead of quietly losing them.

```bash
DEDALO_SECTION_USERS_TIPO="dd128"
```

*Default: dd128*

---

### Defining main fallback section

MAIN_SECTION `string`

It defines the section that is loaded by default when the user logs in.
The main section of the project, normally an inventory or catalog section.

It is EMPTY by default, because there is no section every installation has: the
default used to name one installation's own section, which meant every other
installation landed its users on a tipo that need not exist. Left empty, a login
with no deep link opens the menu — a real state, not a misconfiguration. Set it
to the section your users should land on.

```bash
MAIN_SECTION="oh1"
```

*Default: (empty)*

---

## Media variables {#media}

### 3D

DEDALO_3D_ALTERNATIVE_EXTENSIONS `array` *optional*

**This engine builds no alternative versions of 3d files, so this parameter has no effect.** Keep it empty.

The reason is structural, not a missing option: the web version of a 3d file is a plain copy of the uploaded model, and no mesh converter is called anywhere in the engine, so there is nothing here that could write a second format.

A value set here is not silently obeyed and not silently ignored either: the formats are refused at start-up, and the server log names this parameter, its value and this reason. Nothing is scanned for, indexed or offered in the versions panel for a file that cannot be produced.

Dédalo stores the uploaded file and the web version, and nothing else.

```bash
DEDALO_3D_ALTERNATIVE_EXTENSIONS=[]
```

*Default: []*

---

### 3D

DEDALO_3D_AR_QUALITY `array`

This parameter defines the different qualities that can be used for store 3d files.

This parameter will use to store files to specific quality.

```bash
DEDALO_3D_AR_QUALITY=["original","web"]
```

*Default: ["original","web"]*

---

### 3D

DEDALO_3D_EXTENSION `string`

This parameter defines the standard file type of 3d files.

By default Dédalo use glb standard definition for the 3d files. All other formats will be exported to this standard.

```bash
DEDALO_3D_EXTENSION="glb"
```

*Default: glb*

---

### 3D

DEDALO_3D_EXTENSIONS_SUPPORTED `array`

This parameter defines the standards file type admitted for the 3d files.

Dédalo will use this parameter to identify the file format of the original files uploaded by the users before transform it to the standard defined in the DEDALO_3D_EXTENSION parameter.

```bash
DEDALO_3D_EXTENSIONS_SUPPORTED=["glb"]
```

> Note: in current version only glb files are available, in future versions other format files will be supported: as 'gltf', 'obj', 'fbx', 'dae', 'zip'

*Default: ["glb","gltf","obj","fbx","dae","zip"]*

---

### 3D

DEDALO_3D_FOLDER `string`

This parameter define the main directory for the 3d files.

```bash
DEDALO_3D_FOLDER="/3d"
```

*Default: /3d*

---

### 3D

DEDALO_3D_QUALITY_DEFAULT `string`

This parameter defines the default quality used for the 3d files.

This parameter will use to transform all 3d files to specific format, unifying the quality used by all sections. By default Dédalo use glb format for web quality.

```bash
DEDALO_3D_QUALITY_DEFAULT="web"
```

*Default: web*

---

### 3D

DEDALO_3D_QUALITY_ORIGINAL `string`

This parameter defines the quality original for the 3d files.

This parameter will use to identify the uploaded files to with specific quality. Dédalo admit lots of different formats from different sources and qualities, and it define this files as "original" quality. Dédalo will transform all supported formats to web standard format, unify all different qualities and codecs, and will store the original file without touch. In some cases, if the institution has a protocol for manage image files, is possible to use one specific quality for the files that users can upload. By default Dédalo do not limit the original format to be uploaded using a "original" quality denomination.

```bash
DEDALO_3D_QUALITY_ORIGINAL="original"
```

*Default: original*

---

### Audiovisual

DEDALO_AV_ALTERNATIVE_EXTENSIONS `array` *optional*

**This engine builds no alternative versions of audiovisual files, so this parameter has no effect.** Keep it empty.

The reason is structural, not a missing option: every compression profile Dédalo ships forces the same container and the same video codec (mp4 / h264), and a profile is chosen by a name that carries only the resolution, the television standard and the aspect ratio. There is no container axis to build a second format on, and there is no second encoder to point at one.

A value set here is not silently obeyed and not silently ignored either: the formats are refused at start-up, and the server log names this parameter, its value and this reason. Nothing is scanned for, indexed or offered in the versions panel for a file that cannot be produced.

Dédalo keeps the uploaded file untouched and compresses only to the standard encapsulation defined in DEDALO_AV_EXTENSION.

```bash
DEDALO_AV_ALTERNATIVE_EXTENSIONS=[]
```

*Default: []*

---

### Audiovisual

DEDALO_AV_AR_QUALITY `array`

This parameter defines the different qualities that can be used for compress the audiovisual files.

This parameter will use to compress audiovisual files to specific quality. The compression will use the original file and will compress to those qualities when the user demand a specific quality.

```bash
DEDALO_AV_AR_QUALITY=["original","1080","720","576","404","240","audio"]
```

*Default: ["original","1080","720","576","404","240","audio"]*

---

### Audiovisual

DEDALO_AV_EXTENSION `string`

This parameter defines the standard file type of encapsulation for the audiovisual files.

By default Dédalo use mp4 encapsulation definition for the audiovisual files with codec h264 or h265. All other formats will be compressed to this parameters.

```bash
DEDALO_AV_EXTENSION="mp4"
```

*Default: mp4*

---

### Audiovisual

DEDALO_AV_EXTENSIONS_SUPPORTED `array`

This parameter defines the standards file type admitted for the audiovisual files.

Dédalo will use this parameter to identify the file format of the original files uploaded by the users before compress it to the standard defined in the DEDALO_AV_EXTENSION parameter.

```bash
DEDALO_AV_EXTENSIONS_SUPPORTED=["mp4","wave","wav","aiff","aif","mp3","mov","avi","mpg","mpeg","vob","zip","flv"]
```

*Default: ["mp4","wave","wav","aiff","aif","mp3","mov","avi","mpg","mpeg","vob","zip","flv"]*

---

### Audiovisual

DEDALO_AV_FASTSTART_PATH `string`

This parameter defines the path to the qt-faststart library in the server.

qt-faststart is used to move the av header from last bytes of the av file to the start of the av file, this change improve the load of the av because the header is at the beginning of the file and it can read first when loads begin.

```bash
DEDALO_AV_FASTSTART_PATH="/usr/bin/qt-faststart"
```

*Default: `<DEDALO_BINARY_BASE>/qt-faststart`*

---

### Audiovisual

DEDALO_AV_FFMPEG_PATH `string`

This parameter defines the path to the ffmpeg library in the server. ffmpeg will use to compress the audiovisual files.

```bash
DEDALO_AV_FFMPEG_PATH="/usr/bin/ffmpeg"
```

*Default: `<DEDALO_BINARY_BASE>/ffmpeg`*

---

### Audiovisual

DEDALO_AV_FFPROBE_PATH `string`

This parameter defines the path to the ffprobe library in the server. ffprobe is used to analyze the audiovisual files and get his metadata.

```bash
DEDALO_AV_FFPROBE_PATH="/usr/bin/ffprobe"
```

*Default: `<DEDALO_BINARY_BASE>/ffprobe`*

---

### Audiovisual

DEDALO_AV_FOLDER `string`

This parameter defines the main directory for the audiovisual files.

```bash
DEDALO_AV_FOLDER="/av"
```

*Default: /av*

---

### Audiovisual

DEDALO_AV_POSTERFRAME_EXTENSION `string`

This parameter defines the type of the image file used to create the posterframe of the audiovisual files.

The posterframe is the image that will show before load the audiovisual files and identify it. This parameter define the type of this image. By default Dédalo use jpg standard to create the posterframe.

```bash
DEDALO_AV_POSTERFRAME_EXTENSION="jpg"
```

*Default: jpg*

---

### Audiovisual

DEDALO_AV_QUALITY_DEFAULT `string`

This parameter defines the default quality used for the audiovisual files.

This parameter will use to compress all audiovisual files to specific quality, unifying the quality used by all sections. By default Dédalo use 720x404 h264 quality.

```bash
DEDALO_AV_QUALITY_DEFAULT="404"
```

*Default: 404*

---

### Audiovisual

DEDALO_AV_QUALITY_ORIGINAL `string`

This parameter defines the quality original for the audiovisual files.

This parameter will use to identify the uploaded files to with specific quality. Dédalo admit lots of different formats from different sources and qualities, and it define this files as "original" quality. Dédalo will compress all formats to web standard format, unify all different qualities and codecs, and will store the original file without touch. In some cases, if the institution has a protocol for manage av files, is possible to use one specific quality for the files that users can upload. By default Dédalo do not limit the original format to be uploaded using a "original" quality denomination.

```bash
DEDALO_AV_QUALITY_ORIGINAL="original"
```

*Default: original*

---

### Audiovisual

DEDALO_AV_SUBTITLES_EXTENSION `string`

This parameter defines the standard used to create the subtitles.

By default Dédalo use VTT format to create the subtitles.

```bash
DEDALO_AV_SUBTITLES_EXTENSION="vtt"
```

*Default: vtt*

---

### External binaries

DEDALO_BINARY_BASE `string`

This parameter defines the directory where the external media binaries are installed.

All media processing is done by external programs — ImageMagick, ffmpeg, ffprobe, qt-faststart, pdfinfo, pdftotext, pdftohtml, ocrmypdf — and Dédalo does not search the `PATH` for them: every binary key derives its default from this directory (`DEDALO_AV_FFMPEG_PATH` = `<DEDALO_BINARY_BASE>/ffmpeg`, and so on). Set this one key and the whole family follows; set an individual key only when that single binary lives somewhere else.

By default Dédalo uses `/usr/bin` (the location the system packages install to) and `/opt/homebrew/bin` on macOS. A source build or a local install (`/usr/local/bin`) is the usual reason to change it.

```bash
DEDALO_BINARY_BASE="/usr/local/bin"
```

*Default: `/opt/homebrew/bin` on macOS, `/usr/bin` elsewhere*

---

### External binaries

DEDALO_FILE_BIN_PATH `string`

This parameter defines the path to the `file` utility in the server, the program that reports the type of a file from its content.

The path is derived from DEDALO_BINARY_BASE and is resolved together with the rest of the external binaries when the server boots, so on a standard install there is nothing to set. Point it at an explicit location only when the utility is not installed alongside the other binaries.

Note that Dédalo does not depend on it to accept an upload: the upload endpoint validates every file by reading its signature bytes with its own detector and refuses anything whose content does not match the declared extension, so an install without this utility still uploads and processes media normally.

```bash
DEDALO_FILE_BIN_PATH="/usr/bin/file"
```

*Default: `<DEDALO_BINARY_BASE>/file`*

---

### Georeferencing variables

DEDALO_GEO_DEFAULT_LAT `float`

Latitude the geolocation map OPENS on when the record has no coordinate stored.

This is a camera position, never data: it is only where the map is looking before the user
places anything, and it is never saved into the record. A record without coordinates stays
without coordinates, and nothing is published for it.

The default (latitude 20, longitude 0, zoom 2) is a world view, chosen precisely because it
cannot be mistaken for a real location. An institution whose records cluster in one region
should set the three DEDALO_GEO_DEFAULT_* keys to that region so cataloguers do not have to
pan the map on every new record.

```bash
DEDALO_GEO_DEFAULT_LAT="20"
```

*Default: 20*

---

### Georeferencing variables

DEDALO_GEO_DEFAULT_LON `float`

Longitude the geolocation map OPENS on when the record has no coordinate stored.

The companion of DEDALO_GEO_DEFAULT_LAT: together with DEDALO_GEO_DEFAULT_ZOOM they define the
opening camera of the map widget. It is a view, not a value — opening a record and saving it
stores no coordinate.

Change it, with the other two keys, when the collection is regional and the world view wastes
the cataloguer's time.

```bash
DEDALO_GEO_DEFAULT_LON="0"
```

*Default: 0*

---

### Georeferencing variables

DEDALO_GEO_DEFAULT_ZOOM `int`

Zoom level the geolocation map OPENS on when the record has no coordinate stored.

Leaflet zoom scale: 2 is the whole world, ~6 a country, ~12 a city, ~18 a street. The default 2
matches the world-view default of DEDALO_GEO_DEFAULT_LAT / DEDALO_GEO_DEFAULT_LON.

Raise it together with the two coordinate keys when every record of the install belongs to the
same region, so the map opens already framed on it.

```bash
DEDALO_GEO_DEFAULT_ZOOM="2"
```

*Default: 2*

---

### Georeferencing variables

DEDALO_GEO_PROVIDER `string`

This parameter defines the tile maps provider to be used.

The param can be change the provider to specific configurations, for ex, if you want to use the ancient roman map and the actual OSM map you can use the "NUMISDATA" provider that include both maps. values supported: OSM | ARCGIS | GOOGLE | VARIOUS | ARCGIS | NUMISDATA

```bash
DEDALO_GEO_PROVIDER="VARIOUS"
```

*Default: VARIOUS*

---

### Generated and exported files

DEDALO_HTML_FILES_FOLDER `string`

This parameter names the directory, inside the media directory, that holds self-contained HTML copies generated from records — the single files an institution hands to a visitor or publishes beside a catalogue.

The directory is created and verified when the server starts, along with the rest of the media directories, so it always carries the same owner and permissions as the rest of the tree instead of being minted by whichever process happens to write there first. Nothing in this engine writes into it yet; it is provisioned so that an install keeps the shape it has always had and so no future subsystem has to create it on the fly.

Change the value only to match a directory an install already carries. It names the folder Dédalo provisions — it does not move files that are already sitting in the old one, and it is a single folder name (a leading slash is optional and removed), never a path: the media directory is the only place this can live.

```bash
DEDALO_HTML_FILES_FOLDER="/html_files"
```

*Default: /html_files*

---

### Image

DEDALO_IDENTIFY_PATH `string`

This parameter defines the path to the ImageMagick `identify` program in the server. Dédalo uses it to read the attributes of an image file — dimensions, format, colorspace, orientation, transparency — before deciding how to compress it.

The path is derived from DEDALO_BINARY_BASE, so a normal ImageMagick install needs no configuration. Dédalo prefers the modern single-entry-point form (`magick identify`, see DEDALO_MAGICK_PATH) and falls back to this standalone binary, which is what the older ImageMagick packages ship. Set this key only to point at a binary in a non-standard location.

```bash
DEDALO_IDENTIFY_PATH="/usr/bin/identify"
```

*Default: `<DEDALO_BINARY_BASE>/identify`*

---

### SVG

DEDALO_RSVG_CONVERT_PATH `string`

This parameter defines the path to the `rsvg-convert` program in the server, shipped with [librsvg](https://gitlab.gnome.org/GNOME/librsvg). Dédalo uses it — and only it — to turn a vector SVG into a raster image, which is how the thumbnail of an SVG record is produced.

ImageMagick is deliberately NOT used for this. Dédalo runs ImageMagick under a hardened policy that disables its scripting coders (`MVG`/`MSL`), a long-standing remote-code-execution vector; on a build without a librsvg delegate ImageMagick renders SVG through its own renderer, which emits MVG, so every SVG rasterization is refused by that policy. Rendering the vector in a dedicated program instead keeps the ImageMagick hardening intact.

Install librsvg (`brew install librsvg`, `apt install librsvg2-bin`) and the path is derived from DEDALO_BINARY_BASE, so no configuration is needed. Set this key only to point at a binary in a non-standard location. Without it, SVG records keep working — upload, storage, display and download are unaffected — but their thumbnail cannot be built, and the media-versions panel says so.

```bash
DEDALO_RSVG_CONVERT_PATH="/usr/bin/rsvg-convert"
```

*Default: `<DEDALO_BINARY_BASE>/rsvg-convert`*

---

### SVG

DEDALO_SVG_THUMB_DPI `int`

This parameter defines the resolution, in dots per inch, at which an SVG is rendered before it is reduced to a thumbnail. A vector file has no pixels of its own, so a resolution has to be chosen for it; 150 dpi is enough for a crisp thumbnail without rendering a needlessly large intermediate image.

```bash
DEDALO_SVG_THUMB_DPI=150
```

*Default: 150*

---

### ImageMagick resource limits

DEDALO_MAGICK_LIMIT_MEMORY `string`

This parameter defines how much memory one ImageMagick process may use for its pixel cache before it starts spilling to disk.

It is not a refusal: an image that needs more than this still converts, using the memory-mapped and then the disk-backed cache (DEDALO_MAGICK_LIMIT_MAP and DEDALO_MAGICK_LIMIT_DISK). What it bounds is how much of the server's RAM a single upload can take while the person who sent it waits, which is what makes a deliberately outsized file a denial of service rather than a slow conversion.

Accepts an ImageMagick size: a plain number of bytes, or a number with a unit (`2GiB`, `512MiB`).

```bash
DEDALO_MAGICK_LIMIT_MEMORY="2GiB"
```

*Default: 2GiB*

---

### ImageMagick resource limits

DEDALO_MAGICK_LIMIT_MAP `string`

This parameter defines how much memory-mapped address space one ImageMagick process may use for its pixel cache before it falls back to the disk-backed cache.

It is the second step of the same ladder as DEDALO_MAGICK_LIMIT_MEMORY and behaves the same way: crossing it slows a conversion down, it never refuses one. Keep it above the memory limit; a value below it makes the middle step useless.

```bash
DEDALO_MAGICK_LIMIT_MAP="4GiB"
```

*Default: 4GiB*

---

### ImageMagick resource limits

DEDALO_MAGICK_LIMIT_AREA `string`

This parameter defines the pixel area above which ImageMagick caches an image on disk instead of in memory.

It is the threshold that decides, for one image, whether the ladder above is entered at all. Like the two limits above it degrades rather than refuses.

```bash
DEDALO_MAGICK_LIMIT_AREA="2GiB"
```

*Default: 2GiB*

---

### ImageMagick resource limits

DEDALO_MAGICK_LIMIT_DISK `string`

This parameter defines how much disk one ImageMagick process may use for its pixel cache.

This is the bottom of the ladder, and the first of these limits that REFUSES: an image whose cache does not fit in this much disk fails to convert, with `cache resources exhausted`. Dédalo treats that as a failed derivative — nothing half-written is ever published — so the cost of a value that is too low is a refused conversion, and the cost of one that is too high is a scratch directory that can fill the volume the media library lives on.

```bash
DEDALO_MAGICK_LIMIT_DISK="16GiB"
```

*Default: 16GiB*

---

### ImageMagick resource limits

DEDALO_MAGICK_LIMIT_WIDTH `int`

This parameter defines the largest image WIDTH, in pixels, that ImageMagick will read.

Unlike the cache limits above, this is a REFUSAL, and it is the one that stops a decode bomb before a single pixel is allocated: the dimensions are read from the file header, so an image declaring more than this is rejected at header-parse time whatever its size on disk.

The default is deliberately far above any real scan. Raise it only when an institution genuinely holds masters wider than this — large-format map and panorama scans are the real case — and remember the shipped ImageMagick policy carries its own ceiling of 200000, which no value here can exceed.

```bash
DEDALO_MAGICK_LIMIT_WIDTH=100000
```

*Default: 100000*

---

### ImageMagick resource limits

DEDALO_MAGICK_LIMIT_HEIGHT `int`

This parameter defines the largest image HEIGHT, in pixels, that ImageMagick will read. It is the counterpart of DEDALO_MAGICK_LIMIT_WIDTH and everything said there applies to it unchanged, including the 200000 ceiling in the shipped policy.

```bash
DEDALO_MAGICK_LIMIT_HEIGHT=100000
```

*Default: 100000*

---

### ImageMagick resource limits

DEDALO_MAGICK_LIMIT_LIST_LENGTH `int`

This parameter defines how many IMAGES one file may contain before ImageMagick refuses to read it.

An image file is not necessarily one image: a PDF has pages, a TIFF can have pages or layers, a GIF has frames. Reading such a file costs memory for every image in it, and that cost is paid even when Dédalo only wants the header — which it does on every upload, to build the preview. A small file can declare an enormous number of tiny images: a 4.6 MB animation of two hundred thousand one-pixel frames, well inside the upload limit, made a single header read take 26 seconds and nearly 9 GB of memory. None of the limits above stops that, because the cost is not in the pixels.

The default admits any real heritage object measured on this engine — a long multi-page scan, a long animation — and refuses the crafted case at about 180 MB. Raise it if an institution genuinely holds masters with more images than this in one file; a file above the limit is refused with `list length exceeds limit` and no derivative is written.

```bash
DEDALO_MAGICK_LIMIT_LIST_LENGTH=4096
```

*Default: 4096*

---

### ImageMagick resource limits

DEDALO_MAGICK_LIMIT_TIME `int`

This parameter defines how long, in seconds, one ImageMagick process may run before it is refused.

It is a second, independent bound on the same exposure the dimension limits cover: an image small enough to pass them can still be shaped so that decoding it takes hours. Fifteen minutes is far longer than any legitimate derivative build measured on this engine, and short enough that a wedged conversion does not hold a request open for a day.

```bash
DEDALO_MAGICK_LIMIT_TIME=900
```

*Default: 900*

---

### Image

DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS `array` *optional*

This parameter defines the extra file formats Dédalo builds beside the standard image format defined in DEDALO_IMAGE_EXTENSION.

Each format listed here produces a companion file of the version Dédalo already stores in a quality: the same picture, the same quality, another container. It is not a copy of every quality in every format, and it never replaces the standard version:

- a quality that holds its standard file gets one companion per format listed here, built from the master image (the retouched one when the record has it, otherwise the original), so that transparency, colour and detail come from the best source the record holds — never from the already delivered standard file, which has lost them;
- a quality that holds no standard file gets no companion, and a companion found there is moved to the `deleted` folder: a file whose version is gone would keep showing a picture the record no longer has;
- the original and the retouched qualities never get companions. They hold the files a person uploaded, and a generated file among them would be taken for one of them;
- the thumbnail quality never gets companions. Thumbnails are stored in the thumbnail format alone, so any other file there would never be seen.

**avif is the format to add here.** Of the formats this engine can write it is the one that keeps transparency, which is what makes an automatic background removal visible: the cut-out survives into the avif companion, while the standard jpg version is always composited onto white. Measured on this reference machine it costs 0.16 to 0.37 seconds per quality, and at the larger qualities it is smaller than the jpg it accompanies (180 KB against 256 KB at the 6MB quality).

Every companion is built while the person who uploaded the image is waiting, so the whole list is added to the time an upload takes. Measured on this reference machine, one 19.9 MB master through the complete upload processing: 0.27 seconds with the list empty, 0.59 seconds with avif, 1.87 seconds with avif and png.

png also keeps transparency and is lossless, so it is a defensible archival choice, but state its cost before adding it: measured on a 3.8 megapixel master it takes 1.25 to 4.33 seconds and 7.6 to 10 MB per quality — 25 to 70 times the disk the jpg uses. There is no size or time cap: Dédalo builds exactly what you list.

If a format is listed that the image processing program on this server cannot write, no file is produced for it, any companion already on disk is moved to the `deleted` folder rather than left showing an outdated picture, and the refusal is reported in the upload response and named in the server log when Dédalo starts.

A companion is only ever built beside a version that Dédalo itself produced from the master. If someone has rotated or cropped a quality, that file no longer shows what the master shows, and a companion built from the master would show a different picture in the same quality: Dédalo declines to build it and says so, naming both sizes. Rebuilding the quality itself produces both files together again — which discards the rotation, exactly as any change of the master already does.

By default the list is empty: no companion file is created and Dédalo stores only the uploaded file and the standard format.

```bash
DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS=["avif"]
```

Example:

Original file: **my_image.tif**

Default format defined in DEDALO_IMAGE_EXTENSION: **jpg**

Alternative formats defined in DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS: **\['avif'\]**

Result:

In original quality directory (a master quality — no companion is built here):
> ../media/image/original/rsc29_rsc170_1.tif
>
> ../media/image/original/rsc29_rsc170_1.jpg

In 1.5MB quality directory:
> ../media/image/1.5MB/rsc29_rsc170_1.jpg
>
> ../media/image/1.5MB/rsc29_rsc170_1.avif

In thumb quality directory (thumbnails take no companion):
> ../media/image/thumb/rsc29_rsc170_1.jpg

*Default: []*

---

### Image

DEDALO_IMAGE_AR_QUALITY `serialized array`

This parameter defines the different qualities that can be used for compress the image files.

This parameter will use to compress image files to specific quality. The compression will use the original file and will compress to those qualities when the user demand a specific quality.

```bash
DEDALO_IMAGE_AR_QUALITY=["original","modified","100MB","25MB","6MB","1.5MB","thumb"]
```

*Default: ["original","modified","100MB","25MB","6MB","1.5MB","thumb"]*

---

### Image

DEDALO_IMAGE_EXTENSION `string`

This parameter defines the standard file type of image files.

By default Dédalo use jpg standard definition for the image files. All other formats will be compressed to this standard.

```bash
DEDALO_IMAGE_EXTENSION="jpg"
```

*Default: jpg*

---

### Image

DEDALO_IMAGE_EXTENSIONS_SUPPORTED `array`

This parameter defines the standards file type admitted for the image files.

Dédalo will use this parameter to identify the file format of the original files uploaded by the users before compress it to the standard defined in the DEDALO_IMAGE_EXTENSION parameter.

```bash
DEDALO_IMAGE_EXTENSIONS_SUPPORTED=["jpg","jpeg","png","tif","tiff","bmp","psd","raw","webp","heic"]
```

*Default: ["jpg","jpeg","png","tif","tiff","bmp","psd","raw","webp","heic","avif"]*

---

### Image

DEDALO_IMAGE_FOLDER `string`

This parameter defines the main directory for the image files.

```bash
DEDALO_IMAGE_FOLDER="/image"
```

*Default: /image*

---

### Image

DEDALO_IMAGE_PRINT_DPI `int`

This parameter defines the resolution in pixels per inch that will be used in the image compression to be apply when the images will be printed.

```bash
DEDALO_IMAGE_PRINT_DPI=150
```

*Default: 150*

---

### Image

DEDALO_IMAGE_QUALITY_DEFAULT `string`

This parameter defines the default quality used for the image files.

This parameter will use to compress all image files to specific quality, unifying the quality used by all sections. By default Dédalo use 1.5MB file size (524.217px or 887x591px) quality.

```bash
DEDALO_IMAGE_QUALITY_DEFAULT="1.5MB"
```

*Default: 1.5MB*

---

### Image

DEDALO_IMAGE_QUALITY_ORIGINAL `string`

This parameter defines the quality original for the image files.

This parameter will use to identify the uploaded files to with specific quality. Dédalo admit lots of different formats from different sources and qualities, and it define this files as "original" quality. Dédalo will compress all formats to web standard format, unify all different qualities and codecs, and will store the original file without touch. In some cases, if the institution has a protocol for manage image files, is possible to use one specific quality for the files that users can upload. By default Dédalo do not limit the original format to be uploaded using a "original" quality denomination.

```bash
DEDALO_IMAGE_QUALITY_ORIGINAL="original"
```

*Default: original*

---

### Image

DEDALO_IMAGE_QUALITY_RETOUCHED `string`

This parameter defines the quality for the image files that has been retouched.

Retouched images are the processed images to improve the image, this quality will be a copy of the original that has any kind of process (color balance, background removed, contrasted, etc)

```bash
DEDALO_IMAGE_QUALITY_RETOUCHED="modified"
```

*Default: modified*

---

### Thumb

DEDALO_IMAGE_THUMB_HEIGHT `int`

This parameter defines height size in pixels to the thumb images, it will be used to compress the images with the thumb quality (the smaller version to be used in lists).

```bash
DEDALO_IMAGE_THUMB_HEIGHT=148
```

*Default: 148*

---

### Thumb

DEDALO_IMAGE_THUMB_WIDTH `int`

This parameter defines width size in pixels to the thumb images, it will be used to compress the images with the thumb quality (the smaller version to be used in lists).

```bash
DEDALO_IMAGE_THUMB_WIDTH=222
```

*Default: 222*

---

### Image

DEDALO_IMAGE_WEB_FOLDER `string`

This parameter names the directory, inside the image directory, that holds browser-sized copies of pictures brought in from a rich-text field rather than from the image component itself.

It sits beside the quality directories (`original`, `1.5MB`, `thumb`, …) and is created and verified when the server starts, so it carries the same owner and permissions as the rest of the media tree. Nothing in this engine writes into it yet; it is provisioned so that an install keeps the shape it has always had and so no future subsystem has to create it on the fly.

The value is a single folder name (a leading slash is optional and removed), never a path.

```bash
DEDALO_IMAGE_WEB_FOLDER="/web"
```

*Default: /web*

---

### Image

DEDALO_MAGICK_PATH `string`

This parameter defines the path to image magick library in the server (when image magick library is installed)

```bash
DEDALO_MAGICK_PATH="/usr/bin/"
```

*Default: `<DEDALO_BINARY_BASE>/magick`*

---

### Defining the media URL directory

DEDALO_MEDIA_DIR `string`

This parameter defines the NAME of the media directory as it appears in the URL. Every media URL Dédalo builds is `/dedalo/<DEDALO_MEDIA_DIR>/` plus the file path.

Do not confuse it with MEDIA_PATH, which is the directory on disk: this one is the public folder name, and the web server maps the two together (the media rules and the reverse-proxy configuration are generated from both, and they must agree — `<web root> + /dedalo/<DEDALO_MEDIA_DIR>/…` must resolve to `MEDIA_PATH/…`).

The default is `media` and a new installation should keep it. The reason to change it is an existing installation whose media were published under another folder name (`media_mib`, say): setting the old name keeps every URL already diffused to the public working.

```bash
DEDALO_MEDIA_DIR="media"
```

*Default: media*

---

### Defining the media base for exports

DEDALO_MEDIA_EXPORT_BASE `string` *optional — unset leaves export media cells unresolved*

This parameter defines the base every media URL that LEAVES the application is built on — an exported list, a relation list cell, anything a third party opens outside Dédalo.

Inside the application media URLs may be relative (`/dedalo/media/image/1.5MB/…`), because the browser already knows the host — that is DEDALO_MEDIA_WEB_BASE's job. A cell that travels cannot: it must carry an address that resolves anywhere, so those cells are built as this base plus the file path of the model's default quality.

Set it to the ABSOLUTE public address of the media directory — the same value DEDALO_MEDIA_WEB_BASE takes, including `/dedalo/<DEDALO_MEDIA_DIR>`, because both are prefixed to the SAME media-root relative path. A trailing slash is stripped.

The parameter is unset by default. When it is unset, media cells cannot be resolved and are reported as unresolved rather than guessed: the export leaves the cell empty and names the models it could not build.

```bash
DEDALO_MEDIA_EXPORT_BASE="https://my_institution.org/dedalo/media"
```

*Default: (unset)*

---

### Defining how many image conversions run at the same time

DEDALO_MEDIA_CONVERT_CONCURRENCY `int`

This parameter defines how many image, PDF or SVG conversions Dédalo will run at the same time.

Unlike media jobs, these conversions happen while somebody waits: the preview of a file being uploaded, a regenerated thumbnail, a rotation. Each one is already limited in how much memory and disk it may use (see the `DEDALO_MAGICK_LIMIT_*` parameters), but that limit applies to ONE conversion, and a large photograph can legitimately use all of it. Without this parameter, ten simultaneous uploads meant ten simultaneous conversions, each allowed to spend the whole budget, and the server ran out of disk while every upload waited.

With it, a conversion that arrives when the lanes are busy waits for a free one and then runs normally. Nothing is lost and nobody is refused, unless the wait exceeds `DEDALO_MEDIA_CONVERT_QUEUE_SECONDS`.

By default Dédalo runs 2 conversions at a time. Raise it on a server with cores and disk to spare and many people uploading at once; lower it to 1 on a small machine that also serves the public website. Values below 1 are raised to 1.

```bash
DEDALO_MEDIA_CONVERT_CONCURRENCY=2
```

*Default: 2*

---

### Defining how long a conversion waits for a free lane

DEDALO_MEDIA_CONVERT_QUEUE_SECONDS `int (seconds)`

This parameter defines how long a conversion may wait for a free conversion lane (`DEDALO_MEDIA_CONVERT_CONCURRENCY`) before it is refused.

Waiting is not free: the person's browser is holding a connection open while it waits. When the server is so busy that the wait becomes long, answering "too many requests, try again" is more useful than an operation that eventually times out with no explanation. The client can retry, and the record is untouched — the original file is never modified by a conversion.

By default Dédalo waits up to 120 seconds. Raise it on an installation that ingests large masters in bulk and prefers slow success to a refusal; lower it on an interactive installation where a quick answer matters more.

```bash
DEDALO_MEDIA_CONVERT_QUEUE_SECONDS=120
```

*Default: 120*

---

### Defining how many audio and video conversions run at the same time

DEDALO_MEDIA_AV_CONCURRENCY `int`

This parameter defines how many audio or video conversions (`ffmpeg` processes) Dédalo will run at the same time.

Video work is the heaviest thing this server does, and not all of it happens in a media job: two actions of the audiovisual component run WHILE THE PERSON WAITS — creating a posterframe, and cutting the fragment an index entry points at. Those belong to no job lane, so before this parameter existed the only limit on how many transcodes a server ran at once was how many people pressed the button.

With it, every ffmpeg the engine starts — the jobs and the two interactive actions alike — takes one of these lanes; one that arrives when they are all busy waits, and is refused with "too many requests" if the wait exceeds `DEDALO_MEDIA_AV_QUEUE_SECONDS`.

By default Dédalo allows one more than the media-job lanes (`DEDALO_MEDIA_JOB_CONCURRENCY`), so a full job queue still leaves room for one interactive fragment. Raise both together on a machine with cores to spare; lower this to 1 on a small server. Values below 1 are raised to 1.

```bash
DEDALO_MEDIA_AV_CONCURRENCY=4
```

*Default: `DEDALO_MEDIA_JOB_CONCURRENCY` + 1*

---

### Defining how long an audio or video conversion waits for a free lane

DEDALO_MEDIA_AV_QUEUE_SECONDS `int (seconds)`

This parameter defines how long an audio or video conversion may wait for a free lane (`DEDALO_MEDIA_AV_CONCURRENCY`) before it is refused.

It exists for the two audiovisual actions that run while somebody waits (the posterframe and the fragment download): when every lane is busy transcoding, answering "too many requests, try again" is more useful than a browser holding a connection open for an hour. Nothing is lost — the original file is never modified, and the person can repeat the action.

A queued media JOB is refused the same way, and its failure is reported in the job's own status, so raise this value on an installation that ingests long interviews in bulk and prefers a slow success to a refusal.

```bash
DEDALO_MEDIA_AV_QUEUE_SECONDS=120
```

*Default: 120*

---

### Defining media job concurrency

DEDALO_MEDIA_JOB_CONCURRENCY `int`

This parameter defines how many media jobs Dédalo will run at the same time.

Media processing (video transcoding, image derivatives, OCR) is heavy and runs inside the server process, so it is capped: a job that arrives while the lanes are busy is queued and starts as soon as one is free. The upload and the interface never block — only the processing waits.

By default Dédalo uses 3 lanes, a safe figure for a modest server. Raise it on a machine with cores to spare and a heavy ingest workload (bulk imports, long interviews); lower it to 1 when the server also serves the public site and must stay responsive while it transcodes. Values below 1 are raised to 1.

```bash
DEDALO_MEDIA_JOB_CONCURRENCY=3
```

*Default: 3*

---

### Defining the media job process files directory

DEDALO_MEDIA_PROCESSES_DIR `string`

This parameter defines the directory holding the process files of the media jobs.

Every media job writes a small JSON file with its state (progress, errors, result) that the client polls while it waits, and that lets a job be resumed after a restart. Terminal files are pruned automatically.

By default Dédalo writes them to `processes/` inside the private directory, which the server creates on demand. Change it when the private directory is on a read-only or network volume, or when several installations share one host and their job files must stay apart. The server needs read/write access to the directory as its owner.

```bash
DEDALO_MEDIA_PROCESSES_DIR="/var/lib/dedalo/processes"
```

*Default: (unset)*

---

### Defining the media web base for the client

DEDALO_MEDIA_WEB_BASE `string` *optional — unset serves media same-origin*

This parameter defines the base every media URL served to the CLIENT is built on — the address the browser fetches images, video, PDFs and their derivatives from.

Unset (the default, and the right value whenever the web server that serves media also fronts the application), media URLs are RELATIVE: `/dedalo/<DEDALO_MEDIA_DIR>/` plus the file path, resolved by the browser against the page's own origin. Set it to an ABSOLUTE URL, without a trailing slash, when media is served from a DIFFERENT origin than the application — the typical case is development, with the application on the engine's TCP port and the media on the local web server that enforces the generated access rules:

```bash
DEDALO_MEDIA_WEB_BASE="http://localhost:8080/dedalo/media"
```

In a production topology (one virtual host fronting both the application and `/dedalo/media`) leave it unset.

Do not confuse it with DEDALO_MEDIA_EXPORT_BASE, which builds the media cells of EXPORTS — content that leaves the application and cannot use a relative URL. Both take the same kind of value (an origin plus `/dedalo/<DEDALO_MEDIA_DIR>`), and on a single-origin installation they are the same string; they differ in their audience and in what UNSET means. That key stays deliberately unset-means-unresolved; this one always has an effective value (the relative default).

*Default: (unset)*

---

### PDF

DEDALO_PDF_ALTERNATIVE_EXTENSIONS `array` *optional*

This parameter defines the image formats Dédalo renders the cover of an uploaded PDF into.

The cover is the first page of the document, rasterized into the web quality so that a viewer that cannot display a PDF still has a picture of it. One cover is written per format listed here, always composited onto white: a page has no paper of its own, so a cover built on a transparent background is a sheet of floating glyphs.

**The jpg cover is built whether or not this list names it.** It is what the record, the lists and the search results show, so it is not optional: removing jpg from this list does not stop it being built, and it does not un-index the covers already on disk. Adding another format here adds a cover beside the jpg one; it never replaces it.

Formats other than jpg are only worth adding for a specific consumer — avif for a web front end that prefers it, for instance. Each one is rendered at the same high density as the jpg cover, so it multiplies the part of the upload wait described in the warning below.

If a format is listed that the image processing program on this server cannot write, no cover is produced for it, the jpg cover is still built, and the refusal is reported in the upload response and named in the server log when Dédalo starts.

```bash
DEDALO_PDF_ALTERNATIVE_EXTENSIONS=["jpg"]
```

Example:

Original file: **my_pdf.pdf**

Formats defined in DEDALO_PDF_ALTERNATIVE_EXTENSIONS: **\['avif','jpg'\]**

Result:

In original quality directory (the uploaded file, untouched — no cover is built here):
> ../media/pdf/original/rsc37_rsc176_1.pdf

In web quality directory:
> ../media/pdf/web/rsc37_rsc176_1.pdf
>
> ../media/pdf/web/rsc37_rsc176_1.jpg
>
> ../media/pdf/web/rsc37_rsc176_1.avif

!!! warning "About increment time when uploaded PDF files render alternative versions"
    Alternative versions of PDF increase the rendering process time of uploaded PDF files by ~5 times.
    The render PDF use a high density dpi and reduce the final image to get a good anti-aliased image.
    This process increases the waiting time until the PDF is displayed and usable.

*Default: ["jpg"]*

---

### PDF

DEDALO_PDF_AR_QUALITY `array`

This parameter defines the different qualities that can be used for compress the PDF files.

This parameter will use to compress PDF files to specific quality. The compression will use the original file and will compress to those qualities when the user demand a specific quality.

```bash
DEDALO_PDF_AR_QUALITY=["original","web"]
```

*Default: ["original","web"]*

---

### PDF

DEDALO_PDF_EXTENSION `string`

This parameter defines the standard file type of pdf files.

```bash
DEDALO_PDF_EXTENSION="pdf"
```

*Default: pdf*

---

### PDF

DEDALO_PDF_EXTENSIONS_SUPPORTED `array`

This parameter define the standards file type admitted for the pdf files. Dédalo will use this parameter to identify the file format of the original files uploaded by the users. Defaults to `["pdf","doc","pages","odt","ods","rtf","ppt"]`.

```bash
DEDALO_PDF_EXTENSIONS_SUPPORTED=["pdf","doc","pages","odt","ods","rtf","ppt"]
```

*Default: ["pdf","doc","pages","odt","ods","rtf","ppt"]*

---

### PDF

DEDALO_PDF_FOLDER `int`

This parameter defines the main directory for the pdf files.

```bash
DEDALO_PDF_FOLDER="/pdf"
```

*Default: /pdf*

---

### PDF

DEDALO_PDF_QUALITY_DEFAULT `string`

This parameter defines the default quality used for the PDF files.

This parameter will use to compress all pdf files to specific format, unifying the quality used by all sections. By default Dédalo will compress images to jpg for web quality.

```bash
DEDALO_PDF_QUALITY_DEFAULT="web"
```

*Default: web*

---

### PDF

DEDALO_PDF_QUALITY_ORIGINAL `string`

This parameter defines the quality original for the pdf files.

This parameter will use to identify the uploaded files to with specific quality. Dédalo admit hight quality for PDF files (print formats or preservation formats), and it define this files as "original" quality. Dédalo will compress to web standard format, unify all different qualities and will store the original file without touch. In some cases, if the institution has a protocol for manage PDF files, is possible to use a specific quality for the files that users can upload. By default Dédalo do not limit the original format to be uploaded using a "original" quality denomination.

```bash
DEDALO_PDF_QUALITY_ORIGINAL="original"
```

*Default: original*

---

### PDF

DEDALO_PDFINFO_PATH `string`

This parameter defines the path to the `pdfinfo` program in the server, usually shipped with [Poppler](https://poppler.freedesktop.org/). Dédalo uses it to read the metadata of the uploaded PDF files — the number of pages and the creation date that feeds the automatic date components.

The path is derived from DEDALO_BINARY_BASE, so a normal Poppler install needs no configuration; set the key only to point at a binary in a non-standard location. When the binary is missing, the PDF is stored and converted normally but its date and page metadata are not extracted.

```bash
DEDALO_PDFINFO_PATH="/usr/bin/pdfinfo"
```

*Default: `<DEDALO_BINARY_BASE>/pdfinfo`*

---

### PDF

DEDALO_PDFTOHTML_PATH `string`

This parameter defines the path to the `pdftohtml` program in the server, usually shipped with [Poppler](https://poppler.freedesktop.org/). The PDF extractor tool uses it to pull the content of a PDF out as formatted HTML, keeping the layout of the page; the plain-text alternative is PDF_AUTOMATIC_TRANSCRIPTION_ENGINE, and the user chooses between them in the tool.

The path is derived from DEDALO_BINARY_BASE, so a normal Poppler install needs no configuration. Set this key only to point at a binary in a non-standard location.

```bash
DEDALO_PDFTOHTML_PATH="/usr/bin/pdftohtml"
```

*Default: `<DEDALO_BINARY_BASE>/pdftohtml`*

---

### PDF

DEDALO_GS_PATH `string`

This parameter defines the path to the `gs` program in the server, the [Ghostscript](https://www.ghostscript.com/) interpreter. Dédalo uses it — and only it — to turn the first page of an uploaded PDF into an image, which is how the cover and the thumbnail of a PDF record are produced.

ImageMagick is deliberately NOT asked to do this. ImageMagick cannot read a PDF by itself either: it hands the file to Ghostscript as a *delegate*, i.e. a second program that Dédalo did not start, cannot bound and cannot stop — a PDF declaring an enormous page then keeps a Ghostscript process running, and filling the disk, after the conversion that started it has already been killed. Dédalo therefore runs Ghostscript itself, refuses a page larger than DEDALO_MAGICK_LIMIT_WIDTH x DEDALO_MAGICK_LIMIT_HEIGHT before rendering anything, and the hardened ImageMagick policy denies the Ghostscript delegate outright.

Install Ghostscript (`brew install ghostscript`, `apt install ghostscript`; version 9.50 or newer, where the safe interpreter mode is the default) and the path is derived from DEDALO_BINARY_BASE, so no configuration is needed. Set this key only to point at a binary in a non-standard location. Without it, PDF records keep working — upload, storage, text extraction, display and download are unaffected — but their cover image and thumbnail cannot be built, and the media-versions panel says so.

```bash
DEDALO_GS_PATH="/usr/bin/gs"
```

*Default: `<DEDALO_BINARY_BASE>/gs`*

---

### Thumb

DEDALO_QUALITY_THUMB `string`

This parameter defines the thumb quality definition that can be used for compress the media files.

This parameter will use to compress and store image files used in lists. The compression will use the default file.

| Media | Remark |
| --- | --- |
| PDF | Will render the first page of the website in quality, if the default image does not exist it will try to use the original quality.|
| AV | Will render the posterframe.|
| Image | Will render the default quality, if the default image does not exist it will try to use the original quality.|
| SVG | Will render the default quality, if the default image does not exist it will try to use the original quality.|
| 3d | Will render the posterframe.|

```bash
DEDALO_QUALITY_THUMB="thumb"
```

*Default: thumb*

---

### Audiovisual

DEDALO_SUBTITLES_FOLDER `string`

This parameter defines the path to the subtitles directory.

Dédalo will store the VTT files generated by the subtitle engine in this directory.

```bash
DEDALO_SUBTITLES_FOLDER="/subtitles"
```

*Default: /subtitles*

---

### SVG

DEDALO_SVG_ALTERNATIVE_EXTENSIONS `array` *optional*

**This engine builds no alternative versions of svg files, so this parameter has no effect.** Keep it empty.

The reason is structural, not a missing option: the web version of an svg is a byte copy of the uploaded drawing, so there is no conversion step here that could be pointed at another format. A raster copy of a vector drawing would need an encoder this part of the engine does not have.

A value set here is not silently obeyed and not silently ignored either: the formats are refused at start-up, and the server log names this parameter, its value and this reason. Nothing is scanned for, indexed or offered in the versions panel for a file that cannot be produced.

Dédalo stores the uploaded file and the web version, and nothing else.

```bash
DEDALO_SVG_ALTERNATIVE_EXTENSIONS=[]
```

*Default: []*

---

### SVG

DEDALO_SVG_AR_QUALITY `array`

This parameter defines the different qualities that can be used transformed svg files.

This parameter will use to store different svg version files to specific quality.

```bash
DEDALO_SVG_AR_QUALITY=["original","web"]
```

*Default: ["original","web"]*

---

### SVG

DEDALO_SVG_EXTENSION `string`

This parameter defines the standard file type of svg files.

```bash
DEDALO_SVG_EXTENSION="svg"
```

*Default: svg*

---

### SVG

DEDALO_SVG_EXTENSIONS_SUPPORTED `array`

This parameter defines the standards file type admitted for the svg files.

Dédalo will use this parameter to identify the file format of the original files uploaded by the users.

```bash
DEDALO_SVG_EXTENSIONS_SUPPORTED=["svg"]
```

*Default: ["svg"]*

---

### SVG

DEDALO_SVG_FOLDER `string`

This parameter defines the main directory for the svg files.

```bash
DEDALO_SVG_FOLDER="/svg"
```

*Default: /svg*

---

### SVG

DEDALO_SVG_QUALITY_DEFAULT `string`

This parameter defines the default quality used for the SVG files.

This parameter will use to store all svg files, unifying the quality used by all sections. By default Dédalo will use a flat svg for web quality.

```bash
DEDALO_SVG_QUALITY_DEFAULT="web"
```

*Default: web*

---

### SVG

DEDALO_SVG_QUALITY_ORIGINAL `string`

This parameter defines the quality original for the svg files.

This parameter will use to identify the uploaded files to with specific quality. Dédalo admit different editing vector formats, and it define this files as "original" quality, Dédalo will store the original file without touch. In some cases, if the institution has a protocol for manage SVG files, is possible to use a specific quality for the files that users can upload. By default Dédalo do not limit the original format to be uploaded using a "original" quality denomination.

```bash
DEDALO_SVG_QUALITY_ORIGINAL="original"
```

*Default: original*

---

### Thumb

DEDALO_THUMB_EXTENSION `string`

This parameter defines the standard file type of thumb files.

```bash
DEDALO_THUMB_EXTENSION="jpg"
```

*Default: jpg*

---

### Generated and exported files

DEDALO_TOOL_EXPORT_FOLDER_PATH `string` *optional — unset means the default location inside the media directory*

This parameter defines where the export tool writes the bundles it produces.

Left unset — the normal case — the bundles go to `export/files` inside the media directory, and that directory is created and verified with the rest of the media tree when the server starts.

Set it to an ABSOLUTE path to put exports somewhere else entirely, which is the reason the setting exists: an export bundle can be large, is regenerated rather than curated, and an institution often wants it on a scratch volume, a shared mount, or a disk that is backed up on a different schedule from the archive itself. A relative value is refused rather than guessed at.

When the path lands OUTSIDE the media directory, Dédalo will create the directory itself but not the volume above it: its parent must already exist, so that a mount that has not come up is reported as a problem you can see instead of quietly recreated as an empty local directory — which is how an export lands on the system disk and fills it.

```bash
DEDALO_TOOL_EXPORT_FOLDER_PATH="/srv/exports/dedalo"
```

*Default: `<media directory>/export/files` — inside the media tree*

---

### Defining the maximum upload size

DEDALO_UPLOAD_MAX_SIZE_BYTES `int`

This parameter defines the largest file, in BYTES, that Dédalo will accept in an upload.

The limit is enforced at three points, and it is a ceiling on the FILE, not on one request. The server publishes it to the client (the upload service reads it when it starts), so the interface can refuse an oversize file before a single byte travels and tell the user why; the server checks the size of every part it receives, so a single oversize request is refused whatever the client believes; and, because a chunked upload is many requests, the server also keeps a running total per transfer and sums the parts before it assembles them, so a file that only exceeds the limit once its chunks are added together is refused too.

A transfer refused for size is QUARANTINED, never deleted: the parts already received stay on disk under a rejection marker, and are released by cancelling the upload or by the ordinary 24 h sweep of staged files.

By default the limit is 2 GB (`2147483648`). Raise it for collections of long, high-resolution video — and remember that the web server in front of Dédalo has a limit of its own (`client_max_body_size` in nginx, `LimitRequestBody` in Apache) which must be at least as large, or the upload dies before it reaches the engine. Splitting the file into chunks (DEDALO_UPLOAD_SERVICE_CHUNK_FILES) is what keeps a single request small; it does not raise this ceiling.

```bash
DEDALO_UPLOAD_MAX_SIZE_BYTES=2147483648
```

*Default: 2147483648*

---

### Defining upload split files in chunks

DEDALO_UPLOAD_SERVICE_CHUNK_FILES `int || false`

Defines the size at which files are split into chunks for upload.

This parameter allows you to break large files into smaller, more manageable pieces for reliable resumable uploads.

This parameter will use to split files at specific size into small chunks or blobs. The value is expressed in MB, but do not use the MB string, the value is a integer, for ex: 5 will be interpreted as 5MB.

When an integer is provided, any file larger than this value will be automatically segmented into chunks. The value is interpreted as Megabytes (MB). For example, chunkSize: 95 will create chunks of approximately 95MB each.

When set to `false`, the chunking feature is disabled, and all files are uploaded in a single request.

```bash
# integer = split threshold in MB (e.g. 5 = 5MB); false = disable chunking
DEDALO_UPLOAD_SERVICE_CHUNK_FILES=false
```

*Default: 4*

---

### Defining the maximum number of simultaneous connections for uploading chunked files

DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT `int || false`

Defines the maximum number of simultaneous HTTP requests that can be open to the server when uploading a file in chunks.

When set to `false`, the internal limit is removed. The browser will then determine the maximum number of concurrent requests, which is typically based on the HTTP protocol version (see below).
When set to a positive integer (e.g., 50), the client will enforce that limit, ensuring no more than the specified number of chunks are uploaded simultaneously.

Protocol Dependencies:
This parameter is highly dependent on the HTTP protocol version in use:

For HTTP/1.1: The standard limits the number of simultaneous requests per domain to a very low number (typically 4-6). In this environment, setting a value higher than ~6 is ineffective and will be ignored by the browser. For optimal performance with HTTP/1.1, it is recommended to set this value to 4.
For HTTP/2: The protocol supports multiplexing, allowing many requests to be sent concurrently over a single connection. While this allows for a higher limit, setting the value too high can overwhelm the server with simultaneous processing load. This parameter should be used to throttle the requests to a level your server can handle reliably.

Purpose:
This setting allows you to optimize upload performance and ensure server stability by defining a number of concurrent chunk upload requests that your server can process efficiently.

```bash
DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT=50
```

*Default: 50*

---

### Defining the upload staging directory

DEDALO_UPLOAD_TMP_SUBDIR `string`

This parameter defines the staging directory where an upload is assembled, RELATIVE to the media root (MEDIA_PATH).

A file arriving in chunks is written there piece by piece, under a subdirectory of the user who is uploading it, and only when the last chunk has landed and the content has been verified is the finished file moved into its media folder. Nothing outside the staging tree is ever written by an upload in flight, and the path is confined to the media root: a value that escapes it is refused.

The default is `upload/service_upload/tmp`, and there is normally no reason to change it. A change is only useful to move the staging tree to a different subdirectory of the media volume — it must stay inside it, because the final move has to be a rename on the same filesystem, not a copy.

```bash
DEDALO_UPLOAD_TMP_SUBDIR="upload/service_upload/tmp"
```

*Default: upload/service_upload/tmp*

---

### Serving media from the engine (development only)

MEDIA_DEV_ROUTE_ENABLED `true || false` *optional — unset is NOT the same as `false`*

**You normally leave this unset.** Media files are served by the WEB SERVER, which enforces the access rules Dédalo generates for it. But Dédalo can also serve them itself, straight from the media root — with no per-record access control at all. That fallback exists for the one setup that has no web server in the request path: a developer running the engine on its local TCP port.

Unset, the fallback is bound to conditions a production install cannot meet, so it needs no flag: it answers ONLY on the development TCP listener (production serves through a unix socket) and ONLY while media protection is unconfigured (once it is, the generated rules are authoritative and the engine must never undercut them).

Set the key only to override that decision. `true` FORCES the fallback on for every listener, the production socket included, serving every file under the media root to any logged-in session with no per-record or per-project check — never do this on a shared or public host; the server logs a loud warning when you do. `false` forces it off even in development.

```bash
MEDIA_DEV_ROUTE_ENABLED=false
```

*Default: (unset)*

---

### Defining media base path

MEDIA_PATH `string`

This parameter defines the root media directory in the directory tree.

Unset, it defaults to `media` inside the private directory — OUTSIDE the code tree, because a code update replaces the whole install directory and must never carry the media library away with the old code. Installs that already keep their media at the legacy in-tree `<install dir>/media` location are not moved: while that directory holds files and this key is unset, it keeps being used and the server logs a one-line warning naming this key as the fix. Set the key (and move the directory) to end the warning.

The directory can be set to any path. The server needs read/write access to this directory as its owner. Unset in dev leaves media handling disabled.

```bash
MEDIA_PATH="/srv/dedalo/media"
```

*Default: `<private dir>/media` — auto-derived; a legacy `<install dir>/media` holding files keeps being used (with a start-up warning) so nothing moves*

---

### Provisioning the media directories at start-up

MEDIA_TREE_BOOT_BUDGET_MS `int (milliseconds)`

Every time the server starts it walks the media directories, creates any that are missing and reports any that are wrong. This parameter is the wall-clock budget for that walk.

On local storage the walk costs a couple of milliseconds and the budget is never reached. On network storage it is not free: the walk is around fifty directory look-ups plus three write probes, and at 200 ms of latency each that is a start-up that appears to hang. When the budget runs out, Dédalo stops the walk, reports the directory it stopped at and how many were left unchecked, and goes on to serve the archive — a slow media volume must never mean an archive that will not open. The directories it did not reach are simply checked again on the next start.

Raise it on an install whose media volume lives on the network and whose start-up log says the budget was exhausted; 30000 (thirty seconds) is a reasonable ceiling for a mount that is slow but healthy. The value is never allowed below 100 ms, because a budget too small to complete a single look-up would turn every start-up into the same error.

One limit is worth knowing, because no setting can remove it: if the media volume is not slow but UNREACHABLE — a hard network mount whose server is down — the very first look-up blocks inside the operating system, where nothing in Dédalo can interrupt it, and no budget of any size will expire. That situation is fixed in the mount (a soft mount, a timeout, an automounter), not here.

```bash
MEDIA_TREE_BOOT_BUDGET_MS=5000
```

*Default: 5000*

---

### PDF

PDF_AUTOMATIC_TRANSCRIPTION_ENGINE `string`

This parameter defines the path to the library, usually [xpdf](http://www.xpdfreader.com/download.html) (pdftotext), to be used for process the pdf to extract the information, this library will be used get the text fo the pdf files and store in the component_text_area. The text will be use to search inside the pdf information.

```bash
PDF_AUTOMATIC_TRANSCRIPTION_ENGINE="/usr/bin/pdftotext"
```

*Default: `<DEDALO_BINARY_BASE>/pdftotext`*

---

### PDF

PDF_OCR_ENGINE `string`

This parameter defines the path to the library, usually [ocrmypdf](https://ocrmypdf.readthedocs.io/en/latest/index.html) that will be used for OCR processing of the pdf uploaded files. Optical Character Recognition or OCR is a technology that converts images of typed or handwritten text, such as in a scanned document, into computer text that can be selected, searched and copied.

```bash
PDF_OCR_ENGINE="/usr/bin/ocrmypdf"
```

*Default: `<DEDALO_BINARY_BASE>/ocrmypdf`*

---

## Menu variables {#menu}

### Defining denied areas

AREAS_DENY `array`

This parameter defines the areas that are removed from the installation.

Areas are the top-level parts of the ontology (Thesaurus, Resources, Tools, …), each with its own tipo. A denied area is stripped from the ontology BEFORE the security layer runs, so it disappears from the menu and becomes unreachable — for every user, the root user included. Denial is absolute: there is no allow-list that can give it back.

By default Dédalo denies the areas that exist as internal lists of values rather than as places a user works in — the Yes/No list, for one — and those should stay denied. Add a tipo here to take a whole area out of an installation that does not use it. To hide an area from the menu while leaving it reachable, use MENU_SKIP_TIPOS instead. The maintenance area can also persist this list at runtime, and that override wins over the value set here.

```bash
AREAS_DENY=["dd137","rsc1","hierarchy20"]
```

*Default: ["dd137","rsc1","hierarchy20"]*

---

### Defining skip tipos from menu

MENU_SKIP_TIPOS `array`

This parameter defines the tipos to be skipped from the menu.

The ontology sometimes defines a long hierarchy to reach the sections, and it can be convenient to remove some tipo from the menu to get to them more quickly. Add the tipo to the array to remove it from the menu.

It is EMPTY by default. The default used to carry four tipos, two of them belonging to specific installations' ontologies — menu shortcuts of one project applied to every project, in a key whose own example already showed an empty array. Declare the skips your own ontology needs.

```bash
MENU_SKIP_TIPOS=[]
```

*Default: []*

---

## Security variables {#security}

### Defining exclude components

DEDALO_AR_EXCLUDE_COMPONENTS `array`

This parameter defines components to be excluded.

Some installations need to block the global access to specific components, use this param to remove the components adding the tipo into the array.

```bash
DEDALO_AR_EXCLUDE_COMPONENTS=[]
```

*Default: []*

---

### Cross-origin API callers (CORS)

DEDALO_CORS_ALLOWED_ORIGINS `array`

Origins allowed to call this server's JSON API from a **browser** on another origin.

Empty (the default) means **no CORS headers are sent at all** and the browser blocks every
cross-origin call — the safe default, and the behaviour of every install that does not set this.

The one workflow that needs it is a Dédalo acting as an **ontology master**
(`IS_AN_ONTOLOGY_SERVER=true`): the update panel on the *client* Dédalo fetches
`get_ontology_update_info` from the master **directly from the browser**
(`client/dedalo/core/area_maintenance/widgets/update_ontology/js/render_update_ontology.js`),
so the master must name the client origins here. The master's **Serve Ontology** maintenance
panel shows whether this key (and the other two serving keys) is set. The server-to-server probe
(`checkRemoteServer`) is unaffected — it is a Bun `fetch`, and CORS is a browser rule.

An entry is matched as an **exact, case-sensitive origin string** — scheme + host + port, no
path, no trailing slash, no partial wildcards. `https://a.example.org` does not match
`https://a.example.org:443` or `http://a.example.org`.

Only a listed origin is echoed back in `Access-Control-Allow-Origin`; `*` is never sent on
the wire, and neither is `Access-Control-Allow-Credentials` — the client calls cross-origin
with `credentials: 'same-origin'` (`data_manager.js`), and the session cookie is
`SameSite=Lax`, so no cookie ever rides one of these requests whatever the calling page asks
for. A cross-origin caller is therefore ALWAYS unauthenticated and reaches only what the
API opens to an anonymous request; listing an origin does not grant it a session.

```bash
DEDALO_CORS_ALLOWED_ORIGINS=["https://archive.example.org","https://museum.example.org"]
```

**A PUBLIC ontology master sets the single entry `*`, meaning any origin.** It is the only
way to express a master that serves its manifest to installations you do not know in advance:
that set of client origins is unbounded, so it cannot be enumerated. `*` is a whole-list
sentinel, not a pattern — it simply wins over any other entry, and there is no
`*.example.org` form, because a suffix rule is the classic CORS bypass. The request origin
is still what gets echoed back, so `Vary: Origin` keeps meaning what it says.

What `*` changes is **who may ASK**: from "any HTTP client" — already true today, since CORS
is a browser rule and not a firewall — to "any HTTP client, plus any web page in a visitor's
browser". The surface it opens is the anonymous one `curl` already reaches: the update
manifest and the reachability probe (still behind the `ONTOLOGY_SERVER_CODE` access code
every client presents), plus login and password reset, which are throttled per client address
(`LOGIN_MAX_ATTEMPTS`) — note that a page running in a visitor's browser spends the
VISITOR's address against that throttle. Nothing authenticated is reachable either way, on
any setting. Use `*` on a deliberately public master; on an ordinary installation, name the
origins.

```bash
# public ontology master (IS_AN_ONTOLOGY_SERVER=true) serving unknown clients
DEDALO_CORS_ALLOWED_ORIGINS=["*"]
```

*Default: []*

---

### Defining lock components

DEDALO_LOCK_COMPONENTS `bool`

This parameter defines if Dédalo will lock / unlock components to avoid replacement data when more than one user edit the same component or Dédalo do not manage the user edition unlocking all components. By default Dédalo do not manage the editions (option false).

```bash
DEDALO_LOCK_COMPONENTS=false
```

*Default: true*

---

### Defining protect media files for external access

DEDALO_MEDIA_ACCESS_MODE `false | string`

This parameter defines if the directory of the media files (av, images, pdf, subtitles, ...) will be protected and controlled for undesired/external access. The full documentation, with the architecture, use cases, web server configuration and examples, is in [Media protection (media file access control)](./media_protection.md).

* `'publication'` (**default**) : logged-in users access everything; anonymous users access only media of published records in the configured public quality folders (see `DEDALO_MEDIA_PUBLIC_QUALITIES`)
* `'private'` : only logged-in Dédalo users can access media files
* `false` : no protection — media files are world-readable

**The default is fail-closed, and that is deliberate.** Until 2026-08-24 an install that
configured nothing served its whole media tree — unpublished records, master-quality
originals, rights-restricted material — to anyone who could guess a URL. `'publication'`
rather than `'private'` because on an install with no publications the two behave
identically, while `'private'` would later 404 the archive's own published site the day
diffusion writes its first marker.

Setting `false` is still a real choice and is honoured — an operator who deliberately
serves an open media tree said so. What is no longer honoured is silence.

**nginx installs must reload** after this takes effect (`nginx -t && nginx -s reload`);
the Apache `.htaccess` applies immediately. See the maintenance widget, which reports it.

```bash
DEDALO_MEDIA_ACCESS_MODE=publication
```

*Default: publication*

---

### Defining protect media files for external access

DEDALO_MEDIA_PUBLIC_QUALITIES `string[]` (optional)

The quality folders an **anonymous** visitor may read when the record is published (rule B).
A JSON array, or a comma-separated list. Leave it unset to derive the delivery-grade folders
from this installation's own quality catalog — `av/404`, `av/posterframe`, `av/subtitles`,
`image/1.5MB`, `image/thumb`, `pdf/web`, `svg/web`, `3d/web`.

Master and working qualities (`original`, `modified`) are **always refused, even if you list
them**: they are the source files, they are the large ones, and they are never public. A
refused entry is dropped and logged; it never silently becomes public and never aborts the boot.

```bash
# publish the larger image derivative too, and keep thumbnails private
DEDALO_MEDIA_PUBLIC_QUALITIES=["image/1.5MB","av/404","av/subtitles"]
```

*Default: (unset)*

---

### Declaring the NAT64 prefixes of an IPv6-only host

DEDALO_NAT64_PREFIXES `array`

Only for a server on an **IPv6-only network that reaches the IPv4 internet through a
NAT64 translator using its own network-specific prefix** (RFC 6052). Leave it empty
everywhere else — that is almost every installation.

Whenever the server fetches a URL on a user's behalf (an RDF import, a catalogue lookup,
a translation or transcription service, a harvest), it first checks that the address is on
the public internet. Behind a NAT64 translator an IPv6 address *inside the translator's
prefix* actually reaches the IPv4 address embedded in it — so with a provider prefix such
as `2001:db8:64::/96`, the address `2001:db8:64::a9fe:a9fe` is really `169.254.169.254`,
the cloud metadata endpoint, although it looks like an ordinary public IPv6 address.
Declaring the prefix here makes the check judge every address inside it by the IPv4
address it carries.

The well-known prefix `64:ff9b::/96` is always understood and needs no entry. The engine
also asks the network itself (the RFC 7050 `ipv4only.arpa` lookup) and uses what it
learns, but only to refuse MORE: an answer from a resolver is not your word, so a prefix it
reports never makes an otherwise-refused address acceptable. If your translator's prefix
is taken from the local-use block `64:ff9b:1::/48` or from a unique-local range such as
`fd00::/8` — those are the RANGES it comes from, not entries to copy — sites on the IPv4
internet are reachable only once you declare the translator's OWN prefix here, for example
`64:ff9b:1::/96`.

Each entry is the translator's prefix exactly as it is configured, of length 32, 40, 48, 56,
64 or 96 — the only lengths RFC 6052 defines (most translators use /96). Declare the length
the translator uses: the length decides which bytes carry the IPv4 address, so a /48 entry
for a /96 translator reads the wrong bytes and every IPv4 site it reaches is refused. An
entry of any other length (`fd00::/8` is one) is refused loudly: until it is fixed,
**every IPv6 destination is refused**, because the check can no longer tell which of them
lead into IPv4.

```bash
DEDALO_NAT64_PREFIXES=2001:db8:64::/96
```

*Default: []*

---

### Defining lock components notifications

DEDALO_NOTIFICATIONS `bool`

This parameter defines if Dédalo will notify to the user than other users are editing the same field in the same section when the user try to edit the field.

```bash
DEDALO_NOTIFICATIONS=false
```

*Default: false*

---

### Defining protect media files for external access

DEDALO_PROTECT_MEDIA_FILES `bool` (deprecated)

The legacy boolean is kept for back-compat: `true` behaves as `DEDALO_MEDIA_ACCESS_MODE='private'` when the new constant is not defined.

```bash
DEDALO_PROTECT_MEDIA_FILES=false
```

!!! note "The mode can also be set at runtime"
    The root user can change the mode from the **media_control** maintenance widget. That
    override is stored in `<private>/ts_state.json` and **wins over this key**, taking effect
    with no restart. If editing `.env` appears to do nothing, the widget reports the effective
    mode and where it came from.

*Default: false*

---

### Defining the upload session cache expiry

DEDALO_SESSION_CACHE_EXPIRE `int`

The lifetime, **in minutes**, that the upload service announces for a queued upload
session. The engine reports it with the rest of the system information, and the upload
panel displays it, so a user knows how long files that were uploaded but not yet saved
into a record remain available in the temporary upload directory.

Default `180` (3 hours). This value is what the interface announces — it does not by
itself prune the temporary upload directory, so keep it in step with whatever
housekeeping runs over `DEDALO_UPLOAD_TMP_SUBDIR`.

```bash
DEDALO_SESSION_CACHE_EXPIRE=180
```

*Default: 180*

---

### Defining single-session (one active session per user)

DEDALO_SINGLE_SESSION `bool`

Restricts each user to ONE active session. When `true`, a successful login evicts every
other session that user already holds (keeping only the one just created) — so logging in
again anywhere immediately invalidates a token stolen earlier, closing the re-login window
(security finding AUTHZ-04). A password reset already revokes all of a user's sessions
regardless of this flag; this key extends that guarantee to ordinary re-login.

Default `false`: concurrent sessions are allowed, so the same user can stay logged in on
several devices at once. Set it `true` for a stricter, single-device policy — at the cost
that a new login logs the user out everywhere else.

```bash
DEDALO_SINGLE_SESSION=false
```

*Default: false*

---

### Defining the account-wide login attempt limit

LOGIN_ACCOUNT_MAX_ATTEMPTS `int`

The second dimension of the login throttle: how many failed logins one **user name**
may accumulate inside `LOGIN_ATTEMPT_WINDOW` **from any address at all**, before that
account is locked for `LOGIN_LOCKOUT_SECONDS`. It is what stops an attacker who rotates
addresses (every new address gets a fresh per-address bucket, but they all share this one).

It is deliberately much higher than `LOGIN_MAX_ATTEMPTS` (default `50` against `10`),
and it should stay that way: a low account-wide limit lets anyone lock a colleague out of
their own account with a burst of wrong passwords — a denial of service you inflict on
yourself. Set it very high to effectively disable this dimension and rely on the
per-address limit alone.

```bash
LOGIN_ACCOUNT_MAX_ATTEMPTS=50
```

*Default: 50*

---

### Defining the source-wide login attempt limit

LOGIN_SOURCE_MAX_ATTEMPTS `int`

The third dimension of the login throttle: how many failed logins one **address**
may accumulate inside `LOGIN_ATTEMPT_WINDOW` **whatever user name they name**, before
that address is refused for `LOGIN_LOCKOUT_SECONDS`.

The other two dimensions both start from the user name, so a caller who ROTATES the name
got a fresh bucket on both at every request: they bounded guessing against an account and
did nothing at all about VOLUME from one source — which is how one unauthenticated client
could keep the engine writing denial rows for as long as it liked (audit 2026-08-26
SEC-21).

It is a FLOOD ceiling, not a guessing ceiling: it must never refuse a shared address doing
ordinary work — a museum behind one NAT, a reading room, a proxy. Raise it if a large
institution shares one address; at the default, that many failed logins from one address
inside the window is not a person mistyping a password.

```bash
LOGIN_SOURCE_MAX_ATTEMPTS=100
```

*Default: 100*

---

### Defining the login attempt window

LOGIN_ATTEMPT_WINDOW `int`

The sliding window, **in seconds**, over which failed logins are counted for both
throttle limits (`LOGIN_MAX_ATTEMPTS` and `LOGIN_ACCOUNT_MAX_ATTEMPTS`). A failure
older than the window no longer counts against anyone, and is deleted from the store
once it can no longer influence a decision.

Default `900` (15 minutes). A longer window makes the throttle stricter — failures
spread over a slow, patient attack still add up.

```bash
LOGIN_ATTEMPT_WINDOW=900
```

*Default: 900*

---

### Defining the login lockout time

LOGIN_LOCKOUT_SECONDS `int`

How long, **in seconds**, a login stays refused once a throttle limit has been reached.
The lock lifts this long after the most recent counted failure; a successful login clears
the counters immediately, so a user who finally remembers the password is not kept waiting.

Default `900` (15 minutes). Raising it slows a brute-force attempt further; lowering it
mostly buys convenience for people who mistype.

```bash
LOGIN_LOCKOUT_SECONDS=900
```

*Default: 900*

---

### Defining the login attempt limit per address

LOGIN_MAX_ATTEMPTS `int`

How many failed logins the same user name may accumulate **from the same client
address** inside `LOGIN_ATTEMPT_WINDOW` before further attempts are refused for
`LOGIN_LOCKOUT_SECONDS`. A successful login clears the counter at once.

Default `10` — room for a run of typos, nowhere near enough for a password-guessing
attack. Note that the client address is taken from the trusted reverse-proxy hop
(`TRUSTED_PROXY_HOPS`): if that number is wrong, every request looks like it comes from
your proxy and one user's mistakes will lock out everybody.

```bash
LOGIN_MAX_ATTEMPTS=10
```

*Default: 10*

---

### Defining protect media files for external access

MEDIA_HTACCESS_ADDONS `string[]` (optional, Apache only)

Raw Apache rewrite directives appended to the generated `.htaccess` immediately before the
final deny rule. You own their syntax; Dédalo only places them.

The value is **JSON only** — a directive legitimately contains commas (`[R=404,L]`), so a
comma-separated list would tear one directive into two invalid ones. That means **every
backslash must be doubled** for JSON. A malformed value is refused and logged
(`[config] MEDIA_HTACCESS_ADDONS must be a JSON array of strings — ignoring the value.`);
your lines are dropped, and the access gate itself is unaffected and stays closed.

```bash
# allow an internal network unconditionally (note the doubled backslashes)
MEDIA_HTACCESS_ADDONS=["RewriteCond %{REMOTE_ADDR} ^10\\.0\\.","RewriteRule ^ - [L]"]
```

*Default: []*

---

### Defining the permissions cache lifetime

PERMISSIONS_CACHE_TTL_SECONDS `int`

Each user's permission table — the grants their profile gives them over sections and
components — is resolved from the database once and then kept in memory. Saving a profile
or changing a user's profile drops the cached table immediately, so a grant change is
normally visible on the next request.

This key is the **backstop**, in seconds: it caps how long a *missed* invalidation can
keep serving stale permissions. A grant changed by a different process (a second engine
instance, a background worker) cannot reach this process's memory, and the time limit is
what eventually corrects it. Default `300` (5 minutes). Lower it if several processes
share one database and you want a tighter bound; set `0` to disable the time limit and
rely on explicit invalidation alone.

```bash
PERMISSIONS_CACHE_TTL_SECONDS=300
```

*Default: 300*

---

### Defining the absolute session lifetime

SESSION_ABSOLUTE_TTL_SECONDS `int`

The hard ceiling, in seconds, on a session's life **counted from the moment it was
created** — regardless of how active it has been. It exists because an idle limit alone
(`SESSION_TTL_SECONDS`) never expires a session that is used at least once per window:
a stolen cookie would live forever, and a browser left open on a workstation renews itself
indefinitely through the client's own background polling.

Default `43200` (12 hours): a session spans one working day and then dies on its own,
whatever the user was doing. Set `0` to disable the absolute cap and keep the idle limit
only — NOT recommended, that is the "lives forever" case above.

Long-running work is NOT affected. A background import keeps its requesting user on the
job record and never re-reads the session (`core/tools/background.ts`), and diffusion
re-derives the enqueuing principal from `owner_user_id` at run time (`diffusion/runner.ts`,
DIFF-01), so publication and massive imports survive their owner's logout by construction.

```bash
SESSION_ABSOLUTE_TTL_SECONDS=43200
```

*Default: 43200*

---

### Defining the Secure flag of the session cookie

SESSION_COOKIE_SECURE `bool`

Marks the session cookie `Secure`, so the browser only ever sends it back over HTTPS
(the media access cookie carries the same posture). It is `true` by default and it should
stay `true` on anything reachable over a network: a session cookie that travels once in
clear text is a session an eavesdropper can replay.

Only the exact value `false` turns it off. The single legitimate reason is a plain-HTTP
development listener on localhost — a browser silently discards a `Secure` cookie over
`http://`, so login there appears to succeed and then does nothing. Never set it on a
server that anyone else can reach; terminate TLS at the web server instead.

```bash
SESSION_COOKIE_SECURE=true
```

*Default: true*

---

### Defining the session idle timeout

SESSION_TTL_SECONDS `int`

How long, in seconds, a session survives **without being used**. Every authenticated
request refreshes it; a session left untouched for longer than this is destroyed and the
user must log in again.

Default `3600` (1 hour): an unattended browser is the real threat, and an hour of no
requests at all means nobody is there. The separate `SESSION_ABSOLUTE_TTL_SECONDS` caps
the total life of a session that is being used continuously.

This value also bounds the media access cookie: `dedalo_media_auth` is re-issued with
this same `Max-Age` on every authenticated request, so the media credential can never
outlive the session that earned it (`core/media/protection.ts`).

```bash
SESSION_TTL_SECONDS=3600
```

*Default: 3600*

---

### Defining the pre-expiry warning window

SESSION_WARNING_SECONDS `int`

How many seconds before a session expires the client warns the user, so unsaved work
can be committed (or the session extended — any request extends it) instead of the next
click failing. Every authenticated response carries `session_expires_in`; the client
warns once that value drops below this threshold.

Default `300` (5 minutes). Set `0` to disable the warning: expiry then surfaces only
through the re-login modal, which the client already raises on the `not_logged` error.

```bash
SESSION_WARNING_SECONDS=300
```

*Default: 300*

---

## Server and runtime {#server}

### Declaring that a process supervisor is present

DEDALO_SUPERVISED `true` (process environment only; unset = not supervised)

A code update replaces the installation tree and then exits the server process, so that
it comes back up running the new code. That only works if **something restarts it**. To
avoid taking the server down for good, the update refuses to run unless the process was
started with `DEDALO_SUPERVISED=true`.

The key is **declared by the process manager that restarts the server**, never written into
the configuration file. Every shipped runtime definition already carries it: the reference
systemd unit (`Environment=DEDALO_SUPERVISED=true`), the Docker Compose stacks
(`environment:`), and the `start:supervised`, `dev` and `dev:server` scripts, which
relaunch the server when it asks for a restart. A unit or stack you wrote yourself needs the
same line.

A value in `../private/.env` is **ignored**: that file is read by every launch method,
including `bun run start`, which is deliberately unsupervised — nothing relaunches it. The
refusal names the ignored line when it finds one. Nor is supervision guessed from the service
manager's own variables: those are inherited by every process started under it, terminal
shells included.

Declaring `true` on a process that nothing restarts is the one dangerous mistake here:
the update will swap the code, exit, and the server will stay down until you start it
by hand.

```bash
# systemd unit, [Service] section:   Environment=DEDALO_SUPERVISED=true
# compose service, environment: map: DEDALO_SUPERVISED: "true"
# inside a shell loop that relaunches the server when it exits:
DEDALO_SUPERVISED=true bun run src/server.ts
```

*Default: (unset)*

---

### Defining the request idle timeout

SERVER_IDLE_TIMEOUT_S `int`

How many seconds a request may stay idle before the engine drops the connection. It
applies to both listeners, and it is clamped to the range 1–255.

Default `255` (the maximum): deliberately generous, because the previous silent 10-second
default killed slow but perfectly legitimate work — large exports, wide searches, long tool
actions — in the middle of the handler.

Whatever you choose, **the web server in front must be at least as patient**: a reverse-proxy
read timeout shorter than your slowest legitimate request re-introduces exactly the same
failure one hop earlier (in nginx, `proxy_read_timeout`).

```bash
SERVER_IDLE_TIMEOUT_S=255
```

*Default: 255*

---

### Defining the maximum request body size

SERVER_MAX_BODY_BYTES `int`

The ceiling, in bytes, on the body of any single request the engine accepts. Every body
is buffered whole in a long-lived process, so an unbounded one is a memory-exhaustion
hazard — this is the cap that bounds it.

Default `268435456` (256 MiB). It does **not** limit the size of a media file: the client
always uploads large files in chunks, so a single request only ever has to carry one chunk.
The per-file limit is `DEDALO_UPLOAD_MAX_SIZE_BYTES`, and the chunk size is
`DEDALO_UPLOAD_SERVICE_CHUNK_FILES`.

Raise it only if a legitimate single request genuinely needs more, and remember the web
server has its own limit — in nginx, `client_max_body_size` — which will reject the request
first if it is lower.

```bash
SERVER_MAX_BODY_BYTES=268435456
```

*Default: 268435456*

---

### Defining the shutdown grace period

SERVER_SHUTDOWN_GRACE_MS `int`

When the server is asked to stop — a service restart, a deploy, a Ctrl-C — it stops
accepting new connections and then **drains the requests already in flight** for up to this
many milliseconds before it closes the database pool, removes the socket file and exits.
Users mid-save are not cut off by a routine restart.

Default `10000` (10 seconds). Raise it if your slowest legitimate request is longer and you
want it to survive a restart; `0` exits immediately and abandons whatever was running.

Keep it **below** the stop timeout of whatever supervises the process, or the supervisor
will kill the server before the drain has finished — which defeats the purpose.

```bash
SERVER_SHUTDOWN_GRACE_MS=10000
```

*Default: 10000*

---

### Defining the development TCP port

SERVER_TCP_PORT `int` (optional; development only)

When set, the engine opens an **additional** plain-HTTP listener on this port, on top of
the unix socket, and the client is reachable at `http://localhost:<port>/dedalo/core/page/`.
It exists because a browser cannot talk to a unix socket directly, so a developer would
otherwise need a web server in front of every local checkout.

Leave it **unset in production**. This listener terminates no TLS, and it is the only one
that will serve media straight from the engine when media protection is unconfigured — with
no per-record access control. A production install serves on the socket only, behind the
reverse proxy that owns TLS, the static files and the media.

```bash
SERVER_TCP_PORT=3000
```

*Default: (unset)*

---

### Defining the server socket

SERVER_UNIX_SOCKET `string`

The unix socket the engine listens on. In production this is the **only** listener: the web
server owns TCP and TLS, serves the client files and the media, and forwards the API and the
dynamic routes to this socket.

Default `/tmp/dedalo_ts.sock`. On a system that cleans `/tmp`, prefer a directory of your
own (`/run/dedalo/`). The path must be writable by the user the engine runs as and reachable
by the user the web server runs as — a socket neither can open is the usual cause of a
"bad gateway" that looks like the engine is down.

If the file already exists at start-up the engine probes it: when a live instance answers,
it **refuses to start** rather than quietly steal the running server's socket; a leftover
file from an unclean stop is removed.

```bash
SERVER_UNIX_SOCKET="/run/dedalo/dedalo_ts.sock"
```

*Default: /tmp/dedalo_ts.sock*

---

### Defining which transport may be believed about the client address

TRUSTED_PROXY_TRANSPORT `socket | tcp | none`

Which of this engine's listeners sits behind the reverse proxy, and therefore
whose `X-Forwarded-For` header may be believed.

`X-Forwarded-For` is a request **header**: anything that can open a connection can write
it. It is trustworthy only because a proxy is known to have rewritten it — so it is read
on one transport and ignored on the other, and on the other the connection's own peer
address is used instead.

* `socket` (**default**) — the unix socket (`SERVER_UNIX_SOCKET`), which only the local
  reverse proxy can open. This is the documented production topology.
* `tcp` — a proxy really does stand in front of `SERVER_TCP_PORT`. Set this ONLY when
  that is true: on a port a browser reaches directly, it lets any client choose its own
  address.
* `none` — never read the header. Every request is attributed to its peer address.

Until 2026-08-24 the header was read on every listener, so on the direct TCP port a client
could pick the address used for the login throttle (a fresh brute-force bucket per
request), for `dd544` activity rows, and for any check that matches a literal loopback
address. The address is used for throttling and audit; the hop arithmetic is
`TRUSTED_PROXY_HOPS`.

```bash
TRUSTED_PROXY_TRANSPORT=socket
```

*Default: socket*

---

### Defining the number of trusted proxy hops

TRUSTED_PROXY_HOPS `int`

How many reverse proxies stand between the internet and the engine. Each one **appends**
the address it received the request from to the `X-Forwarded-For` header, so the genuine
client address is the entry this many positions **from the right**. Everything further to the
left was supplied by the caller and can be forged freely.

The engine uses that address for the login throttle and for audit records — never as an
authorization input. Set it to exactly the number of proxies that append the header; the
default `1` matches the standard single web server in front. Both mistakes hurt:

* **Too high** — you start trusting an entry the caller wrote. An attacker sends a new forged
  address on every attempt, gets a fresh login-throttle bucket each time, and the brute-force
  protection is gone.
* **Too low** — every request appears to come from your own proxy. All users share one throttle
  bucket, so one person's wrong passwords lock out everybody.

Your proxy must *append* rather than replace (in nginx,
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`), or the count is meaningless.

```bash
TRUSTED_PROXY_HOPS=1
```

*Default: 1*

---

## Outbound email and password recovery {#mailer}

Dédalo relays outbound email (password-recovery codes) through an existing mailbox over SMTP — it never runs its own mail server. Leaving `DEDALO_SMTP_HOST` empty disables sending entirely, which also disables the login screen's password-recovery emails.

### Defining the SMTP server

DEDALO_SMTP_HOST `string`

The hostname of the SMTP server Dédalo relays outbound email through (recovery
codes, notifications). Leaving it empty **disables the mailer entirely** — features
that need email (the login screen's password recovery) will silently skip sending.

```bash
DEDALO_SMTP_HOST="smtp.example.org"
```

*Default: (empty)*

---

### Defining the SMTP port

DEDALO_SMTP_PORT `int`

The TCP port of the SMTP server. The default `587` is the submission port used
with STARTTLS; use `465` with `DEDALO_SMTP_SECURE='ssl'` for implicit TLS.

```bash
DEDALO_SMTP_PORT=587
```

*Default: 587*

---

### Defining the SMTP encryption mode

DEDALO_SMTP_SECURE `string`

How the SMTP connection is encrypted:

* `'tls'` : STARTTLS on a plain connection (default, pairs with port 587)
* `'ssl'` : implicit TLS from the first byte (pairs with port 465)
* `'none'` : no encryption — only ever acceptable for a relay on localhost

```bash
DEDALO_SMTP_SECURE=tls
```

*Default: tls*

---

### Defining the SMTP credentials

DEDALO_SMTP_USER `string`

The SMTP AUTH username (usually the mailbox login). Leave it empty for a relay
that accepts unauthenticated mail (e.g. a local MTA).

```bash
DEDALO_SMTP_USER="dedalo@example.org"
```

*Default: (empty)*

---

### Defining the SMTP credentials

DEDALO_SMTP_PASS `string`

The SMTP AUTH password for `DEDALO_SMTP_USER`. Ignored when the user is empty.

```bash
DEDALO_SMTP_PASS="my_smtp_password"
```

*Default: (empty)*

---

### Defining the From address

DEDALO_SMTP_FROM `string`

The envelope/header From address of outbound mail. It must be an address the
relay is allowed to send as (most providers refuse arbitrary senders). When empty,
`DEDALO_SMTP_USER` is used; if both are empty the mailer refuses to send.

```bash
DEDALO_SMTP_FROM="dedalo@example.org"
```

*Default: (empty)*

---

### Defining the From address

DEDALO_SMTP_FROM_NAME `string` (optional)

An optional display name shown next to the From address.

```bash
DEDALO_SMTP_FROM_NAME="Dédalo"
```

*Default: (empty)*

---

### Defining the password recovery code lifetime

DEDALO_PWRESET_CODE_TTL `int`

How long, **in seconds**, an emailed password-recovery code stays valid. The code
is single-use and its short life is part of what makes the 8-digit space safe, so
keep this small. Default `600` (10 minutes).

```bash
DEDALO_PWRESET_CODE_TTL=600
```

*Default: 600*

---

### Defining the password recovery attempt cap

DEDALO_PWRESET_MAX_ATTEMPTS `int`

How many wrong guesses are allowed against a single issued recovery code before
it is invalidated and the user must request a new one. Together with the short
`DEDALO_PWRESET_CODE_TTL` this caps brute-force odds against the 8-digit code at
a few in a hundred million. Default `5`.

```bash
DEDALO_PWRESET_MAX_ATTEMPTS=5
```

*Default: 5*

---

## Logs, backups and diagnostics {#ops}

### Defining the access log

DEDALO_ACCESS_LOG `bool`

With `true`, the engine writes **one JSON line per API request** to its standard output:
timestamp, request id, user id, the API class and action that was called, the response status
and the duration in milliseconds. A service manager captures it with the rest of the service
log, so it can be filtered and parsed with the usual tools.

Off by default: it is a line per request, and on a busy installation that is a lot of lines.
Turn it on when you need to see who called what — a suspicious edit, a user reporting an error
they cannot reproduce — and turn it off again afterwards.

Slow requests are warn-logged whatever this is set to (see `DEDALO_SLOW_REQUEST_MS`), so you
do not need the access log merely to notice that something is slow.

```bash
DEDALO_ACCESS_LOG=false
```

*Default: false*

---

### Defining the database backups directory

DEDALO_BACKUP_DIR `string`

Where the database dumps produced by the maintenance backup tool (and by a scheduled
nightly backup job) are written. Unset, they go to `backups/db` inside the private directory,
next to the configuration file and the session store.

Set it to move the dumps onto another volume: a backup that lives on the same disk as the
database it came from is not a backup. The directory must be writable by the user the engine
runs as, and it must never sit inside the tree the web server publishes — a dump is a complete,
unprotected copy of your data.

Remember that the database dump is only one piece: the media originals and the private directory
have to be copied too, or a restore will bring back records that point at files that no longer
exist. This key is distinct from `DEDALO_BACKUP_PATH`, which is where a code update stages the
previous code tree.

The engine's restore door (`bun scripts/restore.ts <artifact>`, run with the engine stopped) is
the way back: it proves the artifact by a full read, restores it in one transaction beside the
current database and swaps the two by name. Each run writes its report to a `restores/`
directory inside this one.

```bash
DEDALO_BACKUP_DIR="/srv/backups/dedalo/db"
```

*Default: (unset)*

---

### Defining backups directory

DEDALO_BACKUP_PATH `string`

This parameter defines the directory a code update stages the previous tree into
before swapping in a new release, so a failed update can be rolled back. Keep it
outside the served tree for security. Defaults to `<install>/../backups/code`.
This is distinct from `DEDALO_BACKUP_DIR`, which sets the directory for database
backups (see [Database connection](config_db.md)).

```bash
DEDALO_BACKUP_PATH="/srv/dedalo/backups/code"
```

*Default: (unset)*

---

### Defining backup time range

DEDALO_BACKUP_TIME_RANGE `int`

This parameter is the **freshness threshold**, in hours, applied to database backups: it
decides when an existing backup is judged too old. It schedules NOTHING — no engine event, a
user login included, ever starts a backup.

Making the backups is the operating system's job — a nightly timer, described under
[Backups](../management/backup.md). What this value decides, verified against the code on
2026-08-30, is:

- **Whether a code update may proceed.** Applying a code release is REFUSED when the newest
  dump in the backup directory is older than this many hours, or when there is none at all:
  a code swap's rollback contract leans on there being a database to come back to. The
  operator can waive the refusal explicitly, and the update panel shows the same verdict
  before they start.
- **Whether the maintenance "Make backup" button would skip.** It never does today: that
  button always forces a dump, so the throttle it belongs to is not reached.

Age is judged by the modification time of the newest backup that PostgreSQL's own
`pg_restore` can read back end to end. A dump that is cut short, or whose read did not finish
within its time budget (see `DEDALO_BACKUP_VERIFY_SECONDS_PER_GB`), does not count, however
recent it is. Keep the value in step with how often the nightly job actually runs — set it
below the real interval and the updater refuses on an installation that is backing up
perfectly well.

```bash
DEDALO_BACKUP_TIME_RANGE=8
```

*Default: 8*

---

### Defining the backup verification budget

DEDALO_BACKUP_VERIFY_SECONDS_PER_GB `int`

How long the engine may spend proving that a database backup can be restored, in
**seconds per gigabyte** of dump. Before a backup counts — for the code updater's "is there a
recent backup" check, for the update panel, and for a dump the maintenance button just made —
the engine reads the whole archive back with PostgreSQL's `pg_restore`, because only a full
read can tell a complete dump from one that stopped part way. That read gets this many seconds
for every started gigabyte, and never less than one minute.

A read that does not finish within its budget proves nothing, so that backup does **not**
count: the code updater refuses (it can still be waived explicitly) and says so, naming this
key. On an installation whose backups live on slow storage (a network share, a USB disk), raise
the value until the read fits; a verification that succeeded is remembered, so the cost is paid
once per backup file.

```bash
DEDALO_BACKUP_VERIFY_SECONDS_PER_GB=60
```

*Default: 60*

---

### Defining debug detail for API errors

DEDALO_DEBUG_API_ERRORS `bool` (optional; development only)

When a request fails unexpectedly, the client is answered with a generic message and a
**request id**, while the exception text stays on the server, logged under that same id. This
is deliberate: the raw text of an error can carry query fragments, filesystem paths and internal
identifiers, and the request id is what lets you find the full story in the log without handing
any of it to the caller.

Set `DEDALO_DEBUG_API_ERRORS=true` and the exception text is **also** echoed in the response.
It is a convenience while developing, and a gift to an attacker anywhere else — every failed
request becomes a free description of your internals.

Unset (off) is the default and the only correct value on a shared or public installation.

```bash
DEDALO_DEBUG_API_ERRORS=true
```

*Default: false*

---

### Defining development mode

DEDALO_DEV_MODE `bool`

Marks this installation as a development server. With `true`, the client is told
it is talking to a development server so it takes the no-cache path instead of the offline
service-worker one, the readable, non-minified versions of the client libraries are served,
and the dev-only client libraries the browser test harness needs (mocha/chai) are served. The configuration widget in the maintenance
area reports the mode it resolved, so you can always check what a running server thinks it is.

This key is the SERVER's posture only. It does NOT control the debug/developer surfaces in the
interface (the info bar, the ontology/inspector shortcuts): those follow the LOGGED USER — a
user flagged `is_developer` in their record sees them, root (superuser) included. A
non-developer gets neither even on a development server — the surfaces follow the person, not
the box.

Default `false`, the production posture. Never `true` on a shared or public installation: it
switches the client off the offline cache and serves unminified libraries.

The real environment wins over the configuration file, so a single development run can be marked
without editing anything:

```bash
DEDALO_DEV_MODE=true bun run dev
```

*Default: false*

---

### Defining the export files directory

DEDALO_EXPORT_ARTIFACTS_DIR `string`

This parameter defines where the export tool builds the files a user downloads.

An export runs on the server as a background job: it walks every selected record, writes the
result to a working copy in this directory, and builds each download (CSV, TSV, HTML, XLSX, ODS,
the lossless NDJSON and the media ZIP) from that copy. Each user has a subdirectory of their own
and each export one more below it; only the user who ran an export can download its files.

Unset, the files go to `export_artifacts` inside the private directory. Point it at another
volume when exports are large: a full export of a big collection with many columns can take
gigabytes while it exists, and it is only ever temporary (see
`DEDALO_EXPORT_ARTIFACTS_TTL_HOURS`). The directory must be writable by the user the engine
runs as and must NEVER sit inside a tree the web server publishes — an export is a copy of your
records, and it is served only through the engine, after the owner and their read access have
been checked again. The engine enforces this: a directory that is, sits inside, or contains the
media directory, the client files or a tool directory (the in-repo tools and every
`DEDALO_ADDITIONAL_TOOLS` path — the engine serves those without a login) (symbolic links followed)
is refused, and no export is written until it is moved; the refusal is logged at start-up.

Give it a directory of its own, empty or not yet created. The engine deletes expired exports
here every hour, so it only works in a directory it owns: on first use it leaves a
`.dedalo_export_artifacts` marker file in an empty directory. A directory that already
holds other files and has no marker is refused, and nothing in it is written or deleted.

Each installation needs its OWN directory. The marker records which installation claimed it
(a fingerprint of its database), and a directory another installation's marker names is
refused by every door — listing, preview, download, sweep — so two instances that copied the
same example path never see or delete each other's exports.

```bash
DEDALO_EXPORT_ARTIFACTS_DIR="/srv/dedalo_exports"
```

*Default: `<private dir>/export_artifacts`*

---

### Defining the export storage quota per user

DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES `int`

This parameter defines how many bytes of export files one user may hold at the same time.

Every export a user runs keeps its working copy and its built files on the server until they
expire. When a new export, or a new file of an existing one, would take the user past this
amount, it is refused with a message that says so, and succeeds again once the user deletes an
older export from the export tool (Delete export, which removes it with all its files) or older
exports have expired. Ten gigabytes by default, which holds several complete exports of a large
collection.

The quota counts all of a user's exports together, including several running at the same time.

Set `0` to switch the quota off. Size the volume of `DEDALO_EXPORT_ARTIFACTS_DIR` for this
amount times the number of users who export at once.

```bash
DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES=10737418240
```

*Default: 10737418240*

---

### Defining how long export files are kept

DEDALO_EXPORT_ARTIFACTS_TTL_HOURS `int`

This parameter defines how many hours the files of a finished export are kept before they
are deleted.

An export expires this many hours after it FINISHED (ended, failed, was stopped or was
interrupted). It is a hard limit: building a file from the export later (a spreadsheet, a media
zip) does NOT extend it, so a file built an hour before the limit disappears with the export. From
that moment the export and its files are gone for their owner (preview, list and downloads answer
not-found at once), and the sweep — when the engine starts and every hour after that — deletes
the directory; it only waits while a file is still being built from it. An export still running is never touched while the server running it is alive; one left behind
by a server that stopped or restarted is marked interrupted and its partial files are removed
(the user runs it again). Twenty-four hours by default: long enough to come back
the next day for a download, short enough that copies of the collection do not pile up on the
server. Values below 1 are raised to 1.

```bash
DEDALO_EXPORT_ARTIFACTS_TTL_HOURS=24
```

*Default: 24*

---

### Defining how many exports one user may keep

DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS `int`

This parameter defines how many exports one user may keep on the server at the same time.

The storage quota (`DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES`) counts bytes, and a tiny export
takes almost none: without this limit one user could keep a very large number of small exports,
and every listing of their exports would have to read all of them. When a new export would go
past this number it is refused with a message that says so, and succeeds again once the user
deletes an older export from the export tool or older exports have expired. One hundred by
default, far more than anyone needs within the lifetime of an export
(`DEDALO_EXPORT_ARTIFACTS_TTL_HOURS`).

Set `0` to switch the limit off.

```bash
DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS=100
```

*Default: 100*

---

### Defining the free space exports always leave on their volume

DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES `int`

This parameter defines how many bytes must always stay free on the volume that holds the export
files (`DEDALO_EXPORT_ARTIFACTS_DIR`).

The storage quota is per user, so several users together can hold far more than one quota. By
default the export files live inside the private directory, next to the session store and the
installation's settings: if that volume filled up, logins and saved settings would fail for
everyone. So an export, or a file built from one, that would leave less than this amount free
is refused (and one already writing stops) with a message saying the server is short of space,
whatever the users' quotas. One gigabyte by default.

Set `0` to switch the check off (only when the export directory is on a volume of its own).

```bash
DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES=1073741824
```

*Default: 1073741824*

---

### Defining the export preview page size

DEDALO_EXPORT_PREVIEW_PAGE_SIZE `int`

This parameter defines how many records the export tool shows per page in its preview when
the user has not chosen a size.

The preview shows one page of the export at a time, whatever the size of the export, so the
browser stays responsive with hundreds of thousands of records; the downloads always contain
every record. One hundred by default. The value is kept between 1 and 200, the most the preview
will ever draw at once.

```bash
DEDALO_EXPORT_PREVIEW_PAGE_SIZE=100
```

*Default: 100*

---

### Defining how many export jobs one user may queue

DEDALO_EXPORT_JOBS_PER_USER `int`

This parameter defines how many export jobs one user may have waiting or running at the same
time: exports being built plus files being built from them.

Export jobs share two queues (see `DEDALO_JOB_LANE_EXPORT_CONCURRENCY` and
`DEDALO_JOB_LANE_EXPORT_FILE_CONCURRENCY`), so without a limit one user could queue many complete
exports of a large collection and make everybody else wait behind them.
A request over the limit is refused at once with a message that says so, and nothing is queued;
the user can start it again when one of their jobs has finished. Two by default: an export being
built and a file being built from an earlier one. Exports still being built never block
downloading a file of an export that has already finished: a file build is counted only against
the user's other file builds.

```bash
DEDALO_EXPORT_JOBS_PER_USER=2
```

*Default: 2*

---

### Defining the export job deadline

DEDALO_JOB_DEADLINE_EXPORT_S `int`

This parameter defines how long, in seconds, an export job may run before Dédalo cancels it.

There is NO deadline by default (`0`): a complete export of a large collection with deep
relations is legitimately long work, the user who started it can stop it at any time, and a
deadline that cancelled it near the end would throw that work away.

Set it on an installation that knows its own ceiling, to turn an export that has stopped making
progress into a reported one instead of a lane that stays busy.

```bash
DEDALO_JOB_DEADLINE_EXPORT_S=0
```

*Default: 0*

---

### Defining the export file job deadline

DEDALO_JOB_DEADLINE_EXPORT_FILE_S `int`

This parameter defines how long, in seconds, a job that builds a file from a finished export
(a CSV, spreadsheet, HTML page or media ZIP) may run before Dédalo cancels it.

There is NO deadline by default (`0`): a media ZIP of a large selection copies every media file
into the archive, which is legitimately long, and the user who started it can stop it at any time.

```bash
DEDALO_JOB_DEADLINE_EXPORT_FILE_S=0
```

*Default: 0*

---

### Defining the maintenance job deadline

DEDALO_JOB_DEADLINE_MAINTENANCE_S `int`

This parameter defines how long, in seconds, a maintenance job may run before Dédalo cancels it.

Maintenance jobs are the work an administrator starts: a code or data update, a cache rebuild, a
bulk import, a value propagated across records. Six hours by default, which is generous for a
full cache rebuild of a large collection and far more than any update needs. A job that passes
its deadline is asked to stop and its record is marked stopped, so the lane is not held for ever
by work that will never finish.

Set it to `0` to switch the deadline off, on an installation whose imports legitimately run
longer than the default. Raise it rather than switching it off if you can name the ceiling: a
deadline is what turns a wedged job into a reported one.

```bash
DEDALO_JOB_DEADLINE_MAINTENANCE_S=21600
```

*Default: 21600*

---

### Defining the media job deadline

DEDALO_JOB_DEADLINE_MEDIA_S `int`

This parameter defines how long, in seconds, a media job may run before Dédalo cancels it.

There is NO deadline by default (`0`), and that is deliberate: transcoding a master video is
legitimately hours of work, and a deadline that killed it would be the fault, not the guard.

Set it on an installation that knows its own ceiling — if nothing you hold should ever take more
than two hours to convert, `7200` turns a stuck conversion into a reported one instead of a lane
that stays busy for ever. Note that the cancellation reaches the job itself; a conversion program
already running as a separate process finishes its own work, and the fact that it is still
holding its lane is reported in the counters.

```bash
DEDALO_JOB_DEADLINE_MEDIA_S=0
```

*Default: 0*

---

### Defining the index job deadline

DEDALO_JOB_DEADLINE_RAG_S `int`

This parameter defines how long, in seconds, an index-building job may run before Dédalo
cancels it.

These are the jobs that compute the semantic index used by assisted search and by object
identification. One hour by default, which comfortably covers a pass over a single group of
records. A job that passes its deadline is asked to stop and its record is marked stopped.

Set it to `0` to switch the deadline off, or raise it when you index very large groups in one
go.

```bash
DEDALO_JOB_DEADLINE_RAG_S=3600
```

*Default: 3600*

---

### Defining the transcription job deadline

DEDALO_JOB_DEADLINE_TRANSCRIPTION_S `int`

This parameter defines how long, in seconds, a transcription job may run before Dédalo
cancels it.

Transcription jobs wait on the speech-to-text service, so they are mostly idle time; four hours
by default, which covers a long interview with room to spare. A batch that runs longer than this
is almost always a service that has stopped answering rather than work still in progress, and
the deadline turns that into a stopped job with a reason instead of a lane held for ever.

Set it to `0` to switch the deadline off.

```bash
DEDALO_JOB_DEADLINE_TRANSCRIPTION_S=14400
```

*Default: 14400*

---

### Defining export job concurrency

DEDALO_JOB_LANE_EXPORT_CONCURRENCY `int`

This parameter defines how many export jobs Dédalo will run at the same time.

Background work in Dédalo runs in lanes, and each class of work has its own budget of
simultaneous jobs. Exports have a lane of their own because any user who can read a section can
start one: a large export must never hold up the maintenance work an administrator is waiting
on, nor the media conversions of an upload.

One by default. An export reads every selected record and writes a working copy the size of the
result, so two at once mostly share the same database and disk; the others wait their turn and
their users see them queued. Raise it on a machine with cores and disk to spare. Values below 1
are raised to 1.

```bash
DEDALO_JOB_LANE_EXPORT_CONCURRENCY=1
```

*Default: 1*

---

### Defining export file job concurrency

DEDALO_JOB_LANE_EXPORT_FILE_CONCURRENCY `int`

This parameter defines how many files Dédalo will build from finished exports at the same time
(the CSV, TSV, HTML, spreadsheet, NDJSON and media ZIP downloads).

These jobs have a lane of their own, separate from the exports themselves. If they shared one
queue, every user's download would wait behind someone else's complete export of a large
collection. The CSV, TSV, HTML, spreadsheet and NDJSON files read only the finished export, never
the database, and usually take seconds where an export can take hours. The media ZIP is
different: for every record it reads the database again (the record's access and its stored
media) and it copies every media file, so on a large selection it can run for hours and keeps
database connections busy all that time. Size this value, and the database pool, with that in
mind.

Two by default, so one large media ZIP does not make the next user's CSV wait. To keep that true
whoever submits, one user may hold every slot of this lane but one (with the default two: one file
at a time per user); a second file from the same user is refused until the first finishes. With
the value 1 the single slot is shared first come, first served. Values below 1 are raised to 1.

```bash
DEDALO_JOB_LANE_EXPORT_FILE_CONCURRENCY=2
```

*Default: 2*

---

### Defining maintenance job concurrency

DEDALO_JOB_LANE_MAINTENANCE_CONCURRENCY `int`

This parameter defines how many maintenance jobs Dédalo will run at the same time.

Background work in Dédalo runs in lanes, and each class of work has its own budget of
simultaneous jobs: media derivatives, transcription, index building and the maintenance work an
administrator starts by hand. The lanes are independent on purpose — a queue of video
transcodes must never be able to hold up the code update you are waiting for.

Maintenance is the administrator's own lane: code and data updates, cache rebuilds, imports,
propagations. Two by default, so that starting an import does not have to wait for a cache
rebuild to finish. Values below 1 are raised to 1.

```bash
DEDALO_JOB_LANE_MAINTENANCE_CONCURRENCY=2
```

*Default: 2*

---

### Defining index job concurrency

DEDALO_JOB_LANE_RAG_CONCURRENCY `int`

This parameter defines how many index-building jobs Dédalo will run at the same time.

Background work in Dédalo runs in lanes, and each class of work has its own budget of
simultaneous jobs: media derivatives, transcription, index building and the maintenance work an
administrator starts by hand. The lanes are independent on purpose — a queue of video
transcodes must never be able to hold up the code update you are waiting for.

This lane builds the semantic index used by assisted search and object identification. Two by
default. Raise it if you index frequently and the machine has cores to spare; lower it to 1 to
keep the index work out of the way of everything else. Values below 1 are raised to 1.

```bash
DEDALO_JOB_LANE_RAG_CONCURRENCY=2
```

*Default: 2*

---

### Defining transcription job concurrency

DEDALO_JOB_LANE_TRANSCRIPTION_CONCURRENCY `int`

This parameter defines how many transcription jobs Dédalo will run at the same time.

Background work in Dédalo runs in lanes, and each class of work has its own budget of
simultaneous jobs: media derivatives, transcription, index building and the maintenance work an
administrator starts by hand. The lanes are independent on purpose — a queue of video
transcodes must never be able to hold up the code update you are waiting for.

Transcription jobs spend nearly all their time waiting on the speech-to-text service rather than
using this machine, so their slots are cheap to hold: two by default, which keeps a short
recording from queueing behind a long interview. Raise it if your transcription service handles
several requests at once. Values below 1 are raised to 1.

```bash
DEDALO_JOB_LANE_TRANSCRIPTION_CONCURRENCY=2
```

*Default: 2*

---

### Reconcile scheduler

DEDALO_RECONCILE_SCHEDULER_ENABLED `bool`

Whether **this** server runs the scheduled cross-store reconciles by itself: the
boot-class ones once after it starts listening (today: the publication-marker index, which
re-derives the web server's `pub/` markers from the per-target truth) and the interval-class
ones on their period. Every outcome is published under `reconcile` on `/api/v1/counters`
and listed by the **Reconcile** maintenance widget, which — like `bun scripts/reconcile.ts` —
keeps working with the scheduler off; only the automatic runs stop.

Enabled by default. Set it to `false` on an instance that must not touch a shared store — a
maintenance or smoke-test copy that shares the database or the media tree with the live
installation, where a boot-time repair from the wrong root would do harm.

```bash
DEDALO_RECONCILE_SCHEDULER_ENABLED=false
```

*Default: true*

---

### Activity log retention

DEDALO_ACTIVITY_RETENTION_DAYS `int`

How many days of `matrix_activity` rows this installation keeps. Every
state-changing action appends one row — and so does every DENIED login, which nobody has to
be authenticated to cause — so the table grows with use and with abuse alike, inside the
database every backup copies.

The default is `0`: **keep everything**. That is the right default for a heritage archive,
because the activity log is the record of who changed what. The key exists so an institution
that has decided otherwise can say so, and so that the deletion is performed by the engine
(the retention scheduler, or `bun scripts/reconcile.ts`-style operator surfaces) rather than
by hand-written SQL against the matrix.

```bash
DEDALO_ACTIVITY_RETENTION_DAYS=1095
```

*Default: 0*

---

### Publication ledger retention

DEDALO_DIFFUSION_LEDGER_RETENTION_DAYS `int`

How many days of SETTLED rows the `dd1758` publication ledger keeps. The ledger
appends one row per record per publish run — republishing the same catalogue writes them all
again — so it grows linearly with how often you publish, not with how much you hold.

PENDING rows (an unpublish still owed to a public target) are NEVER pruned, whatever this is
set to: they are outstanding debt, not history.

The default is `0`: keep everything. Set a window if your publication history does not need
to be permanent.

```bash
DEDALO_DIFFUSION_LEDGER_RETENTION_DAYS=365
```

*Default: 0*

---

### Retention scheduler

DEDALO_RETENTION_SCHEDULER_ENABLED `bool`

Whether **this** server applies the configured retention windows by itself, once
after boot and then daily. With every window at its default (`0` = keep everything) it has
nothing to do, so leaving it on costs nothing and means that the day an operator sets a
window, it takes effect.

Set it to `false` on an instance that shares a database with the live installation — a
maintenance or smoke-test copy — where a scheduled delete would act on data it does not own.

```bash
DEDALO_RETENTION_SCHEDULER_ENABLED=false
```

*Default: true*

---

### Defining the slow request threshold

DEDALO_SLOW_REQUEST_MS `int`

Any API request that takes longer than this, in milliseconds, is warn-logged with its
duration, the API call, the request id and the user — and counted, so the count also shows up in
the server counters. This happens whether or not the access log is on.

Default `5000` (5 seconds): slow enough that a healthy installation stays quiet, fast enough to
notice a query that has started to degrade. Lower it while hunting a latency problem; raise it if
one genuinely heavy operation is flooding the log with noise you have already accounted for. Set
`0` to disable the warning entirely.

```bash
DEDALO_SLOW_REQUEST_MS=5000
```

*Default: 5000*

---

### Update log file

UPDATE_LOG_FILE `string`

Defines the directory path to store the update log.

The maintenance update process uses the update log to store the status of each update task. This log is useful to know what happens in the update process. If the update fails, you can consult the last status to restore the update process at this last point.

Defaults to `update.log` inside `../private`. If you move it elsewhere, keep the
directory private and outside the served tree.

```bash
UPDATE_LOG_FILE="/srv/dedalo/private/update.log"
```

*Default: (unset)*

---

## Error reporting {#error_report}

### Error reports: reporter IP allowlist

DEDALO_ERROR_REPORT_ALLOWED_IPS `string`

Only meaningful on the **master** installation (the one that receives reports). A
comma-separated list of the IP addresses allowed to reach the intake; a report from any
other address is refused. The shorthand `loopback` accepts the local machine. Write
every IPv4 part in plain decimal: an entry with a leading zero (`010.0.0.1`) is refused,
because some software reads it as octal — it matches no address at all.

Unset (the default) leaves the intake open to any address — it is still anonymous,
rate-limited and size-capped, but if you know which installations report to you, listing
them here is the cheapest way to keep everyone else out.

```bash
DEDALO_ERROR_REPORT_ALLOWED_IPS="loopback,203.0.113.10,203.0.113.11"
```

*Default: (unset)*

---

### Error reports: master installation URL

DEDALO_ERROR_REPORT_MASTER_URL `string`

The JSON API endpoint of the **master** installation this Dédalo sends its error
reports to. **Setting it is what enables reporting**: with a master URL configured, global
administrators get a report button on every page, from which they can describe a problem
and send it — together with the page context and any JavaScript errors captured since the
page loaded — to the maintainers. Nothing ever leaves the machine without that explicit
click.

Leave it unset if this installation does not report anywhere. `https` is required (plain
`http` is accepted only for a loopback target while developing).

```bash
DEDALO_ERROR_REPORT_MASTER_URL="https://master.example.org/dedalo/core/api/v1/json/"
```

*Default: (unset)*

---

### Error reports: act as the receiver

DEDALO_ERROR_REPORT_RECEIVER `bool`

Set to `true` **only on the designated master installation** — the one other
Dédalos point at with their master URL. It opens the intake endpoint that stores the
incoming reports, and it turns on the *Error reports* widget of the maintenance dashboard,
where an administrator can browse what has arrived.

The default is `false`, and while it is off the endpoint is indistinguishable from an
action that does not exist. A normal installation never turns this on.

```bash
DEDALO_ERROR_REPORT_RECEIVER=true
```

*Default: false*

---

### Error reports: retention

DEDALO_ERROR_REPORT_RETENTION_DAYS `int`

Only meaningful on the **master** installation. Received reports older than this many
days are pruned. Default `90`; `0` keeps them forever.

Reports are user-written text and can quote record data, so a bounded retention is the
recommended posture — shorten it if your institution's data-protection policy asks for it.

```bash
DEDALO_ERROR_REPORT_RETENTION_DAYS=90
```

*Default: 90*

---

### Error reports: stored row ceiling

DEDALO_ERROR_REPORT_MAX_ROWS `int`

Only meaningful on the **master** installation. The highest number of reports the
store may hold. The age window (`DEDALO_ERROR_REPORT_RETENTION_DAYS`) cannot bound a burst:
a flood arriving today is inside the window and stays for the whole of it, and since a
report may carry an inline screenshot each one can be a few hundred kilobytes. When the
store is over this ceiling the OLDEST reports are dropped until it is under it again —
eviction, not refusal, because refusing would let a flood silence the genuine reports the
intake exists for. Default `100000`; `0` removes the ceiling.

```bash
DEDALO_ERROR_REPORT_MAX_ROWS=100000
```

*Default: 100000*

---

### Error reports: relay timeout

DEDALO_ERROR_REPORT_TIMEOUT_MS `int`

How long (in milliseconds) this server waits for the master installation to accept a
relayed report before giving up. Default `10000` (ten seconds), minimum `1000`.

Raise it if the master is reached over a slow link and administrators see reports fail to
send; a timeout only loses that one report, it never blocks the user's work.

```bash
DEDALO_ERROR_REPORT_TIMEOUT_MS=10000
```

*Default: 10000*

---

### Error reports: shared token

DEDALO_ERROR_REPORT_TOKEN `string`

An optional shared secret sent with every relayed report and checked by the master
installation, which rejects a report that does not carry the matching value. It is a spam
filter, not authentication: the sending server, not the browser, adds it.

Both ends must hold the **same** value — set it on the master and on each installation
that reports to it. This is a **secret**: the shipped template carries a placeholder only,
so pick a long random string and set it for real. When it is unset on the master, the
check is skipped and any report is accepted (still rate-limited and size-capped).

```bash
DEDALO_ERROR_REPORT_TOKEN="a-long-random-shared-secret"
```

*Default: (unset)*

---

## AI assistant, agent and semantic search {#ai}

### Defining the default assistant model

AGENT_MODEL `string`

This parameter names the model the assistant uses when no model catalog is declared.
It only matters in the zero-configuration case: with `DEDALO_AGENT_MODELS` unset and an
`ANTHROPIC_API_KEY` present, Dédalo builds an implicit one-model catalog and this is the
model id it asks for. As soon as you declare an explicit catalog, this parameter is
ignored — each catalog entry carries its own model id.

Change it to move the single implicit model up or down a generation (a faster, cheaper
model for a small installation; a more capable one for heavy cataloguing work). The
default is `"claude-opus-4-8"`.

```bash
AGENT_MODEL="claude-opus-4-8"
```

*Default: claude-opus-4-8*

---

### Defining the Anthropic API key

ANTHROPIC_API_KEY `string`

The credential the assistant sends to Anthropic. It is used by every catalog entry
whose provider is `anthropic` and does not name its own key variable, and it is what makes
the implicit (zero-configuration) catalog exist at all: with no key and no
`DEDALO_AGENT_MODELS`, the assistant has no models and stays disabled.

The engine fails closed without it — a conversation with an Anthropic model refuses rather
than silently trying an unauthenticated call. It is a secret: keep it in `../private/.env`,
never in a repository. There is no default.

```bash
ANTHROPIC_API_KEY="sk-ant-..."
```

*Default: (unset)*

---

### Defining the daily semantic-search budget per user

DEDALO_AI_USER_DAILY_EMBED_QUERIES `int`

This parameter defines how many semantic-search queries (each one embeds the query text with the embedding model) one user may spend in one day (a UTC day, reset
at midnight UTC).

Every AI request is first RESERVED against the user's usage ledger (the engine-owned
`AI usage` section under Administration, one record per user and day); a request that would go
past this budget is refused with a message saying when the budget resets, before any model is
called. Nobody is exempt — administrators and the root user included. Counted per query: a semantic search, a passage retrieval, a text-to-image search and the retrieval step of a generated answer each count one. The searches the assistant makes INSIDE a conversation are part of that conversation and are not counted here.

`0` refuses every such request. There is no "unlimited" value: a model spend always has a
limit.

```bash
DEDALO_AI_USER_DAILY_EMBED_QUERIES=2000
```

*Default: 2000*

---

### Defining the daily assistant-run budget per user

DEDALO_AI_USER_DAILY_RUNS `int`

This parameter defines how many model runs one user may spend in one day (a UTC day, reset
at midnight UTC).

Every AI request is first RESERVED against the user's usage ledger (the engine-owned
`AI usage` section under Administration, one record per user and day); a request that would go
past this budget is refused with a message saying when the budget resets, before any model is
called. Nobody is exempt — administrators and the root user included. A run is one assistant conversation turn (which may call the model up to twelve times) or one generated answer over the collection (`ask`).

`0` refuses every such request. There is no "unlimited" value: a model spend always has a
limit.

```bash
DEDALO_AI_USER_DAILY_RUNS=50
```

*Default: 50*

---

### Defining the daily model-token budget per user

DEDALO_AI_USER_DAILY_TOKENS `int`

This parameter defines how many model tokens one user may spend in one day (a UTC day, reset
at midnight UTC).

Every AI request is first RESERVED against the user's usage ledger (the engine-owned
`AI usage` section under Administration, one record per user and day); a request that would go
past this budget is refused with a message saying when the budget resets, before any model is
called. Nobody is exempt — administrators and the root user included. Each run reserves the most output it can produce (the per-turn output limit times the turns it may take) and is then charged what the model reports it used; a model that reports no usage keeps the whole reservation charged.

`0` refuses every such request. There is no "unlimited" value: a model spend always has a
limit.

```bash
DEDALO_AI_USER_DAILY_TOKENS=1000000
```

*Default: 1000000*

---

### Defining the daily vision-model budget per user

DEDALO_AI_USER_DAILY_VISION `int`

This parameter defines how many vision-model calls one user may spend in one day (a UTC day, reset
at midnight UTC).

Every AI request is first RESERVED against the user's usage ledger (the engine-owned
`AI usage` section under Administration, one record per user and day); a request that would go
past this budget is refused with a message saying when the budget resets, before any model is
called. Nobody is exempt — administrators and the root user included. Counted per call: the identification tool's vision proposals and an image identification that sends the photograph to an external image encoder each count one.

`0` refuses every such request. There is no "unlimited" value: a model spend always has a
limit.

```bash
DEDALO_AI_USER_DAILY_VISION=50
```

*Default: 50*

---

### Allowing record content to reach external models

DEDALO_AGENT_ALLOW_EXTERNAL_PROVIDER_DEFAULT `bool`

This parameter decides whether a conversation held with an **external** model (one whose
catalog egress class is `external` — any model whose API call leaves your server) may
receive the content of your records at all. It is the privacy switch for institutions whose
data may not leave the building.

With the default `false`, an external conversation still works: the model can use the
discovery tools that describe the ontology (section names, field maps, relational paths),
and it can answer general questions — but **every tool call that would return record content
is refused** with an `egress_restricted` message, and the user is steered to a local model,
which is never gated. Set it to `true` to let external conversations read record content,
minus whatever you list in `DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS`.

Note what the gate does *not* cover: the user's own question and any image they attach
travel to whichever model they picked — that is the user's own act. The gate protects the
repository, not the user's words.

```bash
DEDALO_AGENT_ALLOW_EXTERNAL_PROVIDER_DEFAULT=false
```

*Default: false*

---

### Allowing the assistant to propose changes

DEDALO_AGENT_ALLOW_WRITE `bool`

This parameter exposes the assistant's write tools and the change-plan flow. With the
default `false` the assistant is strictly read-only: the write tools are not even listed to
the model, and a call to one is refused.

Even when it is `true` the assistant never writes on its own. Write mode makes it produce a
**change plan** that a human reads and confirms; only that confirmation executes, and every
gate is re-checked at execution time — the user's own permissions, the per-record scope, and
the section allowlist (`DEDALO_AGENT_WRITE_SECTIONS`). Two limits are worth knowing before
you enable it: writes always run as the logged-in user (never as a service identity), and
write mode is **refused to global-admin sessions** — an administrator's unlimited reach must
not be lent to a model.

```bash
DEDALO_AGENT_ALLOW_WRITE=false
```

*Default: false*

---

### Enabling the in-app assistant

DEDALO_AGENT_HTTP_ENABLED `bool`

The master switch for the assistant inside the Dédalo client: the chat panel, the model
list, and the streaming answer. With the default `false` every assistant request is refused
like an unknown action, and the panel reports the feature as disabled — the rest of the
application is unaffected.

Turn it on once you have declared at least one model (`DEDALO_AGENT_MODELS`, or an
`ANTHROPIC_API_KEY` for the implicit catalog); with the switch on but no usable model the
assistant reports that none is configured. Enabling it grants no write capability by itself —
see `DEDALO_AGENT_ALLOW_WRITE`.

```bash
DEDALO_AGENT_HTTP_ENABLED=true
```

*Default: false*

---

### Defining the assistant output limit

DEDALO_AGENT_MAX_TOKENS `int`

The maximum number of tokens the assistant may produce in a single model turn. It caps
the length of one answer (and the cost of one runaway generation); it does not cap the
conversation, which may take several turns.

Raise it if long answers are being cut off mid-sentence, lower it to keep spend predictable.
A model catalog entry may override it with its own `max_tokens` — the entry always wins. A
missing or non-positive value falls back to the default `16000`.

```bash
DEDALO_AGENT_MAX_TOKENS=16000
```

*Default: 16000*

---

### Defining the assistant model catalog

DEDALO_AGENT_MODELS `array of objects (JSON)`

The list of models the assistant may use — the one place a deployment declares what the
user can pick from, and where each model's answers travel. It is a JSON array; each entry
takes `id`, `label` (what the user sees), `provider` (`anthropic` or `openai_compatible`),
`model` (the provider's own model id), and optionally `endpoint`, `api_key_env` (the NAME of
another variable holding the key — never the key itself), `egress` (`local` or `external`),
`vision`, `max_tokens` and `timeout_s`. The first entry is the default choice.

The catalog is validated fail-closed on every request: malformed JSON, an unknown field or a
single bad entry disables the assistant rather than half-enabling it. An `anthropic` entry is
always `external` — its call leaves your server, and declaring it `local` is rejected as a
configuration error. An `openai_compatible` entry must carry an `endpoint` and an explicit
`egress`, so that calling a model "local" is always a conscious statement. That egress class
is what the privacy gate acts on (see
`DEDALO_AGENT_ALLOW_EXTERNAL_PROVIDER_DEFAULT`).

Leave it unset for the zero-configuration case: a single Anthropic model, but only if
`ANTHROPIC_API_KEY` is set — otherwise the assistant stays disabled.

```bash
DEDALO_AGENT_MODELS=[{"id":"local","label":"Llama 3.1 (local, private)","provider":"openai_compatible","model":"llama3.1:70b","endpoint":"http://127.0.0.1:11434/v1/chat/completions","egress":"local"},{"id":"claude","label":"Claude (external)","provider":"anthropic","model":"claude-opus-4-8","vision":true}]
```

*Default: (unset)*

---

### Defining the deployment prompt text

DEDALO_AGENT_SYSTEM_PROMPT_APPEND `string`

Free text appended to the assistant's built-in instructions, so it knows where it is
working. Use it for the facts a model cannot guess: what the institution holds, which
language its labels are in, which collection is the important one.

It is added *after* the built-in rules, which it can extend but never reorder or remove — the
safety and permission instructions are not overridable from configuration. The text is read
at boot and is the same for every conversation, so it stays in the cached part of the prompt
and costs nothing per question. Unset by default.

```bash
DEDALO_AGENT_SYSTEM_PROMPT_APPEND="This is the archive of the Museum of X. Prefer Catalan (lg-cat) labels when they exist. The oral-history collection is sensitive."
```

*Default: (unset)*

---

### Defining the assistant writable sections

DEDALO_AGENT_WRITE_SECTIONS `string[]`

A comma-separated list of section `tipo`s the assistant's change plans may touch. It
narrows write mode to the part of the repository you are willing to let a model propose edits
in — a cataloguing section, say, and nothing else. A plan naming any other section is refused
before it reaches the database.

Read the default carefully. **UNSET means no narrowing at all** — with
`DEDALO_AGENT_ALLOW_WRITE=true` and this key absent, a confirmed plan may write to any
section the logged-in user could already edit through the client. But **PRESENT AND EMPTY
(`[]`) means NOTHING is writable**, which is what an empty allowlist reads as everywhere
else; the two are deliberately different, because "no narrowing" is already expressible by
leaving the key out. The allowlist is a restriction, not a grant: it can only take sections
away, never add permission the user does not have. It has no effect while write mode is off.

```bash
DEDALO_AGENT_WRITE_SECTIONS=oh1,rsc197
```

*Default: (unset)*

---

### Allowing writes in the stand-alone tool server

DEDALO_MCP_ALLOW_WRITE `bool`

Exposes the write tools in the **stand-alone tool server** — the separate process that
offers Dédalo's tools to an external AI client over a local pipe. With the default `false`
that server registers read tools only, and a write call is refused as read-only.

This is not the in-app assistant (that one is governed by `DEDALO_AGENT_ALLOW_WRITE`);
enabling one does nothing to the other. When you do enable it, remember that the tool server
acts as ONE fixed user (`DEDALO_MCP_USER_ID`) for its whole lifetime: every write is checked
against that user's permissions and record scope, so give it a real, narrowly-privileged
cataloguing user — never an administrator. Write mode refuses a global-admin or superuser
identity outright.

```bash
DEDALO_MCP_ALLOW_WRITE=false
```

*Default: false*

---

### Defining the media import directory

DEDALO_MCP_MEDIA_IMPORT_DIR `string`

The one directory from which the stand-alone tool server may ingest a media file **by
path**. Unset by default, and unset means the whole path-based branch is disabled: a tool
call that names a file path is refused, and media can only be uploaded as inline data.

Point it at a dedicated staging directory (an ingest drop-box), never at a home directory or
the media store itself. Every requested path is resolved to its real location and must land
inside this directory — a `..` traversal or a symbolic link that points outside is refused,
not followed.

```bash
DEDALO_MCP_MEDIA_IMPORT_DIR="/var/dedalo/ingest"
```

*Default: (unset)*

---

### Defining the media import size limit

DEDALO_MCP_MEDIA_MAX_BYTES `int`

The largest media file, in bytes, the stand-alone tool server will accept in one upload
tool call — whether it arrives as inline data or from the import directory. Anything larger is
refused with a "too large" message.

Raise it if you ingest high-resolution masters through the tool server; the default is
`10485760` (10 MiB). The value must be a plain positive integer of bytes: a value the engine
cannot read as one (`10MB`, `0`, empty) falls back to that default rather than removing the
limit.

```bash
DEDALO_MCP_MEDIA_MAX_BYTES=10485760
```

*Default: 10485760*

---

### Defining the tool-server service user

DEDALO_MCP_USER_ID `int`

The Dédalo user the **stand-alone tool server** acts as. That server has no login: it
resolves this one identity at startup and keeps it for the whole process lifetime — every
tool call it serves is authorized against this user's permissions and record scope, exactly as
if that person had done it in the client. There is no tool to change identity mid-flight.

It is required by that server and by nothing else: the Dédalo server itself boots without it,
and the in-app assistant never uses it (it always acts as the logged-in browser user). A
missing or non-integer value is a hard startup error for the tool server — it refuses to start
rather than fall back to a privileged identity. Set it to the `section_id` of a user in the
users section; `-1` is the superuser and is acceptable only in trusted local development, and
read-only even there.

```bash
DEDALO_MCP_USER_ID=42
```

*Default: (unset)*

---

### Defining the tool-server writable sections

DEDALO_MCP_WRITE_SECTIONS `string[]`

A comma-separated list of section `tipo`s the stand-alone tool server's write tools may
target. A write call addressing any other section is refused before the engine is reached.

As with the assistant's twin setting, **UNSET means no narrowing**: with
`DEDALO_MCP_ALLOW_WRITE=true` and this key absent, the tool server may write to every section
its service user (`DEDALO_MCP_USER_ID`) is already allowed to edit. **PRESENT AND EMPTY
(`[]`) means NOTHING is writable.** The list only ever removes sections — it cannot grant
permission that user does not have. It has no effect while write mode is off.

```bash
DEDALO_MCP_WRITE_SECTIONS=rsc197
```

*Default: (unset)*

---

### Defining the embedding batch size

DEDALO_RAG_BATCH_SIZE `int`

How many text fragments Dédalo sends to the embedding service in one request while
indexing. It is a throughput knob for the indexer, invisible to end users.

Larger batches index a big collection faster but make each request heavier — lower it if your
embedding service times out or runs out of memory, raise it if indexing is slow and the
service has headroom. It only applies when an external embedding service is configured
(`DEDALO_RAG_EMBEDDING_PROVIDER=sidecar`). Unset or non-positive falls back to `32`.

```bash
DEDALO_RAG_BATCH_SIZE=32
```

*Default: 32*

---

### Defining the chunking strategy

DEDALO_RAG_CHUNK_STRATEGY `string`

How Dédalo cuts a long text into the fragments it indexes for semantic search. Two
strategies exist:

* `structural_semantic` (the default) — split on the text's own structure (headings,
  paragraphs, transcription time-codes), then also where the meaning shifts, so a fragment
  stays about one thing;
* `structural` — split on structure only. Cheaper and fully deterministic; a reasonable
  choice for short, uniform fields.

A component may override the installation-wide choice in the ontology
(`properties.rag.strategy`). Changing this value only affects fragments produced from then
on — re-index a section if you want the whole of it recut.

```bash
DEDALO_RAG_CHUNK_STRATEGY="structural_semantic"
```

*Default: structural_semantic*

---

### Defining the maximum fragment size

DEDALO_RAG_CHUNK_TOKENS `int`

The largest fragment, in tokens, the chunker will emit. Bigger fragments carry more
context into an answer but blur the match — the embedding of a long passage is an average of
everything in it, so a precise question retrieves it less sharply. Smaller fragments match
precisely but may arrive without the sentence that explains them.

450 suits the descriptive prose typical of catalogue records. Raise it for long-form
transcriptions where an answer usually needs a whole paragraph; lower it for short, dense
fields. A component may override it in the ontology (`properties.rag`).

Changing this only affects fragments produced from then on — re-index a section to recut it.

```bash
DEDALO_RAG_CHUNK_TOKENS=450
```

*Default: 450*

---

### Defining the minimum fragment size

DEDALO_RAG_CHUNK_MIN_TOKENS `int`

The floor, in tokens, below which the chunker will not leave a fragment standing on its
own: a shorter one is merged into its neighbour. Without a floor, a heading or a one-line
field becomes a fragment of its own, and such a fragment matches many questions weakly and
none of them well.

Lower it only if your records genuinely carry meaning in very short fields.

```bash
DEDALO_RAG_CHUNK_MIN_TOKENS=120
```

*Default: 120*

---

### Defining the semantic breakpoint sensitivity

DEDALO_RAG_SEMANTIC_BREAKPOINT_THRESHOLD `float`

Under the `structural_semantic` strategy, how different two consecutive passages must be
before the chunker cuts between them. It is a similarity threshold between 0 and 1: the cut
is made when similarity falls *below* it.

A HIGHER value cuts more eagerly (more, tighter fragments); a lower value cuts only at a
pronounced change of subject (fewer, broader fragments). 0.92 is deliberately close to 1 —
catalogue prose tends to stay on topic, so only a clear shift should split a record.

Has no effect under the `structural` strategy.

```bash
DEDALO_RAG_SEMANTIC_BREAKPOINT_THRESHOLD=0.92
```

*Default: 0.92*

---

### Defining the semantic index database connection

DEDALO_RAG_DB_HOSTNAME_CONN `string`

The host of the vector database. Set it only when the semantic index lives on a
**different** database server than the catalogue: when unset (the default), Dédalo reuses the
main database's route (its socket `DB_SOCKET` when set, else `DB_HOST`), and the same goes for `DEDALO_RAG_DB_PORT_CONN`,
`DEDALO_RAG_DB_USERNAME_CONN` and `DEDALO_RAG_DB_PASSWORD_CONN`. The typical installation sets
none of them.

Give it a host name or IP; a path is also accepted and is treated as a socket directory. A
Unix socket set in `DEDALO_RAG_DB_SOCKET_CONN` wins over this value.

```bash
DEDALO_RAG_DB_HOSTNAME_CONN="10.0.0.42"
```

*Default: (unset)*

---

### Defining the semantic index database

DEDALO_RAG_DB_NAME `string`

The name of the database that holds the semantic index — the vectors and the indexed text
fragments. It is deliberately **separate** from the catalogue database: nothing in it is
irreplaceable, since the whole index can be rebuilt from the records at any time.

Leave it unset unless you host several installations on one database server and need distinct
index databases. Unset, Dédalo uses the compatibility spelling `RAG_DB_NAME` if present, and
otherwise `dedalo7_rag`.

```bash
DEDALO_RAG_DB_NAME="dedalo7_rag"
```

*Default: (unset)*

---

### Defining the semantic index database connection

DEDALO_RAG_DB_PASSWORD_CONN `string`

The password used to connect to the vector database. Needed only when the semantic index
lives on a different database server (or under a different role) than the catalogue: unset,
Dédalo reuses the main database password.

It is a secret — keep it in `../private/.env`. An empty value is a legitimate configuration
when the vector database authenticates by trust or peer.

```bash
DEDALO_RAG_DB_PASSWORD_CONN="•••••"
```

*Default: (unset)*

---

### Defining the semantic index database connection

DEDALO_RAG_DB_PORT_CONN `int`

The port of the vector database server. Set it only when the semantic index lives on a
different server, or on a non-standard port; unset (the default), Dédalo reuses the main
database's port. A value that is not a positive number is ignored and the main database's port
is used.

```bash
DEDALO_RAG_DB_PORT_CONN=5432
```

*Default: (unset)*

---

### Defining the semantic index database connection

DEDALO_RAG_DB_SOCKET_CONN `string`

The Unix socket directory of the vector database, for a local connection that does not go
through the network stack. When set it **wins** over the host and port settings.

Leave it empty (the default) to connect over the network — that is what an installation whose
vector database sits on a separate server needs.

```bash
DEDALO_RAG_DB_SOCKET_CONN="/var/run/postgresql"
```

*Default: (empty)*

---

### Defining the semantic index database connection

DEDALO_RAG_DB_USERNAME_CONN `string`

The role used to connect to the vector database. Set it only when the semantic index lives
on a different database server, or is owned by a different role, than the catalogue; unset (the
default), Dédalo reuses the main database user.

```bash
DEDALO_RAG_DB_USERNAME_CONN="dedalo"
```

*Default: (unset)*

---

### Defining the embedding service endpoint

DEDALO_RAG_EMBEDDING_ENDPOINT `string`

The base URL of the embedding service that turns text into vectors. It is **required** for
real semantic search: with `DEDALO_RAG_EMBEDDING_PROVIDER=sidecar` but no endpoint, Dédalo
silently keeps the built-in development embedder, whose results are reproducible but not
meaningful.

Dédalo posts the fragments to `{endpoint}/embed` and expects the vectors back. Any transport
failure is treated as a retryable indexing failure — a failed batch is never written as
garbage vectors. Empty by default.

```bash
DEDALO_RAG_EMBEDDING_ENDPOINT="http://127.0.0.1:8085"
```

*Default: (empty)*

---

### Defining the embedding model

DEDALO_RAG_EMBEDDING_MODEL `string`

The model name Dédalo asks the embedding service for. It is also the **partition key** of
the semantic index: vectors are stored per model, so two models never contaminate each other's
results.

Because of that, changing this value on a populated installation does not convert the existing
index — it starts a new one, and the records must be re-indexed under the new model before
searches see them again. The default is `"bge-m3"`, a multilingual model that suits a
multi-language archive. It only applies when an external embedding service is configured.

```bash
DEDALO_RAG_EMBEDDING_MODEL="bge-m3"
```

*Default: bge-m3*

---

### Defining the embedding provider

DEDALO_RAG_EMBEDDING_PROVIDER `string`

Which embedder produces the vectors behind semantic search. Set it to `sidecar` to use a
real embedding service — and then `DEDALO_RAG_EMBEDDING_ENDPOINT` must be set too, or Dédalo
falls back to the built-in one.

The default (empty) selects the built-in **development embedder**: it runs offline, needs no
service and no key, and is perfectly reproducible — which makes it right for a test
installation and wrong for a real one, because it matches words rather than meaning. Any
production installation that wants genuine semantic search runs a service and sets `sidecar`.

```bash
DEDALO_RAG_EMBEDDING_PROVIDER="sidecar"
```

*Default: (empty)*

---

### Enabling semantic search

DEDALO_RAG_ENABLED `bool`

The master switch for semantic search: the vector index, the indexing that follows a save,
and the search and question-answering actions built on them. With the default `false` the
subsystem costs nothing — no indexing work is queued when a record is saved, and every
semantic-search request is declined.

Turning it on is only the first half of the decision: nothing is indexed until you also opt
each section and component in through the ontology (`properties.rag`), so enabling the switch
never sweeps the whole repository into an index by surprise. It needs the vector database to
exist (see `DEDALO_RAG_DB_NAME`).

```bash
DEDALO_RAG_ENABLED=true
```

*Default: false*

---

### Defining sections forbidden to external providers

DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS `string[]`

A comma-separated list of section `tipo`s whose content must **never** reach a model
hosted outside your server — the never-egress list. It is the one place an institution names
its protected material (an oral-history collection, a donor file), and it is honoured by both
AI surfaces: the assistant's conversations and the semantic question-answering. One
classification, applied twice.

It outranks the permissive setting: a section on this list stays restricted even with
`DEDALO_AGENT_ALLOW_EXTERNAL_PROVIDER_DEFAULT=true`. The gate errs towards refusal — a request
that merely *mentions* a forbidden section in a filter, or whose answer would surface a linked
record from one, is refused whole rather than trimmed, because a filter over protected values
answers questions about them just as surely as reading them does. Local models are never
gated, so the honest fallback is always available to the user.

Empty by default (nothing is on the list). Naming a section here does not hide it from the
people who may see it — it only stops it from leaving.

```bash
DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS=oh1,rsc45
```

*Default: (unset)*

---

### Enabling image search

DEDALO_RAG_MEDIA_ENABLED `bool`

The master switch for the IMAGE half of semantic search: visual similarity between
objects, a typed question answered with photographs, and the neighbour-based
characterization of an uncatalogued piece. With the default `false` those three actions
decline as unavailable and nothing else changes — the text side of semantic search is
untouched.

It sits *inside* semantic search rather than beside it, so `DEDALO_RAG_ENABLED` must be on
as well. For meaningful results it also needs a joint image-and-text embedding service
(`DEDALO_RAG_MULTIMODAL_ENDPOINT`): with the switch on and no service configured the
pipeline still runs end to end on a built-in, network-free stand-in whose vectors are
reproducible but not semantic — right for trying the feature out, wrong for a real
collection.

```bash
DEDALO_RAG_MEDIA_ENABLED=true
```

*Default: false*

---

### Defining the image embedding provider

DEDALO_RAG_MULTIMODAL_PROVIDER `string`

Which service turns an image into a vector — and, the load-bearing part, whether that
service runs on your own machine. `local` (the default) declares an on-premise image
embedder; **any other value declares an external one**, whose every call carries the image
itself off your server.

That declaration is what `DEDALO_RAG_IMAGE_EGRESS_POLICY` acts on: while the policy is at
its default, naming an external provider here is refused as a configuration error rather
than quietly honoured. So name the service you actually run — `local` for a container of
your own, the vendor's name for a hosted one. Calling a hosted service `local` does not
make it one; it only disables the check.

```bash
DEDALO_RAG_MULTIMODAL_PROVIDER="local"
```

*Default: local*

---

### Defining the image embedding model

DEDALO_RAG_MULTIMODAL_MODEL `string`

The model name Dédalo asks the image embedding service for. It must be a **joint**
image-and-text model (CLIP, SigLIP, jina-clip and their kin): both of its towers share one
vector space, and that shared space is what lets a typed question retrieve a photograph. A
text-only embedder cannot stand in here — the text-side `DEDALO_RAG_EMBEDDING_MODEL` is a
separate, independent choice.

Like its text twin, it **partitions** the stored vectors. Changing it on a populated
installation therefore does not convert the existing image index: the images must be
embedded again under the new model before image searches see them. The default
`"clip-ViT-B-32"` is small enough to serve from a modest machine.

```bash
DEDALO_RAG_MULTIMODAL_MODEL="clip-ViT-B-32"
```

*Default: clip-ViT-B-32*

---

### Defining the image embedding endpoint

DEDALO_RAG_MULTIMODAL_ENDPOINT `string`

The base URL of the image embedding service. Dédalo posts images to
`{endpoint}/image` and query text to `{endpoint}/text`, and expects the vectors back; a
failed or mis-shaped response is skipped whole rather than stored as a partial batch, so a
sick service degrades the results but never corrupts the index.

Empty by default, and empty is meaningful: with no endpoint the image layer falls back to
a built-in, network-free stand-in, so the whole pipeline stays exercisable offline —
reproducible vectors that are not semantic. Any installation that wants real image search
sets one.

```bash
DEDALO_RAG_MULTIMODAL_ENDPOINT="http://127.0.0.1:8089"
```

*Default: (empty)*

---

### Defining the image embedding credential

DEDALO_RAG_MULTIMODAL_API_KEY `string`

The bearer token Dédalo sends to the image embedding service. A container you run
yourself usually needs none; a hosted service always does.

It is a secret — keep it in `../private/.env`, never in a repository. Unset by default,
and unset simply means the request carries no authorization header. Setting it does not by
itself permit images to leave the host: that decision is
`DEDALO_RAG_IMAGE_EGRESS_POLICY`.

```bash
DEDALO_RAG_MULTIMODAL_API_KEY="sk-..."
```

*Default: (unset)*

---

### Deciding whether object images may leave the host

DEDALO_RAG_IMAGE_EGRESS_POLICY `string`

Whether the photographs of your objects may be sent to an embedding service outside your
server. It is the institution's own decision, stated once:

* `local_only` (the default) — images are embedded only by a provider declared `local`
  (`DEDALO_RAG_MULTIMODAL_PROVIDER`). Configuring an external one while this policy holds
  is refused loudly as a configuration error, so no image leaves the building through an
  oversight in a settings file.
* `allow_external` — an external provider is permitted, because the institution has
  decided its material may be processed by a third party. Know what that means in
  practice: the image bytes are transmitted to that service on every embedding call.

The policy governs the **provider**, not the record — it is a switch you hold, not a
hidden restriction on what may be published. Which record *text* may reach an external
language model is a separate question, answered by
`DEDALO_AGENT_ALLOW_EXTERNAL_PROVIDER_DEFAULT` and
`DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS`. An unrecognized value is treated as
`local_only` and logged, so a typo can never open the gate.

```bash
DEDALO_RAG_IMAGE_EGRESS_POLICY="local_only"
```

*Default: local_only*

---

### Defining the embedded image size

DEDALO_RAG_IMAGE_MAX_PX `int`

The longest side, in pixels, of the copy of an image that is sent to the embedding
service. A larger original is downscaled into that box first; one already inside it is sent
untouched. The original file on disk is never modified.

512 is what the usual joint models actually consume — pushing a 6000-pixel master through
gains nothing and costs bandwidth, memory and time on every call. Raise it only for a model
that genuinely accepts a larger input. A value below 1 disables the downscale and sends the
original as it is.

```bash
DEDALO_RAG_IMAGE_MAX_PX=512
```

*Default: 512*

---

### Defining the default image similarity mode

DEDALO_RAG_IMAGE_HYBRID `bool`

Whether an object-similarity search combines the visual match with a lexical one over
the object's own descriptive context, when the request does not say which mode it wants.

Keep the default `true` for a heritage collection: pure visual similarity confuses a
bronze coin with a bronze button, and the descriptive leg is what tells them apart. Set it
to `false` where the image *is* the record (a photographic archive, a fabric-pattern
collection) and the surrounding text would only blur the result. A request may still ask
for either mode explicitly — this decides only what happens when it does not.

```bash
DEDALO_RAG_IMAGE_HYBRID=true
```

*Default: true*

---

### Defining the near-duplicate threshold

DEDALO_RAG_NEAR_DUPLICATE_SIMILARITY `float`

How alike two images must be, on a 0-to-1 similarity scale, before a near-duplicate
search reports them as the same thing. It applies only to a request that explicitly asks
for near duplicates; ordinary similarity searches are unaffected.

0.93 is deliberately severe, because the question it answers is "has this object been
photographed and catalogued twice?" — a looser floor turns that into "these two coins look
alike", a different and much longer list. Lower it if genuine re-photographs (different
lighting, a different rig) are being missed; raise it if merely similar pieces still creep
in.

```bash
DEDALO_RAG_NEAR_DUPLICATE_SIMILARITY=0.93
```

*Default: 0.93*

---

### Defining the characterization neighbourhood

DEDALO_RAG_CHARACTERIZE_TOP_K `int`

How many visually nearest already-catalogued objects are consulted when Dédalo proposes
a typology, a period or a material for an uncatalogued one. The proposal is an aggregate of
what those neighbours are catalogued as — never a generated guess — and it is returned for
a cataloguer to accept or reject: the engine writes nothing.

20 balances the two failure modes. Too few neighbours and a single oddly-photographed piece
dominates the proposal; too many and the neighbourhood drifts away from the object,
diluting a real signal with distant matches. A missing or non-integer value falls back to
it.

```bash
DEDALO_RAG_CHARACTERIZE_TOP_K=20
```

*Default: 20*

---

### Defining the embedding service timeout

DEDALO_RAG_PROVIDER_TIMEOUT `int`

How long, **in seconds**, Dédalo waits for the embedding service to answer one batch before
giving up on it. A timed-out batch is a retryable indexing failure, never a partial write.

Raise it if you embed long transcriptions on a service without hardware acceleration and see
indexing failures; lower it to fail fast on an unresponsive service. Unset or non-positive
falls back to `30`.

```bash
DEDALO_RAG_PROVIDER_TIMEOUT=30
```

*Default: 30*

---

### Defining the hybrid ranking constant

DEDALO_RAG_RRF_K `int`

A tuning constant of the hybrid ranking. A semantic search runs two searches — one on
meaning (vectors), one on words (full text) — and merges the two rankings by position rather
than by score, since the scores are not comparable. This value damps how much the very top
positions dominate that merge.

It is a fine-tuning knob most installations never touch: a lower value gives the leaders of
each list more weight, a higher one flattens the two lists together. Unset or non-positive
falls back to `60`, the widely used value.

```bash
DEDALO_RAG_RRF_K=60
```

*Default: 60*

---

### Locating the local AI model store

DEDALO_AI_MODEL_STORE `path`

Where the models that run **inside the browser** are kept — speech recognition for the
transcription tool, translation for the language tool. The directory is served read-only at
`/dedalo/ai_models/`, one folder per model, **to logged-in users only** — the weights are
large and served with a long-lived cache, so an anonymous request is refused with the same
`404` as a missing model.

This is what makes local inference genuinely local. Without a store, the runtime falls back
to downloading weights from a public model hub, which an air-gapped institution cannot do at
all and which tells a third party when a recording is being worked on. Seed the store with
`bun run scripts/fetch_ai_models.ts`, or copy it in with rsync where there is no network.

Relative values resolve against the private directory. Unset, the store is
`<private>/ai_models`. Expect roughly 1.5 GB for a large speech model.

```bash
DEDALO_AI_MODEL_STORE="/data/dedalo/ai_models"
```

*Default: (unset)*

---

### Allowing model downloads from a public hub

DEDALO_AI_MODEL_ALLOW_HUB `bool`

Whether the browser may fetch model weights from a public model hub when they are not in
the local store.

The default `false` keeps the promise the local engines are chosen for: nothing about a
recording — not even the fact that one is being transcribed — reaches a third party, and the
installation works with no outbound internet. Set it to `true` only where the convenience of
on-demand downloads outweighs that, and never for collections holding personal data.

```bash
DEDALO_AI_MODEL_ALLOW_HUB=false
```

*Default: false*

---

### Allowing a transcriber on the local network

DEDALO_TRANSCRIBER_ALLOW_PRIVATE_HOSTS `bool`

Whether a configured transcription server may live on a private or loopback address.

Outbound requests to private ranges are refused by default, because an *external* service
must never be able to make the engine reach inside the network. An *on-premise* recogniser
(faster-whisper, WhisperX, whisper.cpp on a LAN machine) is the legitimate opposite case, and
this parameter is how you say so — deliberately, per installation, rather than by weakening
the guard for everyone. The cloud metadata addresses stay refused either way, and so does all
of IPv4 link-local (`169.254.0.0/16`), which is never a machine on your LAN.

It applies only to the `local_whisper` engine, which is POSTed the audio bytes; the external
engine keeps the strict guard regardless.

```bash
DEDALO_TRANSCRIBER_ALLOW_PRIVATE_HOSTS=true
```

*Default: false*

---

### Defining the semantic index database

RAG_DB_NAME `string`

The compatibility spelling of the vector-database name, still honoured so that an
installation configured before `DEDALO_RAG_DB_NAME` existed keeps working untouched.

Use `DEDALO_RAG_DB_NAME` in new installations; it wins whenever both are present. With
neither set, the database is `dedalo7_rag`.

```bash
RAG_DB_NAME="dedalo7_rag"
```

*Default: dedalo7_rag*

---

## External record services {#external}

Some ontology nodes resolve their values from a service outside Dédalo (a bibliographic catalogue, an authority file) rather than from the records stored here. These settings govern that outbound side: whether it runs at all, which hosts it may reach — nowhere, until you say so — and the ceilings that keep a slow or hostile service from becoming a slow or broken Dédalo.

### Enabling external record services

DEDALO_EXTERNAL_ENABLED `bool`

The master switch for every outbound record lookup. With it on (the default), a
component whose ontology declares a service other than Dédalo's own may resolve its values
from that service; with it off, every such component resolves to nothing and every outbound
call is refused — the rest of the application is untouched, and no record stored in the
matrix changes.

Turning it on is not by itself permission to reach anywhere: an outbound request must ALSO
name a host you have allowed (`DEDALO_EXTERNAL_ALLOWED_HOSTS`), which is empty by default.
The switch decides whether the subsystem exists at all; the allowlist decides where it may
go.

```bash
DEDALO_EXTERNAL_ENABLED=true
```

*Default: true*

---

### Disabling one external service

DEDALO_EXTERNAL_DISABLED_SERVICES `string[]`

A comma-separated list of service names that must not be contacted, while the rest of
the subsystem keeps working. It is the per-service kill switch: when one catalogue is down,
misbehaving, or has become a legal problem, you name it here instead of turning the whole
outbound side off.

The names are the service identifiers the ontology uses (the `api_engine` a node declares),
compared case-insensitively. A component bound to a disabled service resolves to nothing and
says so, exactly as if the master switch were off — it never falls back to a different
service. Empty by default: nothing is singled out.

```bash
DEDALO_EXTERNAL_DISABLED_SERVICES=zenon
```

*Default: (empty)*

---

### Allowing the hosts the engine may contact

DEDALO_EXTERNAL_ALLOWED_HOSTS `string[]`

The comma-separated list of host names the engine may send an outbound record request
to. Read the default carefully, because it inverts the usual reading of an empty list:
**empty means every outbound request is REFUSED**. The allowlist is not a narrowing of an
otherwise open door — it *is* the door.

That is deliberate. The address a request goes to is assembled from the ontology, which is
editable data: without an allowlist held by the operator, an ontology edit would be enough to
make the server fetch from anywhere, including inside your own network. So the institution
states, once and in a file only it can write, the set of hosts it has decided to talk to. A
request to any other host is refused before a connection is opened, and refused loudly.

Entries are compared case-insensitively against the host name alone — no scheme, no path, no
port, and no wildcards: name each host you mean.

```bash
DEDALO_EXTERNAL_ALLOWED_HOSTS=zenon.dainst.org
```

*Default: (empty)*

---

### Defining the external request timeout

DEDALO_EXTERNAL_TIMEOUT_MS `int`

How long, in milliseconds, the engine waits for one outbound response before giving up.
It is what keeps a slow third party from becoming a slow Dédalo: an editor opening a record
must not sit behind someone else's overloaded server.

A timed-out request is a failed lookup, never a partial one — nothing half-read is ever shown
as a value or stored. 4000 is the historical value and suits a catalogue on the public
internet; raise it only if a service you depend on is genuinely slow, and remember that the
wait is paid on every record view that is not served from the row cache.

```bash
DEDALO_EXTERNAL_TIMEOUT_MS=4000
```

*Default: 4000*

---

### Defining the external response size ceiling

DEDALO_EXTERNAL_MAX_BYTES `int`

The largest response, in bytes, the engine will read from an external service. Reading
stops at the ceiling and the lookup fails; it is never truncated into a value, because half a
document parsed as a whole one is worse than no document.

It bounds the memory one hostile or broken service can make the server spend — a server that
answers a record lookup with a gigabyte of anything must not be able to take the engine down.
2097152 (2 MiB) is far above any bibliographic record and far below a problem.

```bash
DEDALO_EXTERNAL_MAX_BYTES=2097152
```

*Default: 2097152*

---

### Defining the external request concurrency

DEDALO_EXTERNAL_MAX_CONCURRENCY `int`

How many outbound requests may be in flight at once towards one service on one host.
Further requests wait for a slot rather than being refused.

It protects both ends. A list view can hold dozens of components bound to the same catalogue,
and firing them all at once is how an institution gets rate-limited or blocked — the ceiling
makes Dédalo a polite client by construction rather than by luck. Lower it if a service asks
you to; raise it only against a service you run yourself.

```bash
DEDALO_EXTERNAL_MAX_CONCURRENCY=4
```

*Default: 4*

---

### Defining how often a cached external row is refreshed

DEDALO_EXTERNAL_SOFT_TTL_MS `int`

How old, in milliseconds, a cached external row may get before the engine asks the
service for it again. It is a SOFT age: a row past it is still served — immediately, from the
cache — and the refresh happens behind the request. An editor never waits on a third party for
data Dédalo already has.

That is what makes the subsystem survive an outage: while a service is unreachable the last
good values keep being shown, marked as such, instead of records emptying out. Raise it for a
catalogue that changes yearly; lower it where freshness genuinely matters. 300000 is five
minutes.

```bash
DEDALO_EXTERNAL_SOFT_TTL_MS=300000
```

*Default: 300000*

---

### Defining the external retry count

DEDALO_EXTERNAL_RETRY_ATTEMPTS `int`

How many further attempts one outbound lookup makes after the first one fails, with a
growing pause between them. Only failures that a retry could plausibly fix are retried — a
dropped connection, a timeout, a "try later" from the service. A refusal, a not-found or a
malformed document is final and is not repeated.

Set it to `0` to make every lookup single-shot. Do not raise it far: retries multiply the
load a struggling service is already failing under, which is what the circuit breaker
(`DEDALO_EXTERNAL_BREAKER_COOLDOWN_MS`) exists to stop.

```bash
DEDALO_EXTERNAL_RETRY_ATTEMPTS=2
```

*Default: 2*

---

### Defining the external circuit-breaker cooldown

DEDALO_EXTERNAL_BREAKER_COOLDOWN_MS `int`

How long, in milliseconds, the engine stops calling a service after it has failed
repeatedly. During the cooldown every lookup for that service fails instantly from cached data
or from nothing at all — no connection is attempted.

It is the difference between one broken third party and a broken installation: without it,
every record view retries a dead host and every user waits the full timeout for it. The
breaker closes again on its own after the cooldown, and one successful call restores normal
service. 60000 is one minute.

```bash
DEDALO_EXTERNAL_BREAKER_COOLDOWN_MS=60000
```

*Default: 60000*

---

### Defining the external entry length ceiling

DEDALO_EXTERNAL_MAX_ENTRY_CHARS `int`

The longest single value, in characters, the engine will emit from an external record.
A longer one is refused rather than cut: a silently shortened title is a wrong title, and it
would look exactly like a real one.

The value a third party returns is rendered by the client and may be exported and published
from there, so its size is not only a display question. 8192 characters is generous for a
bibliographic field and small enough that no single entry can bloat a record.

```bash
DEDALO_EXTERNAL_MAX_ENTRY_CHARS=8192
```

*Default: 8192*

---

### Defining the external entry count ceiling

DEDALO_EXTERNAL_MAX_ENTRIES `int`

How many values one external component may emit for one record — the count ceiling
beside the length ceiling. A response offering more is cut to this many, and the fact that it
was cut is reported rather than hidden.

It bounds what one remote answer can do to a page: a record with ten thousand contributors
would otherwise be rendered in full, in every list row that shows it. 50 comfortably covers a
real bibliographic record.

```bash
DEDALO_EXTERNAL_MAX_ENTRIES=50
```

*Default: 50*

---

### Defining the Zenon credential

DEDALO_EXTERNAL_ZENON_API_KEY `string`

The credential sent to the Zenon bibliographic service. Zenon's public interface needs
none today, so this is unset by default and unset simply means the request carries no
authorization header — the lookup works exactly as before.

It exists because the credential PATH must exist before it is needed: a service that starts
asking for a key, or a second service added beside this one, must not require a code change to
be authenticated. It is a secret — keep it in `../private/.env`, never in a repository, and
never in the ontology, which is editable data.

```bash
DEDALO_EXTERNAL_ZENON_API_KEY="•••••"
```

*Default: (unset)*

---

## Tools {#tools}

### Defining additional tool roots

DEDALO_ADDITIONAL_TOOLS `array of objects` *optional*

This parameter defines extra directories where Dédalo will look for tools, besides the `tools/` directory of the installation itself.

Tools kept outside the Dédalo directory survive an update of the code and can be versioned on their own, which is what an institution developing its own tools wants. Every entry is an object with a `path` (the directory on disk holding the tool packages) and a `url` (the address the web server publishes that directory at, because the browser loads the tool's own interface code from there). The url must be an address of THIS site — a full address pointing at another host is rejected — and serving the directory at that address is your job, not Dédalo's.

The list is empty by default. The installation's own `tools/` directory is always searched first and always wins a name collision, so an additional root can never quietly replace a tool that ships with Dédalo; a root that does not exist, is not a directory, or sits in a system temporary directory is refused and reported at boot.

```bash
DEDALO_ADDITIONAL_TOOLS=[{"path":"/srv/custom_tools","url":"/custom_tools"}]
```

*Default: (unset)*

---

### Defining the transform definitions directory

DEDALO_TRANSFORM_DEFINITIONS_DIR `string`

This parameter defines the directory holding the transform definition files — the JSON declarations that drive the `move_*` maintenance widgets (move a tipo, move a locator, move data into a portal or into a table, move a language).

A transformation of this kind is written down before it is run: the file lists, item by item, what is moved where. The widget reads the files of its own subdirectory (`<dir>/move_tld/`, `<dir>/move_locator/`, …) and offers them to the operator; only `.json` files sitting directly in that subdirectory are read, never a path that climbs out of it.

Unset, Dédalo reads them from `transform_definition_files` inside the private directory — OUTSIDE the code tree, because a code update replaces the whole install directory and your transformations are institution-specific data an update must not touch. An install that still keeps files at the legacy in-tree `install/transform_definition_files` location is not moved: while that directory holds files and this key is unset, it keeps being used. Point the key at a directory of your own to place them anywhere else.

```bash
DEDALO_TRANSFORM_DEFINITIONS_DIR="/srv/dedalo_transforms"
```

*Default: `<private dir>/transform_definition_files` — a legacy `<install dir>/install/transform_definition_files` holding files keeps being used so nothing moves*

---

### Enabling writes from the tools registration

TOOLS_ENABLE_REGISTRY_IMPORT `bool`

This parameter defines whether the "Register tools" maintenance widget may WRITE to the tools registry, or only report what it would write.

The widget walks every tool directory, validates its declaration and compares it with the tool records stored in the ontology. With this parameter at its default `false`, that is all it does: it reports, per tool, whether it is valid and whether the registry already matches — and changes nothing. Set it to `true` and the same run reconciles the registry, creating or updating the record of each tool.

Leave it off in normal operation and turn it on for the moment you register a newly added tool. An installation that never adds tools of its own never needs it.

```bash
TOOLS_ENABLE_REGISTRY_IMPORT=false
```

*Default: false*

---

### Tools registry cache expiry

TOOLS_REGISTRY_CACHE_TTL_MS `int` *no longer consulted*

This parameter defined how long, in milliseconds, the server kept the tools registry in memory before reading it from the database again.

It is no longer consulted. The expiry existed because a second engine could write the tools registry behind this server's back, so the cache had to be assumed stale after a while. Dédalo is now the only writer of those records, and every write clears the cache the moment it happens — so the data can never be stale and there is nothing to expire.

The key is still recognized, so an existing configuration carrying it still starts, but setting it has no effect and it can be removed.

```bash
TOOLS_REGISTRY_CACHE_TTL_MS=60000
```

*Default: 60000*

---

## Site builder {#sitebuilder}

### Defining the site builder service URL

DEDALO_SITE_BUILDER_URL `string` *optional*

This parameter is the base URL of the **Site Builder** service — the standalone daemon that lets your users build their own public websites over the published data by talking to a coding agent.

The daemon is a separate deployable (`publication/site_builder`) and may run on another host, typically the one that already serves the publication API and its MariaDB. Point this key at the address your reverse proxy publishes it under, including the base path, for example `https://sites.example.org/publication/site_builder`.

**A daemon installed on this same host does not need it.** A provisioned instance publishes no network port: it answers on a private unix socket, which you name with `DEDALO_SITE_BUILDER_SOCKET` instead. Set this key only when the daemon really is reached over the network. When BOTH are set the socket is the transport, and this URL contributes only its path prefix and its host name (the daemon is mounted under a base path, `/publication/site_builder` by default).

Leave both **unset** and the feature does not exist on this install: the site-builder tool hides itself from every toolbar and its actions refuse. Set a transport, set `DEDALO_SITE_BUILDER_INSTANCE` to the museum the daemon serves, set `DEDALO_SITE_BUILDER_TOKEN` to match the daemon's `SERVICE_TOKEN`, grant the tool to the users who should build sites, and they get a workspace where an agent writes the site, a live preview, and a gated publish to production.

```bash
DEDALO_SITE_BUILDER_URL="https://sites.example.org/publication/site_builder"
```

*Default: (unset)*

---

### Defining the site builder unix socket

DEDALO_SITE_BUILDER_SOCKET `string` *optional*

The absolute path of the **unix socket** the Site Builder daemon listens on, for a daemon installed on this same machine. When it is set, the socket **is** the transport: the engine dials it directly and never opens a network connection.

This is what a provisioned daemon offers, and it is preferred over a URL wherever it is available. The daemon's installer creates one socket per instance — `/run/dedalo-sites/<instance>/daemon.sock` — owned by the daemon's own service user with the **engine's group**, mode `0660`. The engine may open it because it group-owns it; no other account on the machine can connect at all, including another museum's daemon or another museum's engine. There is no port to firewall, no token travelling over a network interface, and no way for a second install on the same host to reach this one's daemon.

The path is **not a secret** — it already contains the instance name, the directory above it is world-traversable, and the access decision is the operating system's, not the path's obscurity.

You will not normally type this key by hand: the daemon's provisioner writes an engine pairing fragment (`<config dir>/engine.env.fragment`) carrying exactly these lines, and you append it to this file. When both this key and `DEDALO_SITE_BUILDER_URL` are set, the socket wins and the URL is used only for the path prefix and the host name.

```bash
DEDALO_SITE_BUILDER_SOCKET="/run/dedalo-sites/example/daemon.sock"
```

*Default: (unset)*

---

### Defining the paired site builder instance

DEDALO_SITE_BUILDER_INSTANCE `string` *required when a site builder transport is set*

The name of the site-builder **instance** — the tenancy — this install is paired with. One museum is one Dédalo install and one site-builder instance, so this is a single fixed name, never a list and never something a user chooses at run time.

**It is required as soon as `DEDALO_SITE_BUILDER_URL` or `DEDALO_SITE_BUILDER_SOCKET` is set**, and without it the site-builder tool stays hidden exactly as if nothing were configured. That is not bookkeeping. Before every request, the engine asks the daemon for its identity and refuses to send anything unless it matches: it computes a fingerprint from this name together with `DEDALO_SITE_BUILDER_TOKEN`, and the daemon computes the same fingerprint from its own instance name and its own `SERVICE_TOKEN`. Equal fingerprints prove both that this is the right daemon and that the two sides hold the same credential — and they prove it without either side ever disclosing the name or the token.

The failure that pays for: a private configuration file copied from one museum's server to another's is the single easiest mistake to make in a fleet, and a wrongly pointed engine is not a broken feature — it is one museum's staff driving an agent inside another museum's website, spending that museum's budget and publishing on that museum's public address. With this key set, that arrangement refuses on the first call instead of working.

The value must equal the daemon's `DEDALO_SITE_INSTANCE`. The daemon's provisioner writes it into the engine pairing fragment for you, so appending that fragment sets it correctly.

```bash
DEDALO_SITE_BUILDER_INSTANCE="example"
```

*Default: (unset)*

---

### Defining the site builder service token

DEDALO_SITE_BUILDER_TOKEN `string`

The shared bearer token the engine presents to the Site Builder daemon on every call. It MUST equal the daemon's own `SERVICE_TOKEN` (the daemon's installer generates one and prints it).

It is also one half of the pairing proof: together with `DEDALO_SITE_BUILDER_INSTANCE` it produces the fingerprint the engine checks against the daemon's before it sends anything, so a token that does not match refuses at the door rather than after the fact.

The engine is the daemon's only client and its only authorizer: it authenticates the Dédalo user, decides who may build and who may publish, then calls the daemon with this token and the acting user's identity. The token is what proves the request came from the engine and not from anyone who can reach the daemon's port.

It is a secret: keep it in `../private/.env`, never in a repository. There is no default — without it (and without the URL) the feature is simply off.

```bash
DEDALO_SITE_BUILDER_TOKEN="..."
```

*Default: (unset)*

---

### Defining the site builder request timeout

DEDALO_SITE_BUILDER_TIMEOUT_MS `int`

How long, in milliseconds, the engine waits for a JSON response from the Site Builder daemon before giving up and reporting the service unreachable. It bounds the ordinary control calls (list sites, start a session, trigger a build); the live event stream a session produces is NOT subject to it — a streamed turn may run for many minutes.

The default is `10000` (ten seconds), which is generous for a daemon on the same network. Raise it if the daemon is far away or under load; lower it if you would rather fail fast.

```bash
DEDALO_SITE_BUILDER_TIMEOUT_MS=10000
```

*Default: 10000*

---

## Install {#install}

### Restricting the install wizard by address

DEDALO_INSTALL_ALLOWED_IPS `string` *comma list*

This parameter defines which addresses may reach the install wizard.

A fresh installation has no users yet, so the wizard cannot ask anyone to log in: until the installation is SEALED (the last step of the wizard), its actions are reachable without a password by whoever can open the page — and those actions write the configuration file and restart the server. **Unset, the wizard answers the local machine and nobody else.** To install from another machine — which is the normal case for a container, a virtual machine or a hosted server — you must name the address you will browse from, before you start the wizard.

An entry is one of four things: the word `loopback` (the local machine), a literal address, a range in CIDR notation such as `10.0.0.0/24`, or the word `any`, which opens the wizard to every address. Write `any` only when nothing else can reach the machine — a firewall, or a laptop with no network — and remove it once the installation is sealed. Separate several entries with commas. Write every IPv4 part in plain decimal: a part with a leading zero (`127.0.0.01`, `010.0.0.0/8`) is refused, because some software reads it as octal and some as decimal — such an entry matches no address, and the server log names it as ignored.

The address is taken from the trusted hop reported by the web server in front of Dédalo, so behind a proxy `loopback` will NOT match: name the real address of the machine you install from. If a request arrives with no such information the engine treats it as local, so put the wizard behind the proxy the production guide prescribes, or behind a closed port, whenever the machine is reachable from a network. The effective list is printed in the server log when the engine starts, so an installation you cannot reach tells you why. Once the installation is sealed, the whole install surface answers "not found" for good and this parameter no longer matters.

```bash
DEDALO_INSTALL_ALLOWED_IPS="loopback,203.0.113.10,10.0.0.0/24"
```

*Default: loopback*

---

### Defining the private directory the installer writes to

DEDALO_INSTALL_PRIVATE_DIR `string`

This parameter defines the directory the installer WRITES to — the configuration file it persists, the state file, the sessions and the backups.

By default that is the `private` directory next to the installation, which is where the server also reads its configuration from, and an ordinary installation never sets this key. It exists so that a run which must not touch the live configuration can be pointed somewhere else: the automated checks redirect it to a scratch directory so that a test of the installer can never overwrite the configuration of the machine it runs on.

```bash
DEDALO_INSTALL_PRIVATE_DIR="/srv/dedalo_private"
```

*Default: (unset)*

---

## Maintenance variables {#maintenance}

### Defining server code provider

CODE_SERVERS `array`

This parameter defines the code servers this install offers releases from. Each entry is a JSON object with `name`, `url` and `code`; add entries to the array to offer mirror servers too.

The installers (the command-line installer, the browser wizard and `install.sh`) WRITE the official Dédalo code server entry below, unless the install is declared air-gapped (`--no-update-servers`, the unticked update-server box in the wizard, or answering `n` in `install.sh`), which writes `[]`. Unset or `[]` means no masters: the panel offers no code updates. A re-run of the installer that is not air-gapped leaves a NON-EMPTY list already in the file untouched (mirrors you added survive); a `[]` from an earlier air-gapped run, or a value that is not a valid JSON list, is replaced by the official entry. The list is read at boot, and so is the browser's `connect-src` that lets the update panel reach a master: restart the server after changing it.

`url` is the master's JSON API endpoint — it MUST end in `/dedalo/core/api/v1/json/` (or `/api/v1/json`); any other path answers 404 and the panel reports the server as unreachable. `code` is the shared secret: the master only answers a release manifest to a caller presenting a code listed in its OWN `CODE_SERVERS`.

```bash
CODE_SERVERS=[{"name":"Official Dédalo code server","url":"https://v7.master.dedalo.dev/dedalo/core/api/v1/json/","code":"x3a0B4Y020Eg9w"}]
```

*Default: (unset)*

---

### Code restore points to keep

DEDALO_CODE_RESTORE_POINTS_KEEP `number`

How many code restore points this installation keeps on disk.

Every code update renames the outgoing tree aside as a restore point and keeps it WITH its `node_modules`, so a rollback is a bare `mv` that boots with no network. That is what makes a bad update survivable — and it means each point is a full copy of the code tree, on the same disk the update itself measures and refuses on when it runs short.

Pruning runs after an update the booted tree has CONFIRMED, never before: until that flip the new tree is unproven and the points behind it are the way back. The newest bootable point is never pruned whatever this is set to — it is the rollback for the code running right now.

Set it higher on an installation that updates rarely and has disk to spare; `1` keeps only the rollback.

```bash
DEDALO_CODE_RESTORE_POINTS_KEEP=3
```

*Default: 3*

---

### Defining is a code server directory

DEDALO_CODE_FILES_DIR `string`

This parameter defines the path to the release archives on a code server. Releases are organised in version directories, `<major>/<major.minor>/<version>.zip`, each next to its `.sha256` sidecar:

```
/srv/dedalo/code/7/7.0/7.0.1.zip
/srv/dedalo/code/7/7.0/7.0.1.zip.sha256
```

The directory is CREATED AT BOOT when this key is set on a code server (`IS_A_CODE_SERVER`) and the path does not exist — recursively, at mode `0750`, since only this process reads the archives. An existing directory is left exactly as it is, mode included.

The build action writes both. Remote installs never read this path: they fetch `/dedalo/install/code/<version>/<version>.zip`, which the server maps back to it — so the directory does not need to be inside the web root, and should not be.

```bash
DEDALO_CODE_FILES_DIR="/srv/dedalo/code"
```

*Default: (unset)*

---

### Defining is a code server build version from development git

DEDALO_CODE_SERVER_GIT_DIR `string`

This parameter defines the path to git directory in the server. It use to build the version with for specific version.
GIT directory is a valid git server than can provide the build version.
This parameter is not necessary if the server will be only a mirror from official files.


```bash
DEDALO_CODE_SERVER_GIT_DIR="/my_dedalo_git_directory"
```

*Default: (unset)*

---

### Publishing developer builds from a code server

DEDALO_CODE_SERVER_DEV_CHANNEL `bool`

This parameter lets a code server OFFER developer builds (`<version>-dev.zip`, built from the tip of the `master` branch) to installations that explicitly ask for them. Published releases (`<version>.zip`) are built from release tags (`vX.Y.Z`) and are offered regardless of this setting.

It exists so a developer can test integrated but unreleased work on a real installation without cutting a release: a developer build carries no version bump of its own, so it can be installed OVER the same version. Both switches must be on — this one here, and the "Developer builds" switch in the target installation's code-update panel. A code server that leaves this unset answers a developer-channel request exactly as it answers a normal one, so developer builds are never enumerable from outside.

Everything else is unchanged: the archive is still fetched from a configured code server, still verified against its `.sha256` sidecar, and the update still requires a superuser, maintenance mode and a recent backup.

```bash
DEDALO_CODE_SERVER_DEV_CHANNEL=true
```

*Default: false*

---

### Defining source versions local directory to save the new code

DEDALO_SOURCE_VERSION_LOCAL_DIR `string`

**Not honoured by the engine.** A code update downloads and stages the new release in `.code_staging` under the code-backup root (`<DEDALO_BACKUP_PATH>/.code_staging`), whatever this key says. Setting it has no effect on staging; it is a retirement candidate.

```bash
DEDALO_SOURCE_VERSION_LOCAL_DIR="/tmp/my_museum"
```

*Default: (unset)*

---

### Defining is a code server

IS_A_CODE_SERVER `bool`

This parameter defines if the server can provide code to other Dédalo servers. By default no Dédalo server provides code, but it is possible to set one up as a mirror server that provides code versions. To enable it, also set `DEDALO_CODE_FILES_DIR` — the URL other servers fetch from is derived automatically.

When it is on, the maintenance area shows the **Serve Code** panel: whether this server can publish, the build source, the archives on disk, and the buttons that build a release. See [Updating code](../management/updates/updating_code.md).

```bash
IS_A_CODE_SERVER=false
```

*Default: false*

---

### Is an ontology master server

IS_AN_ONTOLOGY_SERVER `bool`

It defines if the installation server can provide his ontology files to other Dédalo servers.

The maintenance area's **Serve Ontology** panel shows whether this key, `ONTOLOGY_SERVER_CODE` and `DEDALO_CORS_ALLOWED_ORIGINS` are set, and the endpoint other installations register. See [Updating ontology](../management/updates/updating_ontology.md#serving-other-installations-ontology-master).

```bash
IS_AN_ONTOLOGY_SERVER=false
```

*Default: false*

---

### Ontology recovery file path

DEDALO_ONTOLOGY_RECOVERY_PATH `string`

This parameter defines where the ontology recovery file is written and read. Before an ontology update, Dédalo dumps the whitelisted slice of the ontology into this gzipped SQL file, so a failed update can be examined and the previous definitions restored.

Unset, the file lives at `db/dd_ontology_recovery.sql.gz` inside the private directory — OUTSIDE the code tree, because a code update replaces the whole install directory and the recovery dump is exactly the file you need AFTER an update went wrong. A recovery file still sitting at the legacy in-tree location (`install/db/dd_ontology_recovery.sql.gz`) keeps being read while no file exists at the new location, with a warning; the next build always writes to this path.

```bash
DEDALO_ONTOLOGY_RECOVERY_PATH="/srv/dedalo_private/db/dd_ontology_recovery.sql.gz"
```

*Default: `<private dir>/db/dd_ontology_recovery.sql.gz`*

---

### Ontology input/output, export/import or download directory

ONTOLOGY_DATA_IO_DIR `string`

This parameter defines the directory to input/output the ontology files in the server. Ontology files can be created by master ontology servers or downloaded from an external provider such as the official master Dédalo server.

Unset, Dédalo prefers `import/ontology` inside the private directory — OUTSIDE the code tree, because a code update replaces the whole install directory and would otherwise carry downloaded or exported ontology files away with the old code. The legacy `install/import/ontology` directory inside the install tree ships the vendored ontology seed files, so it keeps being used until you create the private-directory home (move any files of your own there) or set this key explicitly.

Files are organised in version directories, `<major.minor>/`: one `<tld>.copy.gz` per ontology, `matrix_dd.copy.gz` for the private lists, and the `ontology.json` (plus `ontology_llm_map.json`) that describe them. The canonical production layout is:

```
/srv/dedalo/ontology/7.0/dd.copy.gz
/srv/dedalo/ontology/7.0/matrix_dd.copy.gz
/srv/dedalo/ontology/7.0/ontology.json
```

```bash
ONTOLOGY_DATA_IO_DIR="/srv/dedalo/ontology"
```

*Default: `<private dir>/import/ontology` once that directory exists; until then the legacy `<install dir>/install/import/ontology` (which ships the vendored ontology seeds) keeps being used*

---

### defining the  ontology master server code

ONTOLOGY_SERVER_CODE `string`

It  defines the valid code for clients to validate to get ontology files.

```bash
ONTOLOGY_SERVER_CODE="x3a0B4Y020Eg9w"
```

This parameter needs to be included as `code` in [ONTOLOGY_SERVERS](#ontology-servers) defintion in every authorized client.

*Default: (unset)*

---

### Ontology servers

ONTOLOGY_SERVERS `array of objects`

This parameter defines the ontology master servers to get the ontology updates. The servers could be:

- the official dedalo.dev server
- an external server for local Ontologies (private Ontologies of entities.)
- local server, the current installation

Each entry is a JSON object with `name`, `url` and `code`.

The installers (the command-line installer, the browser wizard and `install.sh`) WRITE the official dedalo.dev entry below, unless the install is declared air-gapped (`--no-update-servers`, the unticked update-server box in the wizard, or answering `n` in `install.sh`), which writes `[]`. Unset or `[]` means no masters: the panel offers no ontology updates. A re-run of the installer that is not air-gapped leaves a NON-EMPTY list already in the file untouched (mirrors you added survive); a `[]` from an earlier air-gapped run, or a value that is not a valid JSON list, is replaced by the official entry.

The list also has an install-time role: its FIRST entry (a preserved custom list, otherwise the official server) is where the installer fetches every domain ontology other than the built-in `oh`, and whose catalog decides which ontologies can be chosen, unless `--ontology-source` names a local export. With `[]` and no `--ontology-source`, only `oh` can be installed.

Configuration for the official dedalo.dev server:

```bash
ONTOLOGY_SERVERS=[{"name":"Official Dédalo Ontology server","url":"https://v7.master.dedalo.dev/dedalo/core/api/v1/json/","code":"x3a0B4Y020Eg9w"}]
```

It gets the tld from the [ACTIVE_ONTOLOGY_TLDS](#defining-active-ontology-tlds) definition.

A master is identified by its `url`, not by its `code`: several masters may share one access
code, and the update downloads only from the address of the master picked in the panel. List
each master once.

The update panel interrogates each master **from the browser**, so the engine adds every origin
named here to its own `connect-src` Content-Security-Policy automatically — there is no second
setting to keep in step. The policy is built at boot, so **restart** after adding a master, or
the browser refuses the call before it leaves and the panel reports
`Max retries reached, request failed`.

Local ontologies can be provided by other installations in parallel by adding new
entries to this list. Every Dédalo server can provide its own ontologies.

*Default: (unset)*

---

### Sync ontology from master server

STRUCTURE_FROM_SERVER `true || false` (optional; unset = not configured)

**Not honoured by the engine.** The key is still parsed, but nothing reads the value: it has no effect on ontology updates, which are run from the *Update ontology* panel against the masters in [ONTOLOGY_SERVERS](#ontology-servers). A v6 `.env` that carries it keeps booting; the line can be removed. It is a retirement candidate.

```bash
STRUCTURE_FROM_SERVER=true
```

*Default: (unset)*

---

### Enable local IP to Country resolution

DEDALO_GEOIP_ENABLED `bool`

Enables the built-in, self-hosted IP to Country resolution used in section Activity to show the source country flag from an IP address.

Resolution runs on the server against a local, openly-licensed country database (DB-IP IP to Country Lite, CC-BY-4.0) — no third-party request is made from the browser. When disabled, IP addresses are shown without a country flag.

```bash
DEDALO_GEOIP_ENABLED=true
```

*Default: true*

---

### IP to Country database directory

DEDALO_GEOIP_DIR `string`

Directory where the local IP to Country database file is downloaded and cached. Defaults to `geoip` inside the private directory (outside the web root).

```bash
DEDALO_GEOIP_DIR="/srv/dedalo/geoip"
```

*Default: `<private dir>/geoip`*

---

### Auto-download and refresh the IP to Country database

DEDALO_GEOIP_AUTO_UPDATE `bool`

When enabled, the server downloads the IP to Country database on first use and refreshes it monthly. Disable it to use only a database file placed manually in `DEDALO_GEOIP_DIR` (e.g. air-gapped installs).

```bash
DEDALO_GEOIP_AUTO_UPDATE=true
```

*Default: true*

---

### IP to Country database download URL override

DEDALO_GEOIP_DB_URL `string`

Overrides the default monthly DB-IP download URL. Use it to point at a mirror or a pinned month. The default is `https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.mmdb.gz` (the current month, with a fallback to the previous month), computed automatically.

```bash
DEDALO_GEOIP_DB_URL="https://mirror.example.org/dbip-country-lite-2026-07.mmdb.gz"
```

*Default: (unset)*

---

## Diffusion variables {#diffusion}

### Publication server API v1 access codes

API_WEB_USER_CODE_MULTIPLE `array of objects` *optional*

The publication databases served by the legacy publication server API v1
(`publication/server_api/v1`), each with the access `code` that API expects. The
maintenance dashboard (Publication → Publication server API) shows one "Open Swagger UI"
button per entry, opening the API's interactive documentation for that database with the
code, the database name and the current interface language already filled in.

Every entry is an object with `db_name` (the publication database) and `code` (the same
value as `API_WEB_USER_CODE` in that API's own configuration). The optional `api_ui`
is the address of the documentation page when the API runs on another server; unset, it
is `/dedalo/publication/server_api/v1/docu/ui/` on this site. The v1 API and its
documentation page are a separate application that Dédalo itself never serves: the default
address only works when the web server in front of Dédalo routes `/dedalo/publication/`
to that application —
otherwise the button answers "not found", and `api_ui` must point at the server that does
run v1. Only an `http(s)://` or a root-relative address is accepted. An entry without `db_name` or `code` is dropped and
reported at boot. The v6 configuration migrator carries the v6 value across, leaving
out the empty entry a stock v6 configuration ships.

Empty by default: no buttons are shown. The codes are only sent to global administrators,
the only users who can open the maintenance area. The publication server API v2 is configured in its own `.env`,
not here.

```bash
API_WEB_USER_CODE_MULTIPLE=[{"db_name":"web_my_entity","code":"my_api_code"}]
```

*Default: (unset)*

---

### Publication record batch size

DEDALO_DIFFUSION_BATCH_RECORDS `int`

The number of records the publication resolver walks per batch. Diffusion is a
streaming process: records are selected in ordered batches, resolved, and handed to
the format writer, so that a section of hundreds of thousands of records never has to
fit in memory at once. A smaller batch lowers the memory ceiling of a publication run;
a larger one reduces the number of round trips to the database.

Unset, a run resolves **500** records per batch. Each publication run reads the key when
it starts (a resumed run reads it again), so a change applies from the next start. Each
batch is also one durable step: its records, its checkpoint and its run-ledger rows are
written together, so a smaller batch means less work to redo when a run is resumed. The
diffusion panel of the maintenance dashboard reports the configured value.

```bash
DEDALO_DIFFUSION_BATCH_RECORDS=500
```

*Default: (unset)*

---

### Publication rows per write statement

DEDALO_DIFFUSION_BATCH_ROWS `int`

The maximum number of rows the engine packs into a single insert/update statement
when it writes a published table into the target database. Default `200`.

Raise it to reduce the number of statements sent to a remote target database (fewer,
bigger writes); lower it if the target rejects or chokes on large statements — a very
wide table (many columns, long texts) can hit the target's maximum packet size before
it hits the row cap. Any value that is not a positive number falls back to the default.

```bash
DEDALO_DIFFUSION_BATCH_ROWS=200
```

*Default: 200*

---

### Diffusion domain

DEDALO_DIFFUSION_DOMAIN `string`

This parameter would be set with the diffusion domain of our project publication, diffusion domain is the target domain or the part of diffusion ontology that will be used to get the tables and fields and the relation components in the back-end.

The definition for diffusion domain in the configuration file can set only one ontology diffusion_domain for our installation, it can have different diffusion groups or diffusion elements with different databases and tables.

```bash
DEDALO_DIFFUSION_DOMAIN="default"
```

> Any other 'section_tipo' are accepted and it can be other standard tlds used in the ontology like oh1 or ich1. If your institution has a specific tld space in the ontology, you can use your own tld into the DEDALO_DIFFUSION_DOMAIN.

*Default: (unset)*

---

### Published files root

DEDALO_DIFFUSION_FILES_ROOT `string`

The directory under which the file-format publications (RDF, XML, Markdown, CSV,
JSON…) are written, one subdirectory per format and publication target. When unset — the
normal case — Dédalo publishes under its media root (the resolved `MEDIA_PATH`, or the
derived default when that key is unset).

Publishing and un-publishing (which removes the files of a deleted record) resolve the
root through ONE function (`src/core/diffusion_bridge/published_files.ts`), so they
agree on where the artifacts are whether this key is set or not. Change it only between
publications: files published under the previous root are not moved, and a record deleted
after the change is un-published under the NEW root only — run the `public_tier`
reconcile against the old root before retiring it.

Set it when the published files must live outside the media root, for example on a
volume that the public web server exposes and the media root is not.

```bash
DEDALO_DIFFUSION_FILES_ROOT="/var/www/published"
```

*Default: (unset)*

---

### Concurrent publication runners

DEDALO_DIFFUSION_MAX_RUNNERS `int`

How many publication jobs may run at the same time. Dédalo queues every diffusion
request durably and dispatches it to a **runner process** of its own — a separate,
killable process with its own memory ceiling — so a long publication survives a browser
disconnect, a logout, or a server restart. This key caps how many of those processes
the scheduler will have in flight; further jobs simply wait in the queue. Default `2`,
minimum `1`.

Raise it on a machine with spare cores and database connections; each runner opens its
own database pool, so the budget to respect is
`DB_POOL_MAX × (1 + DEDALO_DIFFUSION_MAX_RUNNERS)` connections against the PostgreSQL
server's `max_connections`.

```bash
DEDALO_DIFFUSION_MAX_RUNNERS=2
```

*Default: 2*

---

### Native diffusion engine

DEDALO_DIFFUSION_NATIVE `bool`

Routes the publication tool to the diffusion engine built into this server instead
of the separate, external diffusion service of earlier releases. The tool in the browser
is unchanged, only the server that answers it is.

Defaults to `true`: this server IS the diffusion engine. It was `false` while
installations still ran the separate service of earlier releases alongside Dédalo, but that
service is decommissioned and this server serves no `/dedalo/diffusion/api/v1/` route — so
with the flag off every publication call from the tool fails with a 404.

Set it to `false` ONLY on a deployment that still runs the external service and reaches
it through a reverse-proxy route of its own.

```bash
DEDALO_DIFFUSION_NATIVE=false
```

*Default: true*

---

### Elements routed to the native diffusion engine

DEDALO_DIFFUSION_NATIVE_ELEMENTS `array`

A staged-migration lever: the diffusion element tipos that the native engine is
allowed to publish, or the single value `all` for every one of them. An element outside
the list is refused loudly with an explicit "not routed" message, so that one
element+section is never published by two engines at once.

Accepted encodings: a JSON array or a plain comma-separated list — both parse to the same
set.

Use it to move a large installation over one publication at a time. Unset (the default)
is permissive — every element is accepted — which is the right posture for a development
box and for an installation that has finished its migration.

```bash
DEDALO_DIFFUSION_NATIVE_ELEMENTS=["dd1190","rsc167"]
```

*Default: (unset)*

---

### Defining resolution levels; going to the deeper information

DEDALO_DIFFUSION_RESOLVE_LEVELS `int`

This parameter set the number of resolution levels we would like to accomplish. By default, its value is set to '2'.

```bash
DEDALO_DIFFUSION_RESOLVE_LEVELS=2
```

> Every other positive, numerical value will be accepted.

The number defines the maximum resolution levels of linked information that Dédalo will resolved in the publication process. Dédalo work with related data connected by locators, every link is a level of information, the parameter limit the quantity of linked data will be resolve in the linked data tree.

Ex: If you have an Oral History interview (level 0) with 1 linked image (level 1) and this image has a person linked as author (level 2) and these author 1 linked toponym for the birthplace (level 3). For publishing all linked information will be necessary 3 levels of resolution:

If you increase the value of this parameter, the time needed by Dédalo to resolve the linked data in the publication process will also increase in exponential progression.

*Default: 2*

---

### Publication job scheduler

DEDALO_DIFFUSION_SCHEDULER_ENABLED `bool`

Whether **this** server claims publication jobs from the queue and dispatches runner
processes for them. Enabled by default: a standard, single-server installation must have
it on, or publications will queue and never start.

Set it to `false` only on an instance that must not touch the live queue — a second
instance of the same installation (a maintenance or smoke-test copy sharing the database)
or a deployment where a dedicated machine runs the runners. Turning it off disables only
the claiming and the recovery sweep of interrupted jobs; the rest of diffusion, including
the removal of a deleted record from the published tables, keeps working.

```bash
DEDALO_DIFFUSION_SCHEDULER_ENABLED=false
```

*Default: true*

---

<!-- END GENERATED -->
