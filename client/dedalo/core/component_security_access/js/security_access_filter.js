// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * SECURITY_ACCESS_FILTER
 *
 * Pure (DOM-free) matching layer for the component_security_access permission tree.
 *
 * The ACL tree is ~32k ontology ENTRIES and the view renders it LAZILY (only the
 * root areas exist in the DOM; a branch is built on first expand). A hide/show
 * filter therefore cannot work — the matching nodes are not in the DOM at all. The
 * answer this module gives is the one the render layer needs: the flat subset to
 * render, which is every MATCH plus its ANCESTOR PATH (so the tree keeps its
 * hierarchy and the path to each match is visible). The renderer hierarchizes that
 * subset by `parent` exactly as it does the full datalist, which is why no
 * child-resolution logic has to change.
 *
 * ENTRIES, NOT TIPOS. The datalist repeats a tipo: a section_group shared by many
 * sections appears once per section (measured on a real install: 31,958 entries,
 * 4,056 unique tipos, one grouper 343 times). `tipo` alone is therefore NOT a node
 * identity, and a tipo-keyed walk both loses the path of every duplicate and
 * miscounts. Everything below is indexed by ENTRY, with the parent link resolved
 * the way the renderer resolves it: an element's parent lives in its own
 * `section_tipo` scope; a section/area's parent is a section/area node.
 *
 * NOT EVERY ENTRY IS REACHABLE. The datalist also carries entries whose ancestor
 * area is denied for the viewer (measured: 846). They can never paint (the tree
 * starts at `parent === 'dd1'`), so they neither match nor count.
 *
 * Filtering is VISUAL ONLY. Nothing here reads or writes self.filled_value; the
 * permission values, and every propagation walk, keep using the FULL datalist.
 *
 * No DOM, no component instance, no storage — so it is testable in the client suite,
 * where the render path (live ontology datalist + permissions) is unavailable.
 */

/**
 * MATCH_LIMIT
 * Matches rendered at most. A one-character query over ~32k entries can match
 * thousands, and every match drags its own label + radio group into the DOM; the
 * cap keeps one keystroke from freezing the page. The counter still reports the
 * REAL total of matching entries, and the view says the list is truncated —
 * narrowing reveals the rest.
 */
export const MATCH_LIMIT = 500;

/**
 * NORMALIZE_TEXT
 * Folds a value to its comparable form: NFD-decomposed, combining marks stripped,
 * lowercased. So 'España' and 'ESPANA' both fold to 'espana' and a user typing
 * either one finds the node.
 *
 * shortcut: letters with no canonical decomposition (ß, ø, æ) do not fold, and
 * query punctuation is kept as-is. Upgrade only if operators ask for it.
 * @param {*} value
 * @returns {string}
 */
export const normalize_text = function (value) {
	return String(value ?? '')
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '') // combining marks left by the NFD decomposition
		.toLowerCase();
}; //end normalize_text

/**
 * PARSE_QUERY
 * Splits the raw search box value into normalized tokens. An empty / whitespace-only
 * query yields an empty token list, which means "no filter" (not "matches nothing").
 * @param {*} query
 * @returns {string[]}
 */
export const parse_query = function (query) {
	return normalize_text(query).split(/\s+/).filter(Boolean);
}; //end parse_query

/**
 * ITEM_MATCHES
 * True when EVERY token appears in the node's searchable text, so 'user name' and
 * 'name user' find the same node.
 *
 * Searchable text = label + tipo. `model` is deliberately NOT searched: every
 * component model name contains 'component', so it would match the whole tree.
 * label is nullable in the datalist (foreign/unresolvable tipos), hence the
 * normalize_text null-guard rather than a direct .includes.
 *
 * @param {Object} item - datalist entry {tipo, section_tipo, model, label, parent, …}
 * @param {string[]} tokens - output of parse_query
 * @returns {boolean}
 */
export const item_matches = function (item, tokens) {
	if (!tokens || tokens.length === 0) {
		return true;
	}

	const haystack = `${normalize_text(item?.label)} ${normalize_text(item?.tipo)}`;

	return tokens.every((token) => haystack.includes(token));
}; //end item_matches

/**
 * BUILD_PARENT_LINKS
 * The parent ENTRY of every entry, as the renderer would resolve it:
 *   - `parent === 'dd1'` → -1 (root; the tree starts here).
 *   - section / area node (`tipo === section_tipo`) → the section-like entry whose
 *     tipo is `parent`.
 *   - element → an entry of its OWN section with that tipo (a grouper), else the
 *     section/area node that tipo names, else its own section.
 * `-2` marks "no parent entry": the chain cannot reach the tree, so the entry is
 * not renderable at all.
 * @param {Array} list - full flat datalist
 * @returns {Int32Array} one parent index per entry
 */
