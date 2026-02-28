import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { SettingsTabs } from '../components/SettingsTabs';
import { debugLog } from '../utils/debugLog';
import type { DebugLogEntry } from '../types';

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
};

const LEVEL_BG: Record<string, string> = {
  info: '',
  warn: 'bg-yellow-900/10',
  error: 'bg-red-900/15',
};

export function DebugLogPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>('all');

  const { data } = useQuery({
    queryKey: ['debug-log'],
    queryFn: () => api.getDebugLog(),
    refetchInterval: 3000,
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearDebugLog(),
    onSuccess: () => {
      debugLog.clear();
      queryClient.invalidateQueries({ queryKey: ['debug-log'] });
    },
  });

  // Merge backend + frontend logs
  const backendEntries = data?.entries ?? [];
  const uiEntries = debugLog.getEntries();
  const allEntries = [...backendEntries, ...uiEntries];

  // Filter
  const filtered = filter === 'all'
    ? allEntries
    : filter === 'info' || filter === 'warn' || filter === 'error'
      ? allEntries.filter((e) => e.level === filter)
      : allEntries.filter((e) => e.source === filter);

  // Sort by timestamp newest-first
  const sorted = [...filtered].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Unique sources for filter
  const sources = [...new Set(allEntries.map((e) => e.source))].sort();

  return (
    <div className="px-6 py-8">
      <SettingsTabs />
      <div className="max-w-5xl">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold text-gray-100">Debug Log</h1>
          <div className="flex items-center gap-2">
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-300 outline-none focus:border-blue-500"
            >
              <option value="all">All</option>
              <optgroup label="Level">
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </optgroup>
              {sources.length > 0 && (
                <optgroup label="Source">
                  {sources.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              onClick={() => clearMutation.mutate()}
              disabled={clearMutation.isPending || allEntries.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-gray-800 text-gray-400 hover:text-red-400 border border-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 size={13} />
              Clear All
            </button>
          </div>
        </div>

        {sorted.length === 0 ? (
          <p className="text-sm text-gray-600 py-8 text-center">No log entries yet.</p>
        ) : (
          <div className="border border-gray-800 rounded-lg overflow-hidden">
            <div className="max-h-[calc(100vh-250px)] overflow-y-auto">
              <table className="w-full text-xs font-mono">
                <tbody>
                  {sorted.map((entry) => (
                    <LogRow key={entry.id} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="mt-2 text-xs text-gray-600">
          {sorted.length}{sorted.length !== allEntries.length ? ` / ${allEntries.length}` : ''} entries
        </div>
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: DebugLogEntry }) {
  const ts = new Date(entry.timestamp);
  const time = ts.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ms = String(ts.getMilliseconds()).padStart(3, '0');

  return (
    <tr className={`border-b border-gray-800/50 ${LEVEL_BG[entry.level] ?? ''}`}>
      <td className="px-2 py-1 text-gray-600 whitespace-nowrap align-top w-[90px]">
        {time}.{ms}
      </td>
      <td className={`px-1.5 py-1 whitespace-nowrap align-top w-[42px] uppercase font-semibold ${LEVEL_COLORS[entry.level] ?? 'text-gray-400'}`}>
        {entry.level}
      </td>
      <td className="px-1.5 py-1 text-gray-500 whitespace-nowrap align-top w-[80px] truncate max-w-[80px]">
        {entry.source}
      </td>
      <td className="px-2 py-1 text-gray-300 align-top">
        {entry.message}
        {entry.detail && (
          <span className="text-gray-600 ml-2">{entry.detail}</span>
        )}
      </td>
    </tr>
  );
}
