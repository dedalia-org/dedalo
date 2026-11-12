/**
 * Automatic translation core (PHP tool_lang / tool_lang_multi
 * ::automatic_translation + translators/class.babel.php). Reads a component's
 * source-lang items, translates each `value` through a pluggable provider, and
 * returns target-lang items ({value, lang}) to write into the target slot.
 *
 * The PROVIDER is a seam: the real `babelProvider` POSTs to the configured
 * Apertium/Babel service (external, SSRF-guarded); tests inject a stub. This is
 * the plan's external-engine gate (Phase 4: "the provider is a seam, stub in test").
 * browser_transformer is client-side only (never reaches the server); google is
 * not implemented in PHP either.
 */

import type { MatrixJsonbColumn } from '../db/matrix.ts';
import { DedaloError, ok } from '../errors/index.ts';
import type { ApiEnvelope } from '../errors/schema.ts';
import { stripTags } from '../resolve/html_text.ts';
import { currentDataLang } from '../resolve/request_lang.ts';
import type { Principal } from '../security/permissions.ts';
import { currentRequestContext } from '../security/request_context.ts';
import { fetchGuardedText, isSsrfRefusal } from '../security/ssrf_guard.ts';
import { authorizeRecordAccess, type RecordGrant } from '../security/write_door.ts';
import { addBabelNotransTags, processBabelResponse } from './babel.ts';

export interface TranslateRequest {
	uri: string;
	key: string;
	sourceLang: string;
	targetLang: string;
	text: string;
}

/** The current RQO's id (the tool dispatcher opens the scope), or '' outside a request. */
function currentRequestId(): string {
	return currentRequestContext()?.requestId ?? '';
}

/**
 * One provider call's outcome — an INTERNAL protocol shape, never a wire body:
 * the discriminant is `ok`, so nothing envelope-shaped can escape a translator.
 */
export type TranslateResult =
	| {
			ok: true;
			/** Translated text. */
			text: string;
			msg: string;
			/** Unmodified provider body (PHP $response->raw_result) — debug only, never persisted. */
			rawResult?: string;
	  }
	| { ok: false; msg: string };

/** PHP tool_lang:270 budgets the provider message in BYTES (strlen/substr). */
const PROVIDER_MSG_MAX_BYTES = 512;

/**
 * PHP tool_lang:270 — a translation service that fails can answer with a whole
 * HTML error page; the message is truncated before it reaches the response so
 * one bad request cannot flood the wire.
 *
 * THE UNIT IS BYTES. PHP's `strlen`/`substr` count bytes, JS `String.length` and
 * `slice` count UTF-16 code units, so an error page in any language with accents
 * truncated at a completely different point — and `slice` could cut a surrogate
 * pair in half and put a LONE SURROGATE on the wire.
 *
 * One deliberate divergence, ledgered as
 * `WC-2026-08-09-provider-message-truncation-boundary`: PHP's byte `substr` can
 * end mid-character and emit a partial UTF-8 sequence (which then makes PHP's own
 * `json_encode` fail); we spend the same 512-byte budget but cut on a CHARACTER
 * boundary, dropping the straddling character whole.
 */
export function truncateProviderMessage(message: string): string {
	const bytes = new TextEncoder().encode(message);
	if (bytes.length <= PROVIDER_MSG_MAX_BYTES) return message;
	// Walk back off any UTF-8 continuation byte (10xxxxxx) so the cut lands on
	// the start of a character rather than inside one.
	let end = PROVIDER_MSG_MAX_BYTES;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return `${new TextDecoder().decode(bytes.subarray(0, end))}..`;
}

export type TranslationProvider = (req: TranslateRequest) => Promise<TranslateResult>;

export interface TranslateItemsConfig {
	uri: string;
	key: string;
	sourceLang: string;
	targetLang: string;
}

/** One target-language item; `id` is the source item's, when it had one. */
export interface TranslatedItem {
	id?: number | string;
	value: string;
	lang: string;
}

/**
 * The target item for one source item: the translated `value` in the target
 * `lang`, carrying the source item's `id` (a number or a non-empty string) when
 * it had one — never an invented one.
 */
