---
title: Pages open noticeably faster for returning users on slow connections.
type: changed
audience: user
date: 2026-10-29
---
On HTTPS installations the browser keeps Dédalo's program files in a local cache after login, but three files were still fetched from the server on every page load, one after another, before the page could show anything: the page's entry file and two small helper libraries (tooltips, and a decompressor only used when opening a tag link). Now the entry file comes from the local cache and the two libraries load only when needed. Measured on a simulated slow mobile connection (Slow 4G), a section list appears in 2.8 s instead of 3.9 s and an edit form in 4.5 s instead of 5.7 s; on Fast 4G a list appears in 0.9 s instead of 1.3 s. First visits and installations without HTTPS are unchanged.
