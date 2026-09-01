import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, List, Activity, BarChart2, X, Send,
  ChevronRight, CheckCircle2, TrendingUp, TrendingDown,
  Zap, Wifi, WifiOff, Shield, Brain, Eye, AlertTriangle,
  MessageSquare, Clock, DollarSign, Percent, ArrowRight,
  RefreshCw, UserCheck, XCircle, CheckCircle, Info,
  CalendarClock, IndianRupee, Timer,
} from 'lucide-react';
import api from './services/api';
import socket from './services/socket';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const STATE_COLORS = {
  FAILED_PAYMENT_INGESTED:  { bg: 'bg-red-500/10',    text: 'text-red-400',    dot: '#f87171', label: 'Ingested',        pipeline: 'FAILED' },
  SILENT_RETRY_SCHEDULED:   { bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: '#facc15', label: 'Retrying',        pipeline: 'TRIAGED' },
  OUTREACH_INITIATED:       { bg: 'bg-blue-500/10',   text: 'text-blue-400',   dot: '#60a5fa', label: 'Outreach',        pipeline: 'OUTREACH' },
  MANDATE_PENDING_AUTH:     { bg: 'bg-purple-500/10', text: 'text-purple-400', dot: '#c084fc', label: 'Mandate Pending', pipeline: 'NEGOTIATION' },
  DISCOUNT_GATED_LINK:      { bg: 'bg-orange-500/10', text: 'text-orange-400', dot: '#fb923c', label: 'Discount Sent',   pipeline: 'NEGOTIATION' },
  STOPPING_RULE_TRIGGERED:  { bg: 'bg-red-600/10',    text: 'text-red-500',    dot: '#ef4444', label: 'Stopped',         pipeline: 'FAILED' },
  RECOVERY_FAILED:          { bg: 'bg-gray-500/10',   text: 'text-gray-400',   dot: '#6b7280', label: 'Failed',          pipeline: 'FAILED' },
  RECOVERED:                { bg: 'bg-emerald-500/10',text: 'text-emerald-400',dot: '#34d399', label: 'Recovered',       pipeline: 'RECOVERED' },
  ESCALATED_TO_HUMAN:       { bg: 'bg-amber-500/10',  text: 'text-amber-400',  dot: '#fbbf24', label: 'Escalated',       pipeline: 'NEGOTIATION' },
};

const PIPELINE_STAGES = [
  { key: 'FAILED',      label: 'Failed',      color: '#f87171', glow: 'rgba(248,113,113,0.2)' },
  { key: 'TRIAGED',     label: 'Triaged',     color: '#facc15', glow: 'rgba(250,204,21,0.2)' },
  { key: 'OUTREACH',    label: 'Outreach',    color: '#60a5fa', glow: 'rgba(96,165,250,0.2)' },
  { key: 'NEGOTIATION', label: 'Negotiation', color: '#c084fc', glow: 'rgba(192,132,252,0.2)' },
  { key: 'RECOVERED',   label: 'Recovered',   color: '#34d399', glow: 'rgba(52,211,153,0.2)' },
];

const TEST_MESSAGES = [
  { label: 'UPI Mandate',    message: 'bhai salary 1st ko aayegi, tab pay kar dunga', icon: Clock },
  { label: 'Pay Now',        message: 'okay bhai, pay karna chahta hoon abhi', icon: CheckCircle },
  { label: 'Discount',       message: 'poora amount afford nahi ho raha, kuch kam ho sakta hai?', icon: Percent },
  { label: 'Dispute (STOP)', message: 'I already cancelled this, stop messaging me', icon: XCircle },
  { label: 'Legal Threat',   message: 'yeh fraud hai, main sue karunga tumhe', icon: AlertTriangle },
];

const REACT_STEP_CONFIG = {
  THOUGHT:     { icon: Brain,    color: '#60a5fa', bg: 'rgba(96,165,250,0.08)',   border: 'rgba(96,165,250,0.2)',   label: 'THOUGHT' },
  ACTION:      { icon: Zap,      color: '#c084fc', bg: 'rgba(192,132,252,0.08)',  border: 'rgba(192,132,252,0.2)',  label: 'ACTION' },
  COMPLIANCE:  { icon: Shield,   color: '#fbbf24', bg: 'rgba(251,191,36,0.08)',   border: 'rgba(251,191,36,0.2)',   label: 'COMPLIANCE' },
  OBSERVATION: { icon: Eye,      color: '#34d399', bg: 'rgba(52,211,153,0.08)',   border: 'rgba(52,211,153,0.2)',   label: 'OBSERVATION' },
  DEFAULT:     { icon: Info,     color: '#9ca3af', bg: 'rgba(156,163,175,0.08)',  border: 'rgba(156,163,175,0.2)',  label: 'INFO' },
};

function classifyEntry(entry) {
  const t = (entry.toolName || entry.type || '').toUpperCase();
  if (t.includes('THOUGHT') || t.includes('THINK')) return 'THOUGHT';
  if (t.includes('COMPLIANCE') || t.includes('BLOCKED')) return 'COMPLIANCE';
  if (t === 'OBSERVATION' || entry.observation) return 'OBSERVATION';
  return 'ACTION';
}

function getErrorCategory(errorCode) {
  const soft = ['INSUFFICIENT_FUNDS', 'PAYMENT_DECLINED', 'LOW_BALANCE', 'PAYMENT_ACCOUNT_BLOCKED'];
  const hard = ['CARD_EXPIRED', 'CARD_BLOCKED', 'INVALID_CARD', 'CARD_LOST', 'CARD_STOLEN', 'FRAUD_SUSPECTED'];
  if (hard.includes(errorCode)) return { label: 'Hard Decline', color: 'text-red-400',    bg: 'rgba(248,113,113,0.1)', icon: XCircle,       iconColor: '#f87171' };
  if (soft.includes(errorCode)) return { label: 'Soft Decline', color: 'text-yellow-400', bg: 'rgba(250,204,21,0.1)',  icon: AlertTriangle, iconColor: '#facc15' };
  return                                { label: 'Infra Error',  color: 'text-blue-400',   bg: 'rgba(96,165,250,0.1)', icon: RefreshCw,     iconColor: '#60a5fa' };
}

// ─────────────────────────────────────────────
// Sidebar
// ─────────────────────────────────────────────
const NAV = [
  { id: 'overview',     label: 'Overview',           Icon: LayoutDashboard },
  { id: 'transactions', label: 'Transactions',        Icon: List },
  { id: 'p2p-tracker',  label: 'Promise-to-Pay',      Icon: CalendarClock },
  { id: 'agent-feed',   label: 'Agent Feed',           Icon: Activity },
  { id: 'analytics',    label: 'Analytics',            Icon: BarChart2 },
];

function Sidebar({ active, onSelect }) {
  return (
    <aside className="fixed left-0 top-0 h-full z-50 flex flex-col items-center py-5 gap-1"
      style={{ width: 64, background: 'var(--color-bg-secondary)', borderRight: '1px solid var(--color-border)' }}>
      {/* Logo */}
      <motion.div
        className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-base mb-5 cursor-default select-none"
        style={{ background: 'linear-gradient(135deg,#ff3b5c,#ff8c42)', boxShadow: '0 0 20px rgba(255,59,92,0.35)' }}
        animate={{ boxShadow: ['0 0 16px rgba(255,59,92,0.3)', '0 0 28px rgba(255,59,92,0.5)', '0 0 16px rgba(255,59,92,0.3)'] }}
        transition={{ duration: 2.5, repeat: Infinity }}
      >
        R
      </motion.div>

      {NAV.map(({ id, label, Icon: NavIcon }) => {
        const isActive = active === id;
        return (
          <div key={id} className="relative group w-full px-2">
            <motion.button
              onClick={() => onSelect(id)}
              className="w-full flex items-center justify-center p-2.5 rounded-xl transition-colors relative overflow-hidden"
              style={{
                color: isActive ? 'white' : 'var(--color-text-muted)',
                background: isActive ? 'rgba(255,59,92,0.15)' : 'transparent',
              }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              {isActive && (
                <motion.span
                  layoutId="sidebar-active"
                  className="absolute inset-0 rounded-xl"
                  style={{ background: 'rgba(255,59,92,0.15)' }}
                />
              )}
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r"
                  style={{ background: '#ff3b5c' }} />
              )}
              <NavIcon size={18} className="relative z-10" />
            </motion.button>
            {/* Tooltip */}
            <div className="absolute left-14 top-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-lg text-xs font-medium
              opacity-0 group-hover:opacity-100 pointer-events-none transition-all duration-200 whitespace-nowrap z-50 shadow-xl"
              style={{
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-primary)',
              }}>
              {label}
            </div>
          </div>
        );
      })}
    </aside>
  );
}

