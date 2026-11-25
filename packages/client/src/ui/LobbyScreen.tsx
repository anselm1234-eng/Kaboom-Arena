import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  MAX_LOCAL_PLAYERS,
  PREMATCH_COUNTDOWN_MS,
  ROOM_MIN_PLAYERS,
  ROOM_SIZES,
  type RoomPlayer,
} from '@blastmates/shared';
import { playerColorCss } from '../render';
import { HEAD_ICONS } from '../icons';
import { session } from '../session';
import { audio } from '../sound';
import { useSession, useTick } from './hooks';
import { Badge, Button, Crown, Heading, Muted, Panel, Screen } from './bits';
import { SizeButton } from './LandingScreen';

const ROW_SPRING = { type: 'spring', stiffness: 520, damping: 32, mass: 0.9 } as const;

/** Swap a lobby name label for an inline input; commit on Enter/blur. */
function RenameInput({ player, onDone }: { player: RoomPlayer; onDone: () => void }) {
  const [value, setValue] = useState(player.nickname);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = (next: string): void => {
    if (done.current) return;
    done.current = true;
    const trimmed = next.trim();
    if (trimmed && trimmed !== player.nickname) session.renameLocal(player.id, trimmed);
    onDone();
  };

  return (
    <input
      ref={inputRef}
      type="text"
      maxLength={16}
      value={value}
      onChange={(ev) => setValue(ev.target.value)}
      onBlur={() => commit(value)}
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') commit(value);
        if (ev.key === 'Escape') commit(player.nickname);
      }}
      className="w-30 border-2 border-ash bg-black px-1.5 py-1 text-left font-pixel text-[7px] text-cream outline-none focus:border-sky"
    />
  );
}

