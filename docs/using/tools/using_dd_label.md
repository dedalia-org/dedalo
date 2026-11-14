# Label composition tool (`tool_dd_label`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_dd_label.md)

A grid editor for a tool's multi-language interface labels: it turns the raw label JSON into an editable table with one row per label key and one column per project language.

!!! note "This is a tool-authoring helper"
    You use `tool_dd_label` while registering or maintaining a Dédalo **tool** — to write the localized strings its buttons and headers show. It attaches only to the *Tool labels* field of a tool's registry record, so if you are not building or translating a tool, you will not meet it.

!!! warning "Tool labels ≠ the application's program strings"
    This tool edits **one tool's own** labels — the `dd1372` payload in that tool's `register.json`. It does **not** touch Dédalo's general program strings — the *Save* / *Delete* / *Cancel* buttons, menus and dialogs shared across the whole application. Those live in the repo label catalogs (`src/core/labels/master.json` + `catalog/lg-<code>.json`) and are edited as **code**, not through any UI — see [Internationalization → Program strings](../../development/internationalization.md#2b-program-strings-the-repo-label-catalogs-get_label). WC-034 moved some strings that used to be global into the tools that alone used them; those are now edited here.

## What it's for

Dédalo tools keep their interface strings — button captions, panel titles, confirmation prompts — as a set of localized labels, one string per label key and language. Stored raw, that is an array of JSON objects, awkward to edit by hand and easy to get wrong. `tool_dd_label` renders the same data as a **matrix**: each row is a label key (for example `save` or `cancel`), each column is one of your project's languages, and each cell holds the translated string. You fill in the grid instead of editing JSON.

A concrete example: a developer finishing a new cataloguing tool needs its **Process** button and **Are you sure?** prompt to read correctly in English, Spanish, and Basque. They open this tool on the tool's *Tool labels* field, add a `process` row and a `confirm` row, type each translation into the right language column, and save — no hand-written JSON.

## When to use it

- While authoring or translating a Dédalo tool, to compose or update the strings its interface shows across every project language.
- Whenever you would otherwise be hand-editing a tool's raw label array.

It edits **only** a tool's label field. It does not translate content records, and it does not translate for you — you type each string.

## Where to find it

The tool attaches to the *Tool labels* field (component tipo `dd1372`) of a tool's registry record in the *Tools development* section (section tipo `dd1340`). Open that field and launch the tool from its button. It reads the field's **current in-memory value**, so any unsaved edits you made to the JSON directly are preserved when the grid opens.

## Using it, step by step

1. Open a tool's registry record and launch `tool_dd_label` on its *Tool labels* field.
2. The grid appears: a header row of language names across the top, and one row per existing label key. Each language cell is directly editable.
3. **Add a label key:** press the add button in the top-left corner. A new blank row appears. Type the key name in the first (name) cell — the tool normalizes it to lowercase and replaces spaces with underscores (so "Confirm delete" becomes `confirm_delete`).
4. **Fill in translations:** click a language cell and type the string for that key in that language. The change is captured when you leave the cell or press Enter.
5. **Clear a translation:** empty a cell and leave it — the label for that language is removed.
6. **Remove a key:** press the remove button at the start of its row and confirm. The whole row and all its translations are deleted.
7. **Save.** Your edits are written into the field, but not yet to the database. Close the tool and press the **save** button on the *Tool labels* field to persist them.

!!! warning "Edits are not saved until you save the field"
    The grid writes your changes back into the field's editor immediately, but nothing reaches the database until you click **save** on the *Tool labels* component itself. If you close Dédalo without saving that field, your label edits are lost. Removing a row is likewise only committed on that save.

## Related

- **[tool_lang](using_lang.md)** — automatic translation of a content component's data (a different job: it translates records, not tool labels).
- **[Developer reference](../../development/tools/reference/tool_dd_label.md)** — the label data shape, the client behavior, and registration.
