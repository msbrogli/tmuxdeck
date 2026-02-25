import { useState, useCallback, useMemo } from 'react';
import type { SessionTarget } from '../types';

const STORAGE_KEY = 'windowShortcuts';

function loadMap(): Record<string, SessionTarget> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore corrupt data */ }
  return {};
}

function saveMap(map: Record<string, SessionTarget>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

function targetKey(t: SessionTarget): string {
  return `${t.containerId}:${t.sessionName}:${t.windowIndex}`;
}

export function useWindowShortcuts(): {
  map: Record<string, SessionTarget>;
  assignDigit: (digit: string, target: SessionTarget) => void;
  digitByTargetKey: Record<string, string>;
} {
  const [map, setMap] = useState<Record<string, SessionTarget>>(loadMap);

  const assignDigit = useCallback((digit: string, target: SessionTarget) => {
    setMap((prev) => {
      const next = { ...prev };
      const tk = targetKey(target);

      // If this digit already points to this target → toggle off
      const existing = next[digit];
      if (existing && targetKey(existing) === tk) {
        delete next[digit];
        saveMap(next);
        return next;
      }

      // Remove this target from any other digit (1 window = 1 digit)
      for (const d of Object.keys(next)) {
        if (targetKey(next[d]) === tk) {
          delete next[d];
        }
      }

      // Assign
      next[digit] = target;
      saveMap(next);
      return next;
    });
  }, []);

  const digitByTargetKey = useMemo(() => {
    const reverse: Record<string, string> = {};
    for (const [digit, target] of Object.entries(map)) {
      reverse[targetKey(target)] = digit;
    }
    return reverse;
  }, [map]);

  return { map, assignDigit, digitByTargetKey };
}
