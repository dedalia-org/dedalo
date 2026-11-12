# Date values

> See also: [Sections — typed-column storage](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns) · [component_date](../components/component_date.md) · [Components index](../components/index.md)

This page documents the **DATE data type** itself — the value object that Dédalo
stores in the matrix `date` column — not the component that edits it. For the
editing component (views, properties, import/export, search UI) see
[component_date](../components/component_date.md).

---

## 1. What it is and why it exists

The DATE value stored in the `date` column is a **locale-aware,
timestamp-free** object: the normalized representation of every calendar
value the system stores.

It exists because an absolute epoch offset (a Unix timestamp) cannot
represent the dates a cultural-heritage / archaeological database routinely
needs:

- **BCE dates** — a Unix timestamp has no notion of "44 BCE".
- **Very large CE years** — beyond the representable integer range.
- **Partial dates** — a bare year (`1930`), or year + month (`2022-04`), with no
  day, hour or finer field.

Instead of an absolute epoch offset, a DATE value stores **each calendar
field as a plain nullable integer**, plus its own ordinal `time` field for
sorting. Any field may be absent (unspecified); nothing forces a complete
date.

!!! info "One data object, six date modes"
    The DATE object itself carries **no** calendar/era field and **no**
    type/period field. Whether a value is a single date, a range, a period
    (duration) or a clock time is decided entirely by **which container key
    wraps the object** (`start` / `end` / `period`) and by the producing
    component's `date_mode` property. See
    [§4 Components that produce it](#4-components-that-produce-it).

!!! warning "TS coverage today: partial"
    The virtual-calendar arithmetic (`year × 372 + month × 31 + day` days, in
    seconds) is implemented at the specific call sites that need it:
    `virtualDateNow()` for the `dd197`/`dd201` audit stamps
    (`src/core/section/record/create_record.ts`), the Time Machine `dd559`
    timestamp (`src/core/tm_record/tm_record.ts`, `src/core/db/time_machine.ts`),
    media `file_time` (`src/core/media/files_info.ts`), and search
    (`convertDateToSeconds()`, `src/core/search/builders/builder_date.ts`).
    Search covers only numeric `start.time` comparisons for the default
    `date` mode — the `range`/`period`/`time`/`time_range`/`date_time` modes
    are not yet covered there. A general `component_date` field's `time` is
    **not** recomputed server-side on save today (see the warning in
    [§2](#2-canonical-json-shape)); it is stored exactly as the client sends
    it. Full parsing of `dmy`/`mdy`/BCE-signed CSV input is likewise not yet
    implemented server-side.

---

## 2. Canonical JSON shape

Only the fields that carry a value are present — absent fields simply do not
appear in the JSON. A year-only date is stored as exactly `{"year":1930}`.

### All fields

These are the fields a DATE object can carry:

| Key | Type | Range | Notes |
| --- | --- | --- | --- |
| `day` | `?int` | 1–31 | |
| `month` | `?int` | 1–12 | |
| `year` | `?int` | any integer | **negative = BCE** (e.g. `-44` = 44 BCE); no range constraint |
| `hour` | `?int` | 0–23 | |
| `minute` | `?int` | 0–59 | |
| `second` | `?int` | 0–59 | |
| `time` | `?int` | — | **monotonic sort value in seconds**, *not* a Unix timestamp — the virtual-calendar ordinal (see [§ The `time` sort value](#the-time-sort-value)) |
| `ms` | `?int` | 0–999 | milliseconds |
| `op` | `?string` | `>` `<` `>=` `<=` `=` | comparison operator, used **only during search**; absent on stored values |
| `timestamp` | `?string` | — | raw round-trip string, preserved verbatim, not derived |

!!! warning "`time` is meant to be server-authoritative — currently only true at specific call sites"
    `time` is the virtual-calendar ordinal (seconds), computed by
    `virtualDateNow()` (`src/core/section/record/create_record.ts`) for the
    audit-stamp fields it owns, and by the Time Machine / media call sites
    listed in [§1](#1-what-it-is-and-why-it-exists). For a **general**
    `component_date` field, the TS write path does not currently recompute
    `time` on save — whatever the client sends is stored as-is. Do not rely
    on server-side recomputation for a general date field today; supply a
    correct `time` from the client if the stored value must be search-ordered
    correctly.

### Virtual-calendar constants

The sort-seconds arithmetic uses a **virtual** calendar: a year is 372 days
(31 × 12), a month is 31 days. These constants are reused wherever the
ordinal is computed — `virtualDateNow()`
(`src/core/section/record/create_record.ts`) and `convertDateToSeconds()`
(`src/core/search/builders/builder_date.ts`).

---

## 3. Database column and keying

The DATE data object lives in the matrix **`date` typed JSONB column**.

As described in [Sections — typed-column storage](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns),
the single conceptual record `data` payload is physically split across typed
JSONB columns so PostgreSQL can index each shape. Routing to the `date`
column is resolved through `getColumnNameByModel('component_date')`
(`src/core/ontology/resolver.ts`), which reads `column: 'date'` off
`component_date/descriptor.ts`.

Inside that column, the value is **keyed by the component's ontology `tipo`**,
and `component_date` is non-translatable, so the language key is always
`lg-nolan`:

```json
{
  "rsc85": {
    "lg-nolan": [
      { "start": { "year": 1999, "month": 1, "day": 1, "time": 64249459200 } }
    ]
  }
}
```

- `rsc85` — the component tipo (the "column" within the section).
- `lg-nolan` — the fixed language slot (dates are language-independent).
- the value is an **array** of *record items*; each item holds one or more
  containers (`start` / `end` / `period`) whose values are `dd_date` shapes.

Ordering is meant to use the `time` ordinal (the JSONB `start.time` path).
The one exception is the Time Machine timestamp field (tipo `dd559`,
`TM_COLUMN_TIMESTAMP`, `src/core/tm_record/tm_record.ts`): it is derived from
the literal SQL `timestamp` column, not a JSONB path
(`ddDateFromTimestamp()`).

---

## 4. Components that produce it

The DATE data object is produced and consumed exclusively by
**[component_date](../components/component_date.md)**
(`src/core/components/component_date/descriptor.ts`), a literal-direct,
non-translatable component.

`component_date` does not store a single DATE value as the unit of data. It
stores an **array of plain record objects**; the `start` / `end` / `period`
keys inside those records each hold a DATE object of the shape documented
above.

The ontology property **`date_mode`** (default `'date'`) selects which containers
and fields a record uses:

| `date_mode` | Containers | Fields used |
| --- | --- | --- |
| `date` *(default)* | `start` | year → day |
| `range` | `start`, `end` | year → day |
| `period` | `period` | year / month / day reinterpreted as a **duration count** |
| `time` | `start` | hour / minute / second only |
| `time_range` | `start`, `end` | clock fields only |
| `date_time` | `start` | full year → second |

Rendering a record to text, per `date_mode`, is covered for the `date` and
`range` modes by `resolveCellValue()`'s `date` family
(`src/core/resolve/relation_list.ts` — see [§7](#7-examples) for the exact
output shapes); the `period`/`time`/`time_range`/`date_time` modes are not
yet covered there.

---

## 5. The `time` sort value

`time` is an **ordinal**, in seconds, built from *virtual* calendar units — a
year is 372 days (31 × 12), a month is 31 days — decrementing month/day by 1
so the epoch (year 0, month 1, day 1) maps to `0`. This makes "January 1 of
year N" and "year N alone" sort **identically**, so partial dates order
correctly beside full ones, and it handles negative (BCE) years.
`convertDateToSeconds()` (`src/core/search/builders/builder_date.ts`) and
`virtualDateNow()` (`src/core/section/record/create_record.ts`) both build
this ordinal.

!!! danger "`time` is not reversible"
    `time` is an ordinal *position*, **not** an absolute wall-clock time. Do
    not feed it to a standard date/time formatter — it is not a Unix
    timestamp and will not decode as one.

---

## 6. Client-side model

In the JSON API the value reaches the browser inside the component datum's
`data.value` layer (see [Components → data](../components/index.md#data)). Because
the component is non-translatable, the data slot is keyed by `lg-nolan`:

```json
{
  "tipo": "rsc85",
  "lang": "lg-nolan",
  "value": [
    { "start": { "year": 2012, "month": 11, "day": 7, "time": 64638475292 } }
  ]
}
```

The client model (`client/dedalo/core/component_date/js/component_date.js`)
treats a DATE value as a plain object carrying any subset of
`{ year, month, day, hour, minute, second, millisecond, time }`, wrapped by the
container that matches `date_mode`:

```javascript
// shapes the client builds / consumes, per date_mode
date / date_time   →  { start: date }
range              →  { start: date, end: date }
time / time_range  →  { start: date [, end: date] }
period             →  { period: { year, month, day } }
```

The client's own date parsing/editing never sets `time` — it reads the
display order (`dmy` / `ymd` / `mdy`) from the global
`page_globals.dedalo_date_order`, not from a per-component property.
Parsing, formatting and the built-in calendar editor all live in the JS model;
mismatched fields are flagged rather than silently coerced. See the warning
in [§2](#2-canonical-json-shape) for who is currently responsible for
supplying `time` on a general field.

---

## 7. Examples

A record item is one entry of the value array. The shapes below are exactly as
stored in the `date` column.

**Single full datetime (range):**

```json
[
  {
    "start": { "year":2012, "month":11, "day":7, "time":64638475292, "hour":17, "minute":33, "second":49 },
    "end":   { "year":2012, "month":12, "day":8, "time":64641254135, "hour":22, "minute":15, "second":35 }
  }
]
```

**Partial date (year + month only)** — a partial item simply omits the finer
fields:

```json
[ { "start": { "month":4, "year":2022 } } ]
```

**BCE year-only date** — for a year-only value the `time` ordinal reduces to
`year × 372 × 86400` (here `-205 × 372 × 86400 = -6588864000`):

```json
[ { "start": { "year":-205, "time":-6588864000 } } ]
```

**Period (duration) — *3 years 2 months 15 days*** (year/month/day are duration
counts, not an absolute date):

```json
[ { "period": { "year":3, "month":2, "day":15 } } ]
```

**Clock time only (`time` mode):**

```json
[ { "start": { "hour":17, "minute":33, "second":49 } } ]
```

**Multi-value (several record items in one component):**

```json
[
  { "start": { "year":1852, "month":12, "day":22 } },
  { "start": { "year":1853, "month":2,  "day":18 } }
]
```

How these resolve to a flat display string. There is exactly **one** formatter
in the engine — `dateItemToValue()` in
`src/core/components/component_date/date_value.ts` — and every surface that
shows a date as text calls it: the relation-list ("Referencias") cells, the
export cells and the thesaurus indexation grid. It dispatches on the node's
`date_mode` property, and it degrades gracefully as the stored parts thin out,
so a partial date **never** loses a field it does carry:

```text
date_mode 'date'  (the default)
  year+month+day     →  "2012/11/07"
  year+month, no day →  "2012/11"        (the month is KEPT)
  year only          →  "2012"           (unpadded)
  BCE year only      →  "-205"
  BCE year+month     →  "-205/03"        (padded to four, sign included)

date_mode 'range'
  →  "2012/11/07 <> 2012/12/08"          (each end degrades on its own)
  →  "1987 <> 1988"                       (year-only ends)

date_mode 'time' / 'time_range'
  →  "17:33:49"  /  "01:02:03 <> 04:05:06"

date_mode 'date_time'
  →  "2012/11/07 17:33:49"

date_mode 'period'
  →  "2 years 3 months 4 days"            (unit words in the interface language)
```

!!! warning "Never write a second date formatter"
    A duplicate of this function once rendered `d-m-Y` and dropped the month
    from every day-less date, silently damaging real catalogue records.
    `test/unit/date_flat_value_single_source_tripwire.test.ts` now fails if a
    second date assembler appears anywhere in `src/`.

---

## 8. v7 consolidation / evolution

- **Single source of truth for the shape.** One normalized DATE object shape
  is used everywhere a calendar value is stored — sections, Time Machine
  timestamps, media file dates — instead of per-subsystem date formats.
- **Sparse output.** Emitting only the fields that carry a value keeps the
  `date` column compact and makes partial dates first-class — there is no
  "empty day = 0" noise to interpret on read.
- **Timestamp-free by design.** The deliberate break from Unix-timestamp
  representations is what lets Dédalo store BCE, far-future and partial dates
  uniformly.

---

## See also

- [component_date](../components/component_date.md) — the component that edits and searches this value (see this page for what search and display coverage exists today).
- [Sections — typed-column storage](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns) — where the `date` column sits among the typed JSONB columns.
- [Components index](../components/index.md) — the component typology and the datum `context` / `data` layers.
