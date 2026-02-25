import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { TerminalPool } from './TerminalPool';
import type { TerminalPoolHandle } from './TerminalPool';
import type { PoolEntry } from '../hooks/useTerminalPool';

// Mock the Terminal component — xterm requires a real DOM canvas
vi.mock('./Terminal', () => ({
  Terminal: vi.fn().mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ containerId, sessionName, windowIndex, visible }: any) => (
      <div
        data-testid={`terminal-${containerId}-${sessionName}-${windowIndex}`}
        data-visible={String(visible)}
      >
        Terminal:{containerId}/{sessionName}:{windowIndex}
      </div>
    )
  ),
}));

function makeEntry(containerId: string, sessionName: string, windowIndex: number): PoolEntry {
  return {
    key: `${containerId}-${sessionName}-${windowIndex}`,
    containerId,
    sessionName,
    windowIndex,
    lastAccessedAt: Date.now(),
  };
}

function TestWrapper({ entries, activeKey }: { entries: PoolEntry[]; activeKey: string | null }) {
  const ref = useRef<TerminalPoolHandle>(null);
  return (
    <div style={{ width: 800, height: 600, position: 'relative' }}>
      <TerminalPool ref={ref} entries={entries} activeKey={activeKey} />
    </div>
  );
}

describe('TerminalPool', () => {
  it('renders nothing when entries is empty', () => {
    const { container } = render(<TestWrapper entries={[]} activeKey={null} />);
    expect(container.querySelectorAll('[data-testid^="terminal-"]')).toHaveLength(0);
  });

  it('renders all entries and only the active one is visible', () => {
    const entries = [
      makeEntry('c1', 's1', 0),
      makeEntry('c2', 's2', 0),
    ];
    render(<TestWrapper entries={entries} activeKey="c1-s1-0" />);

    const t1 = screen.getByTestId('terminal-c1-s1-0');
    const t2 = screen.getByTestId('terminal-c2-s2-0');

    // Check the wrapper div visibility (parent of terminal)
    expect(t1.parentElement!.style.visibility).toBe('visible');
    expect(t2.parentElement!.style.visibility).toBe('hidden');

    expect(t1.getAttribute('data-visible')).toBe('true');
    expect(t2.getAttribute('data-visible')).toBe('false');
  });

  it('switches visibility when activeKey changes', () => {
    const entries = [
      makeEntry('c1', 's1', 0),
      makeEntry('c2', 's2', 0),
    ];
    const { rerender } = render(<TestWrapper entries={entries} activeKey="c1-s1-0" />);

    // c1 active
    expect(screen.getByTestId('terminal-c1-s1-0').parentElement!.style.visibility).toBe('visible');
    expect(screen.getByTestId('terminal-c2-s2-0').parentElement!.style.visibility).toBe('hidden');

    // Switch to c2
    rerender(<TestWrapper entries={entries} activeKey="c2-s2-0" />);

    expect(screen.getByTestId('terminal-c1-s1-0').parentElement!.style.visibility).toBe('hidden');
    expect(screen.getByTestId('terminal-c2-s2-0').parentElement!.style.visibility).toBe('visible');
  });

  it('hides all terminals when activeKey is null', () => {
    const entries = [
      makeEntry('c1', 's1', 0),
      makeEntry('c2', 's2', 0),
    ];
    render(<TestWrapper entries={entries} activeKey={null} />);

    expect(screen.getByTestId('terminal-c1-s1-0').parentElement!.style.visibility).toBe('hidden');
    expect(screen.getByTestId('terminal-c2-s2-0').parentElement!.style.visibility).toBe('hidden');
  });

  it('hides all when activeKey does not match any entry', () => {
    const entries = [makeEntry('c1', 's1', 0)];
    render(<TestWrapper entries={entries} activeKey="nonexistent-key-0" />);
    expect(screen.getByTestId('terminal-c1-s1-0').parentElement!.style.visibility).toBe('hidden');
  });

  it('handles adding new entries dynamically', () => {
    const entries1 = [makeEntry('c1', 's1', 0)];
    const { rerender } = render(<TestWrapper entries={entries1} activeKey="c1-s1-0" />);

    expect(screen.queryByTestId('terminal-c2-s2-0')).toBeNull();

    // Add c2 and make it active
    const entries2 = [...entries1, makeEntry('c2', 's2', 0)];
    rerender(<TestWrapper entries={entries2} activeKey="c2-s2-0" />);

    expect(screen.getByTestId('terminal-c2-s2-0').parentElement!.style.visibility).toBe('visible');
    expect(screen.getByTestId('terminal-c1-s1-0').parentElement!.style.visibility).toBe('hidden');
  });

  it('handles removing entries', () => {
    const entries = [
      makeEntry('c1', 's1', 0),
      makeEntry('c2', 's2', 0),
    ];
    const { rerender } = render(<TestWrapper entries={entries} activeKey="c1-s1-0" />);

    expect(screen.getByTestId('terminal-c1-s1-0')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-c2-s2-0')).toBeInTheDocument();

    // Remove c2 (evicted from pool)
    const entries2 = [entries[0]];
    rerender(<TestWrapper entries={entries2} activeKey="c1-s1-0" />);

    expect(screen.getByTestId('terminal-c1-s1-0')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-c2-s2-0')).toBeNull();
  });

  it('simulates preview navigation: A → B → back to A', async () => {
    // Start with A and B in pool, A is active (committed)
    const entries = [
      makeEntry('c1', 's1', 0),
      makeEntry('c2', 's2', 0),
    ];
    const { rerender } = render(<TestWrapper entries={entries} activeKey="c1-s1-0" />);

    // A is visible (committed)
    expect(screen.getByTestId('terminal-c1-s1-0').parentElement!.style.visibility).toBe('visible');
    expect(screen.getByTestId('terminal-c2-s2-0').parentElement!.style.visibility).toBe('hidden');

    // Hover B → preview switches to B
    await act(async () => {
      rerender(<TestWrapper entries={entries} activeKey="c2-s2-0" />);
    });
    expect(screen.getByTestId('terminal-c1-s1-0').parentElement!.style.visibility).toBe('hidden');
    expect(screen.getByTestId('terminal-c2-s2-0').parentElement!.style.visibility).toBe('visible');

    // Mouse leaves → preview clears → back to A
    await act(async () => {
      rerender(<TestWrapper entries={entries} activeKey="c1-s1-0" />);
    });
    expect(screen.getByTestId('terminal-c1-s1-0').parentElement!.style.visibility).toBe('visible');
    expect(screen.getByTestId('terminal-c2-s2-0').parentElement!.style.visibility).toBe('hidden');
  });

  it('simulates rapid switching: A → B → C → A', async () => {
    const entries = [
      makeEntry('c1', 's1', 0),
      makeEntry('c2', 's2', 0),
      makeEntry('c3', 's3', 0),
    ];
    const { rerender } = render(<TestWrapper entries={entries} activeKey="c1-s1-0" />);

    // Switch to B
    await act(async () => { rerender(<TestWrapper entries={entries} activeKey="c2-s2-0" />); });
    expect(screen.getByTestId('terminal-c2-s2-0').parentElement!.style.visibility).toBe('visible');

    // Switch to C
    await act(async () => { rerender(<TestWrapper entries={entries} activeKey="c3-s3-0" />); });
    expect(screen.getByTestId('terminal-c3-s3-0').parentElement!.style.visibility).toBe('visible');
    expect(screen.getByTestId('terminal-c1-s1-0').parentElement!.style.visibility).toBe('hidden');
    expect(screen.getByTestId('terminal-c2-s2-0').parentElement!.style.visibility).toBe('hidden');

    // Back to A
    await act(async () => { rerender(<TestWrapper entries={entries} activeKey="c1-s1-0" />); });
    expect(screen.getByTestId('terminal-c1-s1-0').parentElement!.style.visibility).toBe('visible');
    expect(screen.getByTestId('terminal-c2-s2-0').parentElement!.style.visibility).toBe('hidden');
    expect(screen.getByTestId('terminal-c3-s3-0').parentElement!.style.visibility).toBe('hidden');
  });
});
