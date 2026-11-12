// Adapted from react-bits (https://reactbits.dev) MIT
// Source: src/ts-default/TextAnimations/BlurText — adapted for Ghita Agent:
// imports normalized to `framer-motion`, the raw IntersectionObserver was
// replaced with framer-motion's useInView, and `prefers-reduced-motion`
// renders the text in its final state immediately (no per-word animation).

import {
  useMemo,
  useRef,
  type CSSProperties,
  type ElementType,
  type ReactNode,
  type Ref,
} from 'react';
import { motion, useInView, useReducedMotion, type Transition } from 'framer-motion';

type BlurTextVariant = Record<string, string | number>;

export interface BlurTextProps {
  text: string;
  /** Stagger between words/letters, in milliseconds. */
  delay?: number;
  className?: string;
  style?: CSSProperties;
  animateBy?: 'words' | 'letters';
  direction?: 'top' | 'bottom';
  /** Animate immediately on mount instead of waiting for the element to
   *  scroll into view. */
  startOnMount?: boolean;
  onAnimationComplete?: () => void;
  /** Duration of each keyframe step, in seconds. */
  stepDuration?: number;
  /** Element to render (h1, p, span, ...). Defaults to `p`. */
  as?: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'span' | 'div';
  /** Extra style applied to every word/letter span. Useful for per-span
   *  `background-clip: text` gradients — a gradient on the container does not
   *  participate in the spans' own opacity/filter animation. */
  spanStyle?: CSSProperties;
  /** Extra class applied to every word/letter span. */
  spanClassName?: string;
}

const buildKeyframes = (
  from: BlurTextVariant,
  steps: Array<BlurTextVariant>,
): Record<string, Array<string | number>> => {
  const keys = new Set<string>([...Object.keys(from), ...steps.flatMap((s) => Object.keys(s))]);
  const keyframes: Record<string, Array<string | number>> = {};
  keys.forEach((k) => {
    // Index access can be undefined (noUncheckedIndexedAccess) — coerce so the
    // keyframe tuple stays Array<string | number>.
    keyframes[k] = [from[k] ?? '', ...steps.map((s) => s[k] ?? '')];
  });
  return keyframes;
};

export function BlurText({
  text,
  delay = 200,
  className = '',
  style,
  animateBy = 'words',
  direction = 'top',
  startOnMount = false,
  onAnimationComplete,
  stepDuration = 0.35,
  as = 'p',
  spanStyle,
  spanClassName,
}: BlurTextProps) {
  const elements = animateBy === 'words' ? text.split(' ') : text.split('');
  const ref = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();
  const inView = useInView(ref, { once: true, amount: 0.2 });
  const shouldAnimate = (startOnMount || inView) && !reduceMotion;

  const from: BlurTextVariant = useMemo(
    () =>
      direction === 'top'
        ? { filter: 'blur(10px)', opacity: 0, y: -50 }
        : { filter: 'blur(10px)', opacity: 0, y: 50 },
    [direction],
  );

  const to: Array<BlurTextVariant> = useMemo(
    () => [
      {
        filter: 'blur(5px)',
        opacity: 0.5,
        y: direction === 'top' ? 5 : -5,
      },
      { filter: 'blur(0px)', opacity: 1, y: 0 },
    ],
    [direction],
  );

  // Reduced motion skips straight to the fully revealed state (duration 0).
  const finalState: BlurTextVariant = to[to.length - 1] ?? { opacity: 1, y: 0, filter: 'blur(0px)' };

  const keyframes = useMemo(() => buildKeyframes(from, to), [from, to]);

  const stepCount = to.length + 1;
  const totalDuration = stepDuration * (stepCount - 1);
  const times = Array.from({ length: stepCount }, (_, i) =>
    stepCount === 1 ? 0 : i / (stepCount - 1),
  );

  const Tag = as as ElementType<{
    ref?: Ref<HTMLElement>;
    className?: string;
    style?: CSSProperties;
    children?: ReactNode;
  }>;

  const containerStyle: CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    willChange: shouldAnimate ? 'transform, filter, opacity' : undefined,
    ...style,
  };

  return (
    <Tag ref={ref} className={className} style={containerStyle}>
      {elements.map((segment, index) => {
        const spanTransition: Transition = {
          duration: reduceMotion ? 0 : totalDuration,
          times,
          delay: reduceMotion ? 0 : (index * delay) / 1000,
          ease: 'easeOut',
        };

        return (
          <motion.span
            key={index}
            initial={reduceMotion ? false : from}
            animate={shouldAnimate ? keyframes : reduceMotion ? finalState : from}
            transition={spanTransition}
            onAnimationComplete={index === elements.length - 1 ? onAnimationComplete : undefined}
            style={{
              display: 'inline-block',
              willChange: 'transform, filter, opacity',
              ...spanStyle,
            }}
            className={spanClassName}
          >
            {segment === ' ' ? '\u00A0' : segment}
            {animateBy === 'words' && index < elements.length - 1 ? '\u00A0' : null}
          </motion.span>
        );
      })}
    </Tag>
  );
}