function targetItem(source: unknown, value: string, lang: string): TranslatedItem {
	const id =
		source !== null && typeof source === 'object' ? (source as { id?: unknown }).id : undefined;
	return typeof id === 'number' || (typeof id === 'string' && id !== '')
		? { id, value, lang }
		: { value, lang };
}

/**
 * Translate every source item's `value` into target-lang items. Stops and
 * surfaces the provider error on the first failure (PHP returns immediately). The
 * "Sorry. Quota exceeded" leading string is treated as an error, never persisted.
 *
 * A target item KEEPS its source item's `id`: the translation (or
 * transliteration — Augustus lg-nolan / Αύγουστος lg-ell) of item N IS item N
 * in another language. Dropping it left the frame of item N unpaired
 * (dataframe `id_key`) and let the next save stamp a fresh id on the target —
 * a spurious change of that language's TM lane. A source item without an id
 * yields a target item without one (no id is invented here).
 */
/*
 * COVERAGE-EXEMPT — the PROVIDER CALL below (coverage plan §5.2; reason
 * registered in engineering/crap_coverage_exempt.json): it posts to a
 * third-party / sidecar service over the network. Never fetch in a test — a gate
 * would be non-hermetic and hostage to someone else's uptime. The pure halves in
 * these files (engine mapping, config resolution, URL safety, segment folding)
 * ARE gateable and are not covered by this exemption.
 */
export async function translateItems(
	sourceItems: readonly unknown[],
	provider: TranslationProvider,
	cfg: TranslateItemsConfig,
): Promise<{ items: TranslatedItem[]; error: string | null; emptyResult?: true }> {
	const out: TranslatedItem[] = [];
	for (const item of sourceItems) {
		const text = sourceText(item);
		const res = await provider({
			uri: cfg.uri,
			key: cfg.key,
			sourceLang: cfg.sourceLang,
			targetLang: cfg.targetLang,
			text,
		});
		if (!res.ok) return { items: [], error: truncateProviderMessage(res.msg) };
		if (res.text.startsWith('Sorry. Quota exceeded')) {
			return { items: [], error: 'Sorry. Quota exceeded' };
		}
		// A service that does not know the language pair answers 200 with NO text
		// (Babel/Apertium for a missing direction). That is not a translation: refuse
		// it, so the target language keeps what it holds instead of being blanked.
		if (isEmptyTranslation(text, res.text)) {
			return {
				items: [],
				error: `empty translation for ${cfg.sourceLang} → ${cfg.targetLang}`,
				emptyResult: true,
			};
		}
		out.push(targetItem(item, res.text, cfg.targetLang));
	}
	return { items: out, error: null };
}

/** The text a source item hands the provider: its `value`, or the bare scalar. */
function sourceText(item: unknown): string {
	return item !== null && typeof item === 'object'
		? String((item as { value?: unknown }).value ?? '')
		: String(item ?? '');
}

/**
 * The translated items AS THEY WILL BE STORED (T1-14 / OX7): through the write
 * engine's value gates, exactly like a save (`write_value_gates.ts` — the
 * rich-text sanitizer + WC-042 media-src relativize for an `html` model; PHP
 * `component_text_area::save` → `clean_text`). Babel's own post-processing is
 * a `strip_tags` allowlist that KEEPS attributes, and its entity decode turns
 * literal text into live markup, so the provider result is never trusted as
 * stored form.
 *
 * The visible-text check runs again on the GATED value: a result whose only
 * content was hostile markup sanitizes to nothing, and writing that would blank
 * the target language (WC-2026-11-10) — it is refused as an empty result.
 */
async function gateTranslatedItems(
	model: string,
	sourceSlice: readonly unknown[],
	targetItems: readonly TranslatedItem[],
	direction: { sourceLang: string; targetLang: string },
): Promise<{ items: unknown[]; emptyMsg: string | null }> {
	const { gateComponentItems } = await import('../section/record/write_value_gates.ts');
	const items = await gateComponentItems(model, targetItems);
	const emptied = items.some((item, index) =>
		isEmptyTranslation(sourceText(sourceSlice[index]), sourceText(item)),
	);
	return {
		items,
		emptyMsg: emptied
			? `empty translation for ${direction.sourceLang} → ${direction.targetLang} after sanitizing`
			: null,
	};
}

