import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import { Tooltip } from '../../../../shared/view/ui';
import type { UsageLimitWindow } from '../../hooks/useClaudeUsageLimits';

type UsageLimitBarsProps = {
  session: UsageLimitWindow | null;
  weekly: UsageLimitWindow | null;
};

type UsageBarProps = {
  label: string;
  title: string;
  window: UsageLimitWindow | null;
};

/**
 * Past three quarters the window stops being background information, so the
 * fill warms up to amber and then red rather than staying brand-coloured.
 */
const fillClassFor = (utilization: number): string => {
  if (utilization >= 90) {
    return 'bg-red-500';
  }

  if (utilization >= 75) {
    return 'bg-amber-500';
  }

  return 'bg-primary';
};

const formatResetDistance = (resetsAt: string | null): string | null => {
  if (!resetsAt) {
    return null;
  }

  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) {
    return null;
  }

  const minutes = Math.round((target - Date.now()) / 60_000);
  if (minutes <= 0) {
    return 'now';
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainderMinutes = minutes % 60;
    return remainderMinutes ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours ? `${days}d ${remainderHours}h` : `${days}d`;
};

function UsageBar({ label, title, window }: UsageBarProps) {
  const utilization = window?.utilization ?? null;
  const percent = utilization === null ? 0 : Math.round(utilization);
  const resetDistance = formatResetDistance(window?.resetsAt ?? null);
  const tooltip = [
    `${title}: ${utilization === null ? 'unknown' : `${percent}% used`}`,
    resetDistance ? `resets in ${resetDistance}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Tooltip content={tooltip} position="top">
      <div
        className="flex items-center gap-1.5"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={utilization === null ? undefined : percent}
        aria-valuetext={utilization === null ? 'Unknown' : `${percent}%`}
      >
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          {label}
        </span>
        <span className="h-1.5 w-12 overflow-hidden rounded-full bg-foreground/10 sm:w-16">
          <span
            className={cn(
              'block h-full rounded-full transition-[width,background-color] duration-500 ease-out',
              fillClassFor(percent),
            )}
            style={{ width: `${Math.max(utilization === null ? 0 : 2, percent)}%` }}
          />
        </span>
        <span className="w-7 text-right text-[10px] font-medium tabular-nums text-muted-foreground/80">
          {utilization === null ? '—' : `${percent}%`}
        </span>
      </div>
    </Tooltip>
  );
}

/**
 * The composer's two subscription meters: the 5-hour session window and the
 * 7-day weekly window, in the slot that used to hold the keyboard hints.
 * Renders nothing until real numbers arrive, so an API-key login or an
 * unreachable endpoint leaves the footer clean instead of showing empty bars.
 */
export default function UsageLimitBars({ session, weekly }: UsageLimitBarsProps) {
  const { t } = useTranslation('chat');

  if (session?.utilization == null && weekly?.utilization == null) {
    return null;
  }

  return (
    <div className="hidden min-w-0 items-center gap-2.5 md:flex lg:gap-3.5">
      <UsageBar
        label={t('input.usageLimits.sessionLabel', { defaultValue: 'Session' })}
        title={t('input.usageLimits.sessionTitle', { defaultValue: 'Session limit (5h)' })}
        window={session}
      />
      <UsageBar
        label={t('input.usageLimits.weeklyLabel', { defaultValue: 'Week' })}
        title={t('input.usageLimits.weeklyTitle', { defaultValue: 'Weekly limit (7d)' })}
        window={weekly}
      />
    </div>
  );
}
