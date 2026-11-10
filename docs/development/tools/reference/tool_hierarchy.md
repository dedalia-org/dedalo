# tool_hierarchy

Makes a hierarchy **usable**: it inspects a hierarchy-definition record against the ten conditions a browseable hierarchy must satisfy, shows you which ones fail, and converges the record to all of them — provisioning the virtual sections, flagging the hierarchy active, and rooting its thesaurus tree.

## What it does / why & when to use it

Given a **hierarchy-definition record** (a row of the *Hierarchies* section, tipo `hierarchy1`) that names a TLD, a typology and a source real section, `tool_hierarchy` materializes the **virtual sections** on top of that real one — the runtime ontology nodes (`<tld>0`, `<tld>1`, `<tld>2`) and their node records — flags the hierarchy active, and creates the **general term** roots the thesaurus tree hangs its children on.

Concrete heritage scenario: a numismatics team keeps a flat *Coin types* list (a real section) but wants to organize those types **within the mints that struck them** — a "Mints → types" tree cataloguers can browse and file records into. A curator creates a definition record (name "Mints", a TLD, source real section = *Coin types*, typology), opens `tool_hierarchy` on it, and presses **Activate / repair**. The tool builds the virtual sections, roots the tree at a term named "Mints", and the hierarchy appears as a thesaurus the team can populate. ([tool_cataloging](tool_cataloging.md) is then used to drag real records into the tree.)

Use it when you are standing on a hierarchy-definition record and want that hierarchy to work — whether it has never been generated, or it is **half-built** and you want to know why. It is not for everyday record editing.

!!! tip "It is a repair tool, not just a generator"
    Pressing **Activate / repair** on a healthy hierarchy is safe and does nothing (it reports *"Already consistent — nothing to do"*). It only creates what is missing. That is what makes the status panel worth reading before you press anything.

## The invariant it converges to

The server owns one answer to *"is this hierarchy usable?"* — `inspectHierarchy` in `src/core/ontology/hierarchy_state.ts` — and the tool renders it as a checklist:

| Check | What must be true |
| --- | --- |
| Hierarchy record | the `hierarchy1` record exists |
| TLD | `hierarchy6` is a safe TLD (`[a-z]{2,}`) |
| Typology | `hierarchy9` names a typology — provisioning refuses without one |
| Source section | `hierarchy109` names a **real section**. Defaulted to `hierarchy20` (the thesaurus template) when unset, and **never overwritten**: it is your "Real section tipo", and a hierarchy built on another section is legitimate |
| Active | `hierarchy4` → *Yes*, as a **full locator**. A bare one (no `from_component_tipo`) is invisible to the containment query behind every portal's `target_sections` — the hierarchy exists, but no portal can see it |
| Active in thesaurus | `hierarchy125` is set |
| Ontology | `dd_ontology` holds `<tld>0`, `<tld>1`, `<tld>2`, and `matrix_ontology` holds the two `<tld>0` node records |
| Target sections | `hierarchy53` = `<tld>1`, `hierarchy58` = `<tld>2` |
| General term | `hierarchy45` points at a record that **exists** in `<tld>1` |
| General term model | `hierarchy59` points at a record that **exists** in `<tld>2` |

The last two are the ones that used to break silently. **A locator being *set* is not the same as its target *existing*.** A definition record can carry a general-term locator pointing at `<tld>1`/1 while that record has never been created — the tree then has no root to hang children on, and the hierarchy cannot be used at all. `inspectHierarchy` reports such a locator as `DANGLING → al1/1 does not exist`, and `ensureHierarchy` treats it as absent and creates the root.

Root terms are **resolved or created, never assumed at a fixed id**: if the locator's target exists it is kept; else if the section already holds terms (an imported thesaurus) its root is linked; else a root is created. A created root is **named after the hierarchy** (`hierarchy5`, every language it holds), and the term component is read from the target section's `section_map` (`hierarchy52` → `{thesaurus: {term: 'hierarchy25', …}}`), never hard-coded — a hierarchy on a non-`hierarchy20` section names a different component. An existing name is never overwritten.

