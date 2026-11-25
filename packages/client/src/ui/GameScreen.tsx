import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { audio } from '../sound';
import { playerColorCss, type BrickHit } from '../render';
import { HEAD_ICONS, HUD_ICONS } from '../icons';
import { session } from '../session';
import { useSession, useTick } from './hooks';
import { AudioSettings } from './AudioSettings';
import { Button, Badge, Crown, Muted } from './bits';

const fullscreenSupported = document.fullscreenEnabled === true;
const runningStandalone =
  window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches ||
  ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true);

/** Per-device powerup stats; with local players, one colored block each. */
function HudStats() {
  const latest = session.buffer.latest();
  const room = session.room;
  if (!room) return null;
  const mine = session.myIds();
  return (
    <span id="hud-stats" className="flex flex-none items-center gap-3.5">
      {mine.map((id) => {
        const me = latest?.players.find((p) => p.id === id);
        if (!me) return null;
        const stats: Array<[string, string]> = [
          [HUD_ICONS.bomb, `${me.bombCap}`],
          [HUD_ICONS.range, `${me.range}`],
          [HUD_ICONS.speed, me.speed.toFixed(1)],
        ];
        const nick = room.players.find((p) => p.id === id)?.nickname ?? '?';
        return (
          <span key={id} className="flex items-center gap-3.5">
            {mine.length > 1 && (
              <span style={{ color: playerColorCss(session.slotOf(id)) }}>
                {nick.toUpperCase().slice(0, 6)}
              </span>
            )}
            {stats.map(([icon, value], i) => (
              <span key={i}>
                <img src={icon} alt="" className="mr-1 inline-block h-4 w-4 align-middle" />
                <span>{value}</span>
              </span>
            ))}
          </span>
        );
      })}
    </span>
  );
}

