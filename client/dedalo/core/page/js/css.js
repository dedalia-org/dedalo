// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
 * DYNAMIC CSS MANAGER
 * Runtime stylesheet manager for Dédalo element-level CSS injection.
 *
 * Provides a single shared <style> element (id="elements_style_sheet") that is
 * created on first use and reused for all subsequent rule operations. All writes
 * go through a debounced queue (requestAnimationFrame) so that multiple style
 * updates triggered in the same JS turn are coalesced into one DOM mutation.
 *
 * Exported API:
 *   set_element_css(key, value)     – Build and queue rules for a component key
 *   prune_rules(condition_fn)       – Remove rules that satisfy a predicate
 *   get_inserted_rules()            – Return the live inserted-rules registry Map
 *   get_elements_style_sheet()      – Return (or lazily create) the CSSStyleSheet
 *
 * Internal pipeline:
 *   set_element_css → process_rule → queue_style_update → flush_style_updates → safe_insert_rule
 *
 * The inserted_rules Map acts as a local mirror of what is in the stylesheet so
 * that duplicate inserts and stale-rule replacements can be detected without
 * iterating cssRules (which is O(n) in some browsers).
 */



/**
 * INSERTED_RULES
 * Registry that mirrors every CSS rule currently held in the dynamic stylesheet.
 * Keyed by the normalized CSS selector string; values record only the rule text.
 *
 * Entry shape:
 * {
 *   "key":   "#col_section_id::before",        // normalized selector (Map key)
 *   "value": {
 *     "rule_text": "#col_section_id::before { content:'Id' }"
 *   }
 * }
 *
 * (!) Absolute indices are deliberately NOT cached. insertRule/deleteRule shift
 * every later index, so any stored index goes stale after another rule is deleted.
 * Nor are rules located by comparing selector strings: the browser re-serializes
 * selectorText (':before' -> '::before', spaces around combinators, quoted
 * attribute values…), so a string match silently misses. Instead each key keeps
 * the live CSSRule OBJECT (rule_of_key) and its index is found by identity at
 * delete time; key_of_rule maps back so prune_rules evicts the right entry.
 *
 * @var {Map<string, {rule_text: string}>} inserted_rules
 */
const inserted_rules	= new Map();
const rule_of_key		= new Map();		// key -> CSSRule (kept apart: inserted_rules is JSON-dumped by the debug panel)
const key_of_rule		= new WeakMap();	// CSSRule -> key



/**
 * SET_ELEMENT_CSS
 * Translate a component-level style descriptor into one or more dynamic CSS rules
 * and queue them for insertion into the shared stylesheet.
 *
 * The `value` parameter is a map from logical selector fragments to either:
 *   - a CSS-properties object: { width: '12%', 'grid-column': 'span 2' }
 *     (nested '@media …' / '@supports …' / '&:hover' blocks allowed, see process_rule)
 *   - a callback function that returns { selector, value } for custom/responsive rules
 *     (see ui.make_column_responsive)
 *
 * The special key 'add_class' is skipped — it is handled by the wrapper builders
 * (class list mutation, not stylesheet injection).
 *
 * Selector construction for non-callback entries (each top-level comma branch
 * is scoped on its own, so 'a, b' never leaks 'b' globally):
 *   - fragment starts with '.wrapper' -> compound: `.${key}${fragment}`
 *     e.g. `.oh1_rsc75.edit.wrapper_component`
 *   - otherwise -> direct child: `.${key} > ${fragment}` (no extra '>' when the
 *     fragment already leads with one) e.g. `.oh1_rsc75.edit > .content_data`
 *
 * Declared async for historical call sites that await it; it does no async work.
 *
 * @param {string} key - Scope class(es) without the leading dot, e.g. 'oh1_rsc75.oh62.edit'
 * @param {Object} value - Style descriptor map (see above)
 * @returns {Promise<boolean>} true when processed, false when `value` is empty or not a plain object
 */
