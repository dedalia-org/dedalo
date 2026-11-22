#!/bin/zsh
# ============================================================================
# RETIRED at the 2026-07-11 CUTOVER (rewrite/CUTOVER_RUNBOOK.md §6).
# client/dedalo/ is the PRIMARY, TS-OWNED client source; the PHP tree is
# decommissioned dead code. Running this sync would overwrite owned files
# with stale dead-code copies — refuse. Kept on disk for history only.
# Client fixes are now plain edits in client/ (gate: client_serving.test.ts
# self-consistency + `bun run test:client`).
# ============================================================================
echo "RETIRED: the client sync died with the PHP tree at the 2026-07-11 cutover." >&2
echo "client/dedalo/ is the primary source now — edit it directly." >&2
exit 1

# Phase 7 client seam — copy the vanilla-JS client from the READ-ONLY PHP tree
# (spec §2.5: copy, don't rewrite, the view layer).
#
# Layout: client/dedalo/ mirrors the PHP web root, so the TS server can serve
# the app at the SAME URL paths the PHP deployment uses (/dedalo/core/page/…).
# That matters because the client resolves everything relatively:
#   - assets:   ../../favicon.ico, ../../lib/threejs/…
#   - API:      ../api/v1/json/  (data_manager fallback when DEDALO_API_URL is
#                unset) → /dedalo/core/api/v1/json/ from /dedalo/core/page/
# so byte-identical copies at identical paths need ZERO call-layer edits for
# routing — the seam is only auth/environment (see docs/client_seam.md).
#
# What is copied:
#   - core/: every browser asset (js/css/less/html + images/fonts), git-tracked
#     (first-party client code, ~12MB);
#   - lib/: vendor libraries (threejs, ckeditor, pdfjs, …, ~118MB) — synced but
#     GITIGNORED; rerun this script after cloning.
#   - favicon.ico
#
# NOT synced: the repo-root tools/ tree is TS-OWNED (each tool is a self-contained
# package: js/ css/ img/ register.json + server/). It was seeded once from the PHP
# tools client and now diverges deliberately — port PHP tool JS changes by hand.
#
# Re-runnable: rsync only updates changes. Never writes to the PHP tree.

set -e

# Resolve the two trees relative to this script (v7/master_dedalo/scripts/).
TS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHP_ROOT="$(cd "$TS_ROOT/../../v7_php_frozen/master_dedalo" && pwd)"
CLIENT_ROOT="$TS_ROOT/client/dedalo"

if [[ ! -d "$PHP_ROOT/core/page" ]]; then
	echo "ERROR: PHP tree not found at $PHP_ROOT" >&2
	exit 1
fi

mkdir -p "$CLIENT_ROOT"

# Browser-asset filter: keep directories (to recurse) + web asset extensions;
# everything else (PHP, sql, md, …) is excluded.
ASSET_INCLUDES=(
	--include='*/'
	--include='*.js' --include='*.mjs' --include='*.css' --include='*.less'
	--include='*.html' --include='*.map' --include='*.json'
	--include='*.svg' --include='*.png' --include='*.jpg' --include='*.jpeg'
	--include='*.gif' --include='*.webp' --include='*.ico'
	--include='*.woff' --include='*.woff2' --include='*.ttf' --include='*.otf'
	--exclude='*'
)

