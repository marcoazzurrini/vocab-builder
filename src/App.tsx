import { useEffect, useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { SessionScreen } from "./SessionScreen";
import { authClient } from "./lib/auth-client";
import { Sidebar } from "./ui/Sidebar";
import { Wordmark } from "./ui/Wordmark";

// Auth gate and shell. Everything past signing in belongs to SessionScreen.

export default function App() {
  const { data: current, isPending, error: sessionError } = authClient.useSession();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("error")) {
      setError("Link non valido o scaduto. Richiedi un nuovo link.");
    }
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

    setSending(true);
    try {
      const { error: signInError } = await authClient.signIn.magicLink({ email, callbackURL: "/" });
      if (signInError) setError(signInError.message ?? "Invio non riuscito. Riprova.");
      else setSentTo(email);
    } catch {
      setError("Connessione non disponibile. Riprova.");
    } finally {
      setSending(false);
    }
  }

  if (current) {
    return (
      <div className="shell">
        <Sidebar
          email={current.user.email}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          onSignOut={() => {
            void authClient
              .signOut()
              .then(({ error: signOutError }) => {
                if (signOutError) setError("Disconnessione non riuscita. Riprova.");
                else setSentTo(null);
              })
              .catch(() => setError("Disconnessione non riuscita. Riprova."));
          }}
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
              {error && (
                <p role="alert" className="note wrong">
                  {error}
                </p>
              )}
              <SessionScreen key={current.user.id} userId={current.user.id} />
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

      {isPending && <p className="sent">Carico…</p>}

      {!isPending && !sentTo && (
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
            <button type="submit" disabled={sending}>
              {sending ? "Invio…" : "Invia link"}
            </button>
          </div>
        </form>
      )}

      {sentTo && (
        <>
          <p className="sent">
            Se l'indirizzo è abilitato, riceverai un link a <strong>{sentTo}</strong>. Aprilo su
            questo dispositivo.
          </p>
          <button type="button" onClick={() => setSentTo(null)}>
            Richiedi un altro link
          </button>
        </>
      )}

      {(error || sessionError) && (
        <p role="alert" className="note wrong">
          {error ?? "Impossibile verificare l'accesso. Riprova."}
        </p>
      )}
    </div>
  );
}