/** Visible text: markup removed, whitespace trimmed. */
const visibleText = (value: string): string => stripTags(value).trim();

/** True when a source with visible text came back with none. */
export function isEmptyTranslation(source: string, result: string): boolean {
	return visibleText(source) !== '' && visibleText(result) === '';
}

/**
 * Babel direction code — PHP `babel::get_babel_direction` (class.babel.php:189).
 *
 * `substr($lang, 3, 2)`: the FIRST TWO letters of the ISO code, not the whole
 * code — 'lg-spa' → 'sp', so the pair is 'sp-en'. That is the mode grammar of
 * the babel service Dédalo talks to, stated in its own docblock ("uses two-letter
 * codes for most language pairs but requires the full three-letter 'deu'/'eng'
 * suffix for the German pair").
 *
 * The port stripped the 'lg-' prefix instead and asked for 'spa-eng', a mode the
 * box does not have — so every translation came back as the `Error: Mode …`
 * sentence that audit §5.6 found written over the target-language slot. Screening
 * that body (babel.ts) stops it being persisted; THIS restores the request that
 * makes a translation happen at all.
 *
 * The German branch is PHP's, exception and asymmetry included: the SOURCE
 * becomes 'deu', and the target becomes 'eng' only when it is English. German as
 * a target keeps the generic two-letter extraction — PHP flags that as
 * questionable but it is the contract the service was built against, so it is
 * ported verbatim rather than "improved" here.
 */
export function babelDirection(sourceLang: string, targetLang: string): string {
	// String.slice(3, 5) is PHP substr($lang, 3, 2), empty slice included.
	let source = sourceLang.slice(3, 5);
	let target = targetLang.slice(3, 5);
	if (sourceLang === 'lg-deu') {
		source = 'deu';
		if (targetLang === 'lg-eng') target = 'eng';
	}
	return `${source}-${target}`;
}

/**
 * Real Babel provider — the IO shell of PHP `babel::translate`. Everything that
 * is not the HTTP call lives in `babel.ts` (pure, unit-tested): mark protection
 * on the way out, and the error screen + entity decode + tag strip on the way
 * back.
 *
 * THE RULE THIS ENFORCES: a body that is not a translation must NEVER become
 * one. Until 2026-08 this returned `await res.text()` verbatim, so an Apertium
 * box answering `Error: Mode …` had its error sentence written over the
 * target-language slot and reported as a success (audit §5.6). The screen is
 * PHP's — HTTP 200 is not proof of a translation.
 */
export const babelProvider: TranslationProvider = async (req) => {
	const body = new URLSearchParams({
		key: req.key,
		// PHP: trim(TR::addBabelTagsOnTheFly($text)) — the timecode/index/person/
		// note/reference/svg/geo/page marks travel inside <apertium-notrans> so
		// the engine cannot rewrite them.
		text: addBabelNotransTags(req.text ?? '').trim(),
		direction: babelDirection(req.sourceLang, req.targetLang),
	});
	try {
		// ONE GUARD, NOT TWO (CARRY-10 / SSRF-02). This used to carry its own
		// four-string blocklist — `localhost`, `127.0.0.1`, `::1`,
		// `169.254.169.254`, plus a private-range regex — while the RDF door beside
		// it had already been migrated to the resolving guarded fetcher. One twin
		// hardened, one not.
		//
		// The blocklist could not do the job and its `::1` arm was DEAD CODE:
		// `new URL('http://[::1]/').hostname` is `[::1]` WITH the brackets, so the
		// bare comparison never matched. It also missed `127.0.0.2`, `0.0.0.0`,
		// decimal-integer IPv4, `anything.localhost`, every DNS NAME resolving to a
		// private address, and the redirect hop.
		//
		// `fetchGuardedText` RESOLVES the host and vets the addresses, refuses
		// redirects (a 3xx re-chooses the target), and carries a timeout and a body
		// cap — the last two also close this call's unbounded-read and
		// lane-occupancy exposure (CARRY-14's shape at this site).
		const rawResult = await fetchGuardedText(req.uri, {
			maxBytes: 8 * 1024 * 1024,
			init: { method: 'POST', body },
		});
		const processed = processBabelResponse(rawResult);
		return processed.ok
			? { ok: true, text: processed.value, msg: 'ok', rawResult }
			: { ok: false, msg: processed.msg };
	} catch (error) {
		// Keep this door's long-published refusal text: the guard's own message
		// names the address it refused, which is a probe oracle on the wire.
		const msg = isSsrfRefusal(error) ? 'invalid translator URL (SSRF)' : (error as Error).message;
		return { ok: false, msg };
	}
};

