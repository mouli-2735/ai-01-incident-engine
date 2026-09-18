const alertList = document.getElementById("alert-list");
const alertCount = document.getElementById("alert-count");
const clusterList = document.getElementById("cluster-list");
const analyzeBtn = document.getElementById("analyze-btn");
const rootCauseBtn = document.getElementById("root-cause-btn");
const priorityBtn = document.getElementById("priority-btn");
const remediationBtn = document.getElementById("remediation-btn");
const decidedByInput = document.getElementById("decided-by-input");
const auditList = document.getElementById("audit-list");
const auditCount = document.getElementById("audit-count");

async function loadAlerts() {
  const res = await fetch("/api/alerts");
  const alerts = await res.json();
  alertCount.textContent = `(${alerts.length})`;
  alertList.innerHTML = alerts.map(renderAlert).join("");
}

function renderAlert(a) {
  return `
    <div class="alert-item ${a.severity}">
      <span class="alert-service">${a.service}</span>
      <div><span class="alert-id">${a.id}</span>${new Date(a.timestamp).toLocaleTimeString()}</div>
      <div class="alert-msg">${a.message}</div>
    </div>`;
}

async function runCorrelation() {
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "Analyzing...";
  clusterList.innerHTML = `<p class="placeholder">Running Correlate Agent...</p>`;

  const res = await fetch("/api/correlate", { method: "POST" });
  const { clusters, noise } = await res.json();

  let html = clusters.map(renderCluster).join("");

  if (noise.length > 0) {
    html += `
      <div class="noise-card">
        <strong>${noise.length} uncorrelated / noise alerts</strong> — not grouped into any incident cluster.
        ${noise.map((a) => `<div class="mini-alert">${a.id} — ${a.service}: ${a.message}</div>`).join("")}
      </div>`;
  }

  clusterList.innerHTML = html;
  analyzeBtn.disabled = false;
  analyzeBtn.textContent = "Analyze";

  // Each stage only makes sense once the stage before it has produced something.
  rootCauseBtn.disabled = clusters.length === 0;
  priorityBtn.disabled = true;
  remediationBtn.disabled = true;

  loadAudit();
}

function renderCluster(c) {
  return `
    <div class="cluster-card" data-incident-id="${c.incidentId}">
      <h3>${c.label}</h3>
      <div class="cluster-reason">${c.reason}</div>
      <div class="cluster-alert-count">${c.alerts.length} alerts correlated</div>
      ${c.alerts.map((a) => `<div class="mini-alert"><span class="alert-id">${a.id}</span>${a.service} — ${a.message}</div>`).join("")}
      <div class="root-cause-slot"></div>
      <div class="priority-slot"></div>
      <div class="remediation-slot"></div>
    </div>`;
}

function renderRootCause(rc) {
  const pct = Math.round((rc.confidence ?? 0) * 100);
  return `
    <div class="root-cause-block">
      <div class="root-cause-label">ROOT CAUSE <span class="confidence">confidence ${pct}%</span></div>
      <div class="root-cause-summary">${rc.summary}</div>
      <ul class="evidence-list">
        ${rc.evidence.map((e) => `<li>${e}</li>`).join("")}
      </ul>
      <div class="root-cause-meta">via ${rc.llmProvider} · ${rc.llmModel}</div>
    </div>`;
}

