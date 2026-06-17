import type { OzCodeExample, OzCrawledPage } from "@kiln/shared";
import type { OzTool } from "./contracts.js";

interface ExtractCodeBlocksInput {
  pages: OzCrawledPage[];
}

const FENCED = /```([a-z0-9+#._-]*)\s*([\s\S]*?)```/gi;
const INLINE_IMPORT = /((?:npm|pnpm|yarn|pip|curl|go)\s+[^\n]{4,180})/gi;

export const extractCodeBlocksTool: OzTool<ExtractCodeBlocksInput, { examples: OzCodeExample[] }> = {
  name: "extract_code_blocks",
  description: "Extract code examples and install snippets from crawled docs.",
  inputSchema: { type: "object", required: ["pages"] },
  outputSchema: { type: "object" },
  async execute(input) {
    const examples: OzCodeExample[] = [];
    for (const page of input.pages) {
      for (let match = FENCED.exec(page.text); match && examples.length < 30; match = FENCED.exec(page.text)) {
        const code = (match[2] ?? "").trim();
        if (code.length < 12) continue;
        examples.push({ language: match[1] || "text", code: code.slice(0, 4_000), sourceUrl: page.url });
      }
      for (let match = INLINE_IMPORT.exec(page.text); match && examples.length < 30; match = INLINE_IMPORT.exec(page.text)) {
        examples.push({ language: "shell", code: (match[1] ?? "").trim(), sourceUrl: page.url });
      }
    }
    return { examples };
  },
};
