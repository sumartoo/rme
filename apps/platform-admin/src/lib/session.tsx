'use client';
import { createContext, useContext } from 'react';
import type { Me } from './api';

export const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe dipakai di luar layout konsol');
  return me;
}

/** Tampilan menyesuaikan permission; penegakannya tetap di API (PlatformSecurityGuard). */
export const can = (me: Me, permission: string) => me.permissions.includes(permission);
