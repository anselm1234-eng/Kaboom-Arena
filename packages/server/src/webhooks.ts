import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Store } from './store';

/** HMAC-SHA256 of the raw body, hex, compared in constant time. */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHex: string | undefined,
  secret: string,
): boolean {
  if (!signatureHex) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHex, 'hex');
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

interface WebhookPayload {
  meta?: {
    event_name?: string;
    custom_data?: Record<string, unknown>;
  };
  data?: {
    id?: string;
    attributes?: {
      order_id?: number;
    };
  };
}

export interface WebhookResult {
  status: number;
  body: string;
}

/**
 * The webhook (not the checkout redirect) is the source of truth for
 * payment. order_created activates the brick; license_key_created attaches
 * the key id so /manage can find the brick by key.
 */
export function handleLsWebhook(
  store: Store,
  rawBody: Buffer,
  signature: string | undefined,
  secret: string | null,
  now: number,
): WebhookResult {
  if (!secret) return { status: 503, body: 'webhooks not configured' };
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    return { status: 401, body: 'bad signature' };
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as WebhookPayload;
  } catch {
    return { status: 400, body: 'bad json' };
  }

  const event = payload.meta?.event_name;
  const dataId = payload.data?.id;
  if (!event || !dataId) return { status: 400, body: 'missing event/data id' };

  // Idempotency: each (event, object id) pair is processed exactly once.
  if (!store.markWebhookProcessed(`${event}:${dataId}`, now)) {
    return { status: 200, body: 'already processed' };
  }

  if (event === 'order_created') {
    const brickId = payload.meta?.custom_data?.brick_id;
    if (typeof brickId === 'string' && brickId.length > 0) {
      const orderId = Number(dataId);
      if (store.markPaid(brickId, orderId, now)) {
        return { status: 200, body: 'brick activated' };
      }
      return { status: 200, body: 'brick not pending (ignored)' };
    }
    return { status: 200, body: 'no brick_id (skin or other product)' };
  }

  if (event === 'license_key_created') {
    const orderId = payload.data?.attributes?.order_id;
    if (typeof orderId === 'number') {
      store.attachLicenseKey(orderId, Number(dataId));
      return { status: 200, body: 'license key attached' };
    }
    return { status: 200, body: 'no order id' };
  }

  return { status: 200, body: `ignored event ${event}` };
}
