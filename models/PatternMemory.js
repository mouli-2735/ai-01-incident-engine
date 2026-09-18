const { Schema, model } = require('mongoose');

const DecisionSchema = new Schema(
  {
    incident: { type: Schema.Types.ObjectId, ref: 'Incident' },
    decision: { type: String, enum: ['approved', 'rejected'] },
    decidedBy: { type: String },
    note: { type: String },
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
  },
  { timestamps: true }
);

// Confidence is advisory only. The system may *suggest* lighter oversight;
// it never flips requiresApproval on its own.
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
      history: { incident: incidentId, decision, decidedBy, note, at: new Date() },
    },
  };

  return this.findOneAndUpdate({ patternKey }, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  });
};

module.exports = model('PatternMemory', PatternMemorySchema);
