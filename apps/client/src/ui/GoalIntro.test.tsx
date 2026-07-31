import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GoalIntro } from "./GoalIntro";

describe("goal intro", () => {
  it("states the objective without teaching every control", () => {
    const markup = renderToStaticMarkup(<GoalIntro onDismiss={() => {}} />);
    expect(markup).toContain("Protect your core at all times.");
    expect(markup).toContain(
      "Pick up Health to restore shields. Grab loot, then extract before time runs out.",
    );
    expect(markup).toContain("Enter run");
    expect(markup).not.toContain("WASD");
    expect(markup).not.toContain("Dash");
  });
});
