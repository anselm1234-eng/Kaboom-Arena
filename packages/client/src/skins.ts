import { DEFAULT_SKIN, isFreeSkin, type SkinChoice } from '@blastmates/shared';

/**
 * Skin selection + license-key unlock, persisted in localStorage only —
 * no accounts. Validation fails open: if Lemon Squeezy is unreachable a
 * previously unlocked pack stays unlocked.
 */

const KEY_SKIN = 'skin';
const KEY_LICENSE = 'skinLicenseKey';
const KEY_UNLOCKED = 'skinUnlocked';
const KEY_INSTANCE = 'skinInstance';

export function loadSkin(): SkinChoice {
  try {
    const raw = localStorage.getItem(KEY_SKIN);
    if (!raw) return { ...DEFAULT_SKIN };
    const parsed = JSON.parse(raw) as SkinChoice;
    return {
      palette: typeof parsed.palette === 'string' ? parsed.palette : 'default',
      hat: typeof parsed.hat === 'string' ? parsed.hat : 'none',
      dance: typeof parsed.dance === 'string' ? parsed.dance : 'classic',
    };
  } catch {
    return { ...DEFAULT_SKIN };
  }
}

export function saveSkin(skin: SkinChoice): void {
  localStorage.setItem(KEY_SKIN, JSON.stringify(skin));
}

export function skinUnlocked(): boolean {
  return localStorage.getItem(KEY_UNLOCKED) === '1';
}

/** Selected skin, downgraded to the free default if the pack is locked. */
export function effectiveSkin(): SkinChoice {
  const skin = loadSkin();
  if (isFreeSkin(skin) || skinUnlocked()) return skin;
  return { ...DEFAULT_SKIN };
}

function instanceName(): string {
  let inst = localStorage.getItem(KEY_INSTANCE);
  if (!inst) {
    inst = `web-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(KEY_INSTANCE, inst);
  }
  return inst;
}

export async function redeemSkinKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/skins/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, instance: instanceName() }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (res.ok && body.ok) {
      localStorage.setItem(KEY_LICENSE, key);
      localStorage.setItem(KEY_UNLOCKED, '1');
      return { ok: true };
    }
    return { ok: false, error: body.error ?? 'Could not redeem this key' };
  } catch {
    return { ok: false, error: 'Server unreachable, try again later' };
  }
}

/** Silent re-validation on load; fails open on any kind of outage. */
export async function revalidateSkin(): Promise<void> {
  const key = localStorage.getItem(KEY_LICENSE);
  if (!key || !skinUnlocked()) return;
  try {
    const res = await fetch('/api/skins/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (res.status === 403 || res.status === 404) {
      localStorage.removeItem(KEY_UNLOCKED);
    }
  } catch {
    // fail open
  }
}
