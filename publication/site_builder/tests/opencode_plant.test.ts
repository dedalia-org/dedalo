/**
 * LEAD-1c — PLANT FOR OPENCODE: what an opencode turn LOADS is the daemon's statement, never the
 * workspace's or HOME's (phase A; the `systemd_scope` refusal stays — opencode_refusal.test.ts).
 *
 * Before: the turn ran `opencode run <prompt> --format json` with a daemon-written
 * `<workspace>/opencode.json` (the file the agent is told to leave alone, at the root it writes),
 * and opencode loaded whatever else stood there and in HOME: a project `opencode.json`'s
 * instructions and local MCP servers, `.opencode/{agent,tool,plugin}` (a plugin is CODE it runs),
 * `.claude/skills`, `.agents/skills`, `~/.opencode`, `~/.config/opencode`. One turn's Write could
 * plant a plugin the NEXT turn runs, `bash: deny` notwithstanding; a prompt starting `--` was an
 * option. Under the declared `none` this is the daemon's own uid.
 *
 * This file holds, on the REAL driver path (`opencodeTurnSetup` → `spawnAgentProcess`), against
 * a stand-in CLI that reports what it loads (support/fake_opencode.ts, one restriction key per
 * source):
 *
 *   O1. the argv: `run --pure --format json [--session <t>] -- <prompt>`;
 *   O2. the environment the driver states (TurnPlan.env): the four restriction keys and the
 *       daemon's whole configuration in OPENCODE_CONFIG_CONTENT — no HOME/XDG key (the HOME law),
 *       no egress key (childEgressEnv owns them), none a unit-fixed key;
 *   O3. the daemon wins: OPENCODE_ENV may not name a restriction, egress, fixed or HOME/XDG key
 *       (refused at parse), and a caller's env never overrides the driver's at the spawn;
 *   O4. under `none`, a turn's plants are NOT loaded by the next turn — and the same plants DO
 *       load without the restriction (the positive control); the daemon writes no workspace
 *       `opencode.json`;
 *   O5. a CLI that ignores ANY ONE restriction key, has no `debug`, does not list a flag, or
 *       answers with a non-zero exit is refused, typed (`agent_cli_unsupported`), at detect,
 *       admission and setup — and the 1.18.32-shaped CLI (help on STDERR) is admitted;
 *   O6. per SOURCE: a CLI that ignores only that source's switch is refused NAMING the source
 *       (a); a CLI that loads everything and reports nothing is refused — the control leg cannot
 *       see a source, so the probe cannot prove it closed (b); the vacuity guard (the daemon's MCP,
 *       its permission block, exactly its instructions);
 *   O7. the canary tokens are independent random words, none inside the scratch path;
 *   O8. only a definitive answer is cached: a question that failed once is asked again;
 *   O3b. OPENCODE_ENV is an ALLOWLIST over the binary's own key census; an operator's
 *       `OPENCODE_PERMISSION` cannot reopen `bash`; the probe asks under the operator's env;
 *   O9. the brief: the daemon writes it into `.builder/` and names it the ONE instruction file —
 *       bounded, a symlinked AGENTS.md refused, gone after the turn;
 *   O10. phase B is DERIVED: flipping the `.config` mount alone does not lift `systemd_scope`;
 *   +   every registered driver is classified by a PLANT closure.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveConfig } from '../src/config';
import { assertClaudeCliConfinable } from '../src/drivers/claude_code';
import { policyFromConfig, type ConfinementPolicy } from '../src/drivers/confinement';
import { childEgressEnv } from '../src/drivers/network_profile';
import * as opencodeModule from '../src/drivers/opencode';
import { detectOpencode, opencodeTurnSetup } from '../src/drivers/opencode';
import { piDriver } from '../src/drivers/pi';
import { spawnAgentProcess } from '../src/drivers/process';
import { detectDrivers } from '../src/drivers/registry';
import { TURN_ERROR_RETRIABLE } from '../src/drivers/turn_errors';
import type { AgentEvent, SessionStartOptions } from '../src/drivers/types';
import { isFixedEnvKey } from '../src/drivers/unit_frames';
import { ConfinementRefusedError } from '../src/errors';
import { mkdirPrivate } from '../src/util/shared_tree';
import { LEGACY_HELP, writeFakeClaude } from './support/fake_claude';
import { MODELLED_KEYS, RUN_HELP, opencodeLoadReport, writeFakeOpencode } from './support/fake_opencode';
import envCensus from './fixtures/opencode_1.18.32_env_keys.json';
import { roots, workspacePath } from './fixtures/instance';

// The probe's scratch tree lives under the agent state root (a provisioned root on a host): the
// suite's must exist, as a host's does.
beforeAll(() => {
  mkdirSync(roots.agentStateRoot, { recursive: true });
});

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** The restriction the design states (spelled here, not imported: a leaf cannot agree with itself). */
const RESTRICTION = Object.freeze({
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_PURE: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
});
/** The daemon's permission block (spelled here), restated in OPENCODE_PERMISSION. */
const PERMISSION = Object.freeze({
  bash: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  codesearch: 'deny',
  skill: 'deny',
  task: 'deny',
  external_directory: 'deny',
  edit: 'allow',
});
const MCP = Object.freeze({ name: 'dedalo_publication', url: 'http://127.0.0.1:9/mcp' });
/** opencode's off-plan traffic, switched off by the DRIVER in every mode (spelled here). */
const TRAFFIC = Object.freeze({
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  OPENCODE_DISABLE_SHARE: '1',
});

/** A fresh site workspace under SITES_ROOT. */
function workspace(slug: string): string {
  const ws = workspacePath(slug);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  scratch.push(ws);
  return ws;
}

function startOptions(slug: string, prompt = 'build the page', env: Record<string, string> = {}, resumeToken?: string): SessionStartOptions {
  return {
    slug,
    driver: 'opencode',
    workspace: workspacePath(slug),
    prompt,
    ...(resumeToken ? { resumeToken } : {}),
    mcp: { ...MCP },
    env: { PATH: '/usr/bin:/bin', ...env },
    timeoutMs: 30_000,
  };
}

/** The setup seams of the final design: the binary and the mode (no config writer any more). */
const seams = (bin: string, mode: 'none' | 'systemd_scope' = 'none') => ({ bin, mode }) as never;