async function runRootCause() {
  rootCauseBtn.disabled = true;
  rootCauseBtn.textContent = "Analyzing...";

  document.querySelectorAll(".root-cause-slot").forEach((slot) => {
    slot.innerHTML = `<div class="root-cause-loading">Running Root Cause Agent...</div>`;
  });

  try {
    const res = await fetch("/api/root-cause", { method: "POST" });
    const { analyzed, failed } = await res.json();

    for (const item of analyzed) {
      const card = document.querySelector(`.cluster-card[data-incident-id="${item.incidentId}"] .root-cause-slot`);
      if (card) card.innerHTML = renderRootCause(item.rootCause);
    }

    for (const item of failed) {
      const card = document.querySelector(`.cluster-card[data-incident-id="${item.incidentId}"] .root-cause-slot`);
      if (card) card.innerHTML = `<div class="root-cause-error">Root cause analysis failed: ${item.error}</div>`;
    }

    priorityBtn.disabled = analyzed.length === 0;
  } catch (err) {
    document.querySelectorAll(".root-cause-slot").forEach((slot) => {
      slot.innerHTML = `<div class="root-cause-error">Request failed: ${err.message}</div>`;
    });
  } finally {
    rootCauseBtn.disabled = false;
    rootCauseBtn.textContent = "Find Root Cause";
    loadAudit();
  }
}

function renderPriority(p) {
  return `
    <div class="priority-block priority-${p.priority}">
      <div class="priority-badge">${p.priority}</div>
      <div class="priority-rationale">${p.rationale}</div>
    </div>`;
}

async function runPriority() {
  priorityBtn.disabled = true;
  priorityBtn.textContent = "Assigning...";

  document.querySelectorAll(".priority-slot").forEach((slot) => {
    slot.innerHTML = `<div class="root-cause-loading">Running Priority Agent...</div>`;
  });

  try {
    const res = await fetch("/api/priority", { method: "POST" });
    const { prioritized, failed } = await res.json();

    for (const item of prioritized) {
      const card = document.querySelector(`.cluster-card[data-incident-id="${item.incidentId}"] .priority-slot`);
      if (card) card.innerHTML = renderPriority(item);
    }

    for (const item of failed) {
      const card = document.querySelector(`.cluster-card[data-incident-id="${item.incidentId}"] .priority-slot`);
      if (card) card.innerHTML = `<div class="root-cause-error">Priority assignment failed: ${item.error}</div>`;
    }

    remediationBtn.disabled = prioritized.length === 0;
  } catch (err) {
    document.querySelectorAll(".priority-slot").forEach((slot) => {
      slot.innerHTML = `<div class="root-cause-error">Request failed: ${err.message}</div>`;
    });
  } finally {
    priorityBtn.disabled = false;
    priorityBtn.textContent = "Assign Priority";
    loadAudit();
  }
}

// Pattern history line shown above the proposed action — this is the visible
// half of "AI-01 Remembers". It never implies the gate was skipped; it's
// shown alongside Approve/Reject, never instead of them.
function renderPatternHistory(snapshot) {
  const total = (snapshot?.approvals || 0) + (snapshot?.rejections || 0);
  if (total === 0) {
    return `<div class="pattern-history pattern-new">First time this pattern has occurred — no prior history.</div>`;
  }
  return `<div class="pattern-history">
    Approved ${snapshot.approvals}/${total} time(s) previously
    ${snapshot.lastDecision ? `· last decision: ${snapshot.lastDecision}` : ""}
  </div>`;
}

function renderRemediation(item) {
  const r = item.remediation;
  return `
    <div class="remediation-block risk-${r.riskLevel}">
      <div class="remediation-label">PROPOSED REMEDIATION <span class="risk-tag">${r.riskLevel} risk</span></div>
      ${renderPatternHistory(item.patternSnapshot)}
      <div class="remediation-action">${r.action}</div>
      <div class="remediation-command">${r.command}</div>
      <div class="remediation-rationale">${r.rationale}</div>
      <div class="remediation-meta">via ${r.llmProvider} · ${r.llmModel} · requires human approval</div>
      <div class="decision-row">
        <button class="approve-btn" data-incident-id="${item.incidentId}">Approve</button>
        <button class="reject-btn" data-incident-id="${item.incidentId}">Reject</button>
      </div>
    </div>`;
}

function renderDecision(status, note) {
  const label = status === "approved" ? "APPROVED" : "REJECTED";
  return `<div class="decision-result decision-${status}">${label}${note ? ` — ${note}` : ""}</div>`;
}

