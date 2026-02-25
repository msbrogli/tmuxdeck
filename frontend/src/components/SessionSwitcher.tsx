import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Terminal as TerminalIcon, Search } from 'lucide-react';
import { api } from '../api/client';
import type { Container } from '../types';

interface WindowEntry {
  containerId: string;
  containerName: string;
  sessionName: string;
  windowIndex: number;
  windowName: string;
  sessionSummary?: string;
  key: string; // unique key for recency tracking: containerId:sessionName:windowIndex
}

interface SessionSwitcherProps {
  onClose: () => void;
  onSelect: (containerId: string, sessionName: string, windowIndex: number) => void;
  onPreview?: (containerId: string, sessionName: string, windowIndex: number) => void;
  onPreviewEnd?: () => void;
  recentIds: string[]; // ordered list of keys, most recent first
  digitByTargetKey?: Record<string, string>;
}

function fuzzyMatch(query: string, target: string): { match: boolean; score: number; indices: number[] } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (q.length === 0) return { match: true, score: 0, indices: [] };

  const indices: number[] = [];
  let qi = 0;
  let lastMatchIndex = -1;
  let score = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      // Consecutive matches score higher
      if (lastMatchIndex === ti - 1) {
        score += 2;
      } else {
        score += 1;
      }
      // Bonus for matching at start or after separator
      if (ti === 0 || t[ti - 1] === '/' || t[ti - 1] === '-' || t[ti - 1] === ' ' || t[ti - 1] === ':') {
        score += 3;
      }
      lastMatchIndex = ti;
      qi++;
    }
  }

  if (qi < q.length) return { match: false, score: 0, indices: [] };

  // Penalize long gaps between matches
  score -= (indices[indices.length - 1] - indices[0] - indices.length + 1) * 0.5;

  return { match: true, score, indices };
}

function HighlightedText({ text, indices }: { text: string; indices: number[] }) {
  const indexSet = new Set(indices);
  return (
    <span>
      {text.split('').map((char, i) =>
        indexSet.has(i) ? (
          <span key={i} className="text-blue-400 font-semibold">{char}</span>
        ) : (
          <span key={i}>{char}</span>
        )
      )}
    </span>
  );
}

export function SessionSwitcher({ onClose, onSelect, onPreview, onPreviewEnd, recentIds, digitByTargetKey }: SessionSwitcherProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { data: containers = [] } = useQuery({
    queryKey: ['containers'],
    queryFn: () => api.listContainers(),
  });

  // Flatten sessions→windows from running containers
  const allWindows: WindowEntry[] = useMemo(() => {
    return containers
      .filter((c: Container) => c.status === 'running')
      .flatMap((c: Container) =>
        c.sessions.flatMap((s) =>
          s.windows.map((w) => ({
            containerId: c.id,
            containerName: c.displayName,
            sessionName: s.name,
            windowIndex: w.index,
            windowName: w.name,
            sessionSummary: s.summary,
            key: `${c.id}:${s.name}:${w.index}`,
          }))
        )
      );
  }, [containers]);

  // Filter and sort: fuzzy match, then sort by recency + score
  const filtered = useMemo(() => {
    const recentMap = new Map(recentIds.map((id, i) => [id, recentIds.length - i]));

    return allWindows
      .map((entry) => {
        const searchStr = `${entry.containerName}/${entry.sessionName}:${entry.windowIndex} ${entry.windowName}`;
        const result = fuzzyMatch(query, searchStr);
        const recencyBoost = recentMap.get(entry.key) ?? 0;
        return { ...entry, ...result, searchStr, recencyBoost };
      })
      .filter((e) => e.match)
      .sort((a, b) => {
        // If no query, sort purely by recency
        if (!query) return b.recencyBoost - a.recencyBoost;
        // With query, combine fuzzy score + recency
        return (b.score + b.recencyBoost * 0.5) - (a.score + a.recencyBoost * 0.5);
      });
  }, [allWindows, query, recentIds]);

  // Focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // Keep selected index in bounds (derived, no setState needed)
  const effectiveIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[effectiveIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [effectiveIndex]);

  const emitPreview = (index: number) => {
    const entry = filtered[index];
    if (entry) {
      onPreview?.(entry.containerId, entry.sessionName, entry.windowIndex);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => {
          const next = Math.min(i + 1, filtered.length - 1);
          emitPreview(next);
          return next;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => {
          const next = Math.max(i - 1, 0);
          emitPreview(next);
          return next;
        });
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[effectiveIndex]) {
          const s = filtered[effectiveIndex];
          onPreviewEnd?.();
          onSelect(s.containerId, s.sessionName, s.windowIndex);
          onClose();
        }
        break;
      case 'Escape':
        e.preventDefault();
        onPreviewEnd?.();
        onClose();
        break;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[15vh] z-50" onClick={() => { onPreviewEnd?.(); onClose(); }}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
          <Search size={16} className="text-gray-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Search windows..."
            className="flex-1 bg-transparent text-sm text-gray-200 outline-none placeholder-gray-600"
          />
          <kbd className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-gray-600">
              {allWindows.length === 0 ? 'No running sessions' : 'No matching windows'}
            </div>
          )}
          {filtered.map((entry, i) => (
            <button
              key={entry.key}
              className={`flex items-center gap-3 w-full px-4 py-2.5 text-left transition-colors ${
                i === effectiveIndex
                  ? 'bg-blue-900/40 text-blue-200'
                  : 'text-gray-400 hover:bg-gray-800/60'
              }`}
              onClick={() => {
                onPreviewEnd?.();
                onSelect(entry.containerId, entry.sessionName, entry.windowIndex);
                onClose();
              }}
              onMouseEnter={() => {
                setSelectedIndex(i);
                onPreview?.(entry.containerId, entry.sessionName, entry.windowIndex);
              }}
            >
              <TerminalIcon size={14} className="shrink-0 text-gray-500 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">
                  <HighlightedText text={entry.searchStr} indices={entry.indices} />
                </div>
                {entry.sessionSummary && (
                  <div className="text-xs text-gray-500 truncate">{entry.sessionSummary}</div>
                )}
              </div>
              {digitByTargetKey?.[entry.key] != null && (
                <span className="shrink-0 text-[10px] font-mono font-medium bg-gray-700 text-yellow-400 rounded px-1 py-px leading-none">
                  {digitByTargetKey[entry.key]}
                </span>
              )}
              {entry.recencyBoost > 0 && i < 3 && !query && (
                <span className="text-[10px] text-gray-600">recent</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-gray-800 text-[10px] text-gray-600">
          <span><kbd className="bg-gray-800 px-1 py-0.5 rounded border border-gray-700">↑↓</kbd> navigate</span>
          <span><kbd className="bg-gray-800 px-1 py-0.5 rounded border border-gray-700">↵</kbd> select</span>
          <span><kbd className="bg-gray-800 px-1 py-0.5 rounded border border-gray-700">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
