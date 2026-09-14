import { useEffect, useState } from "react";
import { requestLink } from "@vocab/authentication/client";
import { Wordmark } from "../../shell/Wordmark";

export function SignIn({ pending, sessionError }: { pending: boolean; sessionError: boolean }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("error"))
      setError("Link non valido o scaduto. Richiedi un nuovo link.");
  }, []);

  async function sendLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const email = new FormData(event.currentTarget).get("email");
    if (typeof email !== "string" || !email) return;
    setSending(true);
    try {
      await requestLink(email);
      setSentTo(email);
    } catch {
      setError("Invio non riuscito. Controlla la connessione e riprova.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="auth">
      <h1 className="wordmark">
        <Wordmark />
      </h1>
      {pending && <p className="sent">Carico…</p>}
      {!pending && !sentTo && (
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
