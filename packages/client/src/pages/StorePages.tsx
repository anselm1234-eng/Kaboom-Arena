import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, ErrorText, Muted, Panel, TextInput } from '../ui/bits';

/**
 * Store / info pages rendered by the SPA shell: /bricks, /manage, /wall,
 * /admin, /tos. The game screens stay untouched — these pages never appear
 * in the core play flow.
 */

interface BrickInfo {
  id: string;
  size: number;
  status: string;
  displayName: string;
  linkUrl: string | null;
  imageUrl: string;
  daysLeft: number;
  forever?: boolean;
  stats: {
    appearances: number;
    tilesDestroyed: number;
    fullyDestroyed: number;
    views: number;
    clicks: number;
  };
}

const PAGE_PATHS = ['/bricks', '/manage', '/wall', '/admin', '/tos'] as const;
export type PagePath = (typeof PAGE_PATHS)[number];

/** The store/info page for the current URL, or null for the game app. */
export function storePagePath(): PagePath | null {
  return PAGE_PATHS.find((p) => p === location.pathname) ?? null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).toUpperCase();
}

function PageShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 p-4">
      <h1 className="m-0 mb-2 text-[20px] tracking-[2px] text-amber [text-shadow:4px_4px_0_#7E2553,8px_8px_0_#000000]">
        BLASTMATES
      </h1>
      <nav className="flex gap-[18px]">
        {(
          [
            ['/', 'PLAY'],
            ['/bricks', 'BUY A BRICK'],
            ['/wall', 'WALL'],
            ['/manage', 'MANAGE'],
            ['/tos', 'RULES'],
          ] as const
        ).map(([href, label]) => (
          <a key={href} href={href} className="text-[8px] text-sky no-underline hover:text-lemon">
            {label}
          </a>
        ))}
      </nav>
      <Panel className="max-w-[560px] gap-3">
        <h2 className="m-0 text-[16px] text-lemon [text-shadow:2px_2px_0_#000000]">{title}</h2>
        {children}
      </Panel>
    </div>
  );
}

function PageCopy({ children }: { children: ReactNode }) {
  return <Muted className="max-w-[480px] text-center leading-[1.9]">{children}</Muted>;
}

function BrickImage({ src, size, scale }: { src: string; size: number; scale: number }) {
  return (
    <img
      src={src}
      alt=""
      className="border-2 border-cream bg-black shadow-[4px_4px_0_#000000]"
      style={{ width: size * 16 * scale, height: 16 * scale }}
    />
  );
}