async function runRemediation() {
  remediationBtn.disabled = true;
  remediationBtn.textContent = "Proposing...";

  document.querySelectorAll(".remediation-slot").forEach((slot) => {
    slot.innerHTML = `<div class="root-cause-loading">Running Remediation Agent...</div>`;
  });

  try {
    const res = await fetch("/api/remediation", { method: "POST" });
    const { proposed, failed } = await res.json();

    for (const item of proposed) {
      const card = document.querySelector(`.cluster-card[data-incident-id="${item.incidentId}"] .remediation-slot`);
      if (card) card.innerHTML = renderRemediation(item);
    }

    for (const item of failed) {
      const card = document.querySelector(`.cluster-card[data-incident-id="${item.incidentId}"] .remediation-slot`);
      if (card) card.innerHTML = `<div class="root-cause-error">Remediation proposal failed: ${item.error}</div>`;
    }
  } catch (err) {
    document.querySelectorAll(".remediation-slot").forEach((slot) => {
      slot.innerHTML = `<div class="root-cause-error">Request failed: ${err.message}</div>`;
    });
  } finally {
    remediationBtn.disabled = false;
    remediationBtn.textContent = "Propose Remediation";
    loadAudit();
  }
}

async function decideIncident(incidentId, decision) {
  const slot = document.querySelector(`.cluster-card[data-incident-id="${incidentId}"] .decision-row`);
  if (slot) slot.innerHTML = `<div class="root-cause-loading">Recording decision...</div>`;

  try {
    const res = await fetch(`/api/incidents/${incidentId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, decidedBy: decidedByInput.value || "unspecified" }),
    });
    const data = await res.json();

    if (!res.ok) {
      if (slot) slot.innerHTML = `<div class="root-cause-error">${data.error}</div>`;
      return;
    }

    if (slot) slot.outerHTML = renderDecision(data.status, "");
  } catch (err) {
    if (slot) slot.innerHTML = `<div class="root-cause-error">Request failed: ${err.message}</div>`;
  } finally {
    loadAudit();
  }
}

function renderAuditEntry(log) {
  const time = new Date(log.timestamp).toLocaleTimeString();
  const actorClass = log.actorType === "human" ? "audit-human" : log.actorType === "agent" ? "audit-agent" : "audit-system";
  return `
    <div class="audit-entry ${actorClass}">
      <span class="audit-time">${time}</span>
      <span class="audit-actor">${log.actor}</span>
      <span class="audit-action">${log.action}</span>
      ${log.incident?.title ? `<span class="audit-incident">${log.incident.title}</span>` : ""}
      ${log.reasoning ? `<div class="audit-reasoning">${log.reasoning}</div>` : ""}
    </div>`;
}

async function loadAudit() {
  try {
    const res = await fetch("/api/audit");
    const logs = await res.json();
    auditCount.textContent = `(${logs.length})`;
    auditList.innerHTML = logs.length
      ? logs.map(renderAuditEntry).join("")
      : `<p class="placeholder">No actions recorded yet.</p>`;
  } catch (err) {
    auditList.innerHTML = `<p class="placeholder">Failed to load audit trail: ${err.message}</p>`;
  }
}

analyzeBtn.addEventListener("click", runCorrelation);
rootCauseBtn.addEventListener("click", runRootCause);
priorityBtn.addEventListener("click", runPriority);
remediationBtn.addEventListener("click", runRemediation);

// Event delegation: approve/reject buttons are created dynamically per
// incident card, so listen on the stable parent instead of binding per-button.
clusterList.addEventListener("click", (e) => {
  if (e.target.classList.contains("approve-btn")) {
    decideIncident(e.target.dataset.incidentId, "approved");
  } else if (e.target.classList.contains("reject-btn")) {
    decideIncident(e.target.dataset.incidentId, "rejected");
  }
});

loadAlerts();
loadAudit();