/** Resolve a translation provider by engine name (PHP translator switch). */
export function resolveTranslationProvider(engine: string): {
	provider: TranslationProvider | null;
	error: string | null;
} {
	switch (engine) {
		case 'browser_transformer':
			return { provider: null, error: 'Browser transformer is client-side only' };
		case 'google_translation':
			return { provider: null, error: "'google_translation' is not implemented yet" };
		default:
			return { provider: babelProvider, error: null };
	}
}

/**
 * Read a component's source-lang items, translate them, and write the target-lang
 * slot (PHP automatic_translation save path). Empty source → nothing saved. Uses
 * the verified direct-write path (persistRecordKeys + recordMainHistory
 * (dataframe_slots.ts, two lanes), stamping the record's modified metadata like
 * PHP's component->save()). Shared by tool_lang (one target) and tool_lang_multi
 * (looped targets).
 *
 * GATED LIKE A SAVE (T1-14 / OX7): `persistRecordKeys` is model-agnostic, so the
 * write engine's value gates run HERE, on the target-language items only
 * (gateTranslatedItems — PHP `component_text_area::save` `clean_text`). Other
 * languages are stored values with their own TM lanes and are never rewritten.
 *
 * OBSERVERS (TOOLS-1, the observer half closed by CLOSURE_PLAN Step 2): the
 * write goes through persistRecordKeys, whose post-write hook declares the
 * key's before/after to the obligation ledger — so a component_info or
 * use_self_section edge on a translatable literal recomputes after the COMMIT,
 * exactly as it does for a save.
 *
 * THE LOCK (audit 2026-08 §5.6). The merge is a read-modify-write of ONE jsonb
 * key holding EVERY language of the component, so it is only safe under the
 * engine's locked-RMW contract. Without it, tool_lang_multi's "translate all"
 * — N concurrent requests, one per target language, on the SAME record — had
 * every request merge onto the same stale snapshot and the last write silently
 * discard the languages the others had just added. PHP never had this bug: its
 * requests serialised behind the session lock.
 *
 * The order matters as much as the lock: the provider call is an EXTERNAL HTTP
 * request that can take minutes, so it happens BEFORE the transaction opens.
 * The row lock is then taken for the merge only, and the merge base is the
 * freshly locked re-read — never the pre-translation snapshot.
 *
 * AUTHORIZED BY ITS GRANT: the caller passes the write door's RecordGrant
 * (`authorizeRecordAccess`, write level 2) — `runAutomaticTranslation` is the
 * door that mints it.
 */
