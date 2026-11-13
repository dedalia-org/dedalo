# `src/tld/` — TLD packages

Code that serves ONE installation's ontology (one TLD) and may therefore name
that TLD's tipos. A PEER of `src/core/` (like `src/external/`, `src/diffusion/`):
dependency direction **tld → core only**; core reaches a package ONLY through
`./registry.ts`. Code ships with every engine and comes only from this repo —
never from an ontology path, an ontology update or a database row (the earlier
engine's include-by-`process.file` is the threat class this layout retires).

```
src/tld/
├── README.md        this file
├── types.ts         TldPackage — what a package exports
├── registry.ts      TLD_PACKAGES (one import line per package) + resolveCalculationFn
└── <tld>/
    ├── index.ts     export const <tld>: TldPackage
    ├── README.md    the institution / process the code serves, every literal and why
    └── calculation.ts … the modules the ontology names
```

## How the ontology reaches a package

A `calculation` widget block declares
`process: { fn, file: "/<tld>/calculation/<module>.ts", engine: "ts" }`.
`resolveCalculationFn` (`registry.ts`) treats `file` as a LOOKUP KEY: the
first segment selects the package, the rest (minus `.ts`) the module, `fn` the
function. `/calculation/formulas.ts` is the generic table
(`src/core/components/component_info/widgets/calculation/functions.ts`).
Anything else — a PHP-era `.php` / `engine:"php"` block, an unknown package,
module or fn, a generic file naming a TLD fn or a TLD file naming a generic
fn — is REFUSED with `ontology.invalid_node`. No alias, never a silent `[]`.

## Laws — all gated by `test/unit/engine_install_tld_tripwire.test.ts`

1. the generic engine (`src/` minus `src/tld/`) names NO install tipo;
2. `src/tld/<tld>/**` names only ITS OWN TLD's tipos (seed TLDs allowed);
3. only `registry.ts` (or the package itself) imports `src/tld/<tld>/…`;
   `src/tld/**` never imports `src/diffusion/`, `src/external/`, `src/ai/`;
   outside `src/tld/`, the registry's only importer is the calculation widget;
4. no package fn shadows a generic fn name;
5. every directory here is registered, and its TLD is a census TLD;
6. `tools/tool_<tld>_*` names only its own TLD.

## Adding a package

One directory `<tld>/` with `index.ts` + `README.md` (+ its modules), one
import line in `registry.ts`. The TLD must exist in `scripts/lib/tld_census.ts`.
Record the ontology the package expects (which `process.file` keys) in its
README; the ontology declaring them is the owner's (master ontology) — never
create nodes here.
