// Adapted from react-bits (https://reactbits.dev) MIT
// Source: src/ts-default/Animations/FadeContent — the original animates via
// GSAP + ScrollTrigger; this adaptation reimplements the same visual idea
// (opacity/blur reveal) with framer-motion only, keeps a small type-safe prop
// surface, and respects `prefers-reduced-motion` by rendering content
// immediately without any animation.

import type { HTMLAttributes, ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

// DOM handlers framer-motion redefines (animation/drag callbacks) must be
// omitted or spreading `rest` into motion.div is a type conflict.
export interface FadeContentProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    | 'children'
    | 'onAnimationStart'
    | 'onAnimationIteration'
    | 'onAnimationEnd'
    | 'onDrag'
    | 'onDragStart'
    | 'onDragEnd'
    | 'onDragOver'
    | 'onDragEnter'
    | 'onDragLeave'
    | 'onDrop'
  > {
  children: ReactNode;
  /** Fade duration in seconds. */
  duration?: number;
  /** Delay before the fade starts, in seconds. */
  delay?: number;
  /** Also blur in from 8px. */
  blur?: boolean;
  /** Starting opacity. */
  initialOpacity?: number;
  /** Animate when scrolled into view instead of on mount. */
  inView?: boolean;
}

export function FadeContent({
  children,
  duration = 0.4,
  delay = 0,
  blur = false,
  initialOpacity = 0,
  inView = false,
  className,
  style,
  ...rest
}: FadeContentProps) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return (
      <div className={className} style={style} {...rest}>
        {children}
      </div>
    );
  }

  const hidden = { opacity: initialOpacity, filter: blur ? 'blur(8px)' : 'blur(0px)' };
  const visible = { opacity: 1, filter: 'blur(0px)' };
  const transition = { duration, delay, ease: 'easeOut' as const };

  return (
    <motion.div
      className={className}
      style={style}
      initial={hidden}
      {...(inView
        ? { whileInView: visible, viewport: { once: true, amount: 0.2 } }
        : { animate: visible })}
      transition={transition}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
