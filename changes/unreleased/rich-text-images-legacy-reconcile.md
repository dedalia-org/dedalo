---
title: Older images in rich text can be made visible on published pages, from Maintenance.
type: added
audience: admin
date: 2026-10-26
wc: WC-2026-10-26-rich-text-image-legacy-reconcile
---
Images inserted into rich text before this update keep their original file name and stay visible to
logged-in users only. **Maintenance → Reconcile status** has two new entries. `rich_text_images`
lists them and, when applied, renames a copy of each after the record that uses it (the original
file is kept, and every change is a normal save with a Time Machine entry; a text that cannot be
saved safely is listed and left alone). Both apply only for root. `web_image_exposure`
lists any image a visitor can open although the published record it is named after does not use
it, and, applied by root, makes it private. The second one checks by itself at every start. See
the upgrading guide for the steps.
