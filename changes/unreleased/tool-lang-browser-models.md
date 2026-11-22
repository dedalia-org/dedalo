---
title: The Local AI translator offers a choice of pinned models
type: added
audience: admin
date: 2026-11-22
---
The in-browser translator now has a *Model* selector: Qwen 3 4B (the default), TranslateGemma 4B, MADLAD-400 3B, and one small OPUS model per language pair. Each is pinned by its hub revision and file digests, with its licence on record, and is served only from your installation's model store: seed the ones you want with `bun run scripts/fetch_ai_models.ts <model id>` (`--list` shows the catalogue). NLLB-200 is listed but not offered, because its licence allows non-commercial use only; enable it in the tool configuration record only after confirming that your use is non-commercial. The large models need WebGPU and refuse to start without it. These models have not been run by the test suite: check one by hand before offering it to cataloguers, as described in the [tool_lang developer reference](./development/tools/reference/tool_lang.md#the-browser-model-catalogue).
