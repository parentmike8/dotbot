import type { RunResult } from "../game/useDotBotGame";

type ManifestScreenProps = {
  result: RunResult;
  aiKills: number;
  playerKills: number;
  runTime: string;
  onNewRun: () => void;
  actionLabel?: string;
};

const outcomeLabels: Record<RunResult["outcome"], string> = {
  extracted: "EXTRACTED",
  died: "CONSUMED",
  timeout: "RUN EXPIRED",
};

export function ManifestScreen({ result, aiKills, playerKills, runTime, onNewRun, actionLabel = "↻ NEW RUN" }: ManifestScreenProps) {
  return (
    <section className="manifest-overlay" aria-label="Run manifest">
      <div className="manifest-panel">
        <header className="manifest-header">
          <span>DOTBOT / RUN MANIFEST</span>
          <strong>{outcomeLabels[result.outcome]}</strong>
        </header>
        <dl className="manifest-grid">
          <div>
            <dt>Outcome</dt>
            <dd>{outcomeLabels[result.outcome]}</dd>
          </div>
          <div>
            <dt>Kept</dt>
            <dd>{result.outcome === "extracted" ? result.keptDots : 0}</dd>
          </div>
          <div>
            <dt>Lost</dt>
            <dd>{result.lostDots}</dd>
          </div>
          <div>
            <dt>Kills</dt>
            <dd className="manifest-kills">
              <span>AI {aiKills}</span>
              <span>PLAYERS {playerKills}</span>
            </dd>
          </div>
          <div>
            <dt>Run time</dt>
            <dd>{runTime}</dd>
          </div>
        </dl>
        <button type="button" className="manifest-new-run" onClick={onNewRun}>
          {actionLabel}
        </button>
      </div>
    </section>
  );
}
