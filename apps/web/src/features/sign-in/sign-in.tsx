import { Trans, useLingui } from "@lingui/react/macro";
import { requestLink } from "@vocab/authentication/client";
import { useEffect, useState } from "react";
import * as v from "valibot";

import { Wordmark } from "../../shell/wordmark";

export const SignIn = ({
  pending,
  sessionError,
}: {
  pending: boolean;
  sessionError: boolean;
}) => {
  const { t } = useLingui();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<"expired" | "send" | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("error")) {
      // Read the callback URL after hydration so server and initial client markup match.
      // oxlint-disable-next-line react/set-state-in-effect
      setError("expired");
    }
  }, []);

  const sendLink = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const parsedEmail = v.safeParse(
      v.pipe(v.string(), v.minLength(1)),
      new FormData(event.currentTarget).get("email")
    );
    if (!parsedEmail.success) {
      return;
    }
    const email = parsedEmail.output;
    setSending(true);
    try {
      await requestLink(email);
      setSentTo(email);
    } catch {
      setError("send");
    }
    setSending(false);
  };

  return (
    <div className="auth">
      <h1 className="wordmark">
        <Wordmark />
      </h1>
      {pending && (
        <p className="sent">
          <Trans>Loading…</Trans>
        </p>
      )}
      {!pending && !sentTo && (
        <form onSubmit={sendLink}>
          <label htmlFor="email">
            <Trans>Sign in with an email link</Trans>
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder={t`you@example.com`}
          />
          <div className="actions">
            <button type="submit" disabled={sending}>
              {sending ? t`Sending…` : t`Send link`}
            </button>
          </div>
        </form>
      )}
      {sentTo && (
        <>
          <p className="sent">
            <Trans>
              If this email address has access, you&apos;ll receive a link at{" "}
              <strong>{sentTo}</strong>. Open it on this device.
            </Trans>
          </p>
          <button type="button" onClick={() => setSentTo(null)}>
            <Trans>Request another link</Trans>
          </button>
        </>
      )}
      {(error || sessionError) && (
        <p role="alert" className="note wrong">
          {error &&
            {
              expired: t`This link is invalid or has expired. Request a new one.`,
              send: t`Could not send the link. Check your connection and try again.`,
            }[error]}
          {!error && t`Could not check whether you're signed in. Try again.`}
        </p>
      )}
    </div>
  );
};