/** A declared-unconfined policy whose agent state root is this test's own. */
function nonePolicy(): ConfinementPolicy {
  return { ...policyFromConfig(), mode: 'none', agentStateRoot: scratchDir('oc-state-') };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
const texts = (events: AgentEvent[]) => events.flatMap(event => (event.type === 'text' ? [event.text] : []));

async function runTurn(slug: string, bin: string, policy: ConfinementPolicy, env: Record<string, string> = {}) {
  const opts = startOptions(slug, 'build the page', env);
  const events = await drain(spawnAgentProcess(opts, opencodeTurnSetup(opts, seams(bin)), policy).events);
  return { events, report: opencodeLoadReport(texts(events)) };
}

/** The leaf the design adds (drivers/opencode_argv.ts), or why it cannot be read. */
async function leaf(): Promise<Record<string, any>> {
  try {
    return (await import('../src/drivers/opencode_argv')) as Record<string, any>;
  } catch (error) {
    return { missing: `drivers/opencode_argv.ts cannot be imported: ${String(error)}` };
  }
}

const obedientBin = () => writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode');

/* ────────────────────────────────────────────────────────────────────────────────────
 * O1 — the argv
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('O1 — the argv: run --pure --format json [--session t] -- <prompt>', () => {
  test('a prompt that looks like an option is the prompt; --pure is stated; the session id precedes --', async () => {
    const bin = obedientBin();
    workspace('oc-argv');
    const plan = await opencodeTurnSetup(startOptions('oc-argv', '--version'), seams(bin))();
    await plan.cleanup?.();
    expect(plan.argv.slice(-2)).toEqual(['--', '--version']);
    expect(plan.argv.slice(0, 2)).toEqual([bin, 'run']);
    expect(plan.argv).toContain('--pure');
    expect(plan.argv[plan.argv.indexOf('--format') + 1]).toBe('json');
    const resumed = await opencodeTurnSetup(startOptions('oc-argv', 'go on', {}, 'ses_1'), seams(bin))();
    await resumed.cleanup?.();
    const dash = resumed.argv.indexOf('--');
    const session = resumed.argv.indexOf('--session');
    expect({ session: session > 0 && session < dash, token: resumed.argv[session + 1] }).toEqual({ session: true, token: 'ses_1' });
  });

  test('the builtin-only leaf spells the argv the driver runs', async () => {
    const module = await leaf();
    expect(module.missing ?? 'present').toBe('present');
    expect(module.opencodeTurnArgv?.({ bin: '/o', prompt: '--x', resumeToken: undefined })).toEqual(['/o', 'run', '--pure', '--format', 'json', '--', '--x']);
    expect(module.opencodeTurnArgv?.({ bin: '/o', prompt: 'p', resumeToken: 't' })).toEqual(['/o', 'run', '--pure', '--format', 'json', '--session', 't', '--', 'p']);
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * O2 — the environment the driver states
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('O2 — the driver states the restriction and the daemon’s whole configuration in the env', () => {
  test('every restriction key, its value; CONFIG_CONTENT is the daemon’s MCP alone and its permission block', async () => {
    const bin = obedientBin();
    workspace('oc-env');
    const plan = (await opencodeTurnSetup(startOptions('oc-env'), seams(bin))()) as { env?: Record<string, string>; cleanup?: () => Promise<void> };
    await plan.cleanup?.();
    const env = plan.env ?? {};
    expect(Object.fromEntries(Object.keys(RESTRICTION).map(key => [key, env[key] ?? '(absent)']))).toEqual({ ...RESTRICTION });
    const content = (() => {
      try {
        return JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? 'null');
      } catch {
        return null;
      }
    })();
    expect(Object.keys(content?.mcp ?? {})).toEqual([MCP.name]);
    expect(content?.mcp?.[MCP.name]?.url).toBe(MCP.url);
    expect(content?.permission).toMatchObject({
      bash: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      codesearch: 'deny',
      skill: 'deny',
      task: 'deny',
      external_directory: 'deny',
      edit: 'allow',
    });
    // No AGENTS.md in this workspace: no brief, so no instruction file at all.
    expect(content).toMatchObject({ lsp: false, formatter: false, snapshot: false, share: 'disabled', autoupdate: false, plugin: [], instructions: [] });
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? 'null')).toEqual({ ...PERMISSION });
    // The traffic switches and the database are the DRIVER's statement, in every mode: an opencode
    // turn runs only under `none`, where no egress key is ever applied.
    expect(Object.fromEntries([...Object.keys(TRAFFIC), 'OPENCODE_DB'].map(key => [key, env[key] ?? '(absent)']))).toEqual({ ...TRAFFIC, OPENCODE_DB: 'opencode.db' });
    // The HOME law owns HOME/XDG; childEgressEnv owns the egress (proxy) keys; nothing is a unit-fixed key.
    const egress = Object.keys(childEgressEnv('turn'));
    expect(egress.filter(key => key.startsWith('OPENCODE_'))).toEqual([]);
    for (const key of Object.keys(env)) {
      expect({ key, home: /^(HOME|XDG_|OPENCODE_TEST_HOME$|CLAUDE_CONFIG_DIR$)/.test(key), egress: egress.includes(key), fixed: isFixedEnvKey(key) }).toEqual({
        key,
        home: false,
        egress: false,
        fixed: false,
      });
    }
  });

  test('the leaf’s restriction is the same in both modes and names no unit-fixed key', async () => {
    const module = await leaf();
    expect(module.missing ?? 'present').toBe('present');
    const env = module.OPENCODE_RESTRICTION_ENV?.('{}') ?? {};
    expect(Object.fromEntries(Object.keys(RESTRICTION).map(key => [key, env[key] ?? '(absent)']))).toEqual({ ...RESTRICTION });
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{}');
    expect([...(module.OPENCODE_RESTRICTION_KEYS ?? [])].sort()).toEqual([...Object.keys(RESTRICTION), 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION'].sort());
    expect(Object.keys(env).filter(isFixedEnvKey)).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * O3 — the daemon wins
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('O3 — no operator key and no caller env overrides the restriction', () => {
  function envFile(values: Record<string, string>): string {
    const path = join(scratchDir('oc-cfg-'), 'site.env');
    writeFileSync(path, `${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')}\n`);
    return path;
  }
  const base = (patch: Record<string, string> = {}) => ({
    DEDALO_SITE_INSTANCE: 'gate',
    SERVICE_TOKEN: 'x'.repeat(40),
    SITES_ROOT: '/srv/gate/workspaces',
    AUDIT_DIR: '/srv/gate/audit',
    WEBSPACE_BASE: '/srv/gate/webspaces',
    SITE_TABLE_FILE: '/srv/gate/config/sites.json',
    PUBLICATION_API_URL: 'http://127.0.0.1:3100/publication/server_api/v2',
    AGENT_CONFINEMENT: 'systemd_scope',
    AGENT_UNIT_PREFIX: 'dedalo-site-gate-agent-',
    AGENT_IDENTITIES: '{"alpha":1}',
    AGENT_SOCKET_DIR: '/run/dedalo-sites/gate-agents',
    AGENT_STATE_ROOT: '/srv/gate/agents',
    SYSTEMCTL_BIN: '/usr/bin/systemctl',
    AGENT_IDENTITY_EPOCH: '1',
    GIT_TIMEOUT_MS: '30000',
    ...patch,
  });
  const verdict = (values: Record<string, string>): string => {
    try {
      resolveConfig({ envFilePath: envFile(values), ambient: {}, credentialsDir: null });
      return 'resolved';
    } catch (error) {
      return String((error as Error).message);
    }
  };

  test('control: provider credentials in OPENCODE_ENV resolve', () => {
    expect(verdict(base({ OPENCODE_ENV: 'ANTHROPIC_API_KEY=x,OPENCODE_API_KEY=y,AWS_SECRET_ACCESS_KEY=z' }))).toBe('resolved');
  });

  test('O3b — an ALLOWLIST over the binary’s own key census: every key refused unless it is a credential', () => {
    const census = envCensus as { opencode: string[]; runtime: string[]; provider_ancillary: string[]; credentials: string[] };
    const refusedWrongly: string[] = [];
    const admittedWrongly: string[] = [];
    for (const key of [...census.opencode, ...census.runtime, ...census.provider_ancillary]) {
      const answer = verdict(base({ OPENCODE_ENV: `${key}=${key === 'OPENCODE_AUTH_CONTENT' ? '{}' : '1'}` }));
      const credential = census.credentials.includes(key);
      if (credential && answer !== 'resolved') refusedWrongly.push(key);
      if (!credential && !(answer !== 'resolved' && answer.includes(key))) admittedWrongly.push(key);
    }
    // A credential's VALUE: the inline credential store is a JSON object of credentials (O11).
    const valueOf = (key: string) => (key === 'OPENCODE_AUTH_CONTENT' ? '{}' : '1');
    for (const key of census.credentials) if (verdict(base({ OPENCODE_ENV: `${key}=${valueOf(key)}` })) !== 'resolved') refusedWrongly.push(key);
    expect({ refusedWrongly, admittedWrongly }).toEqual({ refusedWrongly: [], admittedWrongly: [] });
    // The census is a real one: it holds the keys that reopen what the restriction closes.
    for (const key of ['OPENCODE_PERMISSION', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DISABLE_PROJECT_CONFIG']) expect(census.opencode).toContain(key);
  });

  test('O11 — OPENCODE_AUTH_CONTENT is a credential only when it holds credentials: a wellknown entry, a non-object, non-JSON — refused at boot', () => {
    const rows = {
      empty: verdict(base({ OPENCODE_ENV: 'OPENCODE_AUTH_CONTENT={}' })),
      // (OPENCODE_ENV splits on ',': a one-entry object with no comma in it.)
      api: verdict(base({ OPENCODE_ENV: 'OPENCODE_AUTH_CONTENT={"anthropic":{"type":"api"}}' })),
      wellknown: verdict(base({ OPENCODE_ENV: 'OPENCODE_AUTH_CONTENT={"https://x.example":{"type":"wellknown"}}' })),
      array: verdict(base({ OPENCODE_ENV: 'OPENCODE_AUTH_CONTENT=[]' })),
      notJson: verdict(base({ OPENCODE_ENV: 'OPENCODE_AUTH_CONTENT=sk-raw' })),
    };
    expect({
      empty: rows.empty,
      api: rows.api,
      wellknown: rows.wellknown.includes('wellknown') && rows.wellknown.includes('REMOTE configuration'),
      array: rows.array.includes('not a JSON object'),
      notJson: rows.notJson.includes('not JSON'),
    }).toEqual({ empty: 'resolved', api: 'resolved', wellknown: true, array: true, notJson: true });
  });

  const FORBIDDEN = [
    ...Object.keys(RESTRICTION),
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_TEST_HOME',
    ...Object.keys(TRAFFIC),
    'OPENCODE_DB',
    'HTTPS_PROXY',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'HOME',
    'PATH',
    'CLAUDE_CONFIG_DIR',
    'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
  ];
  for (const key of FORBIDDEN) {
    test(`OPENCODE_ENV naming ${key} is refused at parse, naming the key`, () => {
      const refused = verdict(base({ OPENCODE_ENV: `${key}=0` }));
      expect({ key, refused: refused !== 'resolved' && refused.includes('OPENCODE_ENV') && refused.includes(key) }).toEqual({ key, refused: true });
    });
  }

  test('a caller’s env that says otherwise reaches the CLI as the driver’s value', async () => {
    const bin = obedientBin();
    workspace('oc-wins');
    const { report } = await runTurn('oc-wins', bin, nonePolicy(), {
      OPENCODE_PURE: '0',
      OPENCODE_DISABLE_PROJECT_CONFIG: '0',
      OPENCODE_CONFIG_CONTENT: '{"mcp":{}}',
    });
    expect(report === null ? 'the fake never reported (no turn ran)' : 'reported').toBe('reported');
    expect({ pure: report?.env?.OPENCODE_PURE, project: report?.env?.OPENCODE_DISABLE_PROJECT_CONFIG }).toEqual({ pure: '1', project: '1' });
    expect((report?.loaded?.mcp ?? []).map((entry: { name: string }) => entry.name)).toContain(MCP.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * O4 — a turn's plants are not the next turn's configuration
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('O4 — under none, the next turn loads none of what the previous one planted', () => {
  test('positive control: the same plants LOAD when the CLI runs without the restriction and with the planted HOME', () => {
    const bin = obedientBin();
    const ws = scratchDir('oc-control-ws-');
    const home = scratchDir('oc-control-home-');
    const env = { PATH: '/usr/bin:/bin', HOME: home };
    spawnSync(bin, ['run', '--format', 'json', '--', 'plant'], { cwd: ws, env: { ...env, FAKE_PLANT: '1' }, encoding: 'utf8' });
    const out = spawnSync(bin, ['run', '--format', 'json', '--', 'next'], { cwd: ws, env, encoding: 'utf8' }).stdout;
    const report = opencodeLoadReport(out.split('\n').flatMap(line => {
      try {
        const parsed = JSON.parse(line);
        return typeof parsed.text === 'string' ? [parsed.text] : [];
      } catch {
        return [];
      }
    }));
    const planted: string[] = report?.planted ?? [];
    for (const expected of ['PLANTED_INSTRUCTIONS.md', 'mcp:planted', 'plugin:project:planted.js', 'agent:project:build.md', 'tool:home:planted.js', 'plugin:home:home_planted.js', 'PLANTED_GLOBAL.md']) {
      expect({ expected, loaded: planted.includes(expected) }).toEqual({ expected, loaded: true });
    }
    expect(existsSync(join(ws, 'PLUGIN_RAN'))).toBe(true);
  });

  test('turn 2 loads zero planted items and still has the daemon’s MCP server', async () => {
    const bin = obedientBin();
    const ws = workspace('oc-plant');
    const policy = nonePolicy();
    const first = await runTurn('oc-plant', bin, policy, { FAKE_PLANT: '1' });
    expect(first.report === null ? 'turn 1 never ran' : 'ran').toBe('ran');
    rmSync(join(ws, 'PLUGIN_RAN'), { force: true });
    rmSync(join(ws, 'HOME_PLUGIN_RAN'), { force: true });
    const second = await runTurn('oc-plant', bin, policy);
    expect(second.report?.planted ?? 'turn 2 never ran').toEqual([]);
    expect((second.report?.loaded?.mcp ?? []).map((entry: { name: string }) => entry.name)).toEqual([MCP.name]);
    expect({ plugin: existsSync(join(ws, 'PLUGIN_RAN')), homePlugin: existsSync(join(ws, 'HOME_PLUGIN_RAN')) }).toEqual({ plugin: false, homePlugin: false });
  });

  test('the daemon writes no opencode.json into the workspace', async () => {
    const bin = obedientBin();
    const ws = workspace('oc-nofile');
    const plan = await opencodeTurnSetup(startOptions('oc-nofile'), seams(bin))();
    expect(existsSync(join(ws, 'opencode.json'))).toBe(false);
    await plan.cleanup?.();
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * O5 — the probe: a CLI that would load a plant is refused, typed, at every door
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('O5 — a CLI that ignores any restriction is refused at detect, admission and setup', () => {
  type Admit = (options: { bin: string; mode: 'none' | 'systemd_scope' }) => Promise<void>;
  const admitOpencode = (opencodeModule as unknown as { admitOpencode?: Admit }).admitOpencode;

  async function doors(bin: string, slug: string) {
    const ws = workspace(slug);
    // The verdict, not the latency (O12 holds detect()'s own bound): wait for the whole probe.
    const detected = await detectOpencode({ bin, mode: 'none', detectWaitMs: 60_000 } as never);
    let admitted: unknown = 'admitOpencode is not exported';
    if (admitOpencode) {
      admitted = await admitOpencode({ bin, mode: 'none' }).then(
        () => null,
        error => error,
      );
    }
    const setup = await opencodeTurnSetup(startOptions(slug), seams(bin))().then(
      async plan => {
        await plan.cleanup?.();
        return null;
      },
      error => error,
    );
    const typed = (error: unknown) =>
      error instanceof ConfinementRefusedError ? (error as ConfinementRefusedError).code : error === null ? null : String(error);
    return { detected: detected === null ? null : detected.version, admit: typed(admitted), setup: typed(setup), wroteConfig: existsSync(join(ws, 'opencode.json')) };
  }

  test('control: the 1.18.32-shaped CLI (yargs help on STDERR) is available, admitted and set up', async () => {
    expect(await doors(obedientBin(), 'oc-probe-ok')).toEqual({ detected: '1.18.32', admit: null, setup: null, wroteConfig: false });
  });

  test('…and so is one whose help is on stdout (an older yargs): both streams are read', async () => {
    const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { helpOnStdout: true });
    expect(await doors(bin, 'oc-probe-stdout')).toEqual({ detected: '1.18.32', admit: null, setup: null, wroteConfig: false });
  });

  const REFUSED = { detected: null, admit: 'agent_cli_unsupported', setup: 'agent_cli_unsupported', wroteConfig: false };

  for (const key of MODELLED_KEYS) {
    test(`a CLI that ignores ${key} is refused at every door`, async () => {
      const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { ignore: key });
      expect({ key, ...(await doors(bin, `oc-probe-${key.toLowerCase().replace(/_/g, '-').slice(0, 30)}`)) }).toEqual({ key, ...REFUSED });
    });
  }

  test('a CLI with no debug subcommand is refused (the probe cannot ask, so it does not believe)', async () => {
    const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { noDebug: true });
    expect(await doors(bin, 'oc-probe-nodebug')).toEqual(REFUSED);
  });

  for (const flag of ['--pure', '--format', '--session']) {
    test(`a CLI whose run --help does not list ${flag} is refused`, async () => {
      const help = RUN_HELP.split('\n')
        .filter(line => !new RegExp(`^\\s+(-\\w, )?${flag}\\s`).test(line))
        .join('\n');
      expect(help).not.toContain(`${flag} `);
      const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { help });
      expect({ flag, ...(await doors(bin, `oc-probe-flag${flag.replace(/-/g, '')}`)) }).toEqual({ flag, ...REFUSED });
    });
  }

  test('a CLI whose debug answers are clean but EXIT non-zero is refused (an answer it did not stand by is no answer)', async () => {
    const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { debugExit: 3 });
    expect(await doors(bin, 'oc-probe-exit')).toEqual(REFUSED);
  });

  test('a CLI whose help only MENTIONS --pure in a description is refused (a mention is not an option)', async () => {
    const help = RUN_HELP.split('\n')
      .filter(line => !/^\s+--pure\s/.test(line))
      .map(line => (line.includes('--print-logs') ? `${line}  (unlike --pure)` : line))
      .join('\n');
    expect(help).toContain('--pure');
    const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { help });
    expect(await doors(bin, 'oc-probe-mention')).toEqual(REFUSED);
  });

  test('the leaf’s flag matcher reads yargs option lines at any indentation', async () => {
    const module = await leaf();
    expect(module.missing ?? 'present').toBe('present');
    const listed: Set<string> = module.listedYargsFlags?.(RUN_HELP) ?? new Set();
    for (const flag of ['--pure', '--format', '--session', '-s']) expect({ flag, listed: listed.has(flag) }).toEqual({ flag, listed: true });
    // A flag MENTIONED in a description is not listed.
    expect(module.listedYargsFlags?.('Options:\n  --format   json, unlike --pure\n').has('--pure')).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * O6–O8 — the probe sees each source, names it, and believes only a whole answer
 * ──────────────────────────────────────────────────────────────────────────────────── */

type Probe = { version: string | null; problems: readonly string[]; definitive: boolean; transient: boolean };
const probeClosure = (bin: string, stateRoot: string, extra: Record<string, unknown> = {}) =>
  (opencodeModule as unknown as { probeOpencodePlantClosure: (b: string, o: Record<string, unknown>) => Promise<Probe> }).probeOpencodePlantClosure(bin, {
    stateRoot,
    operatorEnv: {},
    ...extra,
  });

describe('O6 — per SOURCE: a leak is named; a source the control cannot see is not believed closed', () => {
  /** Which source each switch closes (the design's table, spelled here). */
  const CLOSES: Record<string, readonly string[]> = {
    OPENCODE_DISABLE_PROJECT_CONFIG: ['project_instructions', 'project_mcp', 'project_agent', 'project_tool', 'project_skill', 'project_command'],
    OPENCODE_PURE: ['project_plugin'],
    OPENCODE_DISABLE_CLAUDE_CODE: ['claude_skill'],
    OPENCODE_DISABLE_EXTERNAL_SKILLS: ['agents_skill'],
  };
  const ALL = Object.values(CLOSES).flat();

  test('control: the obedient CLI — every source surfaces unrestricted, none restricted; the scratch tree is removed', async () => {
    const stateRoot = scratchDir('oc-probe-state-');
    const probe = await probeClosure(obedientBin(), stateRoot);
    expect(probe).toEqual({ version: '1.18.32', problems: [], definitive: true, transient: false });
    expect(existsSync(join(stateRoot, 'probe')) ? readdirSync(join(stateRoot, 'probe')) : []).toEqual([]);
  });

  for (const [key, sources] of Object.entries(CLOSES)) {
    test(`a CLI ignoring only ${key} is refused naming ${sources.join(', ')} — and no other source`, async () => {
      const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { ignore: key as never });
      const probe = await probeClosure(bin, scratchDir('oc-probe-state-'));
      const said = probe.problems.join(' ');
      const named = ALL.filter(source => said.includes(source) || (source === 'project_plugin' && said.includes('RAN a workspace plugin')));
      expect({ key, named: named.sort() }).toEqual({ key, named: [...sources].sort() });
    });
  }

  test('O6b — a BLIND CLI (loads everything, reports nothing) is refused: the probe cannot prove any reported source closed', async () => {
    const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { blind: true });
    const probe = await probeClosure(bin, scratchDir('oc-probe-state-'));
    const unproved = ALL.filter(source => source !== 'project_plugin' && probe.problems.join(' ').includes(`cannot prove ${source} closed`));
    expect({ refused: probe.problems.length > 0, unproved: unproved.sort() }).toEqual({ refused: true, unproved: ALL.filter(source => source !== 'project_plugin').sort() });
  });

  test('the vacuity guard: a CLI that resolves none of the daemon’s permissions is refused naming the block', async () => {
    const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { dropPermission: true });
    const said = (await probeClosure(bin, scratchDir('oc-probe-state-'))).problems.join(' ');
    expect(said.includes("lacks the daemon's permission block")).toBe(true);
  });

  test('the vacuity guard: a CLI that ignores OPENCODE_CONFIG_CONTENT is refused (no daemon MCP, no brief)', async () => {
    const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { ignore: 'OPENCODE_CONFIG_CONTENT' });
    const said = (await probeClosure(bin, scratchDir('oc-probe-state-'))).problems.join(' ');
    expect({ mcp: said.includes("lacks the daemon's MCP server"), brief: said.includes('not exactly the daemon') }).toEqual({ mcp: true, brief: true });
  });
});

