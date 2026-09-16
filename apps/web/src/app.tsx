import { Trans } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { signOut, useSession } from "@vocab/authentication/client";
import { useState } from "react";

import { SessionScreen } from "./features/practice/session-screen";
import { SignIn } from "./features/sign-in/sign-in";
import { AppShell } from "./shell/app-shell";
import { useSessionDocument } from "./use-session-document";

const App = () => {
  const session = useSession();
  const { user, isPending, error: sessionError } = session;
  const [error, setError] = useState(false);
  const { documentIdentity } = useRouteContext({ from: "__root__" });
  const identityChanged = useSessionDocument(session, documentIdentity.userId);

  if (identityChanged) {
    return null;
  }
  if (!user) {
    return <SignIn pending={isPending} sessionError={!!sessionError} />;
  }

  return (
    <AppShell
      email={user.email}
      onSignOut={async () => {
        try {
          await signOut();
          setError(false);
        } catch {
          setError(true);
        }
      }}
    >
      {error && (
        <p role="alert" className="note wrong">
          <Trans>Could not sign out. Try again.</Trans>
        </p>
      )}
      <SessionScreen key={user.id} userId={user.id} />
    </AppShell>
  );
};

export default App;
