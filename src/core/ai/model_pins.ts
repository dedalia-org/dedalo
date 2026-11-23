/**
 * MODEL PINS — the repo-owned answer to "which bytes ARE this model".
 *
 * `model_pins.json` beside this file records, per catalog model id, the hub's
 * IMMUTABLE revision (a 40-hex commit sha) and, per file the downloader can ask
 * for, the sha256 and byte size. It plays the role `vendor/vendor_manifest.json`
 * plays for vendored client code and the `.sha256` sidecar plays for a code
 * update: a downloaded artifact is fetched BY the pinned revision, hashed after
 * transport, and refused — quarantined — when the digest disagrees. A model with
 * no pin is refused before a byte (the hub's `main` is a mutable head, and
 * fetching whatever it points at today is exactly CARRY-06).
 *
 * Where the digests come from: `bun run scripts/pin_ai_models.ts --model <id>
 * --reason "<why>"` — the hub's model API answers the revision sha and, for
 * every LFS weight, `lfs.oid` (its sha256, no gigabyte download needed); the
 * small non-LFS files (config, tokenizer) carry only a git blob id, so the
 * script downloads them at the pinned revision and hashes the bytes. That is the
 * ONE documented way to change a digest, and every change carries `pinned_at`
 * and a `reason` (leg (g) of `model_artifact_integrity_native` refuses an
 * entry without them).
 *
 * UNPINNED models and files — policy, recorded here so the choice is visible:
 *   - An operator's OWN model (rsynced into the store, outside the catalog, or a
 *     file outside `wantedFiles()`) is still SERVABLE and reports `unverified`;
 *     the store was always a folder of files an institution owns.
 *   - An ENGINE-DRIVEN download of an unpinned model is refused: the engine
 *     will not fetch bytes it cannot verify.
 *   - A catalog model the hub does not serve (`unpinned` block, with a reason)
 *     is enumerated, shrink-only, by the gate — never a hand-invented digest.
 *
 * `PINS` is parsed once at module load and frozen — data, not state. The
 * `table` parameter on every reader is a TEST SEAM (a gate pins a fixture model
 * against a loopback hub); production callers never pass it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DedaloError } from '../errors/index.ts';
import { SHA256_HEX } from './model_integrity.ts';

/** The pin of one file: what its bytes must hash to, and how many there are. */
export interface FilePin {
	sha256: string;
	size: number;
}

/**
 * WHAT TERMS THE PINNED BYTES COME UNDER — recorded next to the digests (owner
 * 2026-11-22), because an install downloads them on this repo's word.
 *
 * Read from the hub's model API (`cardData.license`, `license_link`,
 * `base_model`) by `scripts/pin_ai_models.ts`, never typed by hand:
 *   - `card` — what the PINNED repository's own model card declares (`license`
 *     null when it declares none: most ONNX conversions carry no card at all);
 *   - `upstream` — the base model the conversion was made from, with ITS card's
 *     licence. `named_by: 'card'` when the conversion's card names its base;
 *     `'repo_name'` when the card is silent and the base is the one the
 *     repository name reproduces (the pin script's UPSTREAM_WHEN_CARD_SILENT,
 *     each with its evidence). Null when the pinned repository IS the original;
 *   - `name` / `url` — the licence that GOVERNS these bytes and the page it was
 *     read from: the card's own declaration, else the upstream's (a quantised
 *     conversion is a derivative of its base and carries its base's terms).
 *     `declared_by` says which.
 * `licenceProblems` is the validator; the gate refuses a pin without a record.
 * Whether a licence suits Dédalo is a HUMAN judgement recorded in the catalogue
 * (`register.json`), not here — this is the evidence it is made on.
 */
export interface ModelLicence {
	name: string;
	url: string;
	declared_by: 'card' | 'upstream';
	card: { license: string | null; url: string };
	upstream: {
		model: string;
		license: string | null;
		url: string;
		named_by: 'card' | 'repo_name';
	} | null;
}

/** The pin of one model: the immutable revision and every pinned file. */
export interface ModelPin {
	/** The hub's commit sha the files were pinned at (40 hex). */
	revision: string;
	/** ISO date the pin was taken or last changed. */
	pinned_at: string;
	/** Why this pin exists or changed — a sentence, never empty. */
	reason: string;
	/** The terms the bytes come under (required — `licenceProblems`). */
	licence?: ModelLicence;
	files: Record<string, FilePin>;
}

/**
 * HOW A TEMPLATED CATALOG ENTRY WAS EXPANDED — the reproducible record of a
 * one-model-per-pair catalogue (`Xenova/opus-mt-{src}-{tgt}`). The pin script
 * probes every ordered pair of `langs` against the hub's revision API and
 * records the ids that EXIST; a pair the hub does not serve (404/401) is simply
 * not part of the catalogue. Re-running `--expand` with the same `langs`
 * recomputes it.
 */
