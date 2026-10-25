---
title: The publication host's `install.sh` no longer hangs on a stalled Bun download.
type: fixed
audience: admin
date: 2026-10-23
---
Before, `install.sh` downloaded Bun with a size limit only: a mirror (or GitHub) that accepted the
connection and then stopped answering — during the TLS handshake or mid-download — left the
install waiting forever, holding its lock. Now every download has a connect deadline and a total
deadline; when one passes, `install.sh` stops with a line saying so and naming the ways on
(retry, `--mirror <https base url>`, or `--offline <bun zip>`). See the
[publication host guide](./install/publication_host.md).
