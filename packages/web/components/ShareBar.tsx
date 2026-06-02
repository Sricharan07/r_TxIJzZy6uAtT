"use client";

import { useState } from "react";

/** Copyable share URL for a report or eval config (Decision 19). */
export function ShareBar({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="share-bar">
      <input type="text" value={url} readOnly aria-label="Shareable URL" />
      <button
        className="btn btn-ghost"
        style={{ padding: "5px 10px", fontSize: "11px" }}
        onClick={() => {
          navigator.clipboard?.writeText(url).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => setCopied(false)
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