function BrickCard({ brick, children }: { brick: BrickInfo; children?: ReactNode }) {
  const fields: Array<[string, string]> = [
    ['STATUS', brick.status.toUpperCase()],
    ['DAYS LEFT', brick.forever ? 'FOREVER' : String(brick.daysLeft)],
    ['MATCHES', String(brick.stats.appearances)],
    ['VIEWS', String(brick.stats.views)],
    ['CLICKS', String(brick.stats.clicks)],
    ['TILES BLOWN UP', String(brick.stats.tilesDestroyed)],
    ['FULLY DESTROYED', String(brick.stats.fullyDestroyed)],
  ];
  return (
    <div className="flex flex-col items-center gap-2 border-2 border-ash bg-black p-3 text-[8px]">
      <div>{brick.displayName.toUpperCase()}</div>
      <BrickImage src={brick.imageUrl} size={brick.size} scale={4} />
      <div className="flex flex-col gap-1 leading-relaxed">
        {fields.map(([k, v]) => (
          <div key={k}>
            <span className="text-silver">{k}: </span>
            {v}
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

const FILE_INPUT_CLASS = 'w-[280px] font-pixel text-[7px] text-silver';

// --- Brick studio (shared by /bricks checkout and the admin zone) ---

const BRICK_SIZES = [
  { size: 1, label: '1x1', price: '5 EUR' },
  { size: 2, label: '2x1', price: '8 EUR' },
  { size: 3, label: '3x1', price: '12 EUR' },
];

interface SourceOpt {
  i: number;
  kind: string;
  label: string;
  url: string;
}
interface VariantOpt {
  key: string;
  label: string;
  hint: string;
  url: string;
  fullUrl: string;
}
export interface BrickCreatePayload {
  uploadId: string;
  source: number;
  variant: string;
  size: number;
  displayName: string;
  linkUrl?: string;
}

/** Pixel-art preview should never be smoothed when scaled. */
const PIXELATED = { imageRendering: 'pixelated' as const };

function PickCard({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex cursor-pointer flex-col items-center gap-1 border-2 bg-black p-2 ${
        selected ? 'border-amber' : 'border-ash hover:border-sky'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The full "see how it looks in game" flow: provide an image (upload OR paste a
 * URL and pick one of its favicon/og images), render several 8-bit styles,
 * preview each exactly as it appears on crates, then pick the best and submit.
 * onCreate decides what "submit" means (paid checkout vs. free admin brick).
 */
function BrickStudio({
  free,
  submitLabel,
  onCreate,
}: {
  free?: boolean;
  submitLabel: (priceEur: number | null) => string;
  onCreate: (payload: BrickCreatePayload) => Promise<string | null>;
}) {
  const [mode, setMode] = useState<'upload' | 'url'>('upload');
  const [size, setSize] = useState(3);
  const [url, setUrl] = useState('');
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceOpt[]>([]);
  const [source, setSource] = useState<number | null>(null);
  const [variants, setVariants] = useState<VariantOpt[]>([]);
  const [variant, setVariant] = useState<string | null>(null);
  const [priceEur, setPriceEur] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const resetRender = (): void => {
    setVariants([]);
    setVariant(null);
  };
  const resetAll = (): void => {
    setUploadId(null);
    setSources([]);
    setSource(null);
    resetRender();
  };

  const loadUpload = async (): Promise<void> => {
    const blob = fileRef.current?.files?.[0];
    if (!blob) {
      setStatus('PICK AN IMAGE FIRST');
      return;
    }
    setBusy(true);
    setStatus('UPLOADING...');
    try {
      const r = await api<{ uploadId: string; sources: SourceOpt[] }>('/api/bricks/source', {
        method: 'POST',
        body: blob,
      });
      const first = r.sources[0]?.i ?? null;
      setUploadId(r.uploadId);
      setSources(r.sources);
      setSource(first);
      resetRender();
      // Immediately show the in-game alternatives for the uploaded image.
      if (first !== null) await runRender(r.uploadId, first, size);
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const loadUrl = async (): Promise<void> => {
    if (!url.trim()) {
      setStatus('ENTER A URL FIRST');
      return;
    }
    setBusy(true);
    setStatus('FETCHING IMAGES...');
    try {
      const r = await api<{ uploadId: string; sources: SourceOpt[] }>('/api/bricks/source-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const first = r.sources[0]?.i ?? null;
      setUploadId(r.uploadId);
      setSources(r.sources);
      setSource(first);
      resetRender();
      // Render the first found image right away; switching source re-renders.
      if (first !== null) await runRender(r.uploadId, first, size);
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Render the in-game style options for a given source + size. Called
   * automatically whenever the source or size changes, so the buyer always
   * sees the alternatives to pick from without an extra step.
   */
  const runRender = async (uid: string, src: number, sz: number): Promise<void> => {
    setBusy(true);
    setVariants([]);
    setVariant(null);
    setStatus('RENDERING IN-GAME STYLES...');
    try {
      const r = await api<{ variants: VariantOpt[]; priceEur: number }>('/api/bricks/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId: uid, source: src, size: sz }),
      });
      setVariants(r.variants);
      setVariant(r.variants[0]?.key ?? null);
      setPriceEur(r.priceEur);
      setStatus(r.variants.length > 0 ? 'PICK THE STYLE YOU LIKE BEST' : '');
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const pickSize = (s: number): void => {
    setSize(s);
    if (uploadId !== null && source !== null) void runRender(uploadId, source, s);
  };

  const pickSource = (i: number): void => {
    setSource(i);
    if (uploadId !== null) void runRender(uploadId, i, size);
  };

  const submit = async (): Promise<void> => {
    if (uploadId === null || source === null || variant === null) return;
    const displayName = name.trim();
    if (!displayName) {
      setStatus('DISPLAY NAME IS REQUIRED');
      return;
    }
    setBusy(true);
    setStatus('SUBMITTING...');
    const err = await onCreate({
      uploadId,
      source,
      variant,
      size,
      displayName,
      linkUrl: link.trim() || undefined,
    });
    setBusy(false);
    if (err) {
      setStatus(err);
    } else {
      setStatus(free ? 'BRICK CREATED & LIVE!' : '');
      if (free) {
        resetAll();
        setName('');
        setLink('');
        if (fileRef.current) fileRef.current.value = '';
      }
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-3">
      {/* 1. Provide an image */}
      <div className="flex gap-2">
        <Button
          variant="secondary"
          className={mode === 'upload' ? 'bg-amber text-black [text-shadow:none]' : ''}
          onClick={() => {
            setMode('upload');
            resetAll();
            setStatus('');
          }}
        >
          UPLOAD
        </Button>
        <Button
          variant="secondary"
          className={mode === 'url' ? 'bg-amber text-black [text-shadow:none]' : ''}
          onClick={() => {
            setMode('url');
            resetAll();
            setStatus('');
          }}
        >
          FROM A URL
        </Button>
      </div>

      {mode === 'upload' ? (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className={FILE_INPUT_CLASS}
          />
          <Button variant="secondary" disabled={busy} onClick={() => void loadUpload()}>
            USE THIS IMAGE
          </Button>
        </>
      ) : (
        <>
          <TextInput
            maxLength={300}
            placeholder="https://example.com"
            value={url}
            onChange={(ev) => setUrl(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') void loadUrl();
            }}
          />
          <Button variant="secondary" disabled={busy} onClick={() => void loadUrl()}>
            FETCH ITS IMAGES
          </Button>
        </>
      )}

      {/* 2. Pick a source image (URL mode usually returns several) */}
      {sources.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {sources.map((s) => (
            <PickCard key={s.i} selected={s.i === source} onClick={() => pickSource(s.i)}>
              <img src={s.url} alt={s.label} className="h-12 w-12 bg-cream object-contain" />
              <span className="text-[7px] text-silver">{s.label}</span>
            </PickCard>
          ))}
        </div>
      )}

      {/* 3. Size (re-renders the options live) */}
      {uploadId !== null && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {BRICK_SIZES.map(({ size: s, label, price }) => (
            <Button
              key={s}
              variant="secondary"
              className={s === size ? 'bg-amber text-black [text-shadow:none]' : ''}
              onClick={() => pickSize(s)}
            >
              {label}
              {!free && ` · ${price}`}
            </Button>
          ))}
        </div>
      )}

      {/* 4. Pick the style — these are exactly how it renders in a match */}
      {variants.length > 0 && (
        <>
          <Muted>THIS IS EXACTLY HOW IT LOOKS IN-GAME — PICK YOUR FAVORITE</Muted>
          <div className="flex flex-wrap justify-center gap-2.5">
            {variants.map((v) => (
              <PickCard key={v.key} selected={v.key === variant} onClick={() => setVariant(v.key)}>
                <img src={v.url} alt={v.label} className="w-[180px]" style={PIXELATED} />
                <span className="text-[8px] text-cream">{v.label}</span>
                <span className="text-[7px] text-silver">{v.hint}</span>
              </PickCard>
            ))}
          </div>
        </>
      )}

      {/* 5. Details + submit */}
      {variant !== null && (
        <>
          <TextInput
            maxLength={24}
            placeholder="DISPLAY NAME"
            value={name}
            onChange={(ev) => setName(ev.target.value)}
          />
          <TextInput
            maxLength={200}
            placeholder="LINK URL (OPTIONAL)"
            value={link}
            onChange={(ev) => setLink(ev.target.value)}
          />
          <Button disabled={busy} onClick={() => void submit()}>
            {submitLabel(priceEur)}
          </Button>
        </>
      )}
      <ErrorText>{status}</ErrorText>
    </div>
  );
}

// --- /bricks ---

function BricksPage() {
  const checkout = async (payload: BrickCreatePayload): Promise<string | null> => {
    try {
      const result = await api<{ checkoutUrl: string | null }>('/api/bricks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (result.checkoutUrl) {
        location.href = result.checkoutUrl;
        return null;
      }
      return 'CHECKOUT IS NOT CONFIGURED ON THIS SERVER';
    } catch (err) {
      return errorText(err);
    }
  };

  return (
    <PageShell title="BUY A BRICK">
      <PageCopy>
        Your art on crates in real public matches for 30 days. Players blow it up. It comes back
        next round. Upload an image or paste your site&apos;s URL, see several in-game styles, pick
        the best, then pay with Lemon Squeezy. Your receipt email has the license key for managing
        your brick. No account needed.
      </PageCopy>
      <BrickStudio
        submitLabel={(price) => (price ? `PAY ${price} EUR & GO LIVE` : 'PAY & GO LIVE')}
        onCreate={checkout}
      />
      <PageCopy>
        Content rules apply (see RULES). Bricks violating them are removed without refund of the
        remaining days.
      </PageCopy>
    </PageShell>
  );
}

// --- /manage ---

function ManagePage() {
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [brick, setBrick] = useState<BrickInfo | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (): Promise<void> => {
    const trimmed = key.trim();
    if (!trimmed) return;
    setStatus('CHECKING...');
    setBrick(null);
    try {
      const data = await api<{ brick: BrickInfo }>('/api/manage/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: trimmed }),
      });
      setStatus('');
      setBrick(data.brick);
    } catch (err) {
      setStatus(errorText(err));
    }
  };

  const replaceImage = async (): Promise<void> => {
    const blob = fileRef.current?.files?.[0];
    if (!blob) {
      setStatus('PICK A NEW IMAGE FIRST');
      return;
    }
    setStatus('UPLOADING...');
    try {
      const updated = await api<{ brick: BrickInfo }>('/api/manage/replace', {
        method: 'POST',
        headers: { 'x-license-key': key.trim() },
        body: blob,
      });
      setStatus('IMAGE REPLACED!');
      setBrick(updated.brick);
    } catch (err) {
      setStatus(errorText(err));
    }
  };

  return (
    <PageShell title="MANAGE YOUR BRICK">
      <PageCopy>Enter the license key from your Lemon Squeezy receipt email.</PageCopy>
      <TextInput
        maxLength={64}
        placeholder="LICENSE KEY"
        value={key}
        onChange={(ev) => setKey(ev.target.value)}
      />
      <Button onClick={() => void load()}>LOAD MY BRICK</Button>
      <ErrorText>{status}</ErrorText>
      {brick && (
        <div className="flex flex-wrap justify-center gap-3.5">
          <BrickCard brick={brick} />
          {brick.status === 'active' && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                className={FILE_INPUT_CLASS}
              />
              <Button variant="secondary" onClick={() => void replaceImage()}>
                REPLACE IMAGE
              </Button>
            </>
          )}
        </div>
      )}
    </PageShell>
  );
}

// --- /wall ---

interface WallBrick {
  id: string;
  displayName: string;
  linkUrl: string | null;
  imageUrl: string;
  size: number;
  tilesDestroyed: number;
}

function WallPage() {
  const [bricks, setBricks] = useState<WallBrick[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ bricks: WallBrick[] }>('/api/wall')
      .then((data) => setBricks(data.bricks))
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  return (
    <PageShell title="THE WALL">
      <PageCopy>Every brick currently in rotation in public matches.</PageCopy>
      <div className="flex flex-wrap justify-center gap-3.5">
        {error && <ErrorText>{error}</ErrorText>}
        {bricks?.length === 0 && <Muted>NO BRICKS YET - BE THE FIRST!</Muted>}
        {bricks?.map((brick) => (
          <div
            key={brick.id}
            className="flex flex-col items-center gap-2 border-2 border-ash bg-black p-3 text-[8px]"
          >
            <BrickImage src={brick.imageUrl} size={brick.size} scale={4} />
            <div>
              {brick.linkUrl ? (
                <a
                  href={brick.linkUrl}
                  rel="noopener nofollow"
                  target="_blank"
                  className="text-sky"
                >
                  {brick.displayName.toUpperCase()}
                </a>
              ) : (
                <span>{brick.displayName.toUpperCase()}</span>
              )}
            </div>
            <Muted>{brick.tilesDestroyed} TILES BLOWN UP</Muted>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

// --- /admin (account-based admin zone) ---

interface AdminAccount {
  id: string;
  email: string | null;
  admin: boolean;
}

interface OnlinePlayer {
  nickname: string;
  roomId: string;
  roomName: string;
  roomStatus: 'lobby' | 'in_match';
  isPrivate: boolean;
  spectator: boolean;
}

interface AdminSummary {
  accounts: { total: number; registered: number; verified: number; admins: number };
  bricks: {
    byStatus: Record<string, number>;
    total: number;
    appearances: number;
    tilesDestroyed: number;
    fullyDestroyed: number;
    views: number;
    clicks: number;
  };
  live: {
    rooms: number;
    publicRooms: number;
    privateRooms: number;
    inMatch: number;
    humansOnline: number;
    bots: number;
  };
  online: OnlinePlayer[];
}

function StatGrid({ stats }: { stats: Array<[string, string | number]> }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[8px] sm:grid-cols-3">
      {stats.map(([k, v]) => (
        <div key={k} className="flex flex-col items-center gap-1 border-2 border-ash bg-black p-2">
          <span className="text-[14px] text-lemon">{v}</span>
          <span className="text-center text-silver">{k}</span>
        </div>
      ))}
    </div>
  );
}

/** Email/password login shown when nobody (or a non-admin) is signed in. */
function AdminLogin({ onAuthed, notice }: { onAuthed: () => void; notice: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');

  const submit = async (): Promise<void> => {
    setStatus('SIGNING IN...');
    try {
      await api('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      setStatus('');
      onAuthed();
    } catch (err) {
      setStatus(errorText(err));
    }
  };

  return (
    <PageShell title="ADMIN SIGN IN">
      <PageCopy>{notice}</PageCopy>
      <TextInput
        type="email"
        placeholder="EMAIL"
        value={email}
        onChange={(ev) => setEmail(ev.target.value)}
      />
      <TextInput
        type="password"
        placeholder="PASSWORD"
        value={password}
        onChange={(ev) => setPassword(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') void submit();
        }}
      />
      <Button onClick={() => void submit()}>SIGN IN</Button>
      <ErrorText>{status}</ErrorText>
    </PageShell>
  );
}

/** Admin's free-brick creator — the same studio buyers use, but free + live. */
function AdminCreateBrick({ onCreated }: { onCreated: () => void }) {
  const create = async (payload: BrickCreatePayload): Promise<string | null> => {
    try {
      await api('/api/admin/bricks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      onCreated();
      return null;
    } catch (err) {
      return errorText(err);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-2 border-2 border-ash bg-black p-3">
      <h3 className="m-0 text-[10px] text-amber">ADD A FREE BRICK</h3>
      <PageCopy>Upload or paste a URL, preview the in-game styles, and create one for free.</PageCopy>
      <BrickStudio free submitLabel={() => 'CREATE FREE BRICK'} onCreate={create} />
    </div>
  );
}

function AdminDashboard({ account }: { account: AdminAccount }) {
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [bricks, setBricks] = useState<BrickInfo[]>([]);
  const [status, setStatus] = useState('');
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const refresh = async (): Promise<void> => {
    try {
      const [s, b] = await Promise.all([
        api<AdminSummary>('/api/admin/summary'),
        api<{ bricks: BrickInfo[] }>('/api/admin/bricks'),
      ]);
      setSummary(s);
      setBricks(b.bricks);
      setStatus('');
    } catch (err) {
      setStatus(errorText(err));
    }
  };

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
    return () => clearInterval(poll);
  }, []);

  const edit = async (brick: BrickInfo): Promise<void> => {
    const displayName = prompt('Display name', brick.displayName);
    if (displayName === null) return;
    const linkUrl = prompt('Link URL (blank for none)', brick.linkUrl ?? '') ?? '';
    try {
      await api(`/api/admin/bricks/${brick.id}/edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName, linkUrl: linkUrl.trim() || undefined }),
      });
      await refresh();
    } catch (err) {
      setStatus(errorText(err));
    }
  };

  const replace = async (brick: BrickInfo): Promise<void> => {
    const blob = fileRefs.current[brick.id]?.files?.[0];
    if (!blob) {
      setStatus('PICK AN IMAGE FIRST');
      return;
    }
    try {
      await api(`/api/admin/bricks/${brick.id}/replace`, { method: 'POST', body: blob });
      await refresh();
    } catch (err) {
      setStatus(errorText(err));
    }
  };

  const deactivate = async (brick: BrickInfo): Promise<void> => {
    const reason = prompt('Reason (optional)') ?? '';
    try {
      await api(`/api/admin/bricks/${brick.id}/deactivate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      await refresh();
    } catch (err) {
      setStatus(errorText(err));
    }
  };

  const toggleForever = async (brick: BrickInfo): Promise<void> => {
    const forever = !brick.forever;
    if (
      forever &&
      !confirm(`Keep "${brick.displayName}" on the board forever (it will never expire)?`)
    ) {
      return;
    }
    try {
      await api(`/api/admin/bricks/${brick.id}/forever`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ forever }),
      });
      await refresh();
    } catch (err) {
      setStatus(errorText(err));
    }
  };

  const remove = async (brick: BrickInfo): Promise<void> => {
    if (!confirm(`Delete brick "${brick.displayName}"? This cannot be undone.`)) return;
    try {
      await api(`/api/admin/bricks/${brick.id}/delete`, { method: 'POST' });
      await refresh();
    } catch (err) {
      setStatus(errorText(err));
    }
  };

  return (
    <PageShell title="ADMIN ZONE">
      <PageCopy>Signed in as {account.email}. Live numbers refresh every few seconds.</PageCopy>
      <ErrorText>{status}</ErrorText>

      <h3 className="m-0 text-[12px] text-lemon">LIVE</h3>
      <StatGrid
        stats={[
          ['PLAYERS ONLINE', summary?.live.humansOnline ?? '-'],
          ['ROOMS', summary?.live.rooms ?? '-'],
          ['IN MATCH', summary?.live.inMatch ?? '-'],
          ['PUBLIC', summary?.live.publicRooms ?? '-'],
          ['PRIVATE', summary?.live.privateRooms ?? '-'],
          ['BOTS', summary?.live.bots ?? '-'],
        ]}
      />

      <h3 className="m-0 text-[12px] text-lemon">ONLINE PLAYERS</h3>
      {summary && summary.online.length === 0 && <Muted>NOBODY IS PLAYING RIGHT NOW</Muted>}
      {summary && summary.online.length > 0 && (
        <ul className="m-0 w-full max-w-[480px] list-none p-0">
          {summary.online.map((p, i) => (
            <li
              key={`${p.roomId}-${p.nickname}-${i}`}
              className="mt-1.5 flex items-center gap-2 border-2 border-ash bg-black p-2 text-[8px]"
            >
              <span className="grow text-left text-cream">{p.nickname.toUpperCase()}</span>
              <span className="text-silver">{p.roomName}</span>
              <span className={p.roomStatus === 'in_match' ? 'text-amber' : 'text-sky'}>
                {p.spectator ? 'SPECTATING' : p.roomStatus === 'in_match' ? 'IN MATCH' : 'IN LOBBY'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="m-0 text-[12px] text-lemon">STATISTICS</h3>
      <StatGrid
        stats={[
          ['ACCOUNTS', summary?.accounts.total ?? '-'],
          ['REGISTERED', summary?.accounts.registered ?? '-'],
          ['VERIFIED', summary?.accounts.verified ?? '-'],
          ['ADMINS', summary?.accounts.admins ?? '-'],
          ['BRICKS', summary?.bricks.total ?? '-'],
          ['ACTIVE BRICKS', summary?.bricks.byStatus.active ?? 0],
          ['BRICK VIEWS', summary?.bricks.views ?? '-'],
          ['BRICK CLICKS', summary?.bricks.clicks ?? '-'],
          ['TILES BLOWN UP', summary?.bricks.tilesDestroyed ?? '-'],
          ['MATCH APPEARANCES', summary?.bricks.appearances ?? '-'],
          ['FULLY DESTROYED', summary?.bricks.fullyDestroyed ?? '-'],
        ]}
      />

      <h3 className="m-0 text-[12px] text-lemon">BRICKS</h3>
      <AdminCreateBrick onCreated={() => void refresh()} />
      <div className="flex flex-wrap justify-center gap-3.5">
        {bricks.map((brick) => (
          <BrickCard key={brick.id} brick={brick}>
            <input
              ref={(el) => {
                fileRefs.current[brick.id] = el;
              }}
              type="file"
              accept="image/png,image/jpeg"
              className={FILE_INPUT_CLASS}
            />
            <div className="flex flex-wrap justify-center gap-1.5">
              <Button variant="secondary" onClick={() => void replace(brick)}>
                REPLACE IMG
              </Button>
              <Button variant="secondary" onClick={() => void edit(brick)}>
                EDIT
              </Button>
              {brick.status === 'active' && (
                <Button variant="secondary" onClick={() => void deactivate(brick)}>
                  DEACTIVATE
                </Button>
              )}
              <Button
                variant="secondary"
                className={brick.forever ? 'text-amber' : undefined}
                onClick={() => void toggleForever(brick)}
              >
                {brick.forever ? 'END FOREVER' : 'MAKE FOREVER'}
              </Button>
              <Button variant="secondary" className="text-cherry" onClick={() => void remove(brick)}>
                DELETE
              </Button>
            </div>
          </BrickCard>
        ))}
      </div>
    </PageShell>
  );
}

function AdminPage() {
  const [account, setAccount] = useState<AdminAccount | null | 'loading'>('loading');

  const checkAuth = async (): Promise<void> => {
    try {
      const data = await api<{ account: AdminAccount | null }>('/api/auth/me');
      setAccount(data.account ?? null);
    } catch {
      setAccount(null);
    }
  };

  useEffect(() => {
    void checkAuth();
  }, []);

  if (account === 'loading') {
    return (
      <PageShell title="ADMIN ZONE">
        <Muted>LOADING...</Muted>
      </PageShell>
    );
  }
  if (!account || !account.admin) {
    return (
      <AdminLogin
        notice={
          account
            ? 'THIS ACCOUNT IS NOT AN ADMIN. SIGN IN WITH AN ADMIN ACCOUNT.'
            : 'SIGN IN WITH YOUR ADMIN ACCOUNT TO CONTINUE.'
        }
        onAuthed={() => void checkAuth()}
      />
    );
  }
  return <AdminDashboard account={account} />;
}

// --- /tos ---

const RULES = [
  'BLASTMATES is free to play. No account, no tracking, no nags.',
  'Bricks: you buy 30 days of rotation for a custom crate image in public matches. Payment is handled by Lemon Squeezy (merchant of record); your receipt email contains the license key that proves ownership.',
  'Content rules: no illegal content, no hate symbols, no porn, no harassment, no impersonation, no scams or malware links. Plain ads are fine.',
  'Bricks violating these rules are deactivated without refund of remaining days. Payment disputes and refunds are otherwise handled through Lemon Squeezy.',
  'Skin packs are cosmetic only and never affect gameplay.',
  'Branded crates behave exactly like normal crates. Buying a brick gives no gameplay advantage to anyone.',
];

function TosPage() {
  return (
    <PageShell title="RULES / TERMS">
      {RULES.map((rule, i) => (
        <PageCopy key={i}>{rule}</PageCopy>
      ))}
    </PageShell>
  );
}

export function StorePage({ path }: { path: PagePath }) {
  if (path === '/bricks') return <BricksPage />;
  if (path === '/manage') return <ManagePage />;
  if (path === '/wall') return <WallPage />;
  if (path === '/admin') return <AdminPage />;
  return <TosPage />;
}
