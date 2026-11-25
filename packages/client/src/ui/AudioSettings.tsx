import { useReducer } from 'react';
import {
  audio,
  musicEnabled,
  musicVolume,
  setMusicEnabled,
  setMusicVolume,
  setSoundEnabled,
  setSoundVolume,
  soundEnabled,
  soundVolume,
} from '../sound';
import { Button } from './bits';

function VolumeRow({
  label,
  on,
  volume,
  onToggle,
  onVolume,
  onCommit,
}: {
  label: string;
  on: boolean;
  volume: number;
  onToggle: () => void;
  onVolume: (v: number) => void;
  /** Slider released: play a preview at the new level. */
  onCommit: () => void;
}) {
  const pct = Math.round(volume * 100);
  return (
    <div className="flex w-full items-center gap-2.5">
      <Button
        variant="secondary"
        className="min-w-[104px] px-2 py-2 text-[7px]"
        onClick={onToggle}
      >
        {label}: {on ? 'ON' : 'OFF'}
      </Button>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={pct}
        disabled={!on}
        aria-label={`${label} volume`}
        className="h-2 w-full min-w-24 cursor-pointer accent-amber disabled:cursor-default disabled:opacity-40"
        onChange={(ev) => onVolume(Number(ev.target.value) / 100)}
        onPointerUp={onCommit}
        onKeyUp={(ev) => {
          if (ev.key.startsWith('Arrow')) onCommit();
        }}
      />
      <span className="w-9 whitespace-nowrap text-right text-[7px] text-silver">{pct}%</span>
    </div>
  );
}

/**
 * Sound/music toggles + volume sliders, shared by the landing-page settings
 * and the in-game menu. Settings live in module state (sound.ts) and persist;
 * releasing a slider plays a preview so the level is audible immediately.
 */
export function AudioSettings() {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  return (
    <div className="flex w-full flex-col gap-2.5">
      <VolumeRow
        label="SOUND"
        on={soundEnabled()}
        volume={soundVolume()}
        onToggle={() => {
          setSoundEnabled(!soundEnabled());
          if (soundEnabled()) audio.previewSfx();
          rerender();
        }}
        onVolume={(v) => {
          setSoundVolume(v);
          rerender();
        }}
        onCommit={() => audio.previewSfx()}
      />
      <VolumeRow
        label="MUSIC"
        on={musicEnabled()}
        volume={musicVolume()}
        onToggle={() => {
          setMusicEnabled(!musicEnabled());
          if (musicEnabled()) audio.previewMusic();
          rerender();
        }}
        onVolume={(v) => {
          setMusicVolume(v);
          rerender();
        }}
        onCommit={() => audio.previewMusic()}
      />
    </div>
  );
}
