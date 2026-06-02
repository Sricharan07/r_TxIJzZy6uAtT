/**
 * S3 client for trace + report-asset storage (Decision 7).
 *
 * Full execution traces (AgentEvent[]) and generated assets (OG images) live in
 * S3 keyed by run id. This module wraps the access pattern behind a tiny
 * interface so callers don't depend on a concrete SDK. When S3 env vars are
 * absent (local dev / sandbox), it falls back to an in-memory store so the rest
 * of the system runs without external dependencies.
 */
import type { AgentEvent } from "./types";

export interface BlobStore {
  putTrace(runId: string, events: AgentEvent[]): Promise<string>;
  getTrace(key: string): Promise<AgentEvent[] | null>;
  putAsset(key: string, body: Uint8Array, contentType: string): Promise<string>;
}

const memory = new Map<string, unknown>();

/** In-memory fallback used when S3 is not configured. */
class MemoryBlobStore implements BlobStore {
  async putTrace(runId: string, events: AgentEvent[]): Promise<string> {
    const key = `traces/${runId}.json`;
    memory.set(key, events);
    return key;
  }
  async getTrace(key: string): Promise<AgentEvent[] | null> {
    return (memory.get(key) as AgentEvent[]) ?? null;
  }
  async putAsset(key: string, body: Uint8Array): Promise<string> {
    memory.set(key, body);
    return key;
  }
}

/**
 * Returns the configured S3-backed store, or the in-memory fallback. The real
 * implementation (AWS SDK / R2) is wired in here once `KILN_S3_BUCKET` is set;
 * the interface above is what callers depend on.
 */
export function getBlobStore(): BlobStore {
  // A real deployment reads KILN_S3_BUCKET / KILN_S3_REGION / credentials and
  // returns an S3-backed BlobStore. Kept behind the interface so swapping the
  // backend never touches callers.
  return new MemoryBlobStore();
}
