/**
 * utf8_file — a file read as UTF-8, strictly: a byte that is not UTF-8 answers
 * null, where `Bun.file().text()` would turn it into U+FFFD without a word. For
 * text whose encoding the tool controls; one whose encoding it does not is
 * decoded by core's `decodeIngestBytes` (convert or refuse).
 */

/** The file's text, or null when it is not UTF-8. A failed read throws its own error. */
export async function readUtf8File(path: string): Promise<string | null> {
	const bytes = await Bun.file(path).bytes();
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null; // the decode is all this guards: the read is outside it
	}
}
