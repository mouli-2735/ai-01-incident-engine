# AI-01 — Autonomous Enterprise Incident Resolution Engine

**IGNITRRON'26 — Project J.A.R.V.I.S.**

Raw, noisy alerts go in. A chain of five agents correlates them, proposes a
cause, assigns urgency, and recommends a fix — but nothing ever executes
without a human approving it first. Every decision, agent or human, is
written to an append-only audit trail. Every remediation decision also
updates **Pattern Memory**, so the system remembers how humans have handled
this exact kind of problem before — without ever using that memory to skip
the approval step itself.

## Pipeline

```
Alert Feed
   │
   ▼
Correlate Agent        groups raw alerts into incident clusters (rule-based)
   │
   ▼
Root Cause Agent        LLM: proposes a likely cause + evidence + confidence
   │
   ▼
Priority Agent           LLM: assigns P1 / P2 / P3
   │
   ▼
Remediation Agent        LLM: proposes one concrete action, consults Pattern Memory
   │
   ▼
Human Approval Gate      a person approves or rejects — the only place anything is decided
   │
   ▼
Audit Trail              every step above, logged, append-only
```

LLM calls (Root Cause, Priority, Remediation) go through a single fallback
chain — **Groq → OpenRouter → Gemini** — so one provider being down or
rate-limited doesn't stop the pipeline; it just uses the next one and logs
which provider actually answered.

## Novelty: "AI-01 Remembers"

Most incident tools are stateless — they treat every alert as if it's never
been seen before. AI-01 keeps a `PatternMemory` record per incident pattern
(same services + same severity class). Every time a human approves or
rejects a proposed remediation, that decision is recorded against the
pattern. The next time the same kind of incident happens, the Remediation
Agent is told the history ("approved 4/4 times previously") and the human
approver sees it too.

This is deliberately **advisory only**. The system can surface confidence
from past decisions; it never uses that confidence to skip or auto-approve
anything. `requiresApproval` is hardcoded `true` for every incident,
regardless of pattern history or priority — a human decides every time.

## Run it locally

```bash
npm install
cp .env.example .env      # fill in MONGODB_URI and at least one LLM key
npm run seed -- --history # loads 15 mock alerts + 2 seeded pattern histories
npm start
```

Open **http://localhost:3000**, then click through in order:
**Analyze → Find Root Cause → Assign Priority → Propose Remediation →
Approve/Reject** on each incident card. The Audit Trail panel at the bottom
updates after every action.

## Project structure

```
ai-01-incident-engine/
├── server.js              # Express app — all routes for the pipeline above
├── db.js                  # Mongoose connection (local or Atlas via MONGODB_URI)
├── models/
│   ├── Alert.js
│   ├── Incident.js         # rootCause, priority, remediation, patternSnapshot all live here
│   ├── AuditLog.js         # append-only — no update path exists in the schema
│   └── PatternMemory.js    # one doc per pattern; .record() upserts a decision
├── agents/
│   ├── rootCause.js
│   ├── priority.js
│   └── remediation.js
├── lib/
│   ├── llm.js              # Groq → OpenRouter → Gemini fallback, used by all 3 agents
│   └── patternKey.js       # deterministic pattern key: family::services::severity
├── scripts/
│   └── seed.js             # loads data/alerts.json into Mongo; --reset, --history flags
├── data/
│   └── alerts.json          # 15 mock alerts across 3 clusters + noise
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

## API reference

| Route | Method | What it does |
|---|---|---|
| `/api/alerts` | GET | All alerts |
| `/api/correlate` | POST | Runs Correlate Agent, upserts Incidents (idempotent per patternKey) |
| `/api/incidents` | GET | All open incidents with alerts populated |
| `/api/root-cause` | POST | Runs Root Cause Agent on every `correlated` incident |
| `/api/priority` | POST | Runs Priority Agent on every `analyzed` incident |
| `/api/remediation` | POST | Runs Remediation Agent on every `prioritized` incident; consults Pattern Memory |
| `/api/incidents/:id/decision` | POST | `{decision: "approved"\|"rejected", decidedBy, note}` — the approval gate; updates Pattern Memory |
| `/api/audit` | GET | Last 100 audit entries, newest first |

## Testing the LLM fallback chain

Comment out or rename `GROQ_API_KEY` in `.env`, restart the server, and run
Root Cause / Priority / Remediation again — the `llmProvider` shown on each
card should switch to `openrouter` (or `gemini` if that's also unset). The
Audit Trail entry for that step records which provider actually answered.

## Known limitations

- The dashboard rebuilds its incident cards from the response of each
  action; refreshing the page clears what's on screen (the data itself is
  still safely in Mongo — `GET /api/incidents` can retrieve it).
- Correlation rules are hardcoded service-name matches, not learned —
  intentional for a hackathon timeline; a production version would derive
  clusters from telemetry rather than a static service list.
