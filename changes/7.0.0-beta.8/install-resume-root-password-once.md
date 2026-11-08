---
title: Resuming an interrupted Docker install asks for the root password once, not twice.
type: changed
audience: admin
date: 2026-10-27
---
Before: `install.sh --resume` asked for the root password twice, the same as a fresh install.
Now: a resume asks it once, because the install already set the password. A fresh install still asks twice, to catch a typo in a password that is set for the first time. The password rules and the refusals apply in both cases.
