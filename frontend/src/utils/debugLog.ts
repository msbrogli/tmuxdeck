/**
 * Frontend in-memory debug log.
 * Entries are merged with backend logs in the DebugLogPage.
 */
import type { DebugLogEntry } from '../types';

const MAX_ENTRIES = 500;
let entries: DebugLogEntry[] = [];
let nextId = 1;

function addEntry(level: DebugLogEntry['level'], source: string, message: string, detail?: string) {
  const entry: DebugLogEntry = {
    id: `ui-${nextId++}`,
    timestamp: new Date().toISOString(),
    level,
    source: `ui:${source}`,
    message,
    detail,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }
}

export const debugLog = {
  info: (source: string, message: string, detail?: string) => addEntry('info', source, message, detail),
  warn: (source: string, message: string, detail?: string) => addEntry('warn', source, message, detail),
  error: (source: string, message: string, detail?: string) => addEntry('error', source, message, detail),
  getEntries: (): DebugLogEntry[] => [...entries],
  clear: () => { entries = []; },
};
