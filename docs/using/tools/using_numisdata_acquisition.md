# Auction import (`tool_numisdata_acquisition`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_numisdata_acquisition.md)

Paste a public coin-auction URL, review every lot the tool found, then import the kept lots into
the Numismatic Object section as new records, each linked to its Auction and (when a catalog
citation matches) its Type, with the lot's image split into obverse/reverse halves.

## What it's for

Cataloguing numismatic collections from live and past auctions means re-keying the same
information — weight, diameter, inscriptions, the auction house, the catalog reference — by hand
for every lot. This tool fetches a public auction page from one of five supported houses, parses
every lot it lists, and lets the operator curate the batch before anything is written: deselect the
lots that are not relevant, then commit the rest in one background job.

Concrete scenario: a numismatics curator is tracking an upcoming Aureo & Calicó sale. They paste the
auction's listing URL, the tool fetches and parses every lot on every page of the sale, and the
review screen shows a checkbox list with each lot's number, weight, diameter and a description
snippet. The curator deselects the lots outside their collecting interest, confirms a Company match
for the auction house, and clicks **Confirm import**. The tool then creates one record per kept lot,
resolves (or creates) the Auction record and links it, matches the lot's catalog citation (e.g.
"ACIP-1759") against the Types this instance already curates, and downloads the lot's photo,
splitting it into obverse and reverse images attached to the new record.

## When to use it

- You have a public auction URL from jesusvico.com, biddr.com, aureo.com, numisbids.com, or
  sixbid.com and want its lots as Numismatic Object records.
- You want the Auction and (when it matches something already catalogued) the Type linked
  automatically, and the lot's photo split and attached, without any manual data entry.

When NOT to use it:

- To load Dédalo's own `dedalo_raw` exports or a general spreadsheet, use
  [CSV import](using_import_dedalo_csv.md).
- To bulk-ingest media files you already have locally (not from a public auction page), use
  [Media file import](using_import_files.md).

## Where to find it

The tool is scoped to **Numismatic Object** sections — it does not appear on an arbitrary section
even though its registration names the generic `section` model. Where your profile is authorized for
it, its button opens in a **modal** (not a separate window).

## Using it, step by step

1. **Open the tool** on a Numismatic Object section.
2. **Paste the auction URL.** Supported shapes vary by source:
   - **jesusvico.com** — a full auction listing, or a single lot page (`/lot/` or the Spanish
     `/lote/`).
   - **biddr.com** — a full auction catalogue, a single-lot page, or a `biddr.com/search?...`
     results page spanning several auctions at once.
   - **aureo.com** — a full auction listing only.
   - **numisbids.com** — a full sale page, or a single lot page.
   - **sixbid.com** — a full auction, a single lot, or a site-wide search results page spanning
     several auctions at once.
3. **If the source blocks automated fetching**, Preview refuses and tells you so. numisbids.com and
   sixbid.com always refuse (their own robots.txt blocks every automated agent); any source can also
   show a CAPTCHA/"checking your browser" page instead of the real content. Either way: save the
   page yourself in your own browser (a human visiting a page is not automated retrieval, so there is
   nothing to detect or bypass), then pick the saved `.html` file in the upload field below the URL
   field — the URL field is still required, since it tells the tool which parser to use and is part
   of the Auction's dedup key. The tool tries to read the page's own URL out of the saved file
   (`<link rel="canonical">`, `og:url`, or `<base href>`) and fills the field for you when it finds
   one.
4. **Click Preview.** A pasted URL runs as a background job (live fetch, possibly several pages); an
   uploaded HTML file is parsed instantly, nothing fetched. Either way you get:
   - the detected **Auction** (house and number), and whether it will **link** to an existing
     record or a **new** one will be created;
   - when there is an auction house name, a **Company** picker — search for the real Entity record
     it should link to, or create a new one. It runs an automatic search as soon as the list
     appears, and preselects an exact name match when it finds one. Only your latest search
     counts: an older one that answers late never replaces your choice. A search that fails is
     shown as an error, not as "no candidates".
   - a checklist of every lot found, checked by default, each with its number, weight, diameter and
     a description snippet.