## How it works (server + client)

**Server** (`tools/tool_hierarchy/server/{index,tool_hierarchy}.ts`). Two API actions:

- `inspect_hierarchy` — **read**, `permission: 'targets', minLevel: 1` over `hierarchy1/<section_id>`. Returns the checklist (`state`) and `rebuild: {allowed, reason}` — whether *Force to create* may run here. The client calls it when the tool opens and disables the checkbox, with the `rebuild_refused_<reason>` label, when it may not.
- `generate_virtual_section` — **write**, `permission: 'targets', minLevel: 2` over `hierarchy1/<section_id>` — the record the core writer is pinned to, never the `section_tipo` the client sends (which the writer ignores). Converges the record (`ensureHierarchy`); with `force_to_create`, deletes the TLD's ontology from scratch and re-provisions it (`rebuildHierarchy`) — only for a hierarchy that OWNS its provisioned ontology (`classifyHierarchyRebuild`); any other is refused `ontology.teardown_refused` with a `reason` before anything is written. The action name is kept because it is wire contract; the semantics are "make this hierarchy consistent", which is what pressing the button always meant.

The handler sequences nothing itself. The invariant, and every write that establishes it, lives in `src/core/ontology/hierarchy_state.ts` — one writer, guarded by `test/unit/hierarchy_single_writer_tripwire.test.ts`. Afterwards the ontology-derived caches are invalidated (`clearOntologyDerivedCaches`) so the menu and the tree pick the hierarchy up.

**Client** (`tools/tool_hierarchy/js/`). `render_tool_hierarchy.js` renders the definition components of the caller record in `edit` mode — TLD (`hierarchy6`), name (`hierarchy5`), active (`hierarchy4`), typology (`hierarchy9`), language (`hierarchy8`), source real section (`hierarchy109`) — plus the **status panel** (`paint_status`, fed by `inspect_hierarchy`) and the buttons. Only the fields the server cannot derive are validated before submitting: TLD, name, typology and language. *Active* is **not** a precondition — activating the hierarchy is the job, so refusing to start because it is not yet active was circular.

The write response carries the fresh `state`, so the panel repaints from what actually happened rather than a second round-trip, and `applied` — the list of what changed (empty on a healthy record).

## Actions & options

| Action | Permission gate | Background | Reads from `options` |
| --- | --- | --- | --- |
| `inspect_hierarchy` | declarative: `permission: 'targets', minLevel: 1` on `hierarchy1/<section_id>` | no | `section_id`, `section_tipo` |
| `generate_virtual_section` | declarative: `permission: 'targets', minLevel: 2` on `hierarchy1/<section_id>` | no | `section_id`, `section_tipo`, `force_to_create` |

| Option | Type | Required | Meaning |
| --- | --- | --- | --- |
| `section_id` | int | yes | the hierarchy-definition record (the caller record) |
| `section_tipo` | string | yes | that record's section — must be `hierarchy1`; any other value is refused as an unusable target. The gate is asserted on `hierarchy1` itself, not on this value |
| `force_to_create` | bool | no (default `false`) | **Rebuild from scratch**: delete every `dd_ontology` node of the TLD, its ontology-main row and every `<tld>0` node record (extras included), then re-provision `<tld>0/1/2` — in one transaction, after the ownership check. The `<tld>1` **terms are not touched** |

Response: `{ result, msg, errors[], state, applied[] }`, where `state` is `{section_id, tld, typology, usable, checks: [{id, label, ok, detail}]}`.

!!! warning "Rebuild deletes the ontology, not the terms"
    The old label ("existing thesaurus data may be lost") was wrong, and being wrong in the scary direction meant nobody used the one control that fixes a broken ontology. A rebuild removes the TLD's ontology nodes and node records and re-creates them; the thesaurus records in `<tld>1` survive, and the root is re-linked to them afterwards.

