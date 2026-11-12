// Adapted from react-bits (https://reactbits.dev) MIT
// Source: src/ts-default/Animations/AnimatedContent — the original animates
// via GSAP + ScrollTrigger; this adaptation reimplements the same visual idea
// (slide + fade + optional scale reveal) with framer-motion only, keeps a
// small type-safe prop surface, and respects `prefers-reduced-motion` by
// rendering content immediately without any animation.

import type { HTMLAttributes, ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

// DOM handlers framer-motion redefines (animation/drag callbacks take
// AnimationDefinition, not DOM events) must be omitted or spreading `rest`
// into motion.div is a type conflict.
export interface AnimatedContentProps
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
  /** Travel distance in pixels. */
  distance?: number;
  /** Axis of travel. */
  direction?: 'vertical' | 'horizontal';
  /** Slide in from the negative side (up/left) instead of down/right. */
  reverse?: boolean;
  /** Duration in seconds. */
  duration?: number;
  /** Delay in seconds. */
  delay?: number;
  /** Starting opacity. */
  initialOpacity?: number;
  /** Starting scale (1 = no zoom). */
  scale?: number;
  /** Animate when scrolled into view instead of on mount. */
  inView?: boolean;
}

export function AnimatedContent({
  children,
  distance = 24,
  direction = 'vertical',
  reverse = false,
  duration = 0.5,
  delay = 0,
  initialOpacity = 0,
  scale = 1,
  inView = false,
  className,
  style,
  ...rest
}: AnimatedContentProps) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return (
      <div className={className} style={style} {...rest}>
        {children}
      </div>
    );
  }

  const offset = reverse ? -distance : distance;

  // Plain x/y keys (no computed-key union) so the objects stay assignable to
  // framer-motion's TargetAndTransition.
  const hidden: {
    opacity: number;
    scale: number;
    x?: number;
    y?: number;
  } = { opacity: initialOpacity, scale };
  const visible: {
    opacity: number;
    scale: number;
    x?: number;
    y?: number;
  } = { opacity: 1, scale: 1 };

  if (direction === 'horizontal') {
    hidden.x = offset;
    visible.x = 0;
  } else {
    hidden.y = offset;
    visible.y = 0;
  }
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
