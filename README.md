# RecoverPulse AI

**Autonomous Multi-Channel Revenue Recovery & Mandate Orchestrator**

An AI agent that autonomously recovers failed subscription payments via WhatsApp + Email, with real Razorpay payment links, UPI AutoPay mandates, compliance enforcement, and a live real-time dashboard.

---

## What It Does

When a customer's payment fails, RecoverPulse AI:

1. **Ingests** the failure via a webhook (or Razorpay fires it automatically in production)
2. **Classifies** the error — bank/infra down vs card issue vs insufficient funds
3. **Routes** it — infra errors get silent Razorpay retries; customer-friction errors start AI outreach
4. **Runs a ReAct agent loop** (Groq LLM) — Thought → Compliance Check → Action → Observation
5. **Sends real WhatsApp messages** in Hinglish via Meta's Cloud API
6. **Sends HTML recovery emails** via Resend for hard-decline (card expired) scenarios
7. **Creates real Razorpay payment links and UPI mandates** from customer conversations
8. **Enforces compliance** — contact window (8AM–7PM IST), outreach cap (5 messages), discount bounds (5–10%), dispute detection
9. **Updates the dashboard live** via Socket.IO — every state change is visible in real time
10. **Closes the loop** — Razorpay webhook fires when customer pays → transaction → RECOVERED

---

## Tech Stack

| Layer | Choice |
|---|---|
| Backend | Node.js + Express |
| Database | MongoDB Atlas (Mongoose) |
| Real-time | Socket.IO |
| AI | Groq API (`openai/gpt-oss-120b`) |
| Payments | Razorpay (Payment Links + Subscriptions/UPI AutoPay) |
| WhatsApp | Meta WhatsApp Cloud API (primary) + Twilio sandbox (fallback) |
| Email | Resend |
| Frontend | React + Vite + Tailwind CSS + Framer Motion + Lucide React |

---

## Quick Start

### Prerequisites