/**
 * G6 — A PROBE THAT CANNOT PREPARE ITS SCRATCH TREE KEEPS WHAT IT ALREADY PROVED. The `run --help`
 * answer is asked before the scratch tree; a binary that lacks a flag every turn passes is a
 * proven defect, and a scratch failure after it must not replace the verdict with "could not be
 * asked" (retryable, refused only until the next attempt) — the ONE rule: a proven defect beside
 * anything else is the defect.
 */
describe('G6 — a scratch-tree failure never drops a problem the probe already proved', () => {
  test('help lacks --pure AND the state root is a file: refused, NOT transient, both named', async () => {
    const dir = scratchDir('fake-opencode-');
    const bin = writeFakeOpencode(dir, 'opencode', { help: RUN_HELP.split('\n').filter(line => !line.includes('--pure')).join('\n') });
    const notADir = join(scratchDir('oc-probe-file-'), 'state-root-is-a-file');
    writeFileSync(notADir, 'x');
    const probe = await probeClosure(bin, notADir);
    const said = probe.problems.join(' ');
    expect({
      transient: probe.transient,
      definitive: probe.definitive,
      flag: said.includes("does not list --pure"),
      scratch: said.includes("scratch tree"),
    }).toEqual({ transient: false, definitive: false, flag: true, scratch: true });
  });

  test('a scratch failure that is not a moment’s resource refusal (the state root is a file) is a PROBLEM, not retryable', async () => {
    const notADir = join(scratchDir('oc-probe-file-'), 'state-root-is-a-file');
    writeFileSync(notADir, 'x');
    const probe = await probeClosure(obedientBin(), notADir);
    expect({ transient: probe.transient, refused: probe.problems.length > 0, scratch: probe.problems.join(' ').includes('scratch tree') }).toEqual({
      transient: false,
      refused: true,
      scratch: true,
    });
  });
});

