/**
 * Minimal Lemon Squeezy API client. fetch is injectable so tests can mock
 * the API without network access.
 */

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface LsLicenseResult {
  valid: boolean;
  error: string | null;
  licenseKeyId: number | null;
  keyStatus: string | null;
  activationLimit: number | null;
  activationUsage: number | null;
  instanceId: string | null;
  storeId: number | null;
  orderId: number | null;
  variantId: number | null;
}

export interface LsClient {
  createCheckout(opts: {
    storeId: string;
    variantId: string;
    customData: Record<string, string>;
    redirectUrl: string;
  }): Promise<string>;
  validateLicense(key: string, instanceId?: string): Promise<LsLicenseResult>;
  activateLicense(key: string, instanceName: string): Promise<LsLicenseResult>;
}

const API_BASE = 'https://api.lemonsqueezy.com';

interface LicenseApiResponse {
  valid?: boolean;
  activated?: boolean;
  error?: string | null;
  license_key?: {
    id?: number;
    status?: string;
    activation_limit?: number | null;
    activation_usage?: number;
  };
  instance?: { id?: string } | null;
  meta?: { store_id?: number; order_id?: number; variant_id?: number };
}

function parseLicenseResponse(body: LicenseApiResponse): LsLicenseResult {
  return {
    valid: body.valid === true || body.activated === true,
    error: body.error ?? null,
    licenseKeyId: body.license_key?.id ?? null,
    keyStatus: body.license_key?.status ?? null,
    activationLimit: body.license_key?.activation_limit ?? null,
    activationUsage: body.license_key?.activation_usage ?? null,
    instanceId: body.instance?.id ?? null,
    storeId: body.meta?.store_id ?? null,
    orderId: body.meta?.order_id ?? null,
    variantId: body.meta?.variant_id ?? null,
  };
}

export class LsError extends Error {
  constructor(
    readonly code: 'unreachable' | 'api_error' | 'not_configured',
    message: string,
  ) {
    super(message);
  }
}

export function createLsClient(apiKey: string | null, fetchFn: FetchFn = fetch): LsClient {
  async function licenseCall(path: string, form: Record<string, string>): Promise<LsLicenseResult> {
    let res: Response;
    try {
      res = await fetchFn(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(form),
      });
    } catch {
      throw new LsError('unreachable', 'Lemon Squeezy is unreachable');
    }
    let body: LicenseApiResponse;
    try {
      body = (await res.json()) as LicenseApiResponse;
    } catch {
      throw new LsError('api_error', `Unexpected response (${res.status})`);
    }
    return parseLicenseResponse(body);
  }

  return {
    async createCheckout(opts): Promise<string> {
      if (!apiKey) throw new LsError('not_configured', 'LEMONSQUEEZY_API_KEY is not set');
      let res: Response;
      try {
        res = await fetchFn(`${API_BASE}/v1/checkouts`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/vnd.api+json',
            Accept: 'application/vnd.api+json',
          },
          body: JSON.stringify({
            data: {
              type: 'checkouts',
              attributes: {
                checkout_data: { custom: opts.customData },
                product_options: { redirect_url: opts.redirectUrl },
              },
              relationships: {
                store: { data: { type: 'stores', id: opts.storeId } },
                variant: { data: { type: 'variants', id: opts.variantId } },
              },
            },
          }),
        });
      } catch {
        throw new LsError('unreachable', 'Lemon Squeezy is unreachable');
      }
      if (!res.ok) {
        throw new LsError('api_error', `Checkout creation failed (${res.status})`);
      }
      const body = (await res.json()) as { data?: { attributes?: { url?: string } } };
      const url = body.data?.attributes?.url;
      if (!url) throw new LsError('api_error', 'Checkout response had no URL');
      return url;
    },

    validateLicense(key, instanceId) {
      const form: Record<string, string> = { license_key: key };
      if (instanceId) form.instance_id = instanceId;
      return licenseCall('/v1/licenses/validate', form);
    },

    activateLicense(key, instanceName) {
      return licenseCall('/v1/licenses/activate', {
        license_key: key,
        instance_name: instanceName,
      });
    },
  };
}
