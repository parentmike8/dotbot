import { useEffect, useState } from "react";
import { LobbyApp } from "./LobbyApp";
import { PublicQuickPlayApp } from "./PublicQuickPlayApp";
import { selectDeploymentMode, type PublicQuickPlayConfig } from "../publicQuickPlayMachine";
import "./lobby.css";

type DeploymentAppProps = {
  embedded?: boolean;
  onReturnToBase?: () => void;
};

export function DeploymentApp({ embedded = false, onReturnToBase }: DeploymentAppProps) {
  const [config, setConfig] = useState<PublicQuickPlayConfig | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/game-config", { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as PublicQuickPlayConfig : {})
      .catch(() => ({} as PublicQuickPlayConfig))
      .then((value) => { if (active) setConfig(value); });
    return () => { active = false; };
  }, []);

  if (config === null) {
    return (
      <main className={embedded ? "deployment-shell" : "lobby-shell"}>
        <section className="lobby-card public-queue-card" aria-label="Deployment status">
          <span className="lobby-kicker">Deployment</span>
          <h1>Linking.</h1>
          <p className="public-queue-status" role="status" aria-live="polite">CHECKING DEPLOYMENT CHANNEL</p>
        </section>
      </main>
    );
  }

  if (selectDeploymentMode(config) === "public") {
    return <PublicQuickPlayApp embedded={embedded} config={config} onReturnToBase={onReturnToBase} />;
  }
  return <LobbyApp embedded={embedded} onReturnToBase={onReturnToBase} />;
}
