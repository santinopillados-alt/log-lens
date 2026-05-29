import { useState, useCallback } from "react";
import { api } from "./services/api";

// ── Severity config ────────────────────────────────────────────────────────
const SEVERITY = {
  low:      { label: "LOW",      color: "#22c55e", bg: "rgba(34,197,94,0.1)"  },
  medium:   { label: "MEDIUM",   color: "#f59e0b", bg: "rgba(245,158,11,0.1)" },
  high:     { label: "HIGH",     color: "#f97316", bg: "rgba(249,115,22,0.1)" },
  critical: { label: "CRITICAL", color: "#ef4444", bg: "rgba(239,68,68,0.1)"  },
};

const SAMPLE_LOGS = `2024-01-15 10:00:01 INFO  api-gateway — Request received trace_id=abc-123-def
2024-01-15 10:00:01 INFO  auth-service — Token validated trace_id=abc-123-def
2024-01-15 10:00:02 ERROR api-gateway — Database connection timeout: connect ETIMEDOUT 10.0.1.5:5432 trace_id=abc-123-def
2024-01-15 10:00:02 ERROR api-gateway — Failed to process request: connection refused trace_id=abc-123-def
2024-01-15 10:00:03 WARNING api-gateway — Retry attempt 1/3 trace_id=abc-123-def
2024-01-15 10:00:04 WARNING api-gateway — Retry attempt 2/3 trace_id=abc-123-def
2024-01-15 10:00:05 ERROR api-gateway — Max retries exceeded, request aborted trace_id=abc-123-def
2024-01-15 10:00:05 INFO  api-gateway — Circuit breaker opened for database-service
2024-01-15 10:00:06 ERROR payment-service — Cannot process payment: upstream unavailable trace_id=xyz-456
2024-01-15 10:00:07 CRITICAL payment-service — Transaction rollback failed: deadlock detected trace_id=xyz-456`;

// ── Sub-components ─────────────────────────────────────────────────────────

function SeverityBadge({ severity }) {
  const cfg = SEVERITY[severity] || SEVERITY.low;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 10px", borderRadius: 4,
      background: cfg.bg, color: cfg.color,
      fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
      border: `1px solid ${cfg.color}40`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: cfg.color }} />
      {cfg.label}
    </span>
  );
}

function StatPill({ label, value, accent }) {
  return (
    <div style={{
      padding: "10px 16px", borderRadius: 8,
      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
      display: "flex", flexDirection: "column", gap: 2,
    }}>
      <span style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color: accent || "#f1f5f9" }}>{value}</span>
    </div>
  );
}

function ActionList({ items, icon, color }) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((item, i) => (
        <li key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "#cbd5e1" }}>
          <span style={{ color, marginTop: 1, flexShrink: 0 }}>{icon}</span>
          {item}
        </li>
      ))}
    </ul>
  );
}

