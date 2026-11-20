---
title: A damaged server state file now keeps maintenance mode on instead of silently switching it off
type: fixed
audience: admin
date: 2026-11-19
---

Maintenance mode is kept in `ts_state.json`, in the private directory. The file was written in place, so a crash or a power cut at the wrong moment — typically while an update or a restore was switching maintenance mode on — could leave it empty or cut short. The server then read it as "no settings" and started with maintenance mode off: every user could work in the middle of the maintenance window, and nothing was logged.

The file is now replaced in one step, so it always holds either the previous settings or the new ones. If it is found damaged anyway (for instance after editing it by hand), the server treats maintenance mode as on, lets only the superuser in, and says so in the log (`[server_state] … FAILING CLOSED`). Saving the maintenance settings as the superuser writes a good file again. A missing file is still read as the defaults.
