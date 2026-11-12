// Adapted from react-bits (https://reactbits.dev) MIT
// Source: src/ts-default/TextAnimations/ShinyText — adapted for Ghita Agent:
// the companion .css file is inlined as style props (Tailwind-friendly, no
// extra stylesheet), imports normalized to `framer-motion`, and the shine
// loop pauses entirely under `prefers-reduced-motion`.

import { useEffect, useRef, type CSSProperties } from 'react';
import { motion, useAnimationFrame, useMotionValue, useReducedMotion, useTransform } from 'framer-motion';

export interface ShinyTextProps {
  text: string;
  /** Disable the shine loop and render static text. */
  disabled?: boolean;
  /** Seconds for one shine sweep across the text. */
  speed?: number;
  /** Base text color (CSS color or var()). */
  color?: string;
  /** Highlight color of the sweeping shine. */
  shineColor?: string;
  /** Gradient angle in degrees. */
  spread?: number;
  /** Extra seconds between sweeps (0 = continuous). */
  delay?: number;
  className?: string;
  style?: CSSProperties;
}

export function ShinyText({
  text,
  disabled = false,
  speed = 4,
  color = 'var(--text-secondary, #94a3b8)',
  shineColor = 'var(--text-primary, #e2e8f0)',
  spread = 120,
  delay = 0,
  className = '',
  style,
}: ShinyTextProps) {
  const reduceMotion = useReducedMotion();
  const paused = disabled || reduceMotion;
  const progress = useMotionValue(0);
  const elapsedRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);

  const animationDuration = speed * 1000;
  const delayDuration = delay * 1000;

  useAnimationFrame((time) => {
    if (paused) {
      lastTimeRef.current = null;
      return;
    }
    if (lastTimeRef.current === null) {
      lastTimeRef.current = time;
      return;
    }

    const deltaTime = time - lastTimeRef.current;
    lastTimeRef.current = time;
    elapsedRef.current += deltaTime;

    const cycleDuration = animationDuration + delayDuration;
    const cycleTime = elapsedRef.current % cycleDuration;

    if (cycleTime < animationDuration) {
      // Sweep 0 -> 100 (progress 100 maps the shine off the left edge).
      progress.set((cycleTime / animationDuration) * 100);
    } else {
      // Hold between sweeps with the shine off-screen.
      progress.set(100);
    }
  });

  useEffect(() => {
    elapsedRef.current = 0;
    lastTimeRef.current = null;
    progress.set(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed, delay, paused]);

  // p=0 -> shine off right, p=100 -> shine off left.
  const backgroundPosition = useTransform(progress, (p) => `${150 - p * 2}% center`);

  const gradientStyle: CSSProperties = {
    backgroundImage: `linear-gradient(${spread}deg, ${color} 0%, ${color} 35%, ${shineColor} 50%, ${color} 65%, ${color} 100%)`,
    // 200% width + repeat: the base color fills the gaps so the text never
    // loses coverage while the shine sweeps via background-position.
    backgroundSize: '200% auto',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    display: 'inline-block',
  };

  if (paused) {
    // Static, fully legible text — no rAF loop, no background motion.
    return (
      <span className={className} style={{ ...gradientStyle, backgroundPosition: '125% center', ...style }}>
        {text}
      </span>
    );
  }

  return (
    <motion.span
      className={className}
      style={{ ...gradientStyle, backgroundPosition, ...style }}
    >
      {text}
    </motion.span>
  );
}
