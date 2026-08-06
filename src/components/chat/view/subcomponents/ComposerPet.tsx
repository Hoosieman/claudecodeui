import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Kraken — a legendary shiny octopus that lives in the corner of the composer.
 *
 * Mirrors the terminal buddy in ~/.claude-buddy: same species, same `@` eyes,
 * same blink cadence (its frameSequence is [0,0,0,0,3] -- idle, idle, idle,
 * idle, blink), and the faint shimmer that comes with being shiny.
 *
 * Purely decorative and self-contained: no network, no persisted state. It
 * reacts to what the composer is already doing.
 *
 *   idle    gentle bob, tentacles drift, blinks every ~5s
 *   typing  perks up and watches the cursor
 *   busy    agent is streaming -- tentacles work faster
 *   poked   click it; it says something (SNARK: 100)
 *
 * On top of the mood animations, each keystroke in the composer taps one
 * tentacle -- see `typingPulse` -- so he looks like he is typing along.
 *
 * Positioning is the caller's job -- this renders a plain relative box so the
 * composer can hang it in the gutter beside the input.
 */

export type ComposerPetMood = 'idle' | 'typing' | 'busy';

/** Kraken has strong opinions and no filter. */
const REMARKS: readonly string[] = [
  'started the rebase already',
  'that variable name is a war crime',
  'ship it, I guess',
  'I have seen this bug before',
  'eight arms, zero patience',
  'have you tried reading the diff',
  'naming things is my whole personality',
  'this compiles. emotionally, anyway',
];

const REMARK_MS = 2600;

/** How many tentacles are drawn -- the keystroke tap cycles through them. */
const ARM_COUNT = 5;

/** One keypress worth of tentacle. Short enough to keep up with fast typing. */
const TAP_MS = 260;

interface ComposerPetProps {
  /** True while the agent is streaming a response. */
  isBusy?: boolean;
  /** True when there is text in the composer. */
  isTyping?: boolean;
  /**
   * Monotonic counter incremented once per keystroke in the composer. Each
   * increment taps the next tentacle in rotation, so typing runs left-to-right
   * across his arms. The value itself is meaningless -- only that it changed.
   */
  typingPulse?: number;
  className?: string;
}

