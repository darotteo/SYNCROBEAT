import React, { useEffect } from 'react';
import { X } from 'lucide-react';

function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

export const Card: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cx('brand-panel rounded-3xl p-5 sm:p-6', className)} {...props} />
);

export const SectionLabel: React.FC<{ children: React.ReactNode; right?: React.ReactNode; className?: string }> = ({
  children,
  right,
  className,
}) => (
  <div className={cx('flex items-center justify-between gap-3 mb-3', className)}>
    <span className="text-xs font-medium uppercase tracking-[0.12em] text-neutral-500">{children}</span>
    {right}
  </div>
);

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'brand-primary text-black',
  secondary: 'bg-surface-2 text-neutral-200 hover:bg-surface-3 hover:text-white',
  ghost: 'text-neutral-400 hover:text-white hover:bg-surface-2',
  danger: 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-xs rounded-xl gap-1.5',
  md: 'h-11 px-4 text-sm rounded-2xl gap-2',
  lg: 'h-14 px-6 text-base rounded-2xl gap-2.5',
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button: React.FC<ButtonProps> = ({ variant = 'secondary', size = 'md', className, type = 'button', ...props }) => (
  <button
    type={type}
    className={cx(
      'inline-flex items-center justify-center font-medium transition-colors active:scale-[0.97] disabled:opacity-35 disabled:pointer-events-none select-none',
      VARIANTS[variant],
      SIZES[size],
      className
    )}
    {...props}
  />
);

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export const IconButton: React.FC<IconButtonProps> = ({ label, active, className, type = 'button', ...props }) => (
  <button
    type={type}
    aria-label={label}
    title={label}
    className={cx(
      'inline-flex items-center justify-center w-10 h-10 rounded-xl transition-colors active:scale-95 disabled:opacity-35 disabled:pointer-events-none',
      active ? 'bg-brand text-black' : 'text-neutral-400 hover:text-white hover:bg-surface-2',
      className
    )}
    {...props}
  />
);

interface SegmentedProps<T extends string | number> {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'md';
}

export function Segmented<T extends string | number>({ value, options, onChange, disabled, className, size = 'md' }: SegmentedProps<T>) {
  return (
    <div className={cx('flex p-1 gap-1 rounded-2xl bg-surface-2', disabled && 'opacity-40 pointer-events-none', className)}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            title={opt.title}
            aria-pressed={selected}
            onClick={() => onChange(opt.value)}
            className={cx(
              'flex-1 min-w-0 rounded-xl font-medium transition-colors truncate',
              size === 'sm' ? 'h-8 px-2 text-xs' : 'h-10 px-3 text-sm',
              selected ? 'bg-brand text-black shadow-sm' : 'text-neutral-400 hover:text-white'
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export const Toggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string }> = ({
  checked,
  onChange,
  label,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className={cx(
      'relative w-12 h-7 rounded-full transition-colors shrink-0',
      checked ? 'bg-accent' : 'bg-surface-3'
    )}
  >
    <span
      className={cx(
        'absolute top-1 left-1 w-5 h-5 rounded-full transition-transform',
        checked ? 'translate-x-5 bg-black' : 'bg-neutral-400'
      )}
    />
  </button>
);

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export const Modal: React.FC<ModalProps> = ({ open, onClose, title, subtitle, children, footer, size = 'md' }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={cx(
          'brand-panel w-full rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl flex flex-col max-h-[92vh]',
          size === 'sm' ? 'sm:max-w-sm' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg'
        )}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
          <div className="min-w-0">
            <h2 className="text-xl font-light tracking-tight text-white">{title}</h2>
            {subtitle && <p className="text-sm text-neutral-500 mt-0.5">{subtitle}</p>}
          </div>
          <IconButton label="Cerrar" onClick={onClose} className="-mr-2 -mt-1">
            <X className="w-5 h-5" />
          </IconButton>
        </div>
        <div className="px-6 pb-6 overflow-y-auto flex flex-col gap-5">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-line flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
};

export const inputClass =
  'w-full h-11 px-4 bg-surface-2 rounded-2xl text-sm text-white placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-600 transition-shadow';

export { cx };
