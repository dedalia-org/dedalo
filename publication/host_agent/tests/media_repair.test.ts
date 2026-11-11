/**
 * The copy-mode BOOT REPAIR (src/media/repair.ts) and the applied-mode door it shares with
 * every put and mark (src/media/fs_modes.ts). Trees built here as the pre-fix agent left them
 * under UMask=0027: dirs 0750, markers 0640, plus an operator-widened 0755 `copy/`. Ownership
 * is injected (`Ownership`): the foreign-owner branch cannot be produced honestly by a suite
 * that runs as one user (or as root). Generic `test` TLD names; scratch roots from
 * tests/fixtures/instance. That index.ts RUNS the repair is tests/index_process.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAudit } from '../src/audit';
import { ApiError } from '../src/errors';
import { INCOMING_DIR } from '../src/media/copy';
import { ensureDirExact, PRIVATE_DIR_MODE, PUBLIC_DIR_MODE } from '../src/media/fs_modes';
import { PUB_DIR } from '../src/media/probe';
import { REPAIR_LIST_CAP, type RepairReport, repairCopyRoot, repairMediaAtBoot } from '../src/media/repair';
import { COPY_STATE_DIR } from '../src/media/sha_index';
import { resetInstance, roots, scratchPath } from './fixtures/instance';

const ROOT = roots.mediaRoot as string;
const OUTSIDE = 'outside_repair';
const DARK_DIRS = ['image', 'image/1.5MB', 'image/1.5MB/0', 'av', 'av/404', '.publication', PUB_DIR];
const PRIVATE_DIRS = [COPY_STATE_DIR, INCOMING_DIR];
const MARKERS = [join(PUB_DIR, 'test3_1'), join(PUB_DIR, 'test3_2')];
const MEDIA_FILE = 'image/1.5MB/0/test99_test3_1.jpg';
const COPY = { MEDIA_MODE: 'copy', MEDIA_ROOT: ROOT } as const;

function modeOf(rel: string): number {
  return statSync(join(ROOT, rel)).mode & 0o777;
}
function modes(paths: string[]): Record<string, number> {
  return Object.fromEntries(paths.map(path => [path, modeOf(path)]));
}
function all(paths: string[], mode: number): Record<string, number> {
  return Object.fromEntries(paths.map(path => [path, mode]));
}
function report(over: Partial<RepairReport> = {}): RepairReport {
  return { dirs_fixed: 0, markers_fixed: 0, foreign: [], foreign_more: 0, failed: [], failed_more: 0, ...over };
}

/** The tree a pre-fix copy host holds: dark dirs and markers, a widened copy/, one healthy dir, a symlinked dir. */
function buildDarkTree(): string {
  for (const dir of [...DARK_DIRS, ...PRIVATE_DIRS, 'image/thumb']) mkdirSync(join(ROOT, dir), { recursive: true });
  for (const dir of DARK_DIRS) chmodSync(join(ROOT, dir), 0o750);
  for (const dir of PRIVATE_DIRS) chmodSync(join(ROOT, dir), 0o755);
  chmodSync(join(ROOT, 'image/thumb'), 0o755);
  for (const marker of MARKERS) {
    writeFileSync(join(ROOT, marker), '');
    chmodSync(join(ROOT, marker), 0o640);
  }
  writeFileSync(join(ROOT, MEDIA_FILE), 'jpeg');
  chmodSync(join(ROOT, MEDIA_FILE), 0o644);
  const outside = scratchPath(OUTSIDE);
  mkdirSync(join(outside, 'deeper'), { recursive: true });
  chmodSync(outside, 0o750);
  chmodSync(join(outside, 'deeper'), 0o750);
  symlinkSync(outside, join(ROOT, 'image', 'linked'));
  return outside;
}

beforeEach(resetInstance);
afterEach(() => {
  rmSync(scratchPath(OUTSIDE), { recursive: true, force: true });
});

