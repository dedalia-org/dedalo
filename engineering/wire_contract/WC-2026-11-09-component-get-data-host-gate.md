# WC-2026-11-09-component-get-data-host-gate — a component's own get_data of one host record is gated as a read of the HOST, not of its target sections

- **Date:** 2026-11-09 (live bug: a user reading + editing a host record and its portal,
  holding no grant on one portal target section, saw the rows in the section read and got
  `perm.denied` on the portal's own refresh; `src/core/security/host_component_read.ts`,
  called from `api/handlers/dd_core_api.ts` `gateReadTargets` at the read and count doors).
- **Decision:** DEC-12. Diverges from PHP (whose Gate B, `class.dd_core_api.php`
  :2131-2153, refused the same request).

## Shape before (PHP, and TS until this entry)

```
{action:'read', source:{type:'component', action:'get_data', model:'component_portal',
  tipo:P, section_tipo:HOST, section_id:1, mode:'edit'},
 sqo:{section_tipo:[TD, TG], limit:10, offset:0,
  filter_by_locators:[{section_tipo:HOST, section_id:1}]}}
```

with the principal at 0 on `TD` → `403 perm.denied` (Gate B: a read grant on every
`sqo.section_tipo`), although the section read of `HOST/1` embeds P's rows (the subdatum
raise of a component caller's children, `section/node_permissions.ts`).

## Shape after (TS)

The same request answers `200` with the slice the section read of `HOST/1` embeds for P —
the same locators and total, the same rows from every column (nested ones included), the
same column levels. It is SERVED from the component's COLUMN NODE in the host section's own
map, in the read's mode: Gate B hands the read a server-derived rqo whose `source.callers` is
the section root `[{tipo: HOST, section_tipo: HOST, mode}]` (verified like any chain,
`relations/caller_chain.ts` — the section map gated STEP 11 as the section read gates it) and
which carries no `show` / `search` / `choose`; the ONE get_data emission
(`section/read_facade.ts` → `read.ts readComponentDataEmission`) then resolves the node the
section read resolved, with the children the section map injects. The client's own `show` and
`callers` are ACCEPTED and IGNORED on this path: a borrowed chain (another readable component
whose config names P and injects deeper columns) and P's bare own config (wider than what its
section injects) both give way to the derived node. SCOPE OF THAT SENTENCE: it holds only on
THIS admitted path (some sqo section ungranted). A get_data whose sqo names only granted
sections (or no sqo) takes the ordinary read, where the client `callers` / `show` still select
the column set (verified against the ontology, not against the record). Owner decision
(2026-11-09): that is NOT a defect — the security boundary is the section grant; which
configured view of target data a column set selects is presentation, not authorization.

Admitted ONLY when every fact holds (each re-derived on the server):

1. `source.type === 'component'` and `source.action === 'get_data'`;
2. `source.section_id` is a real positive record id the principal can access
   (`principalCanAccessRecord` — projects scope); synthetic / temporal (`is_temporal`) /
   external sources never qualify;
3. no source key substitutes what is read: no `source.properties`, `matrix_id`,
   `data_source`, `tm_surface`;
4. the mode is `edit` or `list` (absent = `edit`), the lang non-empty (absent = the request's
   data lang); an EMPTY mode or lang is refused, and the derived rqo carries the normalized
   pair, so admission and read resolve the same node;
5. `source.tipo` is a component of `source.section_tipo` (virtual-aware
   `tipoBelongsToSection`) and a COLUMN of the host section's map in that mode, gated STEP 11
   exactly as the section read gates it (the section-root chain verifies) — a column the
   principal holds 0 on has no node and is refused at both doors (the count door has no
   Gate A);
6. every `sqo.section_tipo` is a dedalo target of that column node — EXACT
   (`dedaloTargetsOf`, shared with the writer-chain scope);
7. the sqo pins EXACTLY the host (`filter_by_locators` = one `{section_tipo, section_id}`
   pin naming the source record) and carries nothing beyond the page vocabulary (`limit`,
   `offset`, `total`, `full_count`, `order`, `view_order`, `filter_by_locators_op: 'OR'`, …):
   no `filter`, no `mode` (never a TM or related read), no `select`.

Anything else is refused exactly as before (`perm.denied`). The count door decides through
the same function, and under rule 7 a count can only ever reach the host locator.

Limit, stated: a NESTED portal's paging (a component inside another component's cell) is
served as the column of ITS OWN record's section map, not as the cell it was rendered in —
only on this path, i.e. only when one of its targets is ungranted (refused before). A
component the host map does not name in that mode (e.g. a list read whose columns came from
a preset) is refused as before.

## Reason

A portal's refresh / page / save echo read is the HOST record's component data; its sqo
sections are only the component's targets, copied by the client from the context. Gating it
on target grants made the same rows readable through one door and refused through the other.
Gating it as the host read, with the data through the same per-ddo policy, gives one answer.

## Gate reconciliation

`test/unit/component_get_data_target_grant_native.test.ts` (built on scratch `zzcgd`): the
answer EQUALS the section read's embedded slice for a plain portal, root, a virtual host, a
section-injected portal (client show + callers, edit and list; and without show — never its
wider own config), a client show differing from the map, and a borrowed chain (no deeper
column); the count door counts 1 like root; 22 tampered shapes refused at both doors. Every
guard was removed one at a time and reds the gate. `test/unit/subdatum_permission_native.test.ts` *(h) DECIDED*: the former pin
"a get_data (not a search) of THES from TERM_REF stays refused, chain or not" now asserts the
host-gated answer. No frozen fixture carries an ungranted-target get_data (the harvest ran as
an admin) — no drift. **Re-harvest: none.**
