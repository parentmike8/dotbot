import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DownedSelfView } from "./DownedPrompts";
import { KillCamOverlay } from "./KillCamOverlay";

describe("kill cam downed controls", () => {
  it("keeps skip, plea, and leave available together", () => {
    const html = renderToStaticMarkup(
      <>
        <KillCamOverlay label="DOWNED BY QUETZAL · DASH" progress={0.5} onSkip={() => undefined} />
        <DownedSelfView
          self={{ beingRevived: false, rescuers: 1, watching: "Mate", pleaReady: true, pleaReadyInMs: 0 }}
          onPlea={() => undefined}
          onLeave={() => undefined}
        />
      </>,
    );
    expect(html).toContain("SKIP");
    expect(html).toContain("PLEA");
    expect(html).toContain("LEAVE RUN");
  });
});
