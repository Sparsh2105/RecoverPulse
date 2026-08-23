const mongoose = require('mongoose');

// ────────────────────────────────────────────────
// TransactionRecord — core entity for every failed payment
// ────────────────────────────────────────────────
const TransactionRecordSchema = new mongoose.Schema(
  {
    // Customer info
    customerName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },

    // Payment info
    originalAmount: { type: Number, required: true },
    currency: { type: String, default: 'INR', uppercase: true },
    paymentId: { type: String, trim: true }, // external payment gateway ID

    // Error classification
    errorCode: { type: String, required: true, trim: true },
    errorCategory: {
      type: String,
      enum: ['infra', 'soft_decline', 'hard_decline'],
      default: null,
    },

    // Finite State Machine state
    state: {
      type: String,
      enum: [
        'FAILED_PAYMENT_INGESTED',
        'SILENT_RETRY_SCHEDULED',
        'OUTREACH_INITIATED',
        'MANDATE_PENDING_AUTH',
        'DISCOUNT_GATED_LINK',
        'STOPPING_RULE_TRIGGERED',
        'RECOVERY_FAILED',
        'RECOVERED',
        'ESCALATED_TO_HUMAN',
      ],
      default: 'FAILED_PAYMENT_INGESTED',
    },

    // Recovery tracking
    promisedDate: { type: Date, default: null },
    activePaymentLink: { type: String, default: null },
    mandateId: { type: String, default: null },
    settlementDiscountApplied: { type: Number, default: 0 },

    // Escalation
    escalationReason: { type: String, default: null },

    // Agent tracking
    retryCount: { type: Number, default: 0 },
    maxRetries: { type: Number, default: 3 },
    outreachCount: { type: Number, default: 0 },
    lastContactedAt: { type: Date, default: null },
    recoveredAmount: { type: Number, default: 0 },
  },
  {
    timestamps: true, // auto-manages createdAt & updatedAt
  }
);

// Indexes for common queries
TransactionRecordSchema.index({ state: 1 });
TransactionRecordSchema.index({ phone: 1 });
TransactionRecordSchema.index({ createdAt: -1 });

module.exports = mongoose.model('TransactionRecord', TransactionRecordSchema);
