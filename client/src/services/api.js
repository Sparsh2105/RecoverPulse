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

  // ── Health ──
  healthCheck: () => request('/health'),
};

export default api;
