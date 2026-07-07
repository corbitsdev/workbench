import { useAuth } from "../components/AuthProvider";

export function NoWorkbenchWelcomePage() {
  const { session, signOut } = useAuth();
  const name =
    session.status === "authenticated"
      ? (session.user.name ?? session.user.email ?? "there")
      : "there";

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-page px-6 py-12">
      <div className="w-full max-w-md space-y-6 text-center">
        <h1 className="text-2xl font-semibold text-text">
          No workbench access yet
        </h1>
        <p className="text-sm leading-relaxed text-text-2">
          Hi {name} — you&apos;re signed in, but you&apos;re not a member of any
          workbench. Ask an administrator to invite you, then sign in again.
        </p>
        <button
          type="button"
          onClick={() => {
            void signOut().catch(() => {});
          }}
          className="rounded-[10px] border border-border bg-surface px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-page"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
