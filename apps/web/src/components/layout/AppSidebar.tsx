import { Home, LayoutGrid, Settings, Moon, Sun, LogOut } from 'lucide-react';
import { NavLink, Link, useLocation } from 'react-router';
import { useAuth } from '../AuthProvider';
import { useTheme } from '@workbench/ui';

export function AppSidebar() {
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
  const location = useLocation();
  const settingsActive = location.pathname.startsWith('/settings');

  const navIconClass = (isActive: boolean) =>
    `grid h-[40px] w-[40px] place-items-center rounded-[10px] transition-colors duration-150 ease-in-out ${
      isActive ? 'text-orange' : 'text-text-3 hover:text-text'
    }`;

  return (
    <aside className="flex h-full w-[56px] flex-col items-center border-r border-border bg-surface py-3">
      <div className="flex flex-col items-center gap-0">
        <Link to="/" className="group grid h-[40px] w-[40px] place-items-center" aria-label="Home">
          <span className="grid h-[30px] w-[30px] place-items-center rounded-[10px] bg-orange text-[16px] font-extrabold text-white shadow-[var(--orange-glow)] will-change-transform transition-transform duration-[400ms] ease-spring group-hover:rotate-[-8deg] group-hover:scale-[1.08]">
            C
          </span>
        </Link>
      </div>

      <nav className="mt-4 flex flex-col items-center gap-1" aria-label="Main navigation">
        <NavLink
          to="/"
          end
          title="Workbench"
          aria-label="Workbench"
          className={({ isActive }) => navIconClass(isActive)}
        >
          <Home size={18} />
        </NavLink>

        <NavLink
          to="/dashboard"
          title="Sessions"
          aria-label="Sessions"
          className={({ isActive }) => navIconClass(isActive)}
        >
          <LayoutGrid size={18} />
        </NavLink>

        <Link
          to="/settings"
          title="Settings"
          aria-label="Settings"
          className={navIconClass(settingsActive)}
        >
          <Settings size={18} />
        </Link>
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2 pb-1">
        <button
          type="button"
          title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
          aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
          aria-pressed={theme === 'dark'}
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          className="grid h-[40px] w-[40px] place-items-center rounded-[10px] text-text-3 transition-colors duration-150 ease-in-out hover:text-text"
        >
          {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>

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
          className="grid h-[40px] w-[40px] place-items-center rounded-[10px] text-text-2 transition-colors duration-150 ease-in-out hover:text-text"
        >
          <LogOut size={18} />
        </button>
      </div>
    </aside>
  );
}
