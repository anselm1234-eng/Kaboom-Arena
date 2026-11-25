import { useEffect, useState } from 'react';
import {
  accountKnown,
  currentAccount,
  forgotPassword,
  login,
  logout,
  pendingResetToken,
  refreshAccount,
  registerAccount,
  resendVerification,
  resetPassword,
  setResetToken,
  takeVerifyNotice,
  useAccount,
} from '../account';
import { audio } from '../sound';
import { session } from '../session';
import { useSession } from './hooks';
import {
  Badge,
  Button,
  ErrorText,
  Heading,
  Hr,
  Muted,
  Panel,
  Screen,
  SectionTitle,
  TextInput,
  Title,
} from './bits';
import { Pop } from './motion';

type Mode = 'signup' | 'signin' | 'forgot' | 'reset';

/**
 * Sign up / sign in toggle. The active tab pops up in amber while the inactive
 * tab sits pressed-in and dimmed, so it always reads which section you are in.
 */
function TabButton({
  selected,
  onPick,
  children,
}: {
  selected: boolean;
  onPick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        audio.uiClick();
        onPick();
      }}
      className={`grow cursor-pointer border-2 px-5 py-3 font-pixel text-[8px] ${
        selected
          ? 'border-cream bg-amber text-black shadow-[0_4px_0_#AB5236,0_4px_0_2px_#000000]'
          : 'translate-y-[3px] border-ash bg-black text-silver [text-shadow:1px_1px_0_#000000] hover:text-cream'
      }`}
    >
      {children}
    </button>
  );
}

