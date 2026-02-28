import { useLocation, useNavigate } from 'react-router-dom';

const tabs = [
  { label: 'General', path: '/settings' },
  { label: 'Telegram', path: '/settings/telegram' },
  { label: 'Bridges', path: '/settings/bridges' },
  { label: 'Templates', path: '/settings/templates' },
  { label: 'Log', path: '/settings/log' },
];

export function SettingsTabs() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div className="flex gap-0 border-b border-gray-800 mb-6">
      {tabs.map((tab) => {
        const active = location.pathname === tab.path;
        return (
          <button
            key={tab.path}
            onClick={() => navigate(tab.path, { replace: true })}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              active
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
