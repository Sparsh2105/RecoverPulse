/**
 * @file services/triageService.js
 * @description Classifies payment gateway error codes into broad categories.
 */

'use strict';

/**
 * Classifies an error code deterministically.
 * @param {string} errorCode 
 * @returns {'infra' | 'soft_decline' | 'hard_decline'}
 */
function classifyErrorCode(errorCode) {
  const code = (errorCode || '').toUpperCase().trim();

  const infra = [
    'BANK_SERVER_DOWN', 'GATEWAY_TIMEOUT', 'NETWORK_ERROR', 
    'PAYMENT_GATEWAY_ERROR', 'SERVER_ERROR', 'TECHNICAL_ERROR'
  ];
  
  const hard = [
    'CARD_EXPIRED', 'CARD_LOST', 'CARD_STOLEN', 
    'INVALID_CARD', 'CARD_BLOCKED', 'FRAUD_SUSPECTED'
  ];

  if (infra.includes(code)) return 'infra';
  if (hard.includes(code)) return 'hard_decline';
  
  // Default fallback is soft_decline (insufficient funds, generic declines, etc.)
  return 'soft_decline';
}

module.exports = { classifyErrorCode };
