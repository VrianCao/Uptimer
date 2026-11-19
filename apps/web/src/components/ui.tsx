import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react';

import { useI18n } from '../app/I18nContext';
import { useTheme } from '../app/ThemeContext';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export const PANEL_BASE_CLASS =
  'ui-panel rounded-xl border border-slate-200/80 dark:border-slate-700/80';

export const PANEL_INTERACTIVE_CLASS =
  'ui-panel-hover hover:border-slate-300/80 dark:hover:border-slate-600';

export const TABLE_ACTION_BUTTON_CLASS =
  'inline-flex items-center justify-center rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none';

export const MODAL_OVERLAY_CLASS = 'ui-modal-overlay animate-fade-in';

export const MODAL_PANEL_CLASS = 'ui-modal-panel animate-slide-up';

export const INPUT_CLASS = cn(
  'ui-input',
  'text-base',
  'bg-white/90 dark:bg-slate-700/80',
  'border-slate-200 dark:border-slate-600',
  'placeholder:text-slate-400 dark:placeholder:text-slate-500',
);

export const SELECT_CLASS = cn(
  'ui-select',
  'text-base',
  'bg-white/90 dark:bg-slate-700/80',
  'border-slate-200 dark:border-slate-600',
);

export const TEXTAREA_CLASS = cn(
  'ui-textarea',
  'text-base',
  'bg-white/90 dark:bg-slate-700/80',
  'border-slate-200 dark:border-slate-600',
  'placeholder:text-slate-400 dark:placeholder:text-slate-500',
);

export const FIELD_LABEL_CLASS = 'ui-label text-sm font-medium text-slate-700 dark:text-slate-300';

export const FIELD_HELP_CLASS = 'ui-help text-xs text-slate-500 dark:text-slate-400';

interface BadgeProps {
  variant: 'up' | 'down' | 'maintenance' | 'paused' | 'unknown' | 'info';
  children: ReactNode;
  size?: 'sm' | 'md';
}

const badgeStyles = {
  up: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/30',
  down: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/30',
  maintenance:
    'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-400/30',
  paused:
    'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/30',
  unknown:
    'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-500/10 dark:text-slate-300 dark:ring-slate-400/30',
  info: 'bg-slate-100 text-slate-700 ring-slate-500/15 dark:bg-slate-500/10 dark:text-slate-300 dark:ring-slate-400/25',
};

export function Badge({ variant, children, size = 'sm' }: BadgeProps) {
  const sizeClass = size === 'sm' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-medium ring-1 ring-inset',
        'tracking-wide',
        badgeStyles[variant],
        sizeClass,
      )}
    >
      {children}
    </span>
  );
}

interface StatusDotProps {
  status: 'up' | 'down' | 'maintenance' | 'paused' | 'unknown';
  pulse?: boolean;
  size?: 'sm' | 'md';
}

const dotColors = {
  up: 'bg-emerald-500 dark:bg-emerald-400',
  down: 'bg-red-500 dark:bg-red-400',
  maintenance: 'bg-blue-500 dark:bg-blue-400',
  paused: 'bg-amber-500 dark:bg-amber-400',
  unknown: 'bg-slate-400 dark:bg-slate-500',
};

export function StatusDot({ status, pulse = false, size = 'md' }: StatusDotProps) {
  const dotSize = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';

  return (
    <span className={cn('relative inline-flex', dotSize)}>
      {pulse && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75',
            dotColors[status],
          )}
        />
      )}
      <span
        className={cn(
          'relative inline-flex h-full w-full rounded-full shadow-[0_0_0_2px_rgba(255,255,255,0.6)] dark:shadow-none',
          dotColors[status],
        )}
      />
    </span>
  );
}

interface CardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
  onPrepare?: (() => void) | undefined;
}

export function Card({ children, className = '', hover = false, onClick, onPrepare }: CardProps) {
  const clickProps = onClick
    ? {
        onClick,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            onClick();
          }
        },
        role: 'button',
        tabIndex: 0,
      }
    : {};

  return (
    <div
      className={cn(
        PANEL_BASE_CLASS,
        hover && PANEL_INTERACTIVE_CLASS,
        hover && onClick && 'cursor-pointer',
        'transition-base',
        className,
      )}
      {...clickProps}
      onPointerEnter={onPrepare}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onPrepare?.();
      }}
    >
      {children}
    </div>
  );
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  type?: 'button' | 'submit' | 'reset';
}

const buttonVariants = {
  primary:
    'bg-slate-900 text-white hover:bg-slate-800 active:bg-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white shadow-sm',
  secondary:
    'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600 dark:hover:bg-slate-700 shadow-sm',
  ghost:
    'text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800',
  danger:
    'bg-red-600 text-white hover:bg-red-700 active:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600 shadow-sm',
};

const buttonSizes = {
  sm: 'h-9 px-3.5 text-sm',
  md: 'h-10 px-4 text-base',
  lg: 'h-11 px-5 text-base',
};

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  type = 'button',
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium',
        'transition-colors duration-150 focus-visible:outline-none',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

const SunIcon = () => (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
    />
  </svg>
);

const MoonIcon = () => (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
    />
  </svg>
);

const SystemIcon = () => (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
    />
  </svg>
);

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();

  const cycleTheme = () => {
    if (theme === 'system') setTheme('light');
    else if (theme === 'light') setTheme('dark');
    else setTheme('system');
  };

  const themeLabel = t(`theme.${theme}`);
  const title = t('theme.title', { value: themeLabel });

  return (
    <button
      onClick={cycleTheme}
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-lg',
        'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
        'dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100',
        'transition-colors',
      )}
      title={title}
      aria-label={title}
    >
      {theme === 'light' && <SunIcon />}
      {theme === 'dark' && <MoonIcon />}
      {theme === 'system' && <SystemIcon />}
    </button>
  );
}
