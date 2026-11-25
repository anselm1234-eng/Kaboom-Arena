import {
  DEFAULT_ROOM_SIZE_DESKTOP,
  EXPLOSION_DURATION_MS,
  ROOM_SIZE_GRID,
  SUDDEN_DEATH_COUNTDOWN_MS,
  SKIN_PALETTES,
  type BrickSnapshot,
  type Direction,
  type RoomPlayer,
  type SkinChoice,
  type SnapshotMessage,
} from '@blastmates/shared';
import {
  CRUMBLE_MS,
  DEATH_POP_MS,
  DEATH_SPIN_MS,
  FLASH_MS,
  GHOST_MS,
  PICKUP_MS,
  type Fx,
} from './fx';
import { drawTextCentered, textWidth } from './font';
import { color } from './palette';
import {
  PLAYER_UI_COLOR,
  TILE,
  buildPlayerSprites,
  buildSprites,
  hatSprite,
  withHat,
  type PlayerSprites,
  type Sprites,
} from './sprites';
import type { RenderView } from './snapshots';

const OX = TILE; // world origin (border offset)
const OY = TILE;

export function playerColorCss(index: number): string {
  return color(PLAYER_UI_COLOR[index % PLAYER_UI_COLOR.length] ?? 7);
}

export interface BannerLine {
  text: string;
  colorIdx: number;
  scale: number;
}

/** A branded brick located under a pointer, with its on-screen box (CSS px). */
export interface BrickHit {
  brick: BrickSnapshot;
  /** Viewport-space rectangle of the brick cluster, for popup placement. */
  rect: { left: number; top: number; width: number; height: number };
}

export interface BannerState {
  lines: BannerLine[];
  /** Player sprite index doing the victory dance under the text. */
  victorySprite?: number;
  /** Winner's cosmetic skin (palette/hat/dance). */
  victorySkin?: SkinChoice;
}

export interface FrameArgs {
  view: RenderView | null;
  roster: RoomPlayer[];
  /** Players controlled from this device (primary + local players). */
  myIds: readonly string[];
  serverNow: number;
  fx: Fx;
  banner: BannerState | null;
}

/** Loads branded-crate tile images once and serves them when ready. */
class TileImageCache {
  private readonly entries = new Map<string, { img: HTMLImageElement; ready: boolean }>();

  get(url: string): HTMLImageElement | null {
    let entry = this.entries.get(url);
    if (!entry) {
      const img = new Image();
      const fresh = { img, ready: false };
      img.onload = () => {
        fresh.ready = true;
      };
      img.src = url;
      this.entries.set(url, fresh);
      entry = fresh;
    }
    return entry.ready ? entry.img : null;
  }
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sprites: Sprites;
  private readonly tileImages = new TileImageCache();
  private readonly skinSprites = new Map<string, PlayerSprites>();
  private lastNow = 0;
  /** Bricks from the last drawn frame, for pointer hit-testing the popup. */
  private lastBricks: BrickSnapshot[] = [];
  /** Brick the pointer is currently over; gets an animated highlight. */
  private hoveredBrickId: string | null = null;