export const set_element_css = async function(key, value) {

	// Validate value parameter - must be non-empty object
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
		// empty object or invalid type
		return false;
	}

	// add all
		for(const selector in value) {

			if (selector==='add_class') {
				continue;
			}

			const json_css_values = value[selector] || null

			if (typeof json_css_values==='function') {

				// make_column_responsive and all custom case
				// see ui.make_column_responsive
					const data = json_css_values()

				// process and insert rule
				process_rule(data.selector, data.value)
				continue
			}

			// style values like {"width": "12%", height : "150px"}
			if (!json_css_values || typeof json_css_values!=='object' || Array.isArray(json_css_values)) {
				if(SHOW_DEBUG===true) {
					console.warn('set_element_css: ignored non-object style:', key, selector, json_css_values);
				}
				continue;
			}

			// components case
			const full_selector = split_top_level_commas(selector)
				.map(fragment => scope_fragment(key, fragment))
				.join(', ')

			// process and insert rule
			process_rule(full_selector, json_css_values)
		}


	return true
}//end set_element_css



/**
 * SCOPE_FRAGMENT
 * Prefix one selector fragment with the element scope class.
 * @param {string} key - scope class(es) without the leading dot
 * @param {string} fragment - e.g. '.wrapper_component' | '.content_data' | '> .label'
 * @returns {string}
 */
const scope_fragment = function(key, fragment) {

	const clean = fragment.trim()

	if (clean.indexOf('.wrapper')===0) {
		return `.${key}${clean}` // like .oh1_rsc75.edit.wrapper_component
	}

	// direct children operator. Omit '>' when the fragment already leads with it
	const operator = clean.indexOf('>')===0 ? '' : '> '

	return `.${key} ${operator}${clean}` // like .oh1_rsc75.edit > .content_data
}//end scope_fragment



/**
 * SPLIT_TOP_LEVEL_COMMAS
 * Split a selector list on the commas that separate branches, ignoring commas
 * inside (), [] or quotes — ':is(.a, .b)' stays one branch.
 * @param {string} selector
 * @returns {Array<string>}
 */
const split_top_level_commas = function(selector) {

	const parts	= []
	let depth	= 0
	let quote	= null
	let start	= 0
	for (let i = 0; i < selector.length; i++) {
		const c = selector[i]
		if (quote) {
			if (c===quote && selector[i-1]!=='\\') quote = null
		}else if (c==='"' || c==="'") {
			quote = c
		}else if (c==='(' || c==='[') {
			depth++
		}else if (c===')' || c===']') {
			depth--
		}else if (c===',' && depth===0) {
			parts.push(selector.slice(start, i))
			start = i + 1
		}
	}
	parts.push(selector.slice(start))

	return parts.filter(el => el.trim()!=='')
}//end split_top_level_commas



/**
 * PROCESS_RULE
 * Serialize a CSS-properties descriptor into ONE style rule for `selector` (plus
 * its dark-theme counterpart) and hand it to the update queue.
 *
 * Nested blocks use NATIVE CSS NESTING inside the owner rule, so the owner
 * selector stays the single queue / cache key:
 *   { width:'50%', '@media (max-width: 768px)': { width:'100%' } }
 *   -> `.X { width:50%; @media (max-width: 768px) { width:100% } }`
 *   { '&:hover': {...} } or { ':hover': {...} } -> `.X { &:hover { … } }`
 * (!) Before 2026-11 nested blocks were queued under their bare prelude, so every
 * component sharing a media query overwrote the others (only the last kept its
 * responsive css) and deep nesting lost its outer at-rule.
 *
 * Legacy shapes kept as they always rendered:
 *   - v5 `style` / `mixin` sub-keys: skipped (they never matched anything in v6/v7;
 *     switching them on would restyle live layouts unreviewed).
 *   - any other nested selector key (no '&'): ancestor semantics `.anc &`, which
 *     is what the old wrapper `anc { selector {…} }` meant under CSS nesting.
 *
 * Values: strings and numbers. `content` values are single-quoted.
 * Author-supplied literal colours additionally yield a dark-theme counterpart
 * (see adapt_color_for_dark), queued as `:root[data-theme="dark"] <selector>`.
 *
 * @param {string} selector - Full CSS selector (e.g. '.rsc170_rsc20.edit.wrapper_component')
 * @param {Object} json_css_values - CSS-property object, may contain nested blocks
 * @returns {{body: string, dark_body: string}} the serialized rule bodies
 */
