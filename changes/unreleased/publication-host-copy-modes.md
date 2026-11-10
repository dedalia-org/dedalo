---
title: A publication host in copy mode no longer answers "not found" for every published file.
type: fixed
audience: admin
date: 2026-11-10
breaking: true
wc: WC-2026-10-03-publication-hosts-widget
---
On a publication host declared in copy mode, the agent created its folders without the
execute bit for others, so the web server could not reach the publication markers or the
files: every published media file answered "not found", while the **Publication hosts**
panel showed the host as healthy. The agent now sets the permissions it needs itself
(folders `0755`, markers and files `0644`, its own working folder `0700`), whatever the
service's `umask`, and repairs a copy it created earlier each time it starts in copy mode
(in the background, while it already serves; one `media.repair` line in its audit log). A
folder owned by another user is never changed: copying into it is refused with a message
naming the fix. The panel gains the check **Media reachable by the web server**: in copy mode
it turns red when a directory on the way to the published files is closed to the web server;
in shared mode it shows unknown, since the web server may reach the work system's media as
its owner or group.

Action needed: update the agent on every publication host together with the work system,
then restart it (see [publication host](./install/publication_host.md#copy-mode-a-verified-copy-of-the-published-media)).
Until a host runs the updated agent, the panel cannot read its status.