  /** Arena dimensions in tiles; set per room from the room-size config. */
  private gridW: number;
  private gridH: number;
  /** Device pixels per logical pixel: the backing store renders at this scale
   *  so sprites stay crisp at fractional CSS scales and high-DPR screens. */
  private pixelScale = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const dims = ROOM_SIZE_GRID[DEFAULT_ROOM_SIZE_DESKTOP];
    this.gridW = dims.width;
    this.gridH = dims.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    this.ctx = ctx;
    this.sprites = buildSprites();
    this.applyCanvasSize();
  }

  /** Logical view: arena + 1-tile decorative border, in 16px-tile pixels. */
  get viewW(): number {
    return (this.gridW + 2) * TILE;
  }

  get viewH(): number {
    return (this.gridH + 2) * TILE;
  }

  /** Resize the arena (tiles); called when the room's size config changes. */
  setGrid(width: number, height: number): void {
    if (width === this.gridW && height === this.gridH) return;
    this.gridW = width;
    this.gridH = height;
    this.applyCanvasSize();
  }

  /** Set device pixels per logical pixel (CSS scale x devicePixelRatio). */
  setPixelScale(scale: number): void {
    const clamped = Math.max(0.5, scale);
    if (clamped === this.pixelScale) return;
    this.pixelScale = clamped;
    this.applyCanvasSize();
  }

  /** Mark which branded brick the pointer is over (drives the highlight). */
  setHoveredBrick(id: string | null): void {
    this.hoveredBrickId = id;
  }

  /**
   * Branded brick under a viewport point, with its on-screen box, or null.
   * Maps CSS pixels back through the canvas scale to arena tile coordinates.
   */
  brickAt(clientX: number, clientY: number): BrickHit | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const sx = rect.width / this.viewW; // CSS px per logical (16px-tile) px
    const sy = rect.height / this.viewH;
    const lx = (clientX - rect.left) / sx;
    const ly = (clientY - rect.top) / sy;
    const tx = Math.floor((lx - OX) / TILE);
    const ty = Math.floor((ly - OY) / TILE);
    for (const brick of this.lastBricks) {
      if (ty === brick.y && tx >= brick.x && tx < brick.x + brick.tiles.length) {
        return {
          brick,
          rect: {
            left: rect.left + (OX + brick.x * TILE) * sx,
            top: rect.top + (OY + brick.y * TILE) * sy,
            width: brick.tiles.length * TILE * sx,
            height: TILE * sy,
          },
        };
      }
    }
    return null;
  }

  private applyCanvasSize(): void {
    this.canvas.width = Math.max(1, Math.round(this.viewW * this.pixelScale));
    this.canvas.height = Math.max(1, Math.round(this.viewH * this.pixelScale));
    // Resizing resets context state; keep pixel-art scaling nearest-neighbour.
    this.ctx.imageSmoothingEnabled = false;
  }

  /** Sprite index of a player id: order of appearance in the snapshot. */
  private spriteIndex(snap: SnapshotMessage, id: string): number {
    const i = snap.players.findIndex((p) => p.id === id);
    return i >= 0 ? i % this.sprites.players.length : 0;
  }

  private skinOf(roster: RoomPlayer[], id: string): SkinChoice | undefined {
    return roster.find((p) => p.id === id)?.skin;
  }

  /** Resolve the sprite set for a slot + cosmetic skin (cached). */
  private spritesFor(slot: number, skin: SkinChoice | undefined): PlayerSprites | undefined {
    const base = this.sprites.players[slot % this.sprites.players.length];
    if (!base) return undefined;
    const paletteId = skin?.palette ?? 'default';
    const hatId = skin?.hat ?? 'none';
    if (paletteId === 'default' && hatId === 'none') return base;
    const key = `${slot}:${paletteId}:${hatId}`;
    let set = this.skinSprites.get(key);
    if (!set) {
      const palette = SKIN_PALETTES[paletteId];
      set = palette ? buildPlayerSprites(palette) : base;
      if (hatId !== 'none') {
        const hat = hatSprite(hatId);
        if (hat) set = withHat(set, hat);
      }
      this.skinSprites.set(key, set);
    }
    return set;
  }

  frame(args: FrameArgs): void {
    const { ctx } = this;
    const { view, serverNow, fx } = args;
    const dt = this.lastNow > 0 ? Math.min(serverNow - this.lastNow, 100) : 16;
    this.lastNow = serverNow;
    this.lastBricks = view ? view.base.bricks ?? [] : [];

    if (view) {
      fx.ambient(view.base, serverNow);
      fx.update(serverNow, dt);
    }

    // Base transform maps logical 16px-tile pixels onto the DPR-sized
    // backing store; nearest-neighbour scaling keeps sprites crisp.
    ctx.setTransform(this.pixelScale, 0, 0, this.pixelScale, 0, 0);
    ctx.fillStyle = color(0);
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    const [shakeX, shakeY] = view ? fx.shakeOffset(serverNow) : [0, 0];
    ctx.save();
    ctx.translate(shakeX, shakeY);

    this.drawBorder();
    if (view) {
      this.drawWorld(view.base, serverNow, fx);
      this.drawPickups(fx, serverNow);
      this.drawPlayers(args, view);
      this.drawDeaths(args, view, serverNow, fx);
      this.drawParticles(fx);
      this.drawNicknames(args, view);
    }
    ctx.restore();

    if (view) this.drawMatchTimer(view.base, serverNow);
    if (args.banner) this.drawBanner(args.banner, serverNow);
  }

  /**
   * Match timer over the top border: calm countdown to sudden death, an
   * urgent flashing countdown banner in the final 10 seconds, then a
   * pulsing SUDDEN DEATH label while the arena shrinks.
   */
  private drawMatchTimer(snap: SnapshotMessage, now: number): void {
    const sdAt = snap.suddenDeathAt;
    if (sdAt === undefined) return;
    const left = sdAt - now;
    const flash = Math.floor(now / 250) % 2 === 0;
    if (left <= 0) {
      drawTextCentered(this.ctx, 'SUDDEN DEATH', this.viewW / 2, 5, flash ? 8 : 7, 0, 1);
    } else if (left <= SUDDEN_DEATH_COUNTDOWN_MS) {
      const s = Math.ceil(left / 1000);
      drawTextCentered(this.ctx, `SUDDEN DEATH IN ${s}`, this.viewW / 2, 5, flash ? 8 : 10, 0, 1);
    } else {
      const s = Math.ceil(left / 1000);
      const mm = Math.floor(s / 60);
      const ss = `${s % 60}`.padStart(2, '0');
      drawTextCentered(this.ctx, `${mm}:${ss}`, this.viewW / 2, 5, 7, 0, 1);
    }
  }

  private drawBorder(): void {
    const { ctx, sprites } = this;
    for (let x = 0; x < this.gridW + 2; x++) {
      ctx.drawImage(sprites.border, x * TILE, 0);
      ctx.drawImage(sprites.border, x * TILE, this.viewH - TILE);
    }
    for (let y = 1; y < this.gridH + 1; y++) {
      ctx.drawImage(sprites.border, 0, y * TILE);
      ctx.drawImage(sprites.border, this.viewW - TILE, y * TILE);
    }
  }

  private drawWorld(snap: SnapshotMessage, now: number, fx: Fx): void {
    const { ctx, sprites } = this;

    // Branded crate cells -> tile image URL.
    const branded = new Map<number, string>();
    for (const brick of snap.bricks ?? []) {
      brick.tiles.forEach((url, i) => {
        branded.set((brick.x + i) * 1000 + brick.y, url);
      });
    }

    for (let y = 0; y < this.gridH; y++) {
      for (let x = 0; x < this.gridW; x++) {
        const px = OX + x * TILE;
        const py = OY + y * TILE;
        ctx.drawImage(sprites.floor[(x + y) % 2 === 0 ? 0 : 1] ?? sprites.floor[0], px, py);
        const c = snap.grid[y * this.gridW + x];
        if (c === '#') {
          ctx.drawImage(sprites.pillar, px, py);
        } else if (c === 'X') {
          ctx.drawImage(sprites.crush, px, py);
        } else if (c === 'C') {
          const brandUrl = branded.get(x * 1000 + y);
          const img = brandUrl !== undefined ? this.tileImages.get(brandUrl) : null;
          if (img) this.drawBrandedCrate(img, px, py);
          else ctx.drawImage(sprites.crate, px, py);
        }
      }
    }

    // Sudden-death warnings: flashing red frame, faster near the landing.
    for (const w of snap.crush ?? []) {
      const px = OX + w.x * TILE;
      const py = OY + w.y * TILE;
      const left = w.landsAt - now;
      const period = left > 600 ? 220 : 110;
      const on = Math.floor(now / period) % 2 === 0;
      ctx.fillStyle = color(on ? 8 : 2);
      ctx.fillRect(px, py, TILE, 2);
      ctx.fillRect(px, py + TILE - 2, TILE, 2);
      ctx.fillRect(px, py, 2, TILE);
      ctx.fillRect(px + TILE - 2, py, 2, TILE);
      if (on) ctx.fillRect(px + 6, py + 6, 4, 4);
    }

    // Crumbling crates (just-destroyed cells), white flash first.
    for (const cr of fx.crumbles) {
      const elapsed = now - cr.startedAt;
      const px = OX + cr.cx * TILE;
      const py = OY + cr.cy * TILE;
      if (elapsed < FLASH_MS) {
        ctx.drawImage(Math.floor(elapsed / 60) % 2 === 0 ? sprites.crateFlash : sprites.crate, px, py);
      } else {
        const t = (elapsed - FLASH_MS) / (CRUMBLE_MS - FLASH_MS);
        const frame = Math.min(Math.floor(t * sprites.crumble.length), sprites.crumble.length - 1);
        const spr = sprites.crumble[frame];
        if (spr) ctx.drawImage(spr, px, py);
      }
    }

    // Powerups: pulsing background tile + bobbing icon.
    for (const u of snap.powerups) {
      const px = OX + u.x * TILE;
      const py = OY + u.y * TILE;
      const bg = sprites.powerBg[Math.floor(now / 280) % 2 === 0 ? 0 : 1] ?? sprites.powerBg[0];
      ctx.drawImage(bg, px, py);
      const icon = sprites.powerIcons[u.kind];
      const bob = Math.floor(now / 320) % 2;
      ctx.drawImage(icon, px + 3, py + 3 - bob);
    }

    // Bombs: shadow + pulse that speeds up near detonation.
    for (const b of snap.bombs) {
      const px = OX + b.x * TILE;
      const py = OY + b.y * TILE;
      const left = Math.max(b.explodesAt - now, 0);
      const period = left > 1800 ? 360 : left > 800 ? 220 : 120;
      const frame = Math.floor(now / period) % 2;
      ctx.drawImage(this.sprites.shadow, px + 2, py + 11);
      ctx.drawImage(sprites.bomb[frame] ?? sprites.bomb[0], px, py);
    }

    // Explosions: classify each cell as center / arm / cap by neighbors.
    for (const e of snap.explosions) {
      const startedAt = e.endsAt - EXPLOSION_DURATION_MS;
      const t = Math.min(Math.max((now - startedAt) / EXPLOSION_DURATION_MS, 0), 0.999);
      const frame = Math.floor(t * 4);
      const inCells = new Set(e.cells.map((c) => c.x * 100 + c.y));
      for (const cell of e.cells) {
        const px = OX + cell.x * TILE;
        const py = OY + cell.y * TILE;
        const l = inCells.has((cell.x - 1) * 100 + cell.y);
        const r = inCells.has((cell.x + 1) * 100 + cell.y);
        const u = inCells.has(cell.x * 100 + cell.y - 1);
        const d = inCells.has(cell.x * 100 + cell.y + 1);
        const horiz = l || r;
        const vert = u || d;
        let spr: HTMLCanvasElement | undefined;
        if ((horiz && vert) || (!horiz && !vert)) spr = this.sprites.expl.center[frame];
        else if (horiz && l && r) spr = this.sprites.expl.armH[frame];
        else if (horiz) spr = (l ? this.sprites.expl.capRight : this.sprites.expl.capLeft)[frame];
        else if (u && d) spr = this.sprites.expl.armV[frame];
        else spr = (u ? this.sprites.expl.capDown : this.sprites.expl.capUp)[frame];
        if (spr) ctx.drawImage(spr, px, py);
      }
    }

    // Pointer hover: outline the branded brick the cursor is on, hinting it
    // is clickable (the React popup with the brand + link draws over the top).
    if (this.hoveredBrickId !== null) {
      const hovered = (snap.bricks ?? []).find((b) => b.id === this.hoveredBrickId);
      if (hovered) this.drawBrickHighlight(hovered, now);
    }
  }

  /** Animated marching outline + corner brackets around a hovered brick. */
  private drawBrickHighlight(brick: BrickSnapshot, now: number): void {
    const { ctx } = this;
    const px = OX + brick.x * TILE;
    const py = OY + brick.y * TILE;
    const w = brick.tiles.length * TILE;
    const on = Math.floor(now / 220) % 2 === 0;
    // Pulsing 1px frame just inside the cluster.
    ctx.fillStyle = color(on ? 10 : 7);
    ctx.fillRect(px, py, w, 1);
    ctx.fillRect(px, py + TILE - 1, w, 1);
    ctx.fillRect(px, py, 1, TILE);
    ctx.fillRect(px + w - 1, py, 1, TILE);
    // Brighter corner brackets that pop outward by 1px on the off-beat.
    const o = on ? 1 : 0;
    const len = 4;
    const l = px - o;
    const t = py - o;
    const r = px + w - 1 + o;
    const b = py + TILE - 1 + o;
    ctx.fillStyle = color(10);
    // Each L-bracket points inward toward the cluster center.
    ctx.fillRect(l, t, len, 1);
    ctx.fillRect(l, t, 1, len);
    ctx.fillRect(r - len + 1, t, len, 1);
    ctx.fillRect(r, t, 1, len);
    ctx.fillRect(l, b, len, 1);
    ctx.fillRect(l, b - len + 1, 1, len);
    ctx.fillRect(r - len + 1, b, len, 1);
    ctx.fillRect(r, b - len + 1, 1, len);
  }

  /** Brick tile image with a crate-style frame so it still reads as a crate. */
  private drawBrandedCrate(img: HTMLImageElement, px: number, py: number): void {
    const { ctx } = this;
    ctx.drawImage(img, px, py, TILE, TILE);
    ctx.fillStyle = color(0);
    ctx.fillRect(px, py, TILE, 1);
    ctx.fillRect(px, py + TILE - 1, TILE, 1);
    ctx.fillRect(px, py, 1, TILE);
    ctx.fillRect(px + TILE - 1, py, 1, TILE);
    // corner nails, like a normal crate
    ctx.fillStyle = color(6);
    ctx.fillRect(px + 1, py + 1, 1, 1);
    ctx.fillRect(px + TILE - 2, py + 1, 1, 1);
    ctx.fillRect(px + 1, py + TILE - 2, 1, 1);
    ctx.fillRect(px + TILE - 2, py + TILE - 2, 1, 1);
  }

  /** Picked-up powerup icon flying up and blinking out. */
  private drawPickups(fx: Fx, now: number): void {
    for (const p of fx.pickups) {
      const t = (now - p.at) / PICKUP_MS;
      if (t >= 1) continue;
      if (t > 0.6 && Math.floor(now / 60) % 2 === 0) continue; // blink instead of alpha
      const icon = this.sprites.powerIcons[p.kind];
      const px = OX + p.cx * TILE + 3;
      const py = OY + p.cy * TILE + 3 - Math.round(t * 14);
      this.ctx.drawImage(icon, px, py);
    }
  }

  private playerSprite(
    sprites: PlayerSprites,
    dir: Direction | null,
    now: number,
  ): HTMLCanvasElement {
    if (dir) {
      const frame = Math.floor(now / 140) % 2;
      return sprites[dir][frame] ?? sprites.stand;
    }
    // Idle: breathing blink every ~2s.
    return Math.floor(now / 500) % 4 === 3 ? sprites.blink : sprites.stand;
  }

  private drawPlayers(args: FrameArgs, view: RenderView): void {
    const { ctx } = this;
    const now = args.serverNow;
    const ordered = [...view.players].sort((a, b) => a.y - b.y);
    for (const p of ordered) {
      if (!p.alive) continue;
      const idx = this.spriteIndex(view.base, p.id);
      const sprites = this.spritesFor(idx, this.skinOf(args.roster, p.id));
      if (!sprites) continue;
      const px = Math.round(OX + p.x * TILE);
      const py = Math.round(OY + p.y * TILE);
      ctx.drawImage(this.sprites.shadow, px - 6, py + 3);
      const spr = this.playerSprite(sprites, p.dir, now);
      ctx.drawImage(spr, px - 8, py - 11);
    }
  }

  /** Death sequence: directional spin -> star pop -> ghost floats up. */
  private drawDeaths(args: FrameArgs, view: RenderView, now: number, fx: Fx): void {
    const { ctx } = this;
    for (const d of fx.deaths) {
      const idx = this.spriteIndex(view.base, d.playerId);
      const sprites = this.spritesFor(idx, this.skinOf(args.roster, d.playerId));
      if (!sprites) continue;
      const elapsed = now - d.at;
      const px = Math.round(OX + d.x);
      const py = Math.round(OY + d.y);
      if (elapsed < DEATH_SPIN_MS) {
        const spin = [sprites.stand, sprites.standRight, sprites.standUp, sprites.standLeft];
        const frame = Math.floor(elapsed / 100) % spin.length;
        ctx.drawImage(spin[frame] ?? sprites.stand, px - 8, py - 11);
      } else if (elapsed < DEATH_SPIN_MS + DEATH_POP_MS) {
        const pop = this.sprites.pop[Math.floor((elapsed - DEATH_SPIN_MS) / 125) % 2];
        if (pop) ctx.drawImage(pop, px - 8, py - 11);
      } else {
        const t = (elapsed - DEATH_SPIN_MS - DEATH_POP_MS) / GHOST_MS;
        if (Math.floor(now / 90) % 3 === 0) continue; // ghost flickers, no alpha
        const ghost = this.sprites.ghost[Math.floor(now / 250) % 2];
        if (ghost) ctx.drawImage(ghost, px - 8, py - 14 - Math.round(t * 22));
      }
    }
  }

  private drawParticles(fx: Fx): void {
    const { ctx } = this;
    for (const p of fx.particles) {
      ctx.fillStyle = color(p.colorIdx);
      ctx.fillRect(Math.round(OX + p.x), Math.round(OY + p.y), p.size, p.size);
    }
  }

  private drawNicknames(args: FrameArgs, view: RenderView): void {
    for (const p of view.players) {
      if (!p.alive) continue;
      const roster = args.roster.find((r) => r.id === p.id);
      if (!roster) continue;
      const idx = this.spriteIndex(view.base, p.id);
      const px = Math.round(OX + p.x * TILE);
      const py = Math.round(OY + p.y * TILE);
      const label = roster.nickname.slice(0, 10);
      const half = textWidth(label, 1) / 2;
      const cx = Math.min(Math.max(px, 2 + half), this.viewW - 2 - half);
      drawTextCentered(this.ctx, label, cx, py - 19, PLAYER_UI_COLOR[idx] ?? 7, 0, 1);
      // Players controlled from this device get an underline in their color,
      // so two people sharing the keyboard can spot their own character.
      if (args.myIds.includes(p.id)) {
        this.ctx.fillStyle = color(PLAYER_UI_COLOR[idx] ?? 7);
        this.ctx.fillRect(Math.round(cx - half), py - 12, Math.round(half * 2), 1);
      }
    }
  }

  private drawBanner(banner: BannerState, now: number): void {
    const { ctx } = this;
    const lineGap = 6;
    let textH = 0;
    let textW = 0;
    for (const line of banner.lines) {
      textH += 5 * line.scale + lineGap;
      textW = Math.max(textW, textWidth(line.text, line.scale));
    }
    const spriteH = banner.victorySprite !== undefined ? 24 : 0;
    const padX = 14;
    const padY = 12;
    const w = Math.min(textW + padX * 2, this.viewW - 8);
    const h = textH + spriteH + padY * 2 - lineGap;
    const x = Math.round((this.viewW - w) / 2);
    const y = Math.round((this.viewH - h) / 2);

    // Hard-edged panel: black fill, white 2px border, offset shadow.
    ctx.fillStyle = color(1);
    ctx.fillRect(x + 3, y + 3, w, h);
    ctx.fillStyle = color(7);
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = color(0);
    ctx.fillRect(x, y, w, h);

    let ty = y + padY;
    for (const line of banner.lines) {
      drawTextCentered(ctx, line.text, this.viewW / 2, ty, line.colorIdx, null, line.scale);
      ty += 5 * line.scale + lineGap;
    }

    if (banner.victorySprite !== undefined) {
      const sprites = this.spritesFor(banner.victorySprite, banner.victorySkin);
      if (sprites) {
        // Alternate dance: faster cycle with a little hop.
        const bounce = banner.victorySkin?.dance === 'bounce';
        const period = bounce ? 180 : 280;
        const frame = Math.floor(now / period) % 2;
        const hop = bounce && frame === 1 ? -3 : 0;
        const spr = sprites.victory[frame] ?? sprites.stand;
        ctx.drawImage(spr, Math.round(this.viewW / 2 - 8), ty + 2 + hop);
      }
    }
  }
}
