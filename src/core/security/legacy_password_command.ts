/**
 * The CLI that converts v6 password values to Argon2id (package.json script;
 * scripts/migrate_v6_passwords.ts) — the ONE spelling the login refusal, the
 * boot notice, the /health notice and the maintenance widget give the operator.
 *
 * A module of its own, with NO import, on purpose: the update engine's boot
 * state (src/core/update/boot_state.ts) words its notice with it, and the
 * update engine runs from an ENGINE TREE that holds no `client/` (an image's
 * update channel; test/helpers/engine_cli_tree.ts). In password_hash.ts the
 * constant dragged password_policy.ts — and through it the client's shared
 * policy module — into that closure, and the tree could not be imported.
 * Gate: test/unit/engine_tree_closure_native.test.ts.
 */
export const MIGRATE_PASSWORDS_COMMAND = 'bun run dedalo:migrate-passwords';
