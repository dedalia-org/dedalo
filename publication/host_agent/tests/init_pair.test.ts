/**
 * B5 (spec §6) — init/pair.ts: the plan from facts (pure), the exact invocation arrays (through
 * the REAL exec.ts argv builder, observed by a recording spawner — the one spawning file stays
 * the one source of the argv), the classification of the pairing child's exits, and the output
 * law (sanitized, the token never returned). The real child runs in
 * test/unit/publication_host_init_pair_native.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { AUDIT_ACTION_ORIGIN, type AuditAction } from '../src/audit';
import type { SyncSpawner, SyncSpawnOptions } from '../src/exec';
import { initExec } from '../src/exec';
import type { ExecResult, PairInvocation } from '../src/provision/exec_contract';
import {
  ALREADY_REGISTERED,
  detectWorkSystem,
  engineContactSince,
  PACKAGE_KEEP,
  PACKAGE_REMOVE,
  writtenPackageItem,
  PAIR_CHILD_PATH,
  type PairPorts,
  pairEnv,
  pairInvocation,
  pairItem,
  pairOneMachine,
  pairPlan,
  pairPortResult,
  pairPreconditions,
  twoMachineInstructions,
  writePairingPackage,
  TWIN_REGISTERED,
  unitOptionId,
} from '../src/provision/init/pair';
import type { HostFacts, WorkUnit } from '../src/provision/init/types';
import { derive } from '../src/provision/layout';
import { openPairingPackage } from '../src/provision/pairing_package';
import { tlsDeclaration, unixDeclaration } from './fixtures/provision_declaration';

const TOKEN = 'pair-token-not-a-secret-0123456789abcdefghijk';
const UNIX = derive(unixDeclaration()); // engine_group 'dedalo'
const TLS = derive(tlsDeclaration());

function unit(over: Partial<WorkUnit> = {}): WorkUnit {
  return {
    unit: 'dedalo-ts',
    user: 'dedalo',
    group: 'dedalo',
    checkout: '/opt/dedalo/master_dedalo',
    bun: '/opt/dedalo/.bun/bin/bun',
    env: { DEDALO_PRIVATE_DIR: '/opt/dedalo/private', NODE_ENV: 'production', LD_PRELOAD: '/x.so', DEDALO_BAD: 'a\nb' },
    privateDir: '/opt/dedalo/private',
    privateUid: 1001,
    fragmentPending: false,
    ...over,
  };
}

const ACCOUNTS: HostFacts['accounts'] = {
  users: [
    { name: 'dedalo', uid: 1001, gid: 1001, home: '/opt/dedalo', shell: '/usr/sbin/nologin' },
    { name: 'other', uid: 1002, gid: 1002, home: '/home/other', shell: '/bin/sh' },
    { name: 'toor', uid: 0, gid: 0, home: '/root', shell: '/bin/sh' },
  ],
  groups: [
    { name: 'dedalo', gid: 1001, members: [] },
    { name: 'other', gid: 1002, members: [] },
  ],
};

const facts = (work: WorkUnit[]) => ({ work, accounts: ACCOUNTS });
const ARGS = { pairName: 'museum_org', noPair: false };

/* ── detection, env, invocation ───────────────────────────────────────────────────── */

