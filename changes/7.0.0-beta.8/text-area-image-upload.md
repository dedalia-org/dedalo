---
title: Uploading an image from the text editor toolbar works again.
type: fixed
audience: user
date: 2026-10-26
---
The "Upload image from computer" button of a rich-text field failed with `upload: missing file_to_upload`. The image is now stored in the image web folder (`DEDALO_IMAGE_WEB_FOLDER`) and inserted into the text. Only JPG, PNG, GIF, WebP and AVIF images can be inserted. An image with the same name as an earlier one gets a new name instead of replacing it, so other texts that show the earlier image keep it. A resized image now opens at its resized size, without first appearing at full size while the editor loads.
