import { Trans } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { signOut, useSession } from "@vocab/authentication/client";
import { useState } from "react";

import { AppShell } from "@/components/patterns/app-shell";
import type { AppSection } from "@/components/patterns/app-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";

import { ErrorBoundary } from "./features/practice/error-boundary";
import { SessionScreen } from "./features/practice/session-screen";
import { SignIn } from "./features/sign-in/sign-in";
import { useSessionDocument } from "./use-session-document";

const App = () => {
  const session = useSession();
  const { user, isPending, error: sessionError } = session;
  const [error, setError] = useState(false);
  const [section, setSection] = useState<AppSection>("session");
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
      section={section}
      onSectionChange={setSection}
      onSignOut={async () => {
        try {
          await signOut();
          setError(false);
        } catch {
          setError(true);
        }
      }}
      notice={
        error && (
          <Alert variant="destructive">
            <AlertDescription>
              <Trans>Could not sign out. Try again.</Trans>
            </AlertDescription>
          </Alert>
        )
      }
    >
      <ErrorBoundary>
        <SessionScreen
          key={user.id}
          userId={user.id}
          active={section === "session"}
        />
      </ErrorBoundary>
    </AppShell>
  );
};

export default App;
