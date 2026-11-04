'use client';
import { createContext, useContext } from 'react';
import type { AuthSession, Me } from './api';

export interface Session { auth: AuthSession; me: Me }
export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession dipakai di luar layout admin');
  return s;
}

/** Tampilan menyesuaikan permission; penegakannya tetap di API (SecurityGuard). */
export const can = (s: Session, permission: string) => s.me.permissions.includes(permission);

/** Langkah sesudah login: MFA dulu bila role mewajibkan, lalu area admin. */
export const nextStep = (a: AuthSession) => (a.mfaRequired && !a.mfaVerified ? '/mfa' : '/admin');
