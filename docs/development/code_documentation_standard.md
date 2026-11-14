# Code documentation standard

This document defines how to write doc-comments and inline comments in Dédalo's **own**
TypeScript server code (`src/`, `tools/*/server/`, `diffusion/api/v1/`) and the
JavaScript client (`client/dedalo/`). It codifies the house style that already exists in the
best-documented files so that documentation is **uniform, accurate, and useful to developers**.

> Scope: Dédalo source only. Do **not** apply this to third-party libraries — neither the
> installed dependencies under `node_modules/` nor the committed ones under `vendor/`.

## Guiding principles

1. **Explain *why*, not just *what*.** The signature already says *what*. A good doc-block adds
   intent, contracts, edge cases, and the consequences of getting it wrong.
2. **Documentation must match the code.** Every `@param`/`@return`/`@var` type must mirror the
   real signature. A stale or wrong doc-block is worse than none.
3. **Doc-only edits.** Improving documentation never changes behavior. You only add or rewrite
   comments and doc-blocks — never code tokens, never reordering, never "while I'm here" fixes.
4. **Signal over noise.** Comment the non-obvious. Do not narrate self-evident lines.
5. **English only.** Replace any stray Spanish comments with clear English. (Identifiers and
   ontology terms stay as they are — only comments are translated.)
6. **Never delete code.** If you find dead/commented-out code, leave it and flag it in the
   round report. Removal is a separate, explicit decision.

---

## TypeScript

The strict compiler (`tsconfig.json`) already documents *what* a symbol is — the types are in the
signature. A TS doc-comment therefore focuses almost entirely on *why*: intent, contract, edge
cases, and the security/invariant note. Do **not** restate the type in a `@param` tag — the type
annotation is the source of truth, and a `@param` that drifts from it is exactly the stale-doc
failure principle 2 forbids. Formatting is enforced by Biome (`biome.json`); do not hand-format
around it.

### Module header

Every non-trivial module opens with a `/** … */` block:

- One-line summary naming the module and what it is for.
- Blank line, then the *why / responsibilities* — prose and/or bullet lists.
- Where it matters, cite the governing spec section (`spec §4`) and any fault-code the behavior
  defends (`SEC-016`, `AUTH-05`) — these tie the code to the audit register. If the module upholds
  a **tripwired invariant**, say which one, so the next reader knows the gate exists before they
  try to "simplify" the code that satisfies it.

A short, declarative module says what it stores and how it behaves:

```ts
/**
 * component_input_text — short single-line free text. Stores {id,value,lang}
 * items in the `string` matrix column; CLASS-translatable (its data items are
 * lang-filtered on read).
 */
import type { ComponentModel } from '../types.ts';
```

A longer engine module states the invariant it upholds and how it relates to its callers. The
`WHY THIS EXISTS` block is the house convention for a module whose shape is non-obvious:

```ts
/**
 * Request-scoped effective languages (the current interface + data language).
 *
 * WHY THIS EXISTS (spec §4): Bun is a long-lived process, so the "current
 * language" can NOT be a module-level value — that would bleed one user's
 * language choice into every concurrent request. Instead the effective languages
 * live in an AsyncLocalStorage scope opened once per RQO at the dispatch
 * chokepoint (dispatchRqo) from the caller's session. Leaf resolvers read them
 * through the accessors below; outside any scope (unit tests calling resolvers
 * directly, timer/scheduler work) they fall back to the installation defaults. …
 */
```

### Interface / type doc-comment

- Short description of what the shape represents and when it is populated.
- A trailing `// comment` on individual fields for the non-obvious ones — meaning, provenance
  (which matrix column or wire key it maps to), and any gotcha.

```ts
/** Per-request state container. Passed explicitly — never stored globally. */
export interface RequestContext {
    /** Unique id for tracing/log correlation. */
    readonly requestId: string;
    /** Wall-clock start, for latency metrics. */
    readonly startedAt: number;
}
```

### Function doc-comment

- *What & why* prose (one or more lines). State contracts, side effects and fail-closed behavior.
- The parameter and return **types live in the signature** — describe only what the types cannot
  say (units, invariants, "null when the locator cannot be resolved", security gates).
- Note when the function throws and under what condition, in prose.

```ts
/**
 * Route a request. Kept as a plain function (not inline in Bun.serve) so tests
 * can call it directly without a socket.
 */
export async function handleRequest(request: Request, context: RequestContext): Promise<Response> {
```

### Constants

Document non-obvious constants with a one-line comment or a short block explaining the value's
meaning and any security/contract significance (e.g. an `API_ACTIONS` allowlist, a `SESSION_COOKIE`
name, a `KEY_REGEX` grammar, config `DEDALO_*` key mappings).

### `@param`/`@returns` JSDoc tags — sparingly

