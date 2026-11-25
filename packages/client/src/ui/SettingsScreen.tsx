import { session } from '../session';
import { useSession } from './hooks';
import { AudioSettings } from './AudioSettings';
import { Button, Heading, Hr, Panel, Screen, SectionTitle, Title } from './bits';
import { Pop } from './motion';

/** Standalone settings page (/settings), reachable from the landing screen. */
export function SettingsScreen() {
  useSession();
  return (
    <Screen>
      <Title />
      <Pop>
        <Heading>SETTINGS</Heading>
      </Pop>
      <Pop delay={0.06}>
        <Panel className="min-w-[340px] max-w-[420px]">
          <SectionTitle>AUDIO</SectionTitle>
          <AudioSettings />
          {session.isTouch && (
            <>
              <Hr />
              <SectionTitle>HAPTICS</SectionTitle>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => {
                  session.haptics.setEnabled(!session.haptics.enabled());
                  if (session.haptics.enabled()) session.haptics.trigger('light'); // confirm it works
                  session.refresh();
                }}
              >
                HAPTICS: {session.haptics.enabled() ? 'ON' : 'OFF'}
              </Button>
            </>
          )}
          <Hr />
          <Button className="min-w-[160px]" onClick={() => session.goHome()}>
            BACK
          </Button>
        </Panel>
      </Pop>
    </Screen>
  );
}
