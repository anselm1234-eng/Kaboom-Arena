import { session } from '../session';
import { useSession } from './hooks';
import { Button, Heading, Hr, Panel, Screen, Title } from './bits';
import { Pop } from './motion';
import { SkinPicker } from './SkinPicker';

/** Standalone skins page (/skins), reachable from the landing screen. */
export function SkinsScreen() {
  useSession();
  return (
    <Screen>
      <Title />
      <Pop>
        <Heading>SKINS</Heading>
      </Pop>
      <Pop delay={0.06}>
        <Panel className="max-w-[480px]">
          <SkinPicker />
          <Hr />
          <Button className="min-w-[160px]" onClick={() => session.goHome()}>
            BACK
          </Button>
        </Panel>
      </Pop>
    </Screen>
  );
}
