import { useState, useCallback } from 'react';

const CONTAINER_EXPANDED_KEY = 'containerExpanded';

function loadExpandedMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CONTAINER_EXPANDED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistExpandedMap(map: Record<string, boolean>) {
  try {
    localStorage.setItem(CONTAINER_EXPANDED_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

export function useContainerExpandedState() {
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>(loadExpandedMap);

  const isContainerExpanded = useCallback((containerId: string): boolean => {
    return expandedMap[containerId] ?? true;
  }, [expandedMap]);

  const setContainerExpanded = useCallback((containerId: string, expanded: boolean) => {
    setExpandedMap((prev) => {
      const next = { ...prev, [containerId]: expanded };
      persistExpandedMap(next);
      return next;
    });
  }, []);

  return { isContainerExpanded, setContainerExpanded };
}
