# WC-2026-11-25-publication-host-one-machine-install — the panel's draft row carries the one-machine install block; save_draft and pair_package sentences follow the topology and name First use

- **Date:** 2026-11-25, with the publication-host install-ease work
  (`engineering/PUBLICATION_HOST_SPEC.md` §9.14 *One machine first*, *First use*).
- **Decision:** DEC-12 (gated by `test/unit/publication_host_setup_native.test.ts` — the block,
  its quoting, the dependency step only when missing, `--pair-name`, the one-machine default of
  `propose_draft` — `test/unit/publication_host_widget_native.test.ts` and
  `client/dedalo/test/client/js/test_publication_host_setup.js` — the install block and its Copy,
  First use, the select's default). Amends WC-2026-10-09-publication-host-panel-setup.

## Shape before (PHP)

Nothing: the frozen PHP engine had no publication host. Before this entry (TS):

- `get_value` (root only) `drafts[]` rows were `{name, created_at, draft, state, paired_as,
  kit}`; a one-machine draft was installed from the kit or from a source the operator assembled.
- `save_draft` answered one sentence for both topologies (build the kit, install, pair).
- `pair_package`'s success sentence ended at deleting the package.

## Shape after (TS)

- **`get_value` (root only), `drafts[]` row:** NEW key `install: {source: string, draft_file:
  string, agent_deps: boolean, command: string} | null` (`drafts.ts` `oneMachineInstall`).
  Non-null only for an AWAITING draft listening on `unix` when the install source (this engine's
  project root) could be read. `command` is the block to run as root on this server: the draft
  written to `draft_file` (`/root/<instance>.draft.json`, root-only, through a quoted heredoc);
  when `agent_deps` is false, the agent's production dependencies installed in `source` as the
  engine account with the pinned Bun; then `install.sh <instance> --source <source> --draft
  <draft_file>`, plus `-- --pair-name <name>` when the registry name is not the instance. A
  non-root payload still has no `drafts` key at all.
- **`save_draft` RESPONSE `msg`** (`savedDraftSentence`) depends on the draft's listener: `unix`
  → *OK. Draft '<n>' saved. Run the install block shown under it on this server, as root: the
  host pairs itself during the install (no kit, no package).*; `tls` → *OK. Draft '<n>' saved.
  Build its kit, install the publication host from it, then pair the host with the sealed
  package.* `data` unchanged.
- **`pair_package` RESPONSE `msg`** gains the trailing sentence `FIRST_USE_NEXT` (*Next: First
  use under the draft (media rules, API releases, public check).*). `data` unchanged.
- **`propose_draft`:** a missing or unknown `machines` is one machine (unchanged behaviour, now
  gated); the form's question reads *Where the public website runs*, one machine first.
- **First use** is client-only (`render_new_host.js` `run_first_use`): the existing
  `apply_rules {name}`, `push_apis {hosts: [name]}` and `probe_public {name}`, unchanged in
  request and response. No new action, no new error code.
- **UI labels** (not API wire): new `publication_hosts_install_here`, `_install_here_note`,
  `_kit_fold`, `_first_use`, `_push_apis`; re-worded `publication_hosts_draft_machines`,
  `_draft_machines_one`, `_draft_machines_two` (master + 17 catalogs).

## Reason

One machine is the common case for a small institution, and it needs no kit and no package:
init pairs the host itself. Making the operator assemble a source and a root-only draft by hand
was the hardest step of the path; the panel knows every path and can print the exact block.
After pairing, the operator still had to find three actions in the host row in the right order;
First use chains them, as three bounded requests so none outruns the server's idle timeout.

## Gate reconciliation

No parity gate covers the publication-host channel (TS-only); no fixture changes, no re-harvest.
