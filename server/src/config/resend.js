'use strict';

/**
 * @file config/resend.js
 * @description Resend email client singleton.
 *
 * Set in .env:
 *   RESEND_API_KEY     = re_xxxxxxxxxxxx
 *   RESEND_FROM_EMAIL  = noreply@yourdomain.com
 */

const { Resend } = require('resend');

const resendClient = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

function isResendConfigured() {
  return (
    process.env.RESEND_API_KEY &&
    process.env.RESEND_API_KEY !== 'your_resend_api_key'
  );
}

module.exports = { resendClient, FROM_EMAIL, isResendConfigured };
