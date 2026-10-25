---
title: The address bar now names the open record, so an edit page can be copied and reopened
type: added
audience: user
date: 2026-10-23
---
While editing a record, the address bar now carries its id (`?tipo=…&mode=edit&id=…`),
so copying the URL and opening it later — or in another tab — lands on **that** record.
Before, the URL only named the section, and reopening it showed whatever record the
browser's stored edit position happened to point at.

The same URL is also the reliable form for a bug report or an assistant prompt: it
identifies the section and the record without the search that produced them.

Alongside it, two long-standing traps around pasted record links are gone: a link that
named a record could come up with an empty form ("no records found") when the browser
had a stored edit position, and leaving such a page for the list could show a list of
one. The list itself is unchanged, and paginating inside an edit page still works; a
reloaded or shared record link simply shows that record, one at a time.
