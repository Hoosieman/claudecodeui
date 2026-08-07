import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Brain } from 'lucide-react';

import type { ProviderModelOption } from '../../../../types/app';
import { DEFAULT_EFFORT_VALUE } from '../../constants/providerEffort';
import { useComposerMenuAnchor } from '../../hooks/useComposerMenuAnchor';

import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSurface,
} from './ComposerMenuPrimitives';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

interface ComposerEffortMenuProps {
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the button. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
}

/**
 * Reasoning-effort picker. Icon-only and sized to match the permission-mode
 * button beside it, so the composer's trailing controls read as one row of
 * equal-weight toggles.
 */
export default function ComposerEffortMenu({
  effort,
  effortOptions,
  onSelectEffort,
}: ComposerEffortMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const resolvedEffortOptions = useMemo<EffortOption[]>(
    () => (effortOptions.length > 0 ? [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions] : []),
    [effortOptions],
  );

  if (resolvedEffortOptions.length === 0) {
    return null;
  }

  const effortLabel = effort === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : effort;
  const heading = t('composer.reasoning', { defaultValue: 'Reasoning' });
  // The icon alone cannot say which effort is active, so the current value
  // rides in the tooltip the way the mode button leans on its title.
  const triggerTitle = t('composer.effortMenuTitle', {
    effort: effortLabel,
    defaultValue: 'Reasoning: {{effort}}',
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/50 text-muted-foreground transition-colors hover:bg-muted"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={triggerTitle}
        title={triggerTitle}
      >
        <Brain className="h-4 w-4" />
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={heading}>
          <ComposerMenuHeading>{heading}</ComposerMenuHeading>
          {resolvedEffortOptions.map((option) => (
            <ComposerMenuItem
              key={option.value}
              label={option.value === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : option.value}
              description={option.description}
              isSelected={option.value === effort}
              onSelect={() => {
                onSelectEffort(option.value);
                setIsOpen(false);
              }}
              className="capitalize"
            />
          ))}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}
