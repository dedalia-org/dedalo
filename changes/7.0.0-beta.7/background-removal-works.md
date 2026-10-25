---
title: Remove background works again in the image rotation tool.
type: fixed
audience: user
date: 2026-10-22
breaking: false
---
**Remove background** failed every time, with a bare `Worker error` in the panel and
nothing else. Three faults sat behind it, all client-side: the worker was requested
at a path one directory above the application root, so the browser never loaded it;
the model it asked for (`briaai/RMBG-1.4`) is not loadable by the bundled
Transformers.js runtime; and the model's output shape had changed under it, so even
a successful run would have thrown instead of returning the cut-out.

It now measures the subject with `onnx-community/ISNet-ONNX`, the same DIS/IS-Net
family as before, and any failure reports its actual reason (missing model file, no
WebGPU, worker error) instead of a blank banner. A failed run no longer claims
"Background removal completed" and no longer leaves the button disabled.

**Administrators:** the weights come from the install's own model store — never a
CDN — so a store seeded before today has to add
`onnx-community/ISNet-ONNX` (176 MB fp32: `config.json`,
`preprocessor_config.json`, `onnx/model.onnx`) to `<private>/ai_models/`. Until it
is there the tool says so plainly instead of hanging.
