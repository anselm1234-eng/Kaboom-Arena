import { useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  DEFAULT_ROOM_SIZE_DESKTOP,
  DEFAULT_ROOM_SIZE_TOUCH,
  ROOM_SIZES,
  ROOM_SIZE_GRID,
  type RoomSize,
} from '@blastmates/shared';
import {
  agoLabel,
  fetchPublicRooms,
  fetchRoomInfo,
  pruneRecentRoom,
  recentRooms,
  type RecentRoom,
  type RoomInfo,
} from '../rooms';
import { session } from '../session';
import { currentAccount, useAccount } from '../account';
import { audio } from '../sound';
import { useSession } from './hooks';
import {
  Badge,
  Button,
  ErrorText,
  Hr,
  Muted,
  Panel,
  Screen,
  SectionTitle,
  TextInput,
  Title,
} from './bits';

const CREATE_SIZE_KEY = 'roomSize';
const QUICK_SIZE_KEY = 'quickRoomSize';

/** Mobile-first defaults: phones suggest 6-player rooms, desktops 8. */
function defaultSize(): RoomSize {
  return session.isTouch ? DEFAULT_ROOM_SIZE_TOUCH : DEFAULT_ROOM_SIZE_DESKTOP;
}

function storedSize(key: string): RoomSize | null {
  const stored = Number(localStorage.getItem(key));
  return ROOM_SIZES.find((s) => s === stored) ?? null;
}

function SizeButton({
  size,
  selected,
  disabled,
  onPick,
}: {
  size: RoomSize;
  selected: boolean;
  disabled?: boolean;
  onPick: () => void;
}) {
  const { width, height } = ROOM_SIZE_GRID[size];
  return (
    <Button
      variant="secondary"
      className={`px-4 py-2.5 ${selected ? 'bg-amber text-black [text-shadow:none]' : ''}`}
      title={`${size} players, ${width}x${height} arena`}
      disabled={disabled}
      onClick={onPick}
    >
      {size}P
    </Button>
  );
}

export { SizeButton };

function PublicRoomRow({ info }: { info: RoomInfo }) {
  return (
    <li
      className="mt-1.5 flex cursor-pointer items-center gap-2 border-2 border-ash bg-black p-2.5 text-[8px] hover:border-sky"
      onClick={() => {
        audio.uiClick();
        void session.openJoinScreen(info.roomId, true);
      }}
    >
      <span className="grow text-left text-cream">{info.name}</span>
      <Badge kind="size">{info.maxPlayers}P</Badge>
      <Badge kind={info.status === 'lobby' ? 'inlobby' : 'inmatch'}>
        {info.status === 'lobby' ? 'IN LOBBY' : 'IN MATCH'}
      </Badge>
      <span className="whitespace-nowrap text-silver">
        {info.players}/{info.maxPlayers}
      </span>
    </li>
  );
}

function RecentRoomRow({ room }: { room: RecentRoom }) {
  return (
    <li
      className="mt-1.5 flex cursor-pointer items-center gap-2 border-2 border-ash bg-black p-2.5 text-[8px] hover:border-sky"
      onClick={() => {
        audio.uiClick();
        void session.openJoinScreen(room.roomId, true);
      }}
    >
      <span className="grow text-left text-cream">
        {room.name ?? `ROOM ${room.roomId.toUpperCase()}`}
      </span>
      <span className="whitespace-nowrap text-silver">{agoLabel(room.at)}</span>
    </li>
  );
}

