---
title: "Installing a publication host is easier: the guided install handles IPv4 + IPv6 and redirect virtual hosts, Enter takes ordinary defaults, the panel prints the one-server install, and the public check accepts an http address that moves to https."
type: changed
audience: admin
date: 2026-11-25
wc: WC-2026-11-25-publication-host-public-url-http-upgrade, WC-2026-11-25-publication-host-one-machine-install, WC-2026-11-25-publication-host-ipv6-listener
---
- **Virtual hosts on IPv4 and IPv6.** `provision init` no longer stops when the site's virtual
  host listens on both IPv4 and IPv6, in one block or in one block per address family: it is one
  site, and each block gets the include. A block that only redirects (the `:80` → `https://`
  block certbot writes) is left alone. init still stops when only redirects claim the domain (the
  TLS virtual host is missing) or when two blocks really compete for it. See
  [the site's virtual host](./install/publication_host.md#the-sites-virtual-host).
- **Fewer things to type.** Enter now takes the shown default of an ordinary decision. A decision
  with a single option is taken for you (`auto: the only option`). What init cannot do is no
  longer asked: it is listed under **needs your action**, with the commands and the command to
  run init again; a blocking one stops init before anything changes. Decisions that change your
  files or the whole host (the vhost, an SELinux boolean, replacing a pairing, removing the
  pairing package) must still be typed. Without a terminal nothing changes: `--yes` answers no
  decision. See [the report and its lists](./install/publication_host.md#the-three-lists).
- **One server, one block.** In **Maintenance → Publication hosts → New publication host**,
  *On this server* is the default. A saved one-server draft shows an **Install on this server**
  block to copy and run as root: it writes the draft, installs the agent's dependencies if the
  release lacks them, and runs the guided install, which pairs the host itself. A paired draft
  offers **First use**: media rules, API releases and the public check, in order. See
  [New publication host](./install/publication_host.md#new-publication-host).
- **The public check and http.** The public URL may be `http://` (the panel proposes `https://`,
  and shows a notice when you save an http one). When the http address redirects to the https
  address of the same file, the check follows that one redirect and suggests switching the URL
  to https; any other redirect is reported with the address it pointed to. See
  [Checking the gate from the public side](./install/publication_host.md#checking-the-gate-from-the-public-side).
- **IPv6 between two machines.** The agent of a publication host on another server may listen on
  a unique local IPv6 address (`fc00::/7`; in practice one starting with `fd`), written in its short form; link-local addresses are
  refused.
- **A tightened site home on a re-run.** When the site's home is already `root:root` but other
  accounts cannot enter it (for example `0700`), init now makes it `0755` again instead of
  calling it right and then refusing to apply because the agent cannot reach its own files.

**Action needed:** none.