export async function translateAndWrite(
	grant: RecordGrant,
	options: {
		model: string;
		sourceLang: string;
		targetLang: string;
		provider: TranslationProvider;
		uri: string;
		key: string;
	},
): Promise<{
	ok: boolean;
	msg: string;
	count: number;
	providerError?: boolean;
	emptyResult?: true;
}> {
	// THE EFFECT IS BUILT FROM THE GRANT (closure Step 3 req 10): the record, the
	// component and the audit actor are the write door's authorized coordinates —
	// a branded RecordGrant only security/write_door.ts mints — never raw request
	// values. An importer cannot reach this writer without asking the door.
	if (grant.mode !== 'write') {
		throw new DedaloError('internal.invariant', {
			message: `translateAndWrite: a ${grant.mode} grant cannot write (door ${grant.door})`,
			coordinates: { section_tipo: grant.sectionTipo, section_id: grant.sectionId },
		});
	}
	const input = {
		...options,
		componentTipo: grant.componentTipo,
		sectionTipo: grant.sectionTipo,
		sectionId: grant.sectionId,
		userId: grant.userId,
	};
	const { getColumnNameByModel, getMatrixTableFromTipo } = await import('../ontology/resolver.ts');
	const { readMatrixRecord } = await import('../db/matrix.ts');
	const { readComponentItems, filterItemsByLang } = await import('../resolve/component_data.ts');
	const { persistRecordKeys } = await import('../section_record/index.ts');
	const { mainIdentity, readMainSlots, recordMainHistory } = await import(
		'../relations/dataframe_slots.ts'
	);
	const { dbTimestamp } = await import('../db/db_timestamp.ts');
	const { withTransaction } = await import('../db/postgres.ts');
	const { readMatrixKeyForUpdate } = await import('../db/matrix_write.ts');

	const table = await getMatrixTableFromTipo(input.sectionTipo);
	const column = getColumnNameByModel(input.model);
	if (table === null || column === null)
		return { ok: false, msg: 'no matrix table/column', count: 0 };

	const record = await readMatrixRecord(table, input.sectionTipo, input.sectionId);
	const allItems =
		record !== null ? (readComponentItems(record, input.componentTipo, input.model) ?? []) : [];
	const sourceSlice = filterItemsByLang(allItems, input.sourceLang);
	if (sourceSlice.length === 0)
		return { ok: true, msg: 'Ignored empty result. Nothing is saved!', count: 0 };

	// The external call happens OUTSIDE the transaction — a translator server can
	// take minutes, and holding a FOR UPDATE row lock across it would block every
	// other writer of the record.
	const {
		items: targetItems,
		error,
		emptyResult,
	} = await translateItems(sourceSlice, input.provider, {
		uri: input.uri,
		key: input.key,
		sourceLang: input.sourceLang,
		targetLang: input.targetLang,
	});
	// `providerError` is what lets the caller route this sentence into the
	// declared `provider_message` detail instead of onto the wire (WC-2026-08-09).
	// An empty result is the service's answer, not its failure: its own code.
	if (error !== null)
		return {
			ok: false,
			msg: error,
			count: 0,
			...(emptyResult === true ? { emptyResult } : { providerError: true }),
		};
	// Stored form = gated form (see gateTranslatedItems), computed OUTSIDE the
	// row lock: pure CPU, it must not widen the lock window.
	const gated = await gateTranslatedItems(input.model, sourceSlice, targetItems, input);
	if (gated.emptyMsg !== null)
		return { ok: false, msg: gated.emptyMsg, count: 0, emptyResult: true as const };

	return await withTransaction(async () => {
		// TAKE THE ROW LOCK. The merge base must be the row as it stands NOW, not
		// the snapshot taken before the translator was called, so that concurrent
		// translations into other languages stack instead of clobbering.
		// `readMatrixKeyForUpdate` refuses to run outside a transaction, so the
		// lock can never be silently lost.
		const locked = await readMatrixKeyForUpdate(
			table,
			input.sectionTipo,
			input.sectionId,
			column as MatrixJsonbColumn,
			input.componentTipo,
		);
		if (locked === null) {
			return {
				ok: false,
				msg: `record ${input.sectionTipo}/${input.sectionId} not found in ${table} — it was deleted concurrently; the translation was NOT saved`,
				count: 0,
			};
		}
		// DECODE THROUGH THE READ CHOKEPOINT, never through the lock's return
		// value. `readMatrixKeyForUpdate` answers `[]` for anything that is not a
		// JSON array, which on a LEGACY record — where the component value is a
		// bare `{lang,value}` object rather than an array (pre-matrix_dd shape) —
		// is indistinguishable from "this component has no items". Merging the new
		// target language onto that empty base DELETES the record's existing
		// language: the source text the tool was asked to translate is the very
		// thing it destroys. `readComponentItems` is the one place that knows the
		// legacy shape (coerce non-array to `[items]`, drop null/'' holes), and it
		// is already what produced `sourceSlice` above — so the merge base and the
		// source base are decoded by the same grammar or they will disagree again.
		//
		// This re-read runs on the transaction's own connection AFTER the FOR
		// UPDATE, so it sees exactly the row version the lock is held on.
		const lockedRecord = await readMatrixRecord(table, input.sectionTipo, input.sectionId);
		if (lockedRecord === null) {
			// Impossible under the row lock we hold — report it rather than
			// inventing an empty merge base out of it.
			throw new DedaloError('internal.invariant', {
				message: `translateAndWrite: ${table}/${input.sectionTipo}/${input.sectionId} vanished between FOR UPDATE and the locked re-read`,
				coordinates: { section_tipo: input.sectionTipo, section_id: input.sectionId },
			});
		}
		const currentItems = readComponentItems(lockedRecord, input.componentTipo, input.model) ?? [];

		const merged = [
			...currentItems.filter(
				(item) =>
					!(
						item !== null &&
						typeof item === 'object' &&
						(item as { lang?: string }).lang === input.targetLang
					),
			),
			...gated.items,
		];
		// Chokepoint write: translated value + modified stamps in one update (PHP
		// tool_lang saves via component->save(), which stamps).
		await persistRecordKeys(
			{ table, sectionTipo: input.sectionTipo, sectionId: input.sectionId },
			[{ column: column as MatrixJsonbColumn, key: input.componentTipo, value: merged }],
			{ userId: input.userId },
			{ actor: input.userId },
		);
		// The history through the capture's own writer (dataframe_slots.ts
		// recordMainHistory — two lanes): ONE row in the TARGET language's lane,
		// its value only — one row is one language, engine-wide; the whole merged
		// value under one tag put every other language back from this timeline. A
		// translation changes no frame and no lg-nolan value, so no lg-nolan row
		// (WC-2026-09-27-bulk-revert-undo-log, "two lanes").
		const target = { table, sectionTipo: input.sectionTipo, sectionId: input.sectionId };
		const identity = {
			...(await mainIdentity(input.componentTipo, input.targetLang)),
			lang: input.targetLang,
		};
		const slots = await readMainSlots(target, identity.tipo);
		await recordMainHistory(
			target,
			identity,
			{ before: { value: currentItems, slots }, after: { value: merged, slots } },
			{ userId: input.userId, timestamp: dbTimestamp(), bulkId: null },
		);
		return { ok: true, msg: 'OK. Request done', count: gated.items.length };
	});
}

