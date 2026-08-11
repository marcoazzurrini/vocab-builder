import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { SessionScreen } from "./SessionScreen";
import { redirectTo, supabase } from "./lib/supabase";
import { Sidebar } from "./ui/Sidebar";
import { Wordmark } from "./ui/Wordmark";

// Auth gate and shell. Everything past signing in belongs to SessionScreen.

type AuthState =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "linkSent"; email: string }
  | { status: "signedIn"; session: Session };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuth(
        data.session ? { status: "signedIn", session: data.session } : { status: "signedOut" },
      );
    });

    // Also fires when a magic link returns and the session is read out of the
    // URL, which is what moves the screen on without a reload — and again on
    // sign-out, which is what moves it back.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuth(session ? { status: "signedIn", session } : { status: "signedOut" });
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  async function sendLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const email = new FormData(event.currentTarget).get("email");
    if (typeof email !== "string" || !email) return;

    const { error: signInError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo() },
    });
    if (signInError) setError(signInError.message);
    else setAuth({ status: "linkSent", email });
  }

  if (auth.status === "signedIn") {
    return (
      <div className="shell">
        <Sidebar
          email={auth.session.user.email ?? null}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          onSignOut={() => void supabase.auth.signOut()}
        />
        {menuOpen && (
          <div className="scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />
        )}
        <div className="col">
          <header>
            <button
              type="button"
              className="menu-btn"
              onClick={() => setMenuOpen(true)}
              aria-label="Apri menu"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <span className="wordmark">
              <Wordmark />
            </span>
          </header>
          <main>
            <ErrorBoundary>
              <SessionScreen userId={auth.session.user.id} />
            </ErrorBoundary>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <h1 className="wordmark">
        <Wordmark />
      </h1>

      {auth.status === "loading" && <p className="sent">…</p>}

      {auth.status === "signedOut" && (
        <form onSubmit={sendLink}>
          <label htmlFor="email">Accedi con un link via email</label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="tu@esempio.it"
          />
          <div className="actions">
            <button type="submit">Invia link</button>
          </div>
        </form>
      )}

      {auth.status === "linkSent" && (
        <p className="sent">
          Link inviato a <strong>{auth.email}</strong>. Aprilo su questo dispositivo.
        </p>
      )}

      {error && (
        <p role="alert" className="note wrong">
          Errore: {error}
        </p>
      )}
    </div>
  );
}
