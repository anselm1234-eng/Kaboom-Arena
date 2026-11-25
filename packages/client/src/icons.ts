import { buildSprites, spriteDataUrl } from './sprites';

/** Pixel-art data URLs shared by the HUD, lobby and touch controls. */

const uiSprites = buildSprites();

export const HUD_ICONS = {
  bomb: spriteDataUrl(uiSprites.hud.bomb, 2),
  range: spriteDataUrl(uiSprites.hud.range, 2),
  speed: spriteDataUrl(uiSprites.hud.speed, 2),
};

export const CROWN_ICON = spriteDataUrl(uiSprites.hud.crown, 2);

export const HEAD_ICONS = uiSprites.players.map((p) => spriteDataUrl(p.stand, 2));
