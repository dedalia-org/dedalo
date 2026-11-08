---
title: Records open when a portal's list layout names a field from an uninstalled ontology.
type: fixed
audience: user
date: 2026-10-30
---
A portal's list layout can name fields from optional ontologies (for example `tchi`). On an installation without that ontology, opening the record failed with "The identifier is not a valid ontology tipo". Those fields are now left out of the layout, and the server logs a warning naming each one.