describe('repairCopyRoot — the boot pass', () => {
  test('a dark tree is opened (0755), copy/ pulled back (0700), markers 0644; a symlinked dir is not followed', async () => {
    const outside = buildDarkTree();
    expect(await repairCopyRoot(ROOT)).toEqual(report({ dirs_fixed: 9, markers_fixed: 2 }));
    expect(modes([...DARK_DIRS, 'image/thumb'])).toEqual(all([...DARK_DIRS, 'image/thumb'], 0o755));
    expect(modes(PRIVATE_DIRS)).toEqual(all(PRIVATE_DIRS, 0o700));
    expect(modes(MARKERS)).toEqual(all(MARKERS, 0o644));
    expect(modeOf(MEDIA_FILE)).toBe(0o644);
    expect([statSync(outside).mode & 0o777, statSync(join(outside, 'deeper')).mode & 0o777]).toEqual([0o750, 0o750]);
  });

  test('a healthy tree is zero writes: the second pass fixes nothing', async () => {
    buildDarkTree();
    await repairCopyRoot(ROOT);
    expect(await repairCopyRoot(ROOT)).toEqual(report());
  });

  test('a dark dir the agent does not own is reported, never chmodded, and its subtree still repaired', async () => {
    buildDarkTree();
    const foreignAv = join(ROOT, 'av');
    expect(await repairCopyRoot(ROOT, (_st, path) => path !== foreignAv)).toEqual(
      report({ dirs_fixed: 8, markers_fixed: 2, foreign: [foreignAv] }),
    );
    expect([modeOf('av'), modeOf('av/404')]).toEqual([0o750, 0o755]);
  });

  test('a foreign level whose mode MEETS the need is not reported: o+x on a public dir (0775), no group/other bit on copy/', async () => {
    mkdirSync(join(ROOT, 'image'), { recursive: true });
    mkdirSync(join(ROOT, COPY_STATE_DIR), { recursive: true });
    chmodSync(join(ROOT, 'image'), 0o775);
    chmodSync(join(ROOT, '.publication'), 0o711);
    chmodSync(join(ROOT, COPY_STATE_DIR), 0o500);
    expect(await repairCopyRoot(ROOT, () => false)).toEqual(report());
    expect([modeOf('image'), modeOf('.publication'), modeOf(COPY_STATE_DIR)]).toEqual([0o775, 0o711, 0o500]);
  });

  test('a foreign private copy/ that grants group or other bits IS reported', async () => {
    mkdirSync(join(ROOT, COPY_STATE_DIR), { recursive: true });
    chmodSync(join(ROOT, '.publication'), 0o755);
    chmodSync(join(ROOT, COPY_STATE_DIR), 0o750);
    expect(await repairCopyRoot(ROOT, () => false)).toEqual(report({ foreign: [join(ROOT, COPY_STATE_DIR)] }));
  });

  test(`the lists are BOUNDED: the first ${REPAIR_LIST_CAP} paths, the rest counted`, async () => {
    for (let i = 0; i < REPAIR_LIST_CAP + 7; i++) {
      const dir = join(ROOT, 'image', `q${String(i).padStart(2, '0')}`);
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o750);
    }
    const imageDir = join(ROOT, 'image');
    const result = await repairCopyRoot(ROOT, (_st, path) => path === imageDir);
    expect(result.foreign.length).toBe(REPAIR_LIST_CAP);
    expect(result.foreign_more).toBe(7);
    expect(new Set(result.foreign).size).toBe(REPAIR_LIST_CAP);
  });

  test.if(process.getuid?.() !== 0)(
    'an unopenable dir (0000) is a failed entry with its errno; the rest is repaired; the pass resolves',
    async () => {
      buildDarkTree();
      const locked = join(ROOT, 'av', '404');
      chmodSync(locked, 0o000);
      try {
        const result = await repairMediaAtBoot(COPY);
        expect(result?.failed).toEqual([{ path: locked, error: 'EACCES' }]);
        expect(result?.dirs_fixed).toBe(8);
        expect(modes(['image', 'av', PUB_DIR])).toEqual(all(['image', 'av', PUB_DIR], 0o755));
        expect((await readAudit())[0]).toMatchObject({ action: 'media.repair', outcome: 'failed' });
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe('repairMediaAtBoot — the audited step', () => {
  test('copy mode: one media.repair row with the exact counts; a healthy reboot writes no row', async () => {
    buildDarkTree();
    const before = (await readAudit()).length;
    expect(await repairMediaAtBoot(COPY)).toEqual(report({ dirs_fixed: 9, markers_fixed: 2 }));
    const trail = await readAudit();
    expect(trail.length).toBe(before + 1);
    expect(trail[0]).toMatchObject({
      actor: 'agent.boot',
      action: 'media.repair',
      outcome: 'ok',
      detail: { root: ROOT, ...report({ dirs_fixed: 9, markers_fixed: 2 }) },
    });
    await repairMediaAtBoot(COPY);
    expect((await readAudit()).length).toBe(before + 1);
  });

  test('a foreign dark dir does not fail the step: the row is outcome failed and names it', async () => {
    buildDarkTree();
    const foreignPub = join(ROOT, PUB_DIR);
    const result = await repairMediaAtBoot(COPY, (_st, path) => path !== foreignPub);
    expect(result?.foreign).toEqual([foreignPub]);
    expect((await readAudit())[0]).toMatchObject({ action: 'media.repair', outcome: 'failed', detail: { foreign: [foreignPub] } });
  });

  test('shared and none hosts, and an absent copy root, repair nothing', async () => {
    buildDarkTree();
    expect(await repairMediaAtBoot({ MEDIA_MODE: 'shared', MEDIA_ROOT: ROOT })).toBeNull();
    expect(await repairMediaAtBoot({ MEDIA_MODE: 'none' })).toBeNull();
    expect(await repairMediaAtBoot({ MEDIA_MODE: 'copy', MEDIA_ROOT: join(ROOT, 'absent') })).toBeNull();
    expect(modeOf('image')).toBe(0o750);
  });
});

describe('ensureDirExact — the put/mark door', () => {
  function refusalOf(fn: () => void): ApiError {
    try {
      fn();
    } catch (error) {
      if (error instanceof ApiError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  test('a dark level the agent does not own refuses with its own reason (409 media_level_foreign) and is left as it is', () => {
    mkdirSync(join(ROOT, 'image', '1.5MB'), { recursive: true });
    chmodSync(join(ROOT, 'image'), 0o750);
    const error = refusalOf(() => ensureDirExact(ROOT, 'image/1.5MB', PUBLIC_DIR_MODE, () => false));
    expect([error.status, error.extensions?.reason]).toEqual([409, 'media_level_foreign']);
    expect(modeOf('image')).toBe(0o750);
  });

  test('a foreign private level granting group/other bits is refused the same way', () => {
    mkdirSync(join(ROOT, COPY_STATE_DIR), { recursive: true });
    chmodSync(join(ROOT, COPY_STATE_DIR), 0o755);
    const error = refusalOf(() => ensureDirExact(join(ROOT, '.publication'), 'copy', PRIVATE_DIR_MODE, () => false));
    expect(error.extensions?.reason).toBe('media_level_foreign');
  });

  test('a foreign level that meets the need (0775: o+x) is fine — nothing to fight over', () => {
    mkdirSync(join(ROOT, 'image', '1.5MB'), { recursive: true });
    chmodSync(join(ROOT, 'image'), 0o775);
    chmodSync(join(ROOT, 'image', '1.5MB'), 0o755);
    ensureDirExact(ROOT, 'image/1.5MB', PUBLIC_DIR_MODE, () => false);
    expect(modes(['image', 'image/1.5MB'])).toEqual({ image: 0o775, 'image/1.5MB': 0o755 });
  });
});
