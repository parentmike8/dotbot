import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DownedSelfView } from "./DownedPrompts";
import { KillCamOverlay } from "./KillCamOverlay";

describe("kill cam downed controls", () => {
  it("keeps close, replay, plea, and leave available in the downed view", () => {
    const html = renderToStaticMarkup(
      <>
        <KillCamOverlay
          open
          viewportRef={createRef<HTMLDivElement>()}
          label="DOWNED BY QUETZAL · DASH"
          progress={0.5}
          onClose={() => undefined}
        />
        <DownedSelfView
          self={{ beingRevived: false, rescuers: 1, watching: "Mate", pleaReady: true, pleaReadyInMs: 0 }}
          onPlea={() => undefined}
          onLeave={() => undefined}
          onReplay={() => undefined}
          replayAvailable
        />
      </>,
    );
    expect(html).toContain("CLOSE");
    expect(html).toContain("kill-cam-viewport");
    expect(html).toContain("PLEA");
    expect(html).toContain("REPLAY");
    expect(html).toContain("LEAVE RUN");
  });
});
