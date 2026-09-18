require("dotenv").config();
const express = require("express");
const path = require("path");
const { connectDB } = require("./db");
const { Alert, Incident, AuditLog, PatternMemory } = require("./models");
const { buildPatternKey, serviceFamily, patternLabel } = require("./lib/patternKey");
const { analyzeRootCause } = require("./agents/rootCause");
const { assignPriority } = require("./agents/priority");
const { proposeRemediation } = require("./agents/remediation");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Shape the frontend already expects: {id, service, severity, message, timestamp}.
// Mongo's field is `alertId`, not `id` — this is the only translation needed.
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

// --- Correlate Agent ---
// Same clustering rules as the original mock (shared service-family + time
// proximity), but now the result is persisted: each matched cluster becomes
// (or updates) a real Incident document, its alerts are marked correlated,
// and an AuditLog entry records that the agent made this decision.
//
// Idempotent by design: re-running Analyze upserts the same Incident per
// patternKey rather than creating duplicates, so clicking the button twice
// during a demo doesn't pollute the database.
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

const OPEN_STATUSES = ["correlated", "analyzed", "prioritized", "awaiting_approval"];

app.post("/api/correlate", async (req, res) => {
  try {
    // Re-cluster from every alert that hasn't already been resolved/rejected —
    // this keeps "Analyze" reusable across a demo run without re-including
    // incidents that have already been fully handled.
    const alertDocs = await Alert.find({
      status: { $ne: "resolved" },
    }).lean();

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

    res.json({
      clusters: persistedClusters,
      noise: noiseDocs.map(toClientAlert),
    });
  } catch (err) {
    console.error("POST /api/correlate failed:", err.message);
    res.status(500).json({ error: "Correlation failed" });
  }
});

// Returns current incidents with alerts populated — used on page load so a
// refresh doesn't lose correlation/root-cause state already persisted in Mongo.
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

// --- Root Cause Agent ---
// Runs on every incident still sitting at status "correlated" (i.e. the
// Correlate Agent grouped it but no cause has been proposed yet). Each
// incident is analyzed independently and wrapped in its own try/catch —
// one LLM failure (bad key, rate limit, malformed JSON) shouldn't stop the
// other incidents in the batch from being analyzed, and shouldn't crash
// the route. Failures are reported back per-incident so the frontend can
// show exactly which one needs a retry.
app.post("/api/root-cause", async (req, res) => {
  try {
    const incidents = await Incident.find({ status: "correlated" }).populate("alerts");

    const analyzed = [];
    const failed = [];

    for (const incident of incidents) {
      const startedAt = Date.now();
      try {
        const rootCause = await analyzeRootCause(incident, incident.alerts);

        incident.rootCause = rootCause;
        incident.status = "analyzed";
        await incident.save();

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

        analyzed.push({
          incidentId: incident._id,
          title: incident.title,
          rootCause,
        });
      } catch (err) {
        console.error(`Root cause failed for incident ${incident._id}:`, err.message);

        await AuditLog.create({
          incident: incident._id,
          actor: "root-cause-agent",
          actorType: "agent",
          action: "root_cause_failed",
          reasoning: err.message,
          durationMs: Date.now() - startedAt,
        });

        failed.push({ incidentId: incident._id, title: incident.title, error: err.message });
      }
    }

    res.json({ analyzed, failed });
  } catch (err) {
    console.error("POST /api/root-cause failed:", err.message);
    res.status(500).json({ error: "Root cause analysis failed" });
  }
});

// --- Priority Agent ---
// Runs on every incident sitting at status "analyzed" (Root Cause has already
// proposed a cause, but nothing has assigned urgency yet). Same isolation
// pattern as Root Cause: each incident gets its own try/catch so one bad LLM
// response doesn't block the rest of the batch, and failures are reported
// per-incident instead of failing the whole request.
app.post("/api/priority", async (req, res) => {
  try {
    const incidents = await Incident.find({ status: "analyzed" }).populate("alerts");

    const prioritized = [];
    const failed = [];

    for (const incident of incidents) {
      const startedAt = Date.now();
      try {
        const result = await assignPriority(incident, incident.alerts);

        incident.priority = result.priority;
        incident.priorityRationale = result.rationale;
        incident.status = "prioritized";
        await incident.save();

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

        prioritized.push({
          incidentId: incident._id,
          title: incident.title,
          priority: result.priority,
          rationale: result.rationale,
        });
      } catch (err) {
        console.error(`Priority assignment failed for incident ${incident._id}:`, err.message);

        await AuditLog.create({
          incident: incident._id,
          actor: "priority-agent",
          actorType: "agent",
          action: "priority_failed",
          reasoning: err.message,
          durationMs: Date.now() - startedAt,
        });

        failed.push({ incidentId: incident._id, title: incident.title, error: err.message });
      }
    }

    res.json({ prioritized, failed });
  } catch (err) {
    console.error("POST /api/priority failed:", err.message);
    res.status(500).json({ error: "Priority assignment failed" });
  }
});

