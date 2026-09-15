import { signOut, useSession } from "@vocab/authentication/client";
import { useState } from "react";

import { SessionScreen } from "./features/practice/session-screen";
import { SignIn } from "./features/sign-in/sign-in";
import { AppShell } from "./shell/app-shell";

const App = () => {
  const { user, isPending, error: sessionError } = useSession();
  const [error, setError] = useState<string | null>(null);
  if (!user) {
    return <SignIn pending={isPending} sessionError={!!sessionError} />;
  }

  return (
    <AppShell
      email={user.email}
      onSignOut={async () => {
        try {
          await signOut();
          setError(null);
        } catch {
          setError("Disconnessione non riuscita. Riprova.");
        }
      }}
    >
      {error && (
        <p role="alert" className="note wrong">
          {error}
        </p>
      )}
      <SessionScreen key={user.id} userId={user.id} />
    </AppShell>
  );
};

export default App;