describe('detection and the invocation', () => {
  test('dedalo-ts and dedalo-ts@* only; one, several, none', () => {
    expect(detectWorkSystem([])).toEqual({ kind: 'none' });
    expect(detectWorkSystem([unit({ unit: 'dedalo-tsx' }), unit({ unit: 'apache2' })])).toEqual({ kind: 'none' });
    expect(detectWorkSystem([unit()]).kind).toBe('one');
    expect(detectWorkSystem([unit(), unit({ unit: 'dedalo-ts@museum' })]).kind).toBe('several');
  });

  test('the child env: DEDALO_* of the unit (no newline values) + PATH, HOME, LC_ALL — never NODE_ENV or LD_*', () => {
    expect(pairEnv(unit(), '/opt/dedalo')).toEqual({
      DEDALO_PRIVATE_DIR: '/opt/dedalo/private',
      PATH: PAIR_CHILD_PATH,
      HOME: '/opt/dedalo',
      LC_ALL: 'C',
    });
  });

  test('pairInvocation is token-free and names the agent fragment', () => {
    const inv = pairInvocation(unit(), UNIX, '/opt/dedalo', { name: 'museum_org', verb: 'add', dryRun: true });
    expect(inv).toEqual({
      user: 'dedalo',
      bun: '/opt/dedalo/.bun/bin/bun',
      checkout: '/opt/dedalo/master_dedalo',
      verb: 'add',
      name: 'museum_org',
      fragment: UNIX.engineFragmentPath,
      dryRun: true,
      env: pairEnv(unit(), '/opt/dedalo'),
    });
    expect('token' in inv).toBe(false);
    expect(() => pairInvocation(unit(), UNIX, '/x', { name: 'pairing_x', verb: 'add', dryRun: false })).toThrow('must match');
  });

  test('the exact argv, env, cwd and stdin exec.ts builds from it (recording spawner)', () => {
    const calls: { argv: readonly string[]; options: SyncSpawnOptions }[] = [];
    const spawner: SyncSpawner = { run: (argv, options) => (calls.push({ argv, options }), { code: 0, stdout: '', stderr: '' }) };
    const inv = pairInvocation(unit(), UNIX, '/opt/dedalo', { name: 'museum_org', verb: 'add', dryRun: true });
    initExec(spawner).pairAsEngine({ ...inv, token: TOKEN });
    initExec(spawner).pairAsEngine({ ...inv, verb: 'replace', dryRun: false, token: TOKEN });
    const tail = ['/opt/dedalo/.bun/bin/bun', '--no-install', '/opt/dedalo/master_dedalo/scripts/publication_host_pair.ts'];
    expect(calls[0]?.argv).toEqual(['setsid', '--wait', 'runuser', '-u', 'dedalo', '--', ...tail, 'add', 'museum_org', '--fragment', UNIX.engineFragmentPath, '--token-stdin', '--dry-run']);
    expect(calls[1]?.argv).toEqual(['setsid', '--wait', 'runuser', '-u', 'dedalo', '--', ...tail, 'replace', 'museum_org', '--fragment', UNIX.engineFragmentPath, '--token-stdin']);
    for (const call of calls) {
      expect(call.argv.join(' ')).not.toContain(TOKEN);
      expect(Object.values(call.options.env ?? {}).join(' ')).not.toContain(TOKEN);
      expect(new TextDecoder().decode(call.options.input)).toBe(TOKEN);
      expect(call.options.cwd).toBe('/opt/dedalo/master_dedalo');
      expect(Object.keys(call.options.env ?? {}).sort()).toEqual(['DEDALO_PRIVATE_DIR', 'HOME', 'LC_ALL', 'PATH']);
    }
  });
});

/* ── preconditions and the plan ───────────────────────────────────────────────────── */

describe('preconditions (spec §6 B5 steps 2-3)', () => {
  test('a pairable unit has none', () => {
    expect(pairPreconditions(unit(), UNIX, ACCOUNTS)).toEqual([]);
  });

  test.each([
    ['root unit', { user: 'root' }, 'runs as root'],
    ['no user', { user: '' }, 'no named user'],
    ['unknown user', { user: 'ghost' }, 'not in the user database'],
    ['uid 0 user', { user: 'toor', privateUid: 0 }, 'uid 0'],
    ['private dir of another uid', { privateUid: 1002 }, 'chown -R dedalo /opt/dedalo/private'],
    ['no private dir', { privateUid: null }, 'does not exist'],
    ['no fragment', { fragmentPending: null }, 'does not exist yet'],
    ['pending fragment', { fragmentPending: true }, 'pending fingerprint'],
    ['relative checkout', { checkout: 'opt/x' }, 'WorkingDirectory'],
    ['relative bun', { bun: 'bun' }, 'absolute Bun path'],
  ] as const)('%s', (_label, over, fragment) => {
    const problems = pairPreconditions(unit(over as Partial<WorkUnit>), UNIX, ACCOUNTS);
    expect(problems.join('\n')).toContain(fragment);
  });

  test('engine_group membership: primary gid or a supplementary member; otherwise a problem with the fix', () => {
    const layout = { ...UNIX, identity: { ...UNIX.identity, engineGroup: 'other' } };
    expect(pairPreconditions(unit(), layout, ACCOUNTS).join('\n')).toContain("not in engine_group 'other'");
    const member = { ...ACCOUNTS, groups: [...ACCOUNTS.groups.slice(0, 1), { name: 'other', gid: 1002, members: ['dedalo'] }] };
    expect(pairPreconditions(unit(), layout, member)).toEqual([]);
    const noGroup = { ...UNIX, identity: { ...UNIX.identity, engineGroup: 'absent' } };
    expect(pairPreconditions(unit(), noGroup, ACCOUNTS).join('\n')).toContain("not in engine_group 'absent'");
  });
});

