---
title: The propagate tool on a Project filter now offers the same options as the component.
type: fixed
audience: user
date: 2026-10-23
breaking: false
---
Opening *Propagate component data* on a **Project** (filter) component showed the selector empty — no checkbox, so nothing could be propagated. The tool's editable panel is a throwaway copy of the component that is saved once before it renders, and the server's answer to that save carried the component's value but not its option list (the projects you are authorized to use). Only the Project filter family was affected: selects, radio buttons and the rest kept their options.

The server now answers every save of a filter component with the same options its edit view offers — the propagate tool panel, the record edit after a save, and the staged forms all show the project tree as before.
