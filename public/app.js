// ===== Element refs =====
const alertList = document.getElementById("alert-list");
const alertCount = document.getElementById("alert-count");
const clusterList = document.getElementById("cluster-list");
const analyzeBtn = document.getElementById("analyze-btn");
const decidedByInput = document.getElementById("decided-by-input");
const auditList = document.getElementById("audit-list");
const auditCount = document.getElementById("audit-count");
const patternGrid = document.getElementById("pattern-grid");
const patternCount = document.getElementById("pattern-count");
const incidentsView = document.getElementById("incidents-view");
const alertPanel = document.getElementById("alert-panel");
const patternView = document.getElementById("pattern-view");
const tabBtns = document.querySelectorAll(".tab-btn");
const dockChips = document.querySelectorAll(".dock-chip");
const dockPopover = document.getElementById("dock-popover");

// ===== State =====
// incidentsMap: incidentId -> normalized incident state (persists across renders)
const incidentsMap = new Map();
const incidentOrder = [];
const expandedIds = new Set();
let latestNoise = [];
let openDockGroup = null; // which corner list is open ("waiting" | "approved" | ...) or null

// ===== Tabs =====
tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    closeDock();
    if (tab === "patterns") {
      incidentsView.classList.add("hidden");
      alertPanel.classList.add("hidden");
      patternView.classList.add("active");
      loadPatterns();
    } else {
      incidentsView.classList.remove("hidden");
      alertPanel.classList.remove("hidden");
      patternView.classList.remove("active");
    }
  });
});

// ===== Alerts =====
// Live feed: polled on an interval rather than pushed, so a dropped request
// just gets picked up on the next tick — nothing to reconnect, nothing that
// breaks mid-demo on a flaky network.
const LIVE_ALERTS_POLL_MS = 4000;
let seenAlertIds = new Set();
let alertsPollTimer = null;

async function loadAlerts() {
  const res = await fetch("/api/alerts");
  const alerts = await res.json();
  const isFirstLoad = seenAlertIds.size === 0;

  alertCount.textContent = `(${alerts.length})`;
  alertList.innerHTML = alerts.map((a) => renderAlert(a, !isFirstLoad && !seenAlertIds.has(a.id))).join("");
  seenAlertIds = new Set(alerts.map((a) => a.id));
}

function renderAlert(a, isNew) {
  return `
    <div class="alert-item ${a.severity}${isNew ? " alert-item-new" : ""}">
      <span class="alert-service">${a.service}</span>
      <div><span class="alert-id">${a.id}</span>${new Date(a.timestamp).toLocaleTimeString()}</div>
      <div class="alert-msg">${a.message}</div>
    </div>`;
}

function startAlertsPolling() {
  if (alertsPollTimer) return;
  alertsPollTimer = setInterval(() => {
    loadAlerts().catch(() => {}); // a missed poll just gets picked up next tick
  }, LIVE_ALERTS_POLL_MS);
}

function normalizeAlert(a) {
  return {
    id: a.id || a.alertId,
    service: a.service,
    severity: a.severity,
    message: a.message,
    timestamp: a.timestamp,
  };
}

// ===== Analyze (single manual entry point) =====
const THINKING_STEPS = [
  "Correlating alerts…",
  "Determining root cause…",
  "Assessing priority…",
  "Evaluating recovery & pattern trust…",
];

let thinkingTimer = null;

function startThinking() {
  let i = 0;
  clusterList.innerHTML = `
    <div class="thinking">
      <span class="dots"><span></span><span></span><span></span></span>
      <span class="thinking-label">${THINKING_STEPS[0]}</span>
    </div>`;
  const label = clusterList.querySelector(".thinking-label");
  thinkingTimer = setInterval(() => {
    i = (i + 1) % THINKING_STEPS.length;
    if (label) {
      label.style.opacity = 0;
      setTimeout(() => {
        label.textContent = THINKING_STEPS[i];
        label.style.opacity = 1;
      }, 150);
    }
  }, 900);
}

function stopThinking() {
  if (thinkingTimer) clearInterval(thinkingTimer);
  thinkingTimer = null;
}