!!! danger "Rebuild only for an owned hierarchy"
    The TLD comes from the record's editable `hierarchy6`, so the rebuild never trusts it alone. It runs only when the TLD is not core (nor the suite's `test`), this record is the only `hierarchy1` record declaring it, `hierarchy53` is unset or the record's own `<tld>1`/`<tld>2`, the stored `<tld>1`/`<tld>2` are absent or virtual sections of one real section outside the TLD, every other node of the TLD hangs under `<tld>1`/`<tld>2`, each `<tld>0` record has its node and each node its record, an absent shape holds no `<tld>0` record and no ontology-main row, and provisioning can succeed. Otherwise the answer is `ontology.teardown_refused` (409) with `reason` = `core`, `not_sole_declarer`, `root_only`, `ontology_package` or `invalid_source`, and nothing is written. Any failure after that check — a re-provisioning that does not end usable, or a database error in the teardown or the provisioning — rolls everything back and answers `ok:false` with the state as it stands after the rollback.

## How it is registered & surfaced

`tools/tool_hierarchy/register.json` is a column-keyed dump (a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials:

- `dd1326` name = `tool_hierarchy`; `dd799` label ("Hierarchy tool").
- `dd1350` affected_tipos = `["hierarchy1"]` → the tool attaches **only** to hierarchy-definition records.
- `dd1335` properties = `{ "mode": "edit" }` → it opens in edit mode, so the definition can be completed inline before converging.
- `dd1372` labels supply the localized strings. The panel and the confirmations fall back to English when a label is absent, so the tool works before the labels are translated: `status_ready`, `status_incomplete`, `status_unavailable`, `confirm_activate`, `confirm_rebuild`, `generate`, `force_to_create`, and one `rebuild_refused_<reason>` per refusal reason.

Surfacing (`getElementTools`, `src/core/tools/registry.ts`): restricted by `affected_tipos` to `hierarchy1`, the tool appears only on hierarchy-definition records.

## Examples

The write call (built by `tool_hierarchy.js::generate_virtual_section`):

```js
const rqo = {
    dd_api : 'dd_tools_api',
    action : 'tool_request',
    source : create_source(self, 'generate_virtual_section'),
    options : {
        section_id      : self.caller.section_id,   // the hierarchy-definition record
        section_tipo    : self.caller.section_tipo, // 'hierarchy1'
        force_to_create : false                     // true → rebuild the ontology
    }
}
```

A response on a record that needed repairing:

```json
{
    "result": true,
    "msg": "Hierarchy 'al' is ready",
    "errors": [],
    "applied": [
        "flagged active",
        "provisioned the ontology (al0, al1, al2)",
        "hierarchy45: created the root al1/1",
        "hierarchy45: named the root al1/1 after the hierarchy"
    ],
    "state": { "tld": "al", "usable": true, "checks": [] }
}
```

A refusal — the tool does **not** paper over an operator error:

```json
{
    "result": false,
    "msg": "the source section 'actv1' (hierarchy109) is not a section — fix \"Real section tipo\" first",
    "applied": [],
    "state": { "usable": false, "checks": [] }
}
```

## Related

- [Hierarchies](../../../core/ontology/hierarchy.md) — the model this tool operates on, and the same invariant from the ontology side.
- [Installing new hierarchies](../../../management/install_new_hierarchies.md) — the panel imports **and activates** the hierarchies you tick; this tool is how you activate one afterwards.
- [tool_cataloging](tool_cataloging.md) — the natural follow-up: drag real records into the hierarchy this tool builds.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md).
- Source: `tools/tool_hierarchy/server/{index,tool_hierarchy}.ts`, `tools/tool_hierarchy/js/{tool_hierarchy,render_tool_hierarchy}.js`; core: `src/core/ontology/hierarchy_state.ts` (`inspectHierarchy`, `ensureHierarchy`, `rebuildHierarchy`), `src/core/ontology/hierarchy_provision.ts` (`generateVirtualSection`), `src/core/ontology/ontology_delete.ts` (`deleteOwnedHierarchyOntology`), `src/core/ontology/teardown_scope.ts` (the refusal and the sole-declarer scan).
