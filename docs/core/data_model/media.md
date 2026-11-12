# Media values

> The value shape stored in the `media` typed column — per-quality file
> descriptors that point a record at its binaries on disk through a
> **flat-locator filename**.

> See also: [Sections — typed-column storage](../sections/index.md) ·
> [Locator (flat form)](../locator.md) ·
> [media_engine](../system/media_engine.md) ·
> [Media protection](../system/media_protection.md)

This page documents the **data type**, not a single component. Five components
produce it — [`component_image`](../components/component_image.md),
[`component_av`](../components/component_av.md),
[`component_pdf`](../components/component_pdf.md),
[`component_3d`](../components/component_3d.md) and
[`component_svg`](../components/component_svg.md) — and they all store the same
value shape in the same column. For how each component drives uploads, quality
maps and rendering, read the per-component pages cross-linked above.

---

## What it is

A media value is **not** the binary file. Binaries live in the media tree on
disk (or on an external host); the database stores only a small JSON
**descriptor** that lists which qualities/versions exist, their sizes and
timestamps, and the original/modified uploaded names. The descriptor is the
bridge between a record and its files: from it, plus the component's ontology
configuration, Dédalo can reconstruct the exact on-disk path of every quality
without scanning the filesystem.

This separation is deliberate:

- the database stays small and indexable (the heavy bytes never enter `matrix`);
- the same record can describe many derived qualities of one upload
  (`thumb`, `1.5MB`, `original`, `modified`, …);
- the filename is **derived**, not stored as a free path — it is computed from
  the record's identity (the flat locator), so moving the media root or
  re-bucketing folders never requires a data rewrite.

