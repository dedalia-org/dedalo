# Image rotation (`tool_image_rotation`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_image_rotation.md)

Image rotation is an interactive editor for straightening and reframing an image already attached to a record — it rotates and crops every web-sized copy while leaving the preserved master untouched.

## What it's for

An image component keeps a preserved master plus several generated copies (a web-sized version, a small preview, a thumbnail). When a scan or photo comes out crooked or with an unwanted border, you do not want to re-scan and re-upload — you want to straighten it in place. Image rotation opens the picture in an editor, lets you pick a precise angle and draw a crop rectangle, and re-renders all the derived copies to match. The original master is always kept intact, so you can redo the transform later from the pristine file.

The same panel offers **background removal**: it can isolate the subject and drop the background using a neural network that runs in your browser.

Concrete scenario: a photo archivist uploads a scanned print that came off the scanner tilted and with a black edge. They open **Image rotation**, nudge the angle slider until the horizon is level (the alignment guides and "Expand" mode keep the corners from being clipped), draw a crop box to remove the edge, and apply. Every web and thumbnail copy is regenerated straight and trimmed; the archived master is unchanged.

## When to use it

- A derived image needs straightening or reframing without re-uploading.
- You want to isolate an object on a transparent or plain background.

It works on images only. To manage the wider quality set — rebuild, delete, fix audiovisual headers, re-sync — use [Media versions](using_media_versions.md). To bring a new image into a component, use [Upload](using_upload.md).

## Where to find it

Image rotation surfaces as a button on `component_image` components in the record's edit view. It opens as a modal containing the editor.

## Using it, step by step

1. Open the record and click the **Image rotation** button on the image component. The editor opens showing the picture with alignment guides.
2. Set the angle: drag the **Rotation** slider (any angle, in fine steps) or type a value in the box next to it. The preview rotates live.
3. If the corners get clipped, tick **Expand** so the canvas grows to fit the whole rotated image.
4. Choose how exposed corners are filled: pick a **Background colour**, or tick **Transparent** for an alpha background (only meaningful for formats that support transparency).
5. To crop, click the crop button and draw a rectangle over the image; drag its handles or the box itself to adjust. The live readout shows the selection.
6. Press the apply button (labelled **Create**). Confirm when prompted. Dédalo re-renders every derived copy with the rotation and crop, then reloads the preview. The slider and crop reset.
7. To isolate the subject, press **Remove background**. If your browser lacks WebGPU you are warned it may be slow. The result is uploaded and processed into a new copy.

## Options

| Control | What it does |
| --- | --- |
| Rotation (slider / value) | Sets the rotation angle applied to every derived copy. Zero leaves the orientation unchanged. |
| Expand | Grows the canvas to the rotated bounding box so no corners are clipped; unchecked keeps the original frame and clips corners. |
| Background colour | The fill colour shown behind the rotated image where corners are exposed. |
| Transparent | Renders the background as transparent instead of a solid colour (needs an alpha-capable format). |
| Crop | Toggles the crop overlay; draw and adjust a rectangle to trim the image. |
| Create (apply) | Sends the rotation and crop to the server, which re-renders the derived copies. |
| Remove background | Runs in-browser background removal and files the cut-out as a new copy. |

## Tips and gotchas

!!! tip
    Turn on **Expand** before rotating a rectangular image — otherwise the slider crops the corners as it turns, and you lose the parts you were trying to keep.

!!! warning
    Applying a rotation or crop re-renders every derived copy and cannot be undone from within this tool. The preserved master (the `original` quality) is never overwritten, so if you need to start over, use [Media versions](using_media_versions.md) to rebuild the copies from the master.

!!! info
    Background removal runs the neural network entirely in your browser; a WebGPU-capable browser makes it practical, and you are prompted before it starts on an incompatible one.

## Related

- **[Media versions](using_media_versions.md)** — the broader quality manager; it also offers a simple per-quality rotate.
- **[Upload](using_upload.md)** — bring an image into the component in the first place.
- **[Posterframe](using_posterframe.md)** — the equivalent capture tool for audiovisual clips.
- **[Developer reference](../../development/tools/reference/tool_image_rotation.md)** — the `apply_rotation` action, options and internals. See also the [media pipeline](../../development/media_pipeline.md) overview.
