---
title: Style changes reach browsers right after a code update, whatever the web server's cache headers.
type: fixed
audience: admin
date: 2026-11-06
wc: WC-2026-11-06-css-version
---
Before, a web server that sent no `Cache-Control` header for the client files let browsers keep the previous `main.css` and tool stylesheets for days after an update, so the interface looked broken or unchanged until a hard reload. Now the engine tells the page which stylesheet version is current at every start, and the page loads exactly that version before it draws anything. Nothing to configure. `Cache-Control: no-cache` on the client files (see [reverse proxy](./install/reverse_proxy.md)) is still recommended for the scripts.