/**
 * The source language a request that does not name one translates FROM — PHP
 * `$options->source_lang ?? DEDALO_DATA_LANG` (tool_lang.php:149), whose TS twin
 * is the ALS request data lang (installation default outside a request).
 *
 * This was the literal `'lg-eng'` (audit 2026-08 §5.6 tail): a Catalan archive
 * omitting source_lang read the (usually empty) English slice, so the tool
 * either translated nothing or translated the wrong text. Languages are
 * configuration, never module literals.
 */
export function defaultTranslationSourceLang(): string {
	return currentDataLang();
}

/**
 * The full automatic_translation handler orchestration (shared by tool_lang and
 * tool_lang_multi — PHP tool_lang_multi delegates to tool_lang). Gates, resolves
 * the engine + config, reads/translates/writes. `configToolName` selects whose
 * translator_config to read (PHP get_called_class → tool_lang).
 */
export async function runAutomaticTranslation(
	ctx: {
		options: Record<string, unknown>;
		userId: number;
		principal: Principal;
	},
	configToolName: string,
): Promise<ApiEnvelope> {
	const o = ctx.options;
	const componentTipo = String(o.component_tipo ?? '');
	const sectionTipo = String(o.section_tipo ?? '');
	const sourceLang = String(o.source_lang ?? defaultTranslationSourceLang());
	const targetLang = String(o.target_lang ?? '');
	const engine = String(o.translator ?? 'babel');

	if (componentTipo === '' || sectionTipo === '' || targetLang === '') {
		throw new DedaloError('request.invalid_options', {
			publicMessage:
				'Error. Missing required parameters: component_tipo, section_tipo, target_lang',
		});
	}

	// THE WRITE DOOR (closure Step 3 req 10; WC-2026-09-30-write-door): PHP
	// asserted BOTH halves (tool_lang :164/:167, tool_lang_multi :122/:124;
	// TOOLS-10) — the (section_tipo, component_tipo) pair at write and the
	// record in the user's scope. The door asks them in its one order, with
	// what the raw pair read never could: the section floor, the dd128
	// own-record downgrade on the PAIR (a user-manager's own dd1725 is
	// read-only), the integer id grammar (a missing / fractional / garbage id
	// is request.invalid, never record 0) and the non-positive-id refusal ahead
	// of the admin bypass. Before any provider call; the grant addresses the
	// write.
	const grant = await authorizeRecordAccess(
		ctx.principal,
		{ section_tipo: o.section_tipo, component_tipo: o.component_tipo, section_id: o.section_id },
		{ mode: 'write', level: 2, sectionFloor: 1, door: `${configToolName}.automatic_translation` },
	);

	const { provider, error: providerError } = resolveTranslationProvider(engine);
	if (provider === null) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: `Error. ${providerError ?? 'unknown translator engine'}`,
		});
	}

	const { getToolConfig } = await import('./config.ts');
	const cfg = resolveTranslatorConfig(await getToolConfig(configToolName), engine);
	if (cfg === null) {
		throw new DedaloError('translation.not_configured', {
			publicMessage: `Error. Translator config (uri/key) is not defined for '${engine}'`,
		});
	}

	const { getModelByTipo } = await import('../ontology/resolver.ts');
	const model = await getModelByTipo(grant.componentTipo);
	if (model === null) {
		throw new DedaloError('request.invalid_tipo', {
			message: `unknown component tipo: ${grant.componentTipo}`,
			coordinates: { tipo: grant.componentTipo },
		});
	}

	const outcome = await translateAndWrite(grant, {
		model,
		sourceLang,
		targetLang,
		provider,
		uri: cfg.uri,
		key: cfg.key,
	});
	if (!outcome.ok) throw translationFailure(outcome);
	return ok(true, {
		requestId: currentRequestId(),
		// PHP parity: the tool_lang / tool_lang_multi clients read `msg` (and the
		// multi one the per-run `count`) at the top level.
		extend: { msg: outcome.msg, count: outcome.count },
	});
}

