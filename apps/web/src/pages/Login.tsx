import { useState } from "react";
import { api } from "../api";
import { Button, ErrorBanner, Field } from "../components";

export const LoginPage = ({ onLogin }: { onLogin: () => void }) => {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  return (
    <main className="login-shell" id="main">
      <section className="login-card" aria-labelledby="login-heading">
        <p className="eyebrow">Slackboard</p>
        <h1 id="login-heading">Sign in</h1>
        <p className="muted">
          This dashboard controls agent sessions, approvals and project access. It is not a public
          service.
        </p>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(undefined);
            api
              .login(username, password)
              .then(() => onLogin())
              .catch((caught: unknown) =>
                setError(caught instanceof Error ? caught.message : String(caught)),
              )
              .finally(() => setBusy(false));
          }}
        >
          <Field label="Admin username" required>
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </Field>
          <Field label="Admin password" required>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </Field>
          {error ? <ErrorBanner message={error} /> : null}
          <Button kind="primary" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="small muted">
          Sessions expire automatically. Login attempts are rate limited and recorded in the audit
          log.
        </p>
      </section>
    </main>
  );
};
