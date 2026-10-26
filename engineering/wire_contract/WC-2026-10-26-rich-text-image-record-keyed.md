# WC-2026-10-26-rich-text-image-record-keyed — rich-text images are named after their record, and public while it is published

- **Date:** 2026-10-26 (TODO-066).
- **Decision:** DEC-12 (gated: `test/unit/media_upload_endpoint.test.ts` rich-text describe,
  `test/unit/media_protection_tripwire.test.ts` `image/web` rows).
- **Shape before (PHP, and TS until now):** the editor upload (`?resource_type=web&key_dir=web`)
  stored `image/<DEDALO_IMAGE_WEB_FOLDER>/<original name>` (`pic.jpg`). No record in the name, not
  a public quality: anonymous visitors of a published page got 404 for every rich-text image.
- **Shape after (TS):** the upload query also carries `section_tipo`, `section_id` and
  `component_tipo` (the text's record); the endpoint authorizes them through the write door
  (write level 2, section floor 1) before staging and requires that component to BE a
  `component_text_area` (any other writable component, or none — the door then judges the bare
  section — would let a user key an image to a record whose text they cannot edit); a refusal
  carries its own typed code (`request.invalid` / `perm.*`). Section floor 1 is a deliberate
  tightening vs the save door's floor 0 (`SECTION_FLOOR_ZERO_DOORS` is shrink-only): a user who
  edits a portal-target text inline WITHOUT a grant on its section can save the text but not
  insert an image into it. The stored name is `<stem>[-n]_<section_tipo>_<section_id>.<ext>`
  (MEDIA_FILENAME_GRAMMAR) and `image/<DEDALO_IMAGE_WEB_FOLDER>` joins the default public
  qualities, so rule B serves it anonymously exactly while that record is published, and
  `media_copy` ships it to a copy-mode publication host. The answer stays a bare `{ url }`.
- **Reason:** one definition of "public" (rule B) instead of a second marker class.
- **Limits:** legacy unkeyed names stay login-only (a rename + `src` rewrite migration is
  TODO-069); an image pasted into another record follows the record it was uploaded from. Like
  any component media file, a keyed image is public from the moment it is uploaded into an
  ALREADY-published record (before the text embedding it is saved or republished), and stays
  public after it is removed from the text, for as long as the record stays published.
- **Ops:** the qualities list is folded into the rule-file config hash, so the rules are rewritten
  on the next login — nginx still needs a RELOAD to apply them (Apache's `.htaccess` does not).
  An install that sets `DEDALO_MEDIA_PUBLIC_QUALITIES` explicitly does NOT get `image/web` and
  must add it.
- **Gate reconciliation:** no parity fixture holds a rich-text upload (no re-harvest needed).
