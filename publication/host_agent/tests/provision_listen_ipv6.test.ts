/**
 * THE LISTEN HOST OVER IPv6 (spec §2.2), end to end on the agent side: one grammar
 * (layout.ts listenHostProblem) — a canonical non-zero IPv4, or a PRIVATE IPv6 (a unique local
 * address fc00::/7, or ::1) in its RFC 5952 form — read by derive(), the declaration schema and
 * the draft schema alike; the sibling check comparing hosts canonically; the server
 * certificate's IP SAN; the env the agent boots from; the engine fragment's and B4's bracketed
 * URLs; and a REAL mTLS handshake on [::1] with the material ensureTls issues.
 *
 * Link-local is refused BY DESIGN (not "unsupported yet"): fe80::/10 is only bindable with a
 * zone id (fe80::1%eth0), which neither the certificate SAN, an https URL authority (WHATWG
 * URL refuses `%` in an IPv6 host) nor the engine registry can carry.
 */
import { describe, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { tlsHostProblem } from '../src/config';
import { parseEnvFile } from '../src/env_file';
import { parseDraft } from '../src/provision/init/draft_schema';
import { healthRequest } from '../src/provision/init/verify';
import {
  type AgentLayout,
  canonicalIpv6,
  comparableHost,
  derive,
  type HostDeclaration,
  isLoopbackListenHost,
  LayoutError,
  listenHostProblem,
  sameListenHost,
} from '../src/provision/layout';
import { agentUrl } from '../src/provision/render/engine_fragment';
import { renderEnvBody } from '../src/provision/render/env';
import { DeclarationError, parseDeclaration } from '../src/provision/schema';
import { siblingRefusals } from '../src/provision/siblings';
import { ensureTls, parseEngineBundle, type TlsIo } from '../src/provision/tls';
import { tlsDeclaration } from './fixtures/provision_declaration';

const ULA = 'fd00:20::2';

function tlsAt(host: string, port = 7443): HostDeclaration {
  return { ...tlsDeclaration(), listen: { kind: 'tls', host, port } };
}

function memoryIo() {
  const files = new Map<string, string>();
  const io: TlsIo = {
    readFile: path => files.get(path) ?? null,
    writeFile: (path, body) => {
      files.set(path, body);
    },
  };
  return { io, files };
}

/** The refusal derive() gives for a host, or null. */
function deriveRefusal(host: string): string | null {
  try {
    derive(tlsAt(host));
    return null;
  } catch (error) {
    if (!(error instanceof LayoutError)) throw error;
    expect(error.field).toBe('listen.host');
    return error.reason;
  }
}

/** Is [::1] bindable here? (A container with IPv6 disabled has no ::1 at all.) */
const IPV6_LOOPBACK = (() => {
  try {
    Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response('') }).stop(true);
    return true;
  } catch {
    return false;
  }
})();

describe('canonicalIpv6 (RFC 5952 §4)', () => {
  test.each([
    ['FD00:0:0:0:0:0:0:1', 'fd00::1'],
    ['fd00:0000::0001', 'fd00::1'],
    // the FIRST longest zero run is the one compressed; a single zero hextet is never `::`
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
    ['fd00:0:0:1::', 'fd00:0:0:1::'],
    ['::1', '::1'],
    ['::', '::'],
  ])('%s → %s', (text, canonical) => {
    expect(canonicalIpv6(text)).toBe(canonical);
  });

  test('not a bare IPv6 literal: null (a zone id, brackets, IPv4, a name)', () => {
    for (const text of ['fe80::1%eth0', '[fd00::1]', '10.0.0.1', 'agent.lan', '', 'fd00::g']) {
      expect(canonicalIpv6(text), text).toBeNull();
    }
  });

  test('comparableHost: one spelling for a comparison; IPv4 and names unchanged', () => {
    expect(comparableHost('FD00:0::1')).toBe('fd00::1');
    expect(comparableHost('[FD00:0::1]')).toBe('fd00::1');
    expect(comparableHost('10.0.0.1')).toBe('10.0.0.1');
    expect(comparableHost('agent.lan')).toBe('agent.lan');
    expect(sameListenHost('fd00:0:0:0:0:0:0:1', 'fd00::1')).toBe(true);
    expect(sameListenHost('fd00::1', 'fd00::2')).toBe(false);
    expect(isLoopbackListenHost('::1')).toBe(true);
    expect(isLoopbackListenHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackListenHost('127.0.0.2')).toBe(true);
    expect(isLoopbackListenHost(ULA)).toBe(false);
  });
});

