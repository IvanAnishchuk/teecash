"use client";

/**
 * What the signed in user holds.
 *
 * Every screen needs the same three things:
 *
 * - the Privy user identifier
 * - the notes of that user
 * - the deposits of that user
 *
 * This hook reads them from IndexedDB. It reloads them on demand.
 *
 * The records never reach a server. `lib/notes.ts` explains why.
 */

import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import { balanceOf, depositsOf, notesOf } from "./notes";
import type { Deposit, Note } from "./notes";

export interface Vault {
  ready: boolean;
  userId?: string;
  notes: Note[];
  deposits: Deposit[];
  /** The sum of every claimed note. */
  balance: bigint;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useVault(): Vault {
  const { ready, authenticated, user } = usePrivy();
  const [notes, setNotes] = useState<Note[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [loading, setLoading] = useState(true);

  const userId = authenticated ? user?.id : undefined;

  const reload = useCallback(async () => {
    if (!userId) {
      setNotes([]);
      setDeposits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [found, made] = await Promise.all([notesOf(userId), depositsOf(userId)]);
      setNotes(found);
      setDeposits(made.sort((a, b) => b.createdAt - a.createdAt));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ready, userId, notes, deposits, balance: balanceOf(notes), loading, reload };
}