function Roster() {
  const rosterRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ x: number; left: number } | null>(null);
  const room = session.room;
  if (!room) return null;
  const latest = session.buffer.latest();
  // This device's players come first, so they never hide behind the overflow.
  const mine = session.myIds();
  const players = [...room.players].sort(
    (a, b) => Number(mine.includes(b.id)) - Number(mine.includes(a.id)),
  );
  return (
    // One row, never wraps: extra players scroll horizontally. #screen-game
    // sets touch-action:none (ancestors veto pan-x), so scrolling is driven
    // manually via pointer capture - which also gives desktop drag-scrolling.
    <span
      id="roster"
      ref={rosterRef}
      className="flex min-w-0 select-none items-center gap-4 overflow-x-auto"
      onPointerDown={(ev) => {
        if (!rosterRef.current) return;
        drag.current = { x: ev.clientX, left: rosterRef.current.scrollLeft };
        ev.currentTarget.setPointerCapture(ev.pointerId);
      }}
      onPointerMove={(ev) => {
        if (!drag.current || !rosterRef.current) return;
        rosterRef.current.scrollLeft = drag.current.left - (ev.clientX - drag.current.x);
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      {players.map((p) => {
        const slot = session.slotOf(p.id);
        const snap = latest?.players.find((sp) => sp.id === p.id);
        return (
          <span key={p.id} className="flex shrink-0 items-center gap-1">
            {!p.spectator && (
              <img src={HEAD_ICONS[slot % HEAD_ICONS.length] ?? ''} alt="" className="h-6 w-6" />
            )}
            {p.id === room.hostId && <Crown />}
            {p.bot && <Badge kind="bot">BOT</Badge>}
            {p.ownerId !== undefined && <Badge kind="local">LOCAL</Badge>}
            <span
              className={[
                'whitespace-nowrap',
                p.spectator ? 'opacity-50' : '',
                snap && !snap.alive ? 'line-through' : '',
              ].join(' ')}
              style={{ color: p.spectator ? '#C2C3C7' : playerColorCss(slot) }}
            >
              {p.nickname.toUpperCase().slice(0, 8)} {p.wins}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** Full-canvas overlay: reconnect blackout / translucent AFK countdown. */
function Overlay() {
  const info = session.overlayInfo();
  if (!info) return null;
  return (
    <div
      className={[
        'absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-[14px]',
        info.afk ? 'bg-black/75 text-amber' : 'bg-black',
      ].join(' ')}
    >
      <div>{info.title}</div>
      <div className={info.afk ? 'text-[14px] text-cherry' : 'text-[8px] text-silver'}>
        {info.sub}
      </div>
    </div>
  );
}

/** In-game menu; the match keeps running (and killing) underneath. */
function GameMenu() {
  useSession();
  if (session.menu === 'closed') return null;
  const mineCount = session.myIds().length;
  const showA2hs =
    session.isTouch &&
    !fullscreenSupported &&
    !runningStandalone &&
    localStorage.getItem('a2hsHintDismissed') !== '1';
  const menuButton = 'w-full min-h-11 min-w-[220px]';
  // Portalled to <body>: inside #screen-game its touch-action:none (ancestors
  // intersect) would veto native scrolling of a too-tall menu on phones.
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12 }}
      // Pad by the safe-area insets so the panel (and its border) clears the
      // home indicator / gesture bar when the page covers the whole screen.
      className="fixed inset-0 z-[5] flex items-center justify-center bg-black/65 pt-[max(0.75rem,var(--sai-t))] pr-[max(0.75rem,var(--sai-r))] pb-[max(0.75rem,var(--sai-b))] pl-[max(0.75rem,var(--sai-l))]"
      onClick={(ev) => {
        // Tapping outside the panel dismisses the menu.
        if (ev.target === ev.currentTarget) {
          audio.uiClick();
          session.closeMenu();
        }
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.92 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 520, damping: 32, mass: 0.9 }}
        className="flex max-h-full max-w-[90%] flex-col items-center gap-3 overflow-y-auto border-2 border-cream bg-night p-5 shadow-[6px_6px_0_#000000]"
      >
        <h2 className="m-0 text-[12px] text-lemon [text-shadow:2px_2px_0_#000000]">MENU</h2>
        {session.menu === 'main' ? (
          <>
            <div className="max-w-[260px] text-center text-[8px] leading-relaxed text-lemon">
              MATCH KEEPS RUNNING - YOU&apos;RE STILL VULNERABLE!
            </div>
            <div className="flex w-full flex-col gap-2.5">
              <Button className={menuButton} onClick={() => session.closeMenu()}>
                RESUME
              </Button>
              <AudioSettings />
              {session.isTouch && (
                <Button
                  variant="secondary"
                  className={menuButton}
                  onClick={() => {
                    session.haptics.setEnabled(!session.haptics.enabled());
                    if (session.haptics.enabled()) session.haptics.trigger('light'); // confirm it works
                    session.refresh();
                  }}
                >
                  HAPTICS: {session.haptics.enabled() ? 'ON' : 'OFF'}
                </Button>
              )}
              {session.isTouch && fullscreenSupported && (
                <Button
                  variant="secondary"
                  className={menuButton}
                  onClick={() => void session.toggleFullscreen()}
                >
                  {document.fullscreenElement ? 'EXIT FULLSCREEN' : 'FULLSCREEN'}
                </Button>
              )}
              <Button
                variant="secondary"
                className={menuButton}
                onClick={() => session.openLeaveConfirm()}
              >
                LEAVE GAME
              </Button>
              {showA2hs && (
                // iOS Safari has no Fullscreen API for pages: suggest A2HS once.
                <div className="flex w-full flex-col items-center gap-2.5 border-t-2 border-ash pt-3">
                  <Muted className="max-w-[260px] text-center">
                    TIP: ADD THIS PAGE TO YOUR HOME SCREEN (SHARE MENU) TO PLAY FULLSCREEN
                  </Muted>
                  <Button
                    variant="secondary"
                    className={menuButton}
                    onClick={() => {
                      localStorage.setItem('a2hsHintDismissed', '1');
                      session.refresh();
                    }}
                  >
                    GOT IT
                  </Button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex w-full flex-col gap-2.5">
            <div className="max-w-[260px] self-center text-center text-[8px] leading-relaxed text-lemon">
              {mineCount > 1
                ? `LEAVE MATCH? THIS REMOVES ALL ${mineCount} LOCAL PLAYERS ON THIS DEVICE.`
                : "LEAVE MATCH? YOU WON'T BE ABLE TO REJOIN THIS ROUND."}
            </div>
            <Button className={menuButton} onClick={() => session.leaveRoom()}>
              LEAVE
            </Button>
            <Button
              variant="secondary"
              className={menuButton}
              onClick={() => session.cancelLeaveConfirm()}
            >
              CANCEL
            </Button>
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/**
 * Hover/tap card for a branded brick: brand name + a way to open the buyer's
 * link. Portalled to <body> and positioned over the hovered crate so it never
 * gets clipped by the canvas wrapper. The matching crate gets an animated
 * outline drawn on the canvas (see Renderer.drawBrickHighlight).
 */
function BrickPopup({
  hit,
  isTouch,
  onVisit,
  onClose,
}: {
  hit: BrickHit;
  isTouch: boolean;
  onVisit: (id: string, url: string) => void;
  onClose: () => void;
}) {
  const { brick, rect } = hit;
  // Prefer sitting above the crate; flip below when it would clip the top.
  const above = rect.top > 76;
  const cx = Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90);
  const y = above ? rect.top - 9 : rect.top + rect.height + 9;

  return createPortal(
    <motion.div
      key={brick.id}
      initial={{ opacity: 0, y: above ? 6 : -6, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: above ? 6 : -6, scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 600, damping: 30, mass: 0.7 }}
      // pointer-events stay live so touch users can hit VISIT; tapping the
      // backdrop (handled on the canvas) dismisses it.
      className="pointer-events-none fixed z-[6]"
      style={{
        left: cx,
        top: y,
        transform: `translate(-50%, ${above ? '-100%' : '0'})`,
      }}
    >
      <div className="relative flex flex-col items-center gap-1.5 border-2 border-cream bg-night px-3.5 py-2.5 text-center shadow-[4px_4px_0_#000000]">
        <span className="max-w-[200px] truncate text-[9px] text-lemon [text-shadow:2px_2px_0_#000000]">
          {brick.name.toUpperCase()}
        </span>
        {brick.link ? (
          isTouch ? (
            <Button
              className="pointer-events-auto min-h-9 px-3 py-2 text-[8px]"
              onClick={() => onVisit(brick.id, brick.link!)}
            >
              VISIT ↗
            </Button>
          ) : (
            <span className="text-[7px] text-sky">CLICK TO VISIT ↗</span>
          )
        ) : (
          <span className="text-[7px] text-silver">SPONSORED BRICK</span>
        )}
        {isTouch && (
          <button
            type="button"
            aria-label="Close"
            className="pointer-events-auto absolute -top-2.5 -right-2.5 flex h-5 w-5 items-center justify-center border-2 border-cream bg-night text-[8px] text-cherry"
            onClick={onClose}
          >
            ✕
          </button>
        )}
        {/* Little tail pointing at the crate. */}
        <span
          className={`absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-cream bg-night ${
            above ? 'bottom-[-6px] border-r-2 border-b-2' : 'top-[-6px] border-t-2 border-l-2'
          }`}
        />
      </div>
    </motion.div>,
    document.body,
  );
}

/**
 * The match screen. Always mounted (hidden when inactive) so the canvas,
 * renderer and touch controls live exactly once - the game itself renders
 * on the canvas, untouched by React.
 */
export function GameScreen({ active }: { active: boolean }) {
  useSession();
  useTick(250); // HUD stats / roster / AFK countdown refresh
  const screenRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (screenRef.current && hudRef.current && canvasRef.current) {
      session.attachGame({
        screenEl: screenRef.current,
        hudEl: hudRef.current,
        canvas: canvasRef.current,
      });
    }
  }, []);

  // The HUD is only measurable once the screen is visible.
  useEffect(() => {
    if (active) session.applyScale();
  }, [active]);

  // Branded-brick popup: which crate the pointer is on (null = none shown).
  const [brick, setBrick] = useState<BrickHit | null>(null);
  const brickIdRef = useRef<string | null>(null);

  const showBrick = (hit: BrickHit | null): void => {
    const id = hit?.brick.id ?? null;
    if (id !== brickIdRef.current) {
      brickIdRef.current = id;
      session.setHoveredBrick(id);
      if (id) {
        audio.uiHover();
        session.recordBrickEvent(id, 'view'); // one impression per reveal
      }
      setBrick(hit);
    }
  };
  const visitBrick = (id: string, url: string): void => {
    audio.uiClick();
    session.recordBrickEvent(id, 'click');
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // Hovering (mouse only) tracks the crate live; touch reveals it on tap.
  const onCanvasHover = (ev: PointerEvent): void => {
    if (ev.pointerType !== 'mouse') return;
    showBrick(session.brickAtPoint(ev.clientX, ev.clientY));
  };
  const onCanvasClick = (ev: MouseEvent): void => {
    const hit = session.brickAtPoint(ev.clientX, ev.clientY);
    if (!hit) {
      showBrick(null); // tap elsewhere dismisses the card
      return;
    }
    if (session.isTouch) showBrick(hit); // card carries the VISIT button
    else if (hit.brick.link) visitBrick(hit.brick.id, hit.brick.link); // desktop: click opens
  };

  // Stale boxes once the menu opens or the screen hides; clear the highlight.
  useEffect(() => {
    if (!active && brickIdRef.current) showBrick(null);
  }, [active]);

  const room = session.room;
  // Spectating only when every player on this device is a spectator.
  const spectating = room?.state === 'playing' && session.allMineSpectating();
  // Every fighter on this device died this round (joined-late spectators aside).
  const dead = room?.state === 'playing' && session.myDeathAt !== null;
  const watching = spectating || dead;
  // The arena grays out while watching; hold off until the YOU DIED! banner
  // (drawn on the same canvas) has had its full-color moment.
  const grayed =
    spectating ||
    (dead && session.buffer.serverNow() - (session.myDeathAt ?? 0) > 2500);

  return (
    <div
      id="screen-game"
      ref={screenRef}
      className={`relative max-w-full flex-col items-center p-4 ${active ? 'flex' : 'hidden'}`}
    >
      <div
        id="hud"
        ref={hudRef}
        className="flex min-h-11 items-center justify-between gap-6 self-stretch border-2 border-cream bg-night px-3 py-1.5"
      >
        <HudStats />
        <Roster />
        <span className="flex flex-none items-center gap-1.5">
          {fullscreenSupported && (
            <Button
              id="btn-fullscreen"
              variant="secondary"
              title={document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'}
              aria-label="Toggle fullscreen"
              // On phones the tall (44px) button fills the HUD bar: the hard
              // drop shadow would paint over the HUD's bottom border.
              className={`flex items-center justify-center px-2.5 py-2.5 ${session.isTouch ? 'min-h-11 min-w-11 shadow-none!' : 'min-h-10'} ${document.fullscreenElement ? 'text-lemon' : ''}`}
              onClick={(ev) => {
                ev.currentTarget.blur();
                void session.toggleFullscreen();
              }}
            >
              {/* Corner-brackets fullscreen glyph (lit lemon while active). */}
              <span className="relative block h-3.5 w-4">
                <span className="absolute top-0 left-0 h-1.5 w-1.5 border-t-2 border-l-2 border-current" />
                <span className="absolute top-0 right-0 h-1.5 w-1.5 border-t-2 border-r-2 border-current" />
                <span className="absolute bottom-0 left-0 h-1.5 w-1.5 border-b-2 border-l-2 border-current" />
                <span className="absolute right-0 bottom-0 h-1.5 w-1.5 border-r-2 border-b-2 border-current" />
              </span>
            </Button>
          )}
          <Button
            id="btn-menu"
            variant="secondary"
            className={`px-3 py-2.5 text-[8px] ${session.isTouch ? 'min-h-11 min-w-16 shadow-none!' : 'min-h-10'}`}
            onClick={(ev) => {
              ev.currentTarget.blur();
              session.openMenu();
            }}
          >
            MENU (ESC)
          </Button>
        </span>
      </div>
      <div className="relative">
        <canvas
          ref={canvasRef}
          className={`block border-2 border-t-0 border-cream bg-black shadow-[8px_8px_0_#000000] transition-[filter] duration-700 ${grayed ? '[filter:grayscale(0.8)_brightness(0.8)]' : ''} ${brick?.brick.link ? 'cursor-pointer' : ''}`}
          onPointerMove={onCanvasHover}
          onPointerLeave={() => showBrick(null)}
          onClick={onCanvasClick}
        />
        {session.controlsFlash !== null && (
          // Per-local-player controls reminder, shown briefly at match start.
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-[3] flex -translate-x-1/2 flex-col gap-1.5 whitespace-nowrap border-2 border-cream bg-black/85 px-3 py-2 text-[7px]">
            {session.controlsFlash.map((line, i) => (
              <div key={i}>
                <span style={line.color ? { color: line.color } : undefined}>{line.text}</span>
                {line.suffix !== undefined && <span>{line.suffix}</span>}
              </div>
            ))}
          </div>
        )}
        {watching && (
          // Persistent dead/spectator banner: someone opening a shared link
          // mid-match (or tabbing back after dying) must see they're not playing.
          <div
            id="spectate-note"
            className="pointer-events-none absolute inset-x-0 bottom-3 z-[2] flex justify-center"
          >
            <div className="border-2 border-cherry bg-black/85 px-4 py-2.5 text-center shadow-[4px_4px_0_#000000]">
              <div className="animate-pulse text-[11px] text-cherry [text-shadow:2px_2px_0_#000000]">
                {dead ? "YOU'RE DEAD" : 'SPECTATING'}
              </div>
              <div className="mt-1.5 text-[7px] text-silver">
                {dead ? 'WATCHING - YOU PLAY AGAIN NEXT ROUND' : 'YOU JOIN THE NEXT ROUND'}
              </div>
            </div>
          </div>
        )}
        <Overlay />
        <GameMenu />
      </div>
      <AnimatePresence>
        {brick && session.menu === 'closed' && (
          <BrickPopup
            key={brick.brick.id}
            hit={brick}
            isTouch={session.isTouch}
            onVisit={visitBrick}
            onClose={() => showBrick(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
