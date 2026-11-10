/**
 * Higgsfield API wire types.
 *
 * Source: docs.higgsfield.ai (fetched 2026-11-10). Generation is asynchronous:
 * submit -> request_id -> poll or webhook -> terminal status -> output URLs.
 */

export const HF_BASE_URL = "https://api.higgsfield.ai";

export type HfRequestStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "nsfw"
  | "canceled";

export interface HfSubmitResponse {
  status: HfRequestStatus;
  request_id: string;
  status_url: string;
  cancel_url: string;
  expires_after?: number;
}

export interface HfOutputUrl {
  url: string;
}

export interface HfCompletedResponse {
  status: "completed";
  request_id: string;
  expires_at?: string;
  images?: HfOutputUrl[];
  video?: HfOutputUrl;
  audio?: HfOutputUrl;
  audios?: HfOutputUrl[];
  /** Some video/3D operations also produce these artifacts. */
  zip?: HfOutputUrl;
  mov?: HfOutputUrl;
  jsx?: HfOutputUrl;
  fbx?: HfOutputUrl;
  ply?: HfOutputUrl;
  error?: unknown;
}

export interface HfStatusResponse {
  status: HfRequestStatus;
  request_id: string;
  expires_at?: string;
  images?: HfOutputUrl[];
  video?: HfOutputUrl;
  audio?: HfOutputUrl;
  audios?: HfOutputUrl[];
  zip?: HfOutputUrl;
  mov?: HfOutputUrl;
  jsx?: HfOutputUrl;
  fbx?: HfOutputUrl;
  ply?: HfOutputUrl;
  error?: { code?: string; message?: string } | string;
}

export interface HfErrorDetail {
  code?: string;
  message?: string;
  retryable?: boolean;
  limit?: number;
  retry_after_seconds?: number;
}

export interface HfErrorBody {
  detail?: string | HfErrorDetail;
}

export interface HfWebhookEvent {
  request_id: string;
  status: HfRequestStatus;
  expires_at?: string;
  images?: HfOutputUrl[];
  video?: HfOutputUrl;
  audio?: HfOutputUrl;
  audios?: HfOutputUrl[];
  error?: unknown;
}

/** Model kinds Helix exposes through the MCP tools. */
export type HfModelKind = "image" | "video" | "audio" | "edit" | "upscale" | "lipsync";

/**
 * A catalog entry describing one Higgsfield endpoint.
 *
 * `unitPriceUsd` is the list price per `unit` (usually one second of video).
 * The catalog is a snapshot; Higgsfield can change pricing and models at any
 * time, so it is refreshed by a job rather than trusted blindly.
 */
export interface HfModelSpec {
  /** Endpoint id, e.g. `higgsfield/cinema-studio/4.0`. */
  endpointId: string;
  /** Human name, e.g. "Cinema Studio 4.0". */
  name: string;
  kind: HfModelKind;
  /** The upstream lab that actually serves the model. */
  provider: string;
  /** e.g. "seedance", "kling", "veo", "wan", "higgsfield", "minimax", "grok". */
  family: string;
  /** Price per `unit`, in USD. */
  unitPriceUsd: number;
  /** What one unit is: "second", "image", "clip". */
  unit: "second" | "image" | "clip";
  /** Accepted duration bounds in seconds (video only). */
  duration?: { min: number; max: number; default: number };
  /** Accepted resolutions (video only). */
  resolutions?: string[];
  /** Max reference images / videos / audios. */
  references?: { images?: number; videos?: number; audios?: number };
  /** Additional provider terms URL surfaced to users. */
  termsUrl?: string;
  /** Free-form description used in the MCP tool schema. */
  description?: string;
}