# TS-owned client divergences: syncing these back from the PHP tree would break
# the native behavior. Port PHP changes by hand (same pattern as tools/).
#  - diffusion_server_control (WC-005): reworked against the NATIVE diffusion
#    engine (job-queue actions replace the PHP daemon start/stop/restart).
#  - installer (WC-2026-07-09-installer-diagnostics-grid): the TS-native install
#    wizard; its diagnostics grid drops
#    the PHP/Apache-only checkers (php_version/gd/mbstring/…) the Bun server has
#    no PHP for. The PHP tree keeps its own PHP-era installer.
#  - error_reports (WC-018): TS-only maintenance widget browsing this installation's
#    error reports; it has no PHP twin to sync from.
#  - check_config render (WC-027): ONE file diverges — render_check_config.js gains
#    the TS-native "Database details" + "Runtime mode" readouts (db_info/runtime_mode,
#    payload fields the PHP server does not emit) and the eager-value folded-red fix.
#    The widget's OTHER files (check_config.js, css) stay byte-identical, so exclude
#    only the one renderer, not the whole dir. Port PHP renderer changes by hand.
#  - area_maintenance.less (WC-018): carries the error_reports widget @import
#    the PHP tree must not have; render_area_maintenance.js carries the
#    ENGINE_DISABLED_WIDGETS client-side gate (hides widgets THIS engine cannot
#    serve while the server catalog stays byte-identical to PHP).
#  - runtime_info widget js (2 files, WC-030): merged from php_info (phpinfo()
#    iframe, no Bun equivalent) and php_runtime (already TS-native, READ-ONLY —
#    no reset_opcache / in-place refresh, Bun has no PHP opcache); the PHP
#    tree still has BOTH php_info and its mutating php_runtime panel, under
#    their old names. Port upstream renderer changes by hand.
TS_OWNED_EXCLUDES=(
	--exclude='area_maintenance/widgets/diffusion_server_control/**'
	--exclude='area_maintenance/widgets/error_reports/**'
	--exclude='area_maintenance/widgets/check_config/js/render_check_config.js'
	--exclude='area_maintenance/css/area_maintenance.less'
	--exclude='area_maintenance/js/render_area_maintenance.js'
	--exclude='area_maintenance/widgets/runtime_info/js/runtime_info.js'
	--exclude='area_maintenance/widgets/runtime_info/js/render_runtime_info.js'
	--exclude='installer/**'
)

echo "Syncing first-party client (core/) …"
rsync -a --prune-empty-dirs "${TS_OWNED_EXCLUDES[@]}" "${ASSET_INCLUDES[@]}" "$PHP_ROOT/core/" "$CLIENT_ROOT/core/"

# tool_common relocation fixup (TS-owned): tool_common's client machinery lives
# at client/dedalo/core/tools_common/, NOT the PHP tree's tools/tool_common/
# (WC-006; it sat in src/core/tools/client/ until 2026-08-16). The PHP core
# sources still import the old path, so rewrite it here after every sync
# (idempotent). Both consumers now want the SAME target, because URL and disk
# path finally agree — JS runtime imports resolve through /dedalo/core/tools_common/
# and main.less's @import reaches the file on disk at the same relative depth.
# Only main.less imports tool_common CSS, and always at the ../../../ depth of
# core/page/css/, so the exact-prefix match is safe. Both passes are idempotent
# (the old pattern is gone after the first rewrite) and target disjoint file
# globs, so they never interfere.
echo "Fixing up tool_common imports in core/ …"
grep -rl "tools/tool_common/" "$CLIENT_ROOT/core" --include="*.js" --include="*.mjs" 2>/dev/null | while read -r f; do
	sed -i '' "s#tools/tool_common/#core/tools_common/#g" "$f"
done
grep -rl "tools/tool_common/" "$CLIENT_ROOT/core" --include="*.less" --include="*.css" 2>/dev/null | while read -r f; do
	sed -i '' "s#\.\./\.\./\.\./tools/tool_common/css/tool_common#../../tools_common/css/tool_common#g" "$f"
done

