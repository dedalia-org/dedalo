---
title: The official servers moved to master7.dedalo.dev; beta7.dedalo.dev is an opt-in beta provider
type: changed
audience: admin
date: 2026-11-06
breaking: true
---
The official Dédalo update servers now live at `https://master7.dedalo.dev` (releases and the shared ontology). The previous address, `v7.master.dedalo.dev`, is retired with no alias. New installations are written with the new address.

**Installations that already have a `.env` (beta testers included) must edit it:** in `../private/.env`, change the URL in `CODE_SERVERS` and `ONTOLOGY_SERVERS` to `https://master7.dedalo.dev/dedalo/core/api/v1/json/` and **restart** the server (the browser's `connect-src` is built at boot). The access code stays the same. An entry still naming the old address is kept, and logs one line at every boot until it is changed.

A second official server, `https://beta7.dedalo.dev`, publishes prereleases and developer builds, and is where ontology changes are tested before they reach `master7`. It is opt-in: the installer never writes it, and it has its own access code. To use it, list it by hand as a provider (`CODE_SERVERS`, and in `ONTOLOGY_SERVERS` with the `tlds` it should supply; every TLD comes from exactly one entry), as in the commented examples in [CODE_SERVERS](./config/config.md#defining-server-code-provider) and [ONTOLOGY_SERVERS](./config/config.md#ontology-servers). Prereleases are then offered only to a code-update panel set to **Prereleases** or **Developer builds**.