describe('O7 — the canary tokens: independent, and never inside the scratch path', () => {
  test('a token occurring in the scratch root, an overlapping pair, a non-random word — each refused by the builder', async () => {
    const module = await leaf();
    const sources: string[] = [...(module.OPENCODE_PLANT_SOURCES ?? [])];
    expect(sources.length).toBeGreaterThanOrEqual(7);
    const tokens = Object.fromEntries(sources.map((source, index) => [source, `z${index}abcdef0123456`]));
    expect(() => module.opencodePlantCanaries({ tokens, root: '/srv/agents/probe/opencode-zfeed' })).not.toThrow();
    expect(() => module.opencodePlantCanaries({ tokens, root: `/srv/agents/probe/${tokens[sources[2] as string]}` })).toThrow('scratch root');
    expect(() => module.opencodePlantCanaries({ tokens: { ...tokens, [sources[1] as string]: tokens[sources[0] as string] }, root: '/srv/x' })).toThrow('overlap');
    expect(() => module.opencodePlantCanaries({ tokens: { ...tokens, [sources[0] as string]: 'TOKEN' }, root: '/srv/x' })).toThrow('random');
  });

  test('a CLI that echoes HOME and cwd in its answers (as 1.18.32 does) is not refused for it', async () => {
    // The obedient fake echoes paths under HOME and the cwd in `debug agent build` (fake_opencode.ts);
    // a token inside the scratch path would make that echo a "leak". The control probe above passes.
    const probe = await probeClosure(obedientBin(), scratchDir('oc-probe-state-'));
    expect(probe.problems).toEqual([]);
  });
});

