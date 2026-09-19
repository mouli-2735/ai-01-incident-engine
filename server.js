require("dotenv").config();
const express = require("express");
const path = require("path");
const { connectDB } = require("./db");
const { Alert, Incident, AuditLog, PatternMemory } = require("./models");
const { buildPatternKey, serviceFamily, patternLabel } = require("./lib/patternKey");
const { analyzeRootCause } = require("./agents/rootCause");
const { assignPriority } = require("./agents/priority");
const { proposeRecovery } = require("./agents/recovery");
const { startLiveAlertGenerator } = require("./lib/alertGenerator");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ─── Confidence-gated autonomy thresholds ───────────────────────────────
// Analysis stages (Root Cause → Priority) chain automatically once a human
// has manually started the pipeline via "Analyze", as long as confidence
// stays above this bar. Below it, the incident stops and escalates to a
// human rather than guessing forward.
const ANALYSIS_AUTO_CONFIDENCE = 0.6;

// Recovery is different: it always requires human approval by default,
// *unless* both of the following hold — in which case the decision (not the
// execution) can be made automatically, even for P1:
const RECOVERY_AUTO_ROOT_CAUSE_CONFIDENCE = 0.85;
const RECOVERY_AUTO_APPROVAL_RATE = 0.9;
const RECOVERY_AUTO_MIN_HISTORY = 3;

// Shape the frontend already expects: {id, service, severity, message, timestamp}.
function toClientAlert(a) {
  return {
    id: a.alertId,
    service: a.service,
    severity: a.severity,
    message: a.message,
    timestamp: a.timestamp,
  };
}

app.get("/api/alerts", async (req, res) => {
  try {
    const alerts = await Alert.find().sort({ timestamp: 1 }).lean();
    res.json(alerts.map(toClientAlert));
  } catch (err) {
    console.error("GET /api/alerts failed:", err.message);
    res.status(500).json({ error: "Failed to load alerts" });
  }
});

// ─── Correlate Agent ─────────────────────────────────────────────────────
const CLUSTER_DEFS = [
  {
    key: "payments-cluster",
    label: "Payments Path Degradation",
    match: (a) => ["payments-db", "payments-api", "checkout-service"].includes(a.service),
    reason: "Alerts share the payments request path (payments-db → payments-api → checkout-service) and occur within the same 2-minute window.",
  },
  {
    key: "cdn-cluster",
    label: "CDN / Edge Delivery Issue",
    match: (a) => ["cdn-edge", "frontend-web"].includes(a.service),
    reason: "Alerts originate from CDN edge nodes and the frontend that depends on them, clustered within a tight time window.",
  },
  {
    key: "auth-cluster",
    label: "Possible Auth / Credential Anomaly",
    match: (a) => ["auth-service", "user-db"].includes(a.service),
    reason: "Alerts involve authentication, token validation, and unusual database access patterns occurring together.",
  },
];

const OPEN_STATUSES = ["correlated", "analyzed", "prioritized", "awaiting_approval", "escalated"];

