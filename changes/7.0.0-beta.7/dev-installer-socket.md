---
title: A developer install gets its own unix socket, named after its entity, and is refused while another server holds it.
type: changed
audience: developer
date: 2026-10-20
---
**One socket per checkout.** The developer route used to write no `SERVER_UNIX_SOCKET`,
so every checkout on a machine listened on `/tmp/dedalo_ts.sock`, and a second one could
not start. The Development server screen now asks for the socket and always writes it.
The default carries the entity: entity `test` gets `/tmp/dedalo_ts_test.sock`. Change it
there or with `--socket`. On a re-run, the socket your `.env` already names is kept.

**Refused before anything is written.** When a running server already answers on the
chosen socket (another checkout's `bun run dev`), the Review refuses to install, and so
does a headless run, before it writes anything. Before, that only failed at the
installer's last step, after the install was sealed. A leftover socket file that nothing
answers on is not refused; the server removes it when it starts. A socket path longer
than 103 bytes (the operating system's limit) is refused on any route. See the
[developer quickstart](./install/dev_quickstart.md#7-run-it).
