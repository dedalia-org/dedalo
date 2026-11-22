# Hierarchy tool (`tool_hierarchy`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_hierarchy.md)

Turns a hierarchy-definition record into a working, browseable hierarchy: it checks everything a hierarchy needs to function, tells you what is missing, and builds it in one step.

## What it's for

Dédalo lets you organize records into trees — a thesaurus, a taxonomy, a classification. Before you can browse or file records into one, several pieces have to exist: the virtual sections that hold the tree's nodes, the flag that marks the hierarchy active, and a root term for the tree to hang its branches on. `tool_hierarchy` creates all of that for you and reports on anything that is not yet in place.

A concrete example: a numismatics team keeps a flat *Coin types* list, but wants to organize those types **within the mints that struck them** — a "Mints → types" tree cataloguers can browse. A curator writes a definition record (a name, a TLD, the source real section, a typology), opens this tool on it, and presses **Activate / repair**. The tool builds the virtual sections, roots the tree at a term named after the hierarchy, and the new thesaurus appears, ready to fill. [tool_cataloging](using_cataloging.md) is then used to drag the real *Coin types* records into the tree.

## When to use it

- You created a hierarchy-definition record (a row of the *Hierarchies* section, tipo `hierarchy1`) and want that hierarchy to start working.
- A hierarchy is half-built or broken — the tree has no root, the hierarchy does not show up in menus — and you want to see why and fix it.
- After adjusting a definition record, to re-check that it is still consistent.

Do not reach for it for everyday record editing. It operates only on hierarchy-definition records, not on your content. To *fill* a hierarchy with records once it is built, use [tool_cataloging](using_cataloging.md) instead.

!!! tip "It is a repair tool, not just a generator"
    Pressing **Activate / repair** on a healthy hierarchy is safe — it reports that everything is already consistent and changes nothing. It only ever creates what is missing, so you can run it any time you are unsure whether a hierarchy is complete.

## Where to find it

The tool attaches **only** to hierarchy-definition records (tipo `hierarchy1`). Open a record in the *Hierarchies* section and the tool's button appears on it. It opens in **edit** mode, so you can complete the definition fields inline before converging.

## Using it, step by step

1. Open a hierarchy-definition record and launch the tool from its button.
2. Complete the definition fields the tool shows in edit mode: the **TLD** (a short lowercase code that names the hierarchy's ontology, e.g. `mints`), the **name**, the **typology**, the **language**, and the **source real section** (the real section whose records the hierarchy organizes).
3. Read the **status panel**. It lists each condition a usable hierarchy must satisfy — the virtual sections, the active flag, the target sections, the root term — and marks each one as met or failing, so you know exactly what is missing.
4. Press **Activate / repair**. The tool creates only what is missing: it provisions the virtual sections, flags the hierarchy active, and creates the root term (named after the hierarchy) that the tree hangs its children on.
5. The panel repaints from what actually happened, listing what changed. If a definition field is wrong (for example the source section is not a real section), the tool refuses and tells you what to fix first rather than papering over the error.

## Options

| Control | What it does |
| --- | --- |
| **Activate / repair** | Converges the record to a usable state, creating only the missing pieces. Safe to run repeatedly. |
| **Rebuild** (force to create) | Deletes every ontology definition of the hierarchy and recreates it from scratch. Use it only when the ordinary repair cannot fix a structurally broken ontology. Available only for a hierarchy that owns its ontology — otherwise the option is disabled and the tool says why. |

!!! warning "Rebuild removes the ontology, not your terms"
    Rebuild deletes **all** of the hierarchy's ontology definitions — including any own list columns or other custom definitions an older installation carried — and re-creates the standard ones. It happens in one step: if the re-creation fails, nothing is changed. Your **thesaurus terms are not touched** — the records already filed into the tree survive, and the root is re-linked to them afterwards. Still, prefer the plain **Activate / repair** unless a rebuild is genuinely needed.

!!! note "When Rebuild is not available"
    Rebuild is disabled, with the reason next to the checkbox, when the hierarchy does not own its ontology: a core ontology or an installed ontology package (repair those with an ontology update), a hierarchy that points at an existing defined section instead of its own, a TLD that another hierarchy record also declares, or a record that cannot be provisioned (for example a *Real section tipo* that is not a section). A hierarchy that points at a defined section is never given sections of its own by **Activate / repair** either.

## Tips and gotchas

!!! tip "Read the status panel before you press anything"
    The panel is the point of the tool: it tells you whether the hierarchy is already usable, and if not, precisely which condition fails. A locator that is *set* is not the same as its target *existing* — a definition can name a root term that was never created, leaving the tree with nothing to hang children on. The tool detects that and creates the missing root.

!!! warning "General term: root ambiguous"
    When the general term is missing or points at a record that no longer exists, and the hierarchy's section already holds terms, the tool links the one term that has no parent. If several terms have no parent — or none has — it changes nothing and the *General term* line says **root ambiguous**: open the hierarchy record and choose the root yourself in its *General term* field, then press **Activate / repair** again. A general term may hold several roots; the tool keeps every one that exists.

!!! info "This is one of two ways to activate a hierarchy"
    The [Installing new hierarchies](../../administration/install_new_hierarchies.md) panel imports **and** activates the hierarchies you tick. `tool_hierarchy` is how you activate or repair one afterwards, one record at a time. For the model itself, see the [ontology](../../core/ontology/index.md) documentation.

## Related

- **[tool_cataloging](using_cataloging.md)** — the natural follow-up: drag real records into the hierarchy this tool builds.
- **[tool_ontology](using_ontology.md)** — re-syncs edited ontology records into the runtime table (developer tool).
- **[Developer reference](../../development/tools/reference/tool_hierarchy.md)** — the ten checks it converges to, the API actions, and internals.
