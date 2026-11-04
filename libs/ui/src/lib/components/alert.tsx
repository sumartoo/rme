import * as React from 'react';
import { cn } from '../cn';

export function Alert({ tone = 'info', className, ...props }: React.HTMLAttributes<HTMLDivElement> & { tone?: 'info' | 'error' | 'success' }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'}
      className={cn('rounded-md border px-4 py-3 text-sm',
        tone === 'error' && 'border-destructive/40 bg-destructive/5 text-destructive',
        tone === 'success' && 'border-success/40 bg-success/5',
        tone === 'info' && 'bg-muted', className)} {...props} />
  );
}
