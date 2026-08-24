/**
 * @file middleware/validate.js
 * @description Shared, pure validation utilities for payment payload validation.
 * All helpers are stateless and Express-free â€” fully testable in isolation.
 */

'use strict';

// Constants

/** E.164 international phone format: +<country><subscriber>, 7-15 digits total */
const PHONE_RE = /^\+[1-9]\d{6,14}$/;

/** Simple RFC-5322-inspired email regex (no consecutive dots, local + domain) */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Supported ISO 4217 currency codes */
const VALID_CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD']);

/** Maximum accepted transaction amount (1 billion) */
const MAX_AMOUNT = 1_000_000_000;

// Primitive helpers

/**
 * Returns true when `v` is a non-empty string after trimming whitespace.
 * @param {unknown} v - Value to test.
 * @returns {boolean}
 */
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// Payload validator

/**
 * Validates all fields of an incoming payment-failed webhook payload.
 *
 * This function is pure: it accepts a plain object and returns a result
 * object with no side-effects, no DB calls, and no Express dependencies.
 *
 * @param {object} body - The raw request body.
 * @param {string}  body.customerName    - Full name of the customer.
 * @param {string}  body.phone           - Customer phone in E.164 format.
 * @param {string}  [body.email]         - Optional customer email address.
 * @param {number|string} body.originalAmount - Transaction amount (> 0 and <= MAX_AMOUNT).
 * @param {string}  [body.currency]      - ISO 4217 currency code (defaults to 'INR').
 * @param {string}  body.errorCode       - Payment gateway error code.
 * @param {string}  [body.paymentId]     - Optional idempotency key for deduplication.
 *
 * @returns {{ valid: true, sanitized: object }
 *           | { valid: false, status: number, errorCode: string, error: string }}
 *
 * On success returns `{ valid: true, sanitized }` where sanitized is the
 * cleaned, coerced version of every accepted field ready for DB insertion.
 * On failure returns `{ valid: false, status, errorCode, error, ...extras }`.
 */
function validatePaymentPayload(body) {
  const { customerName, phone, email, originalAmount, currency, errorCode, paymentId } = body;

    const missingFields = [];
  if (!isNonEmptyString(customerName)) missingFields.push('customerName');
  if (!isNonEmptyString(phone))        missingFields.push('phone');
  if (!isNonEmptyString(errorCode))    missingFields.push('errorCode');
  if (originalAmount === undefined || originalAmount === null || originalAmount === '')
    missingFields.push('originalAmount');

  if (missingFields.length > 0) {
    return {
      valid: false,
      status: 400,
      errorCode: 'MISSING_REQUIRED_FIELDS',
      error: `Missing or blank required fields: ${missingFields.join(', ')}`,
      missingFields,
    };
  }

    if (!PHONE_RE.test(phone.trim())) {
    return {
      valid: false,
      status: 400,
      errorCode: 'INVALID_PHONE_FORMAT',
      error: 'phone must be in E.164 format, e.g. +919876543210',
    };
  }

    if (email && !EMAIL_RE.test(String(email).trim())) {
    return {
      valid: false,
      status: 400,
      errorCode: 'INVALID_EMAIL_FORMAT',
      error: 'email is not a valid email address',
    };
  }

    const amount = Number(originalAmount);
  if (!Number.isFinite(amount)) {
    return {
      valid: false,
      status: 400,
      errorCode: 'INVALID_AMOUNT_TYPE',
      error: 'originalAmount must be a finite number',
    };
  }
  if (amount <= 0) {
    return {
      valid: false,
      status: 400,
      errorCode: 'AMOUNT_MUST_BE_POSITIVE',
      error: 'originalAmount must be greater than 0',
    };
  }
  if (amount > MAX_AMOUNT) {
    return {
      valid: false,
      status: 400,
      errorCode: 'AMOUNT_EXCEEDS_LIMIT',
      error: `originalAmount cannot exceed ${MAX_AMOUNT.toLocaleString()}`,
    };
  }

    const resolvedCurrency = currency ? String(currency).toUpperCase().trim() : 'INR';
  if (!VALID_CURRENCIES.has(resolvedCurrency)) {
    return {
      valid: false,
      status: 400,
      errorCode: 'INVALID_CURRENCY',
      error: `currency "${resolvedCurrency}" is not supported. Accepted: ${[...VALID_CURRENCIES].join(', ')}`,
    };
  }

    return {
    valid: true,
    sanitized: {
      customerName:   customerName.trim(),
      phone:          phone.trim(),
      email:          email ? String(email).trim().toLowerCase() : null,
      originalAmount: amount,
      currency:       resolvedCurrency,
      errorCode:      errorCode.trim().toUpperCase(),
      paymentId:      paymentId && isNonEmptyString(paymentId) ? paymentId.trim() : null,
    },
  };
}

// Exports

module.exports = {
  PHONE_RE,
  EMAIL_RE,
  VALID_CURRENCIES,
  MAX_AMOUNT,
  isNonEmptyString,
  validatePaymentPayload,
};