const process_rule = function(selector, json_css_values) {

	const { body, dark_body } = build_body(selector, json_css_values)

	if (body.length > 0) {
		queue_style_update(selector, body)
	}

	// Dark counterpart as its own rule. `:root[data-theme="dark"]` adds
	// (0,2,0) of specificity on top of the base selector, so it always wins
	// without needing !important, and both rules coexist: toggling the theme
	// needs no re-injection.
	if (dark_body.length > 0) {
		// prefix every comma branch, or branches 2+ would get the dark value in light theme
		const dark_selector = split_top_level_commas(selector)
			.map(branch => `${DARK_ROOT} ${branch.trim()}`)
			.join(', ')
		queue_style_update(dark_selector, dark_body)
	}


	return { body, dark_body }
}//end process_rule



/**
 * BUILD_BODY
 * Recursive serializer behind process_rule.
 * @param {string} selector - owner selector, only used for debug messages
 * @param {Object} json_css_values
 * @returns {{body: string, dark_body: string}}
 */
const build_body = function(selector, json_css_values) {

	const rules			= []
	const dark_rules	= []

	for(const key in json_css_values) {

		const value = json_css_values[key];

		if (typeof value==='string' || typeof value==='number') {
			// Handle content property with quotes, others without
			rules.push(key === 'content'
				? `${key}:'${value}'`
				: `${key}:${value}`
			)

			// dark theme counterpart for author-supplied literal colours
			const dark_value = adapt_color_for_dark(key, value)
			if (dark_value!==null) {
				dark_rules.push(`${key}:${dark_value}`)
			}
			continue
		}

		if (typeof value!=='object' || value===null || Array.isArray(value)) {
			if (key!=='mixin' && SHOW_DEBUG===true) {
				console.warn('set_element_css: ignored unsupported css value:', selector, key, value);
			}
			continue
		}

		if (key==='style') {
			// legacy v5 {mixin, style} shape: never rendered, see header
			if(SHOW_DEBUG===true) {
				console.warn('set_element_css: ignored legacy v5 "style" block:', selector, value);
			}
			continue
		}

		// nested block prelude
		const prelude = key.charAt(0)==='@' || key.indexOf('&')!==-1
			? key					// '@media …' / '&:hover' / '.parent &'
			: key.charAt(0)===':'
				? `&${key}`			// ':hover' -> '&:hover'
				: `${key} &`		// legacy ancestor key

		const deep = build_body(selector, value)
		if (deep.body.length > 0) {
			rules.push(`${prelude} { ${deep.body} }`)
		}
		if (deep.dark_body.length > 0) {
			dark_rules.push(`${prelude} { ${deep.dark_body} }`)
		}
	}


	return {
		body		: rules.join('; '),
		dark_body	: dark_rules.join('; ')
	}
}//end build_body



/**
 * ADAPT_COLOR_FOR_DARK
 * Map an author-supplied (ontology) colour to its dark-theme counterpart.
 *
 * Colours injected through set_element_css come from `dd_ontology` component
 * properties — they are DATA, authored against the light palette, and therefore
 * survive the `[data-theme="dark"]` token overrides untouched. Left alone, a
 * light surface colour keeps painting a near-white slab under the dark theme
 * and the (now near-white) ink on top becomes unreadable.
 *
 * The mapping is the same policy the hand-tuned dark palette follows in
 * theme_dark.less: KEEP THE HUE (it is meaningful — it encodes the section /
 * field grouping), damp the saturation, and move the lightness to the band the
 * dark theme uses. Expressed with CSS relative colour syntax so the browser
 * does the conversion and any colour notation is accepted:
 *
 *   #fef1e4 (surface) -> hsl(from #fef1e4 h calc(s * 0.42) 18%) ~= #402e1c
 *                        (theme_dark's hand-picked --color_hilite is #4a3424)
 *
 * Only single-token literal colours are adapted. `var(…)` values are already
 * theme-aware, and keywords (`transparent`, `inherit`, `currentColor`) plus
 * shorthand/gradient values have no single colour to map, so all are skipped.
 *
 * @param {string} property - CSS property name, e.g. 'background-color'
 * @param {string} value    - Author-supplied value, e.g. '#ffe2ab'
 * @returns {string|null} The dark-theme value, or null when the declaration is
 *   not an adaptable colour and must be left exactly as authored
 */
