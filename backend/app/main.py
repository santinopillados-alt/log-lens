"""
Log-Lens API — main application entry point.
"""
import logging
import os
import time
import uuid
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from app.models.schemas import AnalysisRecord, AnalysisResult, LogSubmission
from app.services import analyzer, database
from app.services.preprocessor import build_ai_context, compute_stats

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Log-Lens API",
    description="AI-powered log analysis for teams that can't afford Datadog.",
    version="1.0.0",
    docs_url="/docs",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


# ── Lifecycle ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup() -> None:
    await database.init_pool()
    logger.info("Log-Lens API started.")


@app.on_event("shutdown")
async def shutdown() -> None:
    await database.close_pool()


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    """Railway health check endpoint."""
    return {"status": "ok", "version": "1.0.0"}


@app.post("/api/analyze", response_model=AnalysisResult, status_code=201)
async def analyze_logs(payload: LogSubmission) -> AnalysisResult:
    """
    Submit logs for AI analysis.

    Flow:
    1. Validate input (Pydantic, automatic)
    2. Compute stats locally (no AI cost)
    3. Build a curated context string for the AI
    4. Call AI with retry + fallback
    5. Persist result to PostgreSQL
    6. Return full result to client

    The AI call failing does NOT return a 500 — see analyzer.py for fallback logic.
    """
    start_time = time.time()
    analysis_id = str(uuid.uuid4())

    # Step 2-3: local processing
    stats = compute_stats(payload.content)
    ai_context = build_ai_context(payload.content, stats)

    # Step 4: AI call (never raises)
    result = analyzer.analyze(
        analysis_id=analysis_id,
        service_name=payload.service_name or "unknown",
        ai_context=ai_context,
        stats=stats,
        start_time=start_time,
    )

    # Step 5: persist (non-blocking — failure here doesn't affect response)
    try:
        await database.save_analysis(result)
    except Exception as e:
        logger.error("Failed to persist analysis %s: %s", analysis_id, e)

    return result


@app.get("/api/history", response_model=list[AnalysisRecord])
async def get_history(
    limit: int = Query(default=20, ge=1, le=100),
    service_name: Optional[str] = Query(default=None),
    severity: Optional[str] = Query(default=None),
) -> list[AnalysisRecord]:
    """Return recent analyses with optional filters."""
    try:
        return await database.get_history(
            limit=limit,
            service_name=service_name,
            severity=severity,
        )
    except Exception as e:
        logger.error("History query failed: %s", e)
        raise HTTPException(status_code=500, detail="Could not retrieve history.")


@app.get("/api/analysis/{analysis_id}")
async def get_analysis(analysis_id: str) -> dict:
    """Retrieve a single analysis by ID."""
    row = await database.get_analysis_by_id(analysis_id)
    if not row:
        raise HTTPException(status_code=404, detail="Analysis not found.")
    return row


@app.delete("/api/history", status_code=204)
async def clear_history() -> None:
    """Clear all analyses. Useful for demo resets."""
    pool = database.get_pool()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM analyses")