describe('the listen-host grammar (listenHostProblem) and derive()', () => {
  test('accepted: an IPv4 as before, a unique local IPv6 (fc00::/7), ::1', () => {
    for (const host of ['10.8.0.2', '127.0.0.1', 'fd00::1', 'fc00::1', ULA, 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '::1']) {
      expect(listenHostProblem(host), host).toBeNull();
      expect(deriveRefusal(host), host).toBeNull();
    }
    const layout = derive(tlsAt(ULA));
    expect(layout.listen).toEqual({ kind: 'tls', host: ULA, port: 7443 });
    expect(layout.envVars.TLS_HOST).toBe(ULA);
  });

  test('a non-canonical IPv6 spelling is refused WITH its canonical form', () => {
    expect(deriveRefusal('FD00:0::1')).toBe("'FD00:0::1' must be written in its canonical form (RFC 5952): 'fd00::1'");
    expect(deriveRefusal('fd00:0:0:0:0:0:0:1')).toContain("'fd00::1'");
  });

  test.each([
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'no zone id'],
    ['[fd00::1]', 'no brackets'],
    ['::', 'unspecified'],
    ['ff02::1', 'multicast'],
    ['::ffff:a00:1', 'IPv4-mapped'],
    ['::a00:1', 'IPv4-compatible'],
    // The dotted spellings people actually write: refused for their FAMILY, never told to
    // respell themselves first (the family refusal wins over the canonical-form one).
    ['::ffff:10.0.0.2', 'IPv4-mapped'],
    ['::10.0.0.2', 'IPv4-compatible'],
    ['FE80::1', 'link-local'],
    ['2001:DB8::1', 'not a private IPv6'],
    ['2001:db8::1', 'not a private IPv6'],
    ['2a01:4f8::1', 'not a private IPv6'],
    ['fec0::1', 'not a private IPv6'],
    ['0.0.0.0', 'canonical non-zero IPv4'],
    ['10.0.0.01', 'canonical non-zero IPv4'],
    ['agent.lan', 'never a hostname'],
  ])('%s is refused (%s)', (host, reason) => {
    expect(listenHostProblem(host)).toContain(reason);
    expect(deriveRefusal(host)).toContain(reason);
    expect(listenHostProblem(host), 'a refused family is never sent to respell itself').not.toContain('canonical form');
  });

  test('the declaration schema takes a ULA and refuses a link-local by its reason', () => {
    const { layout } = parseDeclaration(tlsAt(ULA), 'test.json');
    expect(layout.listen).toEqual({ kind: 'tls', host: ULA, port: 7443 });
    let refused: DeclarationError | null = null;
    try {
      parseDeclaration(tlsAt('fe80::1'), 'test.json');
    } catch (error) {
      if (!(error instanceof DeclarationError)) throw error;
      refused = error;
    }
    expect(refused?.issues.map(issue => issue.path)).toEqual(['listen.host']);
    expect(refused?.issues[0]?.message).toContain('link-local');
  });

  test('the draft schema (provision init --draft, the panel draft file) takes the same grammar', () => {
    const draft = parseDraft({ instance: 'museum', media: { mode: 'none' }, listen: { kind: 'tls', host: ULA, port: 8471 } }, 'draft.json');
    expect(draft.listen).toEqual({ kind: 'tls', host: ULA, port: 8471 });
    expect(() =>
      parseDraft({ instance: 'museum', media: { mode: 'none' }, listen: { kind: 'tls', host: 'FD00::1', port: 8471 } }, 'draft.json'),
    ).toThrow("'fd00::1'");
  });
});

describe('two instances on one IPv6 address (siblings.ts)', () => {
  const other = (base: HostDeclaration, listen: HostDeclaration['listen']): HostDeclaration => ({
    ...base,
    instance: 'other',
    agent_user: 'pubhost-other',
    state_root: '/srv/pub_other',
    media: { mode: 'shared', root: '/mnt/media_other' },
    v1: { user: 'pool-other' },
    v2: { unit: 'api-v2-other', user: 'api-v2-other', group: 'api-v2-other', port: 3999, health_url: 'http://127.0.0.1:3999/health' },
    listen,
  });
  const judge = (own: AgentLayout, theirs: AgentLayout) => siblingRefusals(own, [{ source: 'other.json', layout: theirs }]);

  test('the same address and port clash — compared canonically, whatever a hand-written file spelled', () => {
    const own = derive(tlsAt(ULA));
    const theirs = derive(other(tlsAt(ULA), { kind: 'tls', host: ULA, port: 7443 }));
    expect(judge(own, theirs).join('\n')).toContain(`listen ${ULA}:7443`);
    const spelledLong: AgentLayout = { ...theirs, listen: { kind: 'tls', host: 'FD00:20:0:0:0:0:0:2', port: 7443 } };
    expect(judge(own, spelledLong).join('\n')).toContain(`listen ${ULA}:7443`);
    expect(judge(own, derive(other(tlsAt(ULA), { kind: 'tls', host: ULA, port: 7444 })))).toEqual([]);
    expect(judge(own, derive(other(tlsAt(ULA), { kind: 'tls', host: 'fd00:20::3', port: 7443 })))).toEqual([]);
  });

  test('an agent on ::1 at their v2 port is refused like one on 127.0.0.1', () => {
    const own = derive(tlsAt('::1', 3999));
    const theirs = derive(other(tlsAt(ULA), { kind: 'tls', host: ULA, port: 7443 }));
    expect(judge(own, theirs).join('\n')).toContain("listen ::1:3999 is that instance's v2.port");
  });
});

