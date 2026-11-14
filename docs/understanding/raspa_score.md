# The Raspa Data Quality Score

> See also: [Introduction](../core/index.md) · [Glossary](glossary.md)

A cumulative scale for cultural heritage data assessment. To ensure the effective documentation, processing, and long-term preservation of cultural heritage information, the **Dédalo project** proposes the **Raspa Data Quality Score** — a cumulative metric that evaluates data across ten progressive levels of computational readiness, semantic richness, and ethical transparency. This scale reflects the project's commitment to structured, interoperable, and ethically managed data built entirely on **Free and Open Source Software (FOSS)**.

The Raspa Data Quality Score has two dimensions: a **technical dimension** and a **community and social dimension**.

## Technical dimension

The Raspa score begins at **Level 0**, assigned to **unstructured data** such as books, Word documents, and PDFs. While these formats may contain valuable knowledge, they remain machine-opaque and unsuitable for computational processing without prior transformation. Their human readability is not sufficient for automated reasoning or integration into structured knowledge systems like Dédalo (Dédalo can handle this data but it is used as media).

At **Level 1**, **structured data formats** such as spreadsheets (CSV, Excel) and relational databases (SQL) become machine-readable and receive 1 Raspa point. However, they exhibit significant limitations: structural rigidity, limited support for semantic relationships, and insufficient compatibility with the conceptual models required in cultural heritage documentation.

**Level 2** introduces **ontologically modeled data**, where information is structured using formal ontologies. These representations enable the explicit definition of entities and relationships, domain-specific modeling, and support for inferencing, critical capabilities for managing complex heritage knowledge.

Advancing to **Level 3**, **computable data** employs standardized computational primitives (e.g., [TC39 Temporal](https://tc39.es/proposal-temporal/docs/cookbook.html) for time representation), eliminating syntactic ambiguities and enabling precise temporal and spatial reasoning.

At **Level 4**, data becomes **traceable**, incorporating robust provenance tracking and version control. These systems record the full history of modifications, including who made each change, when it occurred, and the rationale behind it, ensuring transparency, accountability, and scholarly reproducibility. Traceable data enables users to assess the origin, evolution, and reliability of the information, supporting responsible reuse and long-term stewardship.

**Level 5** assesses the **epistemological flexibility** of the model, awarding points to data structures capable of representing multiple perspectives, evolving knowledge, and supporting non-destructive schema changes. This capacity is particularly relevant for heritage knowledge, which is inherently interpretive and temporally dynamic.

At **Level 6**, **contextualization** becomes paramount. Data is enriched with metadata that articulates certainty levels, establishes source attribution chains, and embeds domain-specific framing—allowing users to assess the reliability and interpretative lens of the information.

## Community and social dimension

**Level 7** recognizes **translatable data**, where linguistic content is decoupled from core data structures. Systems at this level support internationalization and localization, preserving semantic meaning across multiple languages, an essential requirement for global cultural heritage platforms.

**Level 8** concerns **openness**, recognizing data that is made publicly accessible under clear licensing terms (e.g., Creative Commons) and distributed via REST APIs or equivalent open standards. This level ensures that data is not only reusable but also free from proprietary constraints that hinder scholarly and public access.

At **Level 9**, data demonstrates **multi-standard interoperability**. Such datasets maintain compliance with multiple domain standards (e.g., CIDOC CRM, Dublin Core, Nomisma) and support lossless transformation between schemas, ensuring semantic alignment across institutions, disciplines, and technologies.

Finally, **Level 10** is reserved for data that is **processed entirely through Free and Open Source Software**. This level guarantees end-to-end transparency, reproducibility, and ethical integrity by eliminating dependencies on proprietary tools. It reflects the Dédalo project's core philosophy: that cultural heritage data should be freely accessible, verifiably processed, and ethically managed within open infrastructures.

### Extra point

Sustainable data.
Data that is sustainable over time receives an extra Raspa score, reflecting its resilience, long-term accessibility, and preservation-readiness. Sustainable data is not only well-structured and ethically processed, but also designed to withstand technological, organizational, and epistemological change.

Key characteristics of sustainable data include:

- Format durability: Use of open, standardized, and non-obsolete formats (e.g., JSON, XML, TIFF).
- Long-term storage strategy: Integration with digital preservation infrastructures.
- Documentation continuity: Thorough metadata, contextual notes, and technical documentation that support future interpretation and migration.
- Community stewardship and participation: Maintained by active institutions or open communities that ensure updates, backups, and governance.

Sustainable data ensures that cultural heritage remains accessible, intelligible, and reusable not just today, but decades into the future, even as technologies evolve.

## The Raspa score table

### Technical dimension

| Level | Data Quality Tier | Key Characteristics | Technical Requirements | Raspa points |
| --- | ---| --- | ---| :---: |
| 0 | Unstructured Data | Human-readable only (books, PDFs) | No computational structure | |
| 1 | Basic Structured Data | Machine-readable tables (CSV, Excel, SQL) | Relational schemas | ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} |
| 2 | Ontologically Modeled | Formal semantic relationships | Domain ontologies | ![raspa](../core/assets/20250715_175300_paw.svg){width="30"}  ![raspa](../core/assets/20250715_175300_paw.svg){width="30"}  |
| 3 | Computable Data | Native machine processing ([ECMA TC39 temporal dates](https://tc39.es/proposal-temporal/docs/cookbook.html), [geocoordinates as geojson](https://datatracker.ietf.org/doc/html/rfc7946)) | Data type standardization | ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} |
| 4 | Traceable Data | Full provenance tracking | Immutable logs, version control (W3C PROV) | ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} |
| 5 | Reinterpretable Data | Epistemic flexibility for future revisions | Non-destructive schema evolution | ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} |
| 6 | Contextualized Data | Embedded certainty levels and source attribution | Data-frame metadata structures | ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} |

### Community and social dimension

| Level | Data Quality Tier | Key Characteristics | Technical Requirements | Raspa points |
| --- | ---| --- | --- | :---: |
| 7 | Translatable Data | Language-agnostic representation | Internationalization frameworks, Unicode compliance | ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} |
| 8 | Open Data | Standards-compliant public access | Open APIs (REST, GraphQL, etc.), CC licensing | ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} |
| 9 | Multi-Standard Interoperable | Crosswalk capability across schemas | CIDOC CRM, Dublin Core, schema.org, etc. mappings | ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} |
| 10 | Free Software Processed | End-to-end open toolchain | FOSS stack verification | ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} |
| +1 | Sustainable data | Long-term preservation and community involvement | Standardized formats, checksums and backups, network working data | ![raspa](../core/assets/20250715_175300_paw.svg){width="30"} |

You can earn different Raspa points if the quality of your data meets the level, with a maximum of 15.

## Raspa Acronym Definition

**R** – Reliable & Reproducible

**A** – Adaptable & Aligned

**S** – Structured & Sustainable

**P** – Public & Participatory

**A** – Actionable & Archivable