export function LandingScreen() {
  useSession();
  useAccount();
  const isAdmin = currentAccount()?.admin ?? false;
  const [publicRooms, setPublicRooms] = useState<RoomInfo[] | null>(null);
  const [recents, setRecents] = useState<RecentRoom[]>(() =>
    recentRooms().filter((r) => r.isPrivate),
  );
  const [quickSize, setQuickSize] = useState<RoomSize>(
    () => storedSize(QUICK_SIZE_KEY) ?? defaultSize(),
  );
  const [createSize, setCreateSize] = useState<RoomSize>(
    () => storedSize(CREATE_SIZE_KEY) ?? defaultSize(),
  );
  const [createPassword, setCreatePassword] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const refreshRecents = (): void => {
      setRecents(
        recentRooms()
          .filter((r) => r.isPrivate)
          .sort((a, b) => b.at - a.at),
      );
    };
    const refresh = async (): Promise<void> => {
      refreshRecents();
      const rooms = await fetchPublicRooms();
      if (alive.current && rooms !== null) setPublicRooms(rooms);
    };
    /** Drop recent rooms that no longer exist on the server (no click needed). */
    const validateRecents = async (): Promise<void> => {
      let changed = false;
      await Promise.all(
        recentRooms().map(async (r) => {
          const preview = await fetchRoomInfo(r.roomId);
          if (preview.kind === 'not_found') {
            pruneRecentRoom(r.roomId);
            changed = true;
          }
        }),
      );
      if (changed && alive.current) refreshRecents();
    };
    void refresh();
    void validateRecents();
    // A just-left room races our first fetch; a second pass catches the result.
    const second = window.setTimeout(() => void refresh(), 1200);
    const poll = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refresh();
    }, 4000);
    return () => {
      alive.current = false;
      clearTimeout(second);
      clearInterval(poll);
    };
  }, []);

  const play = (): void => void session.join({ kind: 'quick', size: quickSize });

  const cycleQuickSize = (ev: MouseEvent<HTMLButtonElement>): void => {
    const next =
      ROOM_SIZES[(ROOM_SIZES.indexOf(quickSize) + 1) % ROOM_SIZES.length] ?? defaultSize();
    localStorage.setItem(QUICK_SIZE_KEY, String(next));
    setQuickSize(next);
    ev.currentTarget.blur();
  };

  const cycleCreateSize = (ev: MouseEvent<HTMLButtonElement>): void => {
    const next =
      ROOM_SIZES[(ROOM_SIZES.indexOf(createSize) + 1) % ROOM_SIZES.length] ?? defaultSize();
    localStorage.setItem(CREATE_SIZE_KEY, String(next));
    setCreateSize(next);
    ev.currentTarget.blur();
  };

  return (
    <Screen>
      <Title />
      <Panel>
        <TextInput
          maxLength={16}
          placeholder={session.placeholderNickname}
          autoComplete="off"
          value={session.nickname}
          onChange={(ev) => session.setNickname(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') play();
          }}
        />
        {/* PLAY + the room-size button it quick-joins with (click to change). */}
        <div className="flex items-stretch justify-center gap-2">
          <Button variant="big" disabled={session.joining} onClick={play}>
            PLAY
          </Button>
          <Button
            variant="secondary"
            className="min-w-16 px-[18px] py-4 text-[14px]"
            title="ROOM SIZE - CLICK TO CHANGE"
            onClick={cycleQuickSize}
          >
            {quickSize}P
          </Button>
        </div>
        <ErrorText>{session.landingError}</ErrorText>
        <Hr />
        <SectionTitle>JOIN A PUBLIC ROOM</SectionTitle>
        {publicRooms !== null && publicRooms.length > 0 && (
          <ul className="m-0 w-full list-none p-0">
            {publicRooms.slice(0, 8).map((info) => (
              <PublicRoomRow key={info.roomId} info={info} />
            ))}
          </ul>
        )}
        {publicRooms !== null && publicRooms.length === 0 && (
          <>
            <Muted>NO OPEN ROOMS - CREATE ONE OR QUICK-JOIN</Muted>
            <Button variant="secondary" disabled={session.joining} onClick={play}>
              QUICK JOIN
            </Button>
          </>
        )}
        {recents.length > 0 && (
          <div className="flex w-full flex-col gap-3.5">
            <SectionTitle>PRIVATE ROOMS</SectionTitle>
            <ul className="m-0 w-full list-none p-0">
              {recents.map((r) => (
                <RecentRoomRow key={r.roomId} room={r} />
              ))}
            </ul>
          </div>
        )}
        <Hr />
        <SectionTitle>PRIVATE LOBBY</SectionTitle>
        <TextInput
          type="password"
          placeholder="PASSWORD (OPTIONAL)"
          value={createPassword}
          onChange={(ev) => setCreatePassword(ev.target.value)}
        />
        {/* CREATE + the room-size button it creates with (click to change). */}
        <div className="flex items-stretch justify-center gap-2">
          <Button
            variant="secondary"
            disabled={session.joining}
            onClick={() =>
              void session.join(
                createPassword
                  ? { kind: 'create', password: createPassword, size: createSize }
                  : { kind: 'create', size: createSize },
              )
            }
          >
            CREATE PRIVATE LOBBY
          </Button>
          <Button
            variant="secondary"
            className="min-w-12"
            title="ROOM SIZE - CLICK TO CHANGE"
            onClick={cycleCreateSize}
          >
            {createSize}P
          </Button>
        </div>
        <div className="mt-4 flex gap-2">
          {/* SKINS link hidden for now; we'll do skins later. The skins page itself stays reachable. */}
          <Button variant="secondary" onClick={() => session.openPage('settings')}>
            SETTINGS
          </Button>
          <Button variant="secondary" onClick={() => session.openPage('account')}>
            ACCOUNT
          </Button>
        </div>
        {isAdmin && (
          <Button variant="secondary" className="text-amber" onClick={() => (location.href = '/admin')}>
            ADMIN ZONE
          </Button>
        )}
      </Panel>
      {!session.isTouch && <Muted>MOVE: WASD/ARROWS &nbsp; BOMB: SPACE/ENTER</Muted>}
      <span className="text-[7px] text-ash" title="BUILD">
        V{__APP_VERSION__} ({__GIT_COMMIT__})
      </span>
    </Screen>
  );
}
