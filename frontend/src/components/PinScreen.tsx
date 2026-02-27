import { useState, useRef, useEffect } from 'react';
import { loginWithPin, setupPin } from '../api/httpClient';

interface PinScreenProps {
  mode: 'setup' | 'login';
  onSuccess: () => void;
}

export function PinScreen({ mode, onSuccess }: PinScreenProps) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [step, setStep] = useState<'enter' | 'confirm'>(mode === 'setup' ? 'enter' : 'enter');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);

  // Auto-submit when 4 digits are entered
  useEffect(() => {
    const value = step === 'confirm' ? confirmPin : pin;
    if (value.length === 4 && !loading) {
      formRef.current?.requestSubmit();
    }
  }, [pin, confirmPin, step, loading]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (mode === 'setup') {
      if (step === 'enter') {
        if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
          setError('PIN must be exactly 4 digits');
          return;
        }
        setStep('confirm');
        setConfirmPin('');
        return;
      }
      // confirm step
      if (confirmPin !== pin) {
        setError('PINs do not match');
        setConfirmPin('');
        return;
      }
      setLoading(true);
      try {
        await setupPin(pin);
        onSuccess();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Setup failed');
      } finally {
        setLoading(false);
      }
    } else {
      // login mode
      if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
        setError('PIN must be exactly 4 digits');
        return;
      }
      setLoading(true);
      try {
        await loginWithPin(pin);
        onSuccess();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Login failed');
        setPin('');
      } finally {
        setLoading(false);
      }
    }
  };

  const currentValue = step === 'confirm' ? confirmPin : pin;
  const setCurrentValue = step === 'confirm' ? setConfirmPin : setPin;

  const title = mode === 'setup'
    ? (step === 'enter' ? 'Create a PIN' : 'Confirm your PIN')
    : 'Enter PIN';

  const subtitle = mode === 'setup'
    ? (step === 'enter' ? 'Set a 4-digit PIN to secure access' : 'Re-enter your PIN to confirm')
    : 'Enter your 4-digit PIN to continue';

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] flex items-center justify-center z-50">
      <form ref={formRef} onSubmit={handleSubmit} className="w-full max-w-xs space-y-6 px-4">
        <div className="text-center space-y-2">
          <h1 className="text-xl font-semibold text-gray-100">{title}</h1>
          <p className="text-sm text-gray-500">{subtitle}</p>
        </div>

        <div
          className="relative flex justify-center gap-3 cursor-text"
          onClick={() => inputRef.current?.focus()}
        >
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
            className="absolute inset-0 opacity-0 cursor-text"
            autoFocus
            autoComplete="off"
          />
        </div>

        {error && (
          <p className="text-center text-sm text-red-400">{error}</p>
        )}

        <button
          type="submit"
          disabled={currentValue.length !== 4 || loading}
          className="w-full py-2.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading
            ? 'Please wait...'
            : mode === 'setup'
              ? (step === 'enter' ? 'Next' : 'Set PIN')
              : 'Unlock'
          }
        </button>

        {mode === 'setup' && step === 'confirm' && (
          <button
            type="button"
            onClick={() => {
              setStep('enter');
              setPin('');
              setConfirmPin('');
              setError('');
            }}
            className="w-full text-center text-xs text-gray-500 hover:text-gray-400"
          >
            Start over
          </button>
        )}
      </form>
    </div>
  );
}