describe('pairPlan → pairItem', () => {
  test('one unit, all preconditions met: a change item carrying the pair action', () => {
    const plan = pairPlan(UNIX, facts([unit()]), ARGS);
    expect(plan.kind).toBe('invoke');
    const item = pairItem(plan, UNIX);
    expect([item.id, item.list, item.action?.kind, item.after]).toEqual(['pair.engine', 'change', 'pair', ['verify.agent']]);
    expect(JSON.stringify(item)).not.toContain(TOKEN);
    expect(item.commands[0]).toContain('--token-stdin');
  });

  test('--no-pair, or no unit on a socket listener: printed instructions, never an action', () => {
    for (const [layout, work, args] of [
      [UNIX, [unit()], { ...ARGS, noPair: true }],
      [TLS, [unit()], { ...ARGS, noPair: true }],
      [UNIX, [], ARGS],
    ] as const) {
      const plan = pairPlan(layout, facts([...work]), args);
      expect(plan.kind).toBe('instructions');
      const item = pairItem(plan, layout);
      expect([item.id, item.list, item.action, item.blocking, item.optional]).toEqual(['pair.instructions', 'decision', undefined, false, true]);
    }
  });

  test('a tls listener (two machines): the sealed package, written under <INIT_BASE>/<instance>, optional, after B4', () => {
    for (const work of [[unit()], []]) {
      const plan = pairPlan(TLS, facts(work), ARGS);
      expect(plan.kind).toBe('package');
      if (plan.kind !== 'package') continue;
      expect(plan.path).toBe(`/var/lib/dedalo_publication_host_init/${TLS.instance}/museum_org.pairing`);
      expect(plan.manual.join('\n')).toContain('--token-file'); // the loose-file path stays (D5)
      const item = pairItem(plan, TLS);
      expect([item.id, item.list, item.blocking, item.optional, item.after]).toEqual(['pair.package', 'change', false, true, ['verify.agent']]);
      expect(item.action).toEqual({ kind: 'pair_package', name: 'museum_org', path: plan.path });
      expect(item.commands.join('\n')).toContain('dedalo:pair-publication-host add museum_org --package <the copy>');
    }
    const elsewhere = pairPlan(TLS, facts([]), ARGS, { initDir: '/scratch/init/x' });
    expect(elsewhere.kind === 'package' ? elsewhere.path : '').toBe('/scratch/init/x/museum_org.pairing');
    expect(pairPlan(UNIX, facts([unit()]), ARGS).kind).toBe('invoke'); // one machine: never a package
  });

  test('several units: blocked until declaration.work_unit (draft.ts) chose one, then the chosen one is planned', () => {
    const work = [unit(), unit({ unit: 'dedalo-ts@museum', checkout: '/home/ded_museum/dedalo' })];
    const plan = pairPlan(UNIX, facts(work), ARGS);
    expect(plan.kind).toBe('blocked');
    expect(plan.kind === 'blocked' ? plan.problems[0] : '').toContain('--decide declaration.work_unit=<dedalo-ts | dedalo-ts_museum>');
    const chosen = pairPlan(UNIX, facts(work), ARGS, { chosenUnit: 'dedalo-ts@museum' });
    expect(chosen.kind === 'invoke' ? chosen.invocation.checkout : '').toBe('/home/ded_museum/dedalo');
    expect(unitOptionId('dedalo-ts@Museum.org')).toBe('dedalo-ts_museum_org');
  });

  test('a replace answer plans verb replace', () => {
    const plan = pairPlan(UNIX, facts([unit()]), ARGS, { replace: true });
    expect(plan.kind === 'invoke' ? plan.invocation.verb : '').toBe('replace');
    const add = pairPlan(UNIX, facts([unit()]), ARGS);
    expect(add.kind === 'invoke' ? add.invocation.verb : '').toBe('add');
  });

  test('a precondition failure is a manual decision naming the fix', () => {
    const plan = pairPlan(UNIX, facts([unit({ fragmentPending: true })]), ARGS);
    expect(plan.kind).toBe('blocked');
    const item = pairItem(plan, UNIX);
    expect([item.list, item.defaultOption, item.action]).toEqual(['decision', 'manual', undefined]);
    expect(item.facts.join('\n')).toContain('pending fingerprint');
  });

  test('an EnvironmentFile on the unit is a decision act/manual, never read', () => {
    const plan = pairPlan(UNIX, facts([unit()]), ARGS, { environmentFiles: new Map([['dedalo-ts', ['/opt/dedalo/private/.env']]]) });
    expect(plan.kind).toBe('environment_files');
    const item = pairItem(plan, UNIX);
    expect(item.options?.map(o => o.id)).toEqual(['act', 'manual']);
    expect(item.defaultOption).toBeUndefined();
    expect(item.action?.kind).toBe('pair');
  });
});

