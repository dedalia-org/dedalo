/**
 * THE BOOT ORDER and the listener, as functions a gate can hold (`index.ts` is the process
 * entry and binds at import, so it cannot be imported by a test).
 *
 *   1. PREFLIGHT — instance/roots.ts bootPreflight: whose state root, writable, not root,
 *      audit trail append-only.
 *   2. CLAIM THE LISTEN TARGET — a socket or port that already answers means another agent
 *      holds this instance: refuse. A unix socket file nobody answers on is a corpse and is
 *      removed; any other file at that path is refused, never unlinked.
 *   3. LISTEN — unix (chmod 0660 right after the bind) or mTLS. TLS boot READS the three
 *      files itself and refuses when any is missing, unreadable or not PEM, and the verify
 *      flags are constants (MTLS_VERIFY): no configuration can produce a TCP listener that
 *      accepts a client without a certificate from the pinned CA.
 *   4. AFTER LISTEN (index.ts) — on a copy-mode host, the media mode repair
 *      (media/repair.ts: a streaming walk beside the requests; reports, never refuses).
 *
 * Shape follows publication/site_builder/src/boot.ts + src/index.ts + src/instance/
 * listen_target.ts (claim, stale-socket probe, chmod after bind, drain), without the
 * confinement/reconcile/sweep steps this agent has no equivalent of.
 */

