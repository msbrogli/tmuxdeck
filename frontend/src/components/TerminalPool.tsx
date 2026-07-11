import { Fragment, forwardRef, useImperativeHandle, useState, useEffect, useCallback, createRef } from 'react';
import { Terminal } from './Terminal';
import type { TerminalHandle } from './Terminal';
import type { PoolEntry } from '../hooks/useTerminalPool';
import { Loader2 } from 'lucide-react';
import { FileViewer } from './FileViewer';

export interface TerminalPoolHandle {
  focusActive: () => void;
  refitActive: () => void;
  clearBufferActive: () => void;
}

interface TerminalPoolProps {
  entries: PoolEntry[];
  activeKey: string | null;
  onActiveWindowChanged?: (containerId: string, sessionName: string, windowIndex: number) => void;
  onWindowsChanged?: (containerId: string, sessionName: string, windows: import('../types').TmuxWindow[]) => void;
}

export const TerminalPool = forwardRef<TerminalPoolHandle, TerminalPoolProps>(
  function TerminalPool({ entries, activeKey, onActiveWindowChanged, onWindowsChanged }, ref) {
    // Use useState with lazy init to hold the refs map — avoids useRef.current access during render
    const [refsMap] = useState(() => new Map<string, React.RefObject<TerminalHandle | null>>());
    // Per-window file viewing state, keyed by `${entry.key}::${windowIndex}` —
    // pool entries are per-session, but the viewer belongs to the window the
    // file was opened in, so it must hide when another window becomes active.
    const [viewingFiles, setViewingFiles] = useState(() => new Map<string, { entryKey: string; windowIndex: number; containerId: string; path: string }>());
    // Track which terminals have received their first data
    const [readyKeys, setReadyKeys] = useState<Set<string>>(() => new Set());
    // Track which terminals have been detected as gone (session removed)
    const [goneKeys, setGoneKeys] = useState<Set<string>>(() => new Set());
    // Generation counter per key — incremented on retry to force remount
    const [genMap, setGenMap] = useState(() => new Map<string, number>());

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

    // Clean up readyKeys and goneKeys for evicted entries
    useEffect(() => {
      setReadyKeys(prev => {
        const next = new Set(prev);
        let changed = false;
        for (const key of next) {
          if (!currentKeys.has(key)) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setGoneKeys(prev => {
        const next = new Set(prev);
        let changed = false;
        for (const key of next) {
          if (!currentKeys.has(key)) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setViewingFiles(prev => {
        let changed = false;
        for (const value of prev.values()) {
          if (!currentKeys.has(value.entryKey)) {
            changed = true;
            break;
          }
        }
        if (!changed) return prev;
        const next = new Map(prev);
        for (const [key, value] of next) {
          if (!currentKeys.has(value.entryKey)) next.delete(key);
        }
        return next;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entries]);

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
      clearBufferActive: () => getActiveRef()?.clearBuffer(),
    }), [getActiveRef]);

    const isActiveGone = activeKey != null && goneKeys.has(activeKey);
    const showLoading = activeKey != null && !readyKeys.has(activeKey) && !isActiveGone;

    const retryGoneTerminal = useCallback(() => {
      if (!activeKey) return;
      // Clear gone and ready state so the terminal shows loading
      setGoneKeys(prev => {
        if (!prev.has(activeKey)) return prev;
        const next = new Set(prev);
        next.delete(activeKey);
        return next;
      });
      setReadyKeys(prev => {
        if (!prev.has(activeKey)) return prev;
        const next = new Set(prev);
        next.delete(activeKey);
        return next;
      });
      // Bump generation to force Terminal remount (fresh WebSocket connection)
      setGenMap(prev => {
        const next = new Map(prev);
        next.set(activeKey, (prev.get(activeKey) ?? 0) + 1);
        return next;
      });
    }, [activeKey]);

    return (
      <div className="relative w-full h-full">
        {entries.map((entry) => {
          const isActive = entry.key === activeKey;
          return (
            <Fragment key={`${entry.key}::${genMap.get(entry.key) ?? 0}`}>
              <div
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
                  onOpenFile={(path) => setViewingFiles(prev => {
                    const next = new Map(prev);
                    next.set(`${entry.key}::${entry.windowIndex}`, {
                      entryKey: entry.key,
                      windowIndex: entry.windowIndex,
                      containerId: entry.containerId,
                      path,
                    });
                    return next;
                  })}
                  onDownloadFile={(path) => {
                    const url = `/api/v1/containers/${entry.containerId}/file/download?path=${encodeURIComponent(path)}`;
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = path.split('/').pop() || 'download';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                  }}
                  onActiveWindowChanged={isActive && onActiveWindowChanged ? (session, idx) => onActiveWindowChanged(entry.containerId, session, idx) : undefined}
                  onWindowsChanged={isActive && onWindowsChanged ? (session, windows) => onWindowsChanged(entry.containerId, session, windows) : undefined}
                  onReady={() => setReadyKeys(prev => {
                    if (prev.has(entry.key)) return prev;
                    const next = new Set(prev);
                    next.add(entry.key);
                    return next;
                  })}
                  onSessionGone={() => setGoneKeys(prev => {
                    if (prev.has(entry.key)) return prev;
                    const next = new Set(prev);
                    next.add(entry.key);
                    return next;
                  })}
                />
              </div>
              {[...viewingFiles.entries()]
                .filter(([, viewing]) => viewing.entryKey === entry.key)
                .map(([viewerKey, viewing]) => {
                  const isVisible = isActive && viewing.windowIndex === entry.windowIndex;
                  return (
                    <div
                      key={viewerKey}
                      className="absolute inset-0"
                      style={{
                        display: isVisible ? undefined : 'none',
                        zIndex: 30,
                      }}
                    >
                      <FileViewer
                        containerId={viewing.containerId}
                        path={viewing.path}
                        active={isVisible}
                        onClose={() => {
                          setViewingFiles(prev => {
                            const next = new Map(prev);
                            next.delete(viewerKey);
                            return next;
                          });
                          requestAnimationFrame(() => refsMap.get(entry.key)?.current?.focus());
                        }}
                      />
                    </div>
                  );
                })}
            </Fragment>
          );
        })}
        {showLoading && (
          <div
            className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none"
            style={{ background: '#0a0a0a' }}
          >
            <div className="flex items-center gap-2 text-zinc-500">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">Loading terminal...</span>
            </div>
          </div>
        )}
        {isActiveGone && (
          <div
            className="absolute inset-0 flex items-center justify-center z-20"
            style={{ background: '#0a0a0a' }}
          >
            <div className="flex flex-col items-center gap-3 text-zinc-400">
              <span className="text-sm">Terminal no longer exists — the session was removed</span>
              <button
                onClick={retryGoneTerminal}
                className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
              >
                Retry connection
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
);
