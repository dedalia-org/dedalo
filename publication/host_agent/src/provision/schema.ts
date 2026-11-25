/**
 * The declaration file `/etc/dedalo_publication_host/<instance>.json` — STRUCTURE, strictly
 * (zod, unknown keys refused); then `derive()` (layout.ts) for every cross-field law. One
 * entry point, `parseDeclaration`, and one error, `DeclarationError`, listing every issue.
 *
 * Mirrors publication/site_builder/src/provision/schema.ts (strictObject everywhere,
 * collect-all issues) for one agent. Not zero-dependency (zod): no root-repo test imports it.
 * The configtest binary is not a field: it is derived (layout.ts WEB_CONFIGTEST_CANDIDATES,
 * picked by the host probe passed through), so a declared one is an unknown key.
 */
import { z } from 'zod';
import type { AgentLayout, DeriveHost, HostDeclaration } from './layout';
import {
  ABSOLUTE_PATH_PATTERN,
  API_PATH_PATTERN,
  DOMAIN_PATTERN,
  FPM_VERSION_PATTERN,
  INSTANCE_PATTERN,
  listenHostProblem,
  LayoutError,
  RELEASES_RETAINED_MAX,
  RELEASES_RETAINED_MIN,
  UNIT_NAME_PATTERN,
  UNIX_NAME_PATTERN,
  derive,
} from './layout';

/**
 * canonicalDeclaration, inferLayout and the key order are layout.ts's (zero-dependency, so the
 * pure init modules use them without zod); re-exported here, where the spec names them.
 * tests/provision_schema.test.ts holds DECLARATION_KEY_ORDER equal to the shapes below.
 */
export { DECLARATION_KEY_ORDER, canonicalDeclaration, inferLayout } from './layout';

const absolutePath = z.string().regex(ABSOLUTE_PATH_PATTERN, 'must be an absolute path of [A-Za-z0-9._/-]');
const unixName = z.string().regex(UNIX_NAME_PATTERN, `must match ${UNIX_NAME_PATTERN.source}`);
const unitName = z.string().regex(UNIT_NAME_PATTERN, `must match ${UNIT_NAME_PATTERN.source}`);
const port = z.number().int().min(1).max(65535);

const listenSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unix') }),
  z.strictObject({
    kind: z.literal('tls'),
    // The ONE listen-host grammar (layout.ts listenHostProblem): a canonical non-zero IPv4, or a
    // private IPv6 (fc00::/7 or ::1) in its RFC 5952 form — the refusal names which rule failed.
    host: z.string().superRefine((host, ctx) => {
      const problem = listenHostProblem(host);
      if (problem !== null) {
        ctx.addIssue({ code: 'custom', message: `${problem} (spec §2.2: the channel binds one private interface, never a hostname or wildcard)` });
      }
    }),
    port,
  }),
]);

export const declarationSchema = z.strictObject({
  instance: z.string().regex(INSTANCE_PATTERN, `must match ${INSTANCE_PATTERN.source}`),
  listen: listenSchema,
  agent_user: unixName,
  engine_group: unixName.optional(),
  agent_dir: absolutePath,
  web: z.strictObject({
    server: z.enum(['apache', 'nginx']),
    unit: unitName,
    nginx_map: z.enum(['conf_d', 'none']).optional(),
    log_dirs: z.array(absolutePath).max(32).optional(),
  }),
  site: z
    .strictObject({
      domain: z.string().regex(DOMAIN_PATTERN, 'must be a lower-case DNS name'),
      home: absolutePath.optional(),
      os_family: z.enum(['debian', 'el']).optional(), // = OS_FAMILIES (tests/provision_schema.test.ts)
      api_paths: z
        .strictObject({
          // v1 only with the v1 block (derive refuses it otherwise, by name).
          v1: z.string().regex(API_PATH_PATTERN, `must match ${API_PATH_PATTERN.source}`).optional(),
          v2: z.string().regex(API_PATH_PATTERN, `must match ${API_PATH_PATTERN.source}`),
        })
        .optional(),
      // Required with the v1 block, refused without it (derive: one named refusal each way).
      fpm: z
        .strictObject({
          flavor: z.enum(['debian', 'el', 'remi']), // = FPM_FLAVORS (tests/provision_schema.test.ts)
          version: z.string().regex(FPM_VERSION_PATTERN, `must match ${FPM_VERSION_PATTERN.source}`),
        })
        .optional(),
    })
    .optional(),
  // OPTIONAL: absent = a v2-only instance, no PHP anywhere (layout.ts HostDeclaration.v1).
  v1: z
    .strictObject({
      user: unixName,
    })
    .optional(),
  state_root: absolutePath,
  media: z.strictObject({
    mode: z.enum(['shared', 'copy', 'none']),
    root: absolutePath.optional(),
    selinux_label: z.literal(true).optional(),
  }),
  // Only with v1 (and then required) — derive() names the field either way.
  php_bin: absolutePath.optional(),
  bun_bin: absolutePath,
  v2: z.strictObject({
    unit: unitName,
    user: unixName,
    group: unixName,
    port,
    health_url: z.string().min(1),
  }),
  releases_retained: z.number().int().min(RELEASES_RETAINED_MIN).max(RELEASES_RETAINED_MAX).optional(),
  paths: z
    .strictObject({
      config_base: absolutePath.optional(),
      unit_dir: absolutePath.optional(),
      sudoers_dir: absolutePath.optional(),
      polkit_rules_dir: absolutePath.optional(),
      host_base: absolutePath.optional(),
      nginx_conf_d: absolutePath.optional(),
      fpm_pool_dir: absolutePath.optional(),
      v1_var_base: absolutePath.optional(),
      web_log_base: absolutePath.optional(),
      logrotate_dir: absolutePath.optional(),
    })
    .optional(),
});

export interface DeclarationIssue {
  readonly path: string;
  readonly message: string;
}

export class DeclarationError extends Error {
  readonly issues: readonly DeclarationIssue[];
  constructor(source: string, issues: readonly DeclarationIssue[]) {
    super(
      `declaration '${source}' refused:\n${issues.map(issue => `  - ${issue.path}: ${issue.message}`).join('\n')}`,
    );
    this.name = 'DeclarationError';
    this.issues = issues;
  }
}

/** Structure (zod) then semantics (derive). `source` only names the file in the error. */
export function parseDeclaration(
  raw: unknown,
  source: string,
  host: DeriveHost = {},
): { declaration: HostDeclaration; layout: AgentLayout } {
  const parsed = declarationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeclarationError(
      source,
      parsed.error.issues.map(issue => ({
        path: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
        message: issue.message,
      })),
    );
  }
  const declaration: HostDeclaration = parsed.data;
  try {
    return { declaration, layout: derive(declaration, host) };
  } catch (error) {
    if (error instanceof LayoutError) {
      throw new DeclarationError(source, [{ path: error.field, message: error.message }]);
    }
    throw error;
  }
}
