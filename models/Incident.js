const { Schema, model } = require('mongoose');

// What the Root Cause Agent produces
const RootCauseSchema = new Schema(
  {
    summary: { type: String },
    evidence: [{ type: String }],
    confidence: { type: Number, min: 0, max: 1 },
    llmProvider: { type: String },   // 'groq' | 'openrouter' | 'gemini' | 'human'
    llmModel: { type: String },
    generatedAt: { type: Date },
  },
  { _id: false }
);

// What the Recovery Agent proposes (formerly "Remediation")
const RecoverySchema = new Schema(
  {
    action: { type: String },            // human-readable: "Roll back payments-api to v2.3.1"
    command: { type: String },           // the concrete step that would run
    rationale: { type: String },
    riskLevel: { type: String, enum: ['low', 'medium', 'high'] },
    requiresApproval: { type: Boolean, default: true },
    llmProvider: { type: String },
    llmModel: { type: String },
    proposedAt: { type: Date },

    // confidence-gated autonomy: did this proposal qualify for auto-run, and why
    autoRunEligible: { type: Boolean, default: false },
    autoRunReason: { type: String }, // explanation of why it did/didn't qualify

    // human (or system) approval gate. The AI may self-approve under strict
    // conditions, but nothing ever *executes* except through this same gate —
    // execution is a separate manual step a human always carries out.
    decision: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    decidedBy: { type: String },        // a username, or 'system' for an auto-approval
    decidedByType: { type: String, enum: ['human', 'system'], default: 'human' },
    decidedAt: { type: Date },
    decisionNote: { type: String },

    executed: { type: Boolean, default: false },
    executedBy: { type: String },
    executedAt: { type: Date },
  },
  { _id: false }
);

// Populated when a stage can't confidently resolve on its own, or an
// auto-run attempt at the Recovery stage fails. Pauses the pipeline and asks
// a human for input rather than guessing forward.
const EscalationSchema = new Schema(
  {
    stage: { type: String, enum: ['root_cause', 'priority', 'recovery'] },
    reason: { type: String, enum: ['low_confidence', 'agent_error', 'auto_run_failed'] },
    assumption: { type: String },   // best guess the agent had reached so far
    method: { type: String },       // what approach/agent it tried
    stuckPoint: { type: String },   // specifically where/why it couldn't continue
    confidence: { type: Number },
    escalatedAt: { type: Date, default: Date.now },

    humanSuggestion: { type: String },
    humanSuggestedBy: { type: String },
    resolvedAt: { type: Date },
  },
  { _id: false }
);

const IncidentSchema = new Schema(
  {
    title: { type: String, required: true },

    // links back to the raw signals
    alerts: [{ type: Schema.Types.ObjectId, ref: 'Alert' }],
    alertCount: { type: Number, default: 0 },
    services: [{ type: String }],
    serviceFamily: { type: String, index: true },

    // the key that ties this incident to past ones — drives Pattern Memory
    patternKey: { type: String, index: true },

    windowStart: { type: Date },
    windowEnd: { type: Date },

    status: {
      type: String,
      enum: [
        'correlated',        // Correlate Agent grouped it (human clicked Analyze)
        'analyzed',          // Root Cause Agent ran, confidence high enough to continue
        'prioritized',       // Priority Agent ran
        'awaiting_approval', // Recovery proposed, gate open, waiting on a human
        'escalated',         // a stage couldn't confidently resolve — waiting on human input
        'approved',
        'rejected',
        'resolved',
      ],
      default: 'correlated',
      index: true,
    },

    priority: { type: String, enum: ['P1', 'P2', 'P3'], index: true },
    priorityRationale: { type: String },

    rootCause: { type: RootCauseSchema, default: () => ({}) },
    recovery: { type: RecoverySchema, default: () => ({}) },
    escalation: { type: EscalationSchema, default: null },

    // snapshot of what Pattern Memory said at proposal time, so the UI can show
    // "approved 4/4 times previously" without a second lookup
    patternSnapshot: {
      approvals: { type: Number, default: 0 },
      rejections: { type: Number, default: 0 },
      lastDecision: { type: String },
      approvalRate: { type: Number, default: null },
    },
  },
  { timestamps: true }
);

IncidentSchema.index({ status: 1, createdAt: -1 });

module.exports = model('Incident', IncidentSchema);
