---
title: "Publication API v2: range filters compare numbers as numbers, so BC dates work."
type: fixed
audience: developer
date: 2026-11-24
---
`gt`, `gte`, `lt` and `lte` bound every value as text. Publication columns often store numbers as text (a type's `date_in` is `-150`), and compared as text `filter[date_in][gte]=-150&filter[date_in][lte]=-100` matched nothing. A plain number is now compared as a number; any other value (an ISO date, a code) still compares as text (see [Querying](./diffusion/publication_api/v2/querying.md)).
