# Media versions (`tool_media_versions`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_media_versions.md)

Media versions is the panel where you manage the actual files behind a media component — inspect each quality, rebuild or delete one, rotate an image, fix an audiovisual file's headers, and re-sync the record with what is really on disk.

## What it's for

A media component in Dédalo — an image, an audio or video clip, a PDF, a 3D model or an SVG — never stores just one file. It keeps a preserved master plus a set of generated **qualities**: a web-sized `default`, a small `404` preview, a `thumb`, an `audio` track, and so on. Each is a real file on disk, and the record keeps an index of which qualities exist. Most of the time this set is built for you when a file is uploaded, and you never think about it. Media versions is where you look when something in that set goes wrong.

Concrete scenario: a museum archivist uploads a high-resolution TIFF master of an object. The web previews are generated automatically, but one comes out sideways, and later a colleague deletes a couple of derived files directly on the server. The record now warns that its file information is out of sync. The archivist opens **Media versions**, sees the mismatch between what the record expects and what is on disk, rotates the affected quality, and regenerates the missing files so the record and the disk agree again.

## When to use it

- A derived quality is missing, broken, rotated, or won't play/seek in the browser.
- The record shows that its file information is out of sync with the disk.
- You need to rebuild the web qualities from the preserved master, or delete a specific quality or file.
- An audiovisual file plays but won't scrub — you need to conform (rewrite) its headers.

Do **not** use it to bring a new master file into a component — that is the upload flow ([Upload](using_upload.md)) or a batch ingest ([File import](using_import_files.md)). Media versions works on the files of a media component that already exists.

## Where to find it

Media versions surfaces as a button on the media components themselves — `component_image`, `component_av`, `component_pdf`, `component_3d` and `component_svg` — in the record's edit view (in the component's inline controls and/or the inspector). It opens in a modal over the record. Some actions appear only on the model they apply to: the **rotate** action shows on images, and **conform headers** shows on audiovisual components.

## Using it, step by step

1. Open the record and find the media component whose files you want to manage. Click its **Media versions** button.
2. The modal opens with three areas: a read-only preview of the media at the top, a sync/regenerate area in the middle, and a grid of the individual qualities below.
3. Read the sync area. It compares the qualities the record expects with the qualities actually on disk. If they differ, it tells you the file information is out of sync.
4. In the versions grid, each row is one quality, showing its file name, size and whether it exists. Use the per-quality buttons to open, rebuild, rotate, delete, or (for audiovisual) conform the headers of that quality.
5. To rebuild the whole set from the master, use the regenerate control in the sync area. Optionally tick **Delete normalized files** first so stale derivatives are cleared before rebuilding. Press **Regenerate**.
6. Long operations (rebuilds, transcodes) can take minutes. The tool waits and confirms before running the destructive ones.

## While something is being built

A quality that is being generated right now shows a **progress readout** in its
column instead of a rebuild button: how far along it is, how long it has been
running, and — when the work was started by someone else — who started it.

This is read from the server, not from your own click, so it appears whoever
started the work. That matters most right after an upload: uploading a video
stores your file immediately and sends the web-sized version to be encoded in
the background, so the quality is genuinely still being made for some minutes
after the upload says it finished. Before, that column was simply empty, which
looked exactly like a quality that had never been built.

Because the server is doing the work, you do not have to keep the modal open.
The **activity tray** in the bottom-right corner of the screen lists everything
of yours that is running — media conversions, imports and publications alike —
with progress and elapsed time, and follows you as you move around the
application. Click a row to open the record it belongs to.

The tray also **reports how things ended**. A job that finishes stays listed
briefly with its result; one that fails stays until you dismiss it, and says
why. Media conversions can be stopped from the tray while they run; publications
are stopped from the diffusion panel in Maintenance, which is where that queue
is managed.

You cannot start a second build of a quality that is already being built; the
button is not offered while its work is running. If a build fails, or the
server is restarted while it runs, the column says so with the reason and
offers the rebuild again — it does not go back to looking empty.