describe('twoMachineInstructions', () => {
  test('tls: carry bundle + fragment, the token by file or stdin, delete the copies; the pair name and paths', () => {
    const lines = twoMachineInstructions(TLS, 'museum_org', null).join('\n');
    expect(lines).toContain(TLS.engineBundlePath);
    expect(lines).toContain(TLS.engineFragmentPath);
    expect(lines).toContain('add museum_org --fragment');
    expect(lines).toContain('--bundle');
    expect(lines).toContain('--token-file');
    expect(lines).toContain('--token-stdin');
    expect(lines).toMatch(/delete every copy/);
    expect(lines).toContain('<engine user>');
  });

  test('unix: the socket pairing with the real engine paths, and never --bundle', () => {
    const lines = twoMachineInstructions(UNIX, 'museum_org', unit());
    const command = lines.find(l => !l.startsWith('#'))!;
    expect(command).toBe(
      `sudo cat ${UNIX.serviceTokenPath} | (cd /opt/dedalo/master_dedalo && sudo -u dedalo /opt/dedalo/.bun/bin/bun run dedalo:pair-publication-host add museum_org --fragment ${UNIX.engineFragmentPath} --token-stdin)`,
    );
    expect(command).not.toContain('--bundle');
  });
});

/* ── running the child ────────────────────────────────────────────────────────────── */

function runner(results: ExecResult[] | ((p: PairInvocation) => ExecResult)) {
  const calls: PairInvocation[] = [];
  const queue = Array.isArray(results) ? [...results] : null;
  const ports: PairPorts = {
    exec: {
      pairAsEngine: (p: PairInvocation) => {
        calls.push(p);
        return queue === null ? (results as (p: PairInvocation) => ExecResult)(p) : (queue.shift() ?? { code: 0, stdout: '', stderr: '' });
      },
    },
    io: { readRootFile: () => `${TOKEN}\n` },
    sanitize: (line: string) => line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''),
  };
  return { ports, calls };
}

const INV = pairInvocation(unit(), UNIX, '/opt/dedalo', { name: 'museum_org', verb: 'add', dryRun: false });
const TAG = '[publication_host_pair]';