- Node.js 18+
- MongoDB Atlas account (free tier works)
- Groq API key — [console.groq.com](https://console.groq.com)
- Razorpay test account — [dashboard.razorpay.com](https://dashboard.razorpay.com)
- Meta Developer account for WhatsApp Cloud API — [developers.facebook.com](https://developers.facebook.com)
- (Optional) Resend account for emails — [resend.com](https://resend.com)
- (Optional) Twilio account for WhatsApp fallback — [console.twilio.com](https://console.twilio.com)

### 1. Clone and install

```bash
git clone https://github.com/your-username/recoverpulse.git
cd recoverpulse

# Install server dependencies
cd server && npm install

# Install client dependencies
cd ../client && npm install
```

### 2. Configure environment

```bash
cd server
cp .env.example .env
```

Fill in `.env`:

```env
# MongoDB
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/recoverpulse

# Groq AI
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxx

# Razorpay (Test Mode)
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret

# WhatsApp Cloud API (Meta)
WHATSAPP_TOKEN=EAAPevxxxxxxxxxxxxxxxx
WHATSAPP_PHONE_ID=1295657016960326
WHATSAPP_VERIFY_TOKEN=recoverpulse_verify

# Resend Email (optional)
RESEND_API_KEY=re_xxxxxxxxxxxx
RESEND_FROM_EMAIL=onboarding@resend.dev

# Twilio WhatsApp (optional fallback)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
```

### 3. Generate seed data

```bash
cd server
node scripts/generateSeed.js
```

### 4. Start servers

```bash
# Terminal 1 — Backend
cd server && npm run dev

# Terminal 2 — Frontend
cd client && npm run dev
```

Open **http://localhost:5173**

### 5. Set up webhooks (for inbound WhatsApp)

Start a tunnel to expose your local server:

```bash
cloudflared tunnel --url http://localhost:5000
```

Copy the `https://xxx.trycloudflare.com` URL and configure:

- **Meta WhatsApp**: App Dashboard → WhatsApp → Configuration → Webhook
  - Callback URL: `https://xxx.trycloudflare.com/api/webhooks/whatsapp-cloud`
  - Verify token: `recoverpulse_verify`
  - Subscribe to: `messages`

- **Razorpay** (optional — poller handles this in dev):
  - Dashboard → Settings → Webhooks → `https://xxx.trycloudflare.com/api/webhooks/razorpay`

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/webhooks/payment-failed` | Ingest a failed payment event |
| POST | `/api/webhooks/razorpay` | Razorpay payment captured event |
| GET | `/api/webhooks/whatsapp-cloud` | Meta webhook verification |
| POST | `/api/webhooks/whatsapp-cloud` | Inbound WhatsApp message (Meta) |
| POST | `/api/webhooks/whatsapp` | Inbound WhatsApp message (Twilio) |
| GET | `/api/transactions` | List transactions (paginated) |
| GET | `/api/transactions/stats/summary` | Aggregate stats |
| GET | `/api/transactions/:id` | Single transaction + audit log + conversations |
| POST | `/api/agent/process` | Manually trigger one agent turn |
| POST | `/api/batch/run` | Run the 50-record demo batch |
| GET | `/api/health` | Health check |

---

## Demo Scenarios

### Scenario 1 — Soft Decline → UPI Mandate

1. Click **Simulate Failed Payment** → wait for "Outreach" badge
2. Send from WhatsApp: *"bhai salary 1st ko aayegi"*
3. Agent creates a real Razorpay mandate → you receive the link on WhatsApp
4. Pay via the link → dashboard → **Recovered** (green) within 8 seconds

### Scenario 2 — Hard Decline → Email Recovery

1. Keep clicking Simulate until you get `CARD_EXPIRED`
2. Agent auto-sends an HTML recovery email to the transaction's email address
3. Email contains a "Complete Payment →" button linked to a Razorpay payment page

### Scenario 3 — Dispute → Escalation

1. Open Agent Panel on any "Outreach" transaction
2. Click **"Dispute (STOP)"** quick test
3. Regex pre-filter catches it instantly → badge → **Escalated** (amber)
4. No Groq call made — zero LLM cost for clear disputes

### Scenario 4 — Batch Run (50 records)

1. Click **⚡ Run Batch (50)**
2. Watch the semicircular gauge animate 0→100%
3. Recovery Pipeline nodes light up as transactions progress
4. 6 dispute records auto-escalate, 8 infra records silently retry, rest get AI outreach
5. Analytics tab shows final breakdown with Exception List

---

## Architecture

```
Customer's payment fails
        ↓
POST /api/webhooks/payment-failed
        ↓
Triage: infra → silent retry | soft/hard → OUTREACH_INITIATED
        ↓
runAgentTurn(txnId, 'PAYMENT_FAILED')
        ↓
Groq LLM: THOUGHT → tool selection
        ↓
Compliance Cop: contact window + outreach cap + discount bounds
        ↓
Tool execution: send_whatsapp_message | send_email | generate_payment_link
               | generate_upi_mandate | apply_settlement_discount | escalate_to_human
        ↓
AgentAuditLog written → Socket.IO emits → Dashboard updates live
        ↓
Customer pays → Razorpay webhook → RECOVERED
```

---

## FSM States

```
FAILED_PAYMENT_INGESTED → SILENT_RETRY_SCHEDULED → RECOVERED
                       ↘                         ↗ OUTREACH_INITIATED
                         OUTREACH_INITIATED → MANDATE_PENDING_AUTH → RECOVERED
                                           → DISCOUNT_GATED_LINK  → RECOVERED
                                           → STOPPING_RULE_TRIGGERED → ESCALATED_TO_HUMAN
                                           → RECOVERY_FAILED → ESCALATED_TO_HUMAN
```

---

## Compliance Rules (enforced in code, not just prompts)

| Rule | Value | Where enforced |
|---|---|---|
| Contact window | 8 AM – 7 PM IST | `complianceCop.checkHardRules()` |
| Outreach cap | Max 5 messages | `complianceCop.checkHardRules()` |
| Discount bounds | 5–10% only | `agentTools.js` clamp + compliance cop |
| Dispute keywords | cancel, sue, legal, chargeback, ... | Regex pre-filter before any LLM call |
| Duplicate webhooks | By paymentId | `webhookController.js` dedup check |

---

## Environment Variables

See `server/.env.example` for the full list with descriptions.

Key variables:

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | ✅ | MongoDB Atlas connection string |
| `GROQ_API_KEY` | ✅ | Groq API key for LLM calls |
| `RAZORPAY_KEY_ID` | ✅ | Razorpay test/live key |
| `RAZORPAY_KEY_SECRET` | ✅ | Razorpay secret |
| `WHATSAPP_TOKEN` | ✅ | Meta WhatsApp Cloud API access token |
| `WHATSAPP_PHONE_ID` | ✅ | Meta phone number ID |
| `BYPASS_CONTACT_WINDOW` | ❌ | Set `true` for testing outside 8AM-7PM IST |

---

## Project Structure

```
recoverpulse/
├── client/                    # React + Vite frontend
│   └── src/
│       ├── App.jsx            # Main dashboard (all views + components)
│       └── services/
│           ├── api.js         # REST API client
│           └── socket.js      # Socket.IO client
└── server/
    ├── data/
    │   └── seed-50-records.json  # Batch demo seed data
    ├── scripts/
    │   ├── generateSeed.js    # Regenerate seed data
    │   └── testDay6.js        # Razorpay integration test
    └── src/
        ├── config/
        │   ├── db.js          # MongoDB connection
        │   ├── socket.js      # Socket.IO singleton
        │   ├── razorpay.js    # Razorpay SDK singleton
        │   ├── twilio.js      # Twilio SDK singleton
        │   ├── whatsapp.js    # Meta Cloud API client
        │   └── resend.js      # Resend SDK singleton
        ├── controllers/
        │   ├── webhookController.js
        │   ├── razorpayWebhookController.js
        │   ├── twilioWebhookController.js
        │   ├── whatsappCloudController.js
        │   ├── transactionController.js
        │   ├── agentController.js
        │   └── batchController.js
        ├── middleware/
        │   └── validate.js    # Pure payload validation
        ├── models/
        │   ├── TransactionRecord.js
        │   ├── AgentAuditLog.js
        │   └── ConversationMessage.js
        ├── routes/
        │   ├── webhookRoutes.js
        │   ├── razorpayWebhookRoutes.js
        │   ├── transactionRoutes.js
        │   ├── agentRoutes.js
        │   └── batchRoutes.js
        └── services/
            ├── triageService.js    # Error code classification
            ├── stateMachine.js     # FSM transitions
            ├── retryScheduler.js   # Silent retry pipeline
            ├── agentCore.js        # ReAct loop (Groq)
            ├── agentTools.js       # Tool schemas + executors
            ├── complianceCop.js    # Two-layer compliance review
            ├── emailService.js     # HTML recovery emails
            └── razorpayPoller.js   # Dev-mode payment detection
```
