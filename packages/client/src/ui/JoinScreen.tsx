import { useEffect, useRef, useState } from 'react';
import { session } from '../session';
import { useSession } from './hooks';
import { Badge, Button, ErrorText, Heading, Muted, Panel, Screen, TextInput, Title } from './bits';

/** Invite-link / room-browser entry: live room preview + nickname/password. */
export function JoinScreen() {
  useSession();
  const [password, setPassword] = useState('');
  const nicknameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const seededFor = useRef<string | null>(null);

  const view = session.joinView;
  const info = view?.preview?.kind === 'ok' ? view.preview.info : null;
  const showPassword = view !== null && (view.forcePassword || info?.passwordRequired === true);

  // First successful preview seeds focus: password if we already have a name.
  useEffect(() => {
    if (!view || !info || seededFor.current === view.roomId) return;
    seededFor.current = view.roomId;
    if (info.passwordRequired && session.nickname.trim()) passwordRef.current?.focus();
    else nicknameRef.current?.focus();
  });

  // A failed password attempt re-selects the password input.
  const focusNonce = view?.passwordFocusNonce ?? 0;
  useEffect(() => {
    if (focusNonce > 0) {
      passwordRef.current?.focus();
      passwordRef.current?.select();
    }
  }, [focusNonce]);

  if (!view) return null;

  const joinNow = (): void => session.joinRoom(password);
  const onEnter = (ev: { key: string }): void => {
    if (ev.key === 'Enter') joinNow();
  };

  return (
    <Screen>
      <Title />
      <Panel>
        <Heading>{info ? info.name : `ROOM ${view.roomId.toUpperCase()}`}</Heading>
        <div className="flex flex-wrap items-center justify-center gap-1.5 text-[8px] text-silver">
          {view.preview === null && 'LOOKING UP ROOM...'}
          {info && (
            <>
              <Badge kind={info.isPrivate ? 'priv' : 'pub'} className="ml-0">
                {info.isPrivate ? 'PRIVATE' : 'PUBLIC'}
              </Badge>
              <Badge kind="size" className="ml-0">
                {info.maxPlayers}-PLAYER
              </Badge>
              <Badge kind={info.status === 'lobby' ? 'inlobby' : 'inmatch'} className="ml-0">
                {info.status === 'lobby' ? 'IN LOBBY' : 'MATCH IN PROGRESS'}
              </Badge>
              <span>
                {info.players}/{info.maxPlayers} PLAYERS
              </span>
              <span>CODE {view.roomId.toUpperCase()}</span>
            </>
          )}
        </div>
        {view.edge !== null ? (
          <div className="flex w-full flex-col items-center gap-3.5">
            <div className="text-center text-[10px] text-cherry [text-shadow:1px_1px_0_#000000]">
              {view.edge.title}
            </div>
            <Muted>{view.edge.msg}</Muted>
          </div>
        ) : (
          info && (
            <div className="flex w-full flex-col items-center gap-3.5">
              {/* Mid-match joins work: the server seats you as a spectator. */}
              {info.status === 'in_match' && (
                <Muted>MATCH IN PROGRESS - YOU&apos;LL SPECTATE UNTIL THE NEXT ROUND</Muted>
              )}
              <TextInput
                ref={nicknameRef}
                maxLength={16}
                placeholder={session.placeholderNickname}
                autoComplete="off"
                value={session.nickname}
                onChange={(ev) => session.setNickname(ev.target.value)}
                onKeyDown={onEnter}
              />
              {showPassword && (
                <TextInput
                  ref={passwordRef}
                  type="password"
                  placeholder="ROOM PASSWORD"
                  value={password}
                  onChange={(ev) => setPassword(ev.target.value)}
                  onKeyDown={onEnter}
                />
              )}
              <Button variant="big" disabled={session.joining} onClick={joinNow}>
                JOIN GAME
              </Button>
              <ErrorText>{view.error}</ErrorText>
            </div>
          )
        )}
        <Button variant="secondary" onClick={() => session.goHome()}>
          BROWSE ROOMS / HOME
        </Button>
      </Panel>
    </Screen>
  );
}