describe('pairOneMachine (spec §6 B5 steps 4-5)', () => {
  test('dry run first, then the real pairing; the token on the invocation only', () => {
    const r = runner([
      { code: 0, stdout: `${TAG} pairing proved\n${TAG} --dry-run: nothing was kept`, stderr: '' },
      { code: 0, stdout: `${TAG} added 'museum_org'`, stderr: '' },
    ]);
    const outcome = pairOneMachine(INV, UNIX, r.ports);
    expect(outcome.kind).toBe('done');
    expect(r.calls.map(c => c.dryRun)).toEqual([true, false]);
    expect(r.calls.every(c => c.token === TOKEN)).toBe(true);
    expect(outcome.lines).toHaveLength(3);
  });

  test('dryRunOnly stops after the proof', () => {
    const r = runner([{ code: 0, stdout: 'ok', stderr: '' }]);
    expect(pairOneMachine(INV, UNIX, r.ports, { dryRunOnly: true }).kind).toBe('done');
    expect(r.calls.map(c => c.dryRun)).toEqual([true]);
  });

  test('exit 3 "already registered. Use `replace`" → decision replace / skip / manual, the real run never starts', () => {
    const r = runner([{ code: 3, stdout: '', stderr: `${TAG} REFUSED — a publication host named 'museum_org' is already registered. Use \`replace\` to re-pair it. Nothing was written.` }]);
    const outcome = pairOneMachine(INV, UNIX, r.ports);
    expect(outcome.kind === 'decision' && outcome.id).toBe('replace');
    expect(outcome.kind === 'decision' ? outcome.options.map(o => o.id) : []).toEqual(['replace', 'skip', 'manual']);
    expect(r.calls).toHaveLength(1);
  });

  test('exit 3 "already registered as <twin>" → decision manual (remove twin, then add) / skip', () => {
    const r = runner([{ code: 3, stdout: '', stderr: `${TAG} REFUSED — this agent is already registered as 'old_name'. One agent, one registry entry. Nothing was written.` }]);
    const outcome = pairOneMachine(INV, UNIX, r.ports);
    expect(outcome.kind).toBe('decision');
    if (outcome.kind !== 'decision' || outcome.id !== 'twin') throw new Error('expected the twin decision');
    expect(outcome.twin).toBe('old_name');
    expect(outcome.options.map(o => o.id)).toEqual(['manual', 'skip']);
    expect(outcome.commands[0]).toMatch(/remove old_name$/);
    expect(outcome.commands[1]).toContain('add museum_org');
  });

  test('another exit 3 is refused with the child line; 4 and a timeout are failed, safe to re-run', () => {
    expect(pairOneMachine(INV, UNIX, runner([{ code: 3, stdout: '', stderr: `${TAG} REFUSED — fingerprint mismatch` }]).ports)).toEqual({
      kind: 'refused',
      lines: [`${TAG} REFUSED — fingerprint mismatch`],
    });
    const failed = pairOneMachine(INV, UNIX, runner([{ code: 0, stdout: '', stderr: '' }, { code: 4, stdout: '', stderr: 'unreachable' }]).ports);
    expect(failed.kind === 'failed' ? failed.reason : '').toContain('safe to re-run');
    const dryFailed = pairOneMachine(INV, UNIX, runner([{ code: 4, stdout: '', stderr: '' }]).ports);
    expect(dryFailed.kind === 'failed' ? dryFailed.reason : '').toContain('during its dry run');
    const timeout = pairOneMachine(INV, UNIX, runner([{ code: 124, stdout: '', stderr: 'timed out' }]).ports);
    expect(timeout.kind === 'failed' ? timeout.reason : '').toContain('120 s');
    const usage = pairOneMachine(INV, UNIX, runner([{ code: 2, stdout: '', stderr: '' }]).ports);
    expect(usage.kind === 'failed' ? usage.reason : '').toContain('exit 2');
  });

  test('an exec validation refusal is refused, never a spawn', () => {
    const r = runner(() => {
      throw new Error("exec: 'NODE_ENV' may not reach the pairing child");
    });
    expect(pairOneMachine(INV, UNIX, r.ports)).toEqual({ kind: 'refused', lines: ["exec: 'NODE_ENV' may not reach the pairing child"] });
    const odd = runner(() => {
      throw 'not an error';
    });
    expect(pairOneMachine(INV, UNIX, odd.ports).kind).toBe('refused');
  });

  test('no token: failed before any spawn', () => {
    const r = runner([]);
    const ports = { ...r.ports, io: { readRootFile: () => null } };
    expect(pairOneMachine(INV, UNIX, ports).kind).toBe('failed');
    expect(r.calls).toHaveLength(0);
  });

  test('output law: every child line sanitized; a token echoed by the child never comes back', () => {
    const r = runner([{ code: 3, stdout: `\u001b]52;c;Zm9v\u0007 ok \u001b[31mred\u001b[0m\n`, stderr: `echo ${TOKEN} here\n\n` }]);
    const outcome = pairOneMachine(INV, UNIX, r.ports);
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(TOKEN);
    for (const line of outcome.lines) expect(line).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(outcome.lines).toContain('echo [token] here');
  });

  test('the two slot sentences match the pairing CLI verbatim', async () => {
    // the CLI's pairing path lives in the engine's pair_flow.ts (the CLI and the panel share it)
    const cli = await Bun.file(`${import.meta.dir}/../../../src/core/publication_host/pair_flow.ts`).text();
    expect(cli).toContain('is already registered. Use \\`replace\\` to re-pair it.');
    expect(ALREADY_REGISTERED.test("a publication host named 'x' is already registered. Use `replace` to re-pair it.")).toBe(true);
    expect(cli).toContain("this agent is already registered as '${twin.name}'");
    expect(TWIN_REGISTERED.exec("this agent is already registered as 'abc_1'.")?.[1]).toBe('abc_1');
  });
});