describe('O8 — only a definitive answer is cached; a failure is asked again', () => {
  test('a debug question that fails ONCE: refused (not cached), and the next admission probes again and admits', async () => {
    const dir = scratchDir('fake-opencode-');
    const bin = writeFakeOpencode(dir, 'opencode', { failOnceMarker: join(dir, 'failed-once') });
    const first = await opencodeModule.admitOpencode({ bin, mode: 'none' }).then(
      () => null,
      error => (error as ConfinementRefusedError).code,
    );
    const second = await opencodeModule.admitOpencode({ bin, mode: 'none' }).then(
      () => null,
      error => (error as ConfinementRefusedError).code,
    );
    expect({ first, second }).toEqual({ first: 'agent_cli_unsupported', second: null });
  });

  test('a definitive answer IS cached: a second admission asks the binary nothing', async () => {
    const bin = obedientBin();
    let asked = 0;
    const run = async (argv: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>> }) => {
      asked++;
      const out = spawnSync(argv[0] as string, argv.slice(1) as string[], { cwd: options.cwd, env: { ...options.env }, encoding: 'utf8' });
      return { exitCode: out.status, stdout: out.stdout, stderr: out.stderr };
    };
    await opencodeModule.admitOpencode({ bin, mode: 'none', run });
    const once = asked;
    await opencodeModule.admitOpencode({ bin, mode: 'none', run });
    expect({ probed: once > 0, again: asked - once }).toEqual({ probed: true, again: 0 });
  });
});

