// agents/remediation.js
// Takes an incident that already has root cause + priority and proposes one
// concrete remediation action. This is also where "AI-01 Remembers" enters
// the reasoning: if this exact pattern has a decision history, the agent is
// told about it and may reference it in its rationale — but the history is
// advisory only. It never changes whether human approval is required; that
// decision is made by the route, not the LLM, and P1 always requires it.

const { callLLM } = require("../lib/llm");

const SYSTEM_PROMPT = `You are a remediation planning agent for enterprise incident response.
You receive an incident with a confirmed root cause, an assigned priority, and
(if available) a history of how humans have decided on this exact pattern before.

Propose exactly ONE concrete remediation action — not "investigate further" or
"monitor the situation." Base it specifically on the stated root cause.

If prior decision history is provided, you may reference it in your rationale
(e.g. "this matches a pattern approved 4/4 times before"), but do not let it
change what action you propose — propose the correct fix regardless of history.

riskLevel reflects how disruptive the ACTION ITSELF is if executed (e.g. restarting
a service is usually low/medium; dropping data or a full rollback is high) — it is
independent of the incident's priority.

Respond with ONLY valid JSON, no markdown fences, no text outside the JSON, in this
exact shape:
{
  "action": "short human-readable action, e.g. Restart payments-db connection pool",
  "command": "the concrete command or step that would run",
  "rationale": "one to two sentences justifying this specific action",
  "riskLevel": "low"
}
"riskLevel" must be exactly one of "low", "medium", "high".`;

function buildUserPrompt(incident, alerts, patternMemory) {
  const alertLines = alerts
    .map((a) => `- [${a.alertId}] ${a.service} (${a.severity}): ${a.message}`)
    .join("\n");

  const rc = incident.rootCause || {};

  const historyBlock = patternMemory
    ? `This pattern has occurred before: approved ${patternMemory.approvals} time(s), ` +
      `rejected ${patternMemory.rejections} time(s). Last decision: ${patternMemory.lastDecision || "none"}.` +
      (patternMemory.lastApprovedAction
        ? ` The action approved last time was: "${patternMemory.lastApprovedAction}".`
        : "")
    : "No prior history for this pattern — this is the first time it has occurred.";

  return `Incident: ${incident.title}
Priority: ${incident.priority || "unknown"}
Services involved: ${incident.services.join(", ")}

Root cause (confidence ${rc.confidence ?? "unknown"}):
${rc.summary || "not yet determined"}

Pattern history:
${historyBlock}

Alerts:
${alertLines}`;
}

const VALID_RISK_LEVELS = ["low", "medium", "high"];

/**
 * Proposes remediation for one incident.
 * @param {object} incident - Incident document, expects rootCause + priority populated
 * @param {Array} alerts - the Alert documents belonging to this incident
 * @param {object|null} patternMemory - PatternMemory document for incident.patternKey, or null
 * @returns {{ action, command, rationale, riskLevel, llmProvider, llmModel }}
 */
async function proposeRemediation(incident, alerts, patternMemory) {
  const userPrompt = buildUserPrompt(incident, alerts, patternMemory);

  const { data, provider, model } = await callLLM(SYSTEM_PROMPT, userPrompt, true);

  if (typeof data.action !== "string" || !data.action.trim()) {
    throw new Error("Remediation agent got malformed response shape from LLM");
  }

  return {
    action: data.action,
    command: typeof data.command === "string" ? data.command : "",
    rationale: typeof data.rationale === "string" ? data.rationale : "",
    riskLevel: VALID_RISK_LEVELS.includes(data.riskLevel) ? data.riskLevel : "medium",
    llmProvider: provider,
    llmModel: model,
  };
}

module.exports = { proposeRemediation };
