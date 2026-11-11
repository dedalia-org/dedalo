/**
 * THE PROCESS ENTRY, end to end: `bun run src/index.ts` under NODE_ENV=test boots against
 * the fixture's state root, serves /health on its unix socket at 0660, and on SIGTERM
 * drains, removes the socket and exits 0. And in COPY mode (a named env file, the suite's own
 * roots) the process REPAIRS the media tree after it listens (T0-6): a 0750 dir and a 0640
 * marker come back 0755/0644 with exactly one media.repair audit row; a second boot writes none.
 * The repair is gated as the outcome of `src/index.ts`, not by its spelling.
 */
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readAudit } from '../src/audit';
import { ENV_FILE_VAR, config } from '../src/config';
import { BASE_PATH } from '../src/router';
import { freshScratch, resetInstance, roots } from './fixtures/instance';

const PACKAGE_DIR = join(import.meta.dir, '..');

test('boots, serves, and drains on SIGTERM', async () => {
  expect(config.LISTEN_KIND).toBe('unix'); // .env.test contract (Task 1)
  const socket = config.SOCKET_PATH as string;
  await resetInstance(); // marked state root + empty socket directory

  const child = Bun.spawn([process.execPath, 'run', 'src/index.ts'], {
    cwd: PACKAGE_DIR,
    env: { NODE_ENV: 'test', PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  try {
    let status = 0;
    for (let i = 0; i < 100 && status !== 200; i++) {
      try {
        status = (await fetch(`http://localhost${BASE_PATH}/health`, { unix: socket })).status;
      } catch {
        await Bun.sleep(50);
      }
    }
    expect(status).toBe(200);
    expect(statSync(socket).mode & 0o777).toBe(0o660);

    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    expect(existsSync(socket)).toBe(false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}, 15_000);

/** .env.test with MEDIA_MODE=copy and every relative path made absolute (a named env file). */
async function copyModeEnvFile(): Promise<string> {
  const text = readFileSync(join(PACKAGE_DIR, '.env.test'), 'utf8')
    .replace(/^MEDIA_MODE=.*$/m, 'MEDIA_MODE=copy')
    .replaceAll('=./', `=${PACKAGE_DIR}/`);
  const file = join(await freshScratch('copyenv'), 'agent.env');
  writeFileSync(file, text);
  return file;
}

/** Boot the process in copy mode, wait for its `[media.repair]` line, SIGTERM it, expect exit 0. */
async function bootCopyAgentOnce(envFile: string): Promise<string> {
  const child = Bun.spawn([process.execPath, 'run', 'src/index.ts'], {
    cwd: PACKAGE_DIR,
    env: { [ENV_FILE_VAR]: envFile, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let out = '';
    const deadline = Bun.sleep(10_000).then(() => ({ value: undefined, done: true }) as const);
    while (!out.includes('[media.repair]')) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      out += decoder.decode(value);
    }
    reader.releaseLock();
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    return out;
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

test('copy mode: the process repairs the media tree after it listens, once; a healthy reboot writes no row', async () => {
  await resetInstance();
  const media = roots.mediaRoot as string;
  mkdirSync(join(media, 'image', '1.5MB', '0'), { recursive: true });
  mkdirSync(join(media, '.publication', 'pub'), { recursive: true });
  writeFileSync(join(media, '.publication', 'pub', 'test3_1'), '');
  chmodSync(join(media, 'image', '1.5MB'), 0o750);
  chmodSync(join(media, '.publication', 'pub'), 0o750);
  chmodSync(join(media, '.publication', 'pub', 'test3_1'), 0o640);
  const envFile = await copyModeEnvFile();
  const repairRows = async () => (await readAudit()).filter(entry => entry.action === 'media.repair');

  const first = await bootCopyAgentOnce(envFile);
  expect(first).toContain('listening');
  expect(first).toContain('[media.repair]');
  const modes = ['image/1.5MB', '.publication/pub', '.publication/pub/test3_1'].map(rel => statSync(join(media, rel)).mode & 0o777);
  expect(modes).toEqual([0o755, 0o755, 0o644]);
  expect((await repairRows()).map(row => [row.outcome, row.detail?.dirs_fixed, row.detail?.markers_fixed])).toEqual([['ok', 2, 1]]);

  expect(await bootCopyAgentOnce(envFile)).toContain('[media.repair]');
  expect((await repairRows()).length).toBe(1);
}, 30_000);