describe('the IPv6 listener: certificate, env, URLs', () => {
  test('ensureTls issues the server certificate with the IPv6 IP SAN, and a move reissues it', () => {
    const m = memoryIo();
    const layout = derive(tlsAt(ULA));
    const tls = layout.tls!;
    ensureTls(layout, m.io, new Date());
    const server = new X509Certificate(m.files.get(tls.serverCert)!);
    expect(server.checkIP(ULA)).toBe(ULA);
    expect(server.checkIP('fd00:20::3')).toBeUndefined();
    expect(server.checkIP('10.8.0.2')).toBeUndefined();
    const moved = derive(tlsAt('fd00:20::3'));
    expect(ensureTls(moved, m.io, new Date()).issued).toEqual(['server']);
    expect(new X509Certificate(m.files.get(tls.serverCert)!).checkIP('fd00:20::3')).toBe('fd00:20::3');
  });

  test("the rendered TLS_HOST is one the agent's own config accepts", () => {
    const layout = derive(tlsAt(ULA));
    expect(tlsHostProblem(layout.envVars.TLS_HOST!)).toBeNull();
    // Through the renderer and the agent's own env-file parser: the colons survive verbatim.
    expect(parseEnvFile(renderEnvBody(layout), 'agent.env').TLS_HOST).toBe(ULA);
  });

  test('the engine fragment URL and the B4 health URL bracket the IPv6 host (and only it)', () => {
    expect(agentUrl(ULA, 8471)).toBe(`https://[${ULA}]:8471/publication/host_agent`);
    expect(agentUrl('10.8.0.2', 8471)).toBe('https://10.8.0.2:8471/publication/host_agent');
    // The engine parses the fragment URL with WHATWG URL: the host comes back canonical.
    expect(new URL(agentUrl(ULA, 8471)).hostname).toBe(`[${ULA}]`);
    const tls = { ca: 'ca', cert: 'cert', key: 'key' };
    expect(healthRequest(derive(tlsAt(ULA)), tls).url).toBe(`https://[${ULA}]:7443/publication/host_agent/health`);
  });
});

describe('a REAL mTLS handshake on an IPv6 listener', () => {
  test.skipIf(!IPV6_LOOPBACK)(
    '[::1] (skipped only where the kernel has no IPv6 loopback): the issued bundle is served at the bracketed URL; a certificate for another IPv6 is refused',
    async () => {
      const local = derive(tlsAt('::1'));
      const m = memoryIo();
      ensureTls(local, m.io, new Date());
      const elsewhere = memoryIo();
      ensureTls(derive(tlsAt(ULA)), elsewhere.io, new Date());
      const tls = local.tls!;
      const bundle = parseEngineBundle(m.files.get(local.engineBundlePath)!)!;
      const serve = (io: ReturnType<typeof memoryIo>) =>
        Bun.serve({
          hostname: '::1',
          port: 0,
          tls: {
            cert: io.files.get(tls.serverCert)!,
            key: io.files.get(tls.serverKey)!,
            ca: io.files.get(tls.caCert)!,
            requestCert: true,
            rejectUnauthorized: true,
          },
          fetch: () => new Response('ok'),
        });
      const server = serve(m);
      // The same CA's bundle, but the server certificate names fd00:20::2, not ::1: identity fails.
      const wrongIdentity = serve(elsewhere);
      const elsewhereBundle = parseEngineBundle(elsewhere.files.get(local.engineBundlePath)!)!;
      try {
        const url = healthRequest(local, { ca: bundle.caPem, cert: bundle.certPem, key: bundle.keyPem }).url.replace(':7443/', `:${server.port}/`);
        expect(url.startsWith('https://[::1]:')).toBe(true);
        const res = await fetch(url, { tls: { ca: bundle.caPem, cert: bundle.certPem, key: bundle.keyPem, rejectUnauthorized: true } });
        expect(await res.text()).toBe('ok');
        let refused = false;
        try {
          await fetch(`https://[::1]:${wrongIdentity.port}/`, {
            tls: { ca: elsewhereBundle.caPem, cert: elsewhereBundle.certPem, key: elsewhereBundle.keyPem, rejectUnauthorized: true },
          });
        } catch {
          refused = true;
        }
        expect(refused, 'a server certificate naming another IPv6 address was accepted').toBe(true);
      } finally {
        server.stop(true);
        wrongIdentity.stop(true);
      }
    },
  );
});
