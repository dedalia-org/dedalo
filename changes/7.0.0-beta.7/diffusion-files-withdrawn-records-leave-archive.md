---
title: Unpublishing every record of an RDF, XML or Markdown publication now also removes its combined file and ZIP
type: fixed
audience: user
date: 2026-10-22
---
An RDF, XML or Markdown publication writes one file per record. It also writes a
combined document (RDF and XML only) and a ZIP archive, both built from the records
the run published. If a run published nothing, for example because every record in
it had been unpublished, the run removed the per-record files but kept the combined
document and the ZIP from the previous run. Those files still held the unpublished
records, so anyone could still download them from the public files directory. The
run still reported that it had completed. Now a run that publishes no records
removes the previous combined document and ZIP as well.
