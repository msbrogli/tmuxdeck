import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { PinScreen } from './components/PinScreen';
import { ToastProvider } from './components/ToastContainer';
import { MainPage } from './pages/MainPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TelegramSettingsPage } from './pages/TelegramSettingsPage';
import { BridgeSettingsPage } from './pages/BridgeSettingsPage';
import { HotkeySettingsPage } from './pages/HotkeySettingsPage';
import { DebugLogPage } from './pages/DebugLogPage';
import { HelpPage } from './pages/HelpPage';
import { useAuth } from './hooks/useAuth';
import { setOnAuthLost } from './api/httpClient';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 5000,
      staleTime: 2000,
    },
  },
});

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isPinSet, isLoading, invalidateAuth } = useAuth();

  // Register the auth-lost callback so httpClient can trigger re-render
  useEffect(() => {
    setOnAuthLost(invalidateAuth);
    return () => setOnAuthLost(null);
  }, [invalidateAuth]);

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-[#0a0a0a] flex items-center justify-center">
        <div className="text-gray-500 text-sm">Loading...</div>
      </div>
    );
  }

  if (!isPinSet) {
    return <PinScreen mode="setup" onSuccess={invalidateAuth} />;
  }

  if (!isAuthenticated) {
    return <PinScreen mode="login" onSuccess={invalidateAuth} />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<MainPage />} />
                <Route path="/settings/templates" element={<TemplatesPage />} />
                <Route path="/settings/telegram" element={<TelegramSettingsPage />} />
                <Route path="/settings/hotkeys" element={<HotkeySettingsPage />} />
                <Route path="/settings/bridges" element={<BridgeSettingsPage />} />
                <Route path="/settings/log" element={<DebugLogPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/help" element={<HelpPage />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </AuthGate>
    </QueryClientProvider>
  );
}

export default App;
