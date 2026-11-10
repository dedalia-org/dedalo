/**
 * The import tools' ONE "the write door refused THIS field" predicate — shared
 * by import_execute (tool_import_files / JSON import) and import_csv_execute
 * (tool_import_csv), whose per-field / per-column door calls report such a
 * refusal as IGNORED and skip the field instead of rolling the row back.
 *
 * A field-level refusal is: any `perm.*`, a malformed target
 * (`request.invalid`), or a FIXED dataframe slot (dd560) asked without a valid
 * main (`request.invalid_source`, T0-4). Anything else is not the door's
 * answer about this field and must propagate (the record rolls back, the run
 * reports).
 */

import { type DedaloError, isDedaloError } from '../errors/index.ts';

export function isFieldWriteRefusal(error: unknown): error is DedaloError {
	if (!isDedaloError(error)) return false;
	return (
		error.code.startsWith('perm.') ||
		error.code === 'request.invalid' ||
		error.code === 'request.invalid_source'
	);
}