async function runCorrelate() {
  const alertDocs = await Alert.find({ status: { $ne: "resolved" } }).lean();
  const byAlertId = new Map(alertDocs.map((d) => [d.alertId, d]));
  const clientAlerts = alertDocs.map(toClientAlert);

  const clusters = CLUSTER_DEFS
    .map((def) => ({
      id: def.key,
      label: def.label,
      reason: def.reason,
      alerts: clientAlerts.filter(def.match),
    }))
    .filter((c) => c.alerts.length > 0);

  const persistedClusters = [];

  for (const cluster of clusters) {
    const docsInCluster = cluster.alerts.map((a) => byAlertId.get(a.id));
    const patternKey = buildPatternKey(docsInCluster);
    const services = [...new Set(docsInCluster.map((d) => d.service))];
    const timestamps = docsInCluster.map((d) => new Date(d.timestamp).getTime());

    const incident = await Incident.findOneAndUpdate(
      { patternKey, status: { $in: OPEN_STATUSES } },
      {
        $set: {
          title: cluster.label,
          services,
          serviceFamily: serviceFamily(services[0]),
          patternKey,
          windowStart: new Date(Math.min(...timestamps)),
          windowEnd: new Date(Math.max(...timestamps)),
          status: "correlated",
          alertCount: docsInCluster.length,
        },
        $addToSet: { alerts: { $each: docsInCluster.map((d) => d._id) } },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await Alert.updateMany(
      { _id: { $in: docsInCluster.map((d) => d._id) } },
      { $set: { status: "correlated", incident: incident._id } }
    );

    await AuditLog.create({
      incident: incident._id,
      actor: "correlate-agent",
      actorType: "agent",
      action: "correlated",
      reasoning: cluster.reason,
      metadata: { alertCount: docsInCluster.length, patternKey },
    });

    persistedClusters.push({
      id: cluster.id,
      label: cluster.label,
      reason: cluster.reason,
      incidentId: incident._id,
      alerts: cluster.alerts,
    });
  }

  const clusteredAlertIds = new Set(clusters.flatMap((c) => c.alerts.map((a) => a.id)));
  const noiseDocs = alertDocs.filter((d) => !clusteredAlertIds.has(d.alertId));

  if (noiseDocs.length) {
    await Alert.updateMany(
      { _id: { $in: noiseDocs.map((d) => d._id) } },
      { $set: { status: "noise", incident: null } }
    );
  }

  return { clusters: persistedClusters, noise: noiseDocs.map(toClientAlert) };
}

// ─── Per-stage runners ───────────────────────────────────────────────────
// Each returns a plain descriptor of what happened so the pipeline driver
// (runPipelineForIncident) can decide whether to keep chaining or escalate.
// Each is also responsible for its own AuditLog entry.

async function runRootCauseStage(incident) {
  const startedAt = Date.now();
  try {
    const rootCause = await analyzeRootCause(incident, incident.alerts);
    incident.rootCause = rootCause;

    await AuditLog.create({
      incident: incident._id,
      actor: "root-cause-agent",
      actorType: "agent",
      action: "root_cause_proposed",
      reasoning: rootCause.summary,
      llmProvider: rootCause.llmProvider,
      llmModel: rootCause.llmModel,
      durationMs: Date.now() - startedAt,
      metadata: { confidence: rootCause.confidence, evidenceCount: rootCause.evidence.length },
    });

    if (rootCause.confidence < ANALYSIS_AUTO_CONFIDENCE) {
      incident.status = "escalated";
      incident.escalation = {
        stage: "root_cause",
        reason: "low_confidence",
        assumption: rootCause.summary,
        method: `Root Cause Agent (${rootCause.llmProvider}) analyzed ${incident.alerts.length} correlated alert(s).`,
        stuckPoint: `Confidence ${Math.round(rootCause.confidence * 100)}% is below the ${Math.round(ANALYSIS_AUTO_CONFIDENCE * 100)}% bar needed to auto-continue to Priority.`,
        confidence: rootCause.confidence,
      };
      await AuditLog.create({
        incident: incident._id,
        actor: "system",
        actorType: "system",
        action: "escalated",
        reasoning: incident.escalation.stuckPoint,
        metadata: { stage: "root_cause" },
      });
      return "escalated";
    }

    incident.status = "analyzed";
    return "continue";
  } catch (err) {
    await AuditLog.create({
      incident: incident._id,
      actor: "root-cause-agent",
      actorType: "agent",
      action: "root_cause_failed",
      reasoning: err.message,
      durationMs: Date.now() - startedAt,
    });
    incident.status = "escalated";
    incident.escalation = {
      stage: "root_cause",
      reason: "agent_error",
      assumption: "No root cause could be determined.",
      method: "Root Cause Agent attempted an LLM-based analysis of the correlated alerts.",
      stuckPoint: err.message,
      confidence: null,
    };
    return "escalated";
  }
}

async function runPriorityStage(incident) {
  const startedAt = Date.now();
  try {
    const result = await assignPriority(incident, incident.alerts);
    incident.priority = result.priority;
    incident.priorityRationale = result.rationale;
    incident.status = "prioritized";

    await AuditLog.create({
      incident: incident._id,
      actor: "priority-agent",
      actorType: "agent",
      action: "priority_assigned",
      reasoning: result.rationale,
      llmProvider: result.llmProvider,
      llmModel: result.llmModel,
      durationMs: Date.now() - startedAt,
      metadata: { priority: result.priority },
    });

    return "continue";
  } catch (err) {
    await AuditLog.create({
      incident: incident._id,
      actor: "priority-agent",
      actorType: "agent",
      action: "priority_failed",
      reasoning: err.message,
      durationMs: Date.now() - startedAt,
    });
    incident.status = "escalated";
    incident.escalation = {
      stage: "priority",
      reason: "agent_error",
      assumption: incident.rootCause?.summary || "Root cause was determined, but priority could not be assigned.",
      method: "Priority Agent attempted to classify urgency from the root cause and alerts.",
      stuckPoint: err.message,
      confidence: null,
    };
    return "escalated";
  }
}

async function runRecoveryStage(incident) {
  const startedAt = Date.now();
  const patternMemory = await PatternMemory.findOne({ patternKey: incident.patternKey });

  try {
    const result = await proposeRecovery(incident, incident.alerts, patternMemory);

    const approvalRate = patternMemory?.approvalRate ?? null;
    const total = (patternMemory?.approvals || 0) + (patternMemory?.rejections || 0);

    const rootCauseConfident = (incident.rootCause?.confidence ?? 0) >= RECOVERY_AUTO_ROOT_CAUSE_CONFIDENCE;
    const patternTrusted = total >= RECOVERY_AUTO_MIN_HISTORY && (approvalRate ?? 0) >= RECOVERY_AUTO_APPROVAL_RATE;
    const autoRunEligible = rootCauseConfident && patternTrusted;

    const autoRunReason = autoRunEligible
      ? `Root cause confidence ${Math.round(incident.rootCause.confidence * 100)}% ≥ ${Math.round(RECOVERY_AUTO_ROOT_CAUSE_CONFIDENCE * 100)}% and pattern approved ${patternMemory.approvals}/${total} (≥ ${Math.round(RECOVERY_AUTO_APPROVAL_RATE * 100)}%, ${RECOVERY_AUTO_MIN_HISTORY}+ prior decisions) — qualifies for auto-run even at ${incident.priority}.`
      : !rootCauseConfident
        ? `Root cause confidence ${Math.round((incident.rootCause?.confidence ?? 0) * 100)}% is below the ${Math.round(RECOVERY_AUTO_ROOT_CAUSE_CONFIDENCE * 100)}% bar required for auto-run.`
        : total < RECOVERY_AUTO_MIN_HISTORY
          ? `Pattern Memory has only ${total} prior decision(s) — needs ${RECOVERY_AUTO_MIN_HISTORY}+ to be trusted for auto-run.`
          : `Pattern Memory approval rate ${Math.round((approvalRate ?? 0) * 100)}% is below the ${Math.round(RECOVERY_AUTO_APPROVAL_RATE * 100)}% bar required for auto-run.`;

    incident.recovery = {
      action: result.action,
      command: result.command,
      rationale: result.rationale,
      riskLevel: result.riskLevel,
      requiresApproval: true, // the *executing* is always human; this only governs the decision step
      llmProvider: result.llmProvider,
      llmModel: result.llmModel,
      proposedAt: new Date(),
      autoRunEligible,
      autoRunReason,
      decision: "pending",
    };
    incident.patternSnapshot = {
      approvals: patternMemory?.approvals || 0,
      rejections: patternMemory?.rejections || 0,
      lastDecision: patternMemory?.lastDecision || null,
      approvalRate,
    };

    await AuditLog.create({
      incident: incident._id,
      actor: "recovery-agent",
      actorType: "agent",
      action: "recovery_proposed",
      reasoning: result.rationale,
      llmProvider: result.llmProvider,
      llmModel: result.llmModel,
      durationMs: Date.now() - startedAt,
      metadata: {
        riskLevel: result.riskLevel,
        priority: incident.priority,
        autoRunEligible,
        patternApprovals: patternMemory?.approvals || 0,
        patternRejections: patternMemory?.rejections || 0,
      },
    });

    if (autoRunEligible) {
      incident.recovery.decision = "approved";
      incident.recovery.decidedBy = "system";
      incident.recovery.decidedByType = "system";
      incident.recovery.decidedAt = new Date();
      incident.recovery.decisionNote = autoRunReason;
      incident.status = "approved";

      const pattern = await PatternMemory.record({
        patternKey: incident.patternKey,
        label: patternLabel(incident.services.map((s) => ({ service: s }))),
        decision: "approved",
        decidedBy: "system",
        decidedByType: "system",
        note: autoRunReason,
        incidentId: incident._id,
        action: incident.recovery.action,
      });

      await AuditLog.create({
        incident: incident._id,
        actor: "system",
        actorType: "system",
        action: "auto_approved",
        reasoning: autoRunReason,
        metadata: { action: incident.recovery.action, riskLevel: incident.recovery.riskLevel, priority: incident.priority },
      });

      incident.patternSnapshot = { approvals: pattern.approvals, rejections: pattern.rejections, lastDecision: pattern.lastDecision, approvalRate: pattern.approvalRate };
    } else {
      incident.status = "awaiting_approval";
    }

    return "done";
  } catch (err) {
    await AuditLog.create({
      incident: incident._id,
      actor: "recovery-agent",
      actorType: "agent",
      action: "recovery_failed",
      reasoning: err.message,
      durationMs: Date.now() - startedAt,
    });
    incident.status = "escalated";
    incident.escalation = {
      stage: "recovery",
      reason: "agent_error",
      assumption: incident.priorityRationale || "Priority was assigned, but no recovery action could be proposed.",
      method: "Recovery Agent attempted to propose one concrete action, consulting Pattern Memory.",
      stuckPoint: err.message,
      confidence: null,
    };
    return "escalated";
  }
}

// Drives Root Cause → Priority → Recovery for one incident, stopping the
// moment a stage escalates. Assumes incident.alerts is already populated.
async function runPipelineForIncident(incident) {
  let outcome = await runRootCauseStage(incident);
  await incident.save();
  if (outcome === "escalated") return incident;

  outcome = await runPriorityStage(incident);
  await incident.save();
  if (outcome === "escalated") return incident;

  await runRecoveryStage(incident);
  await incident.save();
  return incident;
}

// ─── /api/analyze — the single manual entry point ───────────────────────
// A human always clicks this to start things off. Correlation itself never
// runs on its own. Once correlation groups the alerts, every resulting
// incident is chained automatically through Root Cause → Priority →
// Recovery, stopping to escalate wherever confidence isn't high enough.
app.post("/api/analyze", async (req, res) => {
  try {
    const { clusters, noise } = await runCorrelate();

    const incidents = await Incident.find({
      _id: { $in: clusters.map((c) => c.incidentId) },
    }).populate("alerts");

    const results = [];
    for (const incident of incidents) {
      await runPipelineForIncident(incident);
      results.push(incident);
    }

    res.json({
      clusters,
      noise,
      incidents: results,
    });
  } catch (err) {
    console.error("POST /api/analyze failed:", err.message);
    res.status(500).json({ error: "Analysis pipeline failed" });
  }
});

// Returns current incidents with alerts populated — used on page load so a
// refresh doesn't lose pipeline state already persisted in Mongo.
app.get("/api/incidents", async (req, res) => {
  try {
    const incidents = await Incident.find({ status: { $ne: "noise" } })
      .populate("alerts")
      .sort({ createdAt: 1 })
      .lean();
    res.json(incidents);
  } catch (err) {
    console.error("GET /api/incidents failed:", err.message);
    res.status(500).json({ error: "Failed to load incidents" });
  }
});

// ─── Human Approval Gate ─────────────────────────────────────────────────
// The one place a recovery action that DIDN'T auto-qualify gets decided by a
// person. Auto-approved incidents skip this route entirely (see
// runRecoveryStage), but even those still require a human to actually carry
// out the fix — approval/auto-approval is a decision, never an execution.
app.post("/api/incidents/:id/decision", async (req, res) => {
  const { decision, decidedBy, note } = req.body || {};

  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
  }

  try {
    const incident = await Incident.findById(req.params.id);
    if (!incident) return res.status(404).json({ error: "Incident not found" });

    if (incident.recovery?.decision !== "pending") {
      return res.status(409).json({
        error: `This incident was already ${incident.recovery?.decision}. Decisions can't be changed once made.`,
      });
    }

    incident.recovery.decision = decision;
    incident.recovery.decidedBy = decidedBy || "unspecified";
    incident.recovery.decidedByType = "human";
    incident.recovery.decidedAt = new Date();
    incident.recovery.decisionNote = note || "";
    incident.status = decision;
    await incident.save();

    const pattern = await PatternMemory.record({
      patternKey: incident.patternKey,
      label: patternLabel(incident.services.map((s) => ({ service: s }))),
      decision,
      decidedBy: decidedBy || "unspecified",
      decidedByType: "human",
      note: note || "",
      incidentId: incident._id,
      action: incident.recovery.action,
    });

    await AuditLog.create({
      incident: incident._id,
      actor: decidedBy || "unspecified",
      actorType: "human",
      action: decision,
      reasoning: note || "",
      metadata: { action: incident.recovery.action, riskLevel: incident.recovery.riskLevel },
    });

    res.json({
      incidentId: incident._id,
      status: incident.status,
      recovery: incident.recovery,
      pattern: { approvals: pattern.approvals, rejections: pattern.rejections, approvalRate: pattern.approvalRate },
    });
  } catch (err) {
    console.error(`POST /api/incidents/${req.params.id}/decision failed:`, err.message);
    res.status(500).json({ error: "Failed to record decision" });
  }
});

// Marks a recovery action as actually carried out. Purely a record-keeping
// step — nothing in this system executes anything; a human does the work
// and then confirms it here.
app.post("/api/incidents/:id/execute", async (req, res) => {
  const { executedBy } = req.body || {};
  try {
    const incident = await Incident.findById(req.params.id);
    if (!incident) return res.status(404).json({ error: "Incident not found" });
    if (incident.recovery?.decision !== "approved") {
      return res.status(409).json({ error: "Only an approved recovery action can be marked executed." });
    }
    if (incident.recovery.executed) {
      return res.status(409).json({ error: "Already marked executed." });
    }

    incident.recovery.executed = true;
    incident.recovery.executedBy = executedBy || "unspecified";
    incident.recovery.executedAt = new Date();
    incident.status = "resolved";
    await incident.save();

    await AuditLog.create({
      incident: incident._id,
      actor: executedBy || "unspecified",
      actorType: "human",
      action: "executed",
      reasoning: `Manually carried out: ${incident.recovery.action}`,
      metadata: { action: incident.recovery.action },
    });

    res.json({ incidentId: incident._id, status: incident.status, recovery: incident.recovery });
  } catch (err) {
    console.error(`POST /api/incidents/${req.params.id}/execute failed:`, err.message);
    res.status(500).json({ error: "Failed to record execution" });
  }
});

// ─── Escalation resolution ───────────────────────────────────────────────
// A human supplies the missing diagnosis/decision for a stage the pipeline
// couldn't confidently resolve on its own. Logged to the Audit Trail AND to
// Pattern Memory as a diagnosis correction, then the pipeline resumes.
app.post("/api/incidents/:id/escalation-response", async (req, res) => {
  const { suggestion, submittedBy } = req.body || {};
  if (!suggestion || !suggestion.trim()) {
    return res.status(400).json({ error: "suggestion is required" });
  }

  try {
    const incident = await Incident.findById(req.params.id).populate("alerts");
    if (!incident) return res.status(404).json({ error: "Incident not found" });
    if (incident.status !== "escalated" || !incident.escalation) {
      return res.status(409).json({ error: "This incident is not currently escalated." });
    }

    const stage = incident.escalation.stage;
    const who = submittedBy || "unspecified";

    await PatternMemory.recordDiagnosis({
      patternKey: incident.patternKey,
      label: patternLabel(incident.services.map((s) => ({ service: s }))),
      stage,
      suggestion,
      submittedBy: who,
      incidentId: incident._id,
    });

    await AuditLog.create({
      incident: incident._id,
      actor: who,
      actorType: "human",
      action: "diagnosis_submitted",
      reasoning: suggestion,
      metadata: { stage },
    });

    incident.escalation.humanSuggestion = suggestion;
    incident.escalation.humanSuggestedBy = who;
    incident.escalation.resolvedAt = new Date();

    // Fold the human's input back into the pipeline and resume from here.
    if (stage === "root_cause") {
      incident.rootCause = {
        summary: suggestion,
        evidence: incident.rootCause?.evidence || [],
        confidence: 1,
        llmProvider: "human",
        llmModel: null,
        generatedAt: new Date(),
      };
      incident.status = "analyzed";
      incident.escalation = null;

      let outcome = await runPriorityStage(incident);
      await incident.save();
      if (outcome !== "escalated") {
        await runRecoveryStage(incident);
        await incident.save();
      }
    } else if (stage === "priority") {
      const match = /P[123]/i.exec(suggestion);
      incident.priority = match ? match[0].toUpperCase() : "P2";
      incident.priorityRationale = `Set by human (${who}) after Priority Agent could not resolve: "${suggestion}"`;
      incident.status = "prioritized";
      incident.escalation = null;

      await runRecoveryStage(incident);
      await incident.save();
    } else if (stage === "recovery") {
      // Human-authored recovery proposals always require human approval —
      // never eligible for auto-run.
      incident.recovery = {
        action: suggestion,
        command: "",
        rationale: `Proposed by human (${who}) after Recovery Agent could not resolve.`,
        riskLevel: "medium",
        requiresApproval: true,
        llmProvider: "human",
        llmModel: null,
        proposedAt: new Date(),
        autoRunEligible: false,
        autoRunReason: "Human-authored proposals always require human approval.",
        decision: "pending",
      };
      incident.status = "awaiting_approval";
      incident.escalation = null;
      await incident.save();
    }

    res.json({ incidentId: incident._id, incident });
  } catch (err) {
    console.error(`POST /api/incidents/${req.params.id}/escalation-response failed:`, err.message);
    res.status(500).json({ error: "Failed to record escalation response" });
  }
});

// ─── Pattern Memory dashboard ────────────────────────────────────────────
app.get("/api/patterns", async (req, res) => {
  try {
    const patterns = await PatternMemory.find().sort({ updatedAt: -1 }).lean({ virtuals: true });
    res.json(patterns);
  } catch (err) {
    console.error("GET /api/patterns failed:", err.message);
    res.status(500).json({ error: "Failed to load pattern memory" });
  }
});

// ─── Audit Trail ──────────────────────────────────────────────────────────
app.get("/api/audit", async (req, res) => {
  try {
    const logs = await AuditLog.find()
      .sort({ timestamp: -1 })
      .limit(100)
      .populate("incident", "title")
      .lean();
    res.json(logs);
  } catch (err) {
    console.error("GET /api/audit failed:", err.message);
    res.status(500).json({ error: "Failed to load audit trail" });
  }
});

// Live alert generation: simulates a real monitoring feed by writing a new
// Alert doc every LIVE_ALERTS_INTERVAL_MS. Disable with LIVE_ALERTS=false
// (e.g. while stepping through a fixed seeded scenario for a demo run).
const LIVE_ALERTS_ENABLED = process.env.LIVE_ALERTS !== "false";
const LIVE_ALERTS_INTERVAL_MS = Number(process.env.LIVE_ALERTS_INTERVAL_MS) || 8000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`AI-01 incident engine running at http://localhost:${PORT}`);
      if (LIVE_ALERTS_ENABLED) {
        startLiveAlertGenerator(LIVE_ALERTS_INTERVAL_MS);
      }
    });
  })
  .catch((err) => {
    console.error("Startup failed — could not connect to MongoDB:", err.message);
    process.exit(1);
  });
