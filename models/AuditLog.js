const { Schema, model } = require('mongoose');

// Append-only record of every decision, agent or human.
// This is the artifact you show a judge who asks "how do I know what it did?"
const AuditLogSchema = new Schema(
  {
    incident: { type: Schema.Types.ObjectId, ref: 'Incident', index: true },

    actor: { type: String, required: true },   // 'correlate-agent', 'root-cause-agent', 'user:arjun'
    actorType: { type: String, enum: ['agent', 'human', 'system'], required: true },

    action: { type: String, required: true },  // 'correlated', 'root_cause_proposed', 'approved', 'llm_fallback'
    reasoning: { type: String },               // why — in plain language

    llmProvider: { type: String },
    llmModel: { type: String },
    durationMs: { type: Number },

    metadata: { type: Schema.Types.Mixed },

    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

AuditLogSchema.index({ incident: 1, timestamp: 1 });

module.exports = model('AuditLog', AuditLogSchema);
