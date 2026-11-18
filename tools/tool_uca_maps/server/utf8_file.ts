/**
 * utf8_file — a file this tool or its own client wrote, read as the UTF-8 it
 * always is. The decode is strict: a byte that is not UTF-8 answers null, where
 * `Bun.file().text()` would turn it into U+FFFD without a word. A user's own
 * upload goes through core's `decodeIngestBytes` instead (convert or refuse).
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
