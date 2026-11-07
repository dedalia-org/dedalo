/**
 * src/core/errors — the import door. See engineering/ERRORS_SPEC.md.
 * registry.ts and dedalo_error.ts are the leaf pair (import nothing);
 * convert.ts and log.ts are the chokepoint helpers.
 */

export {
	type EnvelopeExtension,
	type ErrorEnvelopeContext,
	type ErrorEnvelopeResult,
	type ErrorSurface,
	type FailureRecord,
	type OkEnvelopeContext,
	ok,
	type StreamErrorFrame,
	type StructuredErrV2,
	toDedaloError,
	toErrorBody,
	toErrorEnvelope,
	toFailureRecord,
	toStreamFrame,
	toStructuredErr,
	wireMessage,
} from './convert.ts';
export {
	DedaloError,
	type DedaloErrorFields,
	type ErrorDetailScalar,
	isDedaloError,
	isErrorInDomain,
	spec,
} from './dedalo_error.ts';
export { type SectionIdCode, SectionIdRefused } from './families.ts';
export { formatErrorLine, type LogErrorContext, logError } from './log.ts';
export {
	CATEGORY_STATUS,
	defaultLabelKey,
	ERROR_CODE_PATTERN,
	ERROR_CODES,
	ERROR_REGISTRY,
	type ErrorCategory,
	type ErrorCode,
	type ErrorDisclosure,
	type ErrorSeverity,
	type ErrorSpec,
	EXTERNAL_ERROR_KINDS,
	isErrorCode,
	LEGACY_TOKEN_MAP,
	MCP_HINT_CODES,
	REASON_KEY,
	REASON_KEY_CODES,
	REASON_KEY_PATTERN,
	STATUS_EXEMPTIONS,
	specOf,
} from './registry.ts';
export {
	type ApiEnvelope,
	type ApiErrorBody,
	type ApiNotice,
	apiEnvelopeSchema,
	ENVELOPE_FORBIDDEN_KEYS,
	ENVELOPE_RESERVED_KEYS,
	type ErrEnvelope,
	errEnvelopeSchema,
	errorBodySchema,
	noticeSchema,
	type OkEnvelope,
	okEnvelopeSchema,
} from './schema.ts';
