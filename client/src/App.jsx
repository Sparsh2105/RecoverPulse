import { useState, useEffect, useCallback, useRef } from 'react';
import api from './services/api';
import socket from './services/socket';

const STATE_COLORS = {
  FAILED_PAYMENT_INGESTED:  { bg: 'bg-red-500/20',    text: 'text-red-400',    label: 'Ingested' },
  SILENT_RETRY_SCHEDULED:   { bg: 'bg-yellow-500/20', text: 'text-yellow-400', label: 'Retrying' },
  OUTREACH_INITIATED:       { bg: 'bg-blue-500/20',   text: 'text-blue-400',   label: 'Outreach' },
  MANDATE_PENDING_AUTH:     { bg: 'bg-purple-500/20', text: 'text-purple-400', label: 'Mandate Pending' },
  DISCOUNT_GATED_LINK:      { bg: 'bg-orange-500/20', text: 'text-orange-400', label: 'Discount Sent' },
  STOPPING_RULE_TRIGGERED:  { bg: 'bg-red-600/20',    text: 'text-red-500',    label: 'Stopped' },
  RECOVERY_FAILED:          { bg: 'bg-gray-500/20',   text: 'text-gray-400',   label: 'Failed' },
  RECOVERED:                { bg: 'bg-green-500/20',  text: 'text-green-400',  label: 'Recovered' },
  ESCALATED_TO_HUMAN:       { bg: 'bg-amber-500/20',  text: 'text-amber-400',  label: 'Escalated' },
};

// ── Quick-test message presets ──
const TEST_MESSAGES = [
  { label: 'UPI Mandate',    message: 'bhai salary 1st ko aayegi, tab pay kar dunga' },
  { label: 'Pay Now',        message: 'okay bhai, pay karna chahta hoon abhi' },
  { label: 'Discount',       message: 'poora amount afford nahi ho raha, kuch kam ho sakta hai?' },
  { label: 'Dispute (STOP)', message: 'I already cancelled this, stop messaging me' },
  { label: 'Legal Threat',   message: 'yeh fraud hai, main sue karunga tumhe' },
];

function StatCard({ label, value, accent = 'text-[var(--color-pulse-red)]' }) {
  return (
    <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-xl p-5 hover:border-[var(--color-border-hover)] transition-all duration-300">
      <p className="text-[var(--color-text-muted)] text-xs uppercase tracking-wider mb-2">{label}</p>
      <p className={`text-3xl font-bold font-[var(--font-mono)] ${accent}`}>{value}</p>
    </div>
  );
}