!!! note "When there is no percentage"
    Some source files do not declare how long they are, and for those the
    progress bar shows movement without a number. The work is running normally;
    only its total length is unknown, and the tool would rather show that than
    invent a figure.

## Options

| Control | What it does |
| --- | --- |
| Show data | Reveals the comparison between the qualities recorded in the database and those found on disk, so you can see exactly what is missing or extra. |
| Rebuild (per quality) | Regenerates one quality from the preserved master. |
| Rebuild `thumb` (audio/video) | Builds the thumbnail from the record's posterframe. If the record has no posterframe yet, one is taken from the video automatically, so the button always produces a picture — use [Posterframe](using_posterframe.md) when you want to choose the frame yourself. |
| Rebuild `thumb` (3D models) | Captures the model as it is framed in the preview above and stores that picture as the record's posterframe, then derives the thumbnail from it. Orbit and zoom the preview to the view you want before you press it — that is the view lists will show. |
| Rotate (images only) | Rotates the files of the selected image quality. |
| Conform headers (audiovisual only) | Rewrites an audiovisual file's headers so it seeks/plays correctly in the browser. |
| Delete quality / Delete version | Removes a whole quality, or one specific file of a quality. |
| Delete normalized files | When ticked before regenerating, clears the existing derived files first, so they are rebuilt from the preserved master rather than kept. Your uploaded original is never touched. |
| Regenerate | Rebuilds the derived files that are MISSING — the web-sized versions, the thumbnail, the alternative formats — and then writes correct file information back to the record. Files that are already there are never re-encoded, so pressing it twice is harmless. Anything it could not rebuild (a format this server has no encoder for, a record whose master is not on this machine) is reported instead of passing in silence. For a PDF, it also fills the linked transcription field from the PDF's text when that field is empty in your data language; a transcription that already holds text is kept, never overwritten, and no OCR runs. |

## Tips and gotchas

!!! tip
    When a record warns that its media is out of sync, open **Show data** first to see what actually differs before regenerating — a single missing thumbnail needs far less than a full rebuild.

!!! note "Where a thumbnail comes from"
    Every media record has a thumbnail, and every one of them is a picture of
    something the record already holds: for images, PDFs and SVGs it is made from
    the file the record delivers; for audio/video and 3D models it is made from
    the record's **posterframe**, the still image that stands in for something a
    thumbnailer cannot read. That is why replacing the media file, or deleting a
    posterframe, also updates or removes the thumbnail — a thumbnail that outlived
    what it depicts would quietly misrepresent the record in every list.

!!! note
    A 3D model's thumbnail is not generated from the model file — nothing on the
    server can draw a mesh. It is a snapshot of the interactive viewer, taken in
    your browser, so the thumbnail always shows the view the preview was framed
    on when you pressed the button. Rebuilding it needs the preview to have
    loaded; on a machine where the viewer cannot run, the button falls back to
    rebuilding the thumbnail from the posterframe already stored.

!!! warning
    Deleting a quality or a version removes a real file from disk, and rebuilds and audiovisual transcodes can take several minutes and write across the quality set. These actions ask you to confirm first. The preserved master (the `original` quality) is never overwritten by rotate or rebuild, so you can always regenerate the derivatives from it.

## Related

- **[Posterframe](using_posterframe.md)** — capture a still frame from an audio/video file as its thumbnail or an identifying image.
- **[Image rotation](using_image_rotation.md)** — the full interactive rotate-and-crop editor for images; Media versions offers rotation inline per quality.
- **[Upload](using_upload.md)** · **[File import](using_import_files.md)** — get the master file into the component; Media versions then manages its derived qualities.
- **[Developer reference](../../development/tools/reference/tool_media_versions.md)** — the API actions, permission gates and internals. See also the [media pipeline](../../development/media_pipeline.md) overview.
