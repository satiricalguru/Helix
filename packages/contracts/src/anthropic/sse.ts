/**
 * Server-Sent Events framing for the Anthropic wire format.
 *
 * Anthropic clients dispatch on the `event:` name, so every frame must carry
 * both an `event:` line and a `data:` line, and frames must never be coalesced.
 */

/** Serialise one Anthropic event into an SSE frame (including the blank line). */
export function formatSseEvent(event: { type: string } & Record<string, unknown>): string {
  const data = JSON.stringify(event);
  // A data payload containing a newline must be split across multiple data
  // lines per the SSE spec. JSON.stringify never emits raw newlines, but be
  // defensive anyway.
  const lines = data.split("\n").map((l) => `data: ${l}`).join("\n");
  return `event: ${event.type}\n${lines}\n\n`;
}

/** A comment frame, used as a keepalive. */
export function formatSseComment(text = "keepalive"): string {
  return `: ${text}\n\n`;
}

export interface SseWriterOptions {
  /** Called for each frame. */
  write: (chunk: string) => void;
}

/**
 * Minimal SSE writer. Deliberately synchronous and dependency-free so the
 * gateway can push frames straight into a `ReadableStream` without buffering.
 */
export class SseWriter {
  #write: (chunk: string) => void;
  #closed = false;

  constructor(options: SseWriterOptions) {
    this.#write = options.write;
  }

  get closed(): boolean {
    return this.#closed;
  }

  event(event: { type: string } & Record<string, unknown>): void {
    if (this.#closed) return;
    this.#write(formatSseEvent(event));
  }

  comment(text?: string): void {
    if (this.#closed) return;
    this.#write(formatSseComment(text));
  }

  close(): void {
    this.#closed = true;
  }
}

/* ------------------------------------------------------------- parsing */

/** Parse a raw SSE byte stream into `{ event, data }` records. */
export function* parseSseStream(
  chunk: string,
  state: { event: string | null; data: string[]; lastEventId: string | null },
): Generator<{ event: string | null; data: string; id: string | null }> {
  // Normalise CRLF and split on blank lines.
  const normalised = chunk.replace(/\r\n/g, "\n");
  const frames = normalised.split(/\n\n+/);
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) continue;
    if (frame === "") continue;
    // A trailing partial frame is carried in `state` by the caller.
    const isLast = i === frames.length - 1 && !normalised.endsWith("\n\n");
    let eventName = state.event;
    const dataLines: string[] = [];
    let sawField = false;
    for (const line of frame.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const idx = line.indexOf(":");
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? "" : line.slice(idx + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") {
        eventName = value;
        sawField = true;
      } else if (field === "data") {
        dataLines.push(value);
        sawField = true;
      } else if (field === "id") {
        state.lastEventId = value;
        sawField = true;
      }
    }
    if (!sawField) continue;
    if (isLast && dataLines.length === 0 && eventName === null) continue;
    state.event = null;
    const data = dataLines.join("\n");
    if (data === "") continue;
    yield { event: eventName, data, id: state.lastEventId };
  }
}

/** Create an async generator that yields parsed SSE records from a byte stream. */
export async function* readSse(
  stream: AsyncIterable<Uint8Array>,
  decoder = new TextDecoder(),
): AsyncGenerator<{ event: string | null; data: string; id: string | null }> {
  const state = { event: null as string | null, data: [] as string[], lastEventId: null as string | null };
  let buffer = "";
  for await (const bytes of stream) {
    buffer += decoder.decode(bytes, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const rec of parseSseStream(frame + "\n\n", state)) yield rec;
    }
  }
  if (buffer.trim() !== "") {
    for (const rec of parseSseStream(buffer + "\n\n", state)) yield rec;
  }
}
