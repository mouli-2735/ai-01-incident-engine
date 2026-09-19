const { Schema, model } = require('mongoose');

const DecisionSchema = new Schema(
  {
    incident: { type: Schema.Types.ObjectId, ref: 'Incident' },
    decision: { type: String, enum: ['approved', 'rejected'] },
    decidedBy: { type: String },
    decidedByType: { type: String, enum: ['human', 'system'], default: 'human' },
    note: { type: String },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

// A human (or the Root Cause escalation flow) correcting/supplying a
// diagnosis. Tracked separately from approve/reject so "the system learns
// from humans" covers diagnosis corrections too, not just recovery decisions.
const DiagnosisCorrectionSchema = new Schema(
  {
    incident: { type: Schema.Types.ObjectId, ref: 'Incident' },
    stage: { type: String, enum: ['root_cause', 'priority', 'recovery'] },
    suggestion: { type: String },
    submittedBy: { type: String },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

// "AI-01 Remembers" — one document per incident pattern.
const PatternMemorySchema = new Schema(
  {
    patternKey: { type: String, required: true, unique: true, index: true },
    label: { type: String },          // friendly name for the UI

    approvals: { type: Number, default: 0 },
    rejections: { type: Number, default: 0 },

    lastDecision: { type: String, enum: ['approved', 'rejected'] },
    lastDecisionAt: { type: Date },

    // the action humans keep approving for this pattern — fed back into prompts
    lastApprovedAction: { type: String },

    history: { type: [DecisionSchema], default: [] },
    diagnosisCorrections: { type: [DiagnosisCorrectionSchema], default: [] },
  },
  { timestamps: true }
);

PatternMemorySchema.virtual('total').get(function () {
  return this.approvals + this.rejections;
});

PatternMemorySchema.virtual('approvalRate').get(function () {
  const t = this.approvals + this.rejections;
  return t === 0 ? null : this.approvals / t;
});

PatternMemorySchema.set('toJSON', { virtuals: true });
PatternMemorySchema.set('toObject', { virtuals: true });

// Upsert a decision. Safe to call on a pattern that has never been seen.
PatternMemorySchema.statics.record = async function ({
  patternKey,
  label,
  decision,
  decidedBy,
  decidedByType,
  note,
  incidentId,
  action,
}) {
  const inc = decision === 'approved' ? { approvals: 1 } : { rejections: 1 };

  const update = {
    $inc: inc,
    $set: {
      lastDecision: decision,
      lastDecisionAt: new Date(),
      ...(label ? { label } : {}),
      ...(decision === 'approved' && action ? { lastApprovedAction: action } : {}),
    },
    $push: {
      history: {
        incident: incidentId,
        decision,
        decidedBy,
        decidedByType: decidedByType || 'human',
        note,
        at: new Date(),
      },
    },
  };

  return this.findOneAndUpdate({ patternKey }, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  });
};

// Log a human diagnosis correction (escalation resolution). Does not touch
// approvals/rejections — this is a separate learning signal.
PatternMemorySchema.statics.recordDiagnosis = async function ({
  patternKey,
  label,
  stage,
  suggestion,
  submittedBy,
  incidentId,
}) {
  const update = {
    $set: { ...(label ? { label } : {}) },
    $push: {
      diagnosisCorrections: { incident: incidentId, stage, suggestion, submittedBy, at: new Date() },
    },
  };

  return this.findOneAndUpdate({ patternKey }, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  });
};

module.exports = model('PatternMemory', PatternMemorySchema);
