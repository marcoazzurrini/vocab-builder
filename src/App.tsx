import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { SessionScreen } from "./SessionScreen";
import { redirectTo, supabase } from "./lib/supabase";

// Auth gate only. Everything past signing in belongs to SessionScreen.

type AuthState =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "linkSent"; email: string }
  | { status: "signedIn"; session: Session };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuth(
        data.session ? { status: "signedIn", session: data.session } : { status: "signedOut" },
      );
    });

    // Also fires when a magic link returns and the session is read out of the
    // URL, which is what moves the screen on without a reload.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuth(session ? { status: "signedIn", session } : { status: "signedOut" });
    });
    return () => sub.subscription.unsubscribe();
  }, []);

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

  return (
    <main>
      <h1>vocab-builder</h1>

      {auth.status === "loading" && <p>…</p>}

      {auth.status === "signedOut" && (
        <form onSubmit={sendLink}>
          <label htmlFor="email">Accedi con un link via email</label>
          <br />
          <input id="email" name="email" type="email" required autoComplete="email" />
          <button type="submit">Invia link</button>
        </form>
      )}

      {auth.status === "linkSent" && (
        <p>
          Link inviato a <strong>{auth.email}</strong>. Aprilo su questo dispositivo.
        </p>
      )}

      {auth.status === "signedIn" && (
        <ErrorBoundary>
          <SessionScreen userId={auth.session.user.id} />
        </ErrorBoundary>
      )}

      {error && <p role="alert">Errore: {error}</p>}
    </main>
  );
}
