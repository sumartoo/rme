import * as React from 'react';
import { cn } from '../cn';

const field = 'flex h-9 w-full rounded-md border bg-card px-3 py-1 text-sm placeholder:text-muted-foreground disabled:opacity-50 aria-[invalid=true]:border-destructive';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(field, className)} {...props} />,
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(field, 'h-auto min-h-20 py-2', className)} {...props} />,
);
Textarea.displayName = 'Textarea';

/** Select bawaan browser (aksesibel & aman CSP); gaya disamakan dengan Input. */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => <select ref={ref} className={cn(field, 'pr-8', className)} {...props} />,
);
Select.displayName = 'Select';

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium', className)} {...props} />;
}

/** Label + kontrol + bantuan/error. `error` dihubungkan via aria-describedby oleh pemanggil (id = `${id}-error`). */
export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p id={`${id}-error`} className="text-xs text-destructive" role="alert">{error}</p>
             : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Saklar on/off berbasis checkbox (aksesibel tanpa JS tambahan). */
export function Switch({ className, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <input type="checkbox" role="switch"
      className={cn('relative h-5 w-9 cursor-pointer appearance-none rounded-full bg-border transition-colors checked:bg-primary',
        'before:absolute before:left-0.5 before:top-0.5 before:size-4 before:rounded-full before:bg-card before:transition-transform checked:before:translate-x-4',
        'disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />
  );
}