export default function ComposerPet({
  isBusy = false,
  isTyping = false,
  typingPulse = 0,
  className,
}: ComposerPetProps) {
  const [remark, setRemark] = useState<string | null>(null);
  const remarkIndex = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tentacle tapping. Driven imperatively rather than by CSS class toggling:
  // restarting a CSS animation on an element that is already running one needs
  // a reflow hack, and at typing speed the same arm can be re-tapped before its
  // previous tap finishes. Web Animations gives a clean one-shot per keystroke.
  const armRefs = useRef<(SVGPathElement | null)[]>([]);
  const armAnims = useRef<(Animation | null)[]>([]);
  const nextArm = useRef(0);

  const mood: ComposerPetMood = isBusy ? 'busy' : isTyping ? 'typing' : 'idle';

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    // 0 is the initial value, not a keystroke -- don't tap on mount.
    if (!typingPulse) return;
    // The global prefers-reduced-motion rule can't reach a script-generated
    // animation, so honour it here explicitly.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const index = nextArm.current % ARM_COUNT;
    nextArm.current += 1;

    const arm = armRefs.current[index];
    if (!arm?.animate) return;

    // Cancel the in-flight tap on this arm first: without it, rapid typing
    // stacks animations on one element and the newest fights the leftovers.
    armAnims.current[index]?.cancel();

    // fill defaults to 'none', so when this finishes the arm falls back to its
    // idle CSS drift on its own. Script-generated animations outrank CSS ones
    // in the cascade, so this wins for its duration without touching the class.
    armAnims.current[index] = arm.animate(
      [
        { transform: 'translateY(0) scaleY(1) rotate(0deg)' },
        { transform: 'translateY(1.6px) scaleY(1.34) rotate(-4deg)', offset: 0.45 },
        { transform: 'translateY(0) scaleY(1) rotate(0deg)' },
      ],
      { duration: TAP_MS, easing: 'ease-out' },
    );
  }, [typingPulse]);

  const poke = useCallback(() => {
    // Cycle rather than randomise, so repeated pokes never repeat immediately.
    const next = REMARKS[remarkIndex.current % REMARKS.length];
    remarkIndex.current += 1;
    setRemark(next);

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRemark(null), REMARK_MS);
  }, []);

  return (
    // The outer box carries whatever positioning the caller supplies. It must
    // NOT set its own `position` utility: Tailwind emits `.relative` after
    // `.absolute`, so a hardcoded `relative` here would beat an `absolute`
    // passed in via className regardless of the order they appear in the
    // attribute -- leaving the pet in normal flow with a percentage offset.
    // The inner box is the positioning context for the speech bubble.
    <div
      className={['composer-pet pointer-events-none', className].filter(Boolean).join(' ')}
      data-mood={mood}
    >
      {/* Separate element for the swim: the outer box owns -translate-y-1/2,
          and animating transform there would fight it. */}
      <div className="composer-pet-swim relative">
      {remark && (
        <div
          role="status"
          // w-max is load-bearing: an absolutely-positioned box shrink-to-fits
          // against its containing block, so without it the bubble wraps to
          // the pet's own width instead of using max-w-52.
          className="composer-pet-bubble pointer-events-none absolute bottom-full left-1/2 mb-1 w-max max-w-52 -translate-x-1/2 whitespace-normal rounded-lg border border-border/40 bg-popover/95 px-2.5 py-1.5 text-center text-[11px] leading-snug text-muted-foreground shadow-sm backdrop-blur-sm"
        >
          {remark}
        </div>
      )}

      <button
        // Rendered inside the composer <form>: without type="button" this
        // would submit the message on every poke.
        type="button"
        onClick={poke}
        aria-label="Kraken, a legendary octopus. Poke for an unsolicited opinion."
        // No `title`: the native tooltip would race the nameplate below and
        // show the same thing twice.
        className="composer-pet-hit pointer-events-auto flex h-[104px] w-[104px] items-center justify-center rounded-2xl text-muted-foreground/50 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-primary/40"
      >
        <svg
          viewBox="0 0 24 24"
          className="composer-pet-body h-[96px] w-[96px] overflow-visible"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            {/* "shiny": legendary companions shimmer, more visibly in dark mode. */}
            <linearGradient id="kraken-shine" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.95" />
              <stop offset="45%" stopColor="currentColor" stopOpacity="0.55" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.95" />
            </linearGradient>
          </defs>

          <g className="composer-pet-tentacles" stroke="url(#kraken-shine)" strokeWidth="1.6" strokeLinecap="round">
            <path ref={(el) => { armRefs.current[0] = el; }} className="composer-pet-arm" style={{ animationDelay: '0ms' }} d="M6 15c-.9 1.6-1.4 2.7-1.2 4" />
            <path ref={(el) => { armRefs.current[1] = el; }} className="composer-pet-arm" style={{ animationDelay: '90ms' }} d="M9 16.4c-.5 1.8-.8 3-.4 4.1" />
            <path ref={(el) => { armRefs.current[2] = el; }} className="composer-pet-arm" style={{ animationDelay: '180ms' }} d="M12 16.8v4.2" />
            <path ref={(el) => { armRefs.current[3] = el; }} className="composer-pet-arm" style={{ animationDelay: '270ms' }} d="M15 16.4c.5 1.8.8 3 .4 4.1" />
            <path ref={(el) => { armRefs.current[4] = el; }} className="composer-pet-arm" style={{ animationDelay: '360ms' }} d="M18 15c.9 1.6 1.4 2.7 1.2 4" />
          </g>

          {/* Mantle */}
          <path
            className="composer-pet-head"
            d="M12 3.4c4 0 6.6 2.8 6.6 6.4 0 3.2-2 5.4-2 6.6 0 .5-.5.8-1.2.8H8.6c-.7 0-1.2-.3-1.2-.8 0-1.2-2-3.4-2-6.6C5.4 6.2 8 3.4 12 3.4Z"
            fill="url(#kraken-shine)"
          />

          {/* Eyes -- the `@` of ~(@@)~ */}
          <g className="composer-pet-eyes">
            <circle cx="9.6" cy="10" r="2.05" className="fill-background" />
            <circle cx="14.4" cy="10" r="2.05" className="fill-background" />
            <circle cx="9.6" cy="10" r="1.0" fill="currentColor" />
            <circle cx="14.4" cy="10" r="1.0" fill="currentColor" />
          </g>
        </svg>
      </button>

      {/* Must follow the button in the DOM: the reveal is a sibling selector
          (.composer-pet-hit:hover ~ .composer-pet-nameplate), which can only
          look forwards. w-max because an absolutely positioned box otherwise
          shrink-to-fits against its containing block. */}
      <div
        aria-hidden="true"
        className="composer-pet-nameplate pointer-events-none absolute left-1/2 top-full mt-1 w-max -translate-x-1/2 rounded-md border border-primary/30 bg-popover/95 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary shadow-sm backdrop-blur-sm"
      >
        Kraken
      </div>
      </div>
    </div>
  );
}