export interface TemplateExpansion {
	/** The candidate languages (ISO 639-1), every ordered pair of which was probed. */
	langs: string[];
	computed_at: string;
	reason: string;
	/** How many ids were probed (langs × (langs − 1)). */
	probed: number;
	/** The ids the hub serves — the catalogue's concrete models for this template. */
	present: string[];
}

export interface PinTable {
	models: Record<string, ModelPin>;
	/** Catalog models that COULD NOT be pinned, each with the reason. Shrink-only. */
	unpinned: Record<string, { reason: string }>;
	/**
	 * Templated catalog entries → how they were expanded (see TemplateExpansion).
	 * Always present on a PARSED table; optional so a gate's fixture table need
	 * not spell an empty one.
	 */
	expansions?: Record<string, TemplateExpansion>;
}

/** The pin file's location — beside this module, inside the repo. */
export const MODEL_PINS_PATH = resolve(import.meta.dir, 'model_pins.json');

/** A 40-hex git commit sha — the only revision shape the fetch URL accepts. */
export const REVISION_HEX = /^[0-9a-f]{40}$/;

/**
 * Parse a pin table, dropping nothing silently: a malformed file THROWS, because
 * a pin table that reads as empty would make every download refuse with "no
 * pin" for a reason the operator could not see.
 */
export function parsePinTable(text: string): PinTable {
	const parsed = asObject(JSON.parse(text), 'model pins') as Partial<PinTable>;
	return {
		models: asObject(parsed.models ?? {}, 'model pins `models`') as PinTable['models'],
		unpinned: asObject(parsed.unpinned ?? {}, 'model pins `unpinned`') as PinTable['unpinned'],
		expansions: asObject(
			parsed.expansions ?? {},
			'model pins `expansions`',
		) as PinTable['expansions'],
	};
}

/** The value as a plain object, or the typed refusal that names what was expected. */
function asObject(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new DedaloError('ai.model_integrity', { message: `${what}: not an object` });
	}
	return value as Record<string, unknown>;
}

/** The repo's pin table, read once. */
const PINS: PinTable = Object.freeze(parsePinTable(readFileSync(MODEL_PINS_PATH, 'utf8')));

/** The whole table (the gate censuses it). */
export function readPinTable(): PinTable {
	return PINS;
}

/** The immutable revision a model is pinned at, or null when it has no pin. */
export function pinnedRevision(modelId: string, table: PinTable = PINS): string | null {
	const revision = table.models[modelId]?.revision;
	return typeof revision === 'string' && REVISION_HEX.test(revision) ? revision : null;
}

/**
 * The pin of one file of one model, or null when either is unpinned. A pin with
 * a malformed digest is treated as absent — a digest that cannot match is not a
 * pin, and treating it as one would refuse every download of that file with a
 * "mismatch" that names the wrong cause.
 */
export function pinFor(modelId: string, file: string, table: PinTable = PINS): FilePin | null {
	const pin = table.models[modelId]?.files[file];
	if (pin === undefined || !isWellFormedPin(pin)) return null;
	return { sha256: pin.sha256, size: pin.size };
}

/**
 * The pin a store-relative path (`org/name/onnx/model.onnx`, forward slashes)
 * names, at WHATEVER depth the model id sits and under WHATEVER letter-case the
 * path was requested with — or null. The exact name is tried first; then every
 * pinned `<id>/<file>` is compared CASE-FOLDED. The store lives on a filesystem
 * the engine does not choose, and on a case-insensitive one (macOS APFS, the
 * dev target) `xenova/whisper-small/CONFIG.json` resolves to the very bytes the
 * exact-case name pins — a serve door keyed on the requested spelling handed
 * them out UNVERIFIED (review of P1-25, 2026-09-04). Judging a case-variant by
 * the pin its bytes would alias is correct on both kinds of filesystem: on a
 * case-sensitive one the variant either does not exist (404 before this) or is
 * a different file planted under a catalog id, which the catalog pin may refuse.
 * The returned names are the PIN'S spelling.
 */
export function pinForPath(relPath: string, table: PinTable = PINS): PinMatch | null {
	return pinForExactPath(relPath, table) ?? pinForFoldedPath(relPath, table);
}

/** The pin a request resolved to, in the PIN'S spelling. */
export interface PinMatch {
	modelId: string;
	file: string;
	pin: FilePin;
}

/** Pass 1 of pinForPath: the exact name, at every `<model id>/<file>` split. */
function pinForExactPath(relPath: string, table: PinTable): PinMatch | null {
	const segments = relPath.split('/');
	for (let split = segments.length - 1; split >= 1; split--) {
		const modelId = segments.slice(0, split).join('/');
		const file = segments.slice(split).join('/');
		const pin = pinFor(modelId, file, table);
		if (pin !== null) return { modelId, file, pin };
	}
	return null;
}