A handful of TS files use JSDoc `@param {Type}` / `@returns` tags where a public helper benefits
from an IDE hover. This is allowed but **not required**, and when used the braced type must match
the TS signature exactly. Prefer prose-plus-signature over redundant tags.

---

## JavaScript (the client)

Dédalo JS is browser-side ES modules (no framework). Two type-annotation styles existed in the
codebase; **the standard is modern JSDoc with brace types**. Migrate legacy `@param type name`
to `@param {Type} name` as you touch files.

### File header

Preserve and normalize, in this order:

```javascript
// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global SHOW_DEBUG, page_globals */
/*eslint no-undef: "error"*/

// import
	import {event_manager} from '../../common/js/event_manager.js'
	import {data_manager}  from '../../common/js/data_manager.js'
```

- Line 1 is the **mandatory** AGPL license magnet line — never remove it.
- `/*global …*/` lists module-scope globals (only if any are used).
- For files larger than ~200 lines, add a module header doc-block describing the module's purpose
  and main exports:

```javascript
/**
* DATA_MANAGER
* Central client→server request layer: builds API calls, applies retry/timeout,
* and routes responses through the response cache.
*/
```

### Function doc-block

- First line: `FUNCTION_NAME` (UPPERCASE) — the established client convention, kept for grep-ability.
- *What & why* prose.
- `@param {Type} name - description` — **braces** around the type; hyphen before the description.
- `@returns {Type} description` — use `@returns` (not `@return`).
- `@throws {Error} …` when applicable; `@example` for non-obvious call patterns.
- Common brace types: `{Object}`, `{string}`, `{boolean}`, `{number}`, `{Array}`,
  `{Function}`, `{Promise<Object>}`, `{HTMLElement}`, `{Map}`, `{Set}`, `{*}` (any).

```javascript
/**
* IS_FILTER_EMPTY
* Check whether a normalized filter object contains no active query clauses.
* Recurses through nested $and / $or operator groups.
* @param {Object} filter_obj - normalized filter tree ($and/$or → array of clauses)
* @returns {boolean} true when every leaf `q` clause is empty
*/
export const is_filter_empty = function(filter_obj) {
```

### Prototype-assignment modules (`search.js`, `section.js`, `page.js`, …)

- The constructor function gets a minimal header:

```javascript
/**
* SEARCH
* Search instance: builds and runs the SQO for a section's search UI.
*/
export const search = function() { … }
```

- The block of `X.prototype.method = …` assignments gets one section header doc-block, and the
  existing inline group labels (`// lifecycle`, `// render`, …) are kept:

```javascript
/**
* COMMON FUNCTIONS
* Extend instance with shared prototype methods from common / render modules.
*/
// prototypes assign
	// lifecycle
	search.prototype.destroy = common.prototype.destroy
```

- Individual `prototype.x = …` lines are **not** doc-blocked — the documentation lives at the
  source method's definition.

### Object-literal / namespace modules (`ui.js`, `data_manager.js`)

Each method property carries its own function doc-block (same format as above), not just inline
comments.

### ES6 class modules (`event_manager.js`)

Use standard JSDoc on the class and each method (`@param {Type} name - desc`, `@returns`,
`@throws`, `@example`). Keep the narrative description.

---

## Inline comments (TS & JS)

Use the existing **`// label` block** style: a label line introduces a logical block, with the
explanation indented beneath it. Comment the non-obvious — *why* a check exists, what an edge
case protects against — not the obvious.

```ts
// Get only the component data. Remove possible dataframe data.
// (TM rows store main + dataframe merged; dataframe entries are
//  identified positively via dataframeEntryMatches: type marker first,
//  legacy pairing-keys shape as fallback.)
if (isLiteralWithDataframe) {
    …
}
```

- Prefix genuinely critical warnings with `(!)`:

```javascript
// (!) For components, always use common.init() — do not call init() directly.
```

- Same-line trailing comments are fine for short clarifications of a variable's meaning:

```javascript
self.tipo = options.tipo // structure tipo of the component, e.g. 'dd345'
```

---

## Anti-patterns to avoid

- Restating the type a TS annotation already gives (a redundant or, worse, drifted `@param`).
- Copy-pasted doc-comments whose name/params no longer match the symbol.
- Doc-comments attached to commented-out (dead) code.
- Mixed Spanish/English comments.
- Restating the obvious line by line.
- Removing the AGPL header from a client JS file, or changing any code while "documenting".

## Verification checklist (per file)

- [ ] Doc-only: stripping comments from before/after yields byte-identical code.
- [ ] Any `@param`/`@returns` (JS) or optional TS JSDoc tag matches the real signature/type.
- [ ] Client JS keeps brace types, `@returns`, and the AGPL header.
- [ ] `tsc` passes and `bun run lint` (Biome) is clean (TS); JS lints clean.
- [ ] No new dead code, no Spanish comments.
