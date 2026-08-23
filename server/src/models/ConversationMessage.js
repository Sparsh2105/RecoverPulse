const mongoose = require('mongoose');

// ────────────────────────────────────────────────
// ConversationMessage — two-way conversation history
// Stores every inbound (customer) and outbound (agent) message
// ────────────────────────────────────────────────
const ConversationMessageSchema = new mongoose.Schema(
  {
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TransactionRecord',
      required: true,
      index: true,
    },

    // Message direction
    direction: {
      type: String,
      enum: ['inbound', 'outbound'],
      required: true,
    },

    // Which channel was used
    channel: {
      type: String,
      enum: ['whatsapp', 'email', 'voice'],
      required: true,
    },

    // Message content
    body: { type: String, required: true },

    // External message ID (Twilio SID, Resend ID, etc.)
    externalMessageId: { type: String, default: null },

    // Delivery status tracking
    deliveryStatus: {
      type: String,
      enum: ['queued', 'sent', 'delivered', 'read', 'failed'],
      default: 'queued',
    },
  },
  {
    timestamps: true,
  }
);

// Index for fetching conversation thread in order
ConversationMessageSchema.index({ transactionId: 1, createdAt: 1 });

module.exports = mongoose.model('ConversationMessage', ConversationMessageSchema);
