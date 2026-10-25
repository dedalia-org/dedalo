---
title: A developer install now writes a development listener, so `bun run dev` serves the browser on port 3500.
type: fixed
audience: developer
date: 2026-10-16
---
**The listener is written.** A developer install used to write no `SERVER_TCP_PORT`,
so `bun run dev` served only its unix socket and the browser reached nothing until
the `.env` was edited by hand. The developer route now writes a *Development only*
section: `SERVER_TCP_PORT` (default `3500`, `--dev-port`), `SERVER_TCP_HOST`
(default `127.0.0.1`, this machine only; `--dev-host 0.0.0.0` opens it to the
local network, and the Review and a headless run's summary warn), `DEDALO_DEV_MODE=true`,
`DEDALO_DEBUG_API_ERRORS=true`, and the listener's certificate. The interactive
installer asks these on a new **Development server** step.

**The certificate.** `--tls` on the developer route is `local_ca` by default (a
local certificate authority kept in `<private>/tls`), `none` (plain HTTP) or `files`
(your own pair, with `--tls-cert` and `--tls-key`). `SESSION_COOKIE_SECURE` is
written to match: `true` over HTTPS, `false` over plain HTTP, where a browser on
another machine would otherwise drop the login cookie.

**A port in use is refused.** When another program already listens on the port,
the Review does not offer `install`, and a headless run stops before writing
anything; the refusal names the next free port. The installer never picks another
port for you.

**A re-run keeps your values.** The port, the address, a certificate pair and the
two modes your `.env` already has are kept unless you answer them again, and the
Review lists them as kept. A kept port or address that is not valid is refused
like an answer, so you replace it with `--dev-port` or `--dev-host`. `--tls none` over a kept pair clears it. No other route
writes any of these keys.
