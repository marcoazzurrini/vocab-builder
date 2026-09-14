import { useState } from "react";
import { signOut, useSession } from "@vocab/authentication/client";
import { SessionScreen } from "./features/practice/SessionScreen";
import { SignIn } from "./features/sign-in/SignIn";
import { AppShell } from "./shell/AppShell";

export default function App() {
  const { user, isPending, error: sessionError } = useSession();
  const [error, setError] = useState<string | null>(null);
  if (!user) return <SignIn pending={isPending} sessionError={!!sessionError} />;

  return (
    <AppShell
      email={user.email}
      onSignOut={() => {
        void signOut()
          .then(() => setError(null))
          .catch(() => setError("Disconnessione non riuscita. Riprova."));
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
}