/**
 * A failed translateAndWrite → the thrown refusal.
 *
 * WC-2026-08-09: a translation service that fails can answer with a whole HTML
 * error page, and that text is UNTRUSTED third-party prose. It therefore travels
 * as the code's declared `provider_message` DETAIL (already truncated to the
 * 512-byte budget by translateItems), never as a `publicMessage` that would
 * replace the registry English on the wire. Everything else — no matrix
 * table/column, a record deleted under the lock — is an engine-side save
 * failure.
 */
export function translationFailure(outcome: {
	msg: string;
	providerError?: boolean;
	emptyResult?: true;
}): DedaloError {
	if (outcome.emptyResult === true) {
		return new DedaloError('translation.empty_result', { message: outcome.msg });
	}
	return outcome.providerError === true
		? new DedaloError('translation.provider_failed', {
				details: { provider_message: outcome.msg },
				message: `translation provider failed: ${outcome.msg}`,
			})
		: new DedaloError('record.save_failed', {
				message: `automatic translation: ${outcome.msg}`,
			});
}

/**
 * Resolve the {uri, key} for an engine from a tool's translator_config (dd996).
 *
 * SHAPE: `getToolConfig` resolves options FLAT — one key per option, already
 * unwrapped — so the entry list is `toolConfig.translator_config` (an array).
 * The nested `config.translator_config.value` form is PHP's raw config-item
 * shape and is TOLERATED as legacy, but reading ONLY it (as this did until
 * 2026-07-28) meant the resolver never matched what the caller actually passes:
 * every automatic_translation failed with "Translator config is not defined"
 * while the tests fed the nested shape by hand and stayed green. Same bug, same
 * fix, as resolveTranscriberConfig one subsystem over.
 */
export function resolveTranslatorConfig(
	toolConfig: Record<string, unknown>,
	engine: string,
): { uri: string; key: string } | null {
	const flat = toolConfig?.translator_config;
	const nested = (toolConfig?.config as { translator_config?: { value?: unknown[] } } | undefined)
		?.translator_config?.value;
	// Tolerate an un-unwrapped `{value:[…]}` under the flat key too (a config
	// layer that stored the prop object rather than its value).
	const configs = Array.isArray(flat)
		? flat
		: ((flat as { value?: unknown } | undefined)?.value ?? nested);
	if (!Array.isArray(configs)) return null;
	const entry = configs.find(
		(item) =>
			item !== null && typeof item === 'object' && (item as { name?: string }).name === engine,
	) as { uri?: string; key?: string } | undefined;
	if (!entry?.uri || !entry.key) return null;
	return { uri: entry.uri, key: entry.key };
}
