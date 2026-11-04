'use client';
import * as React from 'react';
import { cn } from '../cn';

/**
 * Dialog modal memakai <dialog> bawaan: fokus terkunci, Esc menutup, backdrop — tanpa style inline
 * yang disisipkan runtime (aman untuk CSP bernonce). Dikendalikan lewat prop `open`.
 */
export function Dialog({ open, onClose, title, description, children, className }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: React.ReactNode; className?: string;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const titleId = React.useId();
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby={titleId}
      className={cn('m-auto w-full max-w-md rounded-md border bg-card p-0 text-foreground shadow-lg', className)}>
      <div className="grid gap-4 p-5">
        <div className="grid gap-1">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {children}
      </div>
    </dialog>
  );
}
