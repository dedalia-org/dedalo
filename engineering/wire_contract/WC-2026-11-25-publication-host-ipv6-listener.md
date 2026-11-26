# WC-2026-11-25-publication-host-ipv6-listener — a two-machine agent may listen on a private IPv6 (ULA or ::1), canonicalized end to end

- **Date:** 2026-11-25, with the publication-host install-ease work
  (`engineering/PUBLICATION_HOST_SPEC.md` §2 *the listen-host grammar*, §2.1, §9.14;
  `engineering/OUTBOUND_SPEC.md` §2.1).
- **Decision:** DEC-12 (gated by `publication/host_agent/tests/provision_listen_ipv6.test.ts` —
  the grammar, the refusal order, the IP SAN, a real mTLS handshake on `[::1]` — and
  `test/unit/publication_host_ipv6_native.test.ts` — the draft, the pairing refusals, the
  registry, a real `pairWith` → registry → `dialAgent` run on `[::1]`; the operator page's IPv6
  example by `test/unit/publication_host_operator_doc.test.ts`). The link-local refusal is a
  DECISION of this entry (below).

## Shape before (PHP)

Nothing: the frozen PHP engine had no publication host. Before this entry (TS): `listen.host` was
a canonical non-zero IPv4 literal only (`LISTEN_HOST_PATTERN`); every other value was refused
with *must be a canonical non-zero IPv4 address (…)* (zod) or the regex in `derive()`'s
`LayoutError`, and the panel's `draft_invalid` said *must be the private IPv4 address the agent
binds (e.g. 10.20.0.2)*. Hosts were compared as text.

## Shape after (TS)

- **`save_draft` / `propose_draft`:** `draft.listen.host` may be a private IPv6 (`fc00::/7` or
  `::1`). Input is canonicalized to RFC 5952 (trimmed, brackets stripped, lower case,
  compressed) before it is judged and stored, so the stored draft and `draft.json` carry the
  canonical form. The `draft_invalid` message for `listen.host` reads *must be the private
  address the agent binds — an IPv4 (e.g. 10.20.0.2) or a unique local IPv6 (e.g. fd00:20::2):
  <reason>*.
- **Agent draft and declaration files** (`provision init --draft`,
  `/etc/dedalo_publication_host/<instance>.json`): `listen.host` accepts a canonical private
  IPv6. The zod issue is `listenHostProblem`'s reason plus the spec §2 suffix; `derive()`'s
  `LayoutError` names the rule instead of printing the regex. Refused by name: link-local,
  brackets or a zone id, `::`, multicast, IPv4-mapped/compatible ("write the IPv4 itself"),
  global/documentation/site-local ("not a private IPv6"), and a non-canonical spelling (with its
  canonical form). A refused family is named before any spelling refusal.
- **Pairing** (CLI and `pair_package`): a fragment URL whose IPv6 host the agent grammar refuses
  is `PairRefusal` `address_invalid`, *DEDALO_PUBLICATION_HOST_URL: the IPv6 host '<h>'
  <reason>.*, before any dial. A ULA or `::1` host is registered in RFC 5952 form.
  `address_mismatch`, `draft_paired` and the name/agent slot checks compare hosts canonically.
- **Registry file** `publication_hosts.json`: a TLS host with a zone id (`%`) is a shape error
  (*must not carry an IPv6 zone id …*); an IPv6 host is normalized to RFC 5952 on load and
  save. No writer ever produced either form.
- **`get_value` host rows and `host_status` `address_label`:** an IPv6 TLS address is shown
  bracketed, `[fd00::1]:8471`; IPv4 unchanged. The draft card does the same.
- **UI label** `publication_hosts_draft_listen_host`: *Private IPv4/IPv6 address of the
  publication host* (master and the 17 catalogs that carry it); the client fallback matches.

**Decision — link-local is refused.** `fe80::/10` is bindable only with a zone id, and the
certificate's IP SAN, an https URL (WHATWG refuses `%`) and the registry cannot carry one; the
message points to a ULA.

## Reason

A private network between the work host and the publication host may be IPv6-only (a ULA
WireGuard tunnel, a provider's private VLAN). The mTLS channel already worked over IPv6 at the
transport (Bun checks the IP SAN; the door brackets the host); the grammar was the only block.
Canonical text everywhere is what lets the same address typed two ways be one machine.

## Gate reconciliation

No parity gate covers the publication-host channel (TS-only); no fixture changes, no re-harvest.