function PlayerRow({
  player,
  index,
  canManageBots,
  canKick,
}: {
  player: RoomPlayer;
  index: number;
  canManageBots: boolean;
  canKick: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const room = session.room;
  if (!room) return null;
  const slot = session.padSlotOf(player.id);
  const preset = session.currentPresets[slot];
  const isMyLocal = player.ownerId === session.joined?.playerId;

  return (
    // Joins slide in from the left; leavers (remove/kick/disconnect) slide out
    // right while the rows below close the gap via the layout animation.
    <motion.li
      layout
      initial={{ opacity: 0, x: -28, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 28, scale: 0.95, transition: { duration: 0.15 } }}
      transition={ROW_SPRING}
      className="mt-1.5 flex items-center gap-2 border-2 border-ash bg-black px-2.5 py-2 text-[8px]"
    >
      <span className="mr-2.5 flex min-w-0 flex-1 items-center">
        <img src={HEAD_ICONS[index % HEAD_ICONS.length] ?? ''} alt="" className="mr-2 h-8 w-8" />
        {renaming ? (
          <RenameInput player={player} onDone={() => setRenaming(false)} />
        ) : (
          <span style={{ color: playerColorCss(index) }}>{player.nickname.toUpperCase()}</span>
        )}
        {player.id === room.hostId && <Crown className="ml-2" />}
        {player.bot && <Badge kind="bot">BOT</Badge>}
        {player.ownerId !== undefined && <Badge kind="local">LOCAL</Badge>}
        {!player.connected && !player.bot && <Badge kind="off">OFFLINE</Badge>}
        {/* Ready state is visible on every human (bots always count as ready).
            Keyed by state so every toggle re-mounts the badge with a pop. The
            badge needs its own AnimatePresence: without it the row's presence
            context (initial={false}) would suppress the mount animation. */}
        {!player.bot && player.connected && (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={player.ready ? 'ready' : 'unready'}
              initial={{ scale: 1.7, rotate: player.ready ? -8 : 8, opacity: 0 }}
              animate={{ scale: 1, rotate: 0, opacity: 1 }}
              transition={ROW_SPRING}
              className="inline-block"
            >
              <Badge kind={player.ready ? 'ready' : 'unready'}>
                {player.ready ? 'READY' : 'NOT READY'}
              </Badge>
            </motion.span>
          </AnimatePresence>
        )}
        {/* Everyone on this device sees their current keys next to their name. */}
        {slot >= 0 && preset && !session.isTouch && (
          <span className="ml-2 whitespace-nowrap text-[6px] text-lemon">
            {session.presetLabel(preset)}
          </span>
        )}
      </span>
      <span className="whitespace-nowrap text-silver">
        {player.wins} WIN{player.wins === 1 ? '' : 'S'}
      </span>
      {isMyLocal && room.state === 'lobby' && (
        <>
          <Button variant="kick" onClick={() => setRenaming(true)}>
            RENAME
          </Button>
          <Button variant="kick" onClick={() => session.removeLocal(player.id)}>
            REMOVE
          </Button>
        </>
      )}
      {canManageBots && player.bot && (
        <Button variant="kick" onClick={() => session.removeBot(player.id)}>
          REMOVE
        </Button>
      )}
      {/* Host kick removes the player's whole device (all its local players). */}
      {canKick && !player.bot && !session.myIds().includes(player.id) && (
        <Button variant="kick" onClick={() => session.kickPlayer(player.id)}>
          KICK
        </Button>
      )}
    </motion.li>
  );
}

/** Big animated pre-match countdown: a digit pop per second + tick blips. */
function StartCountdown({ endsAt }: { endsAt: number }) {
  // serverNow() is off by ~one-way latency, so the remaining time can land a
  // hair above the full countdown length on arrival; clamping stops a "4"
  // (and its tick) from flashing for a few ms before the real first digit.
  const secs = Math.min(
    Math.max(Math.ceil((endsAt - session.buffer.serverNow()) / 1000), 0),
    Math.ceil(PREMATCH_COUNTDOWN_MS / 1000),
  );
  useEffect(() => {
    audio.countdownTick(secs <= 1);
  }, [secs]);
  const color = secs <= 1 ? 'text-cherry' : secs === 2 ? 'text-amber' : 'text-lemon';
  return (
    <div className="flex flex-col items-center gap-1">
      <Muted>MATCH STARTING IN</Muted>
      <div className="flex h-12 items-center justify-center">
        {/* No initial={false}: the very first digit slams in animated too. */}
        <AnimatePresence mode="popLayout">
          <motion.div
            key={secs}
            initial={{ scale: 2.4, rotate: -10, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 26 }}
            className={`font-pixel text-[28px] ${color} [text-shadow:3px_3px_0_#000000]`}
          >
            {secs}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

export function LobbyScreen() {
  useSession();
  useTick(250); // countdown / ready-timer text
  const [copied, setCopied] = useState(false);

  const room = session.room;
  const joined = session.joined;
  if (!room || !joined) return null;

  const isHost = session.isHost();
  const canManageBots = !room.isPrivate || isHost;
  // Kicking humans: private rooms only, host only, lobby only.
  const canKick = room.isPrivate && isHost && room.state === 'lobby';
  // Size control: private rooms only (public size is fixed), host only,
  // lobby only - resizing mid-countdown or mid-match is never allowed.
  const canResize = room.isPrivate && isHost && room.state === 'lobby';
  const occupancy = room.players.length;
  const connected = room.players.filter((p) => p.connected).length;
  // One ready button per device; it toggles every local player at once.
  const mine = room.players.filter((p) => !p.bot && session.myIds().includes(p.id));
  const allMineReady = mine.length > 0 && mine.every((p) => p.ready);
  // Mirrors the server's publicStartDue: if this READY UP makes everyone
  // ready, the countdown tick lands ~one RTT later - skip the click blip so
  // the two sounds don't stack. A wrong guess just costs one blip.
  const humans = room.players.filter((p) => !p.bot && p.connected);
  const bots = room.players.filter((p) => p.bot).length;
  const readyUpStartsCountdown =
    !room.isPrivate &&
    room.state === 'lobby' &&
    !allMineReady &&
    humans.every((p) => p.ready || session.myIds().includes(p.id)) &&
    humans.length + bots >= ROOM_MIN_PLAYERS;
  const inviteLink = `${location.origin}/room/${room.roomId}`;

  const copyLink = (): void => {
    void navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <Screen>
      <Heading>{room.roomName}</Heading>
      <Muted>
        {room.isPrivate ? 'PRIVATE' : 'PUBLIC'} {room.maxPlayers}-PLAYER ROOM
      </Muted>
      <Panel>
        <div className="flex max-w-100 items-center gap-2">
          <Muted>INVITE:</Muted>
          <code className="select-all border-2 border-ash bg-black p-2 text-[8px] wrap-anywhere">
            {inviteLink}
          </code>
          <Button variant="secondary" onClick={copyLink}>
            {copied ? 'COPIED!' : 'COPY LINK'}
          </Button>
        </div>
        <ul className="m-0 w-full list-none p-0">
          <AnimatePresence initial={false}>
            {room.players.map((p, i) => (
              <PlayerRow
                key={p.id}
                player={p}
                index={i}
                canManageBots={canManageBots}
                canKick={canKick}
              />
            ))}
          </AnimatePresence>
        </ul>
        {canResize && (
          <div className="flex w-full flex-col items-center gap-2">
            <Muted>ROOM SIZE</Muted>
            <div className="flex flex-wrap justify-center gap-2">
              {/* Sizes below the current participant count are disabled. */}
              {ROOM_SIZES.map((size) => (
                <SizeButton
                  key={size}
                  size={size}
                  selected={size === room.maxPlayers}
                  disabled={size < occupancy}
                  onPick={() => session.setRoomSize(size)}
                />
              ))}
            </div>
            {ROOM_SIZES.some((s) => s < occupancy) && (
              <Muted>{occupancy} IN THE ROOM - REMOVE PLAYERS OR BOTS FOR SMALLER SIZES</Muted>
            )}
          </div>
        )}
        {room.state === 'countdown' && room.countdownEndsAt !== null ? (
          <StartCountdown endsAt={room.countdownEndsAt} />
        ) : (
          <Muted>{session.lobbyStatusText() || 'WAITING FOR PLAYERS...'}</Muted>
        )}
        {mine.length > 0 && (
          // The lobby's main action: one big ready button per device.
          <button
            type="button"
            className={[
              'cursor-pointer border-2 border-cream px-8 py-4 font-pixel text-[12px] text-cream',
              '[text-shadow:1px_1px_0_#000000] active:translate-y-0.5',
              allMineReady
                ? 'bg-ash shadow-[0_4px_0_#2d2b28,0_4px_0_2px_#000000] hover:bg-silver hover:text-black active:shadow-[0_2px_0_#2d2b28,0_2px_0_2px_#000000]'
                : 'bg-moss shadow-[0_4px_0_#005536,0_4px_0_2px_#000000] hover:bg-lime hover:text-black active:shadow-[0_2px_0_#005536,0_2px_0_2px_#000000]',
            ].join(' ')}
            onClick={(ev) => {
              if (!readyUpStartsCountdown) audio.uiClick();
              session.toggleReady();
              ev.currentTarget.blur(); // a later space press should bomb, not re-click
            }}
          >
            {allMineReady ? 'UNREADY' : 'READY UP'}
          </button>
        )}
        {!session.isTouch && room.state === 'lobby' && (
          <Button
            variant="secondary"
            disabled={
              session.localIds.length >= MAX_LOCAL_PLAYERS ||
              (room.players.length >= room.maxPlayers &&
                (room.isPrivate || !room.players.some((p) => p.bot)))
            }
            onClick={() => session.addLocal()}
          >
            ADD LOCAL PLAYER
          </Button>
        )}
        {canManageBots && room.state === 'lobby' && (
          <Button
            variant="secondary"
            disabled={room.players.length >= room.maxPlayers}
            onClick={() => session.addBot()}
          >
            ADD BOT
          </Button>
        )}
        {isHost && room.state !== 'countdown' && (
          // silent: a successful start brings the countdown tick right behind
          // the click, so the click blip would just stack on top of it.
          <Button silent disabled={connected < ROOM_MIN_PLAYERS} onClick={() => session.startGame()}>
            START GAME
          </Button>
        )}
        <Button variant="secondary" onClick={() => session.leaveRoom()}>
          LEAVE
        </Button>
      </Panel>
    </Screen>
  );
}
