"""
Tests for the log preprocessor — the core engineering decision of this project.

We test:
1. Stats computation accuracy
2. Edge cases (empty logs, no errors, all errors)
3. AI context building (token budget respected)
4. Severity derivation fallback
"""
import pytest
from app.services.preprocessor import compute_stats, build_ai_context
from app.services.analyzer import _severity_from_stats
from app.models.schemas import LogStats


# ── Fixtures ──────────────────────────────────────────────────────────────────

SAMPLE_LOGS_MIXED = """\
2024-01-15 10:00:01 INFO  api-gateway — Request received trace_id=abc-123
2024-01-15 10:00:01 INFO  auth-service — Token validated trace_id=abc-123
2024-01-15 10:00:02 ERROR api-gateway — Database connection timeout trace_id=abc-123
2024-01-15 10:00:02 ERROR api-gateway — Failed to process request: connection refused trace_id=abc-123
2024-01-15 10:00:03 WARNING api-gateway — Retry attempt 1/3 trace_id=abc-123
2024-01-15 10:00:04 ERROR api-gateway — Max retries exceeded trace_id=abc-123
2024-01-15 10:00:05 INFO  api-gateway — Circuit breaker opened
"""

SAMPLE_LOGS_ALL_INFO = """\
2024-01-15 10:00:01 INFO service-a — Started
2024-01-15 10:00:02 INFO service-a — Health check OK
2024-01-15 10:00:03 INFO service-a — Processing request
"""

SAMPLE_LOGS_ALL_ERRORS = """\
2024-01-15 10:00:01 ERROR payment-service — Stripe API timeout
2024-01-15 10:00:02 CRITICAL payment-service — Transaction failed: insufficient funds
2024-01-15 10:00:03 ERROR payment-service — Rollback failed
"""


# ── Stats tests ───────────────────────────────────────────────────────────────

def test_stats_counts_levels_correctly():
    stats = compute_stats(SAMPLE_LOGS_MIXED)
    assert stats.total_lines == 7
    assert stats.error_count == 3
    assert stats.warning_count == 1
    assert stats.info_count == 3


def test_stats_error_rate_calculation():
    stats = compute_stats(SAMPLE_LOGS_MIXED)
    # 3 errors / 7 total = 42.86%
    assert abs(stats.error_rate_percent - 42.86) < 0.1


def test_stats_extracts_trace_ids():
    stats = compute_stats(SAMPLE_LOGS_MIXED)
    assert stats.unique_trace_ids == 1  # abc-123 appears multiple times but deduped


def test_stats_no_errors_returns_zero_error_rate():
    stats = compute_stats(SAMPLE_LOGS_ALL_INFO)
    assert stats.error_count == 0
    assert stats.error_rate_percent == 0.0


def test_stats_all_errors():
    stats = compute_stats(SAMPLE_LOGS_ALL_ERRORS)
    assert stats.error_count == 3
    assert stats.error_rate_percent == 100.0


def test_stats_extracts_top_error_messages():
    stats = compute_stats(SAMPLE_LOGS_MIXED)
    assert len(stats.top_error_messages) > 0
    # Error messages should be non-empty strings
    for msg in stats.top_error_messages:
        assert len(msg) > 5


def test_stats_computes_time_range():
    stats = compute_stats(SAMPLE_LOGS_MIXED)
    # Logs span from 10:00:01 to 10:00:05 = 4 seconds
    assert stats.time_range_seconds == pytest.approx(4.0, abs=1.0)


def test_stats_no_time_range_for_single_timestamp():
    single = "2024-01-15 10:00:01 ERROR svc — Something failed"
    stats = compute_stats(single + "\n" + single)
    # Two lines, same timestamp — range is 0 or very small
    assert stats.time_range_seconds is not None
    assert stats.time_range_seconds == pytest.approx(0.0, abs=1.0)


# ── AI context tests ──────────────────────────────────────────────────────────

def test_ai_context_respects_line_budget():
    # Generate 200 log lines
    big_log = "\n".join(
        [f"2024-01-15 10:00:0{i%10} INFO svc — Line {i}" for i in range(200)]
        + [f"2024-01-15 10:00:01 ERROR svc — Failed on line {i}" for i in range(20)]
    )
    stats = compute_stats(big_log)
    context = build_ai_context(big_log, stats, max_sample_lines=40)
    sample_section = context.split("=== LOG SAMPLE")[1]
    sample_lines = [l for l in sample_section.splitlines() if l.strip() and "===" not in l]
    assert len(sample_lines) <= 40


def test_ai_context_prioritizes_error_lines():
    stats = compute_stats(SAMPLE_LOGS_MIXED)
    context = build_ai_context(SAMPLE_LOGS_MIXED, stats, max_sample_lines=10)
    # All 3 error lines should appear in the sample
    assert "ERROR" in context
    error_lines = [l for l in context.splitlines() if "ERROR" in l]
    assert len(error_lines) >= 3


def test_ai_context_includes_stats_section():
    stats = compute_stats(SAMPLE_LOGS_MIXED)
    context = build_ai_context(SAMPLE_LOGS_MIXED, stats)
    assert "LOG STATISTICS" in context
    assert "Error rate:" in context
    assert str(stats.total_lines) in context


# ── Fallback severity tests ───────────────────────────────────────────────────

@pytest.mark.parametrize("error_rate,expected_severity", [
    (0.0,  "low"),
    (5.0,  "low"),
    (10.0, "medium"),
    (24.9, "medium"),
    (25.0, "high"),
    (49.9, "high"),
    (50.0, "critical"),
    (99.0, "critical"),
])
def test_fallback_severity_thresholds(error_rate, expected_severity):
    stats = LogStats(
        total_lines=100,
        error_count=int(error_rate),
        warning_count=0,
        info_count=100 - int(error_rate),
        error_rate_percent=error_rate,
        unique_trace_ids=0,
        top_error_messages=[],
    )
    severity = _severity_from_stats(stats)
    assert severity.value == expected_severity


# ── Input validation tests ────────────────────────────────────────────────────

def test_single_line_log_raises():
    from pydantic import ValidationError
    from app.models.schemas import LogSubmission
    with pytest.raises(ValidationError):
        LogSubmission(content="just one line here without newline")


def test_empty_log_raises():
    from pydantic import ValidationError
    from app.models.schemas import LogSubmission
    with pytest.raises(ValidationError):
        LogSubmission(content="")


def test_valid_submission_passes():
    from app.models.schemas import LogSubmission
    sub = LogSubmission(
        content="2024-01-15 10:00:01 ERROR svc — Failed\n2024-01-15 10:00:02 INFO svc — OK",
        service_name="my-service",
    )
    assert sub.service_name == "my-service"