describe('O8b — the cache key: the binary AND the operator environment; a replaced binary is a new key', () => {
  /** A runner that counts the probes (each probe asks `--version` once). */
  function countingRunner() {
    const counted = { probes: 0 };
    const run = async (argv: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>> }) => {
      if (argv[1] === '--version') counted.probes++;
      const out = spawnSync(argv[0] as string, argv.slice(1) as string[], { cwd: options.cwd, env: { ...options.env }, encoding: 'utf8' });
      return { exitCode: out.status, stdout: out.stdout, stderr: out.stderr };
    };
    return { counted, run };
  }

  test('the same binary under two operator environments is probed twice — the answer proves the binary UNDER one', async () => {
    const bin = obedientBin();
    const { counted, run } = countingRunner();
    await opencodeModule.admitOpencode({ bin, mode: 'none', run, operatorEnv: { ANTHROPIC_API_KEY: 'sk-a' } } as never);
    await opencodeModule.admitOpencode({ bin, mode: 'none', run, operatorEnv: { ANTHROPIC_API_KEY: 'sk-b' } } as never);
    await opencodeModule.admitOpencode({ bin, mode: 'none', run, operatorEnv: { ANTHROPIC_API_KEY: 'sk-b' } } as never);
    expect(counted.probes).toBe(2);
  });

  test('a re-probe of the binary EVICTS its older entry: the first environment is asked again, never served stale', async () => {
    const bin = obedientBin();
    const { counted, run } = countingRunner();
    for (const key of ['sk-a', 'sk-b', 'sk-a']) {
      await opencodeModule.admitOpencode({ bin, mode: 'none', run, operatorEnv: { ANTHROPIC_API_KEY: key } } as never);
    }
    expect(counted.probes).toBe(3);
  });

  test('a binary REPLACED at the same path (an upgrade, a swap) is probed again — and refused when it ignores a restriction', async () => {
    const dir = scratchDir('fake-opencode-');
    const bin = writeFakeOpencode(dir, 'opencode');
    const { counted, run } = countingRunner();
    await opencodeModule.admitOpencode({ bin, mode: 'none', run, operatorEnv: {} } as never);
    // Same path, other bytes: a CLI that ignores OPENCODE_PURE (a plugin RUNS).
    rmSync(bin);
    writeFakeOpencode(dir, 'opencode', { ignore: 'OPENCODE_PURE', version: '1.18.33' });
    const second = await opencodeModule.admitOpencode({ bin, mode: 'none', run, operatorEnv: {} } as never).then(
      () => null,
      error => (error as ConfinementRefusedError).code,
    );
    expect({ probes: counted.probes, second }).toEqual({ probes: 2, second: 'agent_cli_unsupported' });
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * O12 — the open door stays cheap; a fact about THIS MOMENT is refused retryable
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('O12 — detect() (GET /health, unauthenticated) stays cheap; an unproved answer is retryable, a proven one is not', () => {
  type Result = { exitCode: number | null; stdout: string; stderr?: string; timedOut?: boolean };
  type Runner = (argv: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>> }) => Promise<Result>;
  type Seams = { bin: string; mode: 'none'; run: Runner; operatorEnv: Record<string, string>; now?: () => number; detectWaitMs?: number };
  const oc = opencodeModule as unknown as {
    detectOpencode: (seams: Seams) => Promise<{ version: string } | null>;
    admitOpencode: (seams: Seams) => Promise<void>;
    OPENCODE_DETECT_WAIT_MS?: number;
    OPENCODE_UNPROVED_HOLD_MS?: number;
  };
  const real = (argv: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>> }): Result => {
    const out = spawnSync(argv[0] as string, argv.slice(1) as string[], { cwd: options.cwd, env: { ...options.env }, encoding: 'utf8' });
    return { exitCode: out.status, stdout: out.stdout, stderr: out.stderr };
  };
  /** Each probe asks `--version` exactly once: the count of probes the binary saw. */
  function counting(wrap: (argv: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>> }) => Promise<Result | null> = async () => null) {
    const counted = { probes: 0 };
    const run: Runner = async (argv, options) => {
      if (argv[1] === '--version') counted.probes++;
      return (await wrap(argv, options)) ?? real(argv, options);
    };
    return { counted, run };
  }
  const codeOf = (seams: Seams) =>
    oc.admitOpencode(seams).then(
      () => null,
      error => (error instanceof ConfinementRefusedError ? error.code : String(error)),
    );

  test('N concurrent detect() against a CLI whose debug exits non-zero: ONE probe in flight; the unproved answer is HELD, then asked again', async () => {
    const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { debugExit: 3 });
    const { counted, run } = counting();
    let clock = 1_000_000;
    const seams: Seams = { bin, mode: 'none', run, operatorEnv: {}, now: () => clock, detectWaitMs: 60_000 };
    const answers = await Promise.all(Array.from({ length: 6 }, () => oc.detectOpencode(seams)));
    expect({ probes: counted.probes, answers }).toEqual({ probes: 1, answers: [null, null, null, null, null, null] });
    const hold = oc.OPENCODE_UNPROVED_HOLD_MS ?? 0;
    expect(hold).toBeGreaterThanOrEqual(30_000);
    clock += hold - 1;
    expect({ answer: await oc.detectOpencode(seams), probes: counted.probes }).toEqual({ answer: null, probes: 1 });
    clock += 2;
    expect({ answer: await oc.detectOpencode(seams), probes: counted.probes }).toEqual({ answer: null, probes: 2 });
  });

  test('detect() answers within its bound while the probe hangs — the engine’s 10 s /health timeout is never the probe’s', async () => {
    const bin = obedientBin();
    let release: () => void = () => undefined;
    const hung = new Promise<void>(resolve => {
      release = resolve;
    });
    const { counted, run } = counting(async argv => {
      if (argv[1] !== 'debug') return null;
      await hung;
      return { exitCode: null, stdout: '', stderr: '', timedOut: true };
    });
    const seams: Seams = { bin, mode: 'none', run, operatorEnv: {} };
    const started = performance.now();
    const answer = await oc.detectOpencode(seams);
    const took = performance.now() - started;
    const bound = oc.OPENCODE_DETECT_WAIT_MS ?? Number.POSITIVE_INFINITY;
    expect({ answer, bound: bound <= 5_000, answered: took < bound + 2_000 }).toEqual({ answer: null, bound: true, answered: true });
    // The admission JOINS the probe in flight — the binary sees no second one — and, the hang
    // ended as a timeout, is refused RETRYABLE: a fact about this moment, not the binary.
    const admitted = codeOf(seams);
    release();
    expect({ code: await admitted, probes: counted.probes }).toEqual({ code: 'agent_cli_unproved', probes: 1 });
  }, 20_000);

  test('a probe question that TIMES OUT once: refused retryable (agent_cli_unproved), and the next admission admits', async () => {
    let timedOut = false;
    const { run } = counting(async argv => {
      if (argv[1] !== 'debug' || timedOut) return null;
      timedOut = true;
      return { exitCode: null, stdout: '', stderr: '', timedOut: true };
    });
    const seams: Seams = { bin: obedientBin(), mode: 'none', run, operatorEnv: {} };
    const first = await codeOf(seams);
    const second = await codeOf(seams);
    const retriable = TURN_ERROR_RETRIABLE[`confinement.${first}` as keyof typeof TURN_ERROR_RETRIABLE];
    expect({ first, retriable, second }).toEqual({ first: 'agent_cli_unproved', retriable: true, second: null });
    expect(TURN_ERROR_RETRIABLE['confinement.agent_cli_unsupported']).toBe(false);
  });

  test('a spawn the host refused for want of resources (EAGAIN) is retryable; a binary that is NOT THERE is not', async () => {
    let refused = false;
    const { run } = counting(async argv => {
      if (argv[1] !== 'debug' || refused) return null;
      refused = true;
      throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
    });
    const eagain = await codeOf({ bin: obedientBin(), mode: 'none', run, operatorEnv: {} });
    const missing = await opencodeModule.admitOpencode({ bin: join(scratchDir('no-opencode-'), 'opencode'), mode: 'none', operatorEnv: {} } as never).then(
      () => null,
      error => (error as ConfinementRefusedError).code,
    );
    expect({ eagain, missing }).toEqual({ eagain: 'agent_cli_unproved', missing: 'agent_cli_unsupported' });
  });

  test('`--version` or `run --help` that TIMES OUT once: refused retryable (agent_cli_unproved), and the next admission admits', async () => {
    // The doc and the reason-codes entry promise "a question past its bound is refused retryable"
    // for EVERY question the probe asks — not only the `debug` ones.
    for (const which of ['--version', 'run --help'] as const) {
      let timedOut = false;
      const { run } = counting(async argv => {
        const hit = which === '--version' ? argv[1] === '--version' : argv[1] === 'run' && argv[2] === '--help';
        if (!hit || timedOut) return null;
        timedOut = true;
        return { exitCode: null, stdout: '', stderr: '', timedOut: true };
      });
      const seams: Seams = { bin: obedientBin(), mode: 'none', run, operatorEnv: {} };
      expect({ which, first: await codeOf(seams), second: await codeOf(seams) }).toEqual({ which, first: 'agent_cli_unproved', second: null });
    }
  });

  test('a `--version` that answers NO version is the binary’s own answer: a proven defect, not retryable', async () => {
    const { run } = counting(async argv => (argv[1] === '--version' ? { exitCode: 0, stdout: 'opencode\n', stderr: '' } : null));
    expect(await codeOf({ bin: obedientBin(), mode: 'none', run, operatorEnv: {} })).toBe('agent_cli_unsupported');
  });

  test('a scratch tree the host refuses for a reason that is NOT a moment’s (a file where its directory goes) is a problem, not retryable', async () => {
    const root = scratchDir('oc-scratch-');
    writeFileSync(join(root, 'probe'), 'not a directory');
    const probe = await probeClosure(obedientBin(), root);
    expect({ transient: probe.transient, definitive: probe.definitive, named: probe.problems.join(' ').includes('scratch tree') }).toEqual({
      transient: false,
      definitive: false,
      named: true,
    });
  });

  test('two UNRESOLVABLE binaries asked at once are two questions: each refusal names its own binary', async () => {
    const [a, b] = [join(scratchDir('no-opencode-'), 'opencode'), join(scratchDir('no-opencode-'), 'opencode')];
    const messageOf = (bin: string) =>
      oc.admitOpencode({ bin, mode: 'none', run: counting().run, operatorEnv: {} }).then(
        () => 'admitted',
        error => String((error as Error).message),
      );
    const [ma, mb] = await Promise.all([messageOf(a), messageOf(b)]);
    expect({ aOwn: ma.includes(a) && !ma.includes(b), bOwn: mb.includes(b) && !mb.includes(a) }).toEqual({ aOwn: true, bOwn: true });
  });

  test('a timeout beside a PROVEN defect (run --help lacks --pure) is the defect: not retryable', async () => {
    const help = RUN_HELP.split('\n')
      .filter(line => !/^\s+--pure\s/.test(line))
      .join('\n');
    const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', { help });
    const { run } = counting(async argv => (argv[1] === 'debug' ? { exitCode: null, stdout: '', stderr: '', timedOut: true } : null));
    expect(await codeOf({ bin, mode: 'none', run, operatorEnv: {} })).toBe('agent_cli_unsupported');
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * O11 — the credential store is the daemon's statement (a wellknown entry is a config source)
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('O11 — the credential store: stated every turn, never a file a turn wrote; a remote configuration is refused', () => {
  const planted = (root: string) => {
    const store = join(root, 'unconfined', 'turn', 'state', 'data', 'opencode');
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'auth.json'), JSON.stringify({ 'http://127.0.0.1:9': { type: 'wellknown', key: 'K', token: 'T' } }));
  };

  test('positive control: the fake models the source — unrestricted by the key, a wellknown auth.json in the data dir merges its server’s MCP', () => {
    const bin = obedientBin();
    const root = scratchDir('oc-auth-ctl-');
    planted(root);
    const out = spawnSync(bin, ['debug', 'config'], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), XDG_DATA_HOME: join(root, 'unconfined', 'turn', 'state', 'data') },
      encoding: 'utf8',
    });
    expect(Object.keys(JSON.parse(out.stdout).mcp ?? {})).toContain('zextramcp');
  });

  test('every turn states OPENCODE_AUTH_CONTENT: empty without an operator store, the operator’s when given', async () => {
    const bin = obedientBin();
    workspace('oc-auth-env');
    const bare = (await opencodeTurnSetup(startOptions('oc-auth-env'), seams(bin))()) as { env?: Record<string, string>; cleanup?: () => Promise<void> };
    await bare.cleanup?.();
    const stated = '{"anthropic":{"type":"api","key":"sk-x"}}';
    const operator = (await opencodeTurnSetup(startOptions('oc-auth-env'), { bin, mode: 'none', operatorEnv: { OPENCODE_AUTH_CONTENT: stated } } as never)()) as {
      env?: Record<string, string>;
      cleanup?: () => Promise<void>;
    };
    await operator.cleanup?.();
    expect({ bare: bare.env?.OPENCODE_AUTH_CONTENT ?? '(absent)', operator: operator.env?.OPENCODE_AUTH_CONTENT ?? '(absent)' }).toEqual({ bare: '{}', operator: stated });
  });

  test('a wellknown credential a previous turn PLANTED in the turn’s persistent state reaches no turn', async () => {
    const bin = obedientBin();
    workspace('oc-auth-plant');
    const policy = nonePolicy();
    planted(policy.agentStateRoot as string);
    const { report } = await runTurn('oc-auth-plant', bin, policy);
    expect(report === null ? 'the fake never reported (no turn ran)' : 'reported').toBe('reported');
    // The run really had that state as its data dir — otherwise this asserts nothing.
    expect(report?.env?.XDG_DATA_HOME).toBe(join(policy.agentStateRoot as string, 'unconfined', 'turn', 'state', 'data'));
    expect((report?.loaded?.mcp ?? []).map((m: { name: string }) => m.name)).toEqual([MCP.name]);
  });

  test('an operator credential store with a wellknown entry (past boot, through the seam) is REFUSED at admission, naming what it adds', async () => {
    const bin = obedientBin();
    const refused = await opencodeModule
      .admitOpencode({ bin, mode: 'none', operatorEnv: { OPENCODE_AUTH_CONTENT: JSON.stringify({ 'http://127.0.0.1:9': { type: 'wellknown', key: 'K', token: 'T' } }) } } as never)
      .then(
        () => 'admitted',
        error => String((error as Error).message),
      );
    expect({ mcp: refused.includes('zextramcp'), agent: refused.includes('defines agents') }).toEqual({ mcp: true, agent: true });
  });

  test('the probe asks under the TURN’S persistent state (its data dir), not a fresh one', async () => {
    const bin = obedientBin();
    const root = scratchDir('oc-probe-turnstate-');
    const dataHomes = new Set<string>();
    const run = async (argv: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>> }) => {
      if (argv[1] === 'debug') dataHomes.add(String(options.env.XDG_DATA_HOME));
      const out = spawnSync(argv[0] as string, argv.slice(1) as string[], { cwd: options.cwd, env: { ...options.env }, encoding: 'utf8' });
      return { exitCode: out.status, stdout: out.stdout, stderr: out.stderr };
    };
    await probeClosure(bin, root, { run });
    expect([...dataHomes]).toEqual([join(root, 'unconfined', 'turn', 'state', 'data')]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * O13 — the probe asks under EXACTLY the turn child's environment; a console account is refused
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('O13 — the probe’s environment IS the turn child’s; a console account (a remote configuration no key closes) is refused every turn', () => {
  /** The turn's database under an agent state root (spelled here: the stated OPENCODE_DB under the turn state's data dir). */
  const turnDb = (root: string) => join(root, 'unconfined', 'turn', 'state', 'data', 'opencode', 'opencode.db');
  /** An opencode database with the account tables (1.18.32's names), optionally holding an account. */
  function plantDb(root: string, account: 'none' | 'active_org' | 'no_org' | 'control' = 'active_org'): void {
    const path = turnDb(root);
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true });
    db.run('CREATE TABLE account (id text PRIMARY KEY, email text, url text)');
    db.run('CREATE TABLE account_state (id integer PRIMARY KEY, active_account_id text, active_org_id text)');
    db.run('CREATE TABLE control_account (email text, url text)');
    if (account === 'active_org' || account === 'no_org') {
      db.run("INSERT INTO account VALUES ('acc1', 'a@b', 'https://console.example')");
      db.run(`INSERT INTO account_state VALUES (1, 'acc1', ${account === 'active_org' ? "'org1'" : 'NULL'})`);
    }
    if (account === 'control') db.run("INSERT INTO control_account VALUES ('a@b', 'https://console.example')");
    db.close();
  }
  /**
   * Every leg here spawns the fake binary (each spawn a bun start) — 2 for the positive control,
   * many more for a probe or a turn. Idle the control takes ~0.4 s; under the full concurrent gate
   * (pre-push at 587432b715, hermetic beside db + instance) it ran 5357 ms and bun's 5000 ms
   * built-in cap killed it with no bug behind it. The heavier legs carry the same exposure. A
   * measured bound for this describe, not a package-wide widening (scripts/lib/test_flags.ts keeps
   * the daemon packages on the default).
   */
  const SPAWN_BOUND_MS = 20_000;
  const record = (sink: (env: Record<string, string>) => void) => async (argv: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>> }) => {
    sink({ ...options.env });
    const out = spawnSync(argv[0] as string, argv.slice(1) as string[], { cwd: options.cwd, env: { ...options.env }, encoding: 'utf8' });
    return { exitCode: out.status, stdout: out.stdout, stderr: out.stderr };
  };

  test('positive control: the fake models the source — an active org merges its server’s MCP only when the network is reachable (no proxy)', () => {
    const bin = obedientBin();
    const root = scratchDir('oc-org-ctl-');
    plantDb(root);
    const env = { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), XDG_DATA_HOME: join(root, 'unconfined', 'turn', 'state', 'data') };
    const mcp = (extra: Record<string, string>) =>
      Object.keys(JSON.parse(spawnSync(bin, ['debug', 'config'], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' }).stdout).mcp ?? {});
    expect({ open: mcp({}).includes('zorgmcp'), proxied: mcp(childEgressEnv('turn')).includes('zorgmcp') }).toEqual({ open: true, proxied: false });
  }, SPAWN_BOUND_MS);

  test('the restricted leg asks under the TURN CHILD’s environment: same keys but the offline one, same values but the per-run HOME and the stated configuration, no proxy', async () => {
    const bin = obedientBin();
    const policy = nonePolicy();
    const root = policy.agentStateRoot as string;
    workspace('oc-env-eq');
    const { report } = await runTurn('oc-env-eq', bin, policy, { PATH: process.env.PATH ?? '/usr/bin:/bin' });
    expect(report === null ? 'the fake never reported (no turn ran)' : 'reported').toBe('reported');
    const turn = (report?.allEnv ?? {}) as Record<string, string>;
    let restricted: Record<string, string> = {};
    await probeClosure(bin, root, {
      // The operator's environment as the turn's setup reads it (the config's OPENCODE_ENV).
      operatorEnv: undefined,
      run: record(env => {
        if (env.OPENCODE_PURE === '1' && env.OPENCODE_DISABLE_PROJECT_CONFIG === '1') restricted = env;
      }),
    });
    const offline = ['npm_config_offline'];
    const differing = ['HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_CONTENT'];
    expect({
      onlyInProbe: Object.keys(restricted).filter(key => !(key in turn)).sort(),
      onlyInTurn: Object.keys(turn).filter(key => !(key in restricted)).sort(),
      valuesDiffer: Object.keys(turn)
        .filter(key => key in restricted && turn[key] !== restricted[key])
        .sort(),
      proxy: ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].filter(key => key in turn || key in restricted),
    }).toEqual({ onlyInProbe: offline, onlyInTurn: [], valuesDiffer: [...differing].sort(), proxy: [] });
    // …and the turn carries the driver's statement under `none`: the traffic switches, the database.
    expect(Object.fromEntries([...Object.keys(TRAFFIC), 'OPENCODE_DB'].map(key => [key, turn[key] ?? '(absent)']))).toEqual({ ...TRAFFIC, OPENCODE_DB: 'opencode.db' });
  }, SPAWN_BOUND_MS);

  test('the probe asks with the turn’s own network: an org configuration a dead proxy would have hidden is NAMED', async () => {
    const root = scratchDir('oc-org-probe-');
    plantDb(root);
    const probe = await probeClosure(obedientBin(), root);
    expect({ refused: probe.problems.length > 0, transient: probe.transient, named: probe.problems.join(' ').includes('zorgmcp') }).toEqual({
      refused: true,
      transient: false,
      named: true,
    });
  }, SPAWN_BOUND_MS);

  test('a console account refuses admission, detect and the turn — after a probe that ADMITTED (never cached)', async () => {
    const bin = obedientBin();
    const policy = nonePolicy();
    const root = policy.agentStateRoot as string;
    const seamsAt = { bin, mode: 'none', operatorEnv: {}, stateRoot: root } as never;
    const admit = () =>
      opencodeModule.admitOpencode(seamsAt).then(
        () => null,
        error => ({ code: (error as ConfinementRefusedError).code, names: String((error as Error).message).includes('console account') }),
      );
    expect(await admit()).toBeNull();
    plantDb(root);
    expect({ admit: await admit(), detect: await opencodeModule.detectOpencode(seamsAt) }).toEqual({
      admit: { code: 'agent_cli_unsupported', names: true },
      detect: null,
    });
    workspace('oc-account');
    const opts = startOptions('oc-account');
    const events = await drain(spawnAgentProcess(opts, opencodeTurnSetup(opts, seamsAt), policy).events);
    const error = events.find(event => event.type === 'error');
    expect({ reason: error?.type === 'error' ? error.reason : null, ran: opencodeLoadReport(texts(events)) !== null }).toEqual({
      reason: 'confinement.agent_cli_unsupported',
      ran: false,
    });
  }, SPAWN_BOUND_MS);

  test('the account question on every shape of the database: absent or empty admits; any account, an old control account, an unreadable file refuse', () => {
    const ask = (setup: (root: string) => void) => {
      const root = scratchDir('oc-account-shape-');
      setup(root);
      const problem = opencodeModule.opencodeConsoleAccountProblem(root);
      return problem === null ? 'admitted' : problem.transient ? 'retryable' : 'refused';
    };
    expect({
      absent: ask(() => undefined),
      empty: ask(root => plantDb(root, 'none')),
      activeOrg: ask(root => plantDb(root, 'active_org')),
      noOrg: ask(root => plantDb(root, 'no_org')),
      control: ask(root => plantDb(root, 'control')),
      notSqlite: ask(root => {
        mkdirSync(dirname(turnDb(root)), { recursive: true });
        writeFileSync(turnDb(root), 'not a database');
      }),
      noTables: ask(root => {
        mkdirSync(dirname(turnDb(root)), { recursive: true });
        new Database(turnDb(root), { create: true }).close();
      }),
      directory: ask(root => mkdirSync(turnDb(root), { recursive: true })),
      // A clean database behind a LINK, and a FIFO (whose read-only open would block admission —
      // the daemon's event loop — until a writer came): neither is a regular file, neither is read.
      link: ask(root => {
        const elsewhere = scratchDir('oc-account-elsewhere-');
        plantDb(elsewhere, 'none');
        mkdirSync(dirname(turnDb(root)), { recursive: true });
        symlinkSync(turnDb(elsewhere), turnDb(root));
      }),
      fifo: ask(root => {
        mkdirSync(dirname(turnDb(root)), { recursive: true });
        expect(spawnSync('mkfifo', [turnDb(root)]).status).toBe(0);
      }),
    }).toEqual({
      absent: 'admitted',
      empty: 'admitted',
      activeOrg: 'refused',
      noOrg: 'refused',
      control: 'refused',
      notSqlite: 'refused',
      noTables: 'refused',
      directory: 'refused',
      link: 'refused',
      fifo: 'refused',
    });
  });

  test('a binary that does not open the database the daemon states (OPENCODE_DB ignored), or cannot say which, is refused by the probe — the account check would read another file', async () => {
    for (const fake of [{ ignoreDbKey: true }, { noDbCommand: true }] as const) {
      const bin = writeFakeOpencode(scratchDir('fake-opencode-'), 'opencode', fake);
      const probe = await probeClosure(bin, scratchDir('oc-db-'));
      expect({ fake, refused: probe.problems.length > 0, transient: probe.transient, named: probe.problems.join(' ').includes("'db path'") }).toEqual({
        fake,
        refused: true,
        transient: false,
        named: true,
      });
    }
  }, SPAWN_BOUND_MS);
});

