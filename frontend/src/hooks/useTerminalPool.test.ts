import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTerminalPool } from './useTerminalPool';

describe('useTerminalPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with empty entries', () => {
    const { result } = renderHook(() => useTerminalPool());
    expect(result.current.entries).toEqual([]);
  });

  it('ensure creates a new entry', () => {
    const { result } = renderHook(() => useTerminalPool());
    let key: string;
    act(() => {
      key = result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 0 });
    });
    expect(key!).toBe('c1-s1-0');
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].key).toBe('c1-s1-0');
    expect(result.current.entries[0].containerId).toBe('c1');
  });

  it('ensure is idempotent — does not add duplicate entries', () => {
    const { result } = renderHook(() => useTerminalPool());
    const target = { containerId: 'c1', sessionName: 's1', windowIndex: 0 };
    act(() => { result.current.ensure(target); });
    act(() => { result.current.ensure(target); });
    act(() => { result.current.ensure(target); });
    expect(result.current.entries).toHaveLength(1);
  });

  it('ensure returns consistent key for same target', () => {
    const { result } = renderHook(() => useTerminalPool());
    const target = { containerId: 'c1', sessionName: 's1', windowIndex: 0 };
    let key1: string, key2: string;
    act(() => { key1 = result.current.ensure(target); });
    act(() => { key2 = result.current.ensure(target); });
    expect(key1!).toBe(key2!);
  });

  it('evicts LRU when at capacity', () => {
    const { result } = renderHook(() => useTerminalPool({ maxSize: 2 }));
    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 0 });
    });
    vi.advanceTimersByTime(10);
    act(() => {
      result.current.ensure({ containerId: 'c2', sessionName: 's2', windowIndex: 0 });
    });
    vi.advanceTimersByTime(10);
    act(() => {
      result.current.ensure({ containerId: 'c3', sessionName: 's3', windowIndex: 0 });
    });
    expect(result.current.entries).toHaveLength(2);
    // c1 was LRU, should be evicted
    expect(result.current.entries.map((e) => e.key)).toEqual(['c2-s2-0', 'c3-s3-0']);
  });

  it('active key is protected from LRU eviction', () => {
    const { result } = renderHook(() => useTerminalPool({ maxSize: 2 }));
    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 0 });
      result.current.setActiveKey('c1-s1-0');
    });
    vi.advanceTimersByTime(10);
    act(() => {
      result.current.ensure({ containerId: 'c2', sessionName: 's2', windowIndex: 0 });
    });
    vi.advanceTimersByTime(10);
    act(() => {
      result.current.ensure({ containerId: 'c3', sessionName: 's3', windowIndex: 0 });
    });
    expect(result.current.entries).toHaveLength(2);
    // c1 is active, c2 was LRU, c3 is new
    expect(result.current.entries.map((e) => e.key)).toEqual(['c1-s1-0', 'c3-s3-0']);
  });

  it('evict removes a specific entry', () => {
    const { result } = renderHook(() => useTerminalPool());
    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 0 });
      result.current.ensure({ containerId: 'c2', sessionName: 's2', windowIndex: 0 });
    });
    expect(result.current.entries).toHaveLength(2);
    act(() => { result.current.evict('c1-s1-0'); });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].key).toBe('c2-s2-0');
  });

  it('touch updates lastAccessedAt', () => {
    const { result } = renderHook(() => useTerminalPool());
    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 0 });
    });
    const firstAccess = result.current.entries[0].lastAccessedAt;
    // touch debounces within 1s, advance past that
    vi.advanceTimersByTime(1100);
    act(() => {
      result.current.touch('c1-s1-0');
    });
    expect(result.current.entries[0].lastAccessedAt).toBeGreaterThan(firstAccess);
  });

  it('ensure evicts sibling windows of the same session', () => {
    const { result } = renderHook(() => useTerminalPool());
    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 0 });
    });
    expect(result.current.entries.map((e) => e.key)).toEqual(['c1-s1-0']);

    // Ensuring a different window of the same session evicts the old one
    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 1 });
    });
    expect(result.current.entries.map((e) => e.key)).toEqual(['c1-s1-1']);
  });

  it('sibling eviction does not affect entries from different sessions', () => {
    const { result } = renderHook(() => useTerminalPool());
    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 0 });
      result.current.ensure({ containerId: 'c1', sessionName: 's2', windowIndex: 0 });
      result.current.ensure({ containerId: 'c2', sessionName: 's1', windowIndex: 0 });
    });
    expect(result.current.entries).toHaveLength(3);

    // Switching window in c1/s1 only evicts c1/s1 siblings
    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 1 });
    });
    expect(result.current.entries.map((e) => e.key)).toEqual([
      'c1-s2-0',
      'c2-s1-0',
      'c1-s1-1',
    ]);
  });

  it('switching windows back and forth within same session works', () => {
    const { result } = renderHook(() => useTerminalPool());
    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 0 });
    });
    expect(result.current.entries.map((e) => e.key)).toEqual(['c1-s1-0']);

    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 1 });
    });
    expect(result.current.entries.map((e) => e.key)).toEqual(['c1-s1-1']);

    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 0 });
    });
    expect(result.current.entries.map((e) => e.key)).toEqual(['c1-s1-0']);
  });

  it('idle timeout evicts stale entries', () => {
    const { result } = renderHook(() =>
      useTerminalPool({ maxSize: 8, idleTimeoutMs: 5000 })
    );
    act(() => {
      result.current.ensure({ containerId: 'c1', sessionName: 's1', windowIndex: 0 });
      result.current.ensure({ containerId: 'c2', sessionName: 's2', windowIndex: 0 });
      result.current.setActiveKey('c1-s1-0'); // protect c1
    });
    expect(result.current.entries).toHaveLength(2);
    // Advance past idle timeout + eviction interval
    act(() => { vi.advanceTimersByTime(15000); });
    // c2 should be evicted (idle), c1 protected (active)
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].key).toBe('c1-s1-0');
  });
});
