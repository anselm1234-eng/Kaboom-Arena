import { useEffect } from 'react';
import { AnimatePresence } from 'motion/react';
import { currentAccount, refreshAccount } from '../account';
import { session } from '../session';
import { useSession } from './hooks';
import { Button, Heading, Muted, Panel, Screen } from './bits';
import { PageTransition } from './motion';
import { LandingScreen } from './LandingScreen';
import { JoinScreen } from './JoinScreen';
import { LobbyScreen } from './LobbyScreen';
import { GameScreen } from './GameScreen';
import { SettingsScreen } from './SettingsScreen';
import { SkinsScreen } from './SkinsScreen';
import { AccountScreen } from './AccountScreen';

function RemovedScreen() {
  const byHost = session.removedReason === 'host';
  return (
    <Screen>
      <Heading>{byHost ? 'YOU WERE KICKED FROM THE ROOM' : 'YOU WERE REMOVED FOR INACTIVITY'}</Heading>
      <Panel>
        <Muted>
          {byHost
            ? 'THE HOST REMOVED YOU FROM THE ROOM.'
            : "YOU DIDN'T MOVE FOR TOO LONG, SO THE MATCH WENT ON WITHOUT YOU."}
        </Muted>
        <Button onClick={() => session.backToLanding()}>BACK TO MENU</Button>
      </Panel>
    </Screen>
  );
}

/** Touch devices play landscape-only; CSS shows this in portrait. */
function RotateOverlay() {
  return (
    <div id="rotate-overlay">
      <div className="rotate-phone" />
      <h2 className="m-0 text-[14px] text-amber [text-shadow:2px_2px_0_#000000]">
        ROTATE YOUR PHONE
      </h2>
      <div className="text-[8px] leading-[1.8] text-silver">kaboom-arena PLAYS IN LANDSCAPE</div>
    </div>
  );
}

export function App() {
  useSession();

  // Children mount (and the game canvas attaches) before this runs, so the
  // boot sequence - demo scenes, session resume, invite links - can render.
  useEffect(() => {
    session.boot();
    // Restore a signed-in account silently; never creates one (that happens
    // lazily on the first PLAY, so crawlers don't mint accounts). A fresh
    // device inherits the account's last played nickname.
    if (!session.demoMode) {
      void refreshAccount().then(() => {
        const nickname = currentAccount()?.nickname;
        if (nickname && !session.nickname) session.setNickname(nickname);
      });
    }
  }, []);

  return (
    <>
      {/* The game screen lives outside the switcher: it is always mounted
          (canvas + renderer attach once) and must never exit-animate. */}
      <AnimatePresence mode="wait" initial={false}>
        {session.screen !== 'game' && (
          <PageTransition key={session.screen}>
            {session.screen === 'landing' && <LandingScreen />}
            {session.screen === 'join' && <JoinScreen />}
            {session.screen === 'lobby' && <LobbyScreen />}
            {session.screen === 'removed' && <RemovedScreen />}
            {session.screen === 'skins' && <SkinsScreen />}
            {session.screen === 'settings' && <SettingsScreen />}
            {session.screen === 'account' && <AccountScreen />}
          </PageTransition>
        )}
      </AnimatePresence>
      <GameScreen active={session.screen === 'game'} />
      <RotateOverlay />
    </>
  );
}
