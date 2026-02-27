export const DEFAULT_HOTKEYS: Record<string, string> = {
  quickSwitch: 'Ctrl+K',
  showHelp: 'Ctrl+H',
  nextItem: 'Ctrl+ArrowDown',
  prevItem: 'Ctrl+ArrowUp',
  foldSession: 'Ctrl+ArrowLeft',
  unfoldSession: 'Ctrl+ArrowRight',
  moveWindowUp: 'Shift+Ctrl+ArrowUp',
  moveWindowDown: 'Shift+Ctrl+ArrowDown',
  deselect: 'Escape Escape',
};

export const HOTKEY_LABELS: Record<string, string> = {
  quickSwitch: 'Quick-switch sessions',
  showHelp: 'Show keyboard shortcuts',
  nextItem: 'Next window / session',
  prevItem: 'Previous window / session',
  foldSession: 'Fold session',
  unfoldSession: 'Unfold session',
  moveWindowUp: 'Move window up',
  moveWindowDown: 'Move window down',
  deselect: 'Deselect / logout',
};

interface ParsedBinding {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export function parseBinding(binding: string): ParsedBinding {
  const parts = binding.split('+');
  const modifiers = parts.slice(0, -1).map((m) => m.toLowerCase());
  const key = parts[parts.length - 1];
  return {
    ctrl: modifiers.includes('ctrl'),
    shift: modifiers.includes('shift'),
    alt: modifiers.includes('alt'),
    key,
  };
}

export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  // Special case: double-press bindings like "Escape Escape"
  // These are handled separately by the caller — this function only checks single-press
  if (binding.includes(' ')) return false;

  const parsed = parseBinding(binding);

  // On macOS, treat Cmd (metaKey) as equivalent to Ctrl
  const ctrlPressed = e.ctrlKey || e.metaKey;

  if (parsed.ctrl !== ctrlPressed) return false;
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;

  const eventKey = resolveKey(e);
  return eventKey === parsed.key;
}

/**
 * Check if a binding is a double-press (e.g. "Escape Escape").
 */
export function isDoublePressBinding(binding: string): boolean {
  return binding.includes(' ');
}

/**
 * For double-press bindings like "Escape Escape", check if the key matches
 * the individual key (without modifiers). Timing is handled by the caller.
 */
export function matchesDoublePressKey(e: KeyboardEvent, binding: string): boolean {
  if (!isDoublePressBinding(binding)) return false;
  const key = binding.split(' ')[0];
  return e.key === key && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

/**
 * Extract the real key from a KeyboardEvent, working around macOS Alt behavior.
 * On macOS, Option+key produces special unicode characters in e.key (e.g. Option+H → ˙).
 * We use e.code to recover the intended key.
 */
export function resolveKey(e: KeyboardEvent): string {
  // For single printable characters that look like macOS Alt mangling, use e.code
  if (e.altKey && e.key.length === 1 && e.code.startsWith('Key')) {
    return e.code.slice(3).toLowerCase(); // "KeyH" → "h"
  }
  if (e.altKey && e.key.length === 1 && e.code.startsWith('Digit')) {
    return e.code.slice(5); // "Digit1" → "1"
  }
  return e.key;
}

/**
 * Convert a binding string to display keys for the KeyboardHelp UI.
 * e.g. "Ctrl+K" → ["Ctrl", "K"], "Escape Escape" → ["Esc", "Esc"]
 */
export function bindingToDisplayKeys(binding: string): string[] {
  if (isDoublePressBinding(binding)) {
    return binding.split(' ').map(keyToDisplay);
  }
  return binding.split('+').map(keyToDisplay);
}

function keyToDisplay(key: string): string {
  switch (key) {
    case 'ArrowUp': return '\u2191';
    case 'ArrowDown': return '\u2193';
    case 'ArrowLeft': return '\u2190';
    case 'ArrowRight': return '\u2192';
    case 'Escape': return 'Esc';
    default: return key;
  }
}
