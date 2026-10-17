// The payment authority model used by the offline scenario runner. It reproduces the
// Stripe manual-capture semantics we verified on a test sandbox on 2026-10-17:
//   - a PaymentIntent authorized with capture_method=manual sits in requires_capture;
//   - it can be captured exactly once, for amount_to_capture <= the authorized amount;
//   - a partial capture releases the remainder at once, and any further capture fails
//     ("the remainder of the authorized amount has been released");
//   - a release (cancel) of an uncaptured hold returns the whole amount;
//   - a hold that is never captured nor released is stranded (the driver's money stays
//     blocked until the authorization expires).
// Live, the host executes intents on real Stripe and reports the answers back instead.

export const MESSAGES = {
  remainderReleased: 'This PaymentIntent could not be captured: the remainder of the authorized amount has been released.',
  alreadyCaptured: 'This PaymentIntent could not be captured because it has a status of succeeded. Only a PaymentIntent with one of the following statuses may be captured: requires_capture.',
  canceled: 'This PaymentIntent could not be captured because it has a status of canceled. Only a PaymentIntent with one of the following statuses may be captured: requires_capture.',
  cancelAfterCapture: 'You cannot cancel this PaymentIntent because it has a status of succeeded.',
};

export class PaymentAuthority {
  constructor() {
    this.pis = new Map();
  }

  authorize(id, amount, currency = 'eur') {
    const pi = { id, object: 'payment_intent', amount, currency, amount_capturable: amount, amount_received: 0, status: 'requires_capture', capture_method: 'manual', attempts: 0 };
    this.pis.set(id, pi);
    return { ...pi };
  }

  get(id) { const p = this.pis.get(id); return p ? { ...p } : null; }

  execute(intent) {
    return intent.amount_cents === 0 ? this.cancel(intent.payment_intent) : this.capture(intent.payment_intent, intent.amount_cents);
  }

  capture(id, amountToCapture) {
    const pi = this.pis.get(id);
    if (!pi) return fail('resource_missing', `No such payment_intent: '${id}'`, null);
    pi.attempts++;
    if (pi.status === 'succeeded') {
      return fail('payment_intent_unexpected_state', pi.amount_received < pi.amount ? MESSAGES.remainderReleased : MESSAGES.alreadyCaptured, pi);
    }
    if (pi.status === 'canceled') return fail('payment_intent_unexpected_state', MESSAGES.canceled, pi);
    if (!Number.isInteger(amountToCapture) || amountToCapture <= 0) {
      return fail('parameter_invalid_integer', 'amount_to_capture must be a positive integer number of cents.', pi);
    }
    if (amountToCapture > pi.amount_capturable) {
      return fail('amount_too_large', `amount_to_capture (${amountToCapture}) must be less than or equal to amount_capturable (${pi.amount_capturable}).`, pi);
    }
    pi.amount_received = amountToCapture;
    pi.amount_capturable = 0;
    pi.status = 'succeeded';
    return { ok: true, status: 'succeeded', error: null, stripe_object: { ...pi, amount_released: pi.amount - amountToCapture } };
  }

  cancel(id) {
    const pi = this.pis.get(id);
    if (!pi) return fail('resource_missing', `No such payment_intent: '${id}'`, null);
    pi.attempts++;
    if (pi.status === 'succeeded') return fail('payment_intent_unexpected_state', MESSAGES.cancelAfterCapture, pi);
    if (pi.status === 'canceled') return { ok: true, status: 'canceled', error: null, stripe_object: { ...pi } };
    pi.status = 'canceled';
    pi.amount_capturable = 0;
    return { ok: true, status: 'canceled', error: null, stripe_object: { ...pi, amount_released: pi.amount } };
  }
}

function fail(code, message, pi) {
  return { ok: false, status: pi ? pi.status : 'error', error: { code, message }, stripe_object: pi ? { ...pi } : null };
}
