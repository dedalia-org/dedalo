---
title: Portals without a configured page size show their paginator again.
type: fixed
audience: user
date: 2026-10-30
wc: WC-2026-10-30-request-config-default-page-size
---
A portal in an edit form whose ontology declares no page size showed only its first 10 records, with no paginator to reach the rest. It now pages at the installation's default rows per page (`DEDALO_MAX_ROWS_PER_PAGE`, 10 unless changed) and shows the paginator when there are more records.
