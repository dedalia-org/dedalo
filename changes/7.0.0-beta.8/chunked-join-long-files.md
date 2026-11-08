---
title: Uploading a very large file no longer reports an error while the server is still joining it.
type: fixed
audience: user
date: 2026-11-03
breaking: false
---
After all parts of a large file (several GB) had arrived, the server needed minutes to put them back together. The browser stopped waiting after about half a minute and showed an error, although the file was saved in the end; trying again then failed because the parts were already gone. The browser now keeps waiting (up to 30 minutes, or until you cancel), and asking again for a file that is already joined returns it instead of an error. A part that hits a temporary gateway error (502, 503, 504) is now retried too.