describe('pairPortResult (the act loop never re-pairs without an answer)', () => {
  test('done / failed / refused / decisions', () => {
    expect(pairPortResult({ kind: 'done', lines: [] })).toEqual({ outcome: 'done' });
    expect(pairPortResult({ kind: 'failed', reason: 'r', lines: [] })).toEqual({ outcome: 'failed', reason: 'r' });
    expect(pairPortResult({ kind: 'refused', lines: ['a', 'last'] })).toEqual({ outcome: 'refused', reason: 'last' });
    expect(pairPortResult({ kind: 'refused', lines: [] }).reason).toContain('refused');
    expect(pairPortResult({ kind: 'decision', id: 'replace', options: [], lines: [] })).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining('--decide pair.engine=replace'),
    });
    const twin = pairPortResult({ kind: 'decision', id: 'twin', twin: 'old', options: [], commands: ['x remove old', 'y add new'], lines: [] });
    expect(twin.outcome).toBe('refused');
    expect(twin.reason).toContain("'old'");
    expect(twin.reason).toContain('x remove old ; then y add new');
  });
});

/* ── the sealed package (two machines) ─────────────────────────────────────────────── */

describe('writePairingPackage', () => {
  const FRAGMENT = `DEDALO_PUBLICATION_HOST_INSTANCE=${TLS.instance}\nDEDALO_PUBLICATION_HOST_FINGERPRINT=${'a'.repeat(64)}\n`;
  const BUNDLE = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
  function io(files: Record<string, string>) {
    const writes: { path: string; bytes: Uint8Array; mode: number; uid: number; gid: number }[] = [];
    return {
      writes,
      readRootFile: (path: string) => files[path] ?? null,
      writeBytesAtomic: (path: string, bytes: Uint8Array, mode: number, uid: number, gid: number) => {
        writes.push({ path, bytes, mode, uid, gid });
      },
    };
  }
  const complete = () => ({ [TLS.engineFragmentPath]: FRAGMENT, [TLS.serviceTokenPath]: `${TOKEN}\n`, [TLS.engineBundlePath]: BUNDLE });

  test('seals the three parts into root 0600; the passphrase opens it; nothing else is returned', () => {
    const fake = io(complete());
    const outcome = writePairingPackage(TLS, '/i/x.pairing', { io: fake, root: { uid: 0, gid: 0 } });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(fake.writes.map(w => [w.path, w.mode, w.uid, w.gid])).toEqual([['/i/x.pairing', 0o600, 0, 0]]);
    expect(openPairingPackage(fake.writes[0]?.bytes as Uint8Array, outcome.passphrase)).toEqual({ fragment: FRAGMENT, token: TOKEN, bundle: BUNDLE });
    expect(Object.keys(outcome).sort()).toEqual(['kind', 'passphrase', 'path']);
  });

  test('a missing part, a pending fingerprint or a short token: failed, nothing written, no secret in the reason', () => {
    for (const [drop, why] of [
      [TLS.engineFragmentPath, 'engine fragment'],
      [TLS.serviceTokenPath, 'service token'],
      [TLS.engineBundlePath, 'engine bundle'],
    ] as const) {
      const files = complete();
      delete files[drop];
      const fake = io(files);
      const outcome = writePairingPackage(TLS, '/i/x.pairing', { io: fake, root: { uid: 0, gid: 0 } });
      expect(outcome.kind === 'failed' ? outcome.reason : '').toContain(why);
      expect(fake.writes).toEqual([]);
    }
    const pending = io({ ...complete(), [TLS.engineFragmentPath]: 'DEDALO_PUBLICATION_HOST_FINGERPRINT=PENDING_SERVICE_TOKEN_NOT_MINTED_RERUN_PROVISION_APPLY\n' });
    expect(writePairingPackage(TLS, '/i/x', { io: pending, root: { uid: 0, gid: 0 } }).kind).toBe('failed');
    const short = io({ ...complete(), [TLS.serviceTokenPath]: 'tiny-value' });
    const outcome = writePairingPackage(TLS, '/i/x', { io: short, root: { uid: 0, gid: 0 } });
    expect(outcome.kind === 'failed' ? outcome.reason : '').not.toContain('tiny-value');
    expect(short.writes).toEqual([]);
  });
});