Media is stored **language-neutral** (`lg-nolan`) by default. The only
exception is `component_pdf`, which *may* be translatable; when a media model is
translatable the language is appended to the filename (see
[Flat locator → filename](#flat-locator-on-disk-filename)).

---

## Canonical JSON shape

The stored data is an **array with a single item**. The item carries a
`files_info` list (the canonical per-quality descriptors) plus the
`original_normalized_name` / `modified_normalized_name` of the upload and an
optional `lib_data` bag (used by `component_image`).

```json
[{
  "files_info": [
    {
      "quality": "thumb",
      "file_exist": true,
      "file_name": "rsc29_rsc170_1.jpg",
      "file_path": "/media/image/thumb/0/rsc29_rsc170_1.jpg",
      "file_size": 13540,
      "file_time": {"day":29,"month":5,"year":2022,"hour":18,"minute":44,"second":35,"timestamp":"2022-05-29 18:44:35","time":65001897875},
      "extension": "jpg"
    },
    {
      "quality": "1.5MB",
      "file_exist": true,
      "file_name": "rsc29_rsc170_1.jpg",
      "file_path": "/media/image/1.5MB/0/rsc29_rsc170_1.jpg",
      "file_size": 1127046,
      "file_time": {"timestamp":"2022-05-29 18:44:35"},
      "extension": "jpg"
    }
  ],
  "original_normalized_name": "rsc29_rsc170_1.tif",
  "modified_normalized_name": "rsc29_rsc170_1.psd",
  "lib_data": {}
}]
```

### Per-entry fields (`files_info[*]`)

| field | meaning |
| --- | --- |
| `quality` | the derived version this entry describes (`thumb`, `1.5MB`, `original`, `modified`, …). |
| `file_exist` | whether the file is present on disk; consumers (`get_url`, `get_datalist`) skip entries that are `false`. |
| `file_name` | the on-disk filename — the [flat locator](#flat-locator-on-disk-filename) plus the entry's extension. |
| `file_path` | the path **relative to `DEDALO_MEDIA_PATH` / `DEDALO_MEDIA_URL`** (`/{folder}{initial_media_path}/{quality}{additional_path}/{file_name}`). |
| `file_size` | size in bytes. |
| `file_time` | a structured timestamp object (`timestamp` is the canonical string; the day/month/year/… breakdown may also be present). |
| `extension` | the file extension of *this* quality (a `thumb` can be `jpg` while `original` is `tif`). |

### Item-level fields

| field | meaning |
| --- | --- |
| `original_normalized_name` | the uploaded original, normalized (e.g. `rsc29_rsc170_1.tif`). Preserves the *original* extension, materialised under the `original` quality. |
| `modified_normalized_name` | the working/modified master (e.g. `rsc29_rsc170_1.psd`), materialised under the `modified` quality. |
| `lib_data` | free bag for component-specific metadata; used by `component_image` (empty `{}` otherwise). For `component_image` it holds the vector-editor layers; it is cleared together with `svg_file_data` when the record's last media file is deleted, so a later upload starts a fresh drawing (the cleared value is audited in the Time Machine). |

!!! note "External-source variant"
    When the media is hosted elsewhere, the entry adds `"external": true`,
    `file_path` becomes the **external URL**, and `file_name` / `file_size` /
    `file_time` are `null`. The external URL is resolved through the component's
    `external_source` property, which names a sibling
    [`component_iri`](../components/component_iri.md) whose first `iri` value is
    used as the source — the `externalSource` field threaded through
    `src/core/media/files_info.ts`'s builders.

---

## Flat locator → on-disk filename

This is the crux of the media data type: **the filename encodes the record's
identity**. The base name is the component's *flat-locator identifier*:

```text
{component_tipo}_{section_tipo}_{section_id}
```

(e.g. `rsc29_rsc170_1`), built by `buildMediaIdentifier()`
(`src/core/media/path.ts`) by joining `component_tipo`, `section_tipo` and
`section_id` with `_`. When the media model is **translatable** the data
language is appended:

```text
{component_tipo}_{section_tipo}_{section_id}_{lang}      // e.g. dd650_oh1_7_lg_eng
```

The full on-disk path is then assembled by `buildMediaLocation()` and its
sibling helpers (`src/core/media/path.ts`):

```text
DEDALO_MEDIA_PATH + /{folder}{initial_media_path}/{quality}{additional_path}/{id}.{extension}
```

Every produced absolute path is checked against the configured media root via
`assertInsideMediaRoot()` — a single traversal chokepoint that every media
path passes through before it is used.

| segment | source | default / example |
| --- | --- | --- |
| `folder` | `get_folder()` (per media model) | `/image`, `/av`, `/pdf`, `/3d`, `/svg` |
| `initial_media_path` | section property `initial_media_path[{component_tipo}]` | empty unless configured |
| `quality` | the version being addressed | `thumb`, `1.5MB`, `original`, … |
| `additional_path` | `get_additional_path()` | folder bucketing — see below |
| `{id}` | the flat locator | `rsc29_rsc170_1` |
| `{extension}` | per-quality extension | `jpg`, `tif`, `psd`, … |

### Folder bucketing (`additional_path`)

Directories are kept from growing unbounded by bucketing. If a section
property `additional_path` names another component, its value is used
verbatim; otherwise it **falls back to id-bucketing** from `max_items_folder`
(normally `1000`) via `additionalPath(sectionId, maxItemsFolder)`
(`src/core/media/path.ts`):

```text
additional_path = '/' + max_items_folder * floor(section_id / max_items_folder)
```

So `section_id = 1` → `/0`, `section_id = 1500` → `/1000`, etc. This is why the
sample paths read `/media/image/1.5MB/0/rsc29_rsc170_1.jpg`.

Putting it together for `rsc29_rsc170_1`, quality `1.5MB`, extension `jpg`:

```text
DEDALO_MEDIA_PATH + /image      + (no initial)  + /1.5MB + /0 + /rsc29_rsc170_1.jpg
                    └ folder                       └quality └bucket └ {id}.{ext}
=> /media/image/1.5MB/0/rsc29_rsc170_1.jpg
```

The `original` / `modified` qualities keep the *uploaded* extension via
`original_normalized_name` / `modified_normalized_name` (e.g. `…_1.tif`,
`…_1.psd`), which is how a `thumb.jpg` and an `original.tif` coexist for one
record.

See [Locator — flat form](../locator.md) for the general
`tipo_sectiontipo_sectionid` identifier grammar, and
[Media protection](../system/media_protection.md) for the inverse direction
(parsing this exact filename back to a record to enforce access).

---

## Database column

| column | type | keying |
| --- | --- | --- |
| `media` | `jsonb` (stdClass) | keyed by **component tipo** inside the column |

The `media` column belongs to the [typed-column storage model](../sections/index.md):
the conceptual record `data` is split across typed JSONB columns so PostgreSQL
can index each shape. All five media models route to `media` via each one's
own descriptor (`component_3d/descriptor.ts`, `component_av/descriptor.ts`,
`component_image/descriptor.ts`, `component_pdf/descriptor.ts`,
`component_svg/descriptor.ts` — all declare `column: 'media'`), resolved
through `getColumnNameByModel()` (`src/core/ontology/resolver.ts`).

Inside the column the value is keyed by component tipo
(`{ "rsc29": [ { "files_info": […] } ] }`), so one record can hold several
media components side by side. The GIN search index queries media by atom
properties (e.g. `original_file_name`); note the `media` column is **excluded**
from the `matrix_activity` table.

---

## Components that produce / use it

| component | files | folder |
| --- | --- | --- |
| [`component_image`](../components/component_image.md) | images (thumb/derived qualities, `lib_data`) | `/image` |
| [`component_av`](../components/component_av.md) | audio / video | `/av` |
| [`component_pdf`](../components/component_pdf.md) | PDF documents (may be translatable) | `/pdf` |
| [`component_3d`](../components/component_3d.md) | 3D model files | `/3d` |
| [`component_svg`](../components/component_svg.md) | SVG vector files | `/svg` |

---

## Server-side handling

There is no shared base class; the data type's behaviour lives in a handful
of focused modules under `src/core/media/`, shared by all five components:

| Behaviour | Module |
| --- | --- |
| identity / paths — the flat locator, initial media path, additional path | `buildMediaIdentifier()`, `additionalPath()` (`src/core/media/path.ts`) |
| assembled path/URL, media-root containment | `buildMediaLocation()`, `absoluteFromRelative()`, `assertInsideMediaRoot()` (`src/core/media/path.ts`) |
| descriptor rebuilding, per-quality entries, presence checks | `scanFilesInfo()`, `getQualityFileInfo()`, `refreshStoredFilesInfo()` (`src/core/media/files_info.ts`) |
| external source resolution | the `externalSource` field threaded through `files_info.ts`'s builders |

Transcoding/resizing is delegated to the stateless
[media_engine](../system/media_engine.md) wrappers under
`src/core/media/engine/` (spawning `ffmpeg` / ImageMagick).

---

## Client-side model

In the browser the value arrives in the component's datum `data` layer. The JS
reads two keys:

- `data.entries` — the `files_info` list (the per-quality descriptors);
- `data.external_source` — the external URL when the media is remote.

```javascript
// client/dedalo/core/component_media_common/js/component_media_common.js (excerpt)
const data            = self.data || {}
const entries         = data.entries || []   // entries is a files_info list
const files_info      = entries
const external_source = data.external_source

// no on-disk quality and no external URL → offer the upload tool
const file_exist = files_info.find(item => item.file_exist===true)
```

A local entry's `file_path` is always relative to the media root, prefixed at
render time; an external entry's `file_path` is the absolute external URL and
is used as-is. Clients never store absolute local paths.

---

## Examples

### Local image, two qualities

```json
{
  "rsc29": [
    {
      "files_info": [
        { "quality":"thumb", "file_exist":true, "file_name":"rsc29_rsc170_1.jpg",
          "file_path":"/media/image/thumb/0/rsc29_rsc170_1.jpg",
          "file_size":13540, "file_time":{"timestamp":"2022-05-29 18:44:35"}, "extension":"jpg" },
        { "quality":"1.5MB", "file_exist":true, "file_name":"rsc29_rsc170_1.jpg",
          "file_path":"/media/image/1.5MB/0/rsc29_rsc170_1.jpg",
          "file_size":1127046, "file_time":{"timestamp":"2022-05-29 18:44:35"}, "extension":"jpg" }
      ],
      "original_normalized_name":"rsc29_rsc170_1.tif",
      "modified_normalized_name":"rsc29_rsc170_1.psd",
      "lib_data": {}
    }
  ]
}
```

### External-source entry

```json
[{
  "files_info": [
    {
      "quality": "original",
      "file_exist": true,
      "external": true,
      "file_path": "https://example.org/assets/photo.jpg",
      "file_name": null,
      "file_size": null,
      "file_time": null,
      "extension": "jpg"
    }
  ]
}]
```

### Translatable PDF filename

For a translatable `component_pdf` (`dd650`) on `oh1` / `section_id 7`, data
language English, the `original` quality file is:

```text
DEDALO_MEDIA_PATH/pdf/original/0/dd650_oh1_7_lg_eng.pdf
```

---

## v7 consolidation / evolution

- **Unified descriptor.** All five media models share the single `files_info`
  array of per-quality descriptors plus the `original_normalized_name` /
  `modified_normalized_name` pair, instead of per-model ad-hoc shapes. The
  `src/core/media/` modules are the one place that builds and reads this
  shape.
- **Derived, not stored, paths.** Filenames are recomputed from the flat
  locator and ontology config (`folder` + `initial_media_path` + `quality` +
  `additional_path`). Nothing in the column hard-codes an absolute path, so the
  media root can move and folders can be re-bucketed without a data migration.
- **Quality sanitisation.** `buildMediaLocation()` runs `quality` through
  `assertValidQuality()` (`src/core/concepts/media.ts`) so a raw client value
  can never be reflected into a filesystem path — keeping path building
  consistent with the [media protection](../system/media_protection.md) layer
  that parses these same filenames back into records.

---

## See also

- [Sections — typed-column storage](../sections/index.md) — how the `media`
  column fits the matrix-table model.
- [Locator (flat form)](../locator.md) — the
  `{component_tipo}_{section_tipo}_{section_id}` identifier grammar.
- [media_engine](../system/media_engine.md) — the stateless `Ffmpeg` /
  `ImageMagick` wrappers that produce the qualities.
- [Media protection](../system/media_protection.md) — parsing the media
  filename back into a record to enforce access.
- Producing components:
  [image](../components/component_image.md) ·
  [av](../components/component_av.md) ·
  [pdf](../components/component_pdf.md) ·
  [3d](../components/component_3d.md) ·
  [svg](../components/component_svg.md).