/** Standalone account page (/account): sign up / sign in / signed-in state. */
export function AccountScreen() {
  useSession();
  useAccount();
  const [mode, setMode] = useState<Mode>(() => (pendingResetToken() ? 'reset' : 'signup'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [verifyResult] = useState(() => takeVerifyNotice());
  const [error, setError] = useState(
    verifyResult === 'failed' ? 'THIS VERIFICATION LINK IS INVALID OR EXPIRED' : '',
  );
  const [notice, setNotice] = useState<string | null>(
    verifyResult === 'ok' ? 'EMAIL VERIFIED - YOU ARE ALL SET' : null,
  );

  useEffect(() => {
    void refreshAccount();
  }, []);

  const account = currentAccount();
  const signedIn = account !== null && account.email !== null;

  const submit = async (): Promise<void> => {
    if (busy) return;
    const needsPassword = mode !== 'forgot';
    if ((mode !== 'reset' && !email.trim()) || (needsPassword && !password)) {
      setError('FILL IN ALL FIELDS');
      return;
    }
    if ((mode === 'signup' || mode === 'reset') && password.length < 8) {
      setError('PASSWORD MUST BE AT LEAST 8 CHARACTERS');
      return;
    }
    setBusy(true);
    setError('');
    setNotice(null);
    let err: string | null = null;
    if (mode === 'signup') {
      err = await registerAccount(email.trim(), password);
      if (!err) setNotice('ACCOUNT CREATED - CHECK YOUR INBOX TO VERIFY YOUR EMAIL');
    } else if (mode === 'signin') {
      err = await login(email.trim(), password);
    } else if (mode === 'forgot') {
      err = await forgotPassword(email.trim());
      if (!err) setNotice('IF THAT EMAIL HAS AN ACCOUNT, A RESET LINK IS ON ITS WAY');
    } else {
      err = await resetPassword(pendingResetToken() ?? '', password);
      if (!err) {
        setResetToken(null);
        setNotice('PASSWORD UPDATED - YOU ARE SIGNED IN');
        setMode('signin');
      }
    }
    if (!err) setPassword('');
    setError(err ?? '');
    setBusy(false);
  };

  const onEnter = (key: string): void => {
    if (key === 'Enter') void submit();
  };

  const pickMode = (next: Mode): void => {
    setMode(next);
    setError('');
    setNotice(null);
  };

  return (
    <Screen>
      <Title />
      <Pop>
        <Heading>ACCOUNT</Heading>
      </Pop>
      <Pop delay={0.06}>
        <Panel className="min-w-[340px] max-w-[420px]">
          {signedIn && account ? (
            <>
              <SectionTitle>SIGNED IN AS</SectionTitle>
              <div className="break-all text-[8px] text-cream">
                {account.email?.toUpperCase()}
                <Badge kind={account.verified ? 'ready' : 'unready'}>
                  {account.verified ? 'VERIFIED' : 'NOT VERIFIED'}
                </Badge>
              </div>
              {account.nickname && <Muted>PLAYING AS {account.nickname.toUpperCase()}</Muted>}
              {notice && <Muted className="text-lime">{notice}</Muted>}
              {!account.verified && (
                <>
                  <Muted>
                    CHECK YOUR INBOX FOR THE VERIFICATION LINK. NOTHING THERE? RESEND IT.
                  </Muted>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setError('');
                      void resendVerification().then((err) => {
                        setError(err ?? '');
                        if (!err) setNotice('VERIFICATION EMAIL SENT');
                        setBusy(false);
                      });
                    }}
                  >
                    RESEND VERIFICATION EMAIL
                  </Button>
                </>
              )}
              <ErrorText>{error}</ErrorText>
              <Hr />
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void logout().then((err) => {
                      setError(err ?? '');
                      setBusy(false);
                    });
                  }}
                >
                  SIGN OUT
                </Button>
                <Button onClick={() => session.goHome()}>BACK</Button>
              </div>
            </>
          ) : (
            <>
              <Muted>
                {account === null && !accountKnown()
                  ? 'YOU CAN ALWAYS PLAY WITHOUT AN ACCOUNT.'
                  : 'YOU ARE PLAYING AS A GUEST - NO ACCOUNT NEEDED.'}{' '}
                SIGN UP TO KEEP YOUR PROGRESS ON ANY DEVICE.
              </Muted>
              {mode === 'reset' ? (
                <SectionTitle>SET A NEW PASSWORD</SectionTitle>
              ) : (
                <>
                  <div className="flex w-full gap-2">
                    <TabButton selected={mode === 'signup'} onPick={() => pickMode('signup')}>
                      SIGN UP
                    </TabButton>
                    <TabButton
                      selected={mode === 'signin' || mode === 'forgot'}
                      onPick={() => pickMode('signin')}
                    >
                      SIGN IN
                    </TabButton>
                  </div>
                  <SectionTitle>
                    {mode === 'signup'
                      ? 'CREATE A NEW ACCOUNT'
                      : mode === 'forgot'
                        ? 'RESET YOUR PASSWORD'
                        : 'SIGN IN TO YOUR ACCOUNT'}
                  </SectionTitle>
                </>
              )}
              {mode !== 'reset' && (
                <TextInput
                  type="email"
                  className="w-full"
                  placeholder="EMAIL"
                  autoFocus
                  autoComplete="email"
                  value={email}
                  onChange={(ev) => setEmail(ev.target.value)}
                  onKeyDown={(ev) => onEnter(ev.key)}
                />
              )}
              {mode !== 'forgot' && (
                <TextInput
                  type="password"
                  className="w-full"
                  placeholder={mode === 'reset' ? 'NEW PASSWORD (8+ CHARS)' : mode === 'signup' ? 'PASSWORD (8+ CHARS)' : 'PASSWORD'}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(ev) => setPassword(ev.target.value)}
                  onKeyDown={(ev) => onEnter(ev.key)}
                />
              )}
              {mode === 'forgot' && (
                <Muted>WE WILL EMAIL YOU A LINK TO SET A NEW PASSWORD.</Muted>
              )}
              <Button className="w-full" disabled={busy} onClick={() => void submit()}>
                {mode === 'signup'
                  ? 'CREATE ACCOUNT'
                  : mode === 'signin'
                    ? 'SIGN IN'
                    : mode === 'forgot'
                      ? 'SEND RESET LINK'
                      : 'SET PASSWORD'}
              </Button>
              {mode === 'signin' && (
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 font-pixel text-[8px] text-sky hover:text-lemon"
                  onClick={() => pickMode('forgot')}
                >
                  FORGOT PASSWORD?
                </button>
              )}
              {(mode === 'forgot' || mode === 'reset') && (
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 font-pixel text-[8px] text-sky hover:text-lemon"
                  onClick={() => pickMode('signin')}
                >
                  BACK TO SIGN IN
                </button>
              )}
              {notice && <Muted className="text-lime">{notice}</Muted>}
              <ErrorText>{error}</ErrorText>
              <Hr />
              <Button className="min-w-[160px]" onClick={() => session.goHome()}>
                BACK
              </Button>
            </>
          )}
        </Panel>
      </Pop>
    </Screen>
  );
}
