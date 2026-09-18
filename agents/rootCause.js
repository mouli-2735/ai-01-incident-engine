// agents/rootCause.js
// Takes a correlated Incident (with its Alert docs populated) and produces
// the RootCauseSchema shape defined on the Incident model: a plain-language
// summary, a short evidence list citing specific alerts, and a confidence
// score. This is what turns "3 alerts happened together" into "here's
// probably why."

const { callLLM } = require("../lib/llm");

const SYSTEM_PROMPT = `You are a root-cause analysis agent for enterprise incident response.
You receive a correlated group of alerts that an upstream correlation system has
already determined belong to the same incident. Your job is NOT to re-decide whether
they're related — assume they are. Your job is to explain the most likely underlying
cause and cite which alerts support that conclusion.

Be specific and technical, not generic. Reference actual services, metrics, or
error patterns from the alerts. If the evidence is ambiguous, say so honestly and
lower your confidence rather than inventing certainty.

Respond with ONLY valid JSON, no markdown fences, no text outside the JSON, in this
exact shape:
{
  "summary": "one to two sentence explanation of the likely root cause",
  "evidence": ["short evidence line citing alert 1", "short evidence line citing alert 2"],
  "confidence": 0.0
}
"confidence" must be a number between 0 and 1 (e.g. 0.8), not a word.`;

function buildUserPrompt(incident, alerts) {
  const alertLines = alerts
    .map(
      (a) =>
        `- [${a.alertId}] ${a.service} (${a.severity}) @ ${new Date(a.timestamp).toISOString()}: ${a.message}`
    )
    .join("\n");

  return `Incident: ${incident.title}
Services involved: ${incident.services.join(", ")}
Correlation window: ${incident.windowStart?.toISOString()} to ${incident.windowEnd?.toISOString()}

Alerts in this incident:
${alertLines}`;
}

/**
 * Runs root-cause analysis on one incident.
 * @param {object} incident - Incident document (services, title, windowStart/End)
 * @param {Array} alerts - the Alert documents belonging to this incident
 * @returns {{ summary, evidence, confidence, llmProvider, llmModel, generatedAt }}
 */
async function analyzeRootCause(incident, alerts) {
  const userPrompt = buildUserPrompt(incident, alerts);

  const { data, provider, model } = await callLLM(SYSTEM_PROMPT, userPrompt, true);

  if (typeof data.summary !== "string" || !Array.isArray(data.evidence)) {
    throw new Error("Root cause agent got malformed response shape from LLM");
  }

  return {
    summary: data.summary,
    evidence: data.evidence,
    confidence: typeof data.confidence === "number" ? data.confidence : 0.5,
    llmProvider: provider,
    llmModel: model,
    generatedAt: new Date(),
  };
}

module.exports = { analyzeRootCause };
