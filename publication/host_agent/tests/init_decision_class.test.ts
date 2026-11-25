/**
 * init/decision_class.ts — the ONE rule for how a decision is asked (P2, owner-approved 2026-11):
 * needs_action (every option manual: never asked), typed (a producer-marked option: Enter takes
 * nothing), auto (exactly one option, not manual, not typed: resolved without asking), choose
 * (Enter takes the shown default). Plus typedMarkProblems, the gate the producers' marks must pass.
 */
import { describe, expect, test } from 'bun:test';
import { classifyDecision, TYPED_ACTION_KINDS, typedMarkProblems } from '../src/provision/init/decision_class';
import type { Item, ItemOption } from '../src/provision/init/types';

const MANUAL: ItemOption = { id: 'manual', label: 'by hand', resolves: 'manual' };
const ACT: ItemOption = { id: 'act', label: 'do it', resolves: 'act' };
const ACT_TYPED: ItemOption = { ...ACT, confirm: 'typed' };
const SKIP: ItemOption = { id: 'skip', label: 'leave it', resolves: 'skip' };

function decision(options: readonly ItemOption[], extra: Partial<Item> = {}): Item {
  return {
    id: 'declaration.layout',
    list: 'decision',
    area: 'declaration',
    title: 't',
    facts: [],
    commands: [],
    options,
    after: [],
    blocking: false,
    optional: false,
    operatorFile: false,
    hostWide: false,
    ...extra,
  };
}

describe('classifyDecision', () => {
  test('needs_action: every option manual (one or several); its answer is the manual option (the default when it names one)', () => {
    expect(classifyDecision(decision([MANUAL], { defaultOption: 'manual' }))).toEqual({ kind: 'needs_action', enter: 'manual' });
    expect(classifyDecision(decision([MANUAL]))).toEqual({ kind: 'needs_action', enter: 'manual' });
    const mount: ItemOption = { id: 'mount', label: 'mount option', resolves: 'manual', confirm: 'typed' };
    // A typed mark on a manual-only decision does not make it askable: init still can do nothing.
    expect(classifyDecision(decision([MANUAL, mount], { defaultOption: 'mount' }))).toEqual({ kind: 'needs_action', enter: 'mount' });
  });

  test('typed: any typed option makes the whole decision typed — Enter takes nothing, even a single option', () => {
    expect(classifyDecision(decision([ACT_TYPED, MANUAL], { defaultOption: 'act' }))).toEqual({ kind: 'typed', enter: null });
    expect(classifyDecision(decision([ACT_TYPED]))).toEqual({ kind: 'typed', enter: null });
    expect(classifyDecision(decision([ACT, { ...SKIP, confirm: 'typed' }], { defaultOption: 'act' })).kind).toBe('typed');
  });

  test('auto: exactly one option, not manual, not typed (any resolution)', () => {
    expect(classifyDecision(decision([ACT]))).toEqual({ kind: 'auto', enter: 'act' });
    expect(classifyDecision(decision([{ id: 'apache', label: 'apache', resolves: 'act' }], { defaultOption: 'apache' }))).toEqual({ kind: 'auto', enter: 'apache' });
    expect(classifyDecision(decision([{ id: 'relocate', label: 'r', resolves: 'relocate' }])).kind).toBe('auto');
  });

  test('choose: one acting option PLUS manual or skip is a real choice, never auto; Enter takes the default, or nothing without one', () => {
    expect(classifyDecision(decision([ACT, MANUAL], { defaultOption: 'act' }))).toEqual({ kind: 'choose', enter: 'act' });
    expect(classifyDecision(decision([MANUAL, SKIP], { defaultOption: 'manual' }))).toEqual({ kind: 'choose', enter: 'manual' });
    expect(classifyDecision(decision([ACT, MANUAL]))).toEqual({ kind: 'choose', enter: null });
    // A default that names no option is not taken.
    expect(classifyDecision(decision([ACT, MANUAL], { defaultOption: 'ghost' }))).toEqual({ kind: 'choose', enter: null });
    expect(classifyDecision(decision([]))).toEqual({ kind: 'choose', enter: null });
  });
});

describe('typedMarkProblems', () => {
  test('an acting option on a typed action kind, an operator file, a host-wide item, or a pairing replace needs the mark', () => {
    const vhost = decision([ACT, MANUAL], { id: 'web.vhost.0123abcd', action: { kind: 'vhost_reference', path: '/v', beforeSha: 'a', server: 'apache', edit: 'reference', line: 1 } });
    expect(typedMarkProblems(vhost)).toEqual(["web.vhost.0123abcd=act is not marked confirm: 'typed' (its action is vhost_reference)"]);
    expect(typedMarkProblems({ ...vhost, options: [ACT_TYPED, MANUAL] })).toEqual([]);
    expect(typedMarkProblems(decision([ACT, MANUAL], { operatorFile: true }))).toHaveLength(1);
    expect(typedMarkProblems(decision([ACT, MANUAL], { hostWide: true }))).toHaveLength(1);
    const boolean = decision([ACT, { id: 'boolean', label: 'b', resolves: 'act' }], {
      optionActions: { boolean: { kind: 'sebool', name: 'httpd_enable_homedirs', value: true, previous: false } },
    } as Partial<Item>);
    expect(typedMarkProblems(boolean)).toEqual(["declaration.layout=boolean is not marked confirm: 'typed' (its action is sebool)"]);
    const replace = decision([{ id: 'replace', label: 'r', resolves: 'replace' }, SKIP, MANUAL], { id: 'pair.engine' });
    expect(typedMarkProblems(replace)).toEqual(["pair.engine=replace is not marked confirm: 'typed' (it replaces the pairing)"]);
  });

  test('manual, skip and relocate options need no mark; an ordinary act option neither', () => {
    expect(typedMarkProblems(decision([MANUAL, SKIP, { id: 'relocate', label: 'r', resolves: 'relocate' }], { hostWide: true, operatorFile: true }))).toEqual([]);
    expect(typedMarkProblems(decision([ACT, MANUAL]))).toEqual([]);
  });

  test('the typed action kinds: the three operator-file edits, the SELinux boolean, the package removal', () => {
    expect([...TYPED_ACTION_KINDS].sort()).toEqual(['nginx_map_seed', 'pair_package_remove', 'sebool', 'vhost_manual_removal', 'vhost_reference']);
  });
});
