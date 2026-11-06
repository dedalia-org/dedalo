// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0

/**
* THEME
* Application-level light/dark theme controller for Dédalo v7.
*
* Manages theme persistence and runtime switching for the Dédalo page shell.
* The active theme is stored in `localStorage` under the key `THEME_KEY`
* ('dedalo_theme') and is applied to the document root via the HTML attribute
* `data-theme="dark"`. LESS/CSS selectors then cascade from `[data-theme="dark"]`
* to restyle the full interface.
*
* Design decisions:
* - Light is the implicit default: no attribute means light, avoiding a FOUC
*   on first visit. `localStorage.removeItem` is used (not setItem('light'))
*   so that clearing storage also resets to light.
* - A companion inline script (`core/page/js/head-init.js`) runs synchronously
*   in the document `<head>` — before any module loads — to set `data-theme`
*   from localStorage immediately, preventing a flash of wrong theme. This
*   module is loaded afterwards and manages subsequent runtime changes.
* - Theme changes are broadcast over the event bus as 'theme_changed' so that
*   any module (e.g. map tiles, canvas renderers) can react without coupling
*   directly to this module.
*
* Exports:
* - {string}   THEME_KEY    — localStorage key constant
* - {Function} get_theme    — read the current persisted theme name
* - {Function} set_theme    — apply a theme and persist it
* - {Function} toggle_theme — flip between light and dark
*/

import {event_manager} from '../../common/js/event_manager.js'

// Storage key used for persisting the user's theme preference across sessions.
// Kept as a named export so that head-init.js and any other early-boot
// scripts can import the same constant rather than duplicating the literal.
export const THEME_KEY = 'dedalo_theme'

/**
* GET_THEME
* Returns the currently persisted theme name.
*
* Reads from `localStorage` and falls back to 'light' when no preference
* has been saved (first visit, incognito mode, or after storage was cleared).
* Does not inspect `document.documentElement` — the source of truth is always
* the persisted value, not the live DOM attribute.
*
* @returns {string} 'light' or 'dark'
*/
export function get_theme() {
	return localStorage.getItem(THEME_KEY) || 'light'
}

/**
* SET_THEME
* Applies the requested theme to the document and persists the choice.
*
* For 'dark': sets `data-theme="dark"` on `<html>` and writes the value
* to localStorage so it survives page reloads.
* For any other value (including 'light'): removes the attribute (restoring
* the default CSS cascade) and clears the localStorage entry so that no
* entry means 'light' — consistent with the fallback in get_theme().
*
* After updating the DOM and storage, publishes the 'theme_changed' event
* on the global event bus with the new theme string as payload. Subscribers
* (e.g. tile-based map renderers, canvas components) can listen to this
* event to swap their own theme-sensitive resources.
*
* (!) The 'theme_changed' event currently has no subscribers within core/.
* Any module that needs to react to theme changes must subscribe before
* set_theme() is called, or it will miss the initial notification.
*
* @param {string} t - Theme name to apply. Recognised values: 'light' | 'dark'.
*   Any value other than 'dark' is treated as 'light'.
* @returns {void}
*/
export function set_theme(t) {
	if (t === 'dark') {
		document.documentElement.setAttribute('data-theme', 'dark')
		localStorage.setItem(THEME_KEY, 'dark')
	} else {
		document.documentElement.removeAttribute('data-theme')
		localStorage.removeItem(THEME_KEY)
	}
	event_manager.publish('theme_changed', t)
}

/**
* TOGGLE_THEME
* Flips the active theme between 'dark' and 'light'.
*
* Reads the current persisted theme via get_theme(), inverts it, and
* delegates to set_theme() which handles DOM updates, storage persistence,
* and the 'theme_changed' event bus notification.
*
* Called by the menu's theme-toggle button (view_default_edit_menu.js) on
* click and on Enter/Space keydown.
*
* @returns {void}
*/
export function toggle_theme() {
	set_theme(get_theme() === 'dark' ? 'light' : 'dark')
}
