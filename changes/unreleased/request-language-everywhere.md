---
wc: WC-2026-10-20-element-context-default-lang
title: Labels and defaults follow the language you chose, not the installation's.
type: fixed
audience: user
date: 2026-11-22
---
Several places still answered in the installation's configured language (or in a
fixed language) instead of the one the user had chosen in the menu:

- the CSV import tool (column mapper, file preview, import progress) and the
  posterframe tool named sections and fields in the installation's interface
  language; they now use the user's;
- the thesaurus export (`hierarchy.json`) and the ontology census picked each
  name in the installation's interface language; the pick now follows the
  operator running it (every stored language is still exported);
- a new record was stamped with the section name in the installation's
  interface language; it now takes the creating user's interface language;
- the login page declared the installation's interface language even when the
  page was shown in another one;
- a search-panel filter field declared by a portal was prepared in Spanish
  whatever the data language;
- for the assistant tools (MCP), an omitted language was English: section lists,
  section descriptions, record reads and searches now default to the data
  language (for the command-line MCP server, which has no user session, the
  installation's main data language, `DEDALO_DATA_LANG_DEFAULT`; send `lang` to
  ask for another);
- object identification (similar records, clustering, the neighbour vote of
  proposals) compared records in the installation's main data language; it now
  compares them in the user's data language.

When a value is missing in the chosen language, the thesaurus term and the
indexation grid now fall back to the installation's main data language
(`DEDALO_DATA_LANG_DEFAULT`), as the rest of the application does, instead of the
menu's starting language.
