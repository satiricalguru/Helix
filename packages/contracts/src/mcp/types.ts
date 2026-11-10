/**
 * Model Context Protocol wire types.
 *
 * Covers both protocol eras Helix must serve:
 *   - modern: 2026-07-28 (stateless, per-request `_meta`, `resultType`)
 *   - legacy: 2025-11-25 and earlier (`initialize` handshake, `Mcp-Session-Id`)
 */

export const MCP_PROTOCOL_VERSION_MODERN = "2026-07-28";
export const MCP_PROTOCOL_VERSION_LEGACY = "2025-11-25";

export const SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_PROTOCOL_VERSION_MODERN,
  MCP_PROTOCOL_VERSION_LEGACY,
  "2025-06-18",
  "2025-03-26",
] as const;

/* ------------------------------------------------------------ json-rpc */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

/* -------------------------------------------------------- error codes */

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** 2026-07-28: header/body mismatch. */
  HeaderMismatch: -32020,
  /** 2026-07-28: the client did not declare a capability we require. */
  MissingRequiredClientCapability: -32021,
  /** 2026-07-28: unsupported protocol version. */
  UnsupportedProtocolVersion: -32022,
} as const;

/* --------------------------------------------------------------- meta */

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_LOG_LEVEL = "io.modelcontextprotocol/logLevel";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
export const META_RELATED_TASK = "io.modelcontextprotocol/related-task";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

export interface Implementation {
  name: string;
  title?: string;
  version: string;
  description?: string;
  websiteUrl?: string;
  icons?: Array<{ src: string; mimeType?: string; sizes?: string }>;
}

export interface ClientCapabilities {
  roots?: Record<string, unknown>;
  sampling?: Record<string, unknown>;
  elicitation?: { form?: Record<string, unknown>; url?: Record<string, unknown> };
  tasks?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
  completions?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/* ------------------------------------------------------------ results */

export type ResultType = "complete" | "input_required" | "task";

export interface CacheableResult {
  ttlMs?: number;
  cacheScope?: "public" | "private";
}

/* -------------------------------------------------------------- tools */

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  icons?: Array<{ src: string; mimeType?: string; sizes?: string }>;
  _meta?: Record<string, unknown>;
}

export interface McpToolResult {
  resultType?: ResultType;
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/* ---------------------------------------------------------- resources */

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  icons?: Array<{ src: string; mimeType?: string; sizes?: string }>;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/* ------------------------------------------------------------ prompts */

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  icons?: Array<{ src: string; mimeType?: string; sizes?: string }>;
}

/* -------------------------------------------------------------- tasks */

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface McpTask {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
}

/* --------------------------------------------------------------- MRTR */

export interface InputRequiredResult {
  resultType: "input_required";
  inputRequests?: Record<string, { method: string; params?: Record<string, unknown> }>;
  requestState?: string;
  _meta?: Record<string, unknown>;
}

export type InputResponses = Record<string, unknown>;

/* ------------------------------------------------------- auth metadata */

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  [k: string]: unknown;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  device_authorization_endpoint?: string;
  jwks_uri?: string;
  response_types_supported: string[];
  response_modes_supported?: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
  authorization_response_iss_parameter_supported?: boolean;
  scopes_supported?: string[];
  [k: string]: unknown;
}

export interface DynamicClientRegistrationRequest {
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  application_type?: "web" | "native";
  scope?: string;
  [k: string]: unknown;
}

export interface DynamicClientRegistrationResponse {
  client_id: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
}
