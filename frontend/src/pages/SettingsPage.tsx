import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Plus, X, LogOut, KeyRound } from 'lucide-react';
import { api } from '../api/client';
import { changePin, logout } from '../api/httpClient';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const [telegramToken, setTelegramToken] = useState('');
  const [allowedUsers, setAllowedUsers] = useState<string[]>([]);
  const [defaultVolumes, setDefaultVolumes] = useState<string[]>([]);
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [terminalPoolSize, setTerminalPoolSize] = useState(8);
  const [isDirty, setIsDirty] = useState(false);

  // Sync local state when settings data changes
  const [prevSettings, setPrevSettings] = useState(settings);
  if (settings && settings !== prevSettings) {
    setPrevSettings(settings);
    setTelegramToken(settings.telegramBotToken);
    setAllowedUsers(settings.telegramAllowedUsers);
    setDefaultVolumes(settings.defaultVolumeMounts);
    setSshKeyPath(settings.sshKeyPath);
    setTerminalPoolSize(settings.terminalPoolSize ?? 8);
    setIsDirty(false);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateSettings({
        telegramBotToken: telegramToken,
        telegramAllowedUsers: allowedUsers,
        defaultVolumeMounts: defaultVolumes,
        sshKeyPath,
        terminalPoolSize,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setIsDirty(false);
    },
  });

  const markDirty = () => setIsDirty(true);

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
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
        {/* Telegram Section */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Telegram Bot
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Bot Token</label>
              <input
                type="password"
                value={telegramToken}
                onChange={(e) => {
                  setTelegramToken(e.target.value);
                  markDirty();
                }}
                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 font-mono"
              />
              <p className="text-xs text-gray-600 mt-1">
                Get a token from @BotFather on Telegram
              </p>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">Allowed Users</label>
              {allowedUsers.map((user, i) => (
                <div key={i} className="flex items-center gap-2 mb-1">
                  <input
                    value={user}
                    onChange={(e) => {
                      const newUsers = [...allowedUsers];
                      newUsers[i] = e.target.value;
                      setAllowedUsers(newUsers);
                      markDirty();
                    }}
                    placeholder="username or user ID"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={() => {
                      setAllowedUsers(allowedUsers.filter((_, j) => j !== i));
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
                  setAllowedUsers([...allowedUsers, '']);
                  markDirty();
                }}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-1"
              >
                <Plus size={12} />
                Add user
              </button>
            </div>
          </div>
        </section>

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

        {/* Security Section */}
        <SecuritySection />
      </div>
    </div>
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
