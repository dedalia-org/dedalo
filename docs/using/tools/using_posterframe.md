# Posterframe (`tool_posterframe`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_posterframe.md)

Posterframe lets you scrub through a video to a chosen moment and grab that frame — either as the clip's own thumbnail (its posterframe) or as an identifying image attached to a related record.

## What it's for

A video or audio clip needs a still image to represent it in lists, grids and the media player. Dédalo can generate one automatically, but the auto-pick often lands on a black frame or a title card. Posterframe gives you a player and lets you choose the exact frame that best represents the clip.

It also solves a heritage-specific need. In an oral-history archive, an interview record holds the video, but the public catalogue and the related **Person** or **Event** records want a face — a representative still. Posterframe can capture the frame where the interviewee is best framed and store it directly as the identifying image of that related record, with no manual screenshot, crop, upload and re-link.

Concrete scenario: an interview video is open. You scrub to the moment the interviewee looks straight at the camera, pick the related Person record from the selector, and press **Create identifying image**. Dédalo creates the still and files it as that Person's image, so their record shows that portrait wherever its image appears.

## When to use it

- A video or audio clip has no thumbnail, or its auto-generated one is unrepresentative.
- You want a related Person/Event (or other) record to show a still captured from this clip.

Do not use it to manage the clip's other qualities or fix playback — that is [Media versions](using_media_versions.md). Posterframe is specifically about capturing a frame.

## Where to find it

Posterframe surfaces as a button on audiovisual components (`component_av`, and also `component_3d`) in the record's edit view. It opens a player so you can navigate the clip frame by frame. The **Create identifying image** part appears only on `component_av`, and only when a related section has been configured (in the ontology) to receive an identifying image from this clip — otherwise the selector is empty.

## Using it, step by step

1. Open the record holding the video and click the **Posterframe** button on its audiovisual component.
2. The clip opens in a player. Scrub to the frame you want to capture.
3. To set the clip's own thumbnail, press **Create**. To remove an existing one, press **Delete**. The tool confirms first, then extracts the frame and refreshes the preview.
4. To attach the frame to a related record, choose the target from the **identifying image** selector (it lists the related records that are set up to receive one), then press **Create identifying image**. Confirm when prompted.
5. Dédalo creates the related record's image from the current frame and processes it into the standard image qualities. The related record now shows that still.

## Options

| Control | What it does |
| --- | --- |
| Create / Delete (posterframe) | Creates or removes the clip's own representative still, taken at the current playhead position. |
| Identifying-image selector | Lists the related records configured to accept an identifying image captured from this clip. |
| Create identifying image | Captures the current frame and stores it as the chosen related record's identifying image. |

!!! note "Creating replaces the current posterframe"
    The create button always writes a new posterframe over the existing one — for
    a 3D model, using whatever camera angle is on screen — so it asks you to
    confirm first. If it cannot capture (a 3D viewer that has not finished
    loading, an audio-only file), it now says so rather than quietly showing the
    placeholder image.

## Tips and gotchas

!!! tip
    Pause on the exact frame before pressing the button — the capture uses the current playhead position, so a well-chosen still saves cropping and re-linking later.

!!! info
    The identifying-image selector is populated from the ontology: a related section must expose a portal marked as this clip's identifying image. If the selector is empty, no related section has been configured that way — see the [developer reference](../../development/tools/reference/tool_posterframe.md) for the `identifying_image` property.

## Related

- **[Media versions](using_media_versions.md)** — manage the qualities the posterframe and identifying image produce.
- **[Image rotation](using_image_rotation.md)** — rotate and crop the resulting image files.
- **[Subtitles](using_subtitles.md)** · **[Transcription](using_transcription.md)** — the other audiovisual tools that host a media player over the same clip.
- **[Developer reference](../../development/tools/reference/tool_posterframe.md)** — the API actions, the ontology configuration, and internals. See also the [media pipeline](../../development/media_pipeline.md) overview.
