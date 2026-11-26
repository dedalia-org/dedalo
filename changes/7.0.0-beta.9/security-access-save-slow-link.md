---
title: Saving a profile's access permissions no longer reports an error on slow connections when the save went through.
type: fixed
audience: user
date: 2026-11-09
wc: WC-2026-11-09-security-access-save-echo-no-datalist
---
Saving a profile's permissions used to upload the whole ontology tree shown in the editor (about 6.5 MB) with every save. On a slow connection the upload outlasted the client's wait, so the screen showed a save error and kept the changes marked as unsaved, even though the server had stored them (a reload showed them). The save now sends only the permissions. Large saves also get more time to upload before the client gives up. The server's reply to the save no longer sends the tree back either, so a retried save is recognised instead of being reported as failed.