const DARK_ROOT				= ':root[data-theme="dark"]'
const surface_prop_re		= /^(background|background-color)$/
const line_prop_re			= /^(border(-(top|right|bottom|left))?-color|outline-color)$/
const ink_prop_re			= /^(color|fill|stroke)$/
const literal_color_re		= /^(#[0-9a-f]{3,8}|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|[a-z]{3,20})$/i
const color_keyword_re		= /^(transparent|inherit|initial|unset|revert|none|currentcolor|auto)$/i
const adapt_color_for_dark = function(property, value) {

	const prop = String(property).toLowerCase().trim()

	const is_surface	= surface_prop_re.test(prop)
	const is_line		= line_prop_re.test(prop)
	const is_ink		= ink_prop_re.test(prop)
	if (!is_surface && !is_line && !is_ink) {
		return null
	}

	const raw = String(value).trim()
	if (!literal_color_re.test(raw) || color_keyword_re.test(raw)) {
		return null // var(), shorthand, gradient, keyword… : leave as authored
	}

	if (is_ink) {
		// ink is lifted into the light band so it reads on a dark surface
		return `hsl(from ${raw} h calc(s * 0.55) 78%)`
	}
	if (is_line) {
		// borders sit between surface and ink: visible, never glaring
		return `hsl(from ${raw} h calc(s * 0.42) 34%)`
	}

	// surface. 18% is the ceiling that keeps --field_label_fg (#9aa3ae, the
	// smallest ink that lands on these surfaces) at ~5:1 — WCAG AA.
	return `hsl(from ${raw} h calc(s * 0.42) 18%)`
}//end adapt_color_for_dark



/**
 * QUEUE_STYLE_UPDATE
 * Batch-collect CSS rule updates and schedule a single DOM flush via
 * requestAnimationFrame to deduplicate rapid back-to-back writes.
 *
 * The queue is keyed by selector. If the same selector is submitted multiple
 * times within one animation frame only the last rule_body wins (last-write-wins
 * within a frame). If the incoming rule_body is identical to the currently queued
 * one it is skipped immediately without rescheduling.
 *
 * requestAnimationFrame is used (rather than setTimeout/microtask) so that all
 * style mutations for a given render cycle are batched together and applied just
 * before the browser's next paint, minimising forced style recalculations.
 *
 * Module-level state (declared here for colocation):
 *   style_update_queue      – Pending selector→rule_body pairs
 *   style_update_scheduled  – Guard flag: true while a rAF callback is pending
 *
 * @param {string} selector - Full CSS selector to update (Map key)
 * @param {string} rule_body - Serialised CSS declarations WITHOUT the wrapping
 *   braces, e.g. 'width:12%; height:150px'
 * @returns {void}
 */
const style_update_queue	= new Map(); // selector -> rule_body
let style_update_scheduled	= false;
const queue_style_update = function(selector, rule_body) {

	const current = style_update_queue.get(selector);
	if (current === rule_body) {
		return; // skip identical queued rule
	}

	style_update_queue.set(selector, rule_body);

	if (!style_update_scheduled) {
		style_update_scheduled = true;
		requestAnimationFrame(flush_style_updates);
	}
}//end queue_style_update



/**
 * FLUSH_STYLE_UPDATES
 * Drain the pending style update queue and write every rule to the live
 * stylesheet in a single rAF callback.
 *
 * Resets style_update_scheduled before iterating so that any new updates
 * arriving during a (synchronous) safe_insert_rule call can schedule a
 * fresh rAF without being blocked by a stale true value.
 *
 * After all rules are processed the queue is cleared so that the Map does
 * not grow unboundedly across frames.
 *
 * @returns {void}
 */
const flush_style_updates = function() {
	style_update_scheduled = false;
	for (const [rule_selector, rule_body] of style_update_queue.entries()) {
		safe_insert_rule(rule_selector, rule_body);
	}
	style_update_queue.clear();
}//end flush_style_updates



/**
 * NORMALIZE_SELECTOR
 * Collapse whitespace so equivalent constructed selectors share one cache key.
 *
 * @param {string} selector
 * @returns {string}
 */
const normalize_selector = function(selector) {

	return selector.replace(/\s+/g, ' ').trim()
}//end normalize_selector



/**
 * SAFE_INSERT_RULE
 * Insert or replace a single CSS rule in the dynamic stylesheet, maintaining
 * the inserted_rules cache as a source of truth.
 *
 * Unchanged rule text is a no-op. A changed body replaces the previous rule:
 * the old CSSRule is located by IDENTITY (rule_of_key) — never by a cached
 * index nor by selector text — and removed, then the new one is appended.
 *
 * Errors from both deleteRule and insertRule are caught and warned so that a
 * single malformed rule (e.g. invalid selector from a callback) does not abort
 * the rest of the batch.
 *
 * @param {string} selector - Full CSS selector
 * @param {string} rule_body - Serialised declarations without outer braces
 * @returns {boolean} true when the rule was successfully inserted or replaced;
 *   false when insertion failed or no change was needed
 */
const safe_insert_rule = function(selector, rule_body) {

	// sheet
	const sheet = get_elements_style_sheet()

	// map key
	const key = normalize_selector(selector)

	// rule_text
	const rule_text = `${selector} { ${rule_body} }`;

	// check for already inserted rule
	const cached = inserted_rules.get(key);
	if (cached) {

		if (cached.rule_text === rule_text) {
			return false; // No change needed
		}

		// replace: remove exactly the rule this key inserted
		delete_key_rule(sheet, key)
	}

	try {
		const index	= sheet.insertRule(rule_text, sheet.cssRules.length);
		const rule	= sheet.cssRules[index]
		inserted_rules.set(key, { rule_text });
		rule_of_key.set(key, rule)
		key_of_rule.set(rule, key)
	} catch (e) {
		console.warn('Failed to insert rule', rule_text, e);
		inserted_rules.delete(key);
		rule_of_key.delete(key);
		return false;
	}


	return true;
}//end safe_insert_rule



/**
 * DELETE_KEY_RULE
 * Remove from the sheet the CSSRule previously inserted for key (by identity).
 * @param {CSSStyleSheet} sheet
 * @param {string} key
 * @returns {void}
 */
const delete_key_rule = function(sheet, key) {

	const rule = rule_of_key.get(key)
	if (!rule) {
		return
	}
	rule_of_key.delete(key)

	const index = Array.prototype.indexOf.call(sheet.cssRules, rule)
	if (index !== -1) {
		try {
			sheet.deleteRule(index);
		} catch (e) {
			console.warn('Failed to delete rule', e);
		}
	}
}//end delete_key_rule



/**
 * PRUNE_RULES
 * Remove all rules from the dynamic stylesheet that satisfy a caller-supplied
 * predicate, and evict the corresponding entries from inserted_rules.
 *
 * The predicate receives the raw CSSRule object (not just the selector) so
 * callers can match on any property, e.g.:
 *   prune_rules(rule => rule.selectorText.startsWith('.oh1_rsc75'))
 *
 * Iteration is performed in reverse index order (high → low) so that deleteRule()
 * does not invalidate the indices of remaining rules ahead of the cursor.
 * The cache entry is found through key_of_rule (rule identity), so it is evicted
 * even when the browser serialized the selector differently from the key.
 *
 * @param {Function} condition_fn - Predicate receiving a CSSRule; return true
 *   to delete the rule, false to keep it
 * @returns {void}
 */
export const prune_rules = function(condition_fn) {

	const sheet = get_elements_style_sheet();

	for (let i = sheet.cssRules.length - 1; i >= 0; i--) {

		const rule = sheet.cssRules[i];

		if (condition_fn(rule)) {

			// delete sheet rule by index
			sheet.deleteRule(i);

			// inserted_rules delete to keep the cache in sync
			const key = key_of_rule.get(rule)
			if (key!==undefined) {
				inserted_rules.delete(key);
				rule_of_key.delete(key);
			}
		}
	}
}//end prune_rules



/**
 * IS_SELECTOR_ALIVE
 * Check whether a rule's selector still matches at least one element in the DOM.
 *
 * Pseudo-classes and pseudo-elements are stripped so the test is state-independent
 * (e.g. a ':hover' rule is not treated as orphan just because nothing is hovered).
 * Stripping only ever broadens the match, so the test is biased towards keeping
 * rules: it never reports a live rule as orphan, at most it keeps a few dead ones.
 *
 * @param {CSSRule} rule
 * @returns {boolean} true to keep (an element matches, or presence can't be
 *   determined); false when the rule is orphan (no element matches) and safe to prune
 */
const pseudo_re = /:{1,2}[a-zA-Z-]+(\([^)]*\))?/g;
const theme_scope_re = /^\s*:root\[data-theme=[^\]]*\]\s+/i;
const is_selector_alive = function(rule) {

	// Non-style rules (media, keyframes, font-face...) have no selectorText.
	// They are few and cannot be DOM-tested: keep them.
	const selector_text = rule && rule.selectorText;
	if (!selector_text) {
		return true
	}

	// test each comma separated branch independently
	const ar_selector = selector_text.split(',');
	for (let i = 0; i < ar_selector.length; i++) {

		// strip the theme scope FIRST. `:root[data-theme="dark"] .foo` (the dark
		// counterpart emitted by process_rule) matches nothing while the light
		// theme is active, so testing it as-is would prune every dark rule the
		// moment the user is on light — and the components would then render
		// unthemed after a toggle. The rule lives or dies with its base selector.
		// stripping pseudo-classes / pseudo-elements and any dangling combinators
		const clean = ar_selector[i]
			.replace(theme_scope_re, '')
			.replace(pseudo_re, '')
			.replace(/[>+~\s]+$/, '')
			.trim();

		if (clean==='') {
			// nothing testable left: keep the rule to be safe
			return true
		}

		try {
			if (document.querySelector(clean)) {
				return true // at least one matching element is alive
			}
		} catch (e) {
			// unsupported/invalid selector after stripping: keep to be safe
			return true
		}
	}

	// no element matched any branch: the rule is orphan
	return false
}//end is_selector_alive



