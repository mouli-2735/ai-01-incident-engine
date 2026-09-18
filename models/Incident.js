const { Schema, model } = require('mongoose');

// What the Root Cause Agent produces
const RootCauseSchema = new Schema(
  {
    summary: { type: String },
    evidence: [{ type: String }],
    confidence: { type: Number, min: 0, max: 1 },
    llmProvider: { type: String },   // 'groq' | 'openrouter' | 'gemini' — proves the fallback chain ran
    llmModel: { type: String },
    generatedAt: { type: Date },
  },
  { _id: false }
);

// What the Remediation Agent proposes
const RemediationSchema = new Schema(
  {
    action: { type: String },            // human-readable: "Roll back payments-api to v2.3.1"
    command: { type: String },           // the concrete step that would run
    rationale: { type: String },
    riskLevel: { type: String, enum: ['low', 'medium', 'high'] },
    requiresApproval: { type: Boolean, default: true },
    llmProvider: { type: String },
    proposedAt: { type: Date },

    // human approval gate
    decision: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    decidedBy: { type: String },
    decidedAt: { type: Date },
    decisionNote: { type: String },
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
        'correlated',        // Correlate Agent grouped it
        'analyzed',          // Root Cause Agent ran
        'prioritized',       // Priority Agent ran
        'awaiting_approval', // Remediation proposed, gate open
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
    remediation: { type: RemediationSchema, default: () => ({}) },

    // snapshot of what Pattern Memory said at proposal time, so the UI can show
    // "approved 4/4 times previously" without a second lookup
    patternSnapshot: {
      approvals: { type: Number, default: 0 },
      rejections: { type: Number, default: 0 },
      lastDecision: { type: String },
    },
  },
  { timestamps: true }
);

IncidentSchema.index({ status: 1, createdAt: -1 });

module.exports = model('Incident', IncidentSchema);
