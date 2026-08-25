const API_BASE = '/api';

/**
 * Generic fetch wrapper with error handling
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  };

  const response = await fetch(url, config);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
}

/**
 * API service for RecoverPulse backend
 */
const api = {
  // ── Transactions ──
  getTransactions: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/transactions${query ? `?${query}` : ''}`);
  },

  getTransaction: (id) => request(`/transactions/${id}`),

  getStats: () => request('/transactions/stats/summary'),

  // ── Webhooks (for testing) ──
  simulateFailedPayment: (payload) =>
    request('/webhooks/payment-failed', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // ── Razorpay simulation (Day 6 — simulates payment.captured webhook) ──
  simulateRazorpayCapture: (transactionId, amount) =>
    request('/webhooks/razorpay', {
      method: 'POST',
      body: JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id:       'pay_test_' + Date.now(),
              amount:   Math.round(amount * 100), // paise
              currency: 'INR',
              status:   'captured',
              notes:    { transactionId },
            },
          },
        },
      }),
    }),

  // ── Health ──
  healthCheck: () => request('/health'),
};

export default api;
