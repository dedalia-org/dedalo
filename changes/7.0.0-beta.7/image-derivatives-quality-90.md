---
title: Image derivatives are encoded at full quality again — sharper web and list images, and somewhat larger files
type: fixed
audience: user
date: 2026-10-23
---
Every generated image size (`1.5MB`, `6MB`, `thumb`, the alternative-format
twins) was compressed at quality 82, a value inherited from the first version of
this engine. The previous engine encoded images at **90**, and inspection of the
same picture side by side shows the difference plainly: the web size looked
softer and smoothed-over, most visibly on fine texture and lettering.

Derived images are now encoded at 90 again, matching the previous engine. Expect
the `1.5MB` and other jpg sizes to grow by roughly 40–75 % for the same pixel
dimensions (on the reference record, 55,988 → 97,453 bytes); thumbnails grow
much less. The `original` quality's viewable copy was already written at 100 and
is unchanged.

Nothing is rebuilt automatically: existing records keep their current files until
a master is uploaded again or the record is regenerated from the media versions
tool (**Regenerate files** after deleting the size you want rebuilt).
