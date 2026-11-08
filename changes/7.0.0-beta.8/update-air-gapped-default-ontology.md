---
title: A code update on an installation without an ontology server no longer stops in "needs a database restore".
type: fixed
audience: admin
date: 2026-11-01
wc: WC-2026-11-01-update-plan-declared
---
A release that declares no update steps of its own runs the default ones; its ontology step is skipped, and recorded, when the installation has no ontology server configured (`ONTOLOGY_SERVERS=[]`). The master's update list lost that distinction on the way to the installation, so the installation treated the step as required: after the new code started, the ontology step failed and the update ended asking for a database restore. The installation now receives it and skips the step as intended. An update refused for want of a recent, restorable database backup again says which backup did not verify and why, and is reported as a refusal: make a backup (or waive it) and start again. A refused archive (its checksum does not match the one the code server publishes) is also reported as a refusal with its reason, no longer as a bare "code failed". And a healthy update that crosses the data model no longer logs "NOT CONFIRMED — NEEDS A HUMAN … a migration failed" when it starts that step: the log now says the rollback is disarmed until the update confirms.
