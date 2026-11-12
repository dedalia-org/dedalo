# Journal article import (`tool_bibliography_acquisition`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_bibliography_acquisition.md)

Paste a journal's OAI-PMH URL (or a normal OJS article/journal URL), review every article the tool
found, then import the kept ones into the Publications section as new records, each linked to its
Series and Authors, with the article's PDF attached when one can be found.

## What it's for

Building a bibliography of a journal's output by hand — title, authors, abstract, pages, the
journal/series it belongs to — is slow and repetitive. This tool speaks OAI-PMH, the metadata-
harvesting protocol almost every OJS (Open Journal Systems) journal and many institutional
repositories expose, so it can pull structured article metadata straight from the source instead of
scraping free text.

Concrete scenario: a librarian wants a Spanish academic journal's current issue in the
Publications section. They paste the issue's normal landing-page URL (not the raw OAI endpoint —
the tool derives that itself from OJS's own URL convention); the tool resolves every article linked
from that page, fetches each one's OAI-PMH record, and the review screen shows a checklist with
each article's title, authors, date and page range. The librarian keeps the relevant ones and clicks
**Confirm import**. The tool creates one Publication record per kept article, resolves (or creates)
the journal's Series record and each author's Person record and links them, writes the abstract in
every language the source carries that your installation uses, and — when a downloadable copy can be found — imports
the PDF directly onto the record.

## When to use it

- You have a journal's URL (an OAI-PMH endpoint, or a normal OJS homepage/issue/article URL) and
  want its articles as Publication records.
- You want the Series and Authors linked automatically, and the PDF attached when one is
  available, without re-typing bibliographic metadata by hand.

When NOT to use it:

- To import a Zotero-exported bibliography you already curated outside Dédalo, use
  [Zotero import](using_import_zotero.md).
- For a library's MARC21 catalogue export, use [MARC21 import](using_import_marc21.md).
- To harvest an entire journal's back catalogue in one go: this tool deliberately resolves one
  bounded set of articles per run (a single article, or every article linked from one listing page
  such as a current-issue page) — run it again per issue for the rest.

## Where to find it

The tool is scoped to **Publication** sections — it does not appear on an arbitrary section even
though its registration names the generic `section` model. Where your profile is authorized for it,
its button opens in a **modal** (not a separate window).

## Using it, step by step

1. **Open the tool** on the Publications section.
2. **Paste the journal's URL** — either its real OAI-PMH base URL (ending `/oai`), or a normal OJS
   URL (a journal homepage, a current-issue page, an individual article's `.../article/view/<id>`
   page): the tool derives the OAI endpoint from OJS's own journal-routing URL convention
   automatically. A listing page (not a single article) is scanned for every real article link it
   carries.
3. **If the source blocks automated fetching** (confirmed for some OJS journal landing pages sitting
   behind a Cloudflare challenge), Preview refuses and tells you so. Save the page yourself in your
   own browser, then pick the saved OAI-PMH response (or HTML) file in the upload field below the
   URL field — the URL is still required, since it picks the right parser and is part of the
   Series dedup key.
4. **Click Preview.** A pasted URL runs as a background job — one OAI-PMH fetch per article found,
   so a full issue can take a little while; an uploaded file is parsed instantly. Either way you get:
   - the detected **Series** (the journal's own name), and whether it will **link** to an existing
     record or a **new** one will be created;
   - a checklist of every article found, checked by default, each with its title, authors,
     publication date and page range.
   - if some articles could not be fetched, a notice listing each one and why, above the
     articles that were.
5. **Curate the list.** Use *Select all* / *Deselect all*, an include/exclude keyword filter against
   the title and authors, or an include/exclude **year range** (parsed from each article's
   publication date).
6. **Click Confirm import.** The tool creates one record per kept article in the background, with
   live progress, and reports one result line per article: the fields written, whether the Series
   was linked (created or reused, or why it could not be), whether the authors were linked, and
   whether a PDF was imported.

## Tips and gotchas

!!! note "Re-importing the same batch does not duplicate it"
    Each article is matched by its own stable identifier before anything is created; an article
    already imported is reported as skipped, not duplicated. Re-running Confirm import — including
    after stopping a batch partway — picks up only what is left.

!!! note "The abstract is written once per language the source carries and your installation uses"
    When a source provides the abstract in more than one language, each variant is written into its
    own language slot on the record rather than merged into a single one — open the record's
    language switcher to see all of them. A variant in a language your installation does not use,
    or a second variant for a language already written, is left out, and the result line names it;
    the publication itself is still imported.

!!! note "A PDF is imported best-effort, separately from the record itself"
    OAI-PMH metadata never carries a direct PDF link, so the tool follows the article's landing page
    to find one. That step — and the PDF download itself — can fail independently of everything
    else (a blocked landing page, no PDF on it, a host this tool doesn't recognise); the record is
    still created with all its other fields, and the result line says specifically why the PDF did
    not come along.

!!! warning "This is one bounded set per run, not a whole-journal harvest"
    Pasting a journal's homepage or an issue page resolves the articles linked from *that page* —
    typically one issue's worth — capped at 200 articles found and 200 kept per batch, not the
    journal's entire publication history. Run it again for another issue.

!!! note "If the panel loses a job's progress"
    When the connection that reports a preview's or an import's progress drops before the job
    ends, the panel says it lost the job's status and that the job may still be running (with its
    process number), and keeps its button disabled — a second click could start a second import
    beside the first. Click **Check again** to reconnect to the same job and see how it ended.
    A progress report that falls silent for 15 seconds is treated the same way.

    When the server does not confirm whether a job started at all (the request timed out or the
    connection dropped), the panel says the job may be running and keeps its button disabled.
    Click **Check my jobs** to list your jobs of this kind: **Show this job** follows the one that
    started, and a new attempt is offered only when none of them is running or queued.

!!! tip "Stopping a long import is safe"
    Cancelling a running Confirm import stops it before starting the next article — it never leaves
    a half-written record behind. The summary reports how many of the total were actually
    committed, and re-running the same batch afterwards only imports what is left (see the dedup
    note above).

## Related

- **[Zotero import](using_import_zotero.md)** — the other Publications-section importer, for a
  bibliography already curated and exported from Zotero rather than harvested live from a journal.
- **[MARC21 import](using_import_marc21.md)** — a library MARC21 catalogue import into the same
  section.
- **[Auction import](using_numisdata_acquisition.md)** — built the same way (paste a public URL,
  review a checklist, commit in the background) for a different domain: auction lots into
  Numismatic Objects, rather than journal articles into Publications.
- **[Developer reference](../../development/tools/reference/tool_bibliography_acquisition.md)** —
  the `preview_url`/`preview_html`/`commit_publications` actions, the OAI-PMH adapter, and the
  dedup/lock rules.
