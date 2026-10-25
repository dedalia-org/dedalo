---
title: A lookup in an external catalogue now always ends within its timeout, even when the name server or the answer stalls.
type: fixed
audience: admin
date: 2026-10-21
---
The timeout of an external record service (for example Zenon) started only when the
connection was opened. Resolving the service's name, and reading an answer that stopped
arriving, were not covered, so a stalled name server or a stalled answer could keep the
lookup — and one of the service's few parallel request slots — waiting indefinitely. The
whole request, from the name lookup to the last byte of the answer, is now covered by the
service's configured timeout, and such a request is reported as timed out.
