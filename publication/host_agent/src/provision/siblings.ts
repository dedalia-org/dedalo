/**
 * SEVERAL INSTANCES ON ONE HOST — what one instance may never share with another.
 *
 * derive() namespaces every path it owns by instance (config dir, agent unit, socket, sudoers
 * and polkit files), and the state-root marker refuses another instance's tree. What it cannot
 * see is the OTHER declarations: the principals, the v2 unit and the ports are the operator's
 * choice, and a collision there is either a silent failure (two v2 services on one port) or an
 * isolation hole. The hole is the users: polkit grants by subject.user and each state root is
 * owned by its agent user, so two instances sharing an agent user can each write the other's
 * media include (parsed by root at configtest) and API releases — one compromise is both.
 *
 * The v1 configuration (DB credentials included) is guarded by its OWNER, the v1 user (the
 * site's PHP-FPM pool user): behind one web server every pool shares the web server's group,
 * so the v1 user is a principal like the others — disjoint across instances. v2.group reads
 * v2/shared/v2.env: disjoint too.
 *
 * Pure, ZERO-DEPENDENCY (tests/provision_zero_dep.test.ts): the CLI reads and parses the
 * sibling declarations (schema.ts), this module only judges the derived layouts.
 */
import type { AgentLayout } from './layout';
import { isLoopbackListenHost, pathsOverlap, sameListenHost } from './layout';

export interface Sibling {
  /** The declaration file, named in every refusal. */
  readonly source: string;
  readonly layout: AgentLayout;
}

/** derive()'s own normal-form overlap (segment-wise: '/srv/a' vs '/srv/ab' and '/srv/a/..x' right). */
const overlap = pathsOverlap;

/** The users that run code for an instance. Disjoint across instances. */
function principals(layout: AgentLayout): ReadonlyMap<string, string> {
  const users = new Map([[layout.identity.agentUser, 'agent_user']]);
  // A v2-only instance has no v1 principal.
  if (layout.v1 !== null) users.set(layout.v1.user, 'v1.user');
  users.set(layout.identity.v2User, 'v2.user');
  return users;
}

/** The groups that read an instance's API configuration (its credentials). Disjoint across instances. */
function secretGroups(layout: AgentLayout): ReadonlyMap<string, string> {
  return new Map([[layout.identity.v2Group, 'v2.group']]);
}

/** The directories an instance WRITES (its state root; a copy-mode media root). */
function writtenRoots(layout: AgentLayout): readonly [string, string][] {
  const roots: [string, string][] = [['state_root', layout.state.root]];
  if (layout.media.mode === 'copy' && layout.media.root !== null) roots.push(['media.root (copy)', layout.media.root]);
  return roots;
}

/**
 * The host-wide ProtectHome= fact (spec S10): true when any sibling is home-bound. The caller
 * passes it to derive() (DeriveHost.anyHomeBound) so every agent unit renders the same value.
 */
export function anySiblingHomeBound(siblings: readonly Sibling[]): boolean {
  return siblings.some(sibling => sibling.layout.homeBound);
}

