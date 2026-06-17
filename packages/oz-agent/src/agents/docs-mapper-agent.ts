import type { OzAgentState } from "@kiln/shared";

export interface DocsMapItem {
  surface: string;
  sourceUrl: string;
  signal: string;
  confidence: number;
}

const SURFACES: Array<{ surface: string; pattern: RegExp; signal: string }> = [
  { surface: "Quickstart", pattern: /quickstart|getting started|first/i, signal: "First integration path" },
  { surface: "Authentication", pattern: /auth|api key|bearer|token/i, signal: "Credential setup" },
  { surface: "SDK reference", pattern: /sdk|npm install|pip install|client/i, signal: "SDK install and initialization" },
  { surface: "API reference", pattern: /endpoint|rest|http|openapi|reference/i, signal: "HTTP/API operations" },
  { surface: "Webhook docs", pattern: /webhook|signature|event/i, signal: "Webhook verification" },
  { surface: "Examples", pattern: /example|sample|tutorial/i, signal: "Expected implementation pattern" },
  { surface: "Changelog", pattern: /changelog|release|migration/i, signal: "Version drift risk" },
];

export function buildDocsMap(state: OzAgentState): DocsMapItem[] {
  const items: DocsMapItem[] = [];
  for (const page of state.discovery.selectedDocs) {
    for (const surface of SURFACES) {
      if (!surface.pattern.test(`${page.url}\n${page.title}\n${page.text}`)) continue;
      items.push({
        surface: surface.surface,
        sourceUrl: page.url,
        signal: surface.signal,
        confidence: 0.72,
      });
    }
  }
  return items;
}

export async function runDocsMapperAgent(state: OzAgentState): Promise<{ state: OzAgentState; docsMap: DocsMapItem[] }> {
  return { state, docsMap: buildDocsMap(state) };
}
