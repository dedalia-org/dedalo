/**
 * THE SUITE DECLARES ITS CHECKOUT before any test module loads (bunfig.toml [test] preload).
 *
 * src/config.ts falls back to the committed `.env.test` under NODE_ENV=test only in a
 * checkout whose `.test-tmp/` is a real directory owned by this uid holding a real instance
 * marker (TEST_SCRATCH_MARKER) — so a DEPLOYED checkout, which has none, never boots in test
 * mode (tests/deployed_test_mode.test.ts). The fixture (tests/fixtures/instance.ts) cannot
 * plant it: it imports the config, which resolves at import. So this file does, importing
 * only the naming module (never src/config.ts).
 *
 * It never wipes: a non-empty `.test-tmp/` that does not declare the suite's instance is left
 * alone, and the config then refuses loudly — the fixture's assertDestroyable law, unchanged.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTANCE_MARKER, markerContent } from '../src/instance/roots';

/** Must equal tests/fixtures/instance.ts INSTANCE (pinned by tests/deployed_test_mode.test.ts). */
export const PRELOAD_INSTANCE = 'test';

const scratch = join(import.meta.dir, '..', '.test-tmp');
const marker = join(scratch, INSTANCE_MARKER);
const declared = existsSync(marker) && readFileSync(marker, 'utf8') === markerContent(PRELOAD_INSTANCE);
if (!declared && (!existsSync(scratch) || readdirSync(scratch).length === 0)) {
  mkdirSync(scratch, { recursive: true });
  // Exclusive create: no exists-then-write window — a concurrent preload that won
  // the race wrote the same declaration, and an existing marker is never replaced.
  try {
    writeFileSync(marker, markerContent(PRELOAD_INSTANCE), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
