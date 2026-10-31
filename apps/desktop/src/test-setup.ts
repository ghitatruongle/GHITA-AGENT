import '@testing-library/jest-dom';

/**
 * happy-dom's Web Animations implementation rejects the `finished` promise
 * when `Animation.cancel()` is called. framer-motion (motion-dom ≥ 12.42)
 * stops animations during unmount, so render tests surfaced ten unhandled
 * `AbortError: The animation was canceled` rejections. A neutral stub keeps
 * animation teardown silent in tests — real animations are irrelevant to
 * what these suites assert.
 */
if (typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function') {
  const createAnimationStub = (): Animation =>
    ({
      cancel: () => {},
      finish: () => {},
      play: () => {},
      pause: () => {},
      reverse: () => {},
      updatePlaybackRate: () => {},
      persist: () => {},
      commitStyles: () => {},
      playState: 'idle',
      pending: false,
      playbackRate: 1,
      startTime: null,
      currentTime: 0,
      effect: null,
      id: '',
      onfinish: null,
      oncancel: null,
      replaceState: 'active',
      finished: Promise.resolve(),
      ready: Promise.resolve(),
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }) as unknown as Animation;

  Element.prototype.animate = function animate(): Animation {
    return createAnimationStub();
  } as typeof Element.prototype.animate;
}
