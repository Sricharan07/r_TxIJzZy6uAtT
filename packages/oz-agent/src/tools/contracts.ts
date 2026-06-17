import type { KilnStore } from "@kiln/shared/store";

export interface OzToolContext {
  jobId: string;
  userId: string;
  store?: KilnStore;
  fetchImpl?: typeof fetch;
}

export interface OzTool<I, O> {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  execute(input: I, ctx: OzToolContext): Promise<O>;
}

export function scoreText(text: string, patterns: RegExp[]): number {
  const haystack = text.toLowerCase();
  return patterns.reduce((score, pattern) => score + (pattern.test(haystack) ? 1 : 0), 0);
}

export function clampConfidence(value: number): number {
  return Math.max(0.05, Math.min(0.99, value));
}

export function normalizeUrl(url: string): string {
  const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(item);
  }
  return out;
}

export function evidence(source: string, quote: string, confidence: number) {
  return { source, quote: quote.trim().slice(0, 280), confidence: clampConfidence(confidence) };
}
