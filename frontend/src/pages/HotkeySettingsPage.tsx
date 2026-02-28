import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Keyboard, RotateCcw } from 'lucide-react';
import { api } from '../api/client';
import { SettingsTabs } from '../components/SettingsTabs';
import { DEFAULT_HOTKEYS, HOTKEY_LABELS, bindingToDisplayKeys, resolveKey } from '../utils/hotkeys';

export function HotkeySettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const [hotkeyOverrides, setHotkeyOverrides] = useState<Record<string, string>>({});
  const [isDirty, setIsDirty] = useState(false);

  const [prevSettings, setPrevSettings] = useState<typeof settings>(undefined);
  if (settings && settings !== prevSettings) {
    setPrevSettings(settings);
    setHotkeyOverrides(settings.hotkeys ?? {});
    setIsDirty(false);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateSettings({
        hotkeys: hotkeyOverrides,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setIsDirty(false);
    },
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        navigate(-1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  return (
    <div className="px-6 py-8">
      <SettingsTabs />
      <div className="max-w-2xl">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-xl font-semibold text-gray-100">Keyboard Shortcuts</h1>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={!isDirty || saveMutation.isPending}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Save size={14} />
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>

        <HotkeySection
          hotkeys={hotkeyOverrides}
          onChange={(updated) => { setHotkeyOverrides(updated); setIsDirty(true); }}
        />
      </div>
    </div>
  );
}

function HotkeySection({
  hotkeys,
  onChange,
}: {
  hotkeys: Record<string, string>;
  onChange: (updated: Record<string, string>) => void;
}) {
  const [recordingAction, setRecordingAction] = useState<string | null>(null);

  const handleKeyCapture = useCallback((e: KeyboardEvent) => {
    if (!recordingAction) return;

    // Ignore bare modifier presses
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    e.preventDefault();
    e.stopPropagation();

    const key = resolveKey(e);
    const parts: string[] = [];
    if (e.shiftKey) parts.push('Shift');
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    parts.push(key.length === 1 ? key.toLowerCase() : key);

    const binding = parts.join('+');
    onChange({ ...hotkeys, [recordingAction]: binding });
    setRecordingAction(null);
  }, [recordingAction, hotkeys, onChange]);

  useEffect(() => {
    if (!recordingAction) return;
    window.addEventListener('keydown', handleKeyCapture, true);
    return () => window.removeEventListener('keydown', handleKeyCapture, true);
  }, [recordingAction, handleKeyCapture]);

  // Close recording on click outside
  useEffect(() => {
    if (!recordingAction) return;
    const handleClick = () => setRecordingAction(null);
    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [recordingAction]);

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4 flex items-center gap-2">
        <Keyboard size={14} />
        Keyboard Shortcuts
      </h2>
      <p className="text-xs text-gray-500 mb-3">
        Click a binding to record a new shortcut. Press the desired key combination.
      </p>
      <div className="space-y-1">
        {(Object.entries(HOTKEY_LABELS) as [string, string][]).map(([actionId, label]) => {
          const binding = hotkeys[actionId] ?? DEFAULT_HOTKEYS[actionId];
          const isDefault = binding === DEFAULT_HOTKEYS[actionId];
          const isRecording = recordingAction === actionId;
          const displayKeys = bindingToDisplayKeys(binding);

          return (
            <div key={actionId} className="flex items-center justify-between py-1.5">
              <span className="text-sm text-gray-400">{label}</span>
              <div className="flex items-center gap-2">
                <button
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setRecordingAction(isRecording ? null : actionId);
                  }}
                  className={`flex items-center gap-1 px-2 py-1 rounded transition-colors ${
                    isRecording
                      ? 'bg-blue-600/30 border border-blue-500 ring-1 ring-blue-500/50'
                      : 'bg-gray-800 border border-gray-700 hover:border-gray-600'
                  }`}
                >
                  {isRecording ? (
                    <span className="text-xs text-blue-300 animate-pulse">Press keys...</span>
                  ) : (
                    displayKeys.map((key: string, j: number) => (
                      <span key={j}>
                        {j > 0 && <span className="text-gray-600 text-xs mx-0.5">+</span>}
                        <kbd className="text-xs text-gray-300 bg-gray-700/50 px-1.5 py-0.5 rounded border border-gray-600 min-w-[1.5rem] text-center inline-block">
                          {key}
                        </kbd>
                      </span>
                    ))
                  )}
                </button>
                {!isDefault && (
                  <button
                    onClick={() => {
                      const updated = { ...hotkeys };
                      updated[actionId] = DEFAULT_HOTKEYS[actionId];
                      onChange(updated);
                    }}
                    className="p-1 text-gray-600 hover:text-gray-400 transition-colors"
                    title="Reset to default"
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