import { chmodSync, lstatSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import type { AgentConfig } from './config';
import { MAX_MEDIA_FILE_BYTES } from './media/grammar';

export class BootRefused extends Error {
  constructor(door: string, message: string) {
    super(`[boot] ${door}: ${message} Nothing was started.`);
    this.name = 'BootRefused';
  }
}

export interface BootSteps {
  readonly preflight: () => void | Promise<void>;
  readonly claimListenTarget: () => void | Promise<void>;
  readonly listen: () => void | Promise<void>;
}

/** Run the steps in THE order. A step that throws stops the boot there. */
export async function bootSequence(steps: BootSteps): Promise<void> {
  await steps.preflight();
  await steps.claimListenTarget();
  await steps.listen();
}

export type ListenConfig = Pick<
  AgentConfig,
  'LISTEN_KIND' | 'SOCKET_PATH' | 'TLS_HOST' | 'TLS_PORT' | 'TLS_CERT_FILE' | 'TLS_KEY_FILE' | 'TLS_CLIENT_CA_FILE' | 'MAX_BUNDLE_BYTES'
> &
  Partial<Pick<AgentConfig, 'MEDIA_MODE'>>;

/**
 * THE Bun.serve BODY CAP. A copy host receives public media files (an AV delivery file
 * outgrows a release bundle), so its cap is the larger of the two. Each route still
 * enforces its own: a put its X-Size (src/media/copy.ts), the JSON routes their
 * readJsonObject cap, a bundle extractBundle's limits.
 */
export function requestBodyCap(cfg: Pick<AgentConfig, 'MAX_BUNDLE_BYTES'> & Partial<Pick<AgentConfig, 'MEDIA_MODE'>>): number {
  return cfg.MEDIA_MODE === 'copy' ? Math.max(cfg.MAX_BUNDLE_BYTES, MAX_MEDIA_FILE_BYTES) : cfg.MAX_BUNDLE_BYTES;
}

export type ListenTarget =
  | { readonly kind: 'unix'; readonly path: string }
  | { readonly kind: 'tcp'; readonly hostname: string; readonly port: number };

export function listenTarget(cfg: ListenConfig): ListenTarget {
  if (cfg.LISTEN_KIND === 'unix') {
    if (!cfg.SOCKET_PATH) throw new BootRefused('listenTarget', 'LISTEN_KIND=unix but SOCKET_PATH is empty.');
    return { kind: 'unix', path: cfg.SOCKET_PATH };
  }
  if (cfg.LISTEN_KIND === 'tls') {
    if (!cfg.TLS_HOST || cfg.TLS_PORT === undefined) {
      throw new BootRefused('listenTarget', 'LISTEN_KIND=tls but TLS_HOST or TLS_PORT is empty.');
    }
    return { kind: 'tcp', hostname: cfg.TLS_HOST, port: cfg.TLS_PORT };
  }
  throw new BootRefused('listenTarget', `LISTEN_KIND '${String(cfg.LISTEN_KIND)}' is not a listener this agent has (unix | tls).`);
}

/** Whether something already accepts connections at `target`. */
export async function listenTargetHeld(target: ListenTarget): Promise<boolean> {
  const handlers = { data() {}, open() {}, error() {} };
  try {
    const socket =
      target.kind === 'unix'
        ? await Bun.connect({ unix: target.path, socket: handlers })
        : await Bun.connect({ hostname: target.hostname, port: target.port, socket: handlers });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

export async function claimListenTarget(target: ListenTarget): Promise<void> {
  const where = target.kind === 'unix' ? `'${target.path}'` : `${target.hostname}:${target.port}`;
  if (target.kind === 'tcp') {
    if (target.port !== 0 && (await listenTargetHeld(target))) {
      throw new BootRefused('claimListenTarget', `${where} is already accepting connections — another process holds it.`);
    }
    return;
  }
  let isSocket: boolean;
  try {
    isSocket = lstatSync(target.path).isSocket();
  } catch {
    return; // nothing there: free
  }
  if (!isSocket) {
    throw new BootRefused('claimListenTarget', `${where} exists and is not a socket; the agent never unlinks a file it did not create.`);
  }
  if (await listenTargetHeld(target)) {
    throw new BootRefused('claimListenTarget', `${where} is already accepting connections — this instance is served by another agent.`);
  }
  unlinkSync(target.path); // a corpse: the previous agent died without cleaning up
}

/** The client-verification flags. Constants on purpose: not configurable, not optional. */
export const MTLS_VERIFY = Object.freeze({ requestCert: true, rejectUnauthorized: true } as const);

export interface TlsMaterial {
  readonly cert: string;
  readonly key: string;
  readonly ca: string;
}

/**
 * READ THE THREE FILES, OR REFUSE THE BOOT. The refusal names the config key and the
 * errno, never the content. The key must not be world-accessible.
 */
export function readTlsMaterial(cfg: Pick<AgentConfig, 'TLS_CERT_FILE' | 'TLS_KEY_FILE' | 'TLS_CLIENT_CA_FILE'>): TlsMaterial {
  const read = (key: 'TLS_CERT_FILE' | 'TLS_KEY_FILE' | 'TLS_CLIENT_CA_FILE', pemLabel: string): string => {
    const path = cfg[key];
    if (!path) throw new BootRefused('readTlsMaterial', `LISTEN_KIND=tls but ${key} is empty.`);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new BootRefused('readTlsMaterial', `${key} ('${path}') is unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'}).`);
    }
    if (!text.includes('-----BEGIN ') || !text.includes(pemLabel)) {
      throw new BootRefused('readTlsMaterial', `${key} ('${path}') is not a PEM ${pemLabel}.`);
    }
    return text;
  };
  const cert = read('TLS_CERT_FILE', 'CERTIFICATE');
  const key = read('TLS_KEY_FILE', 'PRIVATE KEY');
  const ca = read('TLS_CLIENT_CA_FILE', 'CERTIFICATE');
  const keyMode = statSync(cfg.TLS_KEY_FILE as string).mode;
  if ((keyMode & 0o007) !== 0) {
    throw new BootRefused(
      'readTlsMaterial',
      `TLS_KEY_FILE ('${cfg.TLS_KEY_FILE}') is world-accessible (mode ${(keyMode & 0o777).toString(8)}); expected no world bits (provisioned: 0400).`,
    );
  }
  return { cert, key, ca };
}

export type FetchHandler = (req: Request) => Response | Promise<Response>;
type ServeOptions = Parameters<typeof Bun.serve>[0];
export type AgentServer = ReturnType<typeof Bun.serve>;

/**
 * THE Bun.serve OPTIONS for this configuration. `idleTimeout: 0`: a v2 install's health
 * wait legitimately outlasts Bun's 10 s idle timer; the channel is private (socket mode or
 * mTLS) so a slow client is not an anonymous one. The cast is the site_builder typing gap
 * (Bun types unix and host:port shapes apart); tests/boot.test.ts asserts the runtime shape.
 */
export function serveOptions(cfg: ListenConfig, fetch: FetchHandler): ServeOptions {
  const target = listenTarget(cfg);
  const common = { maxRequestBodySize: requestBodyCap(cfg), idleTimeout: 0, fetch };
  if (target.kind === 'unix') {
    return { ...common, unix: target.path } as unknown as ServeOptions;
  }
  const material = readTlsMaterial(cfg);
  return { ...common, hostname: target.hostname, port: target.port, tls: { ...material, ...MTLS_VERIFY } } as unknown as ServeOptions;
}

/** Bind. For unix, chmod 0660 immediately after: the socket's mode IS the access control. */
export function startServer(cfg: ListenConfig, fetch: FetchHandler): AgentServer {
  const server = Bun.serve(serveOptions(cfg, fetch));
  if (cfg.LISTEN_KIND === 'unix') {
    try {
      chmodSync(cfg.SOCKET_PATH as string, 0o660);
    } catch (error) {
      server.stop(true);
      throw new BootRefused('startServer', `could not chmod the socket to 0660 (${(error as NodeJS.ErrnoException).code ?? 'error'}).`);
    }
  }
  return server;
}

/** Stop accepting; wait up to `graceMs` for in-flight requests. Returns how many were left. */
export async function drainServer(server: AgentServer, graceMs: number, pollMs = 50): Promise<number> {
  server.stop(false);
  const deadline = Date.now() + graceMs;
  while (server.pendingRequests > 0 && Date.now() < deadline) {
    await Bun.sleep(pollMs);
  }
  return server.pendingRequests;
}