5. **Curate the list.** Use *Select all* / *Deselect all*, an include/exclude keyword filter against
   the lot's description and title, or an include/exclude **lot-number range** (the lot's own
   catalog number, not its position in the list).
6. **Click Confirm import.** When the auction names a house, Confirm waits until its Entity is
   chosen (a match, or *Create new Entity*): it refuses rather than import the lots without the
   auction's company link. The tool creates one record per kept lot in the background, with live
   progress, and reports one result line per lot: the fields written, whether the Auction was linked
   (created or reused, or why it could not be), whether a Type was matched (and if a citation was
   found but nothing in the catalog matched it), and whether the image import succeeded.

## Tips and gotchas

!!! note "Re-importing the same batch does not duplicate it"
    Each lot is matched by its Auction plus its own lot/inventory number, and — for every source
    except aureo.com, whose lots have no page of their own — by a canonical address the tool builds
    from the lot's own identifier on the auction site (the same address however the lot was
    reached: a pasted link, the listing, with or without `www.` or tracking parameters), which it
    stores in the record's URI field. A lot already imported is reported as skipped, not duplicated,
    even from a search-results page or when its auction could not be identified. When the tool
    cannot tell which lot a link names (for example a listing card whose link is broken), that lot
    is matched by Auction and number only — it is never treated as a copy of another lot.
    Re-running Confirm import — including after stopping a batch partway — picks up only what is
    left.

!!! note "A coin's two images are imported together or not at all"
    If the obverse or reverse half fails, neither is kept and the summary says images were not
    imported. In the rare case an unfinished image record cannot be removed, the summary names it
    so you can delete it by hand.

!!! warning "Only jesusvico.com and biddr.com are verified against real auction data"
    All five source adapters are wired up, but aureo.com, numisbids.com and sixbid.com have only
    been checked by code review so far, not against a real production run. Watch the per-lot result
    lines closely the first few times you use one of them.

!!! note "numisbids.com and sixbid.com never fetch automatically"
    Both sites' robots.txt blocks every automated agent, confirmed live — pasting either site's URL
    into Preview always refuses. The saved-HTML upload described above is the only way to import
    from them.

!!! note "The Type link only ever points to an existing record"
    A catalog citation (e.g. "ACIP-1759") parsed out of the lot's description is matched against the
    Types this Dédalo instance already curates — a shared scholarly classification, not something
    this tool fabricates. A citation found with nothing matching it is reported as such so you can
    add the Type by hand if it is worth curating.

!!! warning "A single batch is capped at 3000 lots"
    Preview shows at most the first 3000 lots found at one URL (reporting how many more were left
    out); Confirm import refuses outright, rather than silently trimming, a batch larger than that.

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
    Cancelling a running Confirm import stops it before starting the next lot — it never leaves a
    half-written record behind. The summary reports how many of the total were actually committed,
    and re-running the same batch afterwards only imports what is left (see the dedup note above).

## Related

- **[Media file import](using_import_files.md)** — the `crop_50` processor that splits each lot's
  photo into obverse/reverse halves is the same per-file processor `tool_import_files`' own selector
  would otherwise expose (and refuses there today, since no processor is registered for client use);
  here it is called directly as trusted server code.
- **[Journal article import](using_bibliography_acquisition.md)** — built the same way (paste a
  public URL, review a checklist, commit in the background) for a different domain: journal articles
  into Publications, rather than auction lots into Numismatic Objects.
- **[Developer reference](../../development/tools/reference/tool_numisdata_acquisition.md)** — the
  `preview_url`/`preview_html`/`commit_lots` actions, the source adapters, and the dedup/lock rules.
