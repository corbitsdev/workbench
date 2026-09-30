// Profile menu (settings, theme, sign out) and the Tools button.

import { Moon, Palette, SignOut, SlidersHorizontal, Sun, Wrench, type Icon } from "@/lib/icons";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import "./sidebar-footer.css";
import { IdentityAvatar } from "../chat/avatar";
import { useSessionUser, useSignOut } from "../navigation";
import { matchesRoute, SETTINGS_PATH } from "../routes";
import { isTheme, setTheme, THEMES, useTheme, type Theme } from "../theme-store";

const THEME_OPTIONS: Record<Theme, { readonly label: string; readonly icon: Icon }> = {
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
  canvas: { label: "Canvas", icon: Palette },
};

export function SidebarFooter({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const user = useSessionUser();
  const onSignOut = useSignOut();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const radioRefs = useRef<Partial<Record<Theme, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  const onRadioKeyDown = (event: KeyboardEvent) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = THEMES[(THEMES.indexOf(theme) + step + THEMES.length) % THEMES.length];
    if (next === undefined) return;
    setTheme(next);
    radioRefs.current[next]?.focus();
  };

  const name = user?.name ?? "Account";
  const toolsActive = matchesRoute("/tools", path);

  return (
    <div className="sb-bottom" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="sb-profile"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        onClick={() => setOpen((value) => !value)}
      >
        <IdentityAvatar kind="person" name={name} principalId={user?.id ?? name} />
      </button>
      <button
        type="button"
        className="sb-tools"
        data-active={toolsActive ? "true" : undefined}
        aria-current={toolsActive ? "page" : undefined}
        onClick={() => onNavigate("/tools")}
      >
        <Wrench />
        Tools
      </button>
      {open ? (
        <div className="sb-menu" role="menu" aria-label="Account" onKeyDown={onMenuKeyDown}>
          <div className="sb-menu-head">
            <IdentityAvatar kind="person" name={name} principalId={user?.id ?? name} />
            <div>
              <b>{name}</b>
              {user !== undefined ? <span>{user.email}</span> : null}
            </div>
          </div>
          <div className="sb-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="sb-menu-item"
            autoFocus
            onClick={() => {
              setOpen(false);
              onNavigate(SETTINGS_PATH);
            }}
          >
            <SlidersHorizontal />
            Settings
          </button>
          <div className="sb-menu-theme" role="radiogroup" aria-label="Theme">
            {THEMES.map((key) => {
              const { label, icon: ThemeIcon } = THEME_OPTIONS[key];
              const active = theme === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  data-active={active ? "true" : undefined}
                  ref={(node) => {
                    radioRefs.current[key] = node;
                  }}
                  onKeyDown={onRadioKeyDown}
                  onClick={() => {
                    if (isTheme(key)) setTheme(key);
                  }}
                >
                  <ThemeIcon />
                  {label}
                </button>
              );
            })}
          </div>
          {onSignOut !== undefined ? (
            <>
              <div className="sb-menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="sb-menu-item"
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
              >
                <SignOut />
                Sign out
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
