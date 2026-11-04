import * as React from 'react';
import { cn } from '../cn';

type Div = React.HTMLAttributes<HTMLDivElement>;
export const Card = ({ className, ...p }: Div) => <div className={cn('rounded-md border bg-card shadow-sm', className)} {...p} />;
export const CardHeader = ({ className, ...p }: Div) => <div className={cn('grid gap-1 p-5 pb-3', className)} {...p} />;
export const CardTitle = ({ className, ...p }: React.HTMLAttributes<HTMLHeadingElement>) =>
  <h2 className={cn('text-base font-semibold', className)} {...p} />;
export const CardDescription = ({ className, ...p }: React.HTMLAttributes<HTMLParagraphElement>) =>
  <p className={cn('text-sm text-muted-foreground', className)} {...p} />;
export const CardContent = ({ className, ...p }: Div) => <div className={cn('p-5 pt-0', className)} {...p} />;
export const CardFooter = ({ className, ...p }: Div) => <div className={cn('flex items-center gap-2 p-5 pt-0', className)} {...p} />;