/**
 * PRUNE_ORPHAN_RULES
 * Remove only rules whose selector no longer matches any element in the DOM.
 * Frees memory from destroyed components (e.g. when browsing records) without
 * ever stripping CSS from components that are still visible on screen.
 *
 * @returns {number} number of pruned rules
 */
export const prune_orphan_rules = function() {

	let pruned = 0;

	prune_rules((rule) => {
		const orphan = !is_selector_alive(rule);
		if (orphan) {
			pruned++;
		}
		return orphan
	});


	return pruned
}//end prune_orphan_rules



/**
 * GET_INSERTED_RULES
 * Return the live inserted-rules registry Map.
 * Callers may inspect it for debugging or to check whether a rule for a given
 * selector has already been injected, but should not mutate it directly —
 * all writes must go through safe_insert_rule so the cache stays consistent
 * with the stylesheet.
 *
 * @returns {Map<string, {rule_text: string}>} Reference to the
 *   module-level inserted_rules Map (not a copy)
 */
export const get_inserted_rules = function() {

	return inserted_rules
}//end get_inserted_rules



/**
 * GET_ELEMENTS_STYLE_SHEET
 * Return the singleton dynamic CSSStyleSheet, creating it on first access.
 *
 * On first call a <style id="elements_style_sheet"> element is appended to
 * <head> and its .sheet reference is stored on window.elements_style_sheet for
 * fast subsequent access without a DOM query. All later calls return the cached
 * reference directly.
 *
 * Storing on window (rather than a module-level variable) means the same sheet
 * is shared across ES module instances if more than one bundle is loaded into
 * the same window — useful in Dédalo's multi-panel layout where sections may be
 * loaded as separate module graphs.
 *
 * @throws {Error} When the browser fails to expose the sheet property after
 *   appending the <style> element (should not occur in any modern browser)
 * @returns {CSSStyleSheet} The live stylesheet object backed by
 *   window.elements_style_sheet
 */
export const get_elements_style_sheet = function() {

	if (!window.elements_style_sheet) {

		const style = document.createElement('style');
		style.id	= 'elements_style_sheet'

		// Append <style> element to <head>
		document.head.appendChild(style);

		// Grab style element's sheet
		window.elements_style_sheet = style.sheet;

		// Verify the sheet was created successfully
		if (!window.elements_style_sheet) {
			throw new Error('Failed to create stylesheet');
		}
	}

	return window.elements_style_sheet
}//end get_elements_style_sheet



// @license-end
