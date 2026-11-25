import { useEffect, useState, useSyncExternalStore } from 'react';
import { session } from '../session';

/** Re-render on any session state change; returns the change counter. */
export function useSession(): number {
  return useSyncExternalStore(session.subscribe, session.getVersion);
}

/** Low-rate re-render driver for countdowns and HUD stats. */
export function useTick(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return tick;
}
