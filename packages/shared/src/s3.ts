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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

export interface BlobStore {
  putTrace(runId: string, events: AgentEvent[]): Promise<string>;
  getTrace(key: string): Promise<AgentEvent[] | null>;
  putAsset(key: string, body: Uint8Array, contentType: string): Promise<string>;
}

/** Durable local fallback used for development when S3 is not configured. */
class FileBlobStore implements BlobStore {
  constructor(private readonly rootDir = process.env.KILN_BLOB_DIR ?? join(process.cwd(), ".kiln", "blobs")) {}

  async putTrace(runId: string, events: AgentEvent[]): Promise<string> {
    const key = `traces/${runId}.json`;
    await this.write(key, JSON.stringify(events), "utf8");
    return key;
  }

  async getTrace(key: string): Promise<AgentEvent[] | null> {
    try {
      return JSON.parse(await readFile(this.resolveKey(key), "utf8")) as AgentEvent[];
    } catch {
      return null;
    }
  }

  async putAsset(key: string, body: Uint8Array): Promise<string> {
    await this.write(key, body);
    return key;
  }

  private async write(key: string, body: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, encoding);
  }

  private resolveKey(key: string): string {
    const root = resolve(this.rootDir);
    const path = resolve(root, key);
    if (path !== root && !path.startsWith(root + "/")) {
      throw new Error(`Blob key escapes root: ${key}`);
    }
    return path;
  }
}

type S3Sdk = {
  S3Client: new (config: Record<string, unknown>) => { send(command: object): Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }> };
  GetObjectCommand: new (input: Record<string, unknown>) => object;
  PutObjectCommand: new (input: Record<string, unknown>) => object;
};

const requireAwsSdk = createRequire(import.meta.url);

class S3BlobStore implements BlobStore {
  private client: { send(command: object): Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }> } | null = null;

  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
  ) {}

  async putTrace(runId: string, events: AgentEvent[]): Promise<string> {
    const { PutObjectCommand } = await this.sdk();
    const key = this.key(`traces/${runId}.json`);
    await (await this.getClient()).send(
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
      const { GetObjectCommand } = await this.sdk();
      const res = await (await this.getClient()).send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) return null;
      return JSON.parse(new TextDecoder().decode(bytes)) as AgentEvent[];
    } catch {
      return null;
    }
  }

  async putAsset(key: string, body: Uint8Array, contentType: string): Promise<string> {
    const { PutObjectCommand } = await this.sdk();
    const finalKey = this.key(key);
    await (await this.getClient()).send(
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

  private credentials(): Record<string, string> | undefined {
    const accessKeyId = process.env.KILN_S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.KILN_S3_SECRET_ACCESS_KEY;
    if (!accessKeyId && !secretAccessKey) return undefined;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("KILN_S3_ACCESS_KEY_ID and KILN_S3_SECRET_ACCESS_KEY must be configured together.");
    }
    return {
      accessKeyId,
      secretAccessKey,
      ...(process.env.KILN_S3_SESSION_TOKEN ? { sessionToken: process.env.KILN_S3_SESSION_TOKEN } : {}),
    };
  }

  private async getClient(): Promise<{ send(command: object): Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }> }> {
    if (!this.client) {
      const { S3Client } = await this.sdk();
      this.client = new S3Client({
        region: process.env.KILN_S3_REGION ?? process.env.AWS_REGION ?? "us-east-1",
        endpoint: process.env.KILN_S3_ENDPOINT,
        forcePathStyle: process.env.KILN_S3_FORCE_PATH_STYLE === "1",
        credentials: this.credentials(),
      });
    }
    return this.client;
  }

  private async sdk(): Promise<S3Sdk> {
    return requireAwsSdk("@aws-sdk/client-s3") as S3Sdk;
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
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) {
    throw new Error("KILN_S3_BUCKET is required for production Postgres trace storage.");
  }
  return new FileBlobStore();
}
