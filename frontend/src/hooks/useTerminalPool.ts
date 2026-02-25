import { useRef, useState, useEffect, useCallback } from 'react';
import type { SessionTarget } from '../types';

export interface PoolEntry {
  key: string; // "containerId-sessionName-windowIndex"
  containerId: string;
  sessionName: string;
  windowIndex: number;
  lastAccessedAt: number;
}

export interface UseTerminalPoolResult {
  entries: PoolEntry[];
  ensure: (target: SessionTarget) => string;
  touch: (key: string) => void;
  evict: (key: string) => void;
  setActiveKey: (key: string | null) => void;
}

function makeKey(target: SessionTarget): string {
  // Key by container+session only — the Terminal component handles window
  // switching via SELECT_WINDOW control messages, so we don't need a
  // separate pool entry per window.
  return `${target.containerId}-${target.sessionName}`;
}

export function useTerminalPool({
  maxSize = 8,
  idleTimeoutMs = 60_000,
}: {
  maxSize?: number;
  idleTimeoutMs?: number;
} = {}): UseTerminalPoolResult {
  const [entries, setEntries] = useState<PoolEntry[]>([]);
  const activeKeyRef = useRef<string | null>(null);

  const touch = useCallback((key: string) => {
    setEntries((prev) => {
      const entry = prev.find((e) => e.key === key);
      if (!entry) return prev;
      // Skip update if touched within last second (avoid unnecessary re-renders)
      if (Date.now() - entry.lastAccessedAt < 1000) return prev;
      return prev.map((e) =>
        e.key === key ? { ...e, lastAccessedAt: Date.now() } : e
      );
    });
  }, []);

  const evict = useCallback((key: string) => {
    setEntries((prev) => prev.filter((e) => e.key !== key));
  }, []);

  const ensure = useCallback((target: SessionTarget): string => {
    const key = makeKey(target);
    setEntries((prev) => {
      const existing = prev.find((e) => e.key === key);

      if (existing) {
        // Entry exists — update windowIndex if needed (Terminal component
        // will send SELECT_WINDOW to switch without reconnecting).
        if (existing.windowIndex === target.windowIndex) {
          return prev; // nothing changed — skip re-render
        }
        return prev.map((e) =>
          e.key === key
            ? { ...e, windowIndex: target.windowIndex, lastAccessedAt: Date.now() }
            : e,
        );
      }

      // New entry — evict LRU if at capacity
      const next = [...prev];
      if (next.length >= maxSize) {
        let lruIdx = -1;
        let lruTime = Infinity;
        for (let i = 0; i < next.length; i++) {
          const e = next[i];
          if (e.key !== activeKeyRef.current && e.lastAccessedAt < lruTime) {
            lruTime = e.lastAccessedAt;
            lruIdx = i;
          }
        }
        if (lruIdx !== -1) {
          next.splice(lruIdx, 1);
        }
      }

      next.push({
        key,
        containerId: target.containerId,
        sessionName: target.sessionName,
        windowIndex: target.windowIndex,
        lastAccessedAt: Date.now(),
      });

      return next;
    });
    return key;
  }, [maxSize]);

  const setActiveKey = useCallback((key: string | null) => {
    activeKeyRef.current = key;
  }, []);

  // Periodic idle eviction
  useEffect(() => {
    const intervalId = setInterval(() => {
      const now = Date.now();
      setEntries((prev) => {
        const next = prev.filter((e) => {
          if (e.key === activeKeyRef.current) return true;
          return now - e.lastAccessedAt <= idleTimeoutMs;
        });
        return next.length === prev.length ? prev : next;
      });
    }, 10_000);

    return () => clearInterval(intervalId);
  }, [idleTimeoutMs]);

  return { entries, ensure, touch, evict, setActiveKey };
}