function TransactionRow({ txn, onClick, isSelected }) {
  const state = STATE_COLORS[txn.state] || { bg: 'bg-gray-500/20', text: 'text-gray-400', label: txn.state };
  const time = new Date(txn.createdAt).toLocaleString('en-IN', {
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short',
  });

  return (
    <tr
      onClick={onClick}
      className={`border-b border-[var(--color-border)] cursor-pointer transition-colors duration-200 ${
        isSelected
          ? 'bg-blue-500/10 border-l-2 border-l-blue-400'
          : 'hover:bg-[var(--color-bg-card-hover)]'
      }`}
    >
      <td className="py-3 px-4 text-sm font-medium">{txn.customerName}</td>
      <td className="py-3 px-4 text-sm text-[var(--color-text-secondary)] font-[var(--font-mono)]">{txn.phone}</td>
      <td className="py-3 px-4 text-sm font-semibold text-[var(--color-pulse-orange)] font-[var(--font-mono)]">
        {'\u20B9'}{txn.originalAmount.toLocaleString('en-IN')}
      </td>
      <td className="py-3 px-4 text-sm text-[var(--color-text-secondary)] font-[var(--font-mono)]">{txn.errorCode}</td>
      <td className="py-3 px-4">
        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${state.bg} ${state.text}`}>
          {state.label}
        </span>
      </td>
      <td className="py-3 px-4 text-xs text-[var(--color-text-muted)]">{time}</td>
    </tr>
  );
}

// ── Agent test panel (slide-in from right) ──
function AgentPanel({ txn, onClose }) {
  const [message, setMessage] = useState('');
  const [log, setLog] = useState([]);
  const [sending, setSending] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const logEndRef = useRef(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  const addLog = (type, text) => {
    setLog(prev => [...prev, { type, text, ts: new Date().toLocaleTimeString('en-IN') }]);
  };

  const send = async (msg) => {
    const m = (msg || message).trim();
    if (!m || sending) return;
    setMessage('');
    setSending(true);
    addLog('user', m);

    try {
      const res = await fetch('/api/agent/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId: txn._id, inboundMessage: m }),
      });
      const data = await res.json();

      if (data.success) {
        const d = data.data;
        if (d.complianceBlocked) {
          addLog('compliance', 'BLOCKED by Compliance Cop: ' + d.observation);
        } else {
          addLog('agent', 'Tool: ' + d.toolName);
          addLog('observation', d.observation);
          // Surface the Razorpay link as a separate clickable entry
          if (d.paymentLink) {
            addLog('link', d.paymentLink);
          }
        }
      } else {
        addLog('error', data.error || 'Agent error');
      }
    } catch (err) {
      addLog('error', err.message);
    } finally {
      setSending(false);
    }
  };

  // Simulates the Razorpay payment.captured webhook — closes the recovery loop
  const simulateCapture = async () => {
    if (capturing) return;
    setCapturing(true);
    addLog('system', 'Simulating Razorpay payment.captured webhook...');
    try {
      const data = await api.simulateRazorpayCapture(txn._id, txn.originalAmount);
      if (data.status === 'ok') {
        addLog('recovered', `Payment captured! Rs.${data.amountRecovered?.toLocaleString('en-IN') ?? txn.originalAmount} recovered. State → RECOVERED`);
      } else if (data.status === 'already_recovered') {
        addLog('recovered', 'Transaction is already in RECOVERED state.');
      } else {
        addLog('error', 'Capture response: ' + JSON.stringify(data));
      }
    } catch (err) {
      addLog('error', 'Capture failed: ' + err.message);
    } finally {
      setCapturing(false);
    }
  };

  const LOG_STYLES = {
    user:        'bg-blue-500/15 text-blue-300 self-end',
    agent:       'bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]',
    observation: 'bg-green-500/10 text-green-400 text-xs',
    link:        'bg-blue-500/10 text-blue-300 border border-blue-500/30 text-xs',
    compliance:  'bg-amber-500/15 text-amber-400 border border-amber-500/30',
    error:       'bg-red-500/15 text-red-400',
    system:      'bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] text-xs italic',
    recovered:   'bg-green-500/20 text-green-300 border border-green-500/30 font-semibold',
  };

  const state = STATE_COLORS[txn.state] || { bg: 'bg-gray-500/20', text: 'text-gray-400', label: txn.state };

  return (
    <div className="fixed top-0 right-0 h-full w-[420px] bg-[var(--color-bg-secondary)] border-l border-[var(--color-border)] flex flex-col z-50 shadow-2xl">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-sm">{txn.customerName}</h3>
          <p className="text-xs text-[var(--color-text-muted)] font-[var(--font-mono)] mt-0.5">{txn.phone}</p>
          <div className="flex items-center gap-2 mt-2">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${state.bg} ${state.text}`}>
              {state.label}
            </span>
            <span className="text-xs text-[var(--color-text-muted)]">
              {'\u20B9'}{txn.originalAmount.toLocaleString('en-IN')} &bull; {txn.errorCode}
            </span>
          </div>
          {txn.activePaymentLink && (
            <a
              href={txn.activePaymentLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-2 text-xs text-blue-400 underline underline-offset-2 hover:text-blue-300 transition-colors break-all"
            >
              🔗 {txn.mandateId ? 'Mandate' : 'Payment'} Link: {txn.activePaymentLink}
            </a>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] text-lg leading-none mt-1"
        >
          &times;
        </button>
      </div>

      {/* Quick-test presets */}
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <p className="text-xs text-[var(--color-text-muted)] mb-2 uppercase tracking-wider">Quick tests</p>
        <div className="flex flex-wrap gap-1.5">
          {TEST_MESSAGES.map(({ label, message: m }) => (
            <button
              key={label}
              onClick={() => send(m)}
              disabled={sending}
              className="px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--color-bg-card)] border border-[var(--color-border)] hover:border-[var(--color-border-hover)] disabled:opacity-40 transition-colors"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Razorpay payment capture simulation */}
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <p className="text-xs text-[var(--color-text-muted)] mb-2 uppercase tracking-wider">Razorpay</p>
        <button
          onClick={simulateCapture}
          disabled={capturing || txn.state === 'RECOVERED' || txn.state === 'ESCALATED_TO_HUMAN'}
          className="w-full px-3 py-2 rounded-lg text-xs font-semibold bg-green-500/15 text-green-400 border border-green-500/30 hover:bg-green-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
        >
          {capturing ? (
            <>
              <div className="w-3 h-3 border border-green-400 border-t-transparent rounded-full animate-spin" />
              Sending capture webhook...
            </>
          ) : txn.state === 'RECOVERED' ? (
            '✓ Already Recovered'
          ) : (
            `⚡ Simulate payment.captured → RECOVERED (Rs.${txn.originalAmount?.toLocaleString('en-IN')})`
          )}
        </button>
        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
          Fires a fake Razorpay webhook to close the recovery loop without ngrok.
        </p>
      </div>

      {/* Log */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
        {log.length === 0 && (
          <p className="text-xs text-[var(--color-text-muted)] text-center mt-8">
            Click a quick test or type a message to trigger the agent
          </p>
        )}
        {log.map((entry, i) => (
          <div key={i} className={`rounded-lg px-3 py-2 max-w-[90%] ${LOG_STYLES[entry.type]}`}>
            <p className="text-xs opacity-60 mb-0.5">{entry.type.toUpperCase()} &bull; {entry.ts}</p>
            {entry.type === 'link' ? (
              <a
                href={entry.text}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm underline underline-offset-2 break-all hover:text-blue-200 transition-colors"
              >
                🔗 {entry.text}
              </a>
            ) : (
              <p className="text-sm leading-snug">{entry.text}</p>
            )}
          </div>
        ))}
        {sending && (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <div className="w-3 h-3 border border-[var(--color-pulse-red)] border-t-transparent rounded-full animate-spin" />
            Agent thinking...
          </div>
        )}
        <div ref={logEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-[var(--color-border)]">
        <div className="flex gap-2">
          <input
            type="text"
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && send()}
            placeholder="Type customer message..."
            disabled={sending}
            className="flex-1 bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-border-hover)] disabled:opacity-40"
          />
          <button
            onClick={() => send()}
            disabled={!message.trim() || sending}
            className="px-4 py-2 bg-gradient-to-r from-[var(--color-pulse-red)] to-[var(--color-pulse-orange)] text-white text-sm font-semibold rounded-lg hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            Send
          </button>
        </div>
        <p className="text-xs text-[var(--color-text-muted)] mt-2">
          Click a row to open this panel. Razorpay links appear as clickable URLs in the log.
          Use "Simulate payment.captured" above to close the recovery loop without ngrok.
        </p>
      </div>
    </div>
  );
}

function App() {
  const [transactions, setTransactions] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [serverOnline, setServerOnline] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTxn, setSelectedTxn] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const [txnRes, statsRes] = await Promise.all([
        api.getTransactions(),
        api.getStats(),
      ]);
      setTransactions(txnRes.data);
      setStats(statsRes.data);
      setServerOnline(true);
      setError(null);
    } catch (err) {
      setError(err.message);
      setServerOnline(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    socket.connect();

    socket.on('connect', () => setServerOnline(true));
    socket.on('disconnect', () => setServerOnline(false));

    socket.on('txn:created', (newTxn) => {
      setTransactions(prev => [newTxn, ...prev]);
      api.getStats().then(res => setStats(res.data)).catch(console.error);
    });

    socket.on('txn:updated', (updatedTxn) => {
      setTransactions(prev => prev.map(t => t._id === updatedTxn._id ? updatedTxn : t));
      // Also update the selected panel if it's the same transaction
      setSelectedTxn(prev => prev && prev._id === updatedTxn._id ? updatedTxn : prev);
      api.getStats().then(res => setStats(res.data)).catch(console.error);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('txn:created');
      socket.off('txn:updated');
      socket.disconnect();
    };
  }, [fetchData]);

  const simulatePayment = async () => {
    const testPayloads = [
      { customerName: 'Sparsh',       phone: '+918954003032', email: 'sparsh@example.com',  originalAmount: 4999,  errorCode: 'INSUFFICIENT_FUNDS', note: 'YOUR phone — soft decline' },
      { customerName: 'Rahul Sharma', phone: '+918954003032', email: 'rahul@example.com',   originalAmount: 12500, errorCode: 'BANK_SERVER_DOWN',    note: 'YOUR phone — infra retry' },
      { customerName: 'Priya Patel',  phone: '+918954003032', email: 'priya@example.com',   originalAmount: 2999,  errorCode: 'CARD_EXPIRED',         note: 'YOUR phone — hard decline' },
    ];
    const { note, ...payload } = testPayloads[Math.floor(Math.random() * testPayloads.length)];
    try {
      await api.simulateFailedPayment(payload);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className={`min-h-screen bg-[var(--color-bg-primary)] transition-all ${selectedTxn ? 'pr-[420px]' : ''}`}>
      <header className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-xl sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl bg-gradient-to-br from-[var(--color-pulse-red)] to-[var(--color-pulse-orange)] flex items-center justify-center text-white font-bold text-lg shadow-lg shadow-[var(--color-pulse-red-glow)]"
              style={{ animation: 'pulse-glow 2s ease-in-out infinite' }}
            >
              R
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">
                RecoverPulse<span className="text-[var(--color-pulse-red)]"> AI</span>
              </h1>
              <p className="text-xs text-[var(--color-text-muted)]">Autonomous Revenue Recovery</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${serverOnline ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
              <span
                className={`w-2 h-2 rounded-full ${serverOnline ? 'bg-green-400' : 'bg-red-400'}`}
                style={{ animation: serverOnline ? 'pulse-glow 2s ease-in-out infinite' : 'none' }}
              />
              {serverOnline ? 'Server Online' : 'Server Offline'}
            </div>
            <button
              onClick={simulatePayment}
              disabled={!serverOnline}
              className="px-4 py-2 bg-gradient-to-r from-[var(--color-pulse-red)] to-[var(--color-pulse-orange)] text-white text-sm font-semibold rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-[var(--color-pulse-red-glow)]"
            >
              Simulate Failed Payment
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard label="Total Transactions" value={stats?.totalTransactions ?? 0} accent="text-[var(--color-text-primary)]" />
          <StatCard label="Recovered"          value={stats?.recovered ?? 0}          accent="text-[var(--color-pulse-green)]" />
          <StatCard label="Value at Risk"       value={`\u20B9${(stats?.grossValueAtRisk ?? 0).toLocaleString('en-IN')}`} accent="text-[var(--color-pulse-red)]" />
          <StatCard label="Recovery Rate"       value={`${stats?.recoveryRate ?? 0}%`} accent="text-[var(--color-pulse-blue)]" />
        </div>

        <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
            <h2 className="text-base font-semibold">Failed Payments</h2>
            <div className="flex items-center gap-3">
              {selectedTxn && (
                <span className="text-xs text-blue-400 font-[var(--font-mono)]">
                  Agent panel open &rarr;
                </span>
              )}
              <span className="text-xs text-[var(--color-text-muted)] font-[var(--font-mono)]">
                {transactions.length} records &bull; click row to test agent
              </span>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-[var(--color-pulse-red)] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : transactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-[var(--color-text-muted)]">
              <p className="text-sm">No failed payments detected</p>
              <p className="text-xs mt-1">Click &ldquo;Simulate Failed Payment&rdquo; to test the pipeline</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] text-xs uppercase tracking-wider">
                    <th className="py-3 px-4 text-left font-medium">Customer</th>
                    <th className="py-3 px-4 text-left font-medium">Phone</th>
                    <th className="py-3 px-4 text-left font-medium">Amount</th>
                    <th className="py-3 px-4 text-left font-medium">Error Code</th>
                    <th className="py-3 px-4 text-left font-medium">State</th>
                    <th className="py-3 px-4 text-left font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((txn) => (
                    <TransactionRow
                      key={txn._id}
                      txn={txn}
                      isSelected={selectedTxn?._id === txn._id}
                      onClick={() => setSelectedTxn(prev => prev?._id === txn._id ? null : txn)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {selectedTxn && (
        <AgentPanel
          txn={selectedTxn}
          onClose={() => setSelectedTxn(null)}
        />
      )}
    </div>
  );
}

export default App;
