import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Plus, X, LogOut, KeyRound, RotateCcw, Keyboard } from 'lucide-react';
import { api } from '../api/client';
import { changePin, logout } from '../api/httpClient';
import { SettingsTabs } from '../components/SettingsTabs';
import { DEFAULT_HOTKEYS, HOTKEY_LABELS, bindingToDisplayKeys, resolveKey } from '../utils/hotkeys';

export function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const [defaultVolumes, setDefaultVolumes] = useState<string[]>([]);
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [terminalPoolSize, setTerminalPoolSize] = useState(8);
  const [hotkeyOverrides, setHotkeyOverrides] = useState<Record<string, string>>({});
  const [isDirty, setIsDirty] = useState(false);

  // Sync local state when settings data changes
  const [prevSettings, setPrevSettings] = useState<typeof settings>(undefined);
  if (settings && settings !== prevSettings) {
    setPrevSettings(settings);
    setDefaultVolumes(settings.defaultVolumeMounts);
    setSshKeyPath(settings.sshKeyPath);
    setTerminalPoolSize(settings.terminalPoolSize ?? 8);
    setHotkeyOverrides(settings.hotkeys ?? {});
    setIsDirty(false);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateSettings({
        defaultVolumeMounts: defaultVolumes,
        sshKeyPath,
        terminalPoolSize,
        hotkeys: hotkeyOverrides,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setIsDirty(false);
    },
  });

  const markDirty = () => setIsDirty(true);

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
        <h1 className="text-xl font-semibold text-gray-100">Settings</h1>
        <button
          onClick={() => saveMutation.mutate()}
          disabled={!isDirty || saveMutation.isPending}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Save size={14} />
          {saveMutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>

      <div className="space-y-8">
        {/* Volume Mounts Section */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Default Volume Mounts
          </h2>
          <p className="text-xs text-gray-500 mb-3">
            These mounts are pre-filled when creating new containers.
          </p>
          {defaultVolumes.map((vol, i) => (
            <div key={i} className="flex items-center gap-2 mb-1">
              <input
                value={vol}
                onChange={(e) => {
                  const newVols = [...defaultVolumes];
                  newVols[i] = e.target.value;
                  setDefaultVolumes(newVols);
                  markDirty();
                }}
                placeholder="/host/path:/container/path"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500 font-mono"
              />
              <button
                onClick={() => {
                  setDefaultVolumes(defaultVolumes.filter((_, j) => j !== i));
                  markDirty();
                }}
                className="p-1 text-gray-500 hover:text-red-400"
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button
            onClick={() => {
              setDefaultVolumes([...defaultVolumes, '']);
              markDirty();
            }}
            className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-1"
          >
            <Plus size={12} />
            Add mount
          </button>
        </section>

        {/* Terminal Section */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Terminal
          </h2>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Pool Size</label>
            <input
              type="number"
              min={1}
              max={32}
              value={terminalPoolSize}
              onChange={(e) => {
                setTerminalPoolSize(Math.max(1, Math.min(32, Number(e.target.value) || 8)));
                markDirty();
              }}
              className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
            />
            <p className="text-xs text-gray-600 mt-1">
              Number of terminal instances kept alive simultaneously (1-32, default 8)
            </p>
          </div>
        </section>

        {/* SSH Section */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            SSH
          </h2>
          <div>
            <label className="block text-sm text-gray-400 mb-1">SSH Key Path</label>
            <input
              value={sshKeyPath}
              onChange={(e) => {
                setSshKeyPath(e.target.value);
                markDirty();
              }}
              placeholder="~/.ssh/id_rsa"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 font-mono"
            />
            <p className="text-xs text-gray-600 mt-1">
              Used for mounting into containers for private repo access
            </p>
          </div>
        </section>

        {/* Keyboard Shortcuts Section */}
        <HotkeySection
          hotkeys={hotkeyOverrides}
          onChange={(updated) => { setHotkeyOverrides(updated); markDirty(); }}
        />

        {/* Security Section */}
        <SecuritySection />
      </div>
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

function SecuritySection() {
  const queryClient = useQueryClient();
  const [changePinOpen, setChangePinOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    queryClient.invalidateQueries({ queryKey: ['auth'] });
  };

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
        Security
      </h2>
      <div className="space-y-4">
        <button
          onClick={() => setChangePinOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 transition-colors"
        >
          <KeyRound size={14} />
          Change PIN
        </button>

        <div className="border-t border-gray-800 pt-4">
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
          >
            <LogOut size={14} />
            Log out
          </button>
        </div>
      </div>

      {changePinOpen && (
        <ChangePinScreen onClose={() => setChangePinOpen(false)} />
      )}
    </section>
  );
}

function ChangePinScreen({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'current' | 'new' | 'confirm'>('current');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const currentValue =
    step === 'current' ? currentPin : step === 'new' ? newPin : confirmPin;
  const setCurrentValue =
    step === 'current' ? setCurrentPin : step === 'new' ? setNewPin : setConfirmPin;

  // Auto-submit when 4 digits are entered
  useEffect(() => {
    if (currentValue.length === 4 && !loading) {
      formRef.current?.requestSubmit();
    }
  }, [currentPin, newPin, confirmPin, step, loading]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (currentValue.length !== 4 || !/^\d{4}$/.test(currentValue)) {
      setError('PIN must be exactly 4 digits');
      return;
    }

    if (step === 'current') {
      setStep('new');
      return;
    }

    if (step === 'new') {
      setStep('confirm');
      setConfirmPin('');
      return;
    }

    // confirm step
    if (confirmPin !== newPin) {
      setError('PINs do not match');
      setConfirmPin('');
      return;
    }

    setLoading(true);
    try {
      await changePin(currentPin, newPin);
      queryClient.invalidateQueries({ queryKey: ['auth'] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Change failed');
      // Go back to current PIN step on auth error
      setStep('current');
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
    } finally {
      setLoading(false);
    }
  };

  const title =
    step === 'current'
      ? 'Enter Current PIN'
      : step === 'new'
        ? 'Enter New PIN'
        : 'Confirm New PIN';

  const subtitle =
    step === 'current'
      ? 'Verify your identity first'
      : step === 'new'
        ? 'Choose a new 4-digit PIN'
        : 'Re-enter your new PIN to confirm';

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] flex items-center justify-center z-50">
      <form ref={formRef} onSubmit={handleSubmit} className="w-full max-w-xs space-y-6 px-4">
        <div className="text-center space-y-2">
          <h1 className="text-xl font-semibold text-gray-100">{title}</h1>
          <p className="text-sm text-gray-500">{subtitle}</p>
        </div>

        <div className="flex justify-center gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`w-12 h-14 rounded-lg border-2 flex items-center justify-center text-2xl font-mono transition-colors ${
                i < currentValue.length
                  ? 'border-blue-500 bg-gray-800 text-gray-100'
                  : 'border-gray-700 bg-gray-900 text-gray-600'
              }`}
            >
              {i < currentValue.length ? '\u2022' : ''}
            </div>
          ))}
        </div>

        <input
          ref={inputRef}
          type="tel"
          inputMode="numeric"
          pattern="\d*"
          maxLength={4}
          value={currentValue}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 4);
            setCurrentValue(v);
            setError('');
          }}
          className="sr-only"
          autoFocus
          autoComplete="off"
        />

        {error && (
          <p className="text-center text-sm text-red-400">{error}</p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="w-full text-center text-xs text-gray-500 hover:text-gray-400"
        >
          Cancel
        </button>
      </form>
    </div>
  );
}