function AnalysisPanel({ result }) {
  const sv = SEVERITY[result.severity] || SEVERITY.low;
  return (
    <div style={{ animation: "fadeUp 0.3s ease" }}>
      {/* Header */}
      <div style={{
        padding: "20px 24px", marginBottom: 2,
        background: sv.bg, borderRadius: "12px 12px 0 0",
        border: `1px solid ${sv.color}30`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div>
          <div style={{ fontSize: 11, color: sv.color, fontWeight: 600, letterSpacing: "0.08em", marginBottom: 4 }}>
            ROOT CAUSE
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, color: "#f1f5f9", lineHeight: 1.4 }}>
            {result.root_cause}
          </div>
        </div>
        <SeverityBadge severity={result.severity} />
      </div>

      {/* Stats bar */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))",
        gap: 2, marginBottom: 2,
      }}>
        <StatPill label="Total Lines" value={result.stats.total_lines} />
        <StatPill label="Error Rate" value={`${result.stats.error_rate_percent}%`} accent={sv.color} />
        <StatPill label="Errors" value={result.stats.error_count} accent="#ef4444" />
        <StatPill label="Warnings" value={result.stats.warning_count} accent="#f59e0b" />
        <StatPill label="Trace IDs" value={result.stats.unique_trace_ids} />
        <StatPill label="AI Tokens" value={result.tokens_used || "—"} />
        <StatPill label="Processing" value={`${result.processing_ms}ms`} />
      </div>

      {/* Main content */}
      <div style={{
        padding: "20px 24px",
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: "0 0 12px 12px",
        display: "flex", flexDirection: "column", gap: 20,
      }}>
        {/* What happened */}
        <div>
          <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, letterSpacing: "0.08em", marginBottom: 8 }}>WHAT HAPPENED</div>
          <p style={{ margin: 0, fontSize: 14, color: "#94a3b8", lineHeight: 1.6 }}>{result.what_happened}</p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          {/* Immediate actions */}
          <div>
            <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, letterSpacing: "0.08em", marginBottom: 10 }}>IMMEDIATE ACTIONS</div>
            <ActionList items={result.immediate_actions} icon="→" color="#3b82f6" />
          </div>
          {/* Prevention */}
          <div>
            <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, letterSpacing: "0.08em", marginBottom: 10 }}>PREVENTION</div>
            <ActionList items={result.prevention} icon="◆" color="#8b5cf6" />
          </div>
        </div>

        {/* Top errors */}
        {result.stats.top_error_messages.length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, letterSpacing: "0.08em", marginBottom: 10 }}>RECURRING ERROR PATTERNS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {result.stats.top_error_messages.map((msg, i) => (
                <code key={i} style={{
                  display: "block", padding: "6px 10px",
                  background: "rgba(239,68,68,0.06)", borderRadius: 4,
                  fontSize: 12, color: "#fca5a5",
                  border: "1px solid rgba(239,68,68,0.15)",
                  whiteSpace: "pre-wrap", wordBreak: "break-all",
                }}>
                  {msg}
                </code>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryRow({ record, onSelect }) {
  const sv = SEVERITY[record.severity] || SEVERITY.low;
  return (
    <button
      onClick={() => onSelect(record.id)}
      style={{
        width: "100%", textAlign: "left", cursor: "pointer",
        padding: "12px 16px", borderRadius: 8,
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.06)",
        transition: "border-color 0.15s",
        display: "flex", alignItems: "center", gap: 12,
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = sv.color + "50"}
      onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: sv.color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "#e2e8f0", fontWeight: 500, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {record.root_cause}
        </div>
        <div style={{ fontSize: 11, color: "#475569" }}>
          {record.service_name} · {record.error_rate_percent}% errors · {record.total_lines} lines
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#334155", flexShrink: 0 }}>
        {new Date(record.created_at).toLocaleDateString()}
      </div>
    </button>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState("analyze"); // "analyze" | "history"
  const [logs, setLogs] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const handleAnalyze = useCallback(async () => {
    if (!logs.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await api.analyze(logs, serviceName || "unknown");
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [logs, serviceName]);

  const handleTabHistory = useCallback(async () => {
    setTab("history");
    setHistoryLoading(true);
    try {
      const data = await api.getHistory({ limit: 30 });
      setHistory(data);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const inputStyle = {
    width: "100%", boxSizing: "border-box",
    padding: "10px 14px", borderRadius: 8,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "#e2e8f0", fontSize: 13,
    outline: "none", transition: "border-color 0.15s",
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#080b10",
      color: "#e2e8f0",
      fontFamily: "'IBM Plex Mono', 'Fira Code', 'Courier New', monospace",
      padding: "40px 24px",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        textarea:focus, input:focus { border-color: rgba(59,130,246,0.5) !important; }
        textarea::placeholder, input::placeholder { color: #334155; }
        button { font-family: inherit; }
      `}</style>

      <div style={{ maxWidth: 860, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16,
            }}>◎</div>
            <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>Log-Lens</span>
            <span style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 4,
              background: "rgba(59,130,246,0.1)", color: "#60a5fa",
              border: "1px solid rgba(59,130,246,0.2)", letterSpacing: "0.08em",
            }}>BETA</span>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: "#475569" }}>
            AI-powered root cause analysis for production logs — no Datadog required.
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, marginBottom: 24, borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 0 }}>
          {[["analyze", "Analyze"], ["history", "History"]].map(([id, label]) => (
            <button
              key={id}
              onClick={id === "history" ? handleTabHistory : () => setTab(id)}
              style={{
                padding: "8px 16px", background: "none",
                border: "none", borderBottom: tab === id ? "2px solid #3b82f6" : "2px solid transparent",
                color: tab === id ? "#e2e8f0" : "#475569",
                fontSize: 13, fontWeight: tab === id ? 600 : 400,
                cursor: "pointer", marginBottom: -1,
                transition: "color 0.15s",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Analyze tab */}
        {tab === "analyze" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input
              value={serviceName}
              onChange={e => setServiceName(e.target.value)}
              placeholder="Service name (optional — e.g. payment-service)"
              style={{ ...inputStyle, marginBottom: 4 }}
            />
            <div style={{ position: "relative" }}>
              <textarea
                value={logs}
                onChange={e => setLogs(e.target.value)}
                placeholder={`Paste your logs here...\n\nExample:\n${SAMPLE_LOGS.split('\n').slice(0,3).join('\n')}`}
                style={{
                  ...inputStyle, minHeight: 200,
                  resize: "vertical", lineHeight: 1.6, fontSize: 12,
                }}
              />
              {!logs && (
                <button
                  onClick={() => setLogs(SAMPLE_LOGS)}
                  style={{
                    position: "absolute", bottom: 10, right: 10,
                    padding: "4px 10px", background: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 4, color: "#64748b", fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  load sample
                </button>
              )}
            </div>

            <button
              onClick={handleAnalyze}
              disabled={loading || !logs.trim()}
              style={{
                padding: "12px 24px", borderRadius: 8,
                background: loading || !logs.trim()
                  ? "rgba(59,130,246,0.2)"
                  : "linear-gradient(135deg, #3b82f6, #6366f1)",
                border: "none", color: loading || !logs.trim() ? "#334155" : "#fff",
                fontSize: 13, fontWeight: 600, cursor: loading || !logs.trim() ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                transition: "opacity 0.15s",
              }}
            >
              {loading ? (
                <>
                  <span style={{ width: 14, height: 14, border: "2px solid #3b82f6", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} />
                  Analyzing...
                </>
              ) : "Analyze Logs →"}
            </button>

            {error && (
              <div style={{
                padding: "12px 16px", borderRadius: 8,
                background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
                color: "#fca5a5", fontSize: 13,
              }}>
                ⚠ {error}
              </div>
            )}

            {result && <AnalysisPanel result={result} />}
          </div>
        )}

        {/* History tab */}
        {tab === "history" && (
          <div>
            {historyLoading ? (
              <div style={{ color: "#334155", fontSize: 13, padding: "20px 0" }}>Loading history...</div>
            ) : history.length === 0 ? (
              <div style={{ color: "#334155", fontSize: 13, padding: "20px 0" }}>No analyses yet. Submit some logs first.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {history.map(record => (
                  <HistoryRow key={record.id} record={record} onSelect={() => {}} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{ marginTop: 48, paddingTop: 20, borderTop: "1px solid rgba(255,255,255,0.04)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#1e293b" }}>
            Built by Santino Coronel · github.com/santinopillados-alt
          </span>
          <span style={{ fontSize: 11, color: "#1e293b" }}>
            FastAPI · PostgreSQL · Anthropic Claude
          </span>
        </div>
      </div>
    </div>
  );
}
