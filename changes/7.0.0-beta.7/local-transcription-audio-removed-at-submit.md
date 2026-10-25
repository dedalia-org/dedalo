---
title: The temporary audio copy made for on-premise transcription is deleted as soon as it has been sent.
type: fixed
audience: admin
date: 2026-10-21
---
Automatic transcription with the institution's own recognition server makes a temporary
speech-quality copy of the interview and sends its bytes to that server. The copy used to
be deleted only when the background check of the transcription finished, so it stayed on
disk when the submission failed, when the check never ran (the job was stopped while
waiting, or the server restarted) or when the check could not be scheduled. It is now
deleted the moment the submission ends, whatever its outcome.