// ─────────────────────────────────────────────
// Stat Card
// ─────────────────────────────────────────────
function StatCard({ label, value, accent = 'var(--color-text-primary)', Icon: CardIcon, iconColor, trend, gradient }) {
  return (
    <motion.div
      className="rounded-2xl p-5 flex flex-col gap-3 relative overflow-hidden"
      style={{
        background: gradient || 'var(--color-bg-card)',
        border: '1px solid var(--color-border)',
      }}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ borderColor: iconColor ? `${iconColor}50` : 'var(--color-border-hover)', y: -2 }}
      transition={{ duration: 0.25 }}
    >
      {/* Subtle background glow orb */}
      {iconColor && (
        <div className="absolute -right-4 -top-4 w-20 h-20 rounded-full opacity-10 pointer-events-none"
          style={{ background: iconColor, filter: 'blur(16px)' }} />
      )}
      <div className="flex items-center justify-between relative z-10">
        <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>{label}</p>
        {CardIcon && (
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: `${iconColor}20`, border: `1px solid ${iconColor}30` }}>
            <CardIcon size={15} style={{ color: iconColor }} />
          </div>
        )}
      </div>
      {/* Auto-scale value text to prevent overflow */}
      <p className="font-bold font-mono leading-none relative z-10 truncate"
        style={{
          color: accent,
          fontSize: String(value).length > 12 ? '1.25rem' : String(value).length > 8 ? '1.6rem' : '1.875rem',
        }}>
        {value}
      </p>
      {trend !== undefined && (
        <div className="flex items-center gap-1 relative z-10">
          {trend >= 0
            ? <TrendingUp size={13} className="text-emerald-400" />
            : <TrendingDown size={13} className="text-red-400" />}
          <span className={`text-xs ${trend >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {trend >= 0 ? '+' : ''}{trend}%
          </span>
        </div>
      )}
    </motion.div>
  );
}

// ─────────────────────────────────────────────
// Recovery Pipeline
// ─────────────────────────────────────────────
function RecoveryPipeline({ transactions }) {
  const counts = {};
  PIPELINE_STAGES.forEach(s => (counts[s.key] = 0));
  transactions.forEach(t => {
    const p = STATE_COLORS[t.state]?.pipeline;
    if (p) counts[p] = (counts[p] || 0) + 1;
  });

  return (
    <div className="rounded-2xl p-5 mb-6"
      style={{
        background: 'linear-gradient(135deg, var(--color-bg-card) 0%, rgba(68,138,255,0.04) 100%)',
        border: '1px solid var(--color-border)',
      }}>
      <p className="text-xs font-semibold uppercase tracking-widest mb-5" style={{ color: 'var(--color-text-muted)' }}>
        Recovery Pipeline
      </p>
      <div className="flex items-center">
        {PIPELINE_STAGES.map((stage, idx) => (
          <div key={stage.key} className="flex items-center flex-1">
            <div className="flex flex-col items-center gap-2 flex-1">
              <motion.div
                className="w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold"
                animate={counts[stage.key] > 0 ? {
                  boxShadow: [`0 0 0 0 ${stage.glow}`, `0 0 0 8px transparent`],
                } : {}}
                transition={{ duration: 1.8, repeat: Infinity }}
                style={{
                  border: `2px solid ${counts[stage.key] > 0 ? stage.color : 'var(--color-border)'}`,
                  background: counts[stage.key] > 0 ? stage.glow : 'var(--color-bg-elevated)',
                  color: counts[stage.key] > 0 ? stage.color : 'var(--color-text-muted)',
                }}
              >
                {counts[stage.key]}
              </motion.div>
              <span className="text-xs font-medium tracking-wide"
                style={{ color: counts[stage.key] > 0 ? stage.color : 'var(--color-text-muted)' }}>
                {stage.label}
              </span>
            </div>
            {idx < PIPELINE_STAGES.length - 1 && (
              <div className="flex items-center pb-5 flex-shrink-0 mx-1">
                <ArrowRight size={14} style={{ color: 'var(--color-border-hover)' }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Transaction Row
// ─────────────────────────────────────────────
function TransactionRow({ txn, onClick, isSelected }) {
  const sc = STATE_COLORS[txn.state] || { bg: 'bg-gray-500/10', text: 'text-gray-400', dot: '#6b7280', label: txn.state };
  const cat = getErrorCategory(txn.errorCode);
  const CatIcon = cat.icon;
  const time = new Date(txn.createdAt).toLocaleString('en-IN', {
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short',
  });

  return (
    <motion.tr
      onClick={onClick}
      className="border-b cursor-pointer"
      style={{ borderColor: 'var(--color-border)' }}
      animate={{ backgroundColor: isSelected ? 'rgba(96,165,250,0.06)' : 'transparent' }}
      whileHover={{ backgroundColor: isSelected ? 'rgba(96,165,250,0.08)' : 'rgba(255,255,255,0.02)' }}
      transition={{ duration: 0.15 }}
    >
      {/* Customer */}
      <td className="py-3 px-4">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
            style={{ background: 'linear-gradient(135deg,#448aff,#7c4dff)' }}>
            {txn.customerName?.[0]?.toUpperCase() || '?'}
          </div>
          <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
            {txn.customerName}
          </span>
        </div>
      </td>
      {/* Amount */}
      <td className="py-3 px-4">
        <span className="text-sm font-bold font-mono" style={{ color: 'var(--color-pulse-orange)' }}>
          ₹{txn.originalAmount.toLocaleString('en-IN')}
        </span>
      </td>
      {/* Error Code */}
      <td className="py-3 px-4">
        <span className="text-xs font-mono" style={{ color: 'var(--color-text-secondary)' }}>
          {txn.errorCode}
        </span>
      </td>
      {/* Root Cause */}
      <td className="py-3 px-4">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium"
          style={{ background: cat.bg, color: cat.iconColor }}>
          <CatIcon size={11} />
          {cat.label}
        </span>
      </td>
      {/* State */}
      <td className="py-3 px-4">
        <div className="flex items-center gap-1.5">
          <motion.span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: sc.dot }}
            animate={['OUTREACH_INITIATED', 'MANDATE_PENDING_AUTH'].includes(txn.state)
              ? { scale: [1, 1.4, 1], opacity: [1, 0.6, 1] }
              : {}}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
          <span className={`text-xs font-medium ${sc.text}`}>{sc.label}</span>
        </div>
      </td>
      {/* Time */}
      <td className="py-3 px-4">
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{time}</span>
      </td>
    </motion.tr>
  );
}

// ─────────────────────────────────────────────
// ReAct Agent Feed
// ─────────────────────────────────────────────
function FeedEntry({ entry, index }) {
  const kind = classifyEntry(entry);
  const cfg = REACT_STEP_CONFIG[kind] || REACT_STEP_CONFIG.DEFAULT;
  const StepIcon = cfg.icon;

  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, delay: index * 0.02 }}
      className="rounded-xl px-3 py-2.5 text-xs"
      style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}
    >
      <div className="flex items-center gap-2 mb-1">
        <StepIcon size={11} style={{ color: cfg.color, flexShrink: 0 }} />
        <span className="font-bold tracking-widest" style={{ color: cfg.color }}>{cfg.label}</span>
        <span className="ml-auto font-mono opacity-40" style={{ color: cfg.color }}>
          {entry.ts ? new Date(entry.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
        </span>
      </div>
      <p className="leading-relaxed font-mono" style={{ color: cfg.color, opacity: 0.8 }}>
        {entry.toolName && kind === 'ACTION' && <span className="font-bold">[{entry.toolName}] </span>}
        {entry.observation || entry.text || entry.message || ''}
      </p>
    </motion.div>
  );
}

function AgentFeedPanel({ feedEntries }) {
  const bottomRef = useRef(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [feedEntries]);

  return (
    <div className="rounded-2xl flex flex-col overflow-hidden"
      style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', height: 500 }}>
      <div className="px-4 py-3 flex items-center justify-between"
        style={{ borderBottom: '1px solid var(--color-border)' }}>
        <div className="flex items-center gap-2">
          <motion.span
            className="w-2 h-2 rounded-full bg-emerald-400"
            animate={{ scale: [1, 1.4, 1], opacity: [1, 0.5, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          <span className="text-sm font-semibold">ReAct Agent Feed</span>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full font-mono"
          style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}>
          LIVE · {feedEntries.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5">
        {feedEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3"
            style={{ color: 'var(--color-text-muted)' }}>
            <Activity size={28} opacity={0.3} />
            <p className="text-xs text-center">Waiting for agent activity...<br/>
              <span className="opacity-60">Simulate a payment to see the ReAct loop</span>
            </p>
          </div>
        ) : feedEntries.map((e, i) => <FeedEntry key={i} entry={e} index={i} />)}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Batch Monitor
// ─────────────────────────────────────────────
function SemiGauge({ value, max }) {
  const pct = max > 0 ? Math.min(value / max, 1) : 0;
  const R = 78, cx = 100, cy = 95;
  const toRad = d => (d * Math.PI) / 180;
  const arc = (a1, a2) => {
    const s = { x: cx + R * Math.cos(toRad(a1)), y: cy - R * Math.sin(toRad(a1)) };
    const e = { x: cx + R * Math.cos(toRad(a2)), y: cy - R * Math.sin(toRad(a2)) };
    return `M ${s.x} ${s.y} A ${R} ${R} 0 ${a1 - a2 > 180 ? 1 : 0} 0 ${e.x} ${e.y}`;
  };
  const endAngle = 180 - pct * 180;

  return (
    <svg width="200" height="110" viewBox="0 0 200 110">
      <defs>
        <linearGradient id="gGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#448aff" />
          <stop offset="100%" stopColor="#7c4dff" />
        </linearGradient>
      </defs>
      <path d={arc(180, 0)} fill="none" stroke="var(--color-bg-elevated)" strokeWidth={12} strokeLinecap="round" />
      {pct > 0 && (
        <motion.path
          d={arc(180, endAngle)}
          fill="none" stroke="url(#gGrad)" strokeWidth={12} strokeLinecap="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: pct }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      )}
      <text x={cx} y={cy - 8} textAnchor="middle" fill="var(--color-text-primary)"
        fontSize="20" fontWeight="700" fontFamily="monospace">
        {Math.round(pct * 100)}%
      </text>
      <text x={cx} y={cy + 10} textAnchor="middle" fill="var(--color-text-muted)"
        fontSize="10" fontFamily="system-ui">
        {value} / {max}
      </text>
    </svg>
  );
}

function BatchMonitor({ batchProgress, batchRunning, recentBatch }) {
  if (!batchProgress) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl p-5 mb-6"
      style={{
        background: 'var(--color-bg-card)',
        border: `1px solid ${batchRunning ? 'rgba(68,138,255,0.4)' : 'rgba(52,211,153,0.4)'}`,
        boxShadow: batchRunning ? '0 0 24px rgba(68,138,255,0.08)' : '0 0 24px rgba(52,211,153,0.08)',
      }}
    >
      <div className="flex items-center gap-2 mb-4">
        {batchRunning
          ? <motion.span className="w-2 h-2 rounded-full bg-blue-400"
              animate={{ scale: [1,1.5,1], opacity:[1,0.4,1] }} transition={{ duration: 1, repeat: Infinity }} />
          : <span className="w-2 h-2 rounded-full bg-emerald-400" />}
        <h3 className="text-sm font-semibold">
          {batchRunning ? 'Active Recovery Batch Monitor' : '✅ Batch Complete'}
        </h3>
        <span className="ml-auto text-xs font-mono px-2 py-0.5 rounded-full"
          style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}>
          ✓ {batchProgress.success ?? 0} · ✗ {batchProgress.failed ?? 0}
        </span>
      </div>

      <div className="flex gap-6 items-start">
        <div className="flex-shrink-0">
          <SemiGauge value={batchProgress.processed ?? 0} max={batchProgress.total || 50} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs uppercase tracking-widest mb-2.5" style={{ color: 'var(--color-text-muted)' }}>
            Live Batch Activity
          </p>
          <div className="flex flex-col gap-2">
            <AnimatePresence>
              {recentBatch.slice(-5).map((t, i) => {
                const sc = STATE_COLORS[t.state] || { text: 'text-gray-400', dot: '#6b7280', label: t.state };
                const pct = ['RECOVERED'].includes(t.state) ? 100
                  : ['OUTREACH_INITIATED','MANDATE_PENDING_AUTH','DISCOUNT_GATED_LINK'].includes(t.state) ? 70
                  : t.state === 'SILENT_RETRY_SCHEDULED' ? 40 : 20;
                return (
                  <motion.div key={t._id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
                    className="flex items-center gap-2.5">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
                      style={{ background: 'linear-gradient(135deg,#448aff,#7c4dff)', fontSize: 9 }}>
                      {t.customerName?.[0]?.toUpperCase() || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text-primary)' }}>
                          {t.customerName}
                        </span>
                        <span className={`text-xs ${sc.text} ml-2`}>{sc.label}</span>
                      </div>
                      <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--color-bg-elevated)' }}>
                        <motion.div className="h-full rounded-full"
                          initial={{ width: 0 }} animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.5 }}
                          style={{ background: sc.dot }} />
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {recentBatch.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Processing records...</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 mt-4">
            {[
              { label: 'Projected Recovery', value: `₹${((batchProgress.success ?? 0) * 5200).toLocaleString('en-IN')}`, color: '#34d399' },
              { label: 'Active Escalations', value: batchProgress.failed ?? 0, color: '#fb923c' },
            ].map(s => (
              <div key={s.label} className="rounded-xl p-3"
                style={{ background: 'var(--color-bg-elevated)' }}>
                <p className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>{s.label}</p>
                <p className="text-lg font-bold font-mono" style={{ color: s.color }}>{s.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────
// Agent Panel (Transaction Intelligence)
// ─────────────────────────────────────────────
const COMPLIANCE_CHECKS = [
  { label: 'Contact Window',      desc: '8AM–7PM IST enforced',     ok: true },
  { label: 'Outreach Cap',        desc: 'Max 5 messages',           ok: true },
  { label: 'Discount Bounds',     desc: '5–10% only in code',       ok: true },
  { label: 'Language Preference', desc: 'Hinglish auto-detected',   ok: true },
];

function AgentPanel({ txn, onClose }) {
  const [message, setMessage] = useState('');
  const [log, setLog] = useState([]);
  const [auditHistory, setAuditHistory] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [sending, setSending] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [activeTab, setActiveTab] = useState('chat');
  const bottomRef = useRef(null);

  // Load persisted audit log + conversation history from MongoDB on mount
  useEffect(() => {
    setLoadingHistory(true);
    api.getTransaction(txn._id)
      .then(res => {
        setAuditHistory(res.data.auditLogs || []);
        setConversations(res.data.conversations || []);
      })
      .catch(() => {})
      .finally(() => setLoadingHistory(false));
  }, [txn._id]);

  // Hinglish voice note — auto-plays when an escalated transaction is opened
  useEffect(() => {
    if (!['ESCALATED_TO_HUMAN', 'STOPPING_RULE_TRIGGERED'].includes(txn.state)) return;
    if (!window.speechSynthesis) return;

    window.speechSynthesis.cancel();

    const reason = txn.escalationReason
      ? txn.escalationReason.replace(/_/g, ' ').replace('compliance violation:', '').trim()
      : 'agent ke paas bheja gaya hai';

    const text =
      `${txn.customerName} ji ka Rs. ${txn.originalAmount} ka payment fail hua hai. ` +
      `Humne is case ko human agent ke paas escalate kar diya hai. ` +
      `${reason === 'dispute_or_opt_out_detected' || reason.includes('dispute')
        ? 'Customer ne dispute ya opt-out request kiya hai.'
        : reason.includes('compliance')
          ? 'Compliance violation detected tha.'
          : `Reason hai: ${reason}.`} ` +
      `Please is customer ko personally contact karein aur matter resolve karein. Thank you.`;

    function speak() {
      const voices = window.speechSynthesis.getVoices();

      // Priority: Indian English Neural > Indian English > any Indian > any English
      const preferred =
        voices.find(v => v.name.includes('Heera'))              // Microsoft Heera (en-IN female)
        || voices.find(v => v.name.includes('Ravi'))            // Microsoft Ravi (en-IN male)
        || voices.find(v => v.name.includes('Neerja'))          // Microsoft Neerja
        || voices.find(v => v.lang === 'en-IN')                 // any en-IN
        || voices.find(v => v.name.toLowerCase().includes('india'))
        || voices.find(v => v.lang === 'en-GB' && v.name.includes('Neural'))  // UK Neural as fallback
        || voices.find(v => v.lang?.startsWith('en') && v.name.includes('Neural'))
        || voices.find(v => v.lang?.startsWith('en'))
        || voices[0];

      const utterance = new SpeechSynthesisUtterance(text);
      if (preferred) utterance.voice = preferred;
      utterance.rate   = 0.90;   // Heera sounds most natural at this rate
      utterance.pitch  = 1.0;
      utterance.volume = 1.0;
      window.speechSynthesis.speak(utterance);
    }

    // getVoices() is async on first load — wait for voiceschanged if list is empty
    const timer = setTimeout(() => {
      if (window.speechSynthesis.getVoices().length > 0) {
        speak();
      } else {
        window.speechSynthesis.addEventListener('voiceschanged', speak, { once: true });
      }
    }, 650);

    return () => {
      clearTimeout(timer);
      window.speechSynthesis.cancel();
      window.speechSynthesis.removeEventListener('voiceschanged', speak);
    };
  }, [txn._id, txn.state]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [log]);

  const addLog = (type, text) =>
    setLog(prev => [...prev, { type, text, ts: new Date().toLocaleTimeString('en-IN') }]);

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
          addLog('compliance', 'BLOCKED: ' + d.observation);
        } else {
          addLog('agent', `[${d.toolName}] ${d.observation}`);
          if (d.paymentLink) addLog('link', d.paymentLink);
        }
      } else addLog('error', data.error || 'Agent error');
    } catch (err) { addLog('error', err.message); }
    finally { setSending(false); }
  };

  const simulateCapture = async () => {
    if (capturing) return;
    setCapturing(true);
    addLog('system', 'Firing Razorpay payment.captured webhook...');
    try {
      const data = await api.simulateRazorpayCapture(txn._id, txn.originalAmount);
      if (data.status === 'ok') addLog('recovered', `✅ Recovered ₹${data.amountRecovered?.toLocaleString('en-IN') ?? txn.originalAmount}`);
      else if (data.status === 'already_recovered') addLog('recovered', 'Already RECOVERED.');
      else addLog('error', JSON.stringify(data));
    } catch (err) { addLog('error', err.message); }
    finally { setCapturing(false); }
  };

  const sc = STATE_COLORS[txn.state] || { bg: 'bg-gray-500/10', text: 'text-gray-400', dot: '#6b7280', label: txn.state };

  const bubbleStyle = {
    user: { align: 'justify-end', bg: 'linear-gradient(135deg,#448aff,#7c4dff)', color: 'white', radius: '12px 12px 4px 12px' },
    agent: { align: 'justify-start', bg: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)', radius: '12px 12px 12px 4px' },
    compliance: { align: 'justify-start', bg: 'rgba(251,191,36,0.1)', color: '#fbbf24', radius: '8px' },
    error: { align: 'justify-start', bg: 'rgba(248,113,113,0.1)', color: '#f87171', radius: '8px' },
    system: { align: 'justify-center', bg: 'rgba(156,163,175,0.08)', color: 'var(--color-text-muted)', radius: '8px' },
    recovered: { align: 'justify-start', bg: 'rgba(52,211,153,0.12)', color: '#34d399', radius: '8px' },
  };

  return (
    <motion.div
      initial={{ x: 440, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 440, opacity: 0 }}
      transition={{ type: 'spring', damping: 28, stiffness: 300 }}
      className="fixed top-0 right-0 h-full flex flex-col z-50 shadow-2xl"
      style={{ width: 440, background: 'var(--color-bg-secondary)', borderLeft: '1px solid var(--color-border)' }}
    >
      {/* Header */}
      <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
              Transaction Intelligence
            </p>
            {/* Voice note badge — shown for escalated transactions */}
            {['ESCALATED_TO_HUMAN', 'STOPPING_RULE_TRIGGERED'].includes(txn.state) && (
              <motion.div
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer"
                style={{ background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24' }}
                title="Click to replay voice summary"
                onClick={() => {
                  if (!window.speechSynthesis) return;
                  window.speechSynthesis.cancel();
                  const reason = txn.escalationReason?.replace(/_/g, ' ').replace('compliance violation:', '').trim() || 'agent ke paas bheja gaya';
                  const text = `${txn.customerName} ji ka payment fail hua, Rs. ${txn.originalAmount} ka. Reason: ${reason}. Customer ko human agent ke paas bheja gaya hai. Kripya manually follow up karein.`;
                  const u = new SpeechSynthesisUtterance(text);
                  const voices = window.speechSynthesis.getVoices();
                  const pref = voices.find(v => v.name.includes('Heera'))
                    || voices.find(v => v.name.includes('Ravi'))
                    || voices.find(v => v.lang === 'en-IN')
                    || voices.find(v => v.lang?.startsWith('en') && v.name.includes('Neural'))
                    || voices.find(v => v.lang?.startsWith('en'))
                    || voices[0];
                  if (pref) u.voice = pref;
                  u.rate = 0.90; u.pitch = 1.0; u.volume = 1.0;
                  window.speechSynthesis.speak(u);
                }}
                animate={{ opacity: [1, 0.6, 1] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                🎙 Voice Summary
              </motion.div>
            )}
          </div>
          <motion.button onClick={onClose} whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
            className="p-1.5 rounded-lg" style={{ color: 'var(--color-text-muted)' }}>
            <X size={16} />
          </motion.button>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold text-white"
            style={{ background: 'linear-gradient(135deg,#448aff,#7c4dff)' }}>
            {txn.customerName?.[0]?.toUpperCase() || '?'}
          </div>
          <div>
            <p className="font-semibold">{txn.customerName}</p>
            <p className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>{txn.phone}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium ${sc.bg} ${sc.text}`}>
            <motion.span className="w-1.5 h-1.5 rounded-full" style={{ background: sc.dot }}
              animate={{ scale: [1,1.4,1], opacity:[1,0.6,1] }}
              transition={{ duration: 1.5, repeat: Infinity }} />
            {sc.label}
          </span>
          <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
            ₹{txn.originalAmount.toLocaleString('en-IN')} · {txn.errorCode}
          </span>
          {txn.activePaymentLink && (
            <a href={txn.activePaymentLink} target="_blank" rel="noopener noreferrer"
              className="text-xs text-blue-400 underline underline-offset-2 hover:text-blue-300 transition-colors">
              🔗 Payment Link
            </a>
          )}
        </div>
      </div>

      {/* Compliance Guard */}
      <div className="px-5 py-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <div className="flex items-center gap-2 mb-2.5">
          <Shield size={13} style={{ color: '#34d399' }} />
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
            Compliance Guard
          </p>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {COMPLIANCE_CHECKS.map(({ label, desc, ok }) => (
            <div key={label} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5"
              style={{ background: 'var(--color-bg-card)' }}>
              <CheckCircle2 size={13} className={ok ? 'text-emerald-400' : 'text-red-400'} />
              <div>
                <p className="text-xs font-medium leading-none mb-0.5">{label}</p>
                <p className="text-xs leading-none" style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex px-5 gap-4" style={{ borderBottom: '1px solid var(--color-border)' }}>
        {[
          { id: 'chat',     label: 'Conversation', Icon: MessageSquare },
          { id: 'audit',    label: 'Audit Log',    Icon: Activity },
          { id: 'quick',    label: 'Quick Tests',  Icon: Zap },
        ].map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className="flex items-center gap-1.5 py-2.5 text-xs font-medium border-b-2 transition-colors"
            style={{
              borderColor: activeTab === t.id ? 'var(--color-pulse-red)' : 'transparent',
              color: activeTab === t.id ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
            }}>
            <t.Icon size={12} />
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab body */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {/* CHAT */}
        {activeTab === 'chat' && (
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {log.length === 0 && (
                <p className="text-xs text-center mt-10" style={{ color: 'var(--color-text-muted)' }}>
                  Send a message to simulate the customer
                </p>
              )}
              {log.map((entry, i) => {
                if (entry.type === 'link') return (
                  <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                    className="self-start max-w-[88%]">
                    <a href={entry.text} target="_blank" rel="noopener noreferrer"
                      className="block rounded-xl px-3 py-2 text-xs font-mono underline break-all"
                      style={{ background: 'rgba(68,138,255,0.1)', border: '1px solid rgba(68,138,255,0.25)', color: '#60a5fa' }}>
                      🔗 {entry.text}
                    </a>
                  </motion.div>
                );
                const bs = bubbleStyle[entry.type] || bubbleStyle.system;
                return (
                  <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                    className={`flex ${bs.align}`}>
                    <div className="max-w-[88%] px-3 py-2 text-sm leading-snug"
                      style={{ background: bs.bg, color: bs.color, borderRadius: bs.radius }}>
                      {entry.text}
                      <p className="text-xs mt-1 opacity-40">{entry.ts}</p>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {sending && (
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                <motion.div className="w-3 h-3 border-2 rounded-full"
                  style={{ borderColor: '#ff3b5c', borderTopColor: 'transparent' }}
                  animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }} />
                Agent thinking...
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}

        {/* AUDIT LOG — persisted from MongoDB */}
        {activeTab === 'audit' && (
          <div className="flex flex-col gap-2 py-1">
            {loadingHistory ? (
              <div className="flex items-center justify-center py-10 gap-2"
                style={{ color: 'var(--color-text-muted)' }}>
                <motion.div className="w-4 h-4 border-2 rounded-full"
                  style={{ borderColor: 'var(--color-pulse-red)', borderTopColor: 'transparent' }}
                  animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }} />
                Loading audit log...
              </div>
            ) : auditHistory.length === 0 ? (
              <p className="text-xs text-center mt-10" style={{ color: 'var(--color-text-muted)' }}>
                No audit entries yet — send a message to begin
              </p>
            ) : (
              <>
                {/* Conversation thread (persisted) */}
                {conversations.length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs uppercase tracking-widest mb-2 px-1"
                      style={{ color: 'var(--color-text-muted)' }}>Message Thread</p>
                    <div className="flex flex-col gap-1.5">
                      {conversations.map((msg, i) => {
                        const isInbound = msg.direction === 'inbound';
                        const channelIcon = msg.channel === 'email' ? '✉' : msg.channel === 'whatsapp' ? '💬' : '🎙';
                        return (
                          <div key={i} className={`flex ${isInbound ? 'justify-end' : 'justify-start'}`}>
                            <div className="max-w-[88%] px-3 py-2 text-xs leading-snug rounded-xl"
                              style={isInbound
                                ? { background: 'linear-gradient(135deg,#448aff,#7c4dff)', color: 'white', borderRadius: '12px 12px 4px 12px' }
                                : { background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)', borderRadius: '12px 12px 12px 4px' }
                              }>
                              <span className="mr-1 opacity-60">{channelIcon}</span>
                              {msg.body}
                              <p className="text-xs mt-0.5 opacity-40">
                                {new Date(msg.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ReAct audit steps (persisted) */}
                <p className="text-xs uppercase tracking-widest mb-2 px-1"
                  style={{ color: 'var(--color-text-muted)' }}>ReAct Audit Trail</p>
                {auditHistory.map((entry, i) => {
                  const kindMap = { THOUGHT: 'THOUGHT', ACTION: 'ACTION', COMPLIANCE_CHECK: 'COMPLIANCE', OBSERVATION: 'OBSERVATION' };
                  const kind = kindMap[entry.step] || 'DEFAULT';
                  const cfg = REACT_STEP_CONFIG[kind] || REACT_STEP_CONFIG.DEFAULT;
                  const StepIcon = cfg.icon;
                  const text = entry.thoughtProcess
                    || (entry.toolName ? `[${entry.toolName}] ` : '')
                      + (entry.toolOutput?.observation || entry.complianceReason || JSON.stringify(entry.toolInput || {})).slice(0, 120)
                    || '';
                  const complianceVerdict = entry.step === 'COMPLIANCE_CHECK';

                  return (
                    <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.02 }}
                      className="flex gap-3 items-start">
                      <div className="flex flex-col items-center flex-shrink-0">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center"
                          style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}>
                          <StepIcon size={10} style={{ color: cfg.color }} />
                        </div>
                        {i < auditHistory.length - 1 && (
                          <div className="w-px flex-1 mt-1"
                            style={{ background: 'var(--color-border)', minHeight: 10 }} />
                        )}
                      </div>
                      <div className="flex-1 rounded-xl px-3 py-2 text-xs mb-1"
                        style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-bold tracking-widest" style={{ color: cfg.color }}>{cfg.label}</span>
                          {complianceVerdict && (
                            <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${entry.complianceVerified ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'}`}>
                              {entry.complianceVerified ? '✓ APPROVED' : '✗ REJECTED'}
                            </span>
                          )}
                          {entry.fromState && entry.toState && (
                            <span className="ml-auto text-xs opacity-50 font-mono"
                              style={{ color: cfg.color }}>
                              {entry.fromState?.split('_').pop()} → {entry.toState?.split('_').pop()}
                            </span>
                          )}
                        </div>
                        <p className="leading-relaxed font-mono" style={{ color: cfg.color, opacity: 0.82 }}>
                          {text}
                        </p>
                        <p className="mt-0.5 opacity-30 font-mono" style={{ color: cfg.color, fontSize: 10 }}>
                          {new Date(entry.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </p>
                      </div>
                    </motion.div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {/* QUICK TESTS */}
        {activeTab === 'quick' && (
          <div className="flex flex-col gap-2.5 py-1">
            <p className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Simulate customer replies to test the ReAct loop
            </p>
            {TEST_MESSAGES.map(({ label, message: m, icon: MsgIcon }) => (
              <motion.button key={label} disabled={sending}
                onClick={() => { send(m); setActiveTab('chat'); }}
                className="w-full text-left px-4 py-3 rounded-xl transition-all"
                style={{
                  background: 'var(--color-bg-card)',
                  border: '1px solid var(--color-border)',
                  opacity: sending ? 0.5 : 1,
                  cursor: sending ? 'not-allowed' : 'pointer',
                }}
                whileHover={!sending ? { borderColor: 'var(--color-border-hover)', x: 2 } : {}}
                whileTap={!sending ? { scale: 0.98 } : {}}
              >
                <div className="flex items-center gap-2 mb-1">
                  <MsgIcon size={12} style={{ color: 'var(--color-text-muted)' }} />
                  <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>{label}</span>
                </div>
                <p className="text-xs font-mono" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>"{m}"</p>
              </motion.button>
            ))}

            <div className="mt-1 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
              <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--color-text-muted)' }}>
                Razorpay Simulation
              </p>
              <motion.button
                disabled={capturing || txn.state === 'RECOVERED' || txn.state === 'ESCALATED_TO_HUMAN'}
                onClick={() => { simulateCapture(); setActiveTab('chat'); }}
                className="w-full px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-2"
                style={{
                  background: 'rgba(52,211,153,0.08)',
                  border: '1px solid rgba(52,211,153,0.25)',
                  color: '#34d399',
                  opacity: (capturing || ['RECOVERED','ESCALATED_TO_HUMAN'].includes(txn.state)) ? 0.4 : 1,
                  cursor: (capturing || ['RECOVERED','ESCALATED_TO_HUMAN'].includes(txn.state)) ? 'not-allowed' : 'pointer',
                }}
                whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              >
                {capturing ? (
                  <>
                    <motion.div className="w-3 h-3 border-2 rounded-full"
                      style={{ borderColor: '#34d399', borderTopColor: 'transparent' }}
                      animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }} />
                    Sending webhook...
                  </>
                ) : txn.state === 'RECOVERED' ? '✓ Already Recovered'
                  : `⚡ Simulate payment.captured → RECOVERED (₹${txn.originalAmount?.toLocaleString('en-IN')})`}
              </motion.button>
            </div>
          </div>
        )}
      </div>

      {/* Message Input */}
      {activeTab === 'chat' && (
        <div className="px-4 py-3" style={{ borderTop: '1px solid var(--color-border)' }}>
          <div className="flex gap-2">
            <input
              type="text" value={message} disabled={sending}
              onChange={e => setMessage(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && send()}
              placeholder="Type customer message..."
              className="flex-1 rounded-xl px-3 py-2 text-sm focus:outline-none"
              style={{
                background: 'var(--color-bg-card)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-primary)',
              }}
            />
            <motion.button disabled={!message.trim() || sending}
              onClick={() => send()}
              className="px-3 py-2 rounded-xl flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg,var(--color-pulse-red),var(--color-pulse-orange))',
                color: 'white',
                opacity: !message.trim() || sending ? 0.4 : 1,
                cursor: !message.trim() || sending ? 'not-allowed' : 'pointer',
              }}
              whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.9 }}>
              <Send size={15} />
            </motion.button>
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ─────────────────────────────────────────────
// Promise-to-Pay Tracker
// ─────────────────────────────────────────────
function PromiseToPayTracker({ transactions, onSelectTxn }) {
  const mandates = transactions
    .filter(t => t.state === 'MANDATE_PENDING_AUTH' && t.promisedDate)
    .sort((a, b) => new Date(a.promisedDate) - new Date(b.promisedDate));

  const noDate = transactions.filter(t => t.state === 'MANDATE_PENDING_AUTH' && !t.promisedDate);
  const allMandates = [...mandates, ...noDate];

  const totalCommitted = allMandates.reduce((sum, t) => sum + (t.originalAmount || 0), 0);

  function getDueInfo(promisedDate) {
    if (!promisedDate) return { label: 'No date set', color: '#9ca3af', bg: 'rgba(156,163,175,0.1)', days: null };
    const now  = new Date();
    const due  = new Date(promisedDate);
    const diff = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
    if (diff < 0)  return { label: `${Math.abs(diff)}d overdue`, color: '#f87171', bg: 'rgba(248,113,113,0.12)', days: diff };
    if (diff === 0) return { label: 'Due today',                  color: '#fb923c', bg: 'rgba(251,146,60,0.12)',  days: 0 };
    if (diff <= 3)  return { label: `${diff}d left`,              color: '#fb923c', bg: 'rgba(251,146,60,0.1)',   days: diff };
    if (diff <= 7)  return { label: `${diff}d left`,              color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',   days: diff };
    return               { label: `${diff}d left`,              color: '#34d399', bg: 'rgba(52,211,153,0.1)',   days: diff };
  }

  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold">Promise-to-Pay Tracker</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            UPI mandates awaiting customer authorization, sorted by due date
          </p>
        </div>
        <span className="text-xs px-2.5 py-1 rounded-full font-mono"
          style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
          {allMandates.length} mandates
        </span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Total Committed',  value: `₹${totalCommitted.toLocaleString('en-IN')}`, color: '#c084fc', Icon: IndianRupee },
          { label: 'Pending Auth',     value: allMandates.length,                            color: '#60a5fa', Icon: Timer },
          { label: 'Due This Week',    value: mandates.filter(t => { const d = getDueInfo(t.promisedDate); return d.days !== null && d.days >= 0 && d.days <= 7; }).length, color: '#fbbf24', Icon: CalendarClock },
        ].map(s => (
          <motion.div key={s.label} className="rounded-2xl p-5 relative overflow-hidden"
            style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}
            whileHover={{ borderColor: `${s.color}40`, y: -2 }} transition={{ duration: 0.2 }}>
            <div className="absolute -right-3 -top-3 w-16 h-16 rounded-full opacity-10"
              style={{ background: s.color, filter: 'blur(12px)' }} />
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>{s.label}</p>
              <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `${s.color}20` }}>
                <s.Icon size={13} style={{ color: s.color }} />
              </div>
            </div>
            <p className="text-3xl font-bold font-mono" style={{ color: s.color }}>{s.value}</p>
          </motion.div>
        ))}
      </div>

      {/* Timeline list */}
      {allMandates.length === 0 ? (
        <div className="rounded-2xl flex flex-col items-center justify-center py-20 gap-3"
          style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
          <CalendarClock size={32} opacity={0.25} />
          <p className="text-sm">No pending mandates</p>
          <p className="text-xs opacity-60">Run a batch or trigger UPI mandate scenarios to populate this view</p>
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden"
          style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}>
          <div className="px-5 py-3 flex items-center gap-2"
            style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)' }}>
            {[
              { color: '#34d399', label: '>7 days' },
              { color: '#fbbf24', label: '3–7 days' },
              { color: '#fb923c', label: '<3 days' },
              { color: '#f87171', label: 'Overdue' },
            ].map(l => (
              <div key={l.label} className="flex items-center gap-1.5 mr-4">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: l.color }} />
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{l.label}</span>
              </div>
            ))}
          </div>

          <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            {allMandates.map((txn, i) => {
              const due     = getDueInfo(txn.promisedDate);
              const isOverdue = due.days !== null && due.days < 0;

              return (
                <motion.div key={txn._id}
                  initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="flex items-center gap-4 px-5 py-4 cursor-pointer transition-colors"
                  style={{ background: 'transparent' }}
                  onClick={() => onSelectTxn(txn)}
                  whileHover={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>

                  {/* Due date indicator */}
                  <div className="flex-shrink-0 w-14 text-center">
                    {txn.promisedDate ? (
                      <>
                        <p className="text-lg font-bold font-mono leading-none" style={{ color: due.color }}>
                          {new Date(txn.promisedDate).getDate()}
                        </p>
                        <p className="text-xs" style={{ color: due.color, opacity: 0.8 }}>
                          {new Date(txn.promisedDate).toLocaleDateString('en-IN', { month: 'short' })}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No date</p>
                    )}
                  </div>

                  {/* Vertical timeline line */}
                  <div className="flex-shrink-0 flex flex-col items-center" style={{ height: 40 }}>
                    <motion.div className="w-3 h-3 rounded-full border-2"
                      style={{ background: due.bg, borderColor: due.color }}
                      animate={isOverdue ? { scale: [1, 1.3, 1] } : {}}
                      transition={{ duration: 1.5, repeat: Infinity }} />
                    {i < allMandates.length - 1 && (
                      <div className="w-px flex-1 mt-1" style={{ background: 'var(--color-border)' }} />
                    )}
                  </div>

                  {/* Customer info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                        style={{ background: 'linear-gradient(135deg,#c084fc,#448aff)', fontSize: 9 }}>
                        {txn.customerName?.[0]?.toUpperCase() || '?'}
                      </div>
                      <span className="text-sm font-medium truncate" style={{ color: 'var(--color-text-primary)' }}>
                        {txn.customerName}
                      </span>
                      {txn.mandateId && (
                        <span className="text-xs px-1.5 py-0.5 rounded font-mono"
                          style={{ background: 'rgba(192,132,252,0.1)', color: '#c084fc', fontSize: 10 }}>
                          {txn.mandateId.slice(0, 14)}...
                        </span>
                      )}
                    </div>
                    {txn.promisedDate && (
                      <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        Promised: {new Date(txn.promisedDate).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                      </p>
                    )}
                  </div>

                  {/* Amount + status */}
                  <div className="flex-shrink-0 text-right">
                    <p className="text-sm font-bold font-mono" style={{ color: 'var(--color-pulse-orange)' }}>
                      ₹{txn.originalAmount.toLocaleString('en-IN')}
                    </p>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-medium mt-1"
                      style={{ background: due.bg, color: due.color }}>
                      <Clock size={9} />
                      {due.label}
                    </span>
                  </div>

                  {/* Arrow */}
                  <ChevronRight size={14} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                </motion.div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────
// Analytics View (Day 9)
// ─────────────────────────────────────────────
function AnalyticsView({ stats, transactions }) {
  const exceptions = transactions.filter(t =>
    ['ESCALATED_TO_HUMAN', 'RECOVERY_FAILED', 'STOPPING_RULE_TRIGGERED'].includes(t.state)
  );
  const silentRecoveries = transactions.filter(t =>
    t.state === 'RECOVERED' && t.errorCategory === 'infra'
  );
  const mandated = transactions.filter(t => t.state === 'MANDATE_PENDING_AUTH' || t.mandateId);
  const total = stats?.totalTransactions || 0;
  const recovered = stats?.recovered || 0;
  const recoveryPct = total > 0 ? ((recovered / total) * 100).toFixed(1) : '0.0';

  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-semibold">Analytics Summary</h2>
        <span className="text-xs px-2.5 py-1 rounded-full font-mono"
          style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
          {total} total transactions
        </span>
      </div>

      {/* Top stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total" value={total} Icon={List} iconColor="#9ca3af" />
        <StatCard label="Recovered" value={recovered} accent="#34d399" Icon={UserCheck} iconColor="#34d399" />
        <StatCard label="Escalated" value={stats?.escalated ?? 0} accent="#fbbf24" Icon={AlertTriangle} iconColor="#fbbf24" />
        <StatCard label="In Progress" value={stats?.inProgress ?? 0} accent="#60a5fa" Icon={RefreshCw} iconColor="#60a5fa" />
      </div>

      {/* Money cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Gross Value at Risk',  value: `₹${(stats?.grossValueAtRisk ?? 0).toLocaleString('en-IN')}`,      color: '#f87171', Icon: DollarSign },
          { label: 'Total Recovered',      value: `₹${(stats?.totalRecoveredAmount ?? 0).toLocaleString('en-IN')}`,  color: '#34d399', Icon: CheckCircle2 },
          { label: 'Recovery Rate',        value: `${recoveryPct}%`,                                                  color: '#448aff', Icon: Percent },
        ].map(s => (
          <motion.div key={s.label} className="rounded-2xl p-5"
            style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}
            whileHover={{ borderColor: 'var(--color-border-hover)', y: -2 }}
            transition={{ duration: 0.2 }}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>{s.label}</p>
              <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `${s.color}15` }}>
                <s.Icon size={13} style={{ color: s.color }} />
              </div>
            </div>
            <p className="text-3xl font-bold font-mono" style={{ color: s.color }}>{s.value}</p>
          </motion.div>
        ))}
      </div>

      {/* Pipeline */}
      <RecoveryPipeline transactions={transactions} />

      {/* Secondary stats row */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="rounded-2xl p-5"
          style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}>
          <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--color-text-muted)' }}>Silent Recoveries</p>
          <p className="text-xs mb-3" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
            Infra errors resolved without customer contact
          </p>
          <p className="text-3xl font-bold font-mono" style={{ color: '#facc15' }}>{silentRecoveries.length}</p>
        </div>
        <div className="rounded-2xl p-5"
          style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}>
          <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--color-text-muted)' }}>Mandate / Pending Auth</p>
          <p className="text-xs mb-3" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
            UPI AutoPay mandates awaiting authorization
          </p>
          <p className="text-3xl font-bold font-mono" style={{ color: '#c084fc' }}>{mandated.length}</p>
        </div>
      </div>

      {/* Honest Exception List */}
      <div className="rounded-2xl overflow-hidden"
        style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}>
        <div className="px-5 py-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--color-border)' }}>
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} style={{ color: '#fbbf24' }} />
            <h3 className="text-sm font-semibold">Honest Exception List</h3>
          </div>
          <span className="text-xs px-2 py-0.5 rounded-full font-mono"
            style={{ background: 'rgba(251,191,36,0.1)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)' }}>
            {exceptions.length} exceptions
          </span>
        </div>
        {exceptions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2"
            style={{ color: 'var(--color-text-muted)' }}>
            <CheckCircle2 size={28} className="text-emerald-400 opacity-50" />
            <p className="text-sm">No exceptions — all transactions resolved cleanly</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs uppercase tracking-widest"
                  style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-muted)' }}>
                  {['Customer', 'Amount', 'Error Code', 'State', 'Reason', 'Time'].map(h => (
                    <th key={h} className="py-3 px-4 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {exceptions.map((txn, i) => {
                  const sc = STATE_COLORS[txn.state] || { text: 'text-gray-400', dot: '#6b7280', label: txn.state };
                  return (
                    <motion.tr key={txn._id}
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      transition={{ delay: i * 0.04 }}
                      className="border-b"
                      style={{ borderColor: 'var(--color-border)' }}>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                            style={{ background: 'linear-gradient(135deg,#f87171,#fb923c)', fontSize: 9 }}>
                            {txn.customerName?.[0]?.toUpperCase() || '?'}
                          </div>
                          <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                            {txn.customerName}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-sm font-bold font-mono" style={{ color: 'var(--color-pulse-orange)' }}>
                          ₹{txn.originalAmount.toLocaleString('en-IN')}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-xs font-mono" style={{ color: 'var(--color-text-secondary)' }}>
                          {txn.errorCode}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: sc.dot }} />
                          <span className={`text-xs font-medium ${sc.text}`}>{sc.label}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-xs px-2 py-0.5 rounded-lg"
                          style={{ background: 'rgba(251,191,36,0.08)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.15)' }}>
                          {txn.escalationReason
                            ? txn.escalationReason.replace(/_/g, ' ').toLowerCase()
                            : txn.state === 'RECOVERY_FAILED' ? 'outreach exhausted' : 'unknown'}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                          {new Date(txn.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────
export default function App() {
  const [transactions, setTransactions] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [serverOnline, setServerOnline] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTxn, setSelectedTxn] = useState(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null);
  const [activeView, setActiveView] = useState('overview');
  const [feedEntries, setFeedEntries] = useState([]);
  const [recentBatch, setRecentBatch] = useState([]);

  const fetchData = useCallback(async () => {
    try {
      const [txnRes, statsRes] = await Promise.all([api.getTransactions(), api.getStats()]);
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
    socket.on('txn:created', (t) => {
      setTransactions(prev => [t, ...prev]);
      api.getStats().then(r => setStats(r.data)).catch(() => {});
    });
    socket.on('txn:updated', (t) => {
      setTransactions(prev => prev.map(x => x._id === t._id ? t : x));
      setSelectedTxn(prev => prev?._id === t._id ? t : prev);
      setRecentBatch(prev => [...prev.filter(x => x._id !== t._id), t].slice(-10));
      api.getStats().then(r => setStats(r.data)).catch(() => {});
    });
    socket.on('batch:started', () => { setBatchRunning(true); setBatchProgress({ processed:0,total:0,success:0,failed:0 }); setRecentBatch([]); });
    socket.on('batch:progress', (p) => { setBatchProgress(p); if (p.processed % 5 === 0) api.getStats().then(r => setStats(r.data)).catch(() => {}); });
    socket.on('batch:completed', (p) => { setBatchRunning(false); setBatchProgress(p); api.getStats().then(r => setStats(r.data)).catch(() => {}); });
    socket.on('batch:error', () => setBatchRunning(false));
    socket.on('audit:created', (e) => setFeedEntries(prev => [...prev, { ...e, ts: new Date() }].slice(-20)));
    return () => {
      ['connect','disconnect','txn:created','txn:updated','batch:started','batch:progress','batch:completed','batch:error','audit:created']
        .forEach(ev => socket.off(ev));
      socket.disconnect();
    };
  }, [fetchData]);

  const runBatch = async () => {
    if (batchRunning) return;
    try { await api.runBatch({ speedMultiplier: 10, concurrency: 5 }); }
    catch (err) { setError(err.message); setBatchRunning(false); }
  };

  const simulatePayment = async () => {
    const payloads = [
      { customerName: 'Sparsh',       phone: '+918954003032', email: 'sparsh@example.com', originalAmount: 4999,  errorCode: 'INSUFFICIENT_FUNDS' },
      { customerName: 'Rahul Sharma', phone: '+918954003032', email: 'rahul@example.com',  originalAmount: 12500, errorCode: 'BANK_SERVER_DOWN' },
      { customerName: 'Priya Patel',  phone: '+918954003032', email: 'sparshchaudhary.jee@gmail.com', originalAmount: 2999, errorCode: 'CARD_EXPIRED' },
    ];
    try { await api.simulateFailedPayment(payloads[Math.floor(Math.random() * payloads.length)]); }
    catch (err) { setError(err.message); }
  };

  // ── Table ──
  const TransactionTable = ({ compact = false }) => (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}>
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <motion.div className="w-8 h-8 border-2 rounded-full"
            style={{ borderColor: 'var(--color-pulse-red)', borderTopColor: 'transparent' }}
            animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }} />
        </div>
      ) : transactions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3"
          style={{ color: 'var(--color-text-muted)' }}>
          <DollarSign size={32} opacity={0.25} />
          <p className="text-sm">No failed payments detected</p>
          <p className="text-xs opacity-60">Click "Simulate Failed Payment" to test</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-xs uppercase tracking-widest"
                style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-muted)' }}>
                {['Customer','Amount','Error Code','Root Cause','State','Time'].map(h => (
                  <th key={h} className="py-3 px-4 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transactions.map(txn => (
                <TransactionRow key={txn._id} txn={txn}
                  isSelected={selectedTxn?._id === txn._id}
                  onClick={() => setSelectedTxn(prev => prev?._id === txn._id ? null : txn)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // ── Views ──
  const views = {
    overview: (
      <>
        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard label="Total Transactions" value={stats?.totalTransactions ?? 0}
            Icon={List} iconColor="#9ca3af"
            gradient="linear-gradient(135deg, var(--color-bg-card) 0%, rgba(156,163,175,0.05) 100%)" />
          <StatCard label="Recovered" value={stats?.recovered ?? 0}
            accent="#34d399" Icon={CheckCircle2} iconColor="#34d399"
            gradient="linear-gradient(135deg, var(--color-bg-card) 0%, rgba(52,211,153,0.06) 100%)" />
          <StatCard label="Value at Risk"
            value={`₹${(stats?.grossValueAtRisk ?? 0).toLocaleString('en-IN')}`}
            accent="#f87171" Icon={DollarSign} iconColor="#f87171"
            gradient="linear-gradient(135deg, var(--color-bg-card) 0%, rgba(248,113,113,0.06) 100%)" />
          <StatCard label="Recovery Rate" value={`${stats?.recoveryRate ?? 0}%`}
            accent="#448aff" Icon={Percent} iconColor="#448aff"
            gradient="linear-gradient(135deg, var(--color-bg-card) 0%, rgba(68,138,255,0.06) 100%)" />
        </div>

        {/* Batch Monitor */}
        <AnimatePresence>
          {batchProgress && (
            <BatchMonitor batchProgress={batchProgress} batchRunning={batchRunning} recentBatch={recentBatch} />
          )}
        </AnimatePresence>

        {/* Pipeline */}
        <RecoveryPipeline transactions={transactions} />

        {/* Table + Feed */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          <div className="xl:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold">Failed Payments</h2>
              <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
                {transactions.length} records · click to inspect
              </span>
            </div>
            <TransactionTable />
          </div>
          <div className="xl:col-span-1">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold">ReAct Agent Feed</h2>
              <span className="text-xs px-2 py-0.5 rounded-full font-mono"
                style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}>
                LIVE
              </span>
            </div>
            <AgentFeedPanel feedEntries={feedEntries} />
          </div>
        </div>
      </>
    ),
    transactions: (
      <>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">All Transactions</h2>
          <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
            {transactions.length} total
          </span>
        </div>
        <TransactionTable />
      </>
    ),
    'agent-feed': (
      <>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">ReAct Agent Feed</h2>
          <motion.button onClick={() => setFeedEntries([])}
            className="text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
            whileHover={{ borderColor: 'var(--color-border-hover)' }}>
            Clear Feed
          </motion.button>
        </div>
        <div className="max-w-3xl">
          <AgentFeedPanel feedEntries={feedEntries} />
        </div>
      </>
    ),
    'p2p-tracker': (
      <PromiseToPayTracker
        transactions={transactions}
        onSelectTxn={txn => setSelectedTxn(prev => prev?._id === txn._id ? null : txn)}
      />
    ),
    analytics: (
      <AnalyticsView stats={stats} transactions={transactions} />
    ),
  };

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--color-bg-primary)' }}>
      <Sidebar active={activeView} onSelect={setActiveView} />

      <div className="flex-1 flex flex-col transition-all duration-300"
        style={{ marginLeft: 64, marginRight: selectedTxn ? 440 : 0 }}>

        {/* Header */}
        <header className="sticky top-0 z-40 backdrop-blur-xl"
          style={{ background: 'rgba(10,10,15,0.88)', borderBottom: '1px solid var(--color-border)' }}>
          <div className="px-6 py-3.5 flex items-center justify-between">
            <div>
              <h1 className="text-base font-bold tracking-tight">Recovery Command Center</h1>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Autonomous Revenue Recovery · RecoverPulse AI</p>
            </div>
            <div className="flex items-center gap-3">
              {/* Server */}
              <motion.div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                style={{
                  background: serverOnline ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
                  color: serverOnline ? '#34d399' : '#f87171',
                }}
                animate={{ opacity: [1, 0.85, 1] }} transition={{ duration: 2, repeat: Infinity }}>
                {serverOnline ? <Wifi size={12} /> : <WifiOff size={12} />}
                {serverOnline ? 'Server Online' : 'Server Offline'}
              </motion.div>

              {/* Run Batch */}
              <motion.button disabled={!serverOnline || batchRunning} onClick={runBatch}
                className="px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text-primary)',
                  opacity: !serverOnline || batchRunning ? 0.4 : 1,
                  cursor: !serverOnline || batchRunning ? 'not-allowed' : 'pointer',
                }}
                whileHover={serverOnline && !batchRunning ? { borderColor: 'var(--color-border-hover)' } : {}}
                whileTap={serverOnline && !batchRunning ? { scale: 0.97 } : {}}>
                {batchRunning ? (
                  <>
                    <motion.div className="w-3 h-3 border-2 rounded-full"
                      style={{ borderColor: '#448aff', borderTopColor: 'transparent' }}
                      animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }} />
                    {batchProgress ? `${batchProgress.processed}/${batchProgress.total}` : 'Starting...'}
                  </>
                ) : <><Zap size={14} /> Run Batch (50)</>}
              </motion.button>

              {/* Simulate */}
              <motion.button disabled={!serverOnline} onClick={simulatePayment}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white"
                style={{
                  background: 'linear-gradient(135deg,var(--color-pulse-red),var(--color-pulse-orange))',
                  boxShadow: '0 4px 20px rgba(255,59,92,0.3)',
                  opacity: !serverOnline ? 0.4 : 1,
                  cursor: !serverOnline ? 'not-allowed' : 'pointer',
                }}
                whileHover={{ scale: 1.03, boxShadow: '0 4px 28px rgba(255,59,92,0.45)' }}
                whileTap={{ scale: 0.97 }}>
                Simulate Failed Payment
              </motion.button>
            </div>
          </div>
        </header>

        {/* Error bar */}
        <AnimatePresence>
          {error && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-6 py-3 text-sm flex items-center gap-2"
              style={{ background: 'rgba(248,113,113,0.1)', borderBottom: '1px solid rgba(248,113,113,0.25)', color: '#f87171' }}>
              <AlertTriangle size={14} />
              {error}
              <button onClick={() => setError(null)} className="ml-auto"><X size={14} /></button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Content */}
        <main className="flex-1 px-6 py-6">
          <AnimatePresence mode="wait">
            <motion.div key={activeView}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}>
              {views[activeView] || views.overview}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* Agent Panel */}
      <AnimatePresence>
        {selectedTxn && <AgentPanel key={selectedTxn._id} txn={selectedTxn} onClose={() => setSelectedTxn(null)} />}
      </AnimatePresence>
    </div>
  );
}
