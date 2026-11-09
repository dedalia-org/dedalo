---
title: A portal's "Link resource" picker now saves every pick, and unlinks too.
type: fixed
audience: user
date: 2026-11-09
---
Before, picking records in the "Link resource" list sometimes did not save: the list showed the record as linked, but the portal refused it as already present, and quick successive picks were reported as failed. Clicking a linked record to remove it never removed it. The list now opens inside the page instead of an embedded frame, picks are applied one at a time, and each row shows what is actually stored.