async function runAnalyze() {
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "Analyzing…";
  startThinking();

  const minWait = new Promise((r) => setTimeout(r, 1000));

  try {
    const [res] = await Promise.all([fetch("/api/analyze", { method: "POST" }), minWait]);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Analysis failed");

    latestNoise = data.noise || [];
    const reasonByIncidentId = new Map((data.clusters || []).map((c) => [String(c.incidentId), c]));

    for (const incident of data.incidents || []) {
      ingestIncident(incident, reasonByIncidentId.get(String(incident._id)));
    }

    // Open the most urgent incident so the first thing you see is what needs you.
    const top = sortIncidents(allIncidents())[0];
    if (top && urgencyTier(top) < 2) expandedIds.add(top.id);

    renderAll();

    // On narrow screens the results stack below the alert feed, so bring them into view.
    // On desktop they're already beside it — scrolling would push the corner dock away.
    if (window.matchMedia("(max-width: 860px)").matches) {
      document.getElementById("result-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (err) {
    clusterList.innerHTML = `<div class="root-cause-error">Analysis failed: ${err.message}</div>`;
  } finally {
    stopThinking();
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze";
    loadAudit();
    loadPatterns();
  }
}

// ===== Hydrate on page load (survive refresh) =====
async function loadIncidents() {
  try {
    const res = await fetch("/api/incidents");
    const incidents = await res.json();
    for (const incident of incidents) ingestIncident(incident);
    if (incidentOrder.length) renderAll();
  } catch (err) {
    // non-fatal — the alert feed and audit trail still load independently
  }
}

function ingestIncident(incident, clusterInfo) {
  const id = String(incident._id);
  if (!incidentsMap.has(id)) incidentOrder.push(id);
  incidentsMap.set(id, {
    id,
    title: incident.title,
    status: incident.status,
    reason: clusterInfo?.reason || incidentsMap.get(id)?.reason || null,
    alerts: (incident.alerts || []).map(normalizeAlert),
    alertCount: incident.alertCount || (incident.alerts || []).length,
    rootCause: incident.rootCause,
    priority: incident.priority,
    priorityRationale: incident.priorityRationale,
    recovery: incident.recovery,
    escalation: incident.escalation,
    patternSnapshot: incident.patternSnapshot,
  });
}

const STATUS_LABELS = {
  correlated: "Correlated",
  analyzed: "Analyzed",
  prioritized: "Prioritized",
  awaiting_approval: "Awaiting Approval",
  escalated: "Escalated to Human",
  approved: "Approved",
  rejected: "Rejected",
  resolved: "Resolved",
};

// Status groups behind the corner dock. "Waiting" covers every in-flight
// state (still chaining through stages, awaiting a decision, or escalated to
// a human) since those all still need attention.
const STATUS_GROUPS = [
  { key: "waiting",  label: "Waiting",  statuses: ["correlated", "analyzed", "prioritized", "awaiting_approval", "escalated"], empty: "Nothing is waiting on you right now." },
  { key: "approved", label: "Approved", statuses: ["approved"],  empty: "No approved incidents yet." },
  { key: "resolved", label: "Resolved", statuses: ["resolved"],  empty: "No resolved incidents yet." },
  { key: "rejected", label: "Rejected", statuses: ["rejected"],  empty: "No rejected incidents." },
];

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ===== Ordering =====
// Tier 0: a human has to act now (escalated, awaiting decision, approved but not executed)
// Tier 1: still moving through the pipeline
// Tier 2: closed out (rejected / resolved)
// Within a tier: P1 first. Incidents with no priority yet sort like P2 rather than last.
const PRIORITY_RANK = { P1: 0, P2: 1, P3: 2 };

function urgencyTier(inc) {
  if (["escalated", "awaiting_approval", "approved"].includes(inc.status)) return 0;
  if (["rejected", "resolved"].includes(inc.status)) return 2;
  return 1;
}

function sortIncidents(list) {
  return [...list].sort(
    (a, b) =>
      urgencyTier(a) - urgencyTier(b) ||
      (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
      incidentOrder.indexOf(a.id) - incidentOrder.indexOf(b.id)
  );
}

function allIncidents() {
  return incidentOrder.map((id) => incidentsMap.get(id));
}

function incidentsInGroup(group) {
  return sortIncidents(allIncidents().filter((i) => group.statuses.includes(i.status)));
}

// ===== Rendering =====
function renderAll() {
  const incidents = sortIncidents(allIncidents());
  let html = "";

  if (!incidents.length) {
    html = `<div class="empty-state">No incidents yet.</div>`;
  } else {
    html = renderAssessment(incidents) + incidents.map(renderIncidentCard).join("");
  }

  if (latestNoise.length > 0) {
    html += `
      <div class="noise-card">
        <strong>${latestNoise.length} uncorrelated / noise alerts</strong> — not grouped into any incident cluster.
        ${latestNoise.map((a) => `<div class="mini-alert">${a.id} — ${a.service}: ${a.message}</div>`).join("")}
      </div>`;
  }

  clusterList.innerHTML = html;
  renderSummaryStrip();
  renderDock();
}

// The read-out you get after Analyze: what was found, what needs a human, where to start.
function renderAssessment(incidents) {
  const count = (fn) => incidents.filter(fn).length;
  const p1Open = count((i) => i.priority === "P1" && urgencyTier(i) < 2);
  const escalated = count((i) => i.status === "escalated");
  const needDecision = count((i) => i.status === "awaiting_approval");
  const toExecute = count((i) => i.status === "approved");
  const closed = count((i) => urgencyTier(i) === 2);
  const correlatedAlerts = incidents.reduce((n, i) => n + (i.alertCount || 0), 0);
  const next = incidents.find((i) => urgencyTier(i) === 0);

  const pills = [];
  if (p1Open) pills.push(`<span class="assess-pill assess-p1">${p1Open} P1 open</span>`);
  if (escalated) pills.push(`<span class="assess-pill assess-attn">${escalated} escalated to you</span>`);
  if (needDecision) pills.push(`<span class="assess-pill assess-attn">${needDecision} awaiting your decision</span>`);
  if (toExecute) pills.push(`<span class="assess-pill assess-attn">${toExecute} approved · ready to execute</span>`);
  if (closed) pills.push(`<span class="assess-pill assess-ok">${closed} closed</span>`);
  if (!next) pills.unshift(`<span class="assess-pill assess-ok">Nothing needs a human right now</span>`);

  return `
    <div class="assessment">
      <div class="assessment-headline">
        ${incidents.length} incident${incidents.length === 1 ? "" : "s"}
        <span class="assessment-sub">from ${correlatedAlerts} correlated alert${correlatedAlerts === 1 ? "" : "s"}${latestNoise.length ? ` · ${latestNoise.length} noise` : ""}</span>
      </div>
      <div class="assessment-pills">${pills.join("")}</div>
      ${next ? `<button type="button" class="assess-next" data-jump="${next.id}">Start with: ${esc(next.title)}${next.priority ? ` (${next.priority})` : ""} →</button>` : ""}
    </div>`;
}

// ===== Corner status dock =====
function renderDock() {
  for (const g of STATUS_GROUPS) {
    const n = incidentsInGroup(g).length;
    const countEl = document.getElementById(`dock-count-${g.key}`);
    if (countEl) countEl.textContent = n;
    const chip = document.querySelector(`.dock-chip[data-group="${g.key}"]`);
    if (chip) chip.classList.toggle("attn", g.key === "waiting" && n > 0);
  }
  if (openDockGroup) renderDockPopover();
}

function renderDockRow(inc) {
  const pri = inc.priority
    ? `<span class="priority-badge" style="${badgeInlineStyle(inc.priority)}">${inc.priority}</span>`
    : `<span class="dock-row-pri-none">–</span>`;
  return `
    <button type="button" class="dock-row" data-jump="${inc.id}">
      ${pri}
      <span class="dock-row-title">${esc(inc.title)}</span>
      <span class="status-chip status-${inc.status}">${STATUS_LABELS[inc.status] || inc.status}</span>
    </button>`;
}

function renderDockPopover() {
  const group = STATUS_GROUPS.find((g) => g.key === openDockGroup);
  if (!group) return closeDock();
  const items = incidentsInGroup(group);

  dockPopover.innerHTML = `
    <div class="dock-pop-head">
      <span class="dock-pop-title">${group.label}<span class="dock-pop-count">${items.length}</span></span>
      <button type="button" class="dock-pop-close" data-close-dock aria-label="Close list">×</button>
    </div>
    <div class="dock-pop-list">
      ${items.length ? items.map(renderDockRow).join("") : `<p class="placeholder dock-empty">${group.empty}</p>`}
    </div>`;
  dockPopover.hidden = false;

  dockChips.forEach((chip) => {
    const on = chip.dataset.group === group.key;
    chip.classList.toggle("open", on);
    chip.setAttribute("aria-expanded", String(on));
  });
}

function closeDock() {
  openDockGroup = null;
  dockPopover.hidden = true;
  dockChips.forEach((chip) => {
    chip.classList.remove("open");
    chip.setAttribute("aria-expanded", "false");
  });
}

function toggleDock(key) {
  if (openDockGroup === key) return closeDock();
  openDockGroup = key;
  renderDockPopover();
}

// Clicking a row in the corner list opens that incident in the middle and scrolls to it.
function jumpToIncident(id) {
  if (!incidentsMap.has(id)) return;
  expandedIds.add(id);
  closeDock();
  renderAll();
  const card = clusterList.querySelector(`.cluster-card[data-incident-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1600);
}

function renderSummaryStrip() {
  let p1 = 0, p2 = 0, p3 = 0, esc = 0;
  for (const id of incidentOrder) {
    const inc = incidentsMap.get(id);
    if (inc.status === "escalated") esc++;
    if (inc.priority === "P1") p1++;
    else if (inc.priority === "P2") p2++;
    else if (inc.priority === "P3") p3++;
  }
  document.getElementById("count-p1").textContent = p1;
  document.getElementById("count-p2").textContent = p2;
  document.getElementById("count-p3").textContent = p3;
  document.getElementById("count-esc").textContent = esc;
}


function renderIncidentCard(inc) {
  const expanded = expandedIds.has(inc.id);
  const isP1 = inc.priority === "P1";

  return `
    <div class="cluster-card ${isP1 ? "p1" : ""} ${expanded ? "expanded" : ""}" data-incident-id="${inc.id}">
      <div class="card-head" data-toggle="${inc.id}">
        <svg class="chevron" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <h3>${inc.title}</h3>
        ${inc.priority ? `<span class="priority-badge" style="font-size:11px;padding:3px 9px;${badgeInlineStyle(inc.priority)}">${inc.priority}</span>` : ""}
        <span class="status-chip status-${inc.status}">${STATUS_LABELS[inc.status] || inc.status}</span>
      </div>
      <div class="card-body">
        <div class="card-body-inner">
          ${inc.reason ? `<div class="cluster-reason">${inc.reason}</div>` : ""}
          <div class="cluster-alert-count">${inc.alertCount} alert(s) correlated</div>
          ${inc.alerts.map((a) => `<div class="mini-alert"><span class="alert-id">${a.id}</span>${a.service} — ${a.message}</div>`).join("")}

          ${inc.rootCause?.summary ? renderRootCause(inc.rootCause) : ""}
          ${inc.priority ? renderPriority(inc) : ""}
          ${inc.status === "escalated" && inc.escalation ? renderEscalation(inc) : ""}
          ${inc.recovery?.action ? renderRecovery(inc) : ""}
        </div>
      </div>
    </div>`;
}

function badgeInlineStyle(p) {
  if (p === "P1") return "background:var(--sev-high);color:#fff;";
  if (p === "P2") return "background:var(--sev-medium-wash);color:var(--sev-medium);border:1.5px solid var(--sev-medium);";
  return "background:var(--sev-low-wash);color:var(--sev-low);border:1.5px solid var(--sev-low);";
}

function renderRootCause(rc) {
  const pct = Math.round((rc.confidence ?? 0) * 100);
  return `
    <div class="root-cause-block">
      <div class="root-cause-label">ROOT CAUSE <span class="confidence">confidence ${pct}%</span></div>
      <div class="root-cause-summary">${rc.summary}</div>
      ${rc.evidence?.length ? `<ul class="evidence-list">${rc.evidence.map((e) => `<li>${e}</li>`).join("")}</ul>` : ""}
      <div class="root-cause-meta">via ${rc.llmProvider}${rc.llmModel ? " · " + rc.llmModel : ""}</div>
    </div>`;
}

function renderPriority(inc) {
  return `
    <div class="priority-block priority-${inc.priority}">
      <div class="priority-badge">${inc.priority}</div>
      <div class="priority-rationale">${inc.priorityRationale || ""}</div>
    </div>`;
}

function renderEscalation(inc) {
  const e = inc.escalation;
  const stageLabel = { root_cause: "Root Cause", priority: "Priority", recovery: "Recovery" }[e.stage] || e.stage;
  return `
    <div class="escalation-block">
      <div class="escalation-label">⚠ Escalated to Human — stuck at ${stageLabel}</div>
      <div class="escalation-row"><b>What it assumed:</b> ${e.assumption || "—"}</div>
      <div class="escalation-row"><b>What it tried:</b> ${e.method || "—"}</div>
      <div class="escalation-row"><b>Where it got stuck:</b> ${e.stuckPoint || "—"}</div>
      <div class="escalation-input-row">
        <textarea placeholder="Give your own diagnosis or decision to unblock this incident…" data-escalation-input="${inc.id}"></textarea>
        <button class="submit-suggestion-btn" data-escalation-submit="${inc.id}">Submit</button>
      </div>
    </div>`;
}

function renderPatternBanner(snapshot) {
  const total = (snapshot?.approvals || 0) + (snapshot?.rejections || 0);
  if (!total) {
    return `<div class="pattern-banner pattern-new">First time this pattern has occurred — no prior history.</div>`;
  }
  const rate = Math.round(((snapshot.approvals || 0) / total) * 100);
  return `<div class="pattern-banner">
    <span>Approved ${snapshot.approvals}/${total} time(s) previously (${rate}%)</span>
    <span class="rate-bar"><span class="rate-fill" style="width:${rate}%"></span></span>
    ${snapshot.lastDecision ? `<span>last: ${snapshot.lastDecision}</span>` : ""}
  </div>`;
}

function renderRecovery(inc) {
  const r = inc.recovery;
  let decisionHtml;

  if (r.decision === "pending") {
    decisionHtml = `
      <div class="decision-row">
        <button class="approve-btn" data-incident-id="${inc.id}">Approve</button>
        <button class="reject-btn" data-incident-id="${inc.id}">Reject</button>
      </div>`;
  } else {
    const isAuto = r.decidedByType === "system";
    const cls = isAuto ? "decision-auto" : r.decision === "approved" ? "decision-approved" : "decision-rejected";
    const label = isAuto ? "AUTO-APPROVED BY SYSTEM" : r.decision === "approved" ? "APPROVED" : "REJECTED";
    decisionHtml = `<div class="decision-result ${cls}">${label}${r.decidedBy && !isAuto ? ` — ${r.decidedBy}` : ""}</div>`;
    if (r.decision === "approved" && !r.executed) {
      decisionHtml += `<div><button class="execute-btn" data-execute="${inc.id}">Mark as executed</button></div>`;
    } else if (r.executed) {
      decisionHtml += `<div class="decision-result decision-approved" style="margin-top:6px;">EXECUTED — ${r.executedBy || ""}</div>`;
    }
  }

  const autoBanner = r.autoRunReason
    ? `<div class="auto-run-banner ${r.autoRunEligible ? "eligible" : "not-eligible"}">${r.autoRunEligible ? "✓ " : "— "}${r.autoRunReason}</div>`
    : "";

  return `
    <div class="recovery-block risk-${r.riskLevel}">
      <div class="recovery-label">PROPOSED RECOVERY <span class="risk-tag">${r.riskLevel} risk</span></div>
      ${renderPatternBanner(inc.patternSnapshot)}
      ${autoBanner}
      <div class="recovery-action">${r.action}</div>
      ${r.command ? `<div class="recovery-command">${r.command}</div>` : ""}
      <div class="recovery-rationale">${r.rationale}</div>
      <div class="recovery-meta">via ${r.llmProvider}${r.llmModel ? " · " + r.llmModel : ""} · a human always executes, even when the decision auto-runs</div>
      ${decisionHtml}
    </div>`;
}

// ===== Decisions / execution / escalation response =====
async function decideIncident(incidentId, decision) {
  try {
    const res = await fetch(`/api/incidents/${incidentId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, decidedBy: decidedByInput.value || "unspecified" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const inc = incidentsMap.get(incidentId);
    inc.status = data.status;
    inc.recovery = data.recovery;
    renderAll();
  } catch (err) {
    alert(`Couldn't record decision: ${err.message}`);
  } finally {
    loadAudit();
    loadPatterns();
  }
}

async function executeIncident(incidentId) {
  try {
    const res = await fetch(`/api/incidents/${incidentId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executedBy: decidedByInput.value || "unspecified" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const inc = incidentsMap.get(incidentId);
    inc.status = data.status;
    inc.recovery = data.recovery;
    renderAll();
  } catch (err) {
    alert(`Couldn't record execution: ${err.message}`);
  } finally {
    loadAudit();
  }
}

async function submitEscalationResponse(incidentId, suggestion) {
  const btn = document.querySelector(`[data-escalation-submit="${incidentId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }

  try {
    const res = await fetch(`/api/incidents/${incidentId}/escalation-response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestion, submittedBy: decidedByInput.value || "unspecified" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    ingestIncident(data.incident);
    expandedIds.add(incidentId);
    renderAll();
  } catch (err) {
    alert(`Couldn't submit suggestion: ${err.message}`);
  } finally {
    loadAudit();
    loadPatterns();
  }
}

// ===== Pattern Memory dashboard =====
async function loadPatterns() {
  try {
    const res = await fetch("/api/patterns");
    const patterns = await res.json();
    patternCount.textContent = `(${patterns.length})`;
    patternGrid.innerHTML = patterns.length
      ? patterns.map(renderPatternCard).join("")
      : `<p class="placeholder">No patterns recorded yet — decisions made during Recovery approval build this up over time.</p>`;
  } catch (err) {
    patternGrid.innerHTML = `<p class="placeholder">Failed to load Pattern Memory: ${err.message}</p>`;
  }
}

function renderPatternCard(p) {
  const total = (p.approvals || 0) + (p.rejections || 0);
  const rate = total ? Math.round((p.approvals / total) * 100) : 0;
  const history = [...(p.history || [])].reverse().slice(0, 6);
  const diagnoses = [...(p.diagnosisCorrections || [])].reverse().slice(0, 3);

  return `
    <div class="pattern-card">
      <h3>${p.label || p.patternKey}</h3>
      <div class="pattern-key">${p.patternKey}</div>
      <div class="pattern-rate-row">
        <span class="pattern-rate-pct">${total ? rate + "%" : "—"}</span>
        <span class="pattern-rate-bar"><span class="pattern-rate-fill" style="width:${rate}%"></span></span>
      </div>
      <div class="pattern-counts">${p.approvals || 0} approved · ${p.rejections || 0} rejected · ${total} total</div>
      ${p.lastDecision ? `<div class="pattern-last">Last decision: ${p.lastDecision}${p.lastDecisionAt ? " · " + new Date(p.lastDecisionAt).toLocaleString() : ""}</div>` : ""}
      ${history.length ? `<div class="pattern-history-list">${history.map(renderPatternHistoryItem).join("")}</div>` : ""}
      ${diagnoses.length ? `<div class="pattern-diagnosis"><div class="pd-title">Diagnosis corrections</div>${diagnoses.map((d) => `<div>${d.stage}: ${d.suggestion} <span style="color:var(--text-faint)">(${d.submittedBy})</span></div>`).join("")}</div>` : ""}
    </div>`;
}

function renderPatternHistoryItem(h) {
  const cls = h.decidedByType === "system" ? "ph-system" : h.decision === "approved" ? "ph-approved" : "ph-rejected";
  const label = h.decidedByType === "system" ? "auto-approved" : h.decision;
  return `<div class="pattern-history-item"><span class="${cls}">${label}</span><span>${h.decidedBy || ""}</span><span style="color:var(--text-faint)">${new Date(h.at).toLocaleDateString()}</span></div>`;
}

// ===== Audit trail =====
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

// ===== Event wiring =====
analyzeBtn.addEventListener("click", runAnalyze);

// Corner dock + "jump to incident" buttons (dock rows and the assessment's "Start with")
document.addEventListener("click", (e) => {
  const chip = e.target.closest(".dock-chip");
  if (chip) return toggleDock(chip.dataset.group);

  const jump = e.target.closest("[data-jump]");
  if (jump) return jumpToIncident(jump.dataset.jump);

  if (e.target.closest("[data-close-dock]")) return closeDock();

  // click anywhere else closes an open corner list
  if (openDockGroup && !e.target.closest("#dock-popover")) closeDock();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !openDockGroup) return;
  const key = openDockGroup;
  closeDock();
  document.querySelector(`.dock-chip[data-group="${key}"]`)?.focus();
});

clusterList.addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-toggle]");
  if (toggle) {
    const id = toggle.dataset.toggle;
    if (expandedIds.has(id)) expandedIds.delete(id);
    else expandedIds.add(id);
    renderAll();
    return;
  }
  if (e.target.classList.contains("approve-btn")) {
    decideIncident(e.target.dataset.incidentId, "approved");
  } else if (e.target.classList.contains("reject-btn")) {
    decideIncident(e.target.dataset.incidentId, "rejected");
  } else if (e.target.dataset.execute) {
    executeIncident(e.target.dataset.execute);
  } else if (e.target.dataset.escalationSubmit) {
    const id = e.target.dataset.escalationSubmit;
    const textarea = document.querySelector(`[data-escalation-input="${id}"]`);
    const suggestion = textarea?.value.trim();
    if (!suggestion) { textarea?.focus(); return; }
    submitEscalationResponse(id, suggestion);
  }
});

loadAlerts();
loadAudit();
loadIncidents();
startAlertsPolling();
