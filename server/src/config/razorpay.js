'use strict';

/**
 * @file config/razorpay.js
 * @description Razorpay SDK singleton setup
 */

const Razorpay = require('razorpay');

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error('CRITICAL: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing from .env');
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

module.exports = razorpay;