const build_parent_links = function (list) {
	const section_like = new Map(); // tipo → index, entries with tipo === section_tipo
	const in_section = new Map(); // `${section_tipo}\0${tipo}` → index, element entries

	for (let i = 0; i < list.length; i++) {
		const entry = list[i];
		if (entry === null || entry === undefined || typeof entry.tipo !== 'string') {
			continue;
		}
		if (entry.tipo === entry.section_tipo) {
			if (!section_like.has(entry.tipo)) {
				section_like.set(entry.tipo, i);
			}
		} else {
			const key = `${entry.section_tipo}\u0000${entry.tipo}`;
			if (!in_section.has(key)) {
				in_section.set(key, i);
			}
		}
	}

	const parent_links = new Int32Array(list.length).fill(-2);

	for (let i = 0; i < list.length; i++) {
		const entry = list[i];
		if (entry === null || entry === undefined) {
			continue;
		}
		if (entry.parent === 'dd1') {
			parent_links[i] = -1;
			continue;
		}
		let parent_index;
		if (entry.tipo === entry.section_tipo) {
			parent_index = section_like.get(entry.parent);
		} else {
			parent_index = in_section.get(`${entry.section_tipo}\u0000${entry.parent}`);
			if (parent_index === undefined) {
				parent_index = section_like.get(entry.parent);
			}
			if (parent_index === undefined) {
				parent_index = section_like.get(entry.section_tipo);
			}
		}
		parent_links[i] = parent_index === undefined || parent_index === i ? -2 : parent_index;
	}

	return parent_links;
};

/**
 * FILTER_TREE
 * Resolves the flat subset to render for one query.
 *
 * A match is kept only when its parent chain reaches a root (`parent === 'dd1'`),
 * and the whole chain is kept with it — that is what makes the match visible and
 * what makes `match_count` honest: it counts matching ENTRIES that will actually
 * paint. Ancestors are context, not matches.
 *
 * Kept entries are returned in the ORIGINAL datalist order (pre-order), which is
 * what the renderer's hierarchization pass expects. Above MATCH_LIMIT matches the
 * list stops growing (the newest matches are not painted) but the counter keeps
 * reporting the real total, and `truncated` says so.
 *
 * `matches` is a Set of the matching ENTRIES that will paint (entry identity, not
 * tipo): the view marks exactly those, so an ancestor kept for the path is never
 * highlighted as if it were a result.
 *
 * @param {Array} datalist - full flat ACL tree (self.data.datalist)
 * @param {string} query - raw search box value
 * @returns {Object|null} {items:Array, matches:Set, match_count:number,
 *   truncated:boolean}, or null when the query holds no tokens (= no filter:
 *   render the normal lazy tree)
 */
export const filter_tree = function (datalist, query) {
	const tokens = parse_query(query);
	if (tokens.length === 0) {
		return null;
	}

	const list = Array.isArray(datalist) ? datalist : [];
	const parent_links = build_parent_links(list);

	// reachability: 0 unknown, 1 reaches the tree, 2 does not
	const reachable = new Uint8Array(list.length);
	const is_reachable = function (start) {
		const path = [];
		let current = start;
		for (let guard = 0; guard < 64; guard++) {
			if (current < 0) {
				const ok = current === -1;
				for (const index of path) {
					reachable[index] = ok ? 1 : 2;
				}
				return ok;
			}
			if (reachable[current] === 1) {
				for (const index of path) {
					reachable[index] = 1;
				}
				return true;
			}
			if (reachable[current] === 2) {
				for (const index of path) {
					reachable[index] = 2;
				}
				return false;
			}
			path.push(current);
			current = parent_links[current];
		}
		// a parent cycle: not a tree path, so not renderable
		for (const index of path) {
			reachable[index] = 2;
		}
		return false;
	};

	// entries that matched AND will paint: the view highlights exactly these, so a
	// match is never confused with the ancestors kept only to show its path
	const keep = new Set();
	const matches = new Set();
	let match_count = 0;
	let painted_matches = 0;

	for (let i = 0; i < list.length; i++) {
		if (!item_matches(list[i], tokens)) {
			continue;
		}
		if (!is_reachable(i)) {
			continue; // counted nowhere: it can never paint
		}
		match_count++;
		if (painted_matches >= MATCH_LIMIT) {
			continue;
		}
		painted_matches++;
		matches.add(list[i]);
		let current = i;
		while (current >= 0 && !keep.has(current)) {
			keep.add(current);
			current = parent_links[current];
		}
	}

	const items = [];
	for (let i = 0; i < list.length; i++) {
		if (keep.has(i)) {
			items.push(list[i]);
		}
	}

	return {
		items: items,
		matches: matches,
		match_count: match_count,
		truncated: match_count > painted_matches,
	};
}; //end filter_tree

// @license-end
