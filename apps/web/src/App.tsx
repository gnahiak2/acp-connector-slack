import { Component, useEffect, useState, type ReactNode } from "react";
import type { HealthSnapshot } from "@slackboard/shared";
import { api } from "./api";
import { AppLink, Button, Loading } from "./components";
import { useAsync } from "./hooks";
import { LoginPage } from "./pages/Login";
import { SessionsPage } from "./pages/Sessions";
import { SessionDetailPage } from "./pages/SessionDetail";
import { AgentsPage } from "./pages/Agents";
import { ProjectsPage } from "./pages/Projects";
import { SkillsPage } from "./pages/Skills";
import { MemoryPage } from "./pages/Memory";
import { IntegrationsPage } from "./pages/Integrations";
import { SettingsPage } from "./pages/Settings";

const usePath = (): string => {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
};

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  override render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="container" id="main">
          <div className="banner banner-error" role="alert">
            <span>The dashboard hit an unexpected error: {this.state.error.message}</span>
            <Button kind="quiet" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

const ConnectionState = ({ health }: { health: HealthSnapshot | undefined }) => {
  if (!health) {
    return <span className="connection connection-neutral">Health unavailable</span>;
  }
  const slack =
    health.slack.connected
      ? "Slack connected"
      : health.slack.configured
        ? "Slack disconnected"
        : "Slack not configured";
  const runner = health.runner.ok
    ? health.runner.type === "local"
      ? "Local runner (trusted)"
      : "Container runner"
    : "Runner unavailable";
  return (
    <div className="connection-group">
      <span className={`connection ${health.slack.connected ? "connection-ok" : "connection-warn"}`}>
        <span className="connection-dot" aria-hidden="true" />
        {slack}
      </span>
      <span className={`connection ${health.runner.ok ? "connection-ok" : "connection-bad"}`}>
        <span className="connection-dot" aria-hidden="true" />
        {runner}
      </span>
      <span className="connection connection-neutral">v{health.version}</span>
    </div>
  );
};

const navItems = [
  { href: "/", label: "Sessions" },
  { href: "/agents", label: "Agents" },
  { href: "/projects", label: "Projects" },
  { href: "/skills", label: "Skills" },
  { href: "/memory", label: "Memory" },
  { href: "/integrations", label: "Integrations" },
  { href: "/settings", label: "Settings" },
];

export const App = () => {
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  const path = usePath();

  useEffect(() => {
    api
      .sessionInfo()
      .then(() => setAuth("in"))
      .catch(() => setAuth("out"));
  }, []);

  useEffect(() => {
    const onUnauthorized = (): void => setAuth("out");
    window.addEventListener("slackboard:unauthorized", onUnauthorized);
    return () => window.removeEventListener("slackboard:unauthorized", onUnauthorized);
  }, []);

  const health = useAsync(
    (_signal) => (auth === "in" ? api.health() : Promise.resolve(undefined)),
    [auth],
  );

  useEffect(() => {
    if (auth !== "in") return;
    const timer = window.setInterval(() => health.reload(), 20_000);
    return () => window.clearInterval(timer);
  }, [auth, health]);

  if (auth === "loading") {
    return (
      <main className="container" id="main">
        <Loading label="Checking dashboard session…" />
      </main>
    );
  }

  if (auth === "out") {
    return <LoginPage onLogin={() => setAuth("in")} />;
  }

  const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path);
  let page: ReactNode;
  let active = path;
  if (sessionMatch?.[1]) {
    page = <SessionDetailPage sessionId={decodeURIComponent(sessionMatch[1])} />;
    active = "/";
  } else if (path === "/agents") page = <AgentsPage />;
  else if (path === "/projects") page = <ProjectsPage />;
  else if (path === "/skills") page = <SkillsPage />;
  else if (path === "/memory") page = <MemoryPage />;
  else if (path === "/integrations") page = <IntegrationsPage />;
  else if (path === "/settings") page = <SettingsPage />;
  else page = <SessionsPage onOpen={(id) => {
    window.history.pushState({}, "", `/sessions/${encodeURIComponent(id)}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }} />;

  return (
    <ErrorBoundary>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            sb
          </span>
          <div>
            <div className="brand-name">Slackboard</div>
            <div className="brand-sub">Agent operations</div>
          </div>
        </div>
        <div className="topbar-right">
          <ConnectionState health={health.data} />
          <Button
            kind="quiet"
            onClick={() => {
              void api.logout().finally(() => setAuth("out"));
            }}
          >
            Sign out
          </Button>
        </div>
      </header>
      <nav className="nav" aria-label="Main navigation">
        <ul>
          {navItems.map((item) => (
            <li key={item.href}>
              <AppLink
                href={item.href}
                className={`nav-link ${active === item.href ? "nav-active" : ""}`}
              >
                {item.label}
              </AppLink>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="container">
        {page}
      </main>
      <footer className="footer">
        <span>Slackboard</span>
        <span>Approvals are one-time and expire. Agent output is untrusted content.</span>
      </footer>
    </ErrorBoundary>
  );
};
