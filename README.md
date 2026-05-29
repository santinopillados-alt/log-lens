# Log-Lens

**AI-powered root cause analysis for production logs.**

Small teams without Datadog or Splunk budgets spend hours grepping through logs when something breaks at 2am. Log-Lens solves that: paste your logs, get a structured diagnosis in under 10 seconds.

→ **[Live demo](https://log-lens.vercel.app)** · [Backend API docs](https://log-lens-api.railway.app/docs)

![CI](https://github.com/santinopillados-alt/log-lens/actions/workflows/ci.yml/badge.svg)

---

## The Business Problem

Log analysis is a solved problem — if you have $$$. Datadog starts at $15/host/month. Splunk requires a dedicated team to operate. New Relic charges per GB ingested.

For a 5-person startup burning through runway, those tools are inaccessible. The alternative is `grep`, `awk`, and gut feeling. **Log-Lens is the middle ground**: open-source, self-hostable, and backed by a real AI model.

---

## Architecture

```
User pastes logs
       │
       ▼
┌─────────────────────────────────┐
│  FastAPI  (validation layer)    │  ← Pydantic rejects malformed input here
│  Pydantic schema enforcement    │    before any processing happens
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│  Preprocessor  (Python, local)  │  ← No AI cost. Pure computation.
│  • Parse log levels with regex  │    Groups by trace_id, computes stats,
│  • Extract trace IDs            │    builds a curated context string.
│  • Compute error rate & stats   │    Reduces token usage ~70%.
│  • Select representative sample │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│  Anthropic Claude API           │  ← Receives stats + 40-line sample,
│  (claude-sonnet)                │    NOT the full log dump.
│  Retry: 1 automatic on 5xx      │    Returns structured JSON diagnosis.
│  Fallback: stats-only result    │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│  PostgreSQL                     │  ← Stores every analysis.
│  asyncpg connection pool        │    Indexed for history queries.
│  Schema auto-created on startup │    Raw SQL — no ORM abstraction.
└────────────────┬────────────────┘
                 │
                 ▼
         JSON response
         to React frontend
```

---

## Key Engineering Decisions

### Why pre-process before sending to AI?

Sending raw logs to an LLM is expensive and produces worse results. A 1,000-line log dump at GPT-4 prices costs ~$0.03 per analysis and buries the signal in noise.

The preprocessor runs entirely in Python with no external calls:
1. Groups log lines around `trace_id` so the AI sees coherent request flows
2. Computes statistical metrics (error rate, level distribution, time range)
3. Selects up to 40 lines, prioritizing ERROR/CRITICAL lines + surrounding context
4. Sends the AI: `stats summary + curated sample` instead of the raw dump

Result: **~70% fewer tokens used, better AI accuracy** (coherent traces > random fragments).

### What happens if the AI call fails?

Three-layer defense — the system **never returns a 500 to the user** for an AI failure:

1. **Timeout**: hard 30-second limit. A slow AI response is worse UX than a fast fallback.
2. **Retry**: one automatic retry on `5xx` or timeout errors (the prompt is idempotent).
3. **Fallback**: if both attempts fail, the endpoint returns a stats-only result with severity derived from the error rate. The user still gets value — they see error counts, trace IDs, and top error messages — even when the AI is down.

### Why raw SQL instead of an ORM?

This project is a portfolio piece demonstrating SQL competency. Every query in `database.py` is readable without framework knowledge. A reviewer can audit `GROUP BY`, `ON CONFLICT`, and index usage directly.

At this scale (< 100k rows), the performance difference between asyncpg raw SQL and SQLAlchemy async is irrelevant. The readability benefit is real.

### Trade-off: regex parsing vs. a dedicated log parser

We use regex-based level/trace extraction intentionally. A strict log parser (like `python-logparse`) would reject ~40% of real-world logs due to inconsistent formatting. Regex is more forgiving at the cost of occasional misclassification — acceptable for an analysis tool where false negatives cost less than rejected inputs.

---

## What Happens When It Fails? (Failure Scenarios)

| Failure | Behavior |
|---|---|
| AI timeout (> 30s) | Automatic retry once, then stats-based fallback result |
| AI 5xx error | Same as timeout |
| AI auth error | Immediate fallback (retrying won't help) |
| Database write fails | Logged as warning — **does not affect the API response** |
| Database read fails (history) | Returns 500 with error message |
| Malformed log input | 422 Validation Error from Pydantic before any processing |
| Log too short (< 2 lines) | 422 Validation Error with descriptive message |

---

## Local Setup

**Prerequisites**: Docker, Docker Compose, an Anthropic API key.

```bash
git clone https://github.com/santinopillados-alt/log-lens
cd log-lens

cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env

docker compose up --build
```

- Frontend: http://localhost:5173
- Backend API docs: http://localhost:8000/docs

**Run tests:**

```bash
cd backend
pip install -r requirements.txt
pytest tests/ -v
```

---

## Deployment

**Backend → Railway**

1. Create a new Railway project, add a PostgreSQL plugin.
2. Connect the `/backend` directory.
3. Set environment variables: `ANTHROPIC_API_KEY`, `DATABASE_URL` (auto-set by Railway).
4. Railway auto-detects the Dockerfile.

**Frontend → Vercel**

1. Connect the `/frontend` directory.
2. Set `VITE_API_URL` to your Railway backend URL.
3. Vercel auto-detects Vite.

---

## Project Structure

```
log-lens/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app, routes, lifecycle
│   │   ├── models/
│   │   │   └── schemas.py       # Pydantic models — all I/O contracts
│   │   └── services/
│   │       ├── preprocessor.py  # Log parsing, stats, AI context builder
│   │       ├── analyzer.py      # Anthropic API call, retry, fallback
│   │       └── database.py      # asyncpg pool, raw SQL queries
│   ├── tests/
│   │   └── test_preprocessor.py # 15 tests — stats, AI context, fallback
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.jsx              # Main UI — analyze + history tabs
│   │   └── services/api.js      # Fetch wrapper — single source of truth
│   ├── package.json
│   └── Dockerfile
├── .github/workflows/ci.yml     # Lint + test on every push
├── docker-compose.yml           # Local dev environment
└── README.md
```

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Backend framework | FastAPI | Async, auto-generated OpenAPI docs, Pydantic native |
| Validation | Pydantic v2 | Schema enforcement before any business logic runs |
| AI | Anthropic Claude | Structured JSON output, reliable instruction following |
| Database | PostgreSQL 16 | ACID, JSONB for flexible stats storage, raw SQL for visibility |
| DB driver | asyncpg | Fastest async PostgreSQL driver for Python |
| Frontend | React 18 + Vite | No heavy dependencies — native fetch, no Redux |
| CI/CD | GitHub Actions | Lint + tests on every push, Docker build check |
| Deployment | Railway + Vercel | Zero-config, free tier, production-grade |

---

## Author

**Santino Coronel** — self-taught backend engineer, Córdoba, Argentina.

Seeking a junior engineering role in Portugal (available from March 2027, D3 visa).

- GitHub: [santinopillados-alt](https://github.com/santinopillados-alt)
- See also: [ObserveIQ](https://github.com/santinopillados-alt/observeiq) (Kafka observability platform), [Global-Relay Sync](https://github.com/santinopillados-alt/global-relay-sync) (PostgreSQL CDC engine)
