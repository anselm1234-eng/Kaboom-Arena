import type { ComponentProps, ReactNode } from 'react';
import { CROWN_ICON } from '../icons';
import { audio } from '../sound';

/** Retro UI building blocks: chunky borders, hard shadows, PICO-8 colors. */

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Screen({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('flex flex-col items-center gap-4 p-4', className)}>{children}</div>;
}

export function Title() {
  return (
    <h1 className="m-0 mb-2 text-[32px] tracking-[2px] text-amber [text-shadow:4px_4px_0_#7E2553,8px_8px_0_#000000]">
      kaboom-arena
    </h1>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return <h2 className="m-0 text-[16px] text-lemon [text-shadow:2px_2px_0_#000000]">{children}</h2>;
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        'flex min-w-[420px] flex-col items-center gap-3.5 border-2 border-cream bg-night p-6 shadow-[6px_6px_0_#000000]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Hr() {
  return <hr className="w-full border-0 border-t-2 border-ash" />;
}

export function Muted({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('text-[8px] leading-[1.8] text-silver', className)}>{children}</div>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-3 text-[8px] text-cherry [text-shadow:1px_1px_0_#000000]">{children}</div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="w-full text-left text-[8px] text-lemon [text-shadow:1px_1px_0_#000000]">
      {children}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'big' | 'kick';

const BUTTON_BASE =
  'cursor-pointer border-2 border-cream font-pixel text-cream [text-shadow:1px_1px_0_#000000] ' +
  'active:translate-y-[2px] ' +
  'disabled:cursor-default disabled:translate-y-0 disabled:bg-ash disabled:text-silver ' +
  'disabled:shadow-[0_4px_0_#1D2B53,0_4px_0_2px_#000000]';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-cherry text-[8px] px-5 py-3 shadow-[0_4px_0_#7E2553,0_4px_0_2px_#000000] hover:bg-bubblegum ' +
    'active:shadow-[0_2px_0_#7E2553,0_2px_0_2px_#000000]',
  secondary:
    'bg-night text-[8px] px-5 py-3 shadow-[0_4px_0_#000000,0_4px_0_2px_#000000] hover:bg-haze ' +
    'active:shadow-[0_2px_0_#000000,0_2px_0_2px_#000000]',
  // The headline action (PLAY / JOIN GAME): big and amber.
  big:
    'bg-amber text-[14px] px-12 py-4 shadow-[0_4px_0_#AB5236,0_4px_0_2px_#000000] ' +
    'hover:bg-lemon hover:text-black hover:[text-shadow:none] ' +
    'active:shadow-[0_2px_0_#AB5236,0_2px_0_2px_#000000]',
  kick: 'bg-wine text-[6px] px-1.5 py-1 shadow-[0_2px_0_#000000] hover:bg-cherry active:shadow-none',
};

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  /** Skip the click blip, e.g. when the click immediately triggers another sound. */
  silent?: boolean;
}

export function Button({ variant = 'primary', className, type, onClick, silent, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className)}
      onClick={(ev) => {
        if (!silent) audio.uiClick();
        onClick?.(ev);
      }}
      {...rest}
    />
  );
}

export function TextInput({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <input
      className={cx(
        'w-64 border-2 border-ash bg-black px-3 py-2.5 text-center font-pixel text-[8px] text-cream',
        'outline-none placeholder:text-ash focus:border-sky',
        className,
      )}
      {...rest}
    />
  );
}

export type BadgeKind =
  | 'host'
  | 'off'
  | 'spec'
  | 'bot'
  | 'local'
  | 'size'
  | 'ready'
  | 'unready'
  | 'pub'
  | 'priv'
  | 'inlobby'
  | 'inmatch';

const BADGE_COLORS: Record<BadgeKind, string> = {
  host: 'bg-amber text-black',
  off: 'bg-cherry text-cream',
  spec: 'bg-ash text-cream',
  bot: 'bg-sky text-black',
  local: 'bg-lime text-black',
  size: 'bg-haze text-black',
  ready: 'bg-lime text-black',
  unready: 'bg-ash text-cream',
  pub: 'bg-lime text-black',
  priv: 'bg-amber text-black',
  inlobby: 'bg-sky text-black',
  inmatch: 'bg-cherry text-cream',
};

export function Badge({
  kind,
  className,
  children,
}: {
  kind: BadgeKind;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'ml-1.5 border border-black px-1 py-0.75 text-[6px]',
        BADGE_COLORS[kind],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Crown({ className }: { className?: string }) {
  return <img src={CROWN_ICON} alt="host" title="Host" className={cx('h-4 w-4', className)} />;
}
