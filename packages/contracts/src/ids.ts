/**
 * Identifier generation.
 *
 * Anthropic id formats that Helix reproduces so that SDKs and clients that
 * pattern-match on them keep working:
 *   - message id:   msg_...
 *   - tool use id:  toolu_...
 *   - request id:   req_...
 *   - server tool:  srvtoolu_...
 *   - batch id:     msgbatch_...
 */

import { randomUUID } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Random string using only the characters Anthropic uses in its ids. */
export function randomId(length = 24): string {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  // Rejection-free mapping: 62 does not divide 256, so bias slightly toward
  // the first 8 characters. Not a security boundary, just an id format.
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const messageId = (): string => `msg_${randomId(24)}`;
export const toolUseId = (): string => `toolu_${randomId(24)}`;
export const requestId = (): string => `req_${randomId(24)}`;
export const serverToolUseId = (): string => `srvtoolu_${randomId(24)}`;
export const messageBatchId = (): string => `msgbatch_${randomId(24)}`;

/**
 * UUIDv7: a 48-bit millisecond timestamp, a 4-bit version, a 12-bit
 * monotonic counter, a 2-bit variant and 62 random bits.
 *
 * The counter is what makes ids sortable: two ids minted in the same
 * millisecond still increase.
 */
let lastMs = 0;
let counter = 0;

export function uuidV7(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);

  const ms = Date.now();
  if (ms === lastMs) {
    counter = (counter + 1) & 0xfff;
    // A wrapped counter means the millisecond is gone; resync.
    if (counter === 0) lastMs = ms + 1;
  } else if (ms > lastMs) {
    lastMs = ms;
    counter = 0;
  } else {
    // The clock went backwards; keep the previous millisecond so ids stay
    // monotonic rather than jumping around.
    counter = (counter + 1) & 0xfff;
  }
  const stamp = Math.max(ms, lastMs);

  // The first 48 bits are the Unix timestamp in milliseconds, big-endian.
  // `>>>` is a 32-bit operator, so divide rather than shift.
  bytes[0] = Math.floor(stamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(stamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(stamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(stamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(stamp / 2 ** 8) & 0xff;
  bytes[5] = stamp & 0xff;
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7 + counter high
  bytes[7] = counter & 0xff; // counter low
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export { randomUUID };
