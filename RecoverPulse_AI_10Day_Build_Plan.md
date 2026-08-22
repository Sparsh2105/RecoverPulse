# RecoverPulse AI — Solo Builder's 10-Day Execution Plan

*Autonomous Multi-Channel Revenue Recovery & Mandate Orchestrator*

> This is a solo-founder build plan. It assumes you have basic Node.js/React experience and ~4–6 focused hours/day. Where the original blueprint named a specific vendor, I've kept it but noted a lighter-weight swap in case you hit friction (e.g., API approval delays, sandbox limits) — pick one path and don't context-switch mid-build.

---

## 0.1 Feature Priority — Build Order

Not everything in the original blueprint is load-bearing for the evaluation bar ("show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail"). Build top-down. Don't touch P2 until every P0 item is demo-solid.

### P0 — Core (must work flawlessly, this is what gets judged)
| # | Feature | Why it's P0 |
|---|---|---|
| 1 | Failed-payment webhook ingestion + root-cause triage | Entry point for everything; "detect revenue at risk" |
| 2 | Finite state machine w/ enforced legal transitions | Prevents silent data corruption during demo |
| 3 | ReAct agent core (Thought → Action → Observation) | The "agent" in "build an agent" |
| 4 | Compliance Cop + dispute/opt-out stopping rules | Explicitly named in the bar — non-negotiable |
| 5 | Contact-window + discount-bound enforcement (in code, not just prompt) | "Compliant escalation" — judges will test edge cases |
| 6 | Immutable `AgentAuditLog` audit trail | Explicitly named in the bar |
| 7 | One real payment rail integration (Razorpay: links + mandate) | "Recover the money" needs to be real, not simulated |
| 8 | One real two-way conversational channel (WhatsApp/Twilio) | Proves negotiation, not just outbound blasting |
| 9 | Batch runner (50 records) + analytics summary (₹ recovered, recovery %, exception list) | This IS the bar — "measured money recovered across a batch" |
| 10 | Live dashboard (transaction list + ReAct feed, real-time) | Makes the above visible/demo-able |

### P1 — Strong extras (add only once all P0 is demo-solid, e.g. Day 8–9 if ahead of schedule)
| # | Feature | Notes |
|---|---|---|
| 11 | Email channel (Resend) for hard-decline credential updates | Easy add, reuses existing tool-call pattern |
| 12 | Promise-to-pay tracker view (dedicated UI for pending mandates by date) | Cheap to build once mandate data exists, adds a "direction" from the brief |
| 13 | Deployed, publicly reachable version (Vercel/Render) | Removes localhost/ngrok risk on demo day |

### P2 — Nice-to-have / cut first if behind schedule
| # | Feature | Notes |
|---|---|---|
| 14 | Hinglish Voice Recovery (TTS audio notes) | Flashy but not in the bar's wording; highest effort-to-payoff risk |
| 15 | Separate B2B receivables chaser module | A whole extra "direction" — don't split focus, your payment-failure flow already generalizes conceptually |
| 16 | Checkout-abandonment flow as a distinct trigger type | Only add if payment-failure flow is fully done early |
| 17 | Mandate retry sequencer as a standalone visual/module | Silent retry logic already covers the underlying mechanic; a dedicated UI for it is polish, not substance |

**Rule of thumb for the 10-day plan below:** Days 1–7 are entirely P0. Day 8 is P0 wrap-up (batch + analytics). Day 9 is P1, with P2 only attempted if you're genuinely ahead. Day 10 is hardening — never new features.

---

