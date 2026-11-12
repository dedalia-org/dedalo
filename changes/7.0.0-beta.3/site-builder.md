---
title: Agent-built public websites
type: added
audience: admin
date: 2026-07-23
wc: WC-035
---
A wholly TS-native subsystem lets
users build public sites over the published data by talking to a coding
agent: a standalone daemon (`publication/site_builder/`, isolated like the
publication API), the proxy tool `tool_sitebuilder` (a three-pane workspace),
and a `site_builder_status` maintenance widget that probes the daemon and
hosts the launcher. No counterpart existed in the previous engine. Docs:
[Site builder](./administration/site_builder.md) ·
[internals](./development/site_builder_internals.md).
