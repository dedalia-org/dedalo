# PDF text extractor (`tool_pdf_extractor`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_pdf_extractor.md)

The PDF text extractor pulls the text content of a PDF you have attached to a record and shows it in a preview you can copy into a text field — with the **html** method, a page marker at each page break so you can locate each page later. It is meant to seed a transcription from a document you already hold, not to run OCR on a scan.

## What it's for

When a record carries a PDF — an article, a report, a printed catalogue page — you often want its text inside a Dédalo text field so it becomes searchable and editable alongside the rest of the record. Copy-pasting from a PDF loses the page boundaries that let a reader jump to "page 12". This tool extracts the text with the page structure intact, ready for you to paste into the text field.

Concrete scenario: a documentary archive holds scanned-and-OCR'd journal articles as PDFs on each *Bibliography* record. A cataloguer opens the PDF component, runs the extractor with the **html** method, and copies the full article text — with a page tag at each page break — into the record's transcription field, ready to correct, index and publish.

!!! note
    This extracts the text layer already present in a PDF; it is **not** OCR. A PDF that is a pure image with no text layer will yield little or nothing. Make sure the PDF has extractable text first.

## When to use it

- A record has a PDF component and you want its text in one of the record's text fields.
- You want page markers so a reader can locate a page within the extracted text.

When *not* to use it:

- The PDF is a photographed or scanned image with no text layer — extraction will be empty; the file needs OCR first (re-upload it with **OCR** ticked, see [Upload](using_upload.md#pdfs-the-transcription-and-ocr)).
- You only want the PDF's text in the record's transcription field — an upload already writes it there.
- You want a transcript of audio or video — that is the transcription tooling, not this tool.

## Where to find it

The extractor is an **inline tool on a PDF component** (`component_pdf`). Open the PDF component on a record and you will find the **Extract PDF file content** action on it. It is PDF-only: it refuses to run on any other kind of component.

The extracted text is shown in the tool's own preview. Nothing is written to the record: you copy what you need into a text field yourself.

## Using it, step by step

1. Open a record that has a PDF component with an extractable text layer.
2. Launch **Extract PDF file content** on the PDF component. A small panel opens.
3. Optionally set **Page in** and **Page out** to extract only a page range. Leave both blank to extract the whole document — blank *Page in* starts at the first page, blank *Page out* runs to the last.
4. Choose the extraction method with the **txt / html** radio. **txt** (the default) gives the plain text exactly as the PDF holds it — characters such as `<` and `>` in an edition (`IMP CAES<A>R`) are kept as text — with no page markers. **html** gives formatted text with a page tag at each page boundary; anything executable a PDF might carry (scripts, `javascript:` links) is neutralized on the server before you see it.
5. Press **Process**. Extraction can take up to three minutes on a large document, so the panel shows a loading state while it works.
6. Review the extracted text in the inline **preview**.
7. Use **Select text** to select the whole preview, then copy it into the text field where it belongs.

## Options

| Option | What it does |
| --- | --- |
| Page in | First page to extract (1-based). Blank means start at page 1. |
| Page out | Last page to extract, inclusive. Blank means run to the last page. |
| Method (txt / html) | `txt` extracts plain text (the default), exactly as the PDF holds it, without page markers. `html` extracts formatted text and inserts a page tag at each page break, numbered from the PDF component's page offset when one is set. |

## Tips and gotchas

!!! tip
    Leave both page fields blank to extract the whole PDF. Set a range only when you need one section — for example a single article inside a bound journal issue.

!!! tip
    The extractor never changes a field on its own: an edited transcription is safe. Paste where you want the text, and correct it afterwards.

!!! note
    Extraction relies on an external PDF text engine (`pdftotext` / `pdftohtml`) being installed on the server. If it is missing or the PDF has no text layer, the panel shows an error instead of text. This is an installation-level requirement your administrator sets up.

## Related

- **[Print](using_print.md)** — lays out record components (including long transcriptions) onto a printable page.
- **[Developer reference](../../development/tools/reference/tool_pdf_extractor.md)** — the `get_pdf_data` action, options and the extraction engine.
