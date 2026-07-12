import type { RunResult } from "../game/useDotBotGame";
import type { Item } from "@dotbot/game/types";

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

function manifestName(item: Item): string {
  if (item.kind === "blueprint") return `Blueprint / ${item.blueprintId}`;
  return ({ health: "Health", radar: "Radar", dashOvercharge: "Dash overcharge", incognito: "Incognito" } as const)[item.type];
}

function ItemList({ items }: { items: Item[] }) {
  const counts = new Map<string, { item: Item; count: number }>();
  for (const item of items) {
    const key = item.kind === "blueprint" ? `blueprint:${item.blueprintId}` : `powerup:${item.type}`;
    const current = counts.get(key);
    counts.set(key, { item, count: (current?.count ?? 0) + 1 });
  }
  if (counts.size === 0) return <span className="manifest-empty">None</span>;
  return <ul className="manifest-items">{[...counts.values()].map(({ item, count }) => (
    <li key={manifestName(item)}><span>{item.kind === "blueprint" ? "⌑" : item.type === "health" ? "+" : item.type === "radar" ? "◎" : item.type === "dashOvercharge" ? "›" : "◌"}</span>{manifestName(item)} <b>×{count}</b></li>
  ))}</ul>;
}

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
            <dd><ItemList items={result.keptItems} /></dd>
          </div>
          <div>
            <dt>Lost</dt>
            <dd><ItemList items={result.lostItems} /></dd>
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
          {result.learnedBlueprints.length > 0 ? (
            <div className="manifest-learned">
              <dt>Learned</dt>
              <dd>{result.learnedBlueprints.map((blueprintId) => `${blueprintId} blueprint`).join(", ")}</dd>
            </div>
          ) : null}
        </dl>
        <button type="button" className="manifest-new-run" onClick={onNewRun}>
          {actionLabel}
        </button>
      </div>
    </section>
  );
}