/** Pass 2 of pinForPath: every pinned name compared CASE-FOLDED (see header). */
function pinForFoldedPath(relPath: string, table: PinTable): PinMatch | null {
	const folded = relPath.toLowerCase();
	for (const [modelId, model] of Object.entries(table.models)) {
		for (const file of Object.keys(model.files)) {
			if (`${modelId}/${file}`.toLowerCase() !== folded) continue;
			const pin = pinFor(modelId, file, table);
			if (pin !== null) return { modelId, file, pin };
		}
	}
	return null;
}

/** A hub page — the only kind of URL a licence record may cite. */
const HTTPS_URL = /^https:\/\/[^\s]+$/;

/** A non-blank string. */
const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/** The governing licence's own fields: a name, and the https page it was read from. */
function licenceHeaderProblems(modelId: string, licence: ModelLicence): string[] {
	const problems: string[] = [];
	if (!nonEmpty(licence.name)) problems.push(`${modelId}: licence.name is empty`);
	if (!nonEmpty(licence.url) || !HTTPS_URL.test(licence.url)) {
		problems.push(`${modelId}: licence.url is not an https URL`);
	}
	return problems;
}

/** declared_by 'upstream': the card is silent, and the recorded upstream says the name. */
function upstreamDeclarationProblems(modelId: string, licence: ModelLicence): string[] {
	const problems: string[] = [];
	if (licence.card.license !== null) {
		problems.push(`${modelId}: the card declares ${licence.card.license}; it governs`);
	}
	if (licence.upstream === null || licence.upstream === undefined) {
		problems.push(`${modelId}: declared by an upstream that is not recorded`);
	} else if (licence.upstream.license !== licence.name) {
		problems.push(`${modelId}: declared by the upstream, but it says ${licence.upstream.license}`);
	}
	return problems;
}

/** Whoever `declared_by` names must actually declare `name`. */
function declarationProblems(modelId: string, licence: ModelLicence): string[] {
	if (licence.declared_by === 'card') {
		return licence.card.license === licence.name
			? []
			: [`${modelId}: declared by the card, but the card says ${licence.card.license}`];
	}
	if (licence.declared_by === 'upstream') return upstreamDeclarationProblems(modelId, licence);
	return [`${modelId}: licence.declared_by is neither 'card' nor 'upstream'`];
}

type UpstreamRecord = NonNullable<ModelLicence['upstream']>;

/** A recorded upstream names its model, its https card, and how it was identified. */
const UPSTREAM_RULES: ReadonlyArray<[(upstream: UpstreamRecord) => boolean, string]> = [
	[(upstream) => nonEmpty(upstream.model), 'licence.upstream.model is empty'],
	[(upstream) => HTTPS_URL.test(upstream.url ?? ''), 'licence.upstream.url is not an https URL'],
	[
		(upstream) => upstream.named_by === 'card' || upstream.named_by === 'repo_name',
		"licence.upstream.named_by is neither 'card' nor 'repo_name'",
	],
];

/** What is wrong with a recorded upstream (none recorded: nothing). */
function upstreamRecordProblems(modelId: string, upstream: ModelLicence['upstream']): string[] {
	if (upstream === null || upstream === undefined) return [];
	return UPSTREAM_RULES.filter(([holds]) => !holds(upstream)).map(
		([, problem]) => `${modelId}: ${problem}`,
	);
}

/** The pinned repository's card URL must be on record before anything is read from it. */
const hasCardUrl = (licence: ModelLicence): boolean =>
	licence.card !== undefined && licence.card !== null && HTTPS_URL.test(licence.card.url ?? '');

/**
 * What is wrong with one pin's licence record (empty = a valid record). A pin
 * WITHOUT one is a problem: every pinned model's terms are on record, or the
 * gate is red.
 */
export function licenceProblems(modelId: string, pin: ModelPin): string[] {
	const licence = pin.licence;
	if (licence === undefined || licence === null || typeof licence !== 'object') {
		return [`${modelId}: no licence record`];
	}
	const problems = licenceHeaderProblems(modelId, licence);
	if (!hasCardUrl(licence)) {
		return [...problems, `${modelId}: licence.card is missing its card URL`];
	}
	return [
		...problems,
		...declarationProblems(modelId, licence),
		...upstreamRecordProblems(modelId, licence.upstream),
	];
}

/** A 64-hex digest and a non-negative integer size — anything else is not a pin. */
function isWellFormedPin(pin: Partial<FilePin>): pin is FilePin {
	if (typeof pin.sha256 !== 'string' || !SHA256_HEX.test(pin.sha256)) return false;
	return typeof pin.size === 'number' && Number.isInteger(pin.size) && pin.size >= 0;
}
