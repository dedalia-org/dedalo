/**
 * ONTOLOGY FILE DIGESTS — the one reader of an ontology.json's `files_sha256`
 * (`{"<name>.copy.gz": "<hex sha256>"}`, U-41,
 * WC-2026-10-30-ontology-file-digests).
 *
 * A LEAF (zod only): the manifest client (ontology_manifest.ts, a whole
 * `{info, files}` manifest) and the installer's vendored catalog
 * (install/ontology_choice.ts — pure and config-free, so it may not import the
 * manifest client) read the map through the SAME schema. Absent = the source
 * publishes none (unverified: the consumer warns and accepts); malformed =
 * refused (never a partially trusted map).
 */

import { z } from 'zod';

/** `info.files_sha256`: file name → lowercase hex sha256. */
export const filesSha256Schema = z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/));

/** A parsed `files_sha256` map (file name → hex sha256). */
export type FilesSha256 = Readonly<Record<string, string>>;

/**
 * An ontology.json `info` object → its digest map: absent → `digests`
 * undefined; malformed → `{ok:false}` with the first issue (path + message,
 * never the payload).
 */
export function parseFilesSha256(
	info: unknown,
): { ok: true; digests: FilesSha256 | undefined } | { ok: false; reason: string } {
	const raw = (info as { files_sha256?: unknown } | null)?.files_sha256;
	if (raw === undefined) return { ok: true, digests: undefined };
	const parsed = filesSha256Schema.safeParse(raw);
	if (parsed.success) return { ok: true, digests: parsed.data };
	const issue = parsed.error.issues[0];
	return {
		ok: false,
		reason: `files_sha256 does not have the expected shape (${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'})`,
	};
}
