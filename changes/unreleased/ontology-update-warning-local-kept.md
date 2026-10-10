---
title: The update-ontology warning no longer claims your local ontology will be deleted.
type: fixed
audience: admin
date: 2026-10-10
wc: WC-2026-10-10-update-ontology-confirm-text
---
The **Update ontology** panel and its confirmation dialog warned that the update would "delete the actual ontology" and that "you will lose all changes made to the local Ontology". That is not what the process does: it replaces the ontology of the TLDs you select (the common/shared ontologies) with the master's version and re-processes them. Your local ontology — custom TLDs and `localontology` overrides — is a different namespace and is kept, re-applied automatically when the updated nodes are processed. The panel note, the lead text, the submit label and the confirmation dialog now say so, in every interface language (the confirmation dialog was previously an untranslated English string; it is now a translated label). The only way the local ontology is replaced is if you explicitly add `localontology` to the list of ontologies to update — keep it out.
