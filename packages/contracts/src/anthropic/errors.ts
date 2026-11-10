/**
 * Anthropic error taxonomy.
 *
 * Mirrors platform.claude.com/docs/en/api/errors: HTTP status, `error.type`,
 * the `{type:"error", error:{...}, request_id}` body shape, and the
 * `request-id` response header.
 */

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "conflict_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "timeout_error"
  | "overloaded_error";

export interface AnthropicErrorBody {
  type: "error";
  error: {
    type: AnthropicErrorType;
    message: string;
    details?: Record<string, unknown>;
  };
  request_id: string;
}

export class AnthropicApiError extends Error {
  readonly status: number;
  readonly type: AnthropicErrorType;
  readonly details?: Record<string, unknown>;
  readonly requestId: string;
  /** True when a retry has a reasonable chance of succeeding. */
  readonly retryable: boolean;

  constructor(opts: {
    status: number;
    type: AnthropicErrorType;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
  }) {
    super(opts.message);
    this.name = "AnthropicApiError";
    this.status = opts.status;
    this.type = opts.type;
    this.requestId = opts.requestId;
    this.details = opts.details;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE.has(opts.type);
  }

  toBody(): AnthropicErrorBody {
    return {
      type: "error",
      error: {
        type: this.type,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
      request_id: this.requestId,
    };
  }

  toJSON() {
    return this.toBody();
  }
}

/** Error types where an identical retry is meaningful. */
const DEFAULT_RETRYABLE = new Set<AnthropicErrorType>([
  "rate_limit_error",
  "api_error",
  "timeout_error",
  "overloaded_error",
  "conflict_error",
]);

export const invalidRequest = (message: string, requestId: string, details?: Record<string, unknown>) =>
  new AnthropicApiError({ status: 400, type: "invalid_request_error", message, requestId, details });

export const notFound = (message: string, requestId: string) =>
  new AnthropicApiError({ status: 404, type: "not_found_error", message, requestId });

export const permissionDenied = (message: string, requestId: string) =>
  new AnthropicApiError({ status: 403, type: "permission_error", message, requestId });

export const authenticationError = (message: string, requestId: string) =>
  new AnthropicApiError({ status: 401, type: "authentication_error", message, requestId });

export const rateLimited = (
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
) => new AnthropicApiError({ status: 429, type: "rate_limit_error", message, requestId, details });

export const overloaded = (message: string, requestId: string) =>
  new AnthropicApiError({ status: 529, type: "overloaded_error", message, requestId });

export const upstreamError = (message: string, requestId: string) =>
  new AnthropicApiError({ status: 500, type: "api_error", message, requestId });

export const timeoutError = (message: string, requestId: string) =>
  new AnthropicApiError({ status: 504, type: "timeout_error", message, requestId });

/** Map an unknown thrown value into an Anthropic-shaped error. */
export function toAnthropicError(err: unknown, requestId: string): AnthropicApiError {
  if (err instanceof AnthropicApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return upstreamError(message, requestId);
}
