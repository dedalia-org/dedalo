---
title: Zotero import works again — CSL JSON exports, PDFs and cover images are imported.
type: fixed
audience: user
date: 2026-11-12
wc: WC-2026-11-12-zotero-csl-json-import
---
Before, the Zotero import refused every file with "Missing Zotero field-map", and it expected
a Zotero RDF export instead of the CSL JSON export the tool is documented for.

Now export your Zotero collection as **CSL JSON**, drop the `.json` file together with its
PDFs, and import. Each reference is matched by its Zotero key: a re-import updates the
records it created. Titles, authors and every other person field, dates, item type, journal
or series (linked to the Series list, created the first time it appears), ISBN/ISSN and DOI
are written; the PDF goes into the record's PDF field and its first page becomes the
identifying image. The **Values** form is applied to every imported record. When the run
ends, the tool lists what it created and updated, every field it refused, and every Zotero
field it did not import. Reverting the import in **Processes** also removes the Series
records it created.

**Action needed:** none for the shipped field map. A date written only as text ("circa 1900")
or an item type the configuration does not list is now refused for that record and listed,
instead of emptying the stored value. A numeric call number is no longer used as the record
number — that rule is under review; each reference that carries one says so in the report.
