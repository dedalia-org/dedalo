/**
 * Process entry: boot through ONE order (src/boot.ts), serve, drain on SIGTERM.
 *
 * Shape copied from publication/site_builder/src/index.ts (top-level catch, request log,
 * drain within a grace shorter than the unit's TimeoutStopSec=30, socket removed on exit),
 * without the session/confinement steps.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { type AgentServer, bootSequence, claimListenTarget, drainServer, listenTarget, startServer } from './boot';
import { config } from './config';
import { bootPreflight } from './instance/roots';
import { repairMediaAtBoot } from './media/repair';
import { routeRequest } from './router';
import { problem } from './util/response';

const SHUTDOWN_GRACE_MS = 25_000; // < the unit's TimeoutStopSec=30 (render/unit_agent.ts)

let server: AgentServer | null = null;

async function handle(req: Request): Promise<Response> {
  const start = performance.now();
  let res: Response;
  try {
    res = await routeRequest(req);
  } catch (error) {
    res = problem(error); // router.ts renders known errors; this is the last-resort net
  }
  if (res.status >= 500 || config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'info') {
    console.log(`${req.method} ${new URL(req.url).pathname} ${res.status} ${(performance.now() - start).toFixed(1)}ms`);
  }
  return res;
}

try {
  await bootSequence({
    preflight: () => bootPreflight(config),
    claimListenTarget: () => claimListenTarget(listenTarget(config)),
    listen: () => {
      server = startServer(config, handle);
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const where = config.LISTEN_KIND === 'unix' ? `unix socket ${config.SOCKET_PATH}` : `mTLS ${config.TLS_HOST}:${config.TLS_PORT}`;
console.log(`Dédalo publication host agent listening on ${where}`);

// The copy-mode media repair (T0-6, media/repair.ts): AFTER the listener, a streaming walk that
// never holds the event loop and never rejects; puts converge on the same modes. Its
// `[media.repair]` line closes the pass (gate: tests/index_process.test.ts).
void repairMediaAtBoot(config);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}: draining (up to ${SHUTDOWN_GRACE_MS} ms)`);
  const left = server ? await drainServer(server, SHUTDOWN_GRACE_MS) : 0;
  if (left > 0) console.warn(`[shutdown] ${left} request(s) still in flight after the grace; they are cut.`);
  if (config.LISTEN_KIND === 'unix' && config.SOCKET_PATH && existsSync(config.SOCKET_PATH)) {
    try {
      unlinkSync(config.SOCKET_PATH);
    } catch (error) {
      console.error('[shutdown] could not remove the socket:', error);
    }
  }
  console.log('[shutdown] done');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
