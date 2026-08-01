import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunResult } from "../game/useDotBotGame";
import { ManifestScreen } from "./ManifestScreen";

function result(persistenceStatus: RunResult["persistenceStatus"]): RunResult {
  return {
    outcome: "extracted",
    keptItems: [],
    lostItems: [],
    learnedBlueprints: [],
    contractCompletions: [],
    persistenceStatus,
    runTimeMs: 1_000,
  };
}

describe("run manifest settlement fencing", () => {
  it("blocks a new run after authoritative settlement failed", () => {
    const markup = renderToStaticMarkup(
      <ManifestScreen
        result={result("failed")}
        aiKills={0}
        playerKills={0}
        runTime="0:01"
        onNewRun={() => {}}
        actionLabel="DEPLOY AGAIN"
        secondaryActionLabel="SET LOADOUT / RETURN TO BASE"
        onSecondaryAction={() => {}}
      />,
    );

    expect(markup).toContain("SAVE FAILED");
    expect(markup).toContain('<button type="button" class="manifest-new-run" disabled="">DEPLOY AGAIN</button>');
    expect(markup).toContain("SET LOADOUT / RETURN TO BASE");
  });

  it("keeps a new run available after settlement succeeds", () => {
    const markup = renderToStaticMarkup(
      <ManifestScreen
        result={result("saved")}
        aiKills={0}
        playerKills={0}
        runTime="0:01"
        onNewRun={() => {}}
        actionLabel="DEPLOY AGAIN"
      />,
    );

    expect(markup).toContain('<button type="button" class="manifest-new-run">DEPLOY AGAIN</button>');
  });
});
