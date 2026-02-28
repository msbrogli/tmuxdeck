export function DockerIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Container stacks */}
      <rect x="2" y="13" width="4" height="3" rx="0.5" />
      <rect x="7" y="13" width="4" height="3" rx="0.5" />
      <rect x="12" y="13" width="4" height="3" rx="0.5" />
      <rect x="7" y="9" width="4" height="3" rx="0.5" />
      <rect x="12" y="9" width="4" height="3" rx="0.5" />
      <rect x="12" y="5" width="4" height="3" rx="0.5" />
      <rect x="17" y="11" width="4" height="3" rx="0.5" />
      {/* Whale body */}
      <path d="M1 17.5c0 0 1.5 3.5 10 3.5s12-4 12-4c0 0-.5-2-3-3" />
    </svg>
  );
}
