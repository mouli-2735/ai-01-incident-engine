// agents/priority.js
// Takes an incident that already has a root cause proposed and assigns a
// priority of P1/P2/P3. Runs after Root Cause so the agent has more than
// raw alerts to reason from — a plausible cause and a confidence score
// change how urgent an incident actually is, not just which services it hit.

const { callLLM } = require("../lib/llm");

const VALID_PRIORITIES = ["P1", "P2", "P3"];

const SYSTEM_PROMPT = `You are a priority classification agent for enterprise incident response.
You receive a correlated incident, its alerts, and a proposed root cause. Assign
exactly one priority level:

P1 — critical. Active, broad customer or revenue impact (e.g. payments, checkout,
     or auth fully degraded for most/all users). Needs immediate escalation.
P2 — degraded. Partial impact — a subset of users, a non-critical path, or a
     critical path in early/contained degradation.
P3 — low. Cosmetic, internal-only, or already self-recovering with no meaningful
     user impact.

Weigh: which services are affected and their business criticality, alert severity
and count, and the root cause's confidence and summary. A low-confidence root cause
does not by itself justify a lower priority — an incident can be both severe and
poorly understood; when unsure between two levels, prefer the more urgent one.

Respond with ONLY valid JSON, no markdown fences, no text outside the JSON, in this
exact shape:
{
  "priority": "P1",
  "rationale": "one sentence justification referencing specific evidence"
}
"priority" must be exactly one of "P1", "P2", "P3".`;

function buildUserPrompt(incident, alerts) {
  const alertLines = alerts
    .map((a) => `- [${a.alertId}] ${a.service} (${a.severity}): ${a.message}`)
    .join("\n");

  const rc = incident.rootCause || {};

  return `Incident: ${incident.title}
Services involved: ${incident.services.join(", ")}
Alert count: ${alerts.length}

Root cause (confidence ${rc.confidence ?? "unknown"}):
${rc.summary || "not yet determined"}

Alerts:
${alertLines}`;
}

/**
 * Assigns priority to one incident.
 * @param {object} incident - Incident document, expects rootCause populated
 * @param {Array} alerts - the Alert documents belonging to this incident
 * @returns {{ priority, rationale, llmProvider, llmModel }}
 */
async function assignPriority(incident, alerts) {
  const userPrompt = buildUserPrompt(incident, alerts);

  const { data, provider, model } = await callLLM(SYSTEM_PROMPT, userPrompt, true);

  if (!VALID_PRIORITIES.includes(data.priority)) {
    throw new Error(`Priority agent returned invalid priority: ${JSON.stringify(data.priority)}`);
  }

  return {
    priority: data.priority,
    rationale: typeof data.rationale === "string" ? data.rationale : "",
    llmProvider: provider,
    llmModel: model,
  };
}

module.exports = { assignPriority, VALID_PRIORITIES };