/** Every reason `own` cannot coexist with the given siblings; empty = isolated. */
export function siblingRefusals(own: AgentLayout, siblings: readonly Sibling[]): string[] {
  const refusals: string[] = [];
  for (const { source, layout: other } of siblings) {
    const clash = (what: string, fix: string) =>
      refusals.push(`${what} — also used by instance '${other.instance}' (${source}); ${fix}`);

    if (other.instance === own.instance) {
      refusals.push(`${source} declares instance '${own.instance}' too — one declaration per instance; remove one`);
      continue;
    }
    const otherPrincipals = principals(other);
    for (const [user, field] of principals(own)) {
      const theirs = otherPrincipals.get(user);
      if (theirs !== undefined) {
        clash(
          `${field} '${user}' is that instance's ${theirs}`,
          field === 'v1.user' || theirs === 'v1.user'
            ? "run each site's v1 API in its own PHP-FPM pool, under its own user, and declare that user as v1.user"
            : 'give each instance its own users (one compromised instance must not reach the other)',
        );
      }
    }
    const otherGroups = secretGroups(other);
    for (const [group, field] of secretGroups(own)) {
      const theirs = otherGroups.get(group);
      if (theirs === undefined) continue;
      clash(
        `${field} '${group}' is that instance's ${theirs}`,
        'give each instance its own v2 group',
      );
    }
    // Our v2 unit file is written to the unit dir and its restart granted to our agent by polkit:
    // named like ANY of their units it would shadow (or one day control) that unit.
    const theirUnits = new Map([
      [other.v2.unit, 'v2.unit'],
      [other.web.unit, 'web.unit'],
      [other.agentUnitName, 'agent unit'],
    ]);
    const unitClash = theirUnits.get(own.v2.unit);
    if (unitClash !== undefined) {
      clash(`v2.unit '${own.v2.unit}' is that instance's ${unitClash}`, 'give each instance its own v2 unit name');
    }
    // Our socket's group (unix listener): one of their service groups would let their code connect.
    if (own.identity.engineGroup !== null && secretGroups(other).has(own.identity.engineGroup)) {
      clash(
        `engine_group '${own.identity.engineGroup}' is one of that instance's service groups`,
        "use the work system's own group, never a web or API group",
      );
    }
    if (own.v2.port === other.v2.port) clash(`v2.port ${own.v2.port}`, 'give each instance its own v2 port');
    // One website, one instance (spec S6): two would fight over its vhost reference, its home and its pool.
    if (own.site !== null && other.site !== null) {
      if (own.site.domain === other.site.domain) {
        clash(`site.domain '${own.site.domain}'`, 'one instance serves one site; declare the site once');
      }
      const ownV1 = own.site.v1;
      const otherV1 = other.site.v1;
      // The v1 pool's own paths: only between two instances that both serve v1.
      if (ownV1 !== null && otherV1 !== null) {
        if (ownV1.var.root === otherV1.var.root) {
          clash(`the v1 pool directory '${ownV1.var.root}'`, 'give each instance its own paths.v1_var_base');
        }
        if (ownV1.fpm.listen === otherV1.fpm.listen) {
          clash(`the v1 pool socket '${ownV1.fpm.listen}'`, 'each instance runs its own pool on its own socket');
        }
        if (ownV1.fpm.poolFile === otherV1.fpm.poolFile) {
          clash(`the v1 pool file '${ownV1.fpm.poolFile}'`, 'each instance renders its own pool file');
        }
      }
    }
    if (own.listen.kind === 'tls' && other.listen.kind === 'tls') {
      // One address, one spelling: compared canonically (RFC 5952), so `fd00:0::1` and `fd00::1`
      // are one interface even when a hand-written declaration did not use the canonical form.
      if (sameListenHost(own.listen.host, other.listen.host) && own.listen.port === other.listen.port) {
        clash(`listen ${own.listen.host}:${own.listen.port}`, 'give each instance its own port (or address)');
      }
    }
    // v2 binds loopback: a loopback agent listener (127.0.0.0/8 or ::1 — a v2 service bound to a
    // dual-stack `localhost` holds both) on their v2 port collides.
    if (own.listen.kind === 'tls' && isLoopbackListenHost(own.listen.host) && own.listen.port === other.v2.port) {
      clash(`listen ${own.listen.host}:${own.listen.port} is that instance's v2.port`, 'give each instance its own port');
    }
    const theirsWritten = writtenRoots(other);
    const theirsRead = other.media.root !== null ? [...theirsWritten, ['media.root', other.media.root] as [string, string]] : theirsWritten;
    for (const [field, path] of writtenRoots(own)) {
      for (const [otherField, otherPath] of theirsRead) {
        if (overlap(path, otherPath)) {
          clash(`${field} '${path}' overlaps that instance's ${otherField} '${otherPath}'`, 'use separate directories');
        }
      }
    }
    // A shared (read-only) media root of ours under a tree THEY write: they would publish into it.
    if (own.media.mode === 'shared' && own.media.root !== null) {
      for (const [otherField, otherPath] of theirsWritten) {
        if (overlap(own.media.root, otherPath)) {
          clash(`media.root '${own.media.root}' overlaps that instance's ${otherField} '${otherPath}'`, 'use separate directories');
        }
      }
    }
  }
  return refusals;
}
