const { Schema, model } = require('mongoose');

const AlertSchema = new Schema(
  {
    // stable id from the source system (keeps seeds idempotent)
    alertId: { type: String, required: true, unique: true, index: true },

    source: { type: String, required: true },        // 'prometheus', 'cloudwatch', 'datadog', ...
    service: { type: String, required: true, index: true },
    serviceFamily: { type: String, index: true },    // 'payments', 'frontend', 'auth' — used by Correlate
    severity: {
      type: String,
      enum: ['high', 'medium', 'low'],
      default: 'medium',
      index: true,
    },
    message: { type: String, required: true },
    metric: { type: String },
    value: { type: Number },
    timestamp: { type: Date, required: true, index: true },

    // correlation state
    status: {
      type: String,
      enum: ['new', 'correlated', 'noise'],
      default: 'new',
      index: true,
    },
    incident: { type: Schema.Types.ObjectId, ref: 'Incident', default: null, index: true },

    // keep the untouched original payload — useful for the demo and for LLM prompts
    raw: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Correlate Agent's main query: uncorrelated alerts in a time window
AlertSchema.index({ status: 1, timestamp: -1 });

module.exports = model('Alert', AlertSchema);
