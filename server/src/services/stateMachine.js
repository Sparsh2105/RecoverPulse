/**
 * @file services/stateMachine.js
 * @description Finite State Machine for transaction workflows.
 */

'use strict';

const TRANSITIONS = {
  FAILED_PAYMENT_INGESTED: {
    RETRY_SCHEDULED: 'SILENT_RETRY_SCHEDULED',
    OUTREACH_INITIATED: 'OUTREACH_INITIATED'
  },
  SILENT_RETRY_SCHEDULED: {
    PAYMENT_CAPTURED: 'RECOVERED',
    RETRY_EXHAUSTED: 'OUTREACH_INITIATED',
    OUTREACH_INITIATED: 'OUTREACH_INITIATED'
  },
  OUTREACH_INITIATED: {
    MANDATE_CREATED: 'MANDATE_PENDING_AUTH',
    DISCOUNT_APPLIED: 'DISCOUNT_GATED_LINK',
    STOPPING_RULE_HIT: 'STOPPING_RULE_TRIGGERED',
    EXHAUSTED: 'RECOVERY_FAILED'
  },
  MANDATE_PENDING_AUTH: {
    MANDATE_CREATED: 'MANDATE_PENDING_AUTH', // Self-transition if they update the date
    DISCOUNT_APPLIED: 'DISCOUNT_GATED_LINK', // Changed their mind to pay now with discount
    STOPPING_RULE_HIT: 'STOPPING_RULE_TRIGGERED',
    PAYMENT_CAPTURED: 'RECOVERED'
  },
  DISCOUNT_GATED_LINK: {
    MANDATE_CREATED: 'MANDATE_PENDING_AUTH', // Changed their mind to pay later via mandate
    DISCOUNT_APPLIED: 'DISCOUNT_GATED_LINK', // Self-transition if discount is updated
    STOPPING_RULE_HIT: 'STOPPING_RULE_TRIGGERED',
    PAYMENT_CAPTURED: 'RECOVERED'
  },
  STOPPING_RULE_TRIGGERED: {
    ESCALATED: 'ESCALATED_TO_HUMAN'
  },
  RECOVERY_FAILED: {
    ESCALATED: 'ESCALATED_TO_HUMAN'
  }
};

/**
 * Gets the next state for a given event, or throws an error if illegal.
 * @param {string} currentState 
 * @param {string} event 
 * @returns {string} nextState
 */
function getNextState(currentState, event) {
  const nextState = TRANSITIONS[currentState]?.[event];
  if (!nextState) {
    throw new Error(`Illegal transition: ${currentState} -> ${event}`);
  }
  return nextState;
}

module.exports = { TRANSITIONS, getNextState };
