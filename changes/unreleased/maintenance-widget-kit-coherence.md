---
title: The code update panel tells you about maintenance mode up front and lets you switch it on there.
type: changed
audience: admin
date: 2026-10-28
---
A code update is refused while maintenance mode is off, but the update code panel only said so after you had chosen a version and pressed Update. The panel now shows this at the top, under the readiness verdict, with an **Enable maintenance mode** button. The version window also keeps Update disabled until the refusing check is resolved, and offers the same button. Update data version gets the same button in place of its old message.

The maintenance widgets also look more consistent:

- Folded sections use the same arrow as the rest of the application, on the right.
- Every key/value table in a widget uses the same label column width, so stacked tables line up. On a narrow screen the label sits above its value.
- In update code, the server list, the **Offer** choice and **Check available updates** are grouped under **Source** at the end of the panel. Choosing an option no longer moves the other options: its note appears below them.
- Warnings are now amber instead of a red-orange that was hard to tell from "blocked". An unknown state is a grey pill like the others, so a column of states lines up.
- In a key/value table, the key now lines up with the first line of its value, even when the value runs to several lines.
- In the System Map, a destructive or irreversible tool is marked only by a red dot. Its name and border are no longer red. Hovering the chip still says it is destructive.
