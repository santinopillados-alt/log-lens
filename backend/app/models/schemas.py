"""
Pydantic models — request/response contracts for the API.
All validation happens here before touching business logic.
"""
from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field, field_validator


class Severity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class LogSubmission(BaseModel):
    """Raw log input from the user."""
    content: str = Field(..., min_length=10, max_length=50_000)
    service_name: Optional[str] = Field(default="unknown", max_length=100)

    @field_validator("content")
    @classmethod
    def content_must_have_lines(cls, v: str) -> str:
        lines = [line for line in v.strip().splitlines() if line.strip()]
        if len(lines) < 2:
            raise ValueError("Submit at least 2 log lines for meaningful analysis.")
        return v.strip()


class LogStats(BaseModel):
    """Statistical summary computed before sending to AI — reduces token cost ~70%."""
    total_lines: int
    error_count: int
    warning_count: int
    info_count: int
    error_rate_percent: float
    unique_trace_ids: int
    top_error_messages: list[str]
    time_range_seconds: Optional[float] = None


class AnalysisResult(BaseModel):
    """Full analysis result returned to the client."""
    id: str
    service_name: str
    severity: Severity
    root_cause: str
    what_happened: str
    immediate_actions: list[str]
    prevention: list[str]
    stats: LogStats
    tokens_used: int
    created_at: datetime
    processing_ms: int


class AnalysisRecord(BaseModel):
    """Stored record for history endpoint."""
    id: str
    service_name: str
    severity: Severity
    root_cause: str
    created_at: datetime
    error_rate_percent: float
    total_lines: int
