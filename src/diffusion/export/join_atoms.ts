/**
 * THE VALUE FOLD of the export (T0-9, owner decision D1): the flat cell string
 * of a value-format column — and of a WC-008 compact portal cell — is a FOLD
 * over the SAME grid atoms the grid_value format emits, never a second walker.
 * Byte port of PHP export_value::join / join_atoms
 * (core/dd_grid/class.export_value.php :193-364):
 *
 *   - RECORD dimension: atoms bucketed by the segment item_index at the current
 *     depth (null → the single virtual record -1), buckets in item_index order;
 *   - FIELD dimension: inside a record, atoms bucketed by the segment identity
 *     key ({section}_{component}[#sub_id]) in insertion order (= map order);
 *   - separators come from the PARENT segment (the relation around the level;
 *     defaults ' | ' records, ', ' fields at depth 0). The FIRST indexed level
 *     joins its records with records_separator, every DEEPER indexed level with
 *     the parent's fields_separator (the legacy sub-column rule);
 *   - a leaf joins its values with the LEAF segment's fields_separator;
 *   - PHP empty() is applied bug-for-bug: '' AND '0' are skipped at the leaf and
 *     as a field string (owner decision D3: as PHP);
 *   - a record KEEPS its slot when its fields join to '' (D3, PHP :356-358), so a
 *     value cell may read 'x |  | y'.
 *
 * The WC-049 parents MIRROR (value format, `joinExportAtomsMirrored`) is the
 * same fold run once: the term text is byte-identical to `joinExportAtoms` of
 * the term atoms (one code path), and at the mirror depth — the fan-out level of
 * the declared leaf relation — every record contributes its ancestor chain once
 * per piece its term text splits into on that level's record glue.
 *
 * Pure functions over atoms: no I/O, no state.
 */

import type { ExportSegment, GridAtom } from './atoms.ts';

/** PHP export_value join_atoms defaults (depth 0, or a parent without separators). */
const DEFAULT_RECORDS_SEPARATOR = ' | ';
const DEFAULT_FIELDS_SEPARATOR = ', ';

/** PHP empty() on an export atom value / joined string: '' and '0'. */
function phpEmpty(value: string): boolean {
	return value === '' || value === '0';
}

/** PHP export_path_segment::get_identity_key (sub_id joined with '#'). */
function identityKey(segment: ExportSegment): string {
	const base = `${segment.section_tipo}_${segment.component_tipo}`;
	return segment.sub_id !== undefined ? `${base}#${segment.sub_id}` : base;
}

/** The record bucket of an atom at `depth` (-1 = unindexed / absent segment). */
function recordKey(atom: GridAtom, depth: number): number {
	const segment = atom.segments[depth];
	return segment !== undefined && segment.item_index !== null ? segment.item_index : -1;
}

/** The field bucket of an atom at `depth` ('' = absent segment). */
function fieldKey(atom: GridAtom, depth: number): string {
	const segment = atom.segments[depth];
	return segment !== undefined ? identityKey(segment) : '';
}

function groupBy<K>(atoms: readonly GridAtom[], key: (atom: GridAtom) => K): Map<K, GridAtom[]> {
	const groups = new Map<K, GridAtom[]>();
	for (const atom of atoms) {
		const k = key(atom);
		const group = groups.get(k);
		if (group === undefined) groups.set(k, [atom]);
		else group.push(atom);
	}
	return groups;
}

/** One fold level: the term text, its parents mirror, whether a chain showed. */
interface Folded {
	text: string;
	mirror: string;
	hasChain: boolean;
}

/**
 * join_atoms at `depth`. `chains` = the parents atoms riding along (same
 * prefix segments as the term atoms they mirror, a `sub_id:'parents'` segment
 * at `mirrorDepth`); with `mirrorDepth` -1 the fold is the plain join.
 */
