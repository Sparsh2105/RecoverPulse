import { useState, useEffect, useCallback } from 'react';
import api from './services/api';

// ── State badge colors ──
const STATE_COLORS = {
  FAILED_PAYMENT_INGESTED: { bg: 'bg-red-500/20', text: 'text-red-400', label: 'Ingested' },
  SILENT_RETRY_SCHEDULED: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', label: 'Retrying' },
  OUTREACH_INITIATED: { bg: 'bg-blue-500/20', text: 'text-blue-400', label: 'Outreach' },
  MANDATE_PENDING_AUTH: { bg: 'bg-purple-500/20', text: 'text-purple-400', label: 'Mandate Pending' },
  DISCOUNT_GATED_LINK: { bg: 'bg-orange-500/20', text: 'text-orange-400', label: 'Discount Sent' },
  STOPPING_RULE_TRIGGERED: { bg: 'bg-red-600/20', text: 'text-red-500', label: 'Stopped' },
  RECOVERY_FAILED: { bg: 'bg-gray-500/20', text: 'text-gray-400', label: 'Failed' },
  RECOVERED: { bg: 'bg-green-500/20', text: 'text-green-400', label: 'Recovered ✓' },
  ESCALATED_TO_HUMAN: { bg: 'bg-amber-500/20', text: 'text-amber-400', label: 'Escalated' },
};

function StatCard({ label, value, icon, accent = 'text-[var(--color-pulse-red)]' }) {
  return (
    <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-xl p-5 hover:border-[var(--color-border-hover)] transition-all duration-300 hover:shadow-lg hover:shadow-[var(--color-pulse-red-glow)]"
      style={{ animation: 'fade-in-up 0.5s ease-out forwards' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[var(--color-text-muted)] text-sm uppercase tracking-wider">{label}</span>
        <span className="text-xl">{icon}</span>
      </div>
      <p className={`text-3xl font-bold ${accent} font-[var(--font-mono)]`}>{value}</p>
    </div>
  );
}

function TransactionRow({ txn }) {
  const state = STATE_COLORS[txn.state] || { bg: 'bg-gray-500/20', text: 'text-gray-400', label: txn.state };
  const time = new Date(txn.createdAt).toLocaleString('en-IN', { 
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' 
  });

  return (
    <tr className="border-b border-[var(--color-border)] hover:bg-[var(--color-bg-card-hover)] transition-colors duration-200">
      <td className="py-3 px-4 text-sm font-medium">{txn.customerName}</td>
      <td className="py-3 px-4 text-sm text-[var(--color-text-secondary)] font-[var(--font-mono)]">{txn.phone}</td>
      <td className="py-3 px-4 text-sm font-semibold text-[var(--color-pulse-orange)] font-[var(--font-mono)]">
        ₹{txn.originalAmount.toLocaleString('en-IN')}
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

function App() {
  const [transactions, setTransactions] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [serverOnline, setServerOnline] = useState(false);
  const [error, setError] = useState(null);

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
    const interval = setInterval(fetchData, 5000); // Poll every 5s (Socket.IO replaces this on Day 3)
    return () => clearInterval(interval);
  }, [fetchData]);

  // ── Simulate a failed payment (for testing) ──
  const simulatePayment = async () => {
    const testPayloads = [
      { customerName: 'Rahul Sharma', phone: '+919876543210', email: 'rahul@example.com', originalAmount: 4999, errorCode: 'INSUFFICIENT_FUNDS' },
      { customerName: 'Priya Patel', phone: '+919123456789', email: 'priya@example.com', originalAmount: 12500, errorCode: 'BANK_SERVER_DOWN' },
      { customerName: 'Amit Kumar', phone: '+918765432109', email: 'amit@example.com', originalAmount: 2999, errorCode: 'CARD_EXPIRED' },
    ];
    const payload = testPayloads[Math.floor(Math.random() * testPayloads.length)];

    try {
      await api.simulateFailedPayment(payload);
      fetchData();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      {/* ── Header ── */}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[var(--color-pulse-red)] to-[var(--color-pulse-orange)] flex items-center justify-center text-white font-bold text-lg shadow-lg shadow-[var(--color-pulse-red-glow)]"
              style={{ animation: 'pulse-glow 2s ease-in-out infinite' }}>
              R
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">RecoverPulse<span className="text-[var(--color-pulse-red)]"> AI</span></h1>
              <p className="text-xs text-[var(--color-text-muted)]">Autonomous Revenue Recovery</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${serverOnline ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
              <span className={`w-2 h-2 rounded-full ${serverOnline ? 'bg-green-400' : 'bg-red-400'}`} style={{ animation: serverOnline ? 'pulse-glow 2s ease-in-out infinite' : 'none' }} />
              {serverOnline ? 'Server Online' : 'Server Offline'}
            </div>
            <button
              onClick={simulatePayment}
              disabled={!serverOnline}
              className="px-4 py-2 bg-gradient-to-r from-[var(--color-pulse-red)] to-[var(--color-pulse-orange)] text-white text-sm font-semibold rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-[var(--color-pulse-red-glow)]"
            >
              ⚡ Simulate Failed Payment
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* ── Error Banner ── */}
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            ⚠️ {error}
          </div>
        )}

        {/* ── Stats Grid ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard label="Total Transactions" value={stats?.totalTransactions || 0} icon="📊" accent="text-[var(--color-text-primary)]" />
          <StatCard label="Recovered" value={stats?.recovered || 0} icon="✅" accent="text-[var(--color-pulse-green)]" />
          <StatCard label="Value at Risk" value={`₹${(stats?.grossValueAtRisk || 0).toLocaleString('en-IN')}`} icon="🔥" accent="text-[var(--color-pulse-red)]" />
          <StatCard label="Recovery Rate" value={`${stats?.recoveryRate || 0}%`} icon="📈" accent="text-[var(--color-pulse-blue)]" />
        </div>

        {/* ── Transaction Table ── */}
        <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
            <h2 className="text-base font-semibold">Failed Payments</h2>
            <span className="text-xs text-[var(--color-text-muted)] font-[var(--font-mono)]">
              {transactions.length} records
            </span>
          </div>
          
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-[var(--color-pulse-red)] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : transactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-[var(--color-text-muted)]">
              <span className="text-4xl mb-4">🫀</span>
              <p className="text-sm">No failed payments detected</p>
              <p className="text-xs mt-1">Click "Simulate Failed Payment" to test the pipeline</p>
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
                    <TransactionRow key={txn._id} txn={txn} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