## 0. Tech Stack (final, opinionated)

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite + Tailwind + Lucide Icons | Fast dev loop, matches blueprint |
| Realtime | Socket.IO (not raw WebSocket) | Auto-reconnect, rooms per transaction — saves you debugging raw WS |
| Backend | Node.js + Express | Matches blueprint, single language across stack |
| DB | MongoDB Atlas (free tier) | Matches blueprint, generous free tier, easy schema flexibility |
| AI | Gemini 2.0 Flash (function calling) | Fast + cheap for a hackathon budget; direct tool-calling API |
| Payments | Razorpay Node SDK (Test Mode) | Matches blueprint — Payment Links + Subscriptions API for mandates |
| Messaging | Twilio WhatsApp Sandbox | Matches blueprint; free sandbox, no business verification needed |
| Email | Resend API | Matches blueprint; generous free tier, simple API |
| Voice | Browser Web Speech API (TTS) *or* a pre-recorded Hinglish snippet mapped by template | Avoids needing a paid TTS vendor; still "plays" in the demo |
| Tunneling | ngrok | For Twilio + Razorpay webhooks to reach `localhost` |
| Deployment (optional, Day 10) | Frontend → Vercel, Backend → Render/Railway | Free tiers, fast deploy |

**Non-negotiable scope cut for 10 days:** Voice recovery (Feature D) is the first thing to descope if you fall behind. It's a nice-to-have demo flourish, not core to proving the agentic recovery loop. Build it last, on Day 9, only if on schedule.

---

## 1. System Architecture

### 1.1 High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          REACT DASHBOARD (Vite)                      │
│  ┌────────────┐  ┌───────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │ Batch       │  │ Live ReAct     │  │ Transaction  │  │ Analytics  │ │
│  │ Runner UI   │  │ Feed (Socket)  │  │ Detail Panel │  │ Summary    │ │
│  └─────┬──────┘  └───────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
└────────┼─────────────────┼──────────────────┼────────────────┼───────┘
         │ REST            │ Socket.IO         │ REST            │ REST
         ▼                 ▼                  ▼                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     EXPRESS BACKEND API SERVER                       │
│                                                                        │
│  ┌───────────────┐   ┌────────────────────┐   ┌───────────────────┐ │
│  │ Webhook        │   │ State Machine       │   │ Socket.IO Emitter  │ │
│  │ Receivers      │──▶│ Orchestrator        │──▶│ (Brain Log stream) │ │
│  │ (Razorpay/     │   │ (per transactionId) │   └───────────────────┘ │
│  │  Twilio/Sim)   │   └─────────┬──────────┘                         │
│  └───────────────┘             │                                     │
│                                  ▼                                     │
│                    ┌──────────────────────────┐                      │
│                    │   AGENT CORE (ReAct loop)  │                      │
│                    │  Thought → Action → Obs.   │                      │
│                    └────────────┬─────────────┘                      │
│                                  │                                     │
│         ┌────────────────────────┼─────────────────────────┐         │
│         ▼                        ▼                         ▼         │
│  ┌─────────────┐        ┌─────────────────┐        ┌──────────────┐ │
│  │ Root-Cause   │        │ Gemini Tool-     │        │ Compliance    │ │
│  │ Triage       │        │ Calling Layer    │        │ Cop (2nd LLM  │ │
│  │ Engine       │        │ (intent/date/    │        │ pass, audits  │ │
│  │              │        │  amount parsing) │        │ every outbound│ │
│  └─────────────┘        └────────┬─────────┘        │ msg)          │ │
│                                    │                   └──────────────┘ │
│                    ┌───────────────┼────────────────┐                 │
│                    ▼               ▼                ▼                 │
│           ┌────────────┐  ┌──────────────┐  ┌──────────────┐        │
│           │ Razorpay    │  │ Twilio        │  │ Resend        │        │
│           │ Tool        │  │ WhatsApp Tool │  │ Email Tool    │        │
│           │ (links,     │  │ (send/receive)│  │ (dynamic HTML)│        │
│           │  mandates)  │  └──────────────┘  └──────────────┘        │
│           └────────────┘                                              │
└─────────────────────────────────────────────────────────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
┌────────────────┐      ┌────────────────┐       ┌────────────────┐
│ Razorpay Test    │      │ Twilio WhatsApp │       │  Resend Email   │
│ Sandbox          │      │ Sandbox         │       │  API            │
└────────────────┘      └────────────────┘       └────────────────┘

                    ┌──────────────────────────┐
                    │      MongoDB Atlas         │
                    │ TransactionRecord           │
                    │ AgentAuditLog                │
                    │ ConversationHistory          │
                    └──────────────────────────┘
