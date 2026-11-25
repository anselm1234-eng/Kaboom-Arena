import { useEffect, useState } from 'react';
import {
  DANCE_IDS,
  HAT_IDS,
  PALETTE,
  SKIN_PALETTES,
  SKIN_PALETTE_IDS,
  type SkinChoice,
} from '@blastmates/shared';
import { loadSkin, redeemSkinKey, revalidateSkin, saveSkin, skinUnlocked } from '../skins';
import { audio } from '../sound';
import { Button, Muted, TextInput } from './bits';

function Swatch({
  label,
  locked,
  selected,
  bg,
  onPick,
}: {
  label: string;
  locked: boolean;
  selected: boolean;
  bg?: string;
  onPick: () => void;
}) {
  const wide = label.length > 2 && !bg;
  return (
    <button
      type="button"
      title={locked ? 'Skin pack required - redeem a code below' : label}
      onClick={() => {
        if (!locked) audio.uiClick();
        onPick();
      }}
      style={bg ? { background: bg } : undefined}
      className={[
        'h-[26px] cursor-pointer border-2 p-0 font-pixel text-[7px] text-cream shadow-[2px_2px_0_#000000]',
        bg ? '' : 'bg-night',
        wide ? 'w-auto px-2' : 'w-[26px]',
        selected ? 'border-cream' : 'border-ash',
        locked ? 'cursor-not-allowed opacity-40' : '',
      ].join(' ')}
    >
      {bg ? '' : label}
    </button>
  );
}

/** Cosmetics: palette/hat/dance, persisted locally; paid pack via license key. */
export function SkinPicker() {
  const [skin, setSkin] = useState<SkinChoice>(() => loadSkin());
  const [unlocked, setUnlocked] = useState(() => skinUnlocked());
  const [status, setStatus] = useState(() => (skinUnlocked() ? 'SKIN PACK UNLOCKED!' : ''));
  const [redeemKey, setRedeemKey] = useState('');

  useEffect(() => {
    // Silent license re-check; fails open on any outage.
    void revalidateSkin().then(() => setUnlocked(skinUnlocked()));
  }, []);

  const pick = (locked: boolean, next: SkinChoice): void => {
    if (locked) {
      setStatus('LOCKED - REDEEM A SKIN PACK CODE BELOW');
      return;
    }
    saveSkin(next);
    setSkin(next);
    setStatus(unlocked ? 'SKIN PACK UNLOCKED!' : '');
  };

  const redeem = async (): Promise<void> => {
    const key = redeemKey.trim();
    if (!key) return;
    setStatus('CHECKING...');
    const result = await redeemSkinKey(key);
    setStatus(result.ok ? 'SKIN PACK UNLOCKED!' : (result.error ?? 'INVALID CODE').toUpperCase());
    setUnlocked(skinUnlocked());
  };

  const row = 'flex flex-wrap justify-center gap-1.5';
  return (
    <div className="flex w-full flex-col items-center gap-2 border-t-2 border-ash pt-3">
      <Muted>PALETTE</Muted>
      <div className={row}>
        {SKIN_PALETTE_IDS.map((id) => {
          const pal = SKIN_PALETTES[id];
          return (
            <Swatch
              key={id}
              label={id === 'default' ? 'STD' : id.slice(0, 3).toUpperCase()}
              bg={pal ? PALETTE[pal.main] : undefined}
              locked={id !== 'default' && !unlocked}
              selected={skin.palette === id}
              onPick={() => pick(id !== 'default' && !unlocked, { ...skin, palette: id })}
            />
          );
        })}
      </div>
      <Muted>HAT</Muted>
      <div className={row}>
        {HAT_IDS.map((id) => (
          <Swatch
            key={id}
            label={id.toUpperCase()}
            locked={id !== 'none' && !unlocked}
            selected={skin.hat === id}
            onPick={() => pick(id !== 'none' && !unlocked, { ...skin, hat: id })}
          />
        ))}
      </div>
      <Muted>VICTORY DANCE</Muted>
      <div className={row}>
        {DANCE_IDS.map((id) => (
          <Swatch
            key={id}
            label={id.toUpperCase()}
            locked={id !== 'classic' && !unlocked}
            selected={skin.dance === id}
            onPick={() => pick(id !== 'classic' && !unlocked, { ...skin, dance: id })}
          />
        ))}
      </div>
      <div className="flex gap-1.5">
        <TextInput
          maxLength={64}
          placeholder="SKIN PACK CODE"
          value={redeemKey}
          onChange={(ev) => setRedeemKey(ev.target.value)}
          className="w-[180px]"
        />
        <Button variant="secondary" onClick={() => void redeem()}>
          REDEEM
        </Button>
      </div>
      <Muted>{status}</Muted>
    </div>
  );
}
