/**
 * S3 client for trace + report-asset storage (Decision 7).
 *
 * Full execution traces (AgentEvent[]) and generated assets (OG images) live in
 * S3 keyed by run id. This module wraps the access pattern behind a tiny
 * interface so callers don't depend on a concrete SDK. When S3 env vars are
 * absent (local dev / sandbox), it falls back to an in-memory store so the rest
 * of the system runs without external dependencies.
 */
import type { AgentEvent } from "./types.js";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

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

class S3BlobStore implements BlobStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
  ) {
    this.client = new S3Client({
      region: process.env.KILN_S3_REGION ?? process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.KILN_S3_ENDPOINT,
      forcePathStyle: process.env.KILN_S3_FORCE_PATH_STYLE === "1",
    });
  }

  async putTrace(runId: string, events: AgentEvent[]): Promise<string> {
    const key = this.key(`traces/${runId}.json`);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(events),
        ContentType: "application/json",
      }),
    );
    return key;
  }

  async getTrace(key: string): Promise<AgentEvent[] | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) return null;
      return JSON.parse(new TextDecoder().decode(bytes)) as AgentEvent[];
    } catch {
      return null;
    }
  }

  async putAsset(key: string, body: Uint8Array, contentType: string): Promise<string> {
    const finalKey = this.key(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: finalKey,
        Body: body,
        ContentType: contentType,
      }),
    );
    return finalKey;
  }

  private key(key: string): string {
    return this.prefix ? `${this.prefix.replace(/\/$/, "")}/${key}` : key;
  }
}

/**
 * Returns the configured S3-backed store, or the in-memory fallback. The real
 * implementation (AWS SDK / R2) is wired in here once `KILN_S3_BUCKET` is set;
 * the interface above is what callers depend on.
 */
export function getBlobStore(): BlobStore {
  if (process.env.KILN_S3_BUCKET) {
    return new S3BlobStore(process.env.KILN_S3_BUCKET, process.env.KILN_S3_PREFIX ?? "");
  }
  return new MemoryBlobStore();
}
