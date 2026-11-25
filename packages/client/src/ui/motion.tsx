import type { ReactNode } from 'react';
import { motion, type Transition } from 'motion/react';

/**
 * Shared motion bits. Animations stay snappy and chunky to match the retro
 * art style: short springs, small offsets, no slow fades.
 */

const SPRING: Transition = { type: 'spring', stiffness: 520, damping: 32, mass: 0.9 };

/** Full-screen transition wrapper used by the App screen switcher. */
export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -16, scale: 0.98, transition: { duration: 0.12 } }}
      transition={SPRING}
    >
      {children}
    </motion.div>
  );
}

/** Pop-in for panels/headings; stagger siblings with increasing delay. */
export function Pop({
  delay = 0,
  className,
  children,
}: {
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...SPRING, delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
