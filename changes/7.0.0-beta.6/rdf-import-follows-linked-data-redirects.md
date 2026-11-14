---
title: RDF import now works with linked-data servers that redirect, and respects their robots.txt.
type: fixed
audience: user
date: 2026-10-01
breaking: false
wc: WC-2026-10-01-rdf-harvest-door
---
Linked-data servers usually answer an IRI by redirecting to the document that describes it (or from `http` to `https`). The RDF import refused every redirect, so on those servers each import failed. It now asks the IRI itself for RDF/XML and follows the redirects, checking every step. Servers that only answer at the IRI with `.rdf` appended still work: the tool tries that form when the first answer is not RDF/XML. The tool now also reads each site's `robots.txt` and spaces its requests to the same site a few seconds apart. A site that does not allow automated access gets a per-IRI message saying so, and nothing is fetched from it. The tool's IRI list was empty, so nothing could be imported at all; it now lists the record's IRIs again. The tool now always shows why an IRI could not be imported; before, a failed IRI only showed *Empty results*. When a remote server does not answer within 15 seconds (or drops the connection, or reports an error of its own), the result says that server is out of service and to contact its maintainer, instead of waiting until the request times out. One run fetches at most three IRIs. See [RDF import](./using/tools/using_import_rdf.md).
