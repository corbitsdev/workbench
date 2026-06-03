import { Link } from 'react-router';
import { useAuth } from '../AuthProvider';
import { useTheme } from '../../lib/use-theme';

interface TopbarProps {
  /** Current location shown after the wordmark, e.g. "Workbench". */
  breadcrumb?: string;
}

/**
 * Persistent top chrome: wordmark, breadcrumb, notifications, theme toggle,
 * avatar, sign out. 74px tall, centered to 1180px, transparent over the page.
 * Mirrors the topbar in workbench.html (CL-984).
 */
export function Topbar({ breadcrumb = 'Workbench' }: TopbarProps) {
  const { session, signOut } = useAuth();
  const name = session.status === 'authenticated' ? session.user.name : '';
  const initials =
    name
      .split(' ')
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '··';
  const { theme, setTheme } = useTheme();

  return (
    <header className="mx-auto flex h-[74px] max-w-[1180px] items-center gap-[18px] bg-transparent px-2">
      <Link
        to="/"
        className="group flex items-center gap-[11px] text-[19px] font-extrabold tracking-[-0.02em] text-text"
      >
        <span className="grid h-[30px] w-[30px] place-items-center rounded-[10px] bg-orange text-[16px] font-extrabold text-white shadow-[0_4px_14px_rgba(233,132,40,0.45)] transition-transform duration-[400ms] ease-spring group-hover:rotate-[-8deg] group-hover:scale-[1.08]">
          C
        </span>
        Corbits
      </Link>

      <div className="flex items-center gap-2 text-[14px] font-medium text-text-3">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-3.5 w-3.5 opacity-50"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        {breadcrumb}
      </div>

      <div className="flex-1" />

      <button
        type="button"
        title="Notifications"
        aria-label="Notifications"
        className="grid h-[34px] w-[34px] place-items-center rounded-[9px] border border-transparent text-text-2 transition-colors duration-150 ease-in-out hover:border-border hover:bg-[var(--row-hover)] hover:text-text"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-[18px] w-[18px]"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
      </button>

      <div
        className="flex items-center gap-[7px] rounded-full border border-border bg-surface p-1"
        role="group"
        aria-label="Theme"
      >
        <button
          type="button"
          title="Light"
          aria-label="Light theme"
          aria-pressed={theme === 'light'}
          onClick={() => setTheme('light')}
          className={`grid h-[26px] w-[30px] place-items-center rounded-full transition-colors duration-200 ease-in-out ${
            theme === 'light' ? 'bg-orange text-white' : 'text-text-3'
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-[15px] w-[15px]"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        </button>
        <button
          type="button"
          title="Dark"
          aria-label="Dark theme"
          aria-pressed={theme === 'dark'}
          onClick={() => setTheme('dark')}
          className={`grid h-[26px] w-[30px] place-items-center rounded-full transition-colors duration-200 ease-in-out ${
            theme === 'dark' ? 'bg-orange text-white' : 'text-text-3'
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-[15px] w-[15px]"
          >
            <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
          </svg>
        </button>
      </div>

      <div
        className="grid h-[30px] w-[30px] place-items-center rounded-full bg-blue text-[10px] font-bold text-white"
        title={name}
      >
        {initials}
      </div>

      <button
        type="button"
        onClick={signOut}
        title="Sign out"
        aria-label="Sign out"
        className="grid h-[34px] w-[34px] place-items-center rounded-[9px] border border-transparent text-text-2 transition-colors duration-150 ease-in-out hover:border-border hover:bg-[var(--row-hover)] hover:text-text"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-[18px] w-[18px]"
        >
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
        </svg>
      </button>
    </header>
  );
}
