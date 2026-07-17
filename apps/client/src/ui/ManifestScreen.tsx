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
  if (item.kind === "mine") return "Mine";
  return ({ health: "Health", radar: "Radar", dashOvercharge: "Dash overcharge", incognito: "Incognito" } as const)[item.type];
}

function ItemList({ items }: { items: Item[] }) {
  const counts = new Map<string, { item: Item; count: number }>();
  for (const item of items) {
    const key = item.kind === "blueprint" ? `blueprint:${item.blueprintId}` : item.kind === "mine" ? "mine" : `powerup:${item.type}`;
    const current = counts.get(key);
    counts.set(key, { item, count: (current?.count ?? 0) + 1 });
  }
  if (counts.size === 0) return <span className="manifest-empty">None</span>;
  return <ul className="manifest-items">{[...counts.values()].map(({ item, count }) => (
    <li key={manifestName(item)}><span>{item.kind === "blueprint" ? "⌑" : item.kind === "mine" ? "×" : item.type === "health" ? "+" : item.type === "radar" ? "◎" : item.type === "dashOvercharge" ? "›" : "◌"}</span>{manifestName(item)} <b>×{count}</b></li>
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
        {result.persistenceStatus === "failed" ? (
          <p className="manifest-save-failed" role="alert">
            SAVE FAILED — NO EXTRACTED ITEMS WERE CREDITED. RETURN TO BASE BEFORE STARTING ANOTHER RUN.
          </p>
        ) : null}
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
          {result.outcome === "extracted" && result.lostItems.length > 0 ? (
            <div className="manifest-stash-full">
              <dt>Capacity</dt>
              <dd>STASH FULL — LOST: {result.lostItems.length}</dd>
            </div>
          ) : null}
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
          {result.contractCompletions.map((completion) => (
            <div className="manifest-contract" key={completion.contractId}>
              <dt>Contract complete</dt>
              <dd>{completion.title}<small>PAYOUT · {completion.payout.map(manifestName).join(" · ") || "STASH FULL"}</small></dd>
            </div>
          ))}
        </dl>
        <button type="button" className="manifest-new-run" onClick={onNewRun}>
          {actionLabel}
        </button>
      </div>
    </section>
  );
}
