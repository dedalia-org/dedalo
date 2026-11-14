# Where everything lives

> Part of [Dédalo in plain language](index.md) · Next:
> [The journey of one record](journey_of_a_record.md)

Dédalo runs in **two separate places**, and only one of them faces the
internet. Almost every question about safety, hosting and cost has its answer
in that one sentence.

[![Three zones: inside your institution the team, the Dédalo server and the catalogue; on the web server the published copy, the public API and the exported files; and the world, with your website, visitors and AI assistants. Data crosses from left to right only.](../assets/images/diagrams/simple_1_infrastructure.svg)](../assets/images/diagrams/simple_1_infrastructure.svg)

*Click the diagram to open it full size.*

## Reading the picture

**On the left, inside your institution.** Your team — each person with their
own account — works against one program on one computer, on your own network.
Behind it sits the catalogue: every record, every image, every version. This is
the original, and the only original there is. Nothing here is reachable from
the internet.

**In the middle, on the web server.** A *copy* of the records you decided to
make public, plus the service that hands that copy out. The same data can also
be written as files — CSV, XML, RDF, Markdown — for a partner, a national
aggregator or a repository.

**On the right, the world.** Your website, the visitors and researchers you
opened the collection to, and — only if you switch it on — AI assistants.

## Why this shape

!!! note "One direction only"
    Data flows outwards. There is no route from the website back into your
    catalogue, because the public service has no way to write anything, to any
    database, ever. A visitor is not looking through a window into your
    archive; they are reading a copy.

**The two halves can live on different machines.** The public half is normally
installed next to your website, on the web server; the working half stays
inside the institution. They share nothing but the published copy — no
password, no connection, no code.

**So an incident on one side is not an incident on the other.** If the public
site is attacked, overloaded or simply switched off, cataloguing continues
untouched. If the institution's network is down, the website keeps serving.

**And nothing is public by accident.** Publication is a decision taken record
by record, and it can be undone — the next publication run removes what you
un-marked.

## Common questions

**Can we run everything on one machine?** Yes — a small institution often
does, and the separation still holds, because it is a separation of *roles*,
not only of hardware. Two machines is the recommendation once the site has real
traffic or the collection holds material that must not leave the building.

**Do we need to be online to catalogue?** No. The working half needs your own
network, not the internet.

**Where do the big files go?** Masters, derivatives and thumbnails live beside
the catalogue and are served directly by the web server, not carried through
the program — which is why a 32 GB video is not a problem. See the
[media pipeline](../development/media_pipeline.md).

## Where to read more

- **[Architecture overview](../core/architecture_overview.md)** — the same
  picture with the technical names attached.
- **[Installation](../install/index.md)** — sizing, prerequisites and the
  three installation paths.
- **[Diffusion](../diffusion/index.md)** — how the published copy is produced.
- **[Backup](../administration/backup.md)** — protecting the original.
