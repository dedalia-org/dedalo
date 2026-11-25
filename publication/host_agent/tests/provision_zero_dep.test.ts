/**
 * The zero-dependency law (Global Constraints): root-repo tests import the provisioner's
 * layout, hash, plan and renderers, so those modules may import only `node:` builtins, each
 * other, and src/instance/roots.ts — whose own imports must stay builtins plus type-only
 * (erased at runtime). Never zod, never schema.ts/apply.ts/cli.ts/exec.ts, never a package — except
 * the named TYPE-ONLY exemptions below (erased at runtime, each with its reason).
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');
const PROVISION = join(SRC, 'provision');
const ZERO_DEP = [
  'layout.ts',
  'hash.ts',
  'plan.ts',
  // The kernel's access check, judged on observed facts (plan.ts accessRefusals).
  'access.ts',
  // Several instances on one host: judged on derived layouts only (the CLI parses).
  'siblings.ts',
  // Task 9: render/engine_fragment.ts computes the pairing fact with the agent's import-free recipe.
  '../security/pairing.ts',
  // Task 9: the mTLS issuer (node:crypto + ./layout) — a root drill may import it without node_modules.
  'tls.ts',
  // Step 3: the sealed pairing package (node:crypto only) — the engine's pairing script imports it.
  'pairing_package.ts',
  // provision init (spec §2.1, §9): the spawn contracts, the lock policy (its I/O is the injected
  // LockIo; flock.ts is NOT zero-dep — it loads libc), and init's pure modules.
  'exec_contract.ts',
  'lock.ts',
  'init/constants.ts',
  'init/types.ts',
  'init/args.ts',
  // The S9 label table, the web-reference proof and the host map renderer's install decision.
  'selinux.ts',
  // The provisioner's SELinux policy module (spec §9.8): its CIL source and identity guard.
  'selinux_module.ts',
  'web_reference.ts',
  'host_map_renderer.ts',
  // Retired artifacts (the provision record and its guards): plan.ts imports it.
  'retire.ts',
  // The fapolicyd trust set (owner decision 2026-10-09): plan.ts renders the trust file with it.
  'fapolicyd_trust.ts',
  // The host-wide nginx map grammar and merge (spec §13.3): root's renderer copy loads them bare.
  '../rules/directives.ts',
  '../rules/host_map.ts',
  // init's pure modules (spec §2.1): discovery parsers, draft/compare/diff, the journal line
  // format, the API-config renderers, the Bun asset checks, the pairing plan, the vhost edits,
  // and the report.
  ...readdirSync(join(PROVISION, 'init', 'parse'))
    .filter(name => name.endsWith('.ts'))
    .map(name => `init/parse/${name}`),
  'init/draft.ts',
  'init/compare.ts',
  'init/diff.ts',
  'init/journal_format.ts',
  'init/api_config.ts',
  'init/bun_asset.ts',
  'init/pair.ts',
  'init/web_edit.ts',
  'init/report.ts',
  // How a decision is asked (P2): report.ts and tty.ts read it.
  'init/decision_class.ts',
  ...readdirSync(join(PROVISION, 'render'))
    .filter(name => name.endsWith('.ts'))
    .map(name => `render/${name}`),
];
/**
 * The modules outside provision/ a zero-dep module may import (src-relative), each import-free
 * or builtin-only (their own gates below): instance/roots.ts, and audit_actions.ts — the audit
 * action origin map init/pair.ts derives its non-engine set from (T0-6; audit.ts loads config).
 */
const ALLOWED_OUTSIDE = ['instance/roots.ts', 'audit_actions.ts'];
/**
 * NAMED EXEMPTIONS: a TYPE-ONLY import (erased at runtime) of a non-zero-dep module, file by file,
 * each with its reason. Nothing else is exempt: a value import, or a type import not listed here, is red.
 */
const TYPE_ONLY_EXEMPT: Readonly<Record<string, readonly string[]>> = {
  // InitIo extends ProvisionIo (spec §2.2): the provisioner's io contract lives in apply.ts.
  'init/types.ts': ['../apply'],
};
/** The one exemption rule, used by the gate and by its own test. */
function typeOnlyExempt(file: string, clause: string, specifier: string): boolean {
  return /^\s*type\b/.test(clause) && (TYPE_ONLY_EXEMPT[file] ?? []).includes(specifier);
}
const IMPORT = /^\s*(?:import|export)\b([^'"]*?)from\s+['"]([^'"]+)['"]/gm;

test('layout, hash, plan, render/* and security/pairing import only node: builtins, each other and instance/roots', () => {
  const offenders: string[] = [];
  for (const file of ZERO_DEP) {
    const source = readFileSync(join(PROVISION, file), 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[2] ?? '';
      if (specifier.startsWith('node:')) continue;
      if (typeOnlyExempt(file, match[1] ?? '', specifier)) continue;
      if (specifier.startsWith('.')) {
        const target = `${relative(SRC, resolve(dirname(join(PROVISION, file)), specifier))}.ts`;
        if (ZERO_DEP.map(f => relative(SRC, join(PROVISION, f))).includes(target) || ALLOWED_OUTSIDE.includes(target)) continue;
      }
      offenders.push(`${file} → ${specifier}`);
    }
  }
  expect(offenders).toEqual([]);
  expect(ZERO_DEP).toContain('render/types.ts');
  expect(ZERO_DEP).toContain('access.ts');
  expect(ZERO_DEP).toContain('render/env.ts');
  expect(ZERO_DEP).toContain('render/engine_fragment.ts');
  expect(ZERO_DEP).toContain('lock.ts');
  expect(ZERO_DEP).not.toContain('flock.ts');
});

test('the type-only exemption is exact: a value import of the same module is still red', () => {
  const offending = "import { hostIo } from '../apply';";
  const allowed = "import type { ProvisionIo } from '../apply';";
  const verdict = (line: string) =>
    [...line.matchAll(IMPORT)].every(match => typeOnlyExempt('init/types.ts', match[1] ?? '', match[2] ?? ''));
  // Another file may not use init/types.ts's exemption.
  expect(typeOnlyExempt('init/args.ts', ' type { ProvisionIo } ', '../apply')).toBe(false);
  expect(verdict(allowed)).toBe(true);
  expect(verdict(offending)).toBe(false);
  // Anti-vacuity: init/types.ts really carries the exempt import.
  expect(readFileSync(join(PROVISION, 'init', 'types.ts'), 'utf8')).toContain("import type { ProvisionIo } from '../apply';");
});

test('instance/roots.ts imports only node: builtins and type-only modules', () => {
  const source = readFileSync(join(SRC, 'instance', 'roots.ts'), 'utf8');
  const offenders: string[] = [];
  for (const match of source.matchAll(IMPORT)) {
    const clause = match[1] ?? '';
    const specifier = match[2] ?? '';
    if (specifier.startsWith('node:')) continue;
    if (/^\s*type\b/.test(clause)) continue;
    offenders.push(specifier);
  }
  expect(offenders).toEqual([]);
  expect(source).toContain("from '../config'"); // anti-vacuity: the one type-only import is seen
});

test('audit_actions.ts imports nothing at all (a leaf the root-run init may load)', () => {
  const source = readFileSync(join(SRC, 'audit_actions.ts'), 'utf8');
  expect([...source.matchAll(IMPORT)].map(match => match[2])).toEqual([]);
  expect(source).toContain('AUDIT_ACTION_ORIGIN');
});
