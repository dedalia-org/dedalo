/**
 * HOW A DECISION IS ASKED (spec §1.2 TTY, §4.1) — the ONE place that classifies a decision; the
 * terminal (tty.ts), the scripted prompter and the orchestrator (run.ts askDecisions) all read it,
 * so the rule cannot drift between them. Owner-approved 2026-11 (P2: "make the guided install's
 * decisions easy"); before it, every decision had to be typed, even one whose only answer was
 * `manual` — the operator typed "manual" when there was nothing to choose.
 *
 * Four kinds, decided in this order:
 *   1. `needs_action` — every option resolves `manual`: init can do nothing about it. NOT prompted;
 *      run.ts answers it with its manual option and lists it under "needs your action" with its
 *      facts, its commands and the re-run command.
 *   2. `typed` — an option carries `confirm: 'typed'` (it edits an operator file, replaces a pairing,
 *      removes something, sets an SELinux boolean or a mount option): the operator TYPES an option;
 *      Enter takes nothing. The mark is the PRODUCER's (compare.ts, pair.ts), never a label read here.
 *   3. `auto` — exactly ONE option, and it is not `manual` (kind 1) nor typed (kind 2): there is
 *      nothing to choose, so run.ts resolves it and reports "auto: the only option".
 *      A decision with one acting option PLUS `manual` (or `skip`) is NOT `auto`: `manual` is a
 *      real alternative the operator may want (kind 4).
 *   4. `choose` — everything else: Enter takes the shown default (`enter`); without a default,
 *      Enter takes nothing and an option must be typed.
 *
 * Interactive runs only. `--yes` never consults this module: it resolves no decision (spec §1.2),
 * so neither `needs_action` nor `auto` is applied without a terminal. `--decide <id>=<option>`
 * answers any decision before it is classified.
 *
 * PURE, ZERO-DEPENDENCY (tests/provision_zero_dep.test.ts): ./types only.
 */
import type { InitAction, InitActionKind, Item, ItemOption } from './types';

export type DecisionKind = 'needs_action' | 'typed' | 'auto' | 'choose';

export interface DecisionPrompt {
  readonly kind: DecisionKind;
  /**
   * The option id an empty answer (Enter) takes: `choose` with a default → the default;
   * `needs_action` → its manual option; `auto` → the only option; `typed` → null (never).
   * run.ts applies `needs_action`/`auto` without asking, so for them `enter` is the answer itself.
   */
  readonly enter: string | null;
}

/** True when the option is answered only by typing it (the producer's mark). */
export function isTypedOption(option: ItemOption): boolean {
  return option.confirm === 'typed';
}

/** The one classification (the module header states the rule). */
export function classifyDecision(item: Pick<Item, 'options' | 'defaultOption'>): DecisionPrompt {
  const options = item.options ?? [];
  if (options.length === 0) return { kind: 'choose', enter: null };
  if (options.every(option => option.resolves === 'manual')) {
    // The answer is manual whichever option is taken; the shown default when it names one of them.
    const manual = options.find(option => option.id === item.defaultOption) ?? (options[0] as ItemOption);
    return { kind: 'needs_action', enter: manual.id };
  }
  if (options.some(isTypedOption)) return { kind: 'typed', enter: null };
  if (options.length === 1) return { kind: 'auto', enter: (options[0] as ItemOption).id };
  const shown = item.defaultOption !== undefined && options.some(option => option.id === item.defaultOption) ? item.defaultOption : null;
  return { kind: 'choose', enter: shown };
}

/* ── the producers' marks, gated ──────────────────────────────────────────────────── */

/**
 * The action kinds whose option must be typed: an operator file edited (a vhost, its hand-written
 * lines, a hand-placed nginx map), an SELinux boolean set, a pairing package removed.
 */
export const TYPED_ACTION_KINDS: readonly InitActionKind[] = Object.freeze([
  'vhost_reference',
  'vhost_manual_removal',
  'nginx_map_seed',
  'sebool',
  'pair_package_remove',
] as const satisfies readonly InitActionKind[]);

/** An item as compare emits it: the per-option actions ride beside the default one (compare.ts ComparedItem). */
type MarkedItem = Item & { readonly optionActions?: Readonly<Record<string, InitAction>> };

/**
 * The marks a producer forgot (empty = in agreement), for the gates: an ACTING option (`act` or
 * `replace`) must carry `confirm: 'typed'` when its action is one of TYPED_ACTION_KINDS, when the
 * item edits an operator file or is host-wide (compare's --yes law: never a plain change), or when
 * it replaces the pairing (`pair.engine` replace). A `manual`/`skip`/`relocate` option does
 * nothing on the host, so it needs no mark (a producer may still set one: the media mount option).
 */
export function typedMarkProblems(item: MarkedItem): string[] {
  const problems: string[] = [];
  for (const option of item.options ?? []) {
    if (option.resolves !== 'act' && option.resolves !== 'replace') continue;
    const action = item.optionActions?.[option.id] ?? item.action;
    const reasons = [
      action !== undefined && TYPED_ACTION_KINDS.includes(action.kind) ? `its action is ${action.kind}` : null,
      item.operatorFile ? 'the item edits an operator file' : null,
      item.hostWide ? 'the item is host-wide' : null,
      item.id === 'pair.engine' && option.resolves === 'replace' ? 'it replaces the pairing' : null,
    ].filter((reason): reason is string => reason !== null);
    if (reasons.length > 0 && !isTypedOption(option)) problems.push(`${item.id}=${option.id} is not marked confirm: 'typed' (${reasons.join('; ')})`);
  }
  return problems;
}
