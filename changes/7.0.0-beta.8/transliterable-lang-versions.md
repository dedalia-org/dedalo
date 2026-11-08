---
title: Components with language versions show the other version beside the value, and offer the translation tool
type: fixed
audience: user
date: 2026-10-31
wc: WC-2026-10-31-transliterate-value-emitted
---
Some fields are not translated but can keep a version per language beside their
base value — a personal name written once and transliterated into Greek or
Russian, for example, or any IRI field. These fields are marked with
`with_lang_versions` in the ontology.

Before, such a field behaved like a plain untranslated one. The translation tool
was not offered on it, and the version in your working language was not shown
next to the value.

Now:

- The translation tool appears on these fields and on every IRI field. Inside
  the tool, the version you edit shows the base value beside it.
- In the edit form and in lists, the version in your working data language is
  shown beside the base value, for example "Augustus (Αύγουστος)".
- Opening an IRI field's version in the translation tool no longer fails.
- Searching one of these fields also finds the record by any of its language
  versions, not only by the base value.
- The edit form keeps editing the base value even when your working data
  language is another one; only the translation tool edits a version.
- When published, these fields give each language its own version and fall
  back to the base value when a language has none. IRI fields no longer publish
  the base and all its versions joined together in every language.
- The options of selectors, radio buttons and check boxes are always labelled in
  your working data language, also right after saving. Before, they could
  appear in the installation's default language.
- In the Time Machine history of one of these fields, a change to a language
  version shows that version as the row's value, no longer as a greyed
  missing-translation hint.
