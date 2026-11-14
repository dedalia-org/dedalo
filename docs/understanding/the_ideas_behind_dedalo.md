# The ideas behind Dédalo

> Part of [Dédalo in plain language](index.md) · Previous:
> [Ready for AI — on your terms](ai_ready.md)
>
> Written for **curators, archivists, documentalists and humanities
> researchers**. No technical background assumed. Each idea ends with a pointer
> into the technical manual, for when you want the full version — or want to
> hand it to whoever will install the system.

Software for cultural heritage usually fails in one of two ways. Either it is a
spreadsheet with a nicer face — fast to start, impossible to keep coherent
after three years — or it is a rigid database designed by someone who has never
catalogued anything, where adding a field is a project. Dédalo is built on a
handful of ideas that try to avoid both.

---

## A record, a section, a field

Three words cover most of what you do.

- A **record** is one thing you catalogue: an object, an interview, a
  photograph, a person, a place, a bibliographic reference.
- A **section** holds all the records of the same kind. *Coins* is a section.
  *Oral testimonies* is a section. *People* is a section. If you come from
  databases: a section is a table; if you come from archives: it is a series of
  homogeneous units of description.
- A **component** is one field on a record — a title, a date, an extent, a
  photograph, a link to another record.

Components have *kinds*, and the kind is what makes a field intelligent. A date
component understands imperfect dates. A geographic component understands
coordinates and shapes. A media component understands that a file has a master,
derivatives and a thumbnail. A relation component understands that its content
is a pointer to another record, not a piece of text.

> More: [Sections](../core/sections/index.md) ·
> [Components](../core/components/index.md) ·
> [Glossary](glossary.md)

---

## The shape of your catalogue is data

This is the idea Dédalo is built around, and the one worth understanding even
if you read nothing else.

In most systems, the shape of the catalogue — which record types exist, which
fields they have, in what order, with which vocabularies, in which languages —
lives **in the program**. Changing it means changing the program: a developer,
a release, a budget, a delay.

In Dédalo the shape of the catalogue is **itself data**, held in a structure
Dédalo calls the *ontology* and edited inside Dédalo like anything else. Adding
a field, creating a whole new kind of record, reordering a form, making a field
repeatable or translatable, deciding that this field is a controlled vocabulary
pointing at that thesaurus — these are acts of documentation, not acts of
programming.

!!! info "Why this matters for an institution"
    Your descriptive model can follow your discipline instead of the software's
    assumptions. It can also *evolve*: a project that starts with a modest
    inventory and grows into a full scientific catalogue does not have to be
    rebuilt, and a standard that changes — a new controlled vocabulary, a new
    aggregator profile — is a change you make yourself.

The trade is honest: this power lives with whoever designs your model, so the
design deserves the same care as a cataloguing manual. Dédalo does not stop you
from designing a bad model; it stops the software from imposing one.

> More: [The active ontology](../core/ontology/index.md) ·
> [Architecture overview](../core/architecture_overview.md)

---

## Words that mean something: controlled vocabularies

A **thesaurus** in Dédalo is a tree of terms — places, personal names, subjects,
materials, techniques, typologies — and the terms in it are ordinary records.
That last point is the important one: a term can be described, dated, related,
translated and cited exactly like an object, because it *is* a record.

So a place in your toponymic thesaurus is not the string "Vall de Cabó"
repeated across nine hundred records. It is one record, with its own
description, its own variants and its own history, that nine hundred records
point at.

> More: [Thesaurus and hierarchies](../core/thesaurus/index.md) ·
> [Hierarchy tools](../using/tools/using_hierarchy.md)

---

## Links, not copies

When a record refers to another record, Dédalo stores a **pointer**, never a
copy of its name. The consequences are the ones every documentalist wants:

- **Correct once.** Fix a name, a date, a spelling in the term record, and
  every record that refers to it is correct — immediately, everywhere.
- **Ask backwards.** Because the link is real, you can ask *which testimonies
  mention this person?* or *what came from this excavation?* without having
  planned that question in advance.
- **No silent divergence.** Two records cannot end up holding two slightly
  different spellings of the same place, because they hold no spelling at all.

This is the single largest difference between a catalogue and a spreadsheet,
and it is what makes a heritage collection still usable after twenty years.

> More: [Locator — the pointer between records](../core/locator.md)

---

## Many languages, two different kinds