describe('the package after the pairing: engineContactSince + writtenPackageItem', () => {
  const since = '2026-10-09T10:00:00.000Z';
  const line = (ts: string, action: string) => JSON.stringify({ ts, actor: 'engine', action, outcome: 'ok' });

  test('a work-host command after the package was written is the proof; older lines, automatic rollbacks and torn lines are not', () => {
    expect(engineContactSince(null, since)).toBeNull();
    expect(engineContactSince('', since)).toBeNull();
    const before = line('2026-10-09T09:59:59.999Z', 'rules.apply');
    const auto = line('2026-10-10T00:00:00.000Z', 'release.auto_rollback');
    const repair = line('2026-10-10T00:00:01.000Z', 'media.repair');
    expect(engineContactSince([before, auto, repair, '{"torn', 'not json'].join('\n'), since)).toBeNull();
    expect(engineContactSince([before, auto, line('2026-10-09T10:00:00.001Z', 'rules.map')].join('\n'), since)).toEqual({
      action: 'rules.map',
      ts: '2026-10-09T10:00:00.001Z',
    });
    expect(engineContactSince(line(since, 'rules.apply'), since)).toBeNull(); // the same instant is not after
  });

  test('EVERY agent-origin audit action (AUDIT_ACTION_ORIGIN) proves nothing; every engine-origin one is the proof', () => {
    const actions = Object.keys(AUDIT_ACTION_ORIGIN) as AuditAction[];
    const after = '2026-10-10T00:00:00.000Z';
    expect(actions.filter(action => AUDIT_ACTION_ORIGIN[action] === 'agent').sort()).toEqual(['media.repair', 'release.auto_rollback']);
    for (const action of actions) {
      const contact = engineContactSince(line(after, action), since);
      expect([action, contact === null]).toEqual([action, AUDIT_ACTION_ORIGIN[action] === 'agent']);
    }
  });

  test('gone → right; stale or asked → the remove decision (remove by default, keep skips); else right naming the decide', () => {
    const planned = { id: 'pair.package', list: 'change', area: 'pair', title: 't', facts: [], commands: [], after: [], blocking: false, optional: true, operatorFile: false, hostWide: false } as const;
    const path = '/var/lib/dedalo_publication_host_init/test/test.pairing';
    expect(writtenPackageItem(planned, path, { present: false, contact: null, removeAsked: true })).toMatchObject({ list: 'right', action: undefined });
    const waiting = writtenPackageItem(planned, path, { present: true, contact: null, removeAsked: false });
    expect(waiting).toMatchObject({ list: 'right', action: undefined });
    expect(waiting.facts.join('\n')).toContain(`--decide pair.package=${PACKAGE_REMOVE}`);
    for (const state of [{ contact: { action: 'rules.apply', ts: 'x' }, removeAsked: false }, { contact: null, removeAsked: true }]) {
      const item = writtenPackageItem(planned, path, { present: true, ...state });
      expect(item).toMatchObject({ list: 'decision', defaultOption: PACKAGE_REMOVE, action: { kind: 'pair_package_remove', path } });
      expect(item.options?.map(o => [o.id, o.resolves])).toEqual([[PACKAGE_REMOVE, 'act'], [PACKAGE_KEEP, 'skip']]);
    }
  });
});
