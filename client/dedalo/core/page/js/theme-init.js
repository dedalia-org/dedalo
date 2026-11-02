/**
 * theme-init
 *
 * Early-execution theme bootstrap to eliminate "flash of wrong theme" (FOWT).
 *
 * LOADING CONTRACT
 * ----------------
 * This file is intentionally NOT a JS module. It is loaded as a plain
 * synchronous <script src="js/theme-init.js"> in <head> — before the
 * deferred module bundle (index.js) and before any CSS paint — so the
 * correct `data-theme` attribute is on <html> before the first frame.
 *
 * IIFE PATTERN
 * ------------
 * The code is wrapped in an immediately-invoked function expression (IIFE)
 * to avoid leaking any temporary variables into the global scope, since
 * classic (non-module) scripts share the global namespace.
 *
 * STORAGE KEY COUPLING
 * --------------------
 * The literal string 'dedalo_theme' must stay in sync with THEME_KEY in
 * core/page/js/theme.js, which owns the authoritative set_theme() / get_theme()
 * functions used at runtime.  A mismatch between these two files would cause
 * the early init to apply the wrong attribute while the full module applies
 * the correct one (or vice-versa), resulting in a visible theme flicker.
 *
 * LIGHT-THEME OPTIMISATION
 * ------------------------
 * Only the 'dark' value requires an explicit `data-theme` attribute; light is
 * the CSS default, so no attribute needs to be set or removed here.  This
 * keeps the critical path minimal.
 *
 * ERROR GUARD
 * -----------
 * localStorage access is wrapped in try/catch because it throws a
 * SecurityError in certain browser contexts: third-party iframes with
 * storage blocked, private-browsing modes that restrict access, or when
 * the browser's storage quota policy denies reads.  The fallback is a
 * silent no-op that lets the page render with the default (light) theme.
 */
(function(){
	try {
		const t = localStorage.getItem('dedalo_theme');
		// (!) Only act on explicit 'dark'; any other stored value (or absence)
		// leaves the attribute unset, defaulting to light theme via CSS.
		if (t === 'dark') document.documentElement.setAttribute('data-theme','dark');
		// active-field style cache ('dedalo_active_style' = ACTIVE_STYLE_KEY in
		// core/page/js/active_style.js); an unknown id matches no stylesheet
		const s = localStorage.getItem('dedalo_active_style');
		if (s) document.documentElement.setAttribute('data-active_style', s);
	} catch(_){}
})();