Two things get translated in a heritage system, and confusing them causes
trouble.

- **The data** — a title, a description, an abstract can exist in as many
  languages as your institution works in, each stored separately on the same
  record. Some values, by contrast, are the same in every language: an
  inventory number, a coordinate, a year.
- **The interface** — the buttons, menus and field labels a cataloguer sees.

A researcher can read the catalogue in one language while the data itself is
served in another, and a translation workflow can run over the data plane
without ever touching the program.

> More: [Internationalization](../development/internationalization.md) ·
> [Language tools](../using/tools/using_lang.md)

---

## Nothing is silently lost

Every change to a record is kept: what it was, who changed it, and when. You
can read the history of a record and restore an earlier state.

For a scientific catalogue this is not a comfort feature. It is what makes an
attribution defensible, a correction traceable and a disputed record
reconstructible — and what lets you hand a collection to a colleague without
losing the reasoning that produced it.

> More: [Time machine](../using/tools/using_time_machine.md)

---

## Who may see what

Access is not "editor or reader". Permission is expressed per section and per
field, at three levels: none, read, read-and-write. So a volunteer can catalogue
the physical description of an object while never seeing the donor's name; an
external researcher can read a collection they may not touch; a project can be
visible to one team and invisible to the rest of the institution.

The same permissions govern every route into the data — the staff application,
the public service and any AI assistant. See
[Three doors into the same collection](the_three_doors.md).

> More: [Users, profiles and permissions](../administration/users_and_permissions.md)

---

## Files are handled like heritage, not like attachments

An uploaded photograph, recording or video becomes a **master** that is never
altered, plus the derivatives and thumbnails the interface needs. Recordings can
be transcribed and indexed so that a passage — with its timecode — becomes a
citable unit; long texts can carry page references.

Large files are served directly by the web server rather than carried through
the program, which is why a multi-gigabyte video is an ordinary case.

> More: [Media pipeline](../development/media_pipeline.md) ·
> [Transcription](../using/tools/using_transcription.md)

---

## Publishing is a decision, and it is reversible

Dédalo does not have a "public" switch for the institution. It has a decision
per record, and a publication step that copies the marked records outwards into
a separate database and into files. Un-marking a record removes it on the next
run.

That is what lets an institution catalogue frankly — with the donor's
conditions, the internal notes and the unresolved attributions — and still
publish confidently.

> More: [The journey of one record](journey_of_a_record.md) ·
> [Diffusion data flow](../diffusion/diffusion_data_flow.md)

---

## Measuring what you produce

Dédalo carries a data-quality score, **Raspa**, that rates a catalogue from 0
to 10 across progressive levels: structured, ontologically modelled,
traceable, translatable, openly processable. It is a way to argue about
quality with evidence rather than impressions — useful in a funding
application, and useful internally when deciding what to improve next.

> More: [The Raspa Data Quality Score](raspa_score.md)

---

## A short translation table

The manual and your developers will use these words. Here is what they mean in
yours.

| They say | You would say |
| --- | --- |
| **section** | a kind of record — a series, a register, a table |
| **record** | one catalogued item, in one section |
| **component** | a field on the form |
| **ontology** | the definition of your catalogue: which record types and fields exist, and how they behave |
| **tipo** | the internal identifier of one piece of that definition |
| **locator** | a pointer from one record to another |
| **relation** | a link between two records, one-way or mutual |
| **thesaurus / hierarchy** | a controlled vocabulary, as a tree of terms |
| **descriptor** | the preferred term of a concept (as against a non-preferred variant) |
| **diffusion** | publishing: producing the public copy |
| **matrix** | the database table where all records are stored |
| **time machine** | the history of a record, and the ability to restore it |
| **API** | a door another program may knock on |
| **RAG / semantic search** | finding records by meaning rather than by exact words |
| **MCP** | the agreed way an AI assistant may use Dédalo |

> The full definitions, with their technical detail, are in the
> [Glossary](glossary.md).

---

## Where to go next

- **[Dédalo in plain language](index.md)** — back to the four pictures.
- **[Introduction and core hub](../core/index.md)** — the technical manual's
  starting point, if you want to keep reading.
- **[Tools user guide](../using/tools/index.md)** — what your team will actually
  click on, tool by tool.
- **[The v7 rewrite](../rewrite.md)** — why the engine was rebuilt, written for
  developers and humanities readers alike.