```

### 1.2 The ReAct Agent Loop (per transaction, per turn)

```
 ┌─────────────────────────────────────────────────────────────┐
 │  TRIGGER: new webhook event OR inbound WhatsApp/email reply   │
 └───────────────────────────┬────────────────────────────────┘
                              ▼
                    ┌──────────────────┐
                    │  1. LOAD CONTEXT   │  (txn record + full convo history from Mongo)
                    └─────────┬────────┘
                              ▼
                    ┌──────────────────┐
                    │  2. THOUGHT        │  Gemini reasons over context,
                    │  (LLM call #1)     │  decides next action + emits reasoning text
                    └─────────┬────────┘
                              ▼
                    ┌──────────────────┐
                    │  3. STOPPING-RULE  │  Regex + LLM classifier checks for
                    │  PRE-CHECK         │  dispute/legal/opt-out keywords
                    └─────────┬────────┘
                     Triggered│   Not triggered
                     ▼        │
         ┌──────────────────┐│
         │ ESCALATE_TO_HUMAN ││
         │ (halt, log, stop)  ││
         └──────────────────┘│
                              ▼
                    ┌──────────────────┐
                    │  4. ACTION         │  Agent calls a tool via Gemini function
                    │  (tool call)       │  calling: generate_upi_link,
                    │                    │  generate_mandate, send_whatsapp,
                    │                    │  apply_discount, schedule_retry, etc.
                    └─────────┬────────┘
                              ▼
                    ┌──────────────────┐
                    │  5. COMPLIANCE COP │  2nd, independent Gemini call reviews
                    │  (LLM call #2)     │  the DRAFT outbound message/action
                    │                    │  against a rules checklist before send
                    └─────────┬────────┘
                     Rejected │  Approved
                     ▼        │
         ┌──────────────────┐│
         │ REVISE or         ││
         │ ESCALATE           ││
         └──────────────────┘│
                              ▼
                    ┌──────────────────┐
                    │  6. OBSERVATION    │  Tool executes → result captured
                    │  (execute + log)   │  (link created, message sent, etc.)
                    └─────────┬────────┘
                              ▼
                    ┌──────────────────┐
                    │  7. PERSIST + EMIT │  Write AgentAuditLog row, update
                    │                    │  TransactionRecord.state, emit
                    │                    │  socket event to dashboard
                    └──────────────────┘
```

### 1.3 Finite State Machine (as designed in blueprint — keep as-is)

```
[FAILED_PAYMENT_INGESTED]
        │
        ├── bank/infra error ─────────────► [SILENT_RETRY_SCHEDULED] ──► [RECOVERED]
        │
        └── customer friction
                 │
                 ▼
        [OUTREACH_INITIATED]
                 │
                 ├── negotiates date ─────► [MANDATE_PENDING_AUTH] ─────► [RECOVERED]
                 ├── negotiates price ────► [DISCOUNT_GATED_LINK] ──────► [RECOVERED]
                 ├── dispute/stop keyword ─► [STOPPING_RULE_TRIGGERED] ──► [ESCALATED_TO_HUMAN]
                 └── no response/exhausted ► [RECOVERY_FAILED] ──────────► [ESCALATED_TO_HUMAN]
```

Implement this literally as a `state` enum field + a small `transitions.js` map of `{currentState: {event: nextState}}` so illegal transitions throw rather than silently corrupt data. This single guardrail will save you from a lot of demo-day bugs.

### 1.4 Data Pipelines

**Pipeline A — Inbound Webhook Ingestion**
```
Payment Gateway (or /simulate/webhook in dev) 
  → POST /webhooks/payment-failed 
  → validate signature (or dev bypass flag) 
  → upsert TransactionRecord (state=FAILED_PAYMENT_INGESTED) 
  → enqueue triage job 
  → Root-Cause Triage Engine classifies errorCode 
  → branch to Silent Retry OR Outreach
```

**Pipeline B — Two-Way Conversation**
```
Customer WhatsApp reply 
  → Twilio webhook → POST /webhooks/whatsapp 
  → resolve transactionId from phone number (active txn lookup) 
  → append to ConversationHistory 
  → trigger ReAct loop (see 1.2) 
  → outbound message sent back via Twilio 
  → Socket.IO emits to dashboard in real time
```

**Pipeline C — Batch Simulation (demo mode)**
```
/data/seed-50-records.json 
  → POST /batch/run 
  → for each record: enqueue as if webhook arrived (with configurable delay/speed slider) 
  → ReAct loop runs for all 50 concurrently (rate-limited queue, concurrency=5) 
  → Analytics Engine aggregates on completion → Summary Screen
```

**Pipeline D — Compliance Audit Trail**
```
Every agent action 
  → AgentAuditLog row written BEFORE execution (thought+action) 
  → compliance verdict appended AFTER cop review 
  → execution result appended AFTER tool call 
  → immutable, append-only — never edit past rows (for "zero hallucination, full audit" demo claim)
```

---

## 2. MongoDB Schemas (implementation-ready)

```js
// models/TransactionRecord.js
const TransactionSchema = new mongoose.Schema({
  customerName: String,
  phone: String,
  email: String,
  originalAmount: Number,
  currency: { type: String, default: "INR" },
  errorCode: String,
  errorCategory: { type: String, enum: ["infra", "soft_decline", "hard_decline"] },
  state: {
    type: String,
    enum: ["FAILED_PAYMENT_INGESTED","SILENT_RETRY_SCHEDULED","OUTREACH_INITIATED",
           "MANDATE_PENDING_AUTH","DISCOUNT_GATED_LINK","STOPPING_RULE_TRIGGERED",
           "RECOVERY_FAILED","RECOVERED","ESCALATED_TO_HUMAN"],
    default: "FAILED_PAYMENT_INGESTED"
  },
  promisedDate: Date,
  activePaymentLink: String,
  mandateId: String,
  settlementDiscountApplied: { type: Number, default: 0 },
  escalationReason: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// models/AgentAuditLog.js
const AuditLogSchema = new mongoose.Schema({
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "TransactionRecord" },
  step: { type: String, enum: ["THOUGHT","ACTION","COMPLIANCE_CHECK","OBSERVATION"] },
  toolName: String,
  thoughtProcess: String,
  toolInput: mongoose.Schema.Types.Mixed,
  toolOutput: mongoose.Schema.Types.Mixed,
  complianceVerified: Boolean,
  complianceReason: String,
  timestamp: { type: Date, default: Date.now }
});

// models/ConversationMessage.js
const MessageSchema = new mongoose.Schema({
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "TransactionRecord" },
  direction: { type: String, enum: ["inbound","outbound"] },
  channel: { type: String, enum: ["whatsapp","email","voice"] },
  body: String,
  timestamp: { type: Date, default: Date.now }
});
```

---

## 3. The 10-Day Plan

Each day: **Goal → Tasks → Deliverable (end-of-day demo-able artifact)**. Don't move to the next day until the deliverable actually runs.

### Day 1 — Foundations & Skeleton
**Goal:** Repo, infra, and a webhook that writes to Mongo.
- Init monorepo: `/client` (Vite React + Tailwind) and `/server` (Express).
- Set up MongoDB Atlas cluster, get connection string, define both schemas above.
- Set up `.env` files (Mongo URI, Gemini key, Razorpay test keys, Twilio SID/Auth/Sandbox number, Resend key).
- Build `POST /webhooks/payment-failed` (dev-mode, no signature check yet) → writes a `TransactionRecord`.
- Build `GET /transactions` and `GET /transactions/:id` REST endpoints.
- **Deliverable:** `curl` a fake failed-payment payload → see it appear in MongoDB Atlas dashboard.

### Day 2 — Root-Cause Triage + State Machine
**Goal:** Deterministic branching logic, no AI yet.
- Write `classifyErrorCode(errorCode)` → returns `infra | soft_decline | hard_decline`.
- Implement `transitions.js` state map + `applyTransition(txn, event)` helper that throws on illegal transitions.
- Wire triage engine: infra → `SILENT_RETRY_SCHEDULED`; soft/hard decline → `OUTREACH_INITIATED`.
- Build the Silent Retry Sequencer as a simple cron/`setTimeout`-based scheduler (a `node-cron` job checking for due retries every minute is enough for a hackathon).
- **Deliverable:** Post 3 different errorCodes → watch each transaction land in the correct state via a `GET /transactions` call.

### Day 3 — Socket.IO + Minimal Dashboard Shell
**Goal:** Real-time plumbing before you add AI complexity on top.
- Add Socket.IO server; emit a `txn:updated` event on every state change.
- Scaffold React dashboard: transaction list table, connects to socket, updates live.
- Build "Batch Runner" button (stub — just re-posts 3 dummy records for now).
- **Deliverable:** Open dashboard in browser, trigger webhook from terminal, see row appear/update live without refresh.

### Day 4 — Gemini Tool-Calling Core (the ReAct brain)
**Goal:** First real LLM-driven decision.
- Get Gemini API key, install SDK, write `agentCore.js` implementing the loop from §1.2 (Thought → stopping-rule pre-check → Action/tool-call → Compliance Cop → Observation → persist/emit).
- Define tool schemas (function declarations) for Gemini: `send_whatsapp_message`, `generate_payment_link`, `generate_upi_mandate`, `apply_settlement_discount`, `schedule_retry`, `escalate_to_human`.
- For now, stub the actual tool *execution* (log to console) — focus on getting Gemini to reliably choose the right tool given a conversation context.
- Write every `THOUGHT`/`ACTION`/`OBSERVATION` step into `AgentAuditLog`.
- **Deliverable:** Feed the agent a fake inbound message like *"bhai salary 1st ko aayegi"* → see it correctly choose `generate_upi_mandate` with the right extracted date, logged to Mongo and streamed to dashboard.

### Day 5 — Compliance Cop + Stopping Rules
**Goal:** The safety layer that makes this "agentic," not "reckless."
- Build the independent Compliance Cop: a second Gemini call with a strict system prompt + checklist (no false urgency, no threats, discount within 5–10% bound, contact-window check, no more than N follow-ups).
- Implement the dispute/opt-out keyword pre-check (regex list: "cancel", "sue", "legal", "stop", "chargeback", "harassment", etc.) as a fast pre-filter *before* even calling the LLM, then confirm with the LLM classifier for nuance.
- Wire `ESCALATED_TO_HUMAN` transition + `escalationReason` field.
- Enforce contact window (8 AM–7 PM IST) at the tool-execution layer (not just the prompt) — reject/queue any `send_whatsapp_message` call outside that window.
- **Deliverable:** Send *"I already cancelled, stop messaging me"* → watch it hard-stop, turn red in dashboard, log reason `dispute_detected`.

### Day 6 — Razorpay Integration (Real Test-Mode Payments)
**Goal:** Wire the money rails.
- Razorpay test account, generate test API keys.
- Implement `generate_payment_link` tool → Razorpay Payment Links API.
- Implement `generate_upi_mandate` tool → Razorpay Subscriptions API with a future `start_at` date.
- Implement `apply_settlement_discount` tool with a hard-coded bound (5–10%) enforced in code, not just prompt — reject any LLM-proposed value outside range regardless of what the model says.
- Add Razorpay webhook receiver `POST /webhooks/razorpay` to catch `payment.captured` → transition txn to `RECOVERED`.
- **Deliverable:** Trigger a mandate creation from a simulated conversation → get a real Razorpay test-mode mandate URL back, visible in Razorpay dashboard.

### Day 7 — Twilio WhatsApp Two-Way Integration
**Goal:** Replace simulated messages with your actual phone.
- Twilio WhatsApp Sandbox setup, join sandbox from your phone.
- ngrok tunnel → configure Twilio webhook URL to `POST /webhooks/whatsapp`.
- Implement `send_whatsapp_message` tool for real (Hinglish templates via Gemini generation, not hardcoded).
- Build the `upi://pay?...` deep-link string generator for 1-tap checkout inside the WhatsApp message.
- **Deliverable:** From your own phone, message the sandbox number with a soft-decline scenario reply; get a real Hinglish WhatsApp reply back with a working Razorpay test link.

### Day 8 — Email (Resend) + Batch Seed Data + Batch Runner
**Goal:** Fill out remaining channel + load the 50-record demo set.
- Implement Resend email tool for dynamic HTML reminders (used for hard-decline credential-update flow).
- Write `/data/seed-50-records.json` — generate 50 synthetic records matching the category breakdown in the blueprint (22 soft, 10 hard, 8 infra, 4 price-sensitive, 6 disputes/opt-outs). Use a script (`node scripts/generateSeed.js`) so it's reproducible, not hand-typed.
- Build real `POST /batch/run` — queues all 50 through the pipeline with concurrency limit (e.g., `p-limit` at 5) and a speed multiplier so the demo doesn't take 20 minutes.
- **Deliverable:** Click "Run Batch" → watch 50 records process live in the dashboard feed at demo speed.

### Day 9 — Dashboard Polish + Analytics Summary + (stretch) Voice
**Goal:** Make it look and feel finished.
- Build the Analytics Summary screen: Gross Value at Risk, Recovered/Mandated total + %, Silent Recoveries total, Honest Exception List table with reason codes.
- Build the Live ReAct Feed as a proper scrolling terminal-style component (color-coded by step type).
- Build per-transaction detail drawer: conversation thread + audit log + compliance verdicts, side by side.
- **Stretch only if on schedule:** Voice Recovery — use browser `SpeechSynthesis` API with a Hindi/English voice, or pre-generate 3–4 template Hinglish voice notes and pick by scenario type; embed a simple `<audio>` player in the audit feed.
- **Deliverable:** Full demo flow runs start to finish, dashboard looks presentable, no console errors.

### Day 10 — Hardening, Edge Cases, Demo Script, Deploy
**Goal:** De-risk the live demo.
- Test every FSM branch manually at least once end-to-end (recovered via mandate, recovered via discount, silent retry, escalated via dispute, escalated via exhaustion).
- Add basic error handling around every external API call (Razorpay/Twilio/Resend/Gemini) so one flaky call doesn't crash the batch run — catch, log to audit as `toolOutput.error`, transition to a safe state instead of throwing.
- Write a literal demo script (what you'll type into WhatsApp, in what order, timed) — practice it twice.
- Deploy (optional but recommended): backend → Render/Railway, frontend → Vercel, update env vars and Twilio/Razorpay webhook URLs to point at the deployed backend.
- Record a 2–3 min backup video walkthrough in case live demo/network fails.
- **Deliverable:** A rehearsed, resilient, end-to-end demo — live or on video — plus this repo pushed and README updated with setup instructions.

---

## 4. Definition of Done (self-check before demo day)

- [ ] Webhook → triage → correct state transition, for all 3 error categories
- [ ] ReAct loop's Thought/Action/Observation is visible live on the dashboard
- [ ] A real Hinglish WhatsApp round-trip works from your own phone
- [ ] A real Razorpay test-mode payment link **and** a future-dated mandate can be generated from a live conversation
- [ ] Settlement discount is hard-bounded in code (not just prompt-suggested)
- [ ] Dispute/opt-out message reliably triggers `ESCALATED_TO_HUMAN` and halts further outreach
- [ ] Contact-window enforcement actually blocks a send attempt outside 8 AM–7 PM IST
- [ ] Batch of 50 runs end-to-end and produces the summary metrics screen
- [ ] Every agent action has a corresponding, timestamped `AgentAuditLog` row
- [ ] You have a rehearsed demo script and a backup video

---

## 5. Risk Notes / Things That Commonly Eat a Day

- **Twilio Sandbox drift:** the sandbox join code/session can expire — reconfirm it the morning of Day 7 and again before your final demo.
- **ngrok URL changes on restart** (free tier) — you'll need to re-paste the URL into Twilio/Razorpay webhook settings each time you restart ngrok unless you pay for a static domain.
- **Gemini function-calling reliability with code-switched Hinglish:** budget extra time on Day 4 for prompt iteration; give the model explicit few-shot examples of Hinglish replies mapped to the correct tool call.
- **Razorpay mandate/subscription API test-mode quirks:** read the test-mode docs closely before Day 6 — some mandate flows require a linked test plan ID, not just a raw amount.
