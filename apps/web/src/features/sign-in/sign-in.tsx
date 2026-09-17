import { Trans, useLingui } from "@lingui/react/macro";
import { requestLink } from "@vocab/authentication/client";
import { useEffect, useState } from "react";
import * as v from "valibot";

import { Wordmark } from "@/components/patterns/wordmark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

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
    <main className="mx-auto flex min-h-svh w-full max-w-sm flex-col gap-6 px-6 pt-20 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <h1 className="text-2xl font-semibold text-balance">
        <Wordmark />
      </h1>
      {pending && (
        <output className="text-muted-foreground flex items-center gap-2 text-sm">
          <Spinner aria-hidden="true" />
          <Trans>Loading…</Trans>
        </output>
      )}
      {!pending && !sentTo && (
        <form onSubmit={sendLink} aria-busy={sending}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email">
                <Trans>Sign in with an email link</Trans>
              </FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder={t`you@example.com`}
              />
            </Field>
            <Field>
              <Button type="submit" disabled={sending}>
                {sending && (
                  <Spinner aria-hidden="true" data-icon="inline-start" />
                )}
                {sending ? t`Sending…` : t`Send link`}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      )}
      {sentTo && (
        <>
          <output className="text-muted-foreground text-sm text-pretty [overflow-wrap:anywhere]">
            <Trans>
              If this email address has access, you&apos;ll receive a link at{" "}
              <strong>{sentTo}</strong>. Open it on this device.
            </Trans>
          </output>
          <Button
            type="button"
            variant="outline"
            onClick={() => setSentTo(null)}
          >
            <Trans>Request another link</Trans>
          </Button>
        </>
      )}
      {(error || sessionError) && (
        <Alert variant="destructive">
          <AlertDescription>
            {error &&
              {
                expired: t`This link is invalid or has expired. Request a new one.`,
                send: t`Could not send the link. Check your connection and try again.`,
              }[error]}
            {!error && t`Could not check whether you're signed in. Try again.`}
          </AlertDescription>
        </Alert>
      )}
    </main>
  );
};
