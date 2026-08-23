const mongoose = require('mongoose');

// ────────────────────────────────────────────────
// AgentAuditLog — immutable, append-only audit trail
// Every agent action gets a timestamped row BEFORE execution
// ────────────────────────────────────────────────
const AgentAuditLogSchema = new mongoose.Schema(
  {
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TransactionRecord',
      required: true,
      index: true,
    },

    // Which step of the ReAct loop this entry represents
    step: {
      type: String,
      enum: ['THOUGHT', 'ACTION', 'COMPLIANCE_CHECK', 'OBSERVATION'],
      required: true,
    },

    // Tool info (for ACTION and OBSERVATION steps)
    toolName: { type: String, default: null },
    toolInput: { type: mongoose.Schema.Types.Mixed, default: null },
    toolOutput: { type: mongoose.Schema.Types.Mixed, default: null },

    // Agent reasoning (for THOUGHT steps)
    thoughtProcess: { type: String, default: null },

    // Compliance verdict (for COMPLIANCE_CHECK steps)
    complianceVerified: { type: Boolean, default: null },
    complianceReason: { type: String, default: null },

    // State transition metadata
    fromState: { type: String, default: null },
    toState: { type: String, default: null },

    // Error tracking
    error: { type: String, default: null },
  },
  {
    timestamps: true,
    // Make audit logs effectively immutable — no updates allowed
    strict: true,
  }
);

// Index for fast lookups by transaction + chronological order
AgentAuditLogSchema.index({ transactionId: 1, createdAt: 1 });

module.exports = mongoose.model('AgentAuditLog', AgentAuditLogSchema);
