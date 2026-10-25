---
title: The acquisition tools show why a preview or an import failed, instead of "Done."
type: fixed
audience: user
date: 2026-10-21
---
In the auction-catalogue and journal acquisition tools, a preview or an import that
failed on the server was reported as "Done.", and the panel then stopped responding
for that run. Pasting a URL the tool does not support, a page that could not be
read, or an import the server refused all looked like a success.

The panel now shows the reason, in your language, with the server's own sentence
when it says more — for example *Only OAI-PMH journal/repository URLs are supported
right now.* If your session expired while the job was running, the login window
opens. A job you stopped is no longer reported as done either: the panel says it
ended without a result.

The per-record lines of an import summary state their failures the same way.

In the maintenance move panels (move TLD, language, locators, to portal, to table),
when two previews of the same files run at once, only the latest one can now reveal
the Execute button. Before, an older clean preview could reveal it after your newer
preview had failed.
