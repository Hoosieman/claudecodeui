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

interface ComposerPetProps {
  /** True while the agent is streaming a response. */
  isBusy?: boolean;
  /** True when there is text in the composer. */
  isTyping?: boolean;
  className?: string;
}

export default function ComposerPet({
  isBusy = false,
  isTyping = false,
  className,
}: ComposerPetProps) {
  const [remark, setRemark] = useState<string | null>(null);
  const remarkIndex = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mood: ComposerPetMood = isBusy ? 'busy' : isTyping ? 'typing' : 'idle';

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const poke = useCallback(() => {
    // Cycle rather than randomise, so repeated pokes never repeat immediately.
    const next = REMARKS[remarkIndex.current % REMARKS.length];
    remarkIndex.current += 1;
    setRemark(next);

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRemark(null), REMARK_MS);
  }, []);

  return (
    <div
      className={['composer-pet pointer-events-none absolute right-2 top-1 z-10', className]
        .filter(Boolean)
        .join(' ')}
      data-mood={mood}
    >
      {remark && (
        <div
          role="status"
          className="composer-pet-bubble pointer-events-none absolute right-full top-1/2 mr-1.5 hidden -translate-y-1/2 whitespace-nowrap rounded-md border border-border/40 bg-popover/95 px-2 py-1 text-[10px] leading-none text-muted-foreground shadow-sm backdrop-blur-sm sm:block"
        >
          {remark}
        </div>
      )}

      <button
        // Inside a <form>: without type="button" this submits the message.
        type="button"
        onClick={poke}
        aria-label="Kraken, a legendary octopus. Poke for an unsolicited opinion."
        title="Kraken ★★★★★"
        className="composer-pet-hit pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/60 outline-none transition-colors hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-primary/40"
      >
        <svg
          viewBox="0 0 24 24"
          className="composer-pet-body h-[22px] w-[22px] overflow-visible"
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
            <path className="composer-pet-arm" style={{ animationDelay: '0ms' }} d="M6 15c-.9 1.6-1.4 2.7-1.2 4" />
            <path className="composer-pet-arm" style={{ animationDelay: '90ms' }} d="M9 16.4c-.5 1.8-.8 3-.4 4.1" />
            <path className="composer-pet-arm" style={{ animationDelay: '180ms' }} d="M12 16.8v4.2" />
            <path className="composer-pet-arm" style={{ animationDelay: '270ms' }} d="M15 16.4c.5 1.8.8 3 .4 4.1" />
            <path className="composer-pet-arm" style={{ animationDelay: '360ms' }} d="M18 15c.9 1.6 1.4 2.7 1.2 4" />
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
    </div>
  );
}
