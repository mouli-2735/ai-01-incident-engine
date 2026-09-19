# AI-01 — Autonomous Enterprise Incident Resolution Engine

**IGNITRRON'26 — Project J.A.R.V.I.S.**

Raw, noisy alerts go in. A chain of agents correlates them, proposes a
cause, assigns urgency, and recommends a recovery action. A human always
starts the process, and a human always carries out the fix — but the
analysis stages in between can chain on their own when the system is
confident, and pause to ask for help the moment it isn't. Every decision,
agent, system, or human, is written to an append-only audit trail. Every
recovery decision also updates **Pattern Memory**, so the system remembers
how humans have handled this exact kind of problem before.

## Pipeline

```
Human clicks "Analyze"          the only place the pipeline ever starts
   │
   ▼
Correlate Agent          groups raw alerts into incident clusters (rule-based)
   │
   ▼
Root Cause Agent          LLM: proposes a likely cause + evidence + confidence
   │  confidence ≥ 60% ──────────────────────────────┐
   │  confidence < 60% → ESCALATED TO HUMAN            │
   ▼                                                    │
Priority Agent            LLM: assigns P1 / P2 / P3    │
   │  succeeds ─────────────────────────────────────────┤
   │  agent error → ESCALATED TO HUMAN                  │
   ▼                                                    │
Recovery Agent            LLM: proposes one concrete action, consults Pattern Memory
   │  agent error → ESCALATED TO HUMAN
   ▼
Confidence-gated decision
   │  root-cause confidence ≥ 85% AND pattern approval rate ≥ 90% (3+ prior decisions)
   │      → AUTO-APPROVED BY SYSTEM, even for P1
   │  otherwise
   │      → AWAITING APPROVAL — a human decides
   ▼
A human executes the fix       decision ≠ execution, always, even when auto-approved
   │
   ▼
Audit Trail                every step above, logged, append-only
```

LLM calls (Root Cause, Priority, Recovery) go through a single fallback
chain — **Groq → OpenRouter → Gemini** — so one provider being down or
rate-limited doesn't stop the pipeline; it just uses the next one and logs
which provider actually answered.

## Confidence-gated autonomy — what's automatic, what isn't

- **Starting the pipeline is always manual.** Nothing analyzes on page load
  or in the background. A human has to click "Analyze."
- **Correlate → Root Cause → Priority chain automatically** once a human has
  started the run, as long as confidence stays above the bar (Root Cause
  confidence ≥ 60%). Below that bar, the incident stops and **escalates to a
  human** instead of guessing forward.
- **The Recovery decision requires human approval by default — even for
  P1.** The only exception: if root-cause confidence is ≥ 85% *and* Pattern
  Memory shows a ≥ 90% approval rate over 3+ prior decisions for this exact
  pattern, the system can self-approve the decision, priority notwithstanding.
  If either condition isn't met, it pauses and asks a human, regardless of
  priority.
- **Auto-approval is a decision, never an execution.** Even in the high-trust
  auto-approved case, a human still has to click "Mark as executed" after
  actually carrying out the fix. The system never touches production itself
  — there is always a person in the loop at the point of actual change, not
  just at the decision point.

## Escalation — "I couldn't confidently resolve this, here's why"

If Root Cause, Priority, or Recovery can't confidently resolve (low
confidence, or an LLM/agent failure), the incident enters an **Escalated to
Human** state showing:

- what the agent assumed so far,
- what method/approach it tried,
- specifically where it got stuck.

A human can type a suggestion or corrected diagnosis into the incident,
which is logged to the Audit Trail **and** to Pattern Memory as a diagnosis
correction — so "the system learns from humans" covers diagnosis
corrections, not just approve/reject decisions. Submitting a suggestion
resumes the pipeline from that stage.

## Novelty: "AI-01 Remembers"