describe('O3b (behavioural) — the operator’s environment cannot reopen a permission, and the probe asks under it', () => {
  test('an operator OPENCODE_PERMISSION={"bash":"allow"} reaches the CLI under the daemon’s: bash resolves deny', async () => {
    const bin = obedientBin();
    workspace('oc-perm');
    const opts = startOptions('oc-perm');
    const events = await drain(
      spawnAgentProcess(opts, opencodeTurnSetup(opts, { bin, mode: 'none', operatorEnv: { OPENCODE_PERMISSION: '{"bash":"allow"}' } } as never), nonePolicy()).events,
    );
    const report = opencodeLoadReport(texts(events));
    expect(report?.loaded?.permission?.bash ?? 'no turn').toBe('deny');
  });

  test('the probe’s restricted questions carry the operator’s environment, under the restriction', async () => {
    const bin = obedientBin();
    const envs: Array<Record<string, string>> = [];
    const run = async (argv: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>> }) => {
      if (argv[1] === 'debug') envs.push({ ...options.env });
      const out = spawnSync(argv[0] as string, argv.slice(1) as string[], { cwd: options.cwd, env: { ...options.env }, encoding: 'utf8' });
      return { exitCode: out.status, stdout: out.stdout, stderr: out.stderr };
    };
    await probeClosure(bin, scratchDir('oc-probe-state-'), { run, operatorEnv: { ANTHROPIC_API_KEY: 'sk-operator' } });
    const restricted = envs.filter(env => env.OPENCODE_PURE === '1');
    expect({
      asked: restricted.length,
      operator: restricted.every(env => env.ANTHROPIC_API_KEY === 'sk-operator'),
      permission: restricted.every(env => JSON.parse(env.OPENCODE_PERMISSION ?? 'null')?.bash === 'deny'),
    }).toEqual({ asked: 3, operator: true, permission: true });
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * O9 — the brief is the daemon's, the ONE instruction file
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('O9 — the brief: written by the daemon into .builder/, the one instruction file, gone after the turn', () => {
  test('instructions === [<.builder brief>], its content the bounded read; a workspace opencode.json instruction is not loaded', async () => {
    const bin = obedientBin();
    const ws = workspace('oc-brief');
    // A site workspace carries the daemon's `.builder` (made at site creation, 0710).
    await mkdirPrivate(roots.sitesRoot, join('oc-brief', '.builder'));
    writeFileSync(join(ws, 'AGENTS.md'), '# BRIEF_MARKER the site rules\n');
    writeFileSync(join(ws, 'opencode.json'), JSON.stringify({ instructions: ['WS_INSTRUCTION.md'] }));
    const opts = startOptions('oc-brief');
    let seen: { instructions?: string[] } = {};
    let briefBody = '';
    const plan = await opencodeTurnSetup(opts, seams(bin))();
    const content = JSON.parse(plan.env?.OPENCODE_CONFIG_CONTENT ?? '{}');
    seen = content;
    briefBody = readFileSync(String(content.instructions?.[0]), 'utf8');
    await plan.cleanup?.();
    expect({ instructions: seen.instructions, body: briefBody }).toEqual({ instructions: [join(ws, '.builder', 'opencode-brief.md')], body: '# BRIEF_MARKER the site rules\n' });
    expect(existsSync(join(ws, '.builder', 'opencode-brief.md'))).toBe(false);
    // Through a whole turn: the CLI resolves exactly that file, never the workspace's own instruction.
    const events = await drain(spawnAgentProcess(opts, opencodeTurnSetup(opts, seams(bin)), nonePolicy()).events);
    const report = opencodeLoadReport(texts(events));
    expect(report?.loaded?.instructions ?? 'no turn').toEqual([join(ws, '.builder', 'opencode-brief.md')]);
    expect(existsSync(join(ws, '.builder', 'opencode-brief.md'))).toBe(false);
  });

  test('a symlinked AGENTS.md is refused (never read through), and nothing is written', async () => {
    const bin = obedientBin();
    const ws = workspace('oc-brief-link');
    await mkdirPrivate(roots.sitesRoot, join('oc-brief-link', '.builder'));
    const secret = join(scratchDir('oc-secret-'), 'daemon-secret');
    writeFileSync(secret, 'DAEMON_SECRET');
    symlinkSync(secret, join(ws, 'AGENTS.md'));
    const refused = await opencodeTurnSetup(startOptions('oc-brief-link'), seams(bin))().then(
      () => null,
      error => error,
    );
    expect(refused).not.toBeNull();
    expect(existsSync(join(ws, '.builder', 'opencode-brief.md'))).toBe(false);
  });

  test('the leaf refuses an instruction path that is not one absolute path without glob characters', async () => {
    const module = await leaf();
    expect(() => module.opencodeDaemonConfig(MCP, ['/w/.builder/opencode-brief.md'])).not.toThrow();
    for (const bad of ['relative.md', '/w/*.md', '/w/[ab].md', '/w/{a,b}.md']) expect(() => module.opencodeDaemonConfig(MCP, [bad])).toThrow();
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * O10 — phase B is derived
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('O10 — the systemd_scope refusal is DERIVED: the .config mount alone does not lift it', () => {
  const verdict = (phaseB: { configSubdirs: readonly string[]; cache: 'undecided' | 'decided' }) => {
    try {
      (opencodeModule.assertOpencodeConfinable as (mode: string, phaseB: unknown) => void)('systemd_scope', phaseB);
      return 'lifted';
    } catch (error) {
      return (error as ConfinementRefusedError).code;
    }
  };
  test('today: refused; with the mount alone or the cache alone: refused; with both: lifted', () => {
    expect({
      today: verdict({ configSubdirs: [], cache: 'undecided' }),
      mountOnly: verdict({ configSubdirs: ['opencode'], cache: 'undecided' }),
      cacheOnly: verdict({ configSubdirs: [], cache: 'decided' }),
      both: verdict({ configSubdirs: ['opencode'], cache: 'decided' }),
    }).toEqual({ today: 'agent_cli_unsupported', mountOnly: 'agent_cli_unsupported', cacheOnly: 'agent_cli_unsupported', both: 'lifted' });
    // And the defaults are today's: the constants, not a flag.
    expect(opencodeModule.OPENCODE_CONFINED_CACHE).toBe('undecided');
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * Every registered driver is classified by a PLANT closure
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('cross-driver census — no registered driver runs a turn its PLANT closure has not proved', () => {
  test('claude_code and opencode refuse a CLI that cannot be restricted; pi runs no turn at all', async () => {
    const ids: string[] = (await detectDrivers()).map(driver => driver.id as string).sort();
    const CLASSIFIED = ['claude_code', 'opencode', 'pi'];
    expect(ids).toEqual(CLASSIFIED);
    const dir = scratchDir('census-');
    const legacyClaude = writeFakeClaude(dir, 'claude-legacy', { version: '2.0.1', help: LEGACY_HELP, tolerateUnknown: true });
    const claude = await assertClaudeCliConfinable(legacyClaude).then(
      () => null,
      error => (error as ConfinementRefusedError).code,
    );
    const admitOpencode = (opencodeModule as unknown as { admitOpencode?: (o: { bin: string; mode: string }) => Promise<void> }).admitOpencode;
    const planting = writeFakeOpencode(dir, 'opencode-planting', { ignore: 'OPENCODE_DISABLE_PROJECT_CONFIG' });
    const opencode = admitOpencode
      ? await admitOpencode({ bin: planting, mode: 'none' }).then(
          () => null,
          error => (error as ConfinementRefusedError).code,
        )
      : 'admitOpencode is not exported';
    let pi: string | null = null;
    try {
      piDriver.startTurn(startOptions('census-pi'));
    } catch {
      pi = 'no turn';
    }
    expect({ claude, opencode, pi }).toEqual({ claude: 'agent_cli_unsupported', opencode: 'agent_cli_unsupported', pi: 'no turn' });
  });
});
