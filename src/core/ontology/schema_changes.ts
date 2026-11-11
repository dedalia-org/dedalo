/**
 * Ontology schema-change files — the "Latest changes" panel of
 * component_security_access (PHP hierarchy::get_simple_schema_changes_files /
 * parse_simple_schema_changes_file). The writer is saveSimpleSchemaFile
 * (ontology_update.ts): one additions-only diff per ontology update, named
 * `simple_schema_changes_<YYYY-MM-DD_HH-MM-SS>.json`, raw shape
 * `[{tipo, children_added: string[]}]`.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDir } from '../../config/env.ts';
import { DedaloError } from '../errors/index.ts';
import { getOntologyTermLabel } from './labels.ts';
import { getNode } from './resolver.ts';

/** Where saveSimpleSchemaFile writes (PHP DEDALO_BACKUP_PATH_ONTOLOGY/changes). */
export const SCHEMA_CHANGES_DIR = join(privateDir, 'backups', 'ontology', 'changes');

/** The ONLY names listed or read — the client parses the stamp out of it, and it is the path guard. */
const FILENAME_PATTERN = /^simple_schema_changes_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/;

/** Bare filenames, newest first (PHP arsort); a missing dir lists nothing. */
export function listSchemaChangesFiles(dir: string = SCHEMA_CHANGES_DIR): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => FILENAME_PATTERN.test(name))
		.sort()
		.reverse();
}

interface TipoLabel {
	tipo: string;
	label: string;
}

export interface SchemaChange {
	section: TipoLabel;
	/** Farthest ancestor first, `dd0` excluded (PHP get_ar_parents_of_this + krsort). */
	parents: TipoLabel[];
	children: TipoLabel[];
}

const tipoLabel = async (tipo: string): Promise<TipoLabel> => ({
	tipo,
	label: await getOntologyTermLabel(tipo),
});

async function parentChain(tipo: string): Promise<string[]> {
	const chain: string[] = [];
	const seen = new Set([tipo]);
	// a missing/empty parent ends the chain like the root `dd0` does
	let parent = (await getNode(tipo))?.parent || 'dd0';
	while (parent !== 'dd0' && !seen.has(parent)) {
		chain.push(parent);
		seen.add(parent);
		parent = (await getNode(parent))?.parent || 'dd0';
	}
	return chain.reverse();
}

/**
 * One change file, enriched with app-lang labels + the parent chain. The
 * filename is client-supplied: anything but a bare writer-shaped name is
 * refused before it touches the filesystem. An absent/empty/unparseable file
 * answers [] (PHP parity); malformed entries are skipped.
 */
export async function parseSchemaChangesFile(
	filename: unknown,
	dir: string = SCHEMA_CHANGES_DIR,
): Promise<SchemaChange[]> {
	if (typeof filename !== 'string' || !FILENAME_PATTERN.test(filename)) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'invalid schema changes filename',
		});
	}
	const changes: SchemaChange[] = [];
	for (const entry of await readRawEntries(join(dir, filename))) {
		changes.push({
			section: await tipoLabel(entry.tipo),
			parents: await Promise.all((await parentChain(entry.tipo)).map(tipoLabel)),
			children: await Promise.all(entry.children_added.map(tipoLabel)),
		});
	}
	return changes;
}

interface RawEntry {
	tipo: string;
	children_added: string[];
}

/** The file's well-formed `{tipo, children_added}` entries; [] when absent/empty/unparseable. */
async function readRawEntries(path: string): Promise<RawEntry[]> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, 'utf8'));
	} catch {
		return [];
	}
	return (Array.isArray(raw) ? raw : []).filter(isRawEntry).map((entry) => ({
		tipo: entry.tipo,
		children_added: entry.children_added.filter((c): c is string => typeof c === 'string'),
	}));
}

function isRawEntry(entry: unknown): entry is { tipo: string; children_added: unknown[] } {
	const candidate = entry as { tipo?: unknown; children_added?: unknown } | null;
	return typeof candidate?.tipo === 'string' && Array.isArray(candidate.children_added);
}