function fold(
	atoms: readonly GridAtom[],
	chains: readonly GridAtom[],
	depth: number,
	parent: ExportSegment | null,
	recordsLevelDone: boolean,
	mirrorDepth: number,
): Folded {
	const recordsSeparator = parent?.records_separator ?? DEFAULT_RECORDS_SEPARATOR;
	const fieldsSeparator = parent?.fields_separator ?? DEFAULT_FIELDS_SEPARATOR;

	// Record dimension (term atoms only decide it — the mirror never adds a slot).
	const recordGroups = groupBy(atoms, (atom) => recordKey(atom, depth));
	const hasIndex = [...recordGroups.keys()].some((key) => key !== -1);
	const groupSeparator = hasIndex && recordsLevelDone ? fieldsSeparator : recordsSeparator;
	const nextRecordsLevelDone = recordsLevelDone || hasIndex;
	const chainGroups =
		chains.length === 0 ? null : groupBy(chains, (atom) => recordKey(atom, depth));

	const records: string[] = [];
	const mirrors: string[] = [];
	let hasChain = false;
	for (const key of [...recordGroups.keys()].sort((a, b) => a - b)) {
		const recordAtoms = recordGroups.get(key) as GridAtom[];
		const recordChains = chainGroups?.get(key) ?? [];
		const fields: string[] = [];
		const fieldMirrors: string[] = [];
		const atMirror = depth === mirrorDepth;
		const fieldChains =
			atMirror || recordChains.length === 0
				? null
				: groupBy(recordChains, (atom) => fieldKey(atom, depth));

		for (const [field, fieldAtoms] of groupBy(recordAtoms, (atom) => fieldKey(atom, depth))) {
			const leafValues: string[] = [];
			const deeper: GridAtom[] = [];
			let leafSegment: ExportSegment | null = null;
			for (const atom of fieldAtoms) {
				if (atom.segments.length === depth + 1) {
					leafSegment = atom.segments[depth] as ExportSegment;
					leafValues.push(atom.value);
				} else {
					deeper.push(atom);
				}
			}
			if (leafValues.length > 0) {
				const leafSeparator = leafSegment?.fields_separator ?? DEFAULT_FIELDS_SEPARATOR;
				const leaf = leafValues.filter((value) => !phpEmpty(value)).join(leafSeparator);
				if (!phpEmpty(leaf)) {
					fields.push(leaf);
					fieldMirrors.push('');
				}
			}
			if (deeper.length > 0) {
				const below = fold(
					deeper,
					atMirror ? [] : (fieldChains?.get(field) ?? []),
					depth + 1,
					(deeper[0] as GridAtom).segments[depth] as ExportSegment,
					nextRecordsLevelDone,
					atMirror ? -1 : mirrorDepth,
				);
				if (!phpEmpty(below.text)) {
					fields.push(below.text);
					fieldMirrors.push(below.mirror);
					hasChain ||= below.hasChain;
				}
			}
		}

		// D3: the record keeps its slot even when its fields join to ''.
		const text = fields.join(fieldsSeparator);
		records.push(text);
		if (atMirror) {
			// One chain per piece a consumer splits out of this record's text.
			const chain =
				recordChains.find(
					(atom) =>
						atom.segments.length === depth + 1 && atom.segments[depth]?.sub_id !== undefined,
				)?.value ?? '';
			if (chain !== '') hasChain = true;
			mirrors.push(
				text
					.split(groupSeparator)
					.map(() => chain)
					.join(groupSeparator),
			);
		} else {
			mirrors.push(fieldMirrors.join(fieldsSeparator));
		}
	}
	return {
		text: records.join(groupSeparator),
		mirror: mirrors.join(groupSeparator),
		hasChain,
	};
}

/**
 * PHP export_value::join — the flat string of an atom subset ('' for none).
 */
export function joinExportAtoms(atoms: readonly GridAtom[]): string {
	if (atoms.length === 0) return '';
	return fold(atoms, [], 0, null, false, -1).text;
}

/**
 * {@link joinExportAtoms} of `termAtoms` plus its WC-049 parents mirror: the
 * `chainAtoms` (sub_id 'parents') sit at `mirrorDepth` — the segment index of
 * the declared leaf relation's fan-out level. The mirror has the term's exact
 * join structure; `hasChain` is false when no record carried a chain.
 */
export function joinExportAtomsMirrored(
	termAtoms: readonly GridAtom[],
	chainAtoms: readonly GridAtom[],
	mirrorDepth: number,
): { text: string; mirror: string; hasChain: boolean } {
	if (termAtoms.length === 0) return { text: '', mirror: '', hasChain: false };
	return fold(termAtoms, chainAtoms, 0, null, false, mirrorDepth);
}
