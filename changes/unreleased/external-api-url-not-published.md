---
title: An external service's API addresses are no longer sent to the browser, and may not carry a query string
type: security
audience: admin
date: 2026-11-19
wc: WC-2026-11-19-external-api-url-unpublished
---

A section bound to an external record service declares the service's addresses in its `api_config`: `api_url`, `api_url_search` and `ui_base_url`. The first two are called by the Dédalo server, never by the browser, yet both were sent to every browser that opened the section — and an access key written into one of them as `?apikey=…` went with it.

Now only `entity`, `ui_base_url` and `response_map` are sent. `api_url` and `api_url_search` stay on the server, and one that carries a query string or a fragment (`?…`, `#…`) is refused: the section's external binding is refused as misconfigured until the address is corrected, and the server log names the field (never its value). No ontology shipped with Dédalo is affected. If one of your own sections declares such an address, remove the query from it; a service credential belongs in `../private/.env`, never in the ontology. See [External services](./core/system/external_services.md).