# error_reports widget CSS (WC-018): the TS-only widget's styles are compiled
# STANDALONE and APPENDED to main.css under a marker comment — main.css is built
# in the PHP tree (which lacks the widget) and the core/ rsync above just
# re-synced it, wiping any previous append. Put it back. Idempotent (skipped when
# the marker is present); fails LOUDLY when lessc is missing so a re-sync can
# never silently ship the widget unstyled. client_serving.test.ts asserts the
# PHP bytes stay an exact PREFIX of the served main.css with this block as tail.
ER_MARKER='=== error_reports widget (WC-018'
ER_LESS="$CLIENT_ROOT/core/area_maintenance/widgets/error_reports/css/error_reports.less"
MAIN_CSS="$CLIENT_ROOT/core/page/css/main.css"
if [ -f "$ER_LESS" ] && ! grep -q "$ER_MARKER" "$MAIN_CSS"; then
	echo "Re-appending error_reports widget CSS to main.css (WC-018) …"
	if ! command -v lessc >/dev/null 2>&1; then
		echo "ERROR: lessc not found — cannot re-append the WC-018 error_reports CSS to main.css." >&2
		echo "       Install less (npm i -g less / brew install less) and re-run." >&2
		exit 1
	fi
	{
		printf '\n\n/* === error_reports widget (WC-018; appended — source: area_maintenance/widgets/error_reports/css/error_reports.less) === */\n'
		lessc "$ER_LESS"
	} >>"$MAIN_CSS"
fi

# Raw record data view (TS seam): the inspector "View record data" link opens the
# current record's raw JSON in a new tab. The TS server does NOT expose the PHP
# arbitrary-RQO GET; it serves a dedicated, hard-locked endpoint (…/api/v1/raw)
# that only ever performs an admin-gated, read-only section read AND refuses the
# users section dd128 (src/core/api/raw_view.ts). Redirect the link there, deriving
# the URL from DEDALO_API_URL (…/json/ → …/raw) so no new page-global is needed
# (plain_vars stays byte-parity with PHP), passing narrow params instead of an RQO.
# Idempotent: after the rewrite the DEDALO_API_URL '?'+rqo form is gone, so a
# re-run/re-sync reapplies cleanly.
echo "Redirecting inspector raw-record link to the dedicated /raw endpoint …"
INSPECTOR_JS="$CLIENT_ROOT/core/inspector/js/render_inspector.js"
if [ -f "$INSPECTOR_JS" ]; then
	perl -0pi -e "s{const rqo = self\.get_raw_record_rqo\(\)\s*const url = DEDALO_API_URL \+ '\?' \+ object_to_url_vars\(\{\s*rqo\s*:\s*JSON\.stringify\(rqo\)\s*\}\)}{const url = DEDALO_API_URL.replace('json/', 'raw') + '?' + object_to_url_vars({ section_tipo : self.caller.section_tipo, section_id : self.caller.section_id })}s" "$INSPECTOR_JS"
fi

# Environment diagnostic view (TS seam): the menu debug-bar "environment" link opens
# core/common/js/environment.js.php in a new tab. The TS server runs no PHP and does
# not serve .php, so that path 404s. Retarget the link to the TS diagnostic endpoint
# (…/core/api/v1/environment, session-gated, returns the get_environment payload as
# pretty JSON — src/core/api/environment_view.ts), reusing the existing DEDALO_ROOT_WEB
# global (no new page-global). Idempotent.
echo "Redirecting menu environment link to the TS environment endpoint …"
MENU_JS="$CLIENT_ROOT/core/menu/js/view_default_edit_menu.js"
if [ -f "$MENU_JS" ]; then
	perl -pi -e "s{DEDALO_ROOT_WEB \+ '/core/common/js/environment\.js\.php'}{DEDALO_ROOT_WEB + '/core/api/v1/environment'}g" "$MENU_JS"
fi

echo "Syncing vendor lib/ (gitignored) …"
rsync -a --delete "$PHP_ROOT/lib/" "$CLIENT_ROOT/lib/"

cp -f "$PHP_ROOT/favicon.ico" "$CLIENT_ROOT/favicon.ico" 2>/dev/null || true

# NOTE: the client test harness at $CLIENT_ROOT/test/client/ is TS-OWNED and
# git-tracked (ported + seam-adapted from the PHP test/client/ tree; run via
# `bun run test:client`, see docs/client_tests.md). It is deliberately NOT synced
# here — this script only mirrors core/ and lib/, so local seam adaptations to
# the harness/registry survive re-syncs.

echo "Done. Client root: $CLIENT_ROOT (tools/ and test/client/ are TS-owned, not synced)"
du -sh "$CLIENT_ROOT/core" "$CLIENT_ROOT/lib" 2>/dev/null
