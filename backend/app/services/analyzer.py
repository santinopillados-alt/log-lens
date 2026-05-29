"""
AI analysis service — wraps the Anthropic API call.

FAILURE HANDLING (documented for interviews):
Q: "What happens if the AI call fails?"
A: Three-layer defense:
   1. Timeout: hard 30s limit — slow AI is worse than no AI for UX
   2. Retry: one automatic retry on 5xx/timeout (idempotent prompt)
   3. Fallback: if both attempts fail, return a stats-only result with
      severity derived from error_rate. User gets value even when AI is down.

This means the system NEVER returns a 500 to the user for an AI failure.
"""
import json
import logging
import re
import time
from typing import Optional

import anthropic
import httpx

from app.models.schemas import AnalysisResult, LogStats, Severity

logger = logging.getLogger(__name__)

# One client instance per process — reuses the connection pool
_client: Optional[anthropic.Anthropic] = None


def get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
    return _client


SYSTEM_PROMPT = """You are a senior SRE (Site Reliability Engineer) analyzing production logs.
Your job is to diagnose what went wrong and give actionable guidance — fast.

Rules:
- Be direct and specific. No filler phrases like "it seems" or "it appears".
- Root cause must be a single, concrete sentence (max 20 words).
- Immediate actions must be executable commands or steps, not vague advice.
- If you cannot determine the root cause from the logs, say so explicitly.
- Return ONLY valid JSON. No markdown, no explanation outside the JSON.

Response format:
{
  "severity": "low|medium|high|critical",
  "root_cause": "Single sentence identifying the exact failure point",
  "what_happened": "2-3 sentence narrative of the incident timeline",
  "immediate_actions": ["Step 1", "Step 2", "Step 3"],
  "prevention": ["Long-term fix 1", "Long-term fix 2"]
}"""


def _severity_from_stats(stats: LogStats) -> Severity:
    """Derive severity from stats alone — used in fallback path."""
    if stats.error_rate_percent >= 50:
        return Severity.CRITICAL
    if stats.error_rate_percent >= 25:
        return Severity.HIGH
    if stats.error_rate_percent >= 10:
        return Severity.MEDIUM
    return Severity.LOW


def _parse_ai_response(text: str) -> dict:
    """Extract JSON from AI response, handling potential markdown wrapping."""
    # Strip markdown code fences if present
    text = re.sub(r"```(?:json)?\s*", "", text).strip()
    return json.loads(text)


def _call_ai(context: str) -> tuple[dict, int]:
    """
    Single AI call. Returns (parsed_dict, tokens_used).
    Raises on any error — caller handles retry/fallback.
    """
    client = get_client()
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1000,
        timeout=httpx.Timeout(30.0),
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": f"Analyze these logs and return your diagnosis as JSON:\n\n{context}",
            }
        ],
    )
    text = response.content[0].text
    parsed = _parse_ai_response(text)
    tokens = response.usage.input_tokens + response.usage.output_tokens
    return parsed, tokens


def analyze(
    analysis_id: str,
    service_name: str,
    ai_context: str,
    stats: LogStats,
    start_time: float,
) -> AnalysisResult:
    """
    Run AI analysis with retry + fallback.
    Always returns an AnalysisResult — never raises to the caller.
    """
    ai_data: Optional[dict] = None
    tokens_used = 0
    attempts = 0

    for attempt in range(2):  # one retry
        attempts = attempt + 1
        try:
            ai_data, tokens_used = _call_ai(ai_context)
            break
        except (anthropic.APITimeoutError, anthropic.InternalServerError) as e:
            logger.warning("AI attempt %d failed: %s", attempt + 1, e)
            if attempt == 0:
                time.sleep(1)  # brief pause before retry
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as e:
            # Config errors — retrying won't help
            logger.error("AI auth error: %s", e)
            break
        except Exception as e:
            logger.error("Unexpected AI error on attempt %d: %s", attempt + 1, e)
            break

    processing_ms = int((time.time() - start_time) * 1000)

    if ai_data is None:
        # ── FALLBACK PATH ─────────────────────────────────────────────────────
        # AI is down. Return stats-based result so the user still gets value.
        logger.warning(
            "AI unavailable after %d attempts for %s — using stats fallback",
            attempts,
            analysis_id,
        )
        return AnalysisResult(
            id=analysis_id,
            service_name=service_name,
            severity=_severity_from_stats(stats),
            root_cause="AI analysis unavailable — severity derived from error rate statistics.",
            what_happened=(
                f"Log analysis could not be completed by AI after {attempts} attempt(s). "
                f"Statistical analysis shows {stats.error_rate_percent}% error rate "
                f"across {stats.total_lines} log lines."
            ),
            immediate_actions=[
                "Review the error sample in the stats panel below.",
                "Check AI service availability and retry in a few minutes.",
            ],
            prevention=["Ensure ANTHROPIC_API_KEY is valid and has sufficient quota."],
            stats=stats,
            tokens_used=0,
            created_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
            processing_ms=processing_ms,
        )

    # ── HAPPY PATH ────────────────────────────────────────────────────────────
    from datetime import datetime, timezone

    return AnalysisResult(
        id=analysis_id,
        service_name=service_name,
        severity=Severity(ai_data.get("severity", "medium")),
        root_cause=ai_data.get("root_cause", "Could not determine root cause."),
        what_happened=ai_data.get("what_happened", ""),
        immediate_actions=ai_data.get("immediate_actions", []),
        prevention=ai_data.get("prevention", []),
        stats=stats,
        tokens_used=tokens_used,
        created_at=datetime.now(timezone.utc),
        processing_ms=processing_ms,
    )
