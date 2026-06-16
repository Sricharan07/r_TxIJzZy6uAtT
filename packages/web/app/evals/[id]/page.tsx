import Link from "next/link";
import { getStore } from "@kiln/shared/store";
import { ShareBar } from "../../../components/ShareBar";
import { currentUserId } from "../../../lib/auth";

export const dynamic = "force-dynamic";

export default async function EvalConfigPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const evalRecord = await getStore().getEval(id);
  if (!evalRecord) {
    return (
      <div className="form-wrapper">
        <h2>Eval Config</h2>
        <p style={{ color: "var(--text-muted)" }}>Eval config not found.</p>
      </div>
    );
  }
  const userId = await currentUserId();
  const isShareToken = evalRecord.shareToken === id;
  if (!isShareToken && evalRecord.userId !== userId) {
    return (
      <div className="form-wrapper">
        <h2>Eval Config</h2>
        <p style={{ color: "var(--text-muted)" }}>Eval config not found.</p>
      </div>
    );
  }

  const runs = await getStore().listRuns(evalRecord.id);
  const latest = runs.length > 0 ? runs[runs.length - 1] : undefined;
  const shareUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/evals/${
    evalRecord.shareToken
  }`;

  return (
    <div className="form-wrapper">
      <div className="form-header">
        <h2>Eval Config</h2>
        <p>{evalRecord.config.task}</p>
      </div>
      <ShareBar url={shareUrl} />
      <div className="context-preview" style={{ display: "block" }}>
        <p>
          <strong>Language:</strong> {evalRecord.config.language}
        </p>
        <p>
          <strong>Agent:</strong> {evalRecord.config.metadata.agentType}
        </p>
        <p>
          <strong>Context:</strong> {evalRecord.config.context.length} sources
        </p>
        <p>
          <strong>Assertions:</strong> {evalRecord.config.assertions.length} tests
        </p>
      </div>
      <div className="section-title">Context Sources</div>
      <div className="context-sources">
        {evalRecord.config.context.map((source, idx) => (
          <div className="context-source" key={`${source.type}-${idx}`}>
            <span className={`ctx-badge ${source.type === "repo" ? "repo" : source.type === "url" ? "url" : "file"}`}>
              {source.type}
            </span>
            <span className="ctx-name">{source.label}</span>
          </div>
        ))}
      </div>
      <div className="section-title">Assertions</div>
      <div className="assertions">
        {evalRecord.config.assertions.map((assertion, idx) => (
          <div className="assertion-row" key={`${assertion.type}-${idx}`}>
            <span className={`assert-badge ${assertion.type}`}>{assertion.type.toUpperCase()}</span>
            <span className="assert-text">{assertion.name}</span>
          </div>
        ))}
      </div>
      <div className="form-nav">
        {latest && (
          <Link className="btn btn-ghost" href={`/reports/${latest.id}`}>
            Latest Report
          </Link>
        )}
        <Link className="btn btn-primary" href={`/evals/new?from=${evalRecord.id}`}>
          Run This Eval
        </Link>
      </div>
    </div>
  );
}