AI-01 keeps a `PatternMemory` record per incident pattern (same services +
same severity class), with its own dashboard tab. Every recovery decision —
human or system auto-approval — is recorded against the pattern, along with
any diagnosis corrections submitted during escalation. The next time the
same kind of incident happens, the Recovery Agent is told the history and
the confidence-gated autonomy logic can use it to decide whether a decision
qualifies for auto-approval.

## Run it locally

```bash
npm install
cp .env.example .env      # fill in MONGODB_URI and at least one LLM key
npm run seed -- --history # loads 15 mock alerts + 2 seeded pattern histories
npm start
```

Open **http://localhost:3000** and click **Analyze**. Watch incidents chain
through Root Cause → Priority → Recovery on their own; expand a card to see
each stage. Anything that couldn't confidently resolve shows up as
"Escalated to Human" with a box to type your own diagnosis. Anything
awaiting approval shows Approve/Reject; anything that cleared the auto-run
bar shows "AUTO-APPROVED BY SYSTEM" instead, with a `Mark as executed`
button once you've actually carried it out. The **Waiting / Approved /
Resolved / Rejected** chips in the top-right corner of the Incidents panel each
open a quick list for that status — click a row to jump to that incident in the
middle of the page. Switch to the **Pattern Memory** tab to watch approval rates
update live as you decide.

## Project structure

```
ai-01-incident-engine/
├── server.js              # Express app — correlate → root cause → priority → recovery pipeline
├── db.js                  # Mongoose connection (local or Atlas via MONGODB_URI)
├── models/
│   ├── Alert.js
│   ├── Incident.js         # rootCause, recovery, escalation, patternSnapshot all live here
│   ├── AuditLog.js         # append-only — no update path exists in the schema
│   └── PatternMemory.js    # one doc per pattern; .record() and .recordDiagnosis() upsert
├── agents/
│   ├── rootCause.js
│   ├── priority.js
│   └── recovery.js         # formerly "remediation"
├── lib/
│   ├── llm.js              # Groq → OpenRouter → Gemini fallback, used by all 3 agents
│   └── patternKey.js       # deterministic pattern key: family::services::severity
├── scripts/
│   └── seed.js             # loads data/alerts.json into Mongo; --reset, --history flags
├── data/
│   └── alerts.json          # 15 mock alerts across 3 clusters + noise
└── public/
    ├── index.html           # Incidents tab + Pattern Memory tab
    ├── style.css             # light, Linear/Notion-inspired
    └── app.js
```

## API reference

| Route | Method | What it does |
|---|---|---|
| `/api/alerts` | GET | All alerts |
| `/api/analyze` | POST | The one manual entry point: correlates, then chains Root Cause → Priority → Recovery per incident, escalating wherever confidence isn't high enough |
| `/api/incidents` | GET | All open incidents with alerts populated (used to survive a page refresh) |
| `/api/incidents/:id/decision` | POST | `{decision: "approved"\|"rejected", decidedBy, note}` — the human approval gate for incidents that didn't auto-qualify |
| `/api/incidents/:id/execute` | POST | `{executedBy}` — marks an approved recovery action as actually carried out by a human |
| `/api/incidents/:id/escalation-response` | POST | `{suggestion, submittedBy}` — human diagnosis/decision that unblocks an escalated incident and resumes the pipeline |
| `/api/patterns` | GET | All Pattern Memory records, for the dashboard tab |
| `/api/audit` | GET | Last 100 audit entries, newest first |

## Testing the LLM fallback chain

Comment out or rename `GROQ_API_KEY` in `.env`, restart the server, and click
Analyze again — the `llmProvider` shown on each card should switch to
`openrouter` (or `gemini` if that's also unset). The Audit Trail entry for
that step records which provider actually answered.

## Known limitations

- Correlation rules are hardcoded service-name matches, not learned —
  intentional for a hackathon timeline; a production version would derive
  clusters from telemetry rather than a static service list.
- Re-running "Analyze" re-clusters from every still-open alert and will
  re-run the pipeline over incidents that are still in an open status
  (including escalated ones), which is useful for demoing repeatedly but
  means an in-progress escalation can get reset if you click Analyze again
  before resolving it.
