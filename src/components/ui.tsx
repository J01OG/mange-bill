import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white active:bg-brand-900 disabled:bg-gray-400',
  secondary: 'bg-white text-gray-900 border border-gray-300 active:bg-gray-100 disabled:text-gray-400',
  danger: 'bg-red-600 text-white active:bg-red-800 disabled:bg-gray-400',
  ghost: 'bg-transparent text-brand-800 active:bg-brand-50',
};

/** Button look, also usable on links: <Link className={buttonClass()}>. */
export function buttonClass(variant: Variant = 'primary', extra = '') {
  return `inline-flex min-h-12 items-center justify-center rounded-xl px-4 text-base font-semibold transition-colors disabled:cursor-not-allowed ${variants[variant]} ${extra}`;
}

export function Button({
  variant = 'primary',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button className={buttonClass(variant, className)} {...rest} />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

const inputCls =
  'block w-full min-h-12 rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 focus:border-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-100';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-200 ${className}`}>{children}</div>;
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const cls = {
    error: 'bg-red-50 text-red-800 ring-red-200',
    success: 'bg-brand-50 text-brand-900 ring-brand-100',
    info: 'bg-blue-50 text-blue-900 ring-blue-200',
  }[kind];
  return <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded-xl p-3 text-sm ring-1 ${cls}`}>{children}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 p-8 text-gray-600">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-700 border-t-transparent" />
      {label}
    </div>
  );
}

/** Simple bottom-sheet style dialog that works well on phones. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button aria-label="Close" className="h-10 w-10 rounded-full text-2xl text-gray-500" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
