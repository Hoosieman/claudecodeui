import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Cpu } from 'lucide-react';

import type { ProviderModelOption } from '../../../../types/app';
import { useComposerMenuAnchor } from '../../hooks/useComposerMenuAnchor';

import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSurface,
} from './ComposerMenuPrimitives';

interface ComposerModelMenuProps {
  model: string;
  /** Model catalog for the active provider; empty hides the button. */
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
}

/**
 * Model picker. Icon-only and sized to match the permission-mode button beside
 * it. Reasoning effort lives in its own trigger — see ComposerEffortMenu.
 */
export default function ComposerModelMenu({
  model,
  modelOptions,
  onSelectModel,
  modelsLoading,
}: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.value === model) ?? null,
    [model, modelOptions],
  );

  if (modelOptions.length === 0 && !modelsLoading) {
    return null;
  }

  const modelLabel = selectedModelOption?.label || model;
  const heading = t('composer.model', { defaultValue: 'Model' });
  // The icon alone cannot say which model is active, so the current value rides
  // in the tooltip the way the mode button leans on its title.
  const triggerTitle = t('composer.modelMenuTitle', {
    model: modelLabel,
    defaultValue: 'Model: {{model}}',
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
        <Cpu className="h-4 w-4" />
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={heading}>
          <ComposerMenuHeading>{heading}</ComposerMenuHeading>
          {modelOptions.length === 0 && modelsLoading && (
            <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
              {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
            </p>
          )}
          {modelOptions.map((option) => (
            <ComposerMenuItem
              key={option.value}
              label={option.label || option.value}
              isSelected={option.value === model}
              onSelect={() => {
                onSelectModel(option.value);
                setIsOpen(false);
              }}
            />
          ))}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}
