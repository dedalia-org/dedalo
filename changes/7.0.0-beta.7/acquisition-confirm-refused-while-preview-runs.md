---
title: The acquisition tools no longer start an import while a new Preview is loading
type: fixed
audience: user
date: 2026-10-22
---
In the auction-catalogue and journal acquisition tools, clicking **Preview** again
left the previous review on screen, with its **Confirm import** still enabled,
until the new preview arrived. An import started in that moment was then hidden by
the new review, and the new review's **Confirm import** could start a second import
beside the first. The previous review now disappears as soon as you click
**Preview**, and **Confirm import** does nothing while a preview is loading.
