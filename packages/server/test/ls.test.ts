import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LsError, createLsClient, type FetchFn } from '../src/ls';
import { Store } from '../src/store';
import { handleLsWebhook, verifyWebhookSignature } from '../src/webhooks';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('license API client', () => {
  it('parses a valid license validation', async () => {
    const fetchFn: FetchFn = async (url) => {
      expect(url).toContain('/v1/licenses/validate');
      return jsonResponse({
        valid: true,
        error: null,
        license_key: { id: 42, status: 'active', activation_limit: 5, activation_usage: 2 },
        meta: { store_id: 7, order_id: 555, variant_id: 99 },
      });
    };
    const ls = createLsClient(null, fetchFn);
    const result = await ls.validateLicense('KEY-123');
    expect(result.valid).toBe(true);
    expect(result.licenseKeyId).toBe(42);
    expect(result.orderId).toBe(555);
    expect(result.variantId).toBe(99);
    expect(result.activationLimit).toBe(5);
  });

  it('reports activation-limit failures from the API', async () => {
    const fetchFn: FetchFn = async () =>
      jsonResponse(
        { activated: false, error: 'This license key has reached the activation limit.' },
        400,
      );
    const ls = createLsClient(null, fetchFn);
    const result = await ls.activateLicense('KEY-123', 'device');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('activation limit');
  });

  it('throws LsError(unreachable) on network failure', async () => {
    const ls = createLsClient(null, async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(ls.validateLicense('KEY')).rejects.toThrow(LsError);
  });

  it('creates checkouts with custom data and returns the URL', async () => {
    const fetchFn: FetchFn = async (url, init) => {
      expect(url).toContain('/v1/checkouts');
      const body = JSON.parse(String(init.body)) as {
        data: {
          attributes: { checkout_data: { custom: Record<string, string> } };
          relationships: { variant: { data: { id: string } } };
        };
      };
      expect(body.data.attributes.checkout_data.custom.brick_id).toBe('brick-1');
      expect(body.data.relationships.variant.data.id).toBe('var-3x1');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-key');
      return jsonResponse({ data: { attributes: { url: 'https://checkout.test/abc' } } });
    };
    const ls = createLsClient('test-key', fetchFn);
    const url = await ls.createCheckout({
      storeId: 'store-1',
      variantId: 'var-3x1',
      customData: { brick_id: 'brick-1' },
      redirectUrl: 'https://game.test/manage',
    });
    expect(url).toBe('https://checkout.test/abc');
  });

  it('refuses checkout creation without an API key', async () => {
    const ls = createLsClient(null, async () => jsonResponse({}));
    await expect(
      ls.createCheckout({ storeId: 's', variantId: 'v', customData: {}, redirectUrl: 'r' }),
    ).rejects.toThrow(LsError);
  });
});

describe('webhook signature verification', () => {
  const secret = 'whsec';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const goodSig = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a correct HMAC and rejects everything else', () => {
    expect(verifyWebhookSignature(body, goodSig, secret)).toBe(true);
    expect(verifyWebhookSignature(body, goodSig.replace(/^./, '0'), secret)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, 'zznothex', secret)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from('tampered'), goodSig, secret)).toBe(false);
  });
});

describe('webhook handling', () => {
  const secret = 'whsec';
  const BRICK_ID = '1'.repeat(32);

  function makeStoreWithBrick(): Store {
    const store = new Store(':memory:');
    store.createBrick({
      id: BRICK_ID,
      size: 3,
      displayName: 'Acme',
      linkUrl: null,
      tilePaths: ['t0', 't1', 't2'],
      fullPath: 'f',
      originalPath: 'o',
      now: 0,
    });
    return store;
  }

  function signedEvent(event: string, dataId: string, extra: object, custom: object): {
    raw: Buffer;
    sig: string;
  } {
    const raw = Buffer.from(
      JSON.stringify({
        meta: { event_name: event, custom_data: custom },
        data: { id: dataId, attributes: extra },
      }),
    );
    return { raw, sig: createHmac('sha256', secret).update(raw).digest('hex') };
  }

  it('rejects bad signatures with 401', () => {
    const store = makeStoreWithBrick();
    const { raw } = signedEvent('order_created', '500', {}, { brick_id: BRICK_ID });
    expect(handleLsWebhook(store, raw, 'deadbeef', secret, 1000).status).toBe(401);
    expect(store.getBrick(BRICK_ID)?.status).toBe('pending_payment');
  });

  it('activates the brick on order_created and is idempotent on replay', () => {
    const store = makeStoreWithBrick();
    const { raw, sig } = signedEvent('order_created', '500', {}, { brick_id: BRICK_ID });

    const first = handleLsWebhook(store, raw, sig, secret, 1000);
    expect(first.status).toBe(200);
    const brick = store.getBrick(BRICK_ID)!;
    expect(brick.status).toBe('active');
    expect(brick.orderId).toBe(500);
    expect(brick.expiresAt).toBe(1000 + 30 * 86_400_000);

    const replay = handleLsWebhook(store, raw, sig, secret, 99_999);
    expect(replay.status).toBe(200);
    expect(replay.body).toBe('already processed');
    expect(store.getBrick(BRICK_ID)!.expiresAt).toBe(1000 + 30 * 86_400_000); // unchanged
  });

  it('attaches license keys from license_key_created', () => {
    const store = makeStoreWithBrick();
    const order = signedEvent('order_created', '500', {}, { brick_id: BRICK_ID });
    handleLsWebhook(store, order.raw, order.sig, secret, 1000);

    const lk = signedEvent('license_key_created', '9001', { order_id: 500 }, {});
    expect(handleLsWebhook(store, lk.raw, lk.sig, secret, 1100).status).toBe(200);
    expect(store.getBrick(BRICK_ID)?.licenseKeyId).toBe(9001);
  });

  it('ignores unrelated events and orders without brick ids', () => {
    const store = makeStoreWithBrick();
    const skinOrder = signedEvent('order_created', '600', {}, {});
    expect(handleLsWebhook(store, skinOrder.raw, skinOrder.sig, secret, 1000).status).toBe(200);
    expect(store.getBrick(BRICK_ID)?.status).toBe('pending_payment');

    const other = signedEvent('subscription_created', '700', {}, {});
    expect(handleLsWebhook(store, other.raw, other.sig, secret, 1000).status).toBe(200);
  });

  it('returns 503 when no webhook secret is configured', () => {
    const store = makeStoreWithBrick();
    const { raw, sig } = signedEvent('order_created', '500', {}, { brick_id: BRICK_ID });
    expect(handleLsWebhook(store, raw, sig, null, 1000).status).toBe(503);
  });
});
