import { forwardRef, useImperativeHandle, useState, useEffect, useCallback, createRef } from 'react';
import { Terminal } from './Terminal';
import type { TerminalHandle } from './Terminal';
import type { PoolEntry } from '../hooks/useTerminalPool';

export interface TerminalPoolHandle {
  focusActive: () => void;
  refitActive: () => void;
}

interface TerminalPoolProps {
  entries: PoolEntry[];
  activeKey: string | null;
}

export const TerminalPool = forwardRef<TerminalPoolHandle, TerminalPoolProps>(
  function TerminalPool({ entries, activeKey }, ref) {
    // Use useState with lazy init to hold the refs map — avoids useRef.current access during render
    const [refsMap] = useState(() => new Map<string, React.RefObject<TerminalHandle | null>>());

    // Sync refs map with entries (add new, remove stale)
    const currentKeys = new Set(entries.map((e) => e.key));
    for (const key of refsMap.keys()) {
      if (!currentKeys.has(key)) {
        refsMap.delete(key);
      }
    }
    for (const entry of entries) {
      if (!refsMap.has(entry.key)) {
        refsMap.set(entry.key, createRef<TerminalHandle>());
      }
    }

    // Refit the newly active terminal when activeKey changes
    useEffect(() => {
      if (!activeKey) return;
      const termRef = refsMap.get(activeKey);
      if (termRef?.current) {
        // Double-rAF so the visibility CSS is processed before measuring
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            termRef.current?.refit();
          });
        });
      }
    }, [activeKey, refsMap]);

    const getActiveRef = useCallback(() => {
      if (!activeKey) return null;
      return refsMap.get(activeKey)?.current ?? null;
    }, [activeKey, refsMap]);

    useImperativeHandle(ref, () => ({
      focusActive: () => getActiveRef()?.focus(),
      refitActive: () => getActiveRef()?.refit(),
    }), [getActiveRef]);

    return (
      <div className="relative w-full h-full">
        {entries.map((entry) => {
          const isActive = entry.key === activeKey;
          return (
            <div
              key={entry.key}
              className="absolute inset-0"
              style={{
                visibility: isActive ? 'visible' : 'hidden',
                zIndex: isActive ? 10 : 0,
                pointerEvents: isActive ? 'auto' : 'none',
              }}
            >
              <Terminal
                ref={refsMap.get(entry.key)}
                containerId={entry.containerId}
                sessionName={entry.sessionName}
                windowIndex={entry.windowIndex}
                autoFocus={false}
                visible={isActive}
              />
            </div>
          );
        })}
      </div>
    );
  }
);
