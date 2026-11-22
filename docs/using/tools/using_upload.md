# Upload (`tool_upload`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_upload.md)

Upload is the step that takes a file you have just sent from your browser and files it properly into a media component — moving it into storage, generating its web copies, and updating the record so the new media shows up.

## What it's for

Attaching a media file to a record happens in two parts. First your browser streams the file up to Dédalo (with a drag-and-drop picker and a progress bar). That leaves the file staged in a temporary area but not yet part of the record. Upload is the **second part**: it moves the file into the component's master slot, builds the derived qualities the media needs (web-sized image, video/audio versions, PDF and 3D previews), and writes the updated file information back so the record immediately shows the new file instead of a placeholder.

For most people this is invisible — it is what happens automatically after you drop a file onto an image, video, PDF, 3D or SVG component. It is documented here so you understand what the "Processing file…" step is doing, and why large files take a while.

Concrete scenario: a cataloguer drops a large TIFF onto an object's image component. The browser uploads it; then the processing step moves the master into place and generates the web preview and thumbnail. The image preview refreshes in the record without a page reload.

## When to use it

- It runs on its own whenever you upload a file to a media component — you rarely invoke it by name.
- If a colleague asks "what is the *Processing file…* message after an upload?", this is it: the server filing and deriving your uploaded file.

To bulk-ingest many files at once, use [File import](using_import_files.md) instead. To manage the copies of a file that is already in place, use [Media versions](using_media_versions.md).

## Where to find it

Upload is tied to the media components — image, audiovisual, PDF, 3D and SVG. It opens in its own window as the file picker, and its processing step runs automatically once your file finishes uploading. You will see a file picker (or drop zone) and, after you choose a file, a spinner with a **Processing file…** message. When the file is an image or other component, a live preview of the result appears when processing finishes.

## Using it, step by step

1. On the media component, start an upload (choose a file or drag one onto the drop zone). The file streams to the server with a progress bar.
2. When the transfer finishes, the **Processing file…** spinner appears. Dédalo is moving the file into storage and generating its copies.
3. Wait for the confirmation. Large files and video transcodes can take a while — the step allows up to an hour before timing out.
4. On success, the message turns to a success note and — for a component — a preview of the updated media is shown. On failure, the error message is shown as plain text.
5. For a video, the web/audio versions are transcoded in the background; the preview may finish before those are fully ready. Use [Media versions](using_media_versions.md) to check or re-sync the qualities if needed.

**While a video is still being converted, a new upload to the same field is refused** with *"A version build is already running for this file. Wait until it finishes and try again"*. This covers the conversion started by a previous upload and any quality being rebuilt in [Media versions](using_media_versions.md): one build runs per field at a time. Other fields of the same record are not affected. The file you sent is discarded and the stored file is left exactly as it was. Wait until the job in the activity tray (bottom-right corner) finishes, then upload again.

## PDFs: the transcription and OCR

When you upload a PDF, Dédalo also copies its text into the record's transcription field — the text area linked to the PDF, such as *Transcription* next to *Document* in the resources media section. Each page starts with a page tag that marks where that page begins. The text is saved in your current data language.

- **A transcription already there is replaced.** If the field already had text in that language, the new PDF's text takes its place, and the upload shows a note saying how much was replaced. Nothing is lost: [Time Machine](using_time_machine.md) keeps the previous version.
- **A scanned PDF with no text** gets nothing written, and the upload says so. Use OCR for those.

**OCR.** For a scanned PDF, tick **OCR** in the upload panel and pick the language of the document before you upload. Dédalo then reads the scanned pages in the background — the job appears in the activity tray in the bottom-right corner, and a long book can take several minutes. When it finishes, the web copy of the PDF carries a text layer and the transcription is filled from it. Your original file is kept exactly as you uploaded it.

The OCR option appears only when the server can run it, and the language list shows only the languages your administrator has installed OCR support for. If OCR is missing, or a language you need is not offered, ask your administrator.

## Tips and gotchas

!!! tip
    To upload a replacement file after one has processed, reload the page first — the picker hides itself after a successful upload to prevent a double submission.

!!! warning
    Very large media and video transcodes can take minutes; the processing step deliberately waits (up to an hour) rather than failing early. Do not close the window while **Processing file…** is showing.

!!! info
    The file type is restricted to what the component accepts, and the file is validated again on the server before it is filed. The preserved master is stored intact and the web copies are derived from it.

## Related

- **[File import](using_import_files.md)** — ingest a whole batch of media files and their records at once.
- **[Media versions](using_media_versions.md)** — manage the qualities Upload produces, and re-sync after a video transcode finishes.
- **[Update cache](using_update_cache.md)** — fills empty PDF transcriptions in bulk, for example for PDFs uploaded before automatic transcription existed.
- **[Image rotation](using_image_rotation.md)** — rotate/crop an uploaded image; it re-runs this processing after background removal.
- **[Developer reference](../../development/tools/reference/tool_upload.md)** — the `process_uploaded_file` action, the job-status poll, and internals. See also the [media pipeline](../../development/media_pipeline.md) overview.
