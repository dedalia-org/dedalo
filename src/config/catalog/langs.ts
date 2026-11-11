/**
 * CONFIG CATALOG — domain: langs
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import type { CatalogEntry } from '../catalog_types.ts';

export const LANGS_KEYS = {
	APPLICATION_LANG: {
		type: 'string',
		scope: 'operator',
		default: 'lg-spa',
		heading: 'Defining application language',
		typeLabel: 'string',
		doc: `This parameter defines the language will us Dédalo for the user interface.

This is a dynamic parameter and it can be changed when the user login, or in application menu. When the language is changed it is saved into the user's session and it is read to maintain coherence in the diary workflow. If the user's session does not have defined the application language then Dédalo will use the application default language definition.

\`\`\`bash
APPLICATION_LANG="lg-spa"
\`\`\`

> You can set this as a fixed value, but it is recommended you do not — to change the
> default interface language, use \`DEDALO_APPLICATION_LANGS_DEFAULT\` instead.`,
	},
	// APPLICATION_LANGS was DELETED here (2026-07-13) — it was never a real key. Nothing set
	// it; three call sites read it and CSV-split it, which (the real UI-language key,
	// DEDALO_APPLICATION_LANGS, being a JSON map) always yielded garbage and fell through to a
	// hardcoded 'lg-spa,lg-cat,lg-eng'. Any install whose languages were not Spanish/Catalan/
	// English was silently indexed and searched in the wrong ones. Those sites now read
	// config.menu.projectsDefaultLangs; the census tripwire makes the ghost unrevivable.
	DATA_LANG: {
		type: 'string',
		scope: 'operator',
		default: 'lg-spa',
		heading: 'Defining data language',
		typeLabel: 'string',
		doc: `It defines the data language used by Dédalo to process and render textual information.

This is a dynamic parameter that can be changed by the user in any moment. Dédalo is a real multi-language application, it can manage information in multiple languages and process it as unique information block (the field store any translated version of his data). The user can translate any information directly or using specific tools. This parameter define the current language used.

\`\`\`bash
DATA_LANG="lg-spa"
\`\`\`

> You can set this as a fixed value, but it is recommended you do not — to change the
> default data language, use [DEDALO_DATA_LANG_DEFAULT](#defining-default-data-language)
> instead.`,
	},
	DATA_LANG_SYNC: {
		type: 'boolean',
		scope: 'operator',
		default: false,
		heading: 'Defining data language sync',
		typeLabel: 'bool',
		doc: `Defines whether the application language and data language selection remain synchronized.

When set to ' true', it forces to keep DEDALO_APPLICATION_LANG and DEDALO_DATA_LANG synchronized across changes.
The default value is 'false', which allows the application language and data language to be selected independently.

\`\`\`bash
DATA_LANG_SYNC=false
\`\`\``,
	},
	DATA_NOLAN: {
		type: 'string',
		scope: 'operator',
		default: 'lg-nolan',
		heading: 'Defining data without language (no lang)',
		typeLabel: 'string',
		doc: `This parameter defines the tld used by Dédalo to tag data without translation possibility.

Dédalo is multi language by default, all information could be translated to other languages that the main lang, but some data is not susceptible to be translated, like numbers, dates or personal names. In these cases Dédalo defines this kind of data as "not translatable" with the specific tld define in this parameter.

By default and for global Dédalo definition for non translatable data this tld is: \`lg-nolan\`

\`\`\`bash
DATA_NOLAN="lg-nolan"
\`\`\``,
	},
	DEDALO_APPLICATION_LANGS: {
		required: true,
		installSentinel: { 'lg-eng': 'English' },
		type: 'string_map',
		scope: 'operator',
		default: {
			'lg-eng': 'English',
			'lg-spa': 'Castellano',
		},
		defaultDoc:
			'**required, no default** — the installer writes it (working languages: default `lg-eng`, `lg-spa`; interface and data default: the first one picked); the value shown in sample.env is the install-mode stand-in, never a fallback',
		heading: 'Defining application languages',
		typeLabel: 'object',
		typeSuffix: '(a JSON map of `lg-*` code → label)',
		doc: `This parameter defines the languages that Dédalo will use for the data and user interface. Dédalo is a true multi-language application, any text field can be defined as translatable and this configuration define the languages that the installation will use to store and translate text data. When the user select one of those languages Dédalo will change the data showed or the user interface, so it will render all data with this new language.

**Required** — the server refuses to boot without a non-empty value. The installer writes it from the working languages picked (\`lg-eng\` and \`lg-spa\` by default).

\`\`\`bash
DEDALO_APPLICATION_LANGS={"lg-spa":"Castellano","lg-cat":"Català","lg-eus":"Euskara","lg-eng":"English","lg-fra":"French"}
\`\`\`

> See the Dédalo structure lang for see the languages definitions.`,
	},
	DEDALO_APPLICATION_LANGS_DEFAULT: {
		required: true,
		installSentinel: 'lg-eng',
		type: 'string',
		scope: 'operator',
		default: 'lg-eng',
		defaultDoc:
			'**required, no default** — the installer writes it (working languages: default `lg-eng`, `lg-spa`; interface and data default: the first one picked); the value shown in sample.env is the install-mode stand-in, never a fallback',
		heading: 'Defining default application language',
		typeLabel: 'string',
		doc: `Defines the main language will used in the user interface.

**Required** — the server refuses to boot without it. The installer writes it (default: the first working language picked, \`lg-eng\` by default).

Dédalo can be translated to any language, the translations of the interface are done in the ontology. The users can change the Dédalo interface to use it in his language. In Dédalo the user interface and the data language are separated concepts and it is possible have a interface in one language and the data in other. This main language will be used as primary option and as fall back language when the element does not have the translation available.

\`\`\`bash
DEDALO_APPLICATION_LANGS_DEFAULT="lg-eng"
\`\`\`

> See the Dédalo structure lang for see the languages definitions.`,
	},
	DEDALO_DATA_LANG_DEFAULT: {
		required: true,
		installSentinel: 'lg-eng',
		type: 'string',
		scope: 'operator',
		default: 'lg-eng',
		defaultDoc:
			'**required, no default** — the installer writes it (working languages: default `lg-eng`, `lg-spa`; interface and data default: the first one picked); the value shown in sample.env is the install-mode stand-in, never a fallback',
		heading: 'Defining default data language',
		typeLabel: 'string',
		doc: `Defines the main language will used by Dédalo to manage and process data.

**Required** — the server refuses to boot without it. The installer writes it (default: the first working language picked, \`lg-eng\` by default).

The main language is the mandatory language for the text data in the catalog or inventory. Dédalo is a real multi-language application, it can manage multiple translation of the textual information.

In a multi-language situation, when you require some translated information but it is not present (because it is not done), Dédalo will need to use the main language to do a fall back process to main language to show the data. If the main language data is not present, Dédalo will use any other language to show those data.

\`\`\`bash
DEDALO_DATA_LANG_DEFAULT="lg-spa"
\`\`\``,
	},
	DEDALO_LANG_EQUIVALENCES: {
		type: 'string',
		scope: 'operator',
		default: '[["lg-cat","lg-vlca"]]',
		heading: 'Declaring language equivalences',
		typeLabel: 'json',
		doc: `Groups of language codes that are the same language under different names. The shipped
default declares Català and Valencià as one language, matching how earlier Dédalo versions
treated them.

The FIRST code of each group is the canonical *translation source*: ontology terms and
interface labels are authored there, and the other members read those translations (a
Valencian interface shows the Catalan term rather than an arbitrary language). For record
DATA the members are mutual preferred fallbacks in both directions: a user browsing in
Catalan sees a transcript that exists only in Valencian, and vice versa, before the
install-default fallback applies.

Add groups for other equivalences your collection needs; an empty array \`[]\` turns the
mechanism off entirely.

\`\`\`bash
DEDALO_LANG_EQUIVALENCES='[["lg-cat","lg-vlca"]]'
\`\`\``,
	},
	DEDALO_DATA_LANG_SELECTOR: {
		type: 'boolean',
		scope: 'operator',
		default: true,
		heading: 'Defining data language selector',
		typeLabel: 'bool',
		doc: `It defines if the menu show or hide the data language selector.

When the selector is showed the user can change the data language independently of the interface language. If the selector is hide the data language is synchronous to the interface language a change in the interface language will be a change in the data language.

\`\`\`bash
DEDALO_DATA_LANG_SELECTOR=true
\`\`\``,
	},
	DEDALO_DIFFUSION_LANGS: {
		// 'string_list' — NOT 'string'. The declared type was the whole defect: labelled
		// 'array' and documented with a JSON example, but typed 'string', so nothing
		// stopped four call sites reading it raw and comma-splitting it. Under readList
		// the JSON example is now TRUE. Gate: config_declaration_tripwire.
		type: 'string_list',
		scope: 'operator',
		default: undefined,
		defaultDoc: 'the project languages (DEDALO_PROJECTS_DEFAULT_LANGS)',
		heading: 'Defining diffusion languages',
		typeLabel: 'array',
		doc: `This parameter defines the languages that Dédalo will use to publish data.

It controls the amount of languages processed when data is published. Publishing builds one fixed rendition per language, falling back to the main languages' correspondences where a field has no value in the language being processed; this parameter narrows the set of languages that work is done for, so an installation can publish fewer languages than it edits in.

Unset (or empty) it DERIVES from the project languages: the value of DEDALO_PROJECTS_DEFAULT_LANGS is used verbatim, order included. Set it only to separate the published languages from the editing ones.

Accepted encodings: a JSON array or a plain comma-separated list — both parse to the same set. ORDER IS LOAD-BEARING: the first entry is the main publication language.

Every entry must be a \`lg-xxx\` code (the \`all\` sentinel is NOT a language and is refused here) and must be ONE OF the project languages: a language the installation does not edit in has no data to publish. An entry that fails either rule is reported at boot and REFUSES the publication plan — a wrong lang list silently publishes empty renditions, which is worse than not publishing.

\`\`\`bash
DEDALO_DIFFUSION_LANGS=["lg-spa","lg-cat","lg-eng"]
\`\`\`

>The parameter use the Dédalo tld definition for languages. See DEDALO_APPLICATION_LANGS definition to show some examples.`,
	},
	DEDALO_STRUCTURE_LANG: {
		type: 'string',
		scope: 'operator',
		default: 'lg-spa',
		heading: 'Defining structure lang',
		typeLabel: 'string',
		doc: `This parameter defines the ontology LABEL FALLBACK language. Every ontology label (the name of an area, section, field or tool shown in the interface) can be translated to any language; when the interface language has no translation for a label, Dédalo shows it in this language, and when this language is missing too, in any other language available.

It is only a label fallback. It does not name anything: model names, table, column and database names and RDF names are language-free machine names stored in the ontology (the "machine name" field), so changing this parameter never renames a table or a model. It does not define the main data language either.

\`\`\`bash
DEDALO_STRUCTURE_LANG="lg-spa"
\`\`\`

>For the languages, Dédalo uses the pattern: \`lg-xxx\`
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
>| lg-jpn | Japanese |`,
	},
	PROJECTS_DEFAULT_LANGS: {
		required: true,
		installSentinel: ['lg-eng'],
		type: 'string_list',
		scope: 'operator',
		default: ['lg-eng', 'lg-spa'],
		defaultDoc:
			'**required, no default** — the installer writes it (working languages: default `lg-eng`, `lg-spa`; interface and data default: the first one picked); the value shown in sample.env is the install-mode stand-in, never a fallback',
		heading: 'Defining default projects languages',
		typeLabel: 'array',
		doc: `This parameter defines the languages that will use for export and publish data.

**Required** — the server refuses to boot without it. The installer writes it, in its legacy spelling \`DEDALO_PROJECTS_DEFAULT_LANGS\`, from the working languages picked (\`lg-eng\`, \`lg-spa\` by default).

This definition control the amount of languages that will be processed to export data or publish data in the publication process.

When Dédalo export data or publish data, it check the languages of every field of every record to create a fixed version of the data with the language processed or his own correspondences of the main languages when the data is not available in the current language. This parameter reduce the amount languages used in those processes.

\`\`\`bash
PROJECTS_DEFAULT_LANGS=[ "lg-spa", "lg-cat", "lg-eng"]
\`\`\`

> The parameter use the Dédalo tld definition for languages. See DEDALO_APPLICATION_LANGS definition to show some examples.`,
	},
} as const satisfies Record<string, CatalogEntry>;
