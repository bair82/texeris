import type { ReactNode } from 'react';

interface ActivityBarProps {
  filesActive: boolean;
  archiveActive: boolean;
  sideActive: boolean;
  focusMode: boolean;
  onToggleFiles(): void;
  onToggleArchive(): void;
  onToggleSide(): void;
  onToggleFocus(): void;
  onOpenSettings(): void;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * The slim left-hand rail (M1.5 EU1): region toggles on top, settings pinned
 * to the bottom. Always visible so a hidden region is one click away.
 */
export default function ActivityBar({
  filesActive,
  archiveActive,
  sideActive,
  focusMode,
  onToggleFiles,
  onToggleArchive,
  onToggleSide,
  onToggleFocus,
  onOpenSettings,
}: ActivityBarProps) {
  return (
    <div className="activity-bar">
      <button
        className={`activity-button ${filesActive ? 'active' : ''}`}
        title="Toggle files"
        onClick={onToggleFiles}
      >
        <Icon>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
        </Icon>
      </button>
      <button
        className={`activity-button ${archiveActive ? 'active' : ''}`}
        title="Writing archive"
        onClick={onToggleArchive}
      >
        <Icon>
          <path d="M4 5.5h16v14H4z" />
          <path d="M8 5.5v14M12 5.5v14M16 5.5v14" />
          <path d="M3 3h18" />
        </Icon>
      </button>
      <button
        className={`activity-button ${sideActive ? 'active' : ''}`}
        title="Toggle assistant"
        onClick={onToggleSide}
      >
        <Icon>
          <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.6 0-3.1-.4-4.3-1.1L3 20l1.1-5.2A8.5 8.5 0 1 1 21 11.5z" />
        </Icon>
      </button>
      <button
        className={`activity-button ${focusMode ? 'active' : ''}`}
        title="Focus mode — hide both panels"
        onClick={onToggleFocus}
      >
        <Icon>
          <path d="M8 3H5a2 2 0 0 0-2 2v3" />
          <path d="M16 3h3a2 2 0 0 1 2 2v3" />
          <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
          <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
        </Icon>
      </button>
      <div className="activity-spacer" />
      <button className="activity-button" title="Settings" onClick={onOpenSettings}>
        <Icon>
          <line x1="4" y1="6" x2="20" y2="6" />
          <circle cx="15" cy="6" r="2.1" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <circle cx="8" cy="12" r="2.1" />
          <line x1="4" y1="18" x2="20" y2="18" />
          <circle cx="13" cy="18" r="2.1" />
        </Icon>
      </button>
    </div>
  );
}