// --- Remediation Agent ---
// Runs on every incident at status "prioritized". For each, looks up
// PatternMemory for that incident's patternKey (if this exact kind of
// problem has happened before) and hands that history to the LLM as
// context. requiresApproval is NOT something the LLM decides — it's set
// here, hardcoded true for every incident, with P1 called out explicitly
// in the audit reasoning. Pattern history can inform *what* gets proposed
// and can be surfaced to the human approver as a confidence signal; it
// never skips the gate itself.
app.post("/api/remediation", async (req, res) => {
  try {
    const incidents = await Incident.find({ status: "prioritized" }).populate("alerts");

    const proposed = [];
    const failed = [];

    for (const incident of incidents) {
      const startedAt = Date.now();
      try {
        const patternMemory = await PatternMemory.findOne({ patternKey: incident.patternKey });

        const result = await proposeRemediation(incident, incident.alerts, patternMemory);

        incident.remediation = {
          action: result.action,
          command: result.command,
          rationale: result.rationale,
          riskLevel: result.riskLevel,
          requiresApproval: true, // always true — pattern history informs the proposal, never bypasses the human gate
          llmProvider: result.llmProvider,
          llmModel: result.llmModel,
          proposedAt: new Date(),
          decision: "pending",
        };
        incident.patternSnapshot = {
          approvals: patternMemory?.approvals || 0,
          rejections: patternMemory?.rejections || 0,
          lastDecision: patternMemory?.lastDecision || null,
        };
        incident.status = "awaiting_approval";
        await incident.save();

        await AuditLog.create({
          incident: incident._id,
          actor: "remediation-agent",
          actorType: "agent",
          action: "remediation_proposed",
          reasoning: result.rationale,
          llmProvider: result.llmProvider,
          llmModel: result.llmModel,
          durationMs: Date.now() - startedAt,
          metadata: {
            riskLevel: result.riskLevel,
            requiresApproval: true,
            priority: incident.priority,
            patternApprovals: patternMemory?.approvals || 0,
            patternRejections: patternMemory?.rejections || 0,
          },
        });

        proposed.push({
          incidentId: incident._id,
          title: incident.title,
          remediation: incident.remediation,
          patternSnapshot: incident.patternSnapshot,
        });
      } catch (err) {
        console.error(`Remediation failed for incident ${incident._id}:`, err.message);

        await AuditLog.create({
          incident: incident._id,
          actor: "remediation-agent",
          actorType: "agent",
          action: "remediation_failed",
          reasoning: err.message,
          durationMs: Date.now() - startedAt,
        });

        failed.push({ incidentId: incident._id, title: incident.title, error: err.message });
      }
    }

    res.json({ proposed, failed });
  } catch (err) {
    console.error("POST /api/remediation failed:", err.message);
    res.status(500).json({ error: "Remediation proposal failed" });
  }
});

// --- Human Approval Gate ---
// The one place a remediation actually gets decided. Records the decision on
// the incident AND updates PatternMemory for this patternKey — that write is
// what makes "AI-01 Remembers" persist across incidents. A decision can only
// be made once per incident (remediation.decision must still be "pending");
// this keeps PatternMemory's counts from being inflated by accidental
// double-clicks or a changed mind after the fact.
app.post("/api/incidents/:id/decision", async (req, res) => {
  const { decision, decidedBy, note } = req.body || {};

  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
  }

  try {
    const incident = await Incident.findById(req.params.id);
    if (!incident) return res.status(404).json({ error: "Incident not found" });

    if (incident.remediation?.decision !== "pending") {
      return res.status(409).json({
        error: `This incident was already ${incident.remediation?.decision}. Decisions can't be changed once made.`,
      });
    }

    incident.remediation.decision = decision;
    incident.remediation.decidedBy = decidedBy || "unspecified";
    incident.remediation.decidedAt = new Date();
    incident.remediation.decisionNote = note || "";
    incident.status = decision;
    await incident.save();

    const pattern = await PatternMemory.record({
      patternKey: incident.patternKey,
      label: patternLabel(incident.services.map((s) => ({ service: s }))),
      decision,
      decidedBy: decidedBy || "unspecified",
      note: note || "",
      incidentId: incident._id,
      action: incident.remediation.action,
    });

    await AuditLog.create({
      incident: incident._id,
      actor: decidedBy || "unspecified",
      actorType: "human",
      action: decision,
      reasoning: note || "",
      metadata: { action: incident.remediation.action, riskLevel: incident.remediation.riskLevel },
    });

    res.json({
      incidentId: incident._id,
      status: incident.status,
      remediation: incident.remediation,
      pattern: { approvals: pattern.approvals, rejections: pattern.rejections },
    });
  } catch (err) {
    console.error(`POST /api/incidents/${req.params.id}/decision failed:`, err.message);
    res.status(500).json({ error: "Failed to record decision" });
  }
});

// --- Audit Trail ---
// Append-only feed of every agent and human action taken so far, newest
// first. This is the answer to "how would someone verify what happened" —
// every route above writes here, nothing above ever updates or deletes an
// entry.
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

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`AI-01 correlation demo running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Startup failed — could not connect to MongoDB:", err.message);
    process.exit(1);
  });
