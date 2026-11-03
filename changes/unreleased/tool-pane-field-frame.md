---
title: Tool panes: the editor fills its frame, the toolbar lines up with it, and Lift/Margin keep their mark inside tools.
type: fixed
audience: user
date: 2026-11-03
breaking: false
---
In the three audiovisual process tools the text-area frame was much taller than the area
you could type in: clicking below the last line of the transcript did nothing. The editor
now fills the frame, so the whole orange box is editable at every window width.

The formatting toolbar above the transcript was also 4px off: it started inside the
frame on the left and stuck out past it on the right, which made the pane scroll
sideways by that sliver. It now spans the frame exactly, with the tools tab flush at its
right end. When the translation tool's source pane is active (it has no toolbar of its
own), its header row now runs the full pane width instead of stopping after the name, and
it no longer paints the field's white "legend" strip across that row — that strip spilled
past the frame on both sides and, when the name wrapped, pushed a second line under the
toolbar.
On windows narrower than 1024px the transcription tool's two panes now stack even after
the window was resized down, instead of being crushed side by side.

The **Lift** and **Margin** active-field styles now follow you into a tool, in the reduced
form a pane allows. Lift keeps its elevated card, neutral edge, shadow and the orange dot
on the field's name; Margin keeps its orange bracket. What the styles drop inside a tool is
the part built for a form full of fields: Lift's header band (nothing to make room for —
the formatting toolbar already owns the row) and Margin's side gutters and vertical tool
rail (no gutter exists; the tool's tab stands in for the rail). Before, they moved the
field's name over the tool's own controls, turned the tools tab into a white band above
the field and shrank the editable box by the gutter widths. Records keep both styles
exactly as before.
