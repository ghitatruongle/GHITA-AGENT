// Shared framer-motion variants + transition presets (Track 5.3 motion
// normalization). Import these instead of re-declaring inline
// initial/animate/exit objects so desktop UI moves consistently.
//
// Reduced motion: every motion.* component rendered under the app's
// <MotionConfig reducedMotion="user"> (see App.tsx) automatically degrades
// transform/layout animations to simple opacity fades when the user has
// `prefers-reduced-motion: reduce` set at the OS level.

import type { Transition, Variants } from 'framer-motion';

// --- Spring presets ----------------------------------------------------------

/** Gentle spring for panels that expand/collapse (terminal, chat sidebar). */
export const springSoft: Transition = { type: 'spring', bounce: 0, duration: 0.3 };

/** Snappier spring for small interactive pops (dialogs, buttons). */
export const springSnappy: Transition = { type: 'spring', stiffness: 420, damping: 32 };

// --- Entrance variants -------------------------------------------------------

/** Fade + rise. Works with `initial="hidden" animate="visible"` or
 *  `whileInView="visible" viewport={{ once: true }}`. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
};

/** Plain opacity fade. */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.3, ease: 'easeOut' } },
};

/** Opacity + scale entrance for cards / centered blocks. */
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.4, ease: 'easeOut' } },
};

// --- View transitions (tab switching in MainLayout) ---------------------------

export const pageTransition: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: 'easeOut' } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.12, ease: 'easeIn' } },
};

// --- Staggered lists ----------------------------------------------------------

/** Parent container: stagger children that use `listItem` (or any variant). */
export const listContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
};

/** Child item of a `listContainer` — small fade + rise per item. */
export const listItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
};

// --- Overlays / dialogs (CommandPalette, QuickFileOpen, ShortcutsOverlay) -----

/** Dimmed backdrop. */
export const overlayFade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.15, ease: 'easeOut' } },
  exit: { opacity: 0, transition: { duration: 0.1, ease: 'easeIn' } },
};

/** Dialog panel: slight scale + drop from above (snappy spring). */
export const popIn: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: -12 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: springSnappy,
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: -12,
    transition: { duration: 0.1, ease: 'easeIn' },
  },
};
