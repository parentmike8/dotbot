import { useEffect, useRef } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import { AO_ALPHA, SHADOW_ALPHA, V, type ShadowPad } from "../game/renderer/model/tone";
import { swayOffset } from "./worlds/motion";
import { VIGNETTES, type WorldLayers, type Vignette } from "./worlds/vignettes";

/**
 * World lab: three candidate regions, side by side, drawn in the production language.
 *
 * `?worlds` selects it. Like `?lab` it is deliberately not a game surface — no
 * simulation, no input, no netcode — so a region can be redrawn and screenshotted
 * without a match running. Unlike `?lab` it does run a ticker, because a region whose
 * water is frozen cannot be judged.
 *
 *   ?worlds                 all three, stacked
 *   ?worlds&pick=temple     one, full width
 *   ?worlds&still=1         no ticker, for a clean still
 *   ?worlds&shots=1         write a PNG per region to tmp/lab/
 */

type Params = {
  pick: string | null;
  still: boolean;
  shots: boolean;
};

function readParams(search: string): Params {
  const p = new URLSearchParams(search);
  return {
    pick: p.get("pick"),
    still: p.get("still") === "1",
    shots: p.get("shots") === "1",
  };
}

function makePad(alphas: readonly number[]): ShadowPad {
  return alphas.map((alpha) => {
    const g = new Graphics();
    g.alpha = alpha;
    return g;
  });
}

type Built = {
  vignette: Vignette;
  view: Container;
  layers: WorldLayers;
  /** Crowns and other overhead masses, held so they can sway without a redraw. */
  swayers: { node: Container; id: string }[];
};

/**
 * Build one region into a container, in the layer order the game itself uses.
 *
 * Ground, then cast shadow, then ambient occlusion, then the moving layer, then solids,
 * then actors, then overhead. That order is the whole reason a canopy can be drawn over
 * a DotBot and a shadow cannot.
 */
function build(vignette: Vignette): Built {
  const view = new Container();
  const ground = new Graphics();
  const shadow = makePad(SHADOW_ALPHA);
  const ao = makePad(AO_ALPHA);
  const motion = new Graphics();
  const solids = new Graphics();
  const actors = new Graphics();
  const overhead = new Container();

  const layers: WorldLayers = { ground, shadow, solids, motion, actors, overhead };
  vignette.draw(layers);

  view.addChild(ground);
  for (const layer of shadow) view.addChild(layer);
  for (const layer of ao) view.addChild(layer);
  view.addChild(motion);
  view.addChild(solids);
  view.addChild(actors);
  view.addChild(overhead);

  // Everything overhead sways, generically, from its own label. No vignette has to
  // remember to register anything, which is why the label lives on the node.
  const swayers = overhead.children.map((node) => ({
    node: node as Container,
    id: (node as Container).label ?? "sway",
  }));

  return { vignette, view, layers, swayers };
}

/** A caption under each region: what it is, what it asks for, how you get around. */
function caption(vignette: Vignette, width: number): Container {
  const box = new Container();
  const title = new Text({
    text: vignette.title.toUpperCase(),
    style: { fontFamily: "system-ui, sans-serif", fontSize: 26, fontWeight: "700", fill: 0x14171a, letterSpacing: 3 },
  });
  title.position.set(0, 0);
  box.addChild(title);

  const strap = new Text({
    text: vignette.strapline,
    style: { fontFamily: "system-ui, sans-serif", fontSize: 17, fill: 0x3d4247, wordWrap: true, wordWrapWidth: width - 40 },
  });
  strap.position.set(0, 34);
  box.addChild(strap);

  const asks = new Text({
    text: `LANDMARKS\n${vignette.landmarks.map((mark) => `·  ${mark}`).join("\n")}`,
    style: { fontFamily: "system-ui, sans-serif", fontSize: 14, fill: 0x5a6066, lineHeight: 21, wordWrap: true, wordWrapWidth: (width - 60) / 2 },
  });
  asks.position.set(0, 74);
  box.addChild(asks);

  const move = new Text({
    text: `WHAT IT ASKS THE ENGINE FOR\n${vignette.asks.map((ask) => `·  ${ask}`).join("\n")}`,
    style: { fontFamily: "system-ui, sans-serif", fontSize: 14, fill: 0x5a6066, lineHeight: 21, wordWrap: true, wordWrapWidth: (width - 60) / 2 },
  });
  move.position.set(width / 2 + 10, 74);
  box.addChild(move);

  return box;
}

export function WorldLab() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const params = readParams(window.location.search);
    let app: Application | null = null;
    let disposed = false;

    void (async () => {
      const created = new Application();
      await created.init({
        background: 0xeef0f2,
        antialias: true,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        autoDensity: true,
        width: host.clientWidth || 1600,
        height: host.clientHeight || 1000,
        preference: "webgl",
      });
      if (disposed) {
        created.destroy(true);
        return;
      }
      app = created;
      created.canvas.style.width = "100%";
      created.canvas.style.height = "100%";
      created.canvas.style.display = "block";
      host.appendChild(created.canvas);
      // The ticker is driven by hand below, so pixi's own render loop stays off and a
      // still capture is a single deterministic frame rather than whatever was on screen.
      created.ticker.autoStart = false;
      created.ticker.stop();

      const chosen = params.pick
        ? VIGNETTES.filter((v) => v.id === params.pick)
        : VIGNETTES;
      const built = chosen.map(build);

      const CAPTION_H = 190;
      const PAD = 34;

      const stage = new Container();
      created.stage.addChild(stage);

      const layout = (viewW: number): { scale: number; height: number } => {
        const width = Math.max(1, viewW - PAD * 2);
        const first = built[0].vignette;
        const scale = width / first.width;
        const height = built.reduce((sum, b) => sum + b.vignette.height * scale + CAPTION_H + PAD, PAD);
        return { scale, height };
      };

      const compose = (viewW: number): number => {
        stage.removeChildren();
        const { scale } = layout(viewW);
        let y = PAD;
        for (const b of built) {
          const frame = new Container();
          frame.position.set(PAD, y);
          frame.scale.set(scale);

          // A literal border, because the sheet's own edge is a value in the world and a
          // frame drawn as a shadow would read as terrain.
          const edge = new Graphics();
          edge.rect(-2, -2, b.vignette.width + 4, b.vignette.height + 4)
            .stroke({ color: 0x9aa0a6, width: 2 / scale });
          frame.addChild(edge);
          frame.addChild(b.view);
          stage.addChild(frame);

          const cap = caption(b.vignette, b.vignette.width * scale);
          cap.position.set(PAD, y + b.vignette.height * scale + 16);
          stage.addChild(cap);

          y += b.vignette.height * scale + CAPTION_H + PAD;
        }
        return layout(viewW).height;
      };

      let scrollY = 0;
      let contentH = compose(created.renderer.width);

      const frame = (tMs: number): void => {
        for (const b of built) {
          b.layers.motion.clear();
          b.vignette.animate?.(b.layers, tMs);
          for (const swayer of b.swayers) {
            const offset = swayOffset(swayer.id, tMs);
            swayer.node.position.set(offset.x, offset.y);
          }
        }
        stage.position.y = -scrollY;
        created.render();
      };

      if (params.shots) {
        // One PNG per region, each at its own native size so nothing is judged through a
        // downscale. Written to tmp/lab/ by the dev-only plugin `?lab` already uses.
        const results: string[] = [];
        for (const b of built) {
          const solo = new Container();
          solo.addChild(b.view);
          created.stage.removeChildren();
          created.stage.addChild(solo);
          created.renderer.resize(b.vignette.width, b.vignette.height);
          b.layers.motion.clear();
          b.vignette.animate?.(b.layers, 2_400);
          created.render();
          const png = created.canvas.toDataURL("image/png");
          const response = await fetch("/__lab/shot", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: `world-${b.vignette.id}`, png }),
          });
          const body = await response.json() as { ok?: boolean; error?: string };
          results.push(`${b.vignette.id}: ${body.ok ? "ok" : `FAILED ${body.error ?? ""}`}`);
        }
        (window as unknown as { worldShots?: string[] }).worldShots = results;
        return;
      }

      frame(params.still ? 2_400 : 0);

      if (!params.still) {
        const start = performance.now();
        const loop = (): void => {
          if (disposed) return;
          frame(performance.now() - start);
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }

      const observer = new ResizeObserver(() => {
        created.renderer.resize(host.clientWidth, host.clientHeight);
        contentH = compose(created.renderer.width);
        frame(params.still ? 2_400 : performance.now());
      });
      observer.observe(host);
      (created as unknown as { __observer?: ResizeObserver }).__observer = observer;

      host.addEventListener("wheel", (event) => {
        event.preventDefault();
        const max = Math.max(0, contentH - created.renderer.height);
        scrollY = Math.max(0, Math.min(max, scrollY + event.deltaY));
        if (params.still) frame(2_400);
      }, { passive: false });

      void V;
    })();

    return () => {
      disposed = true;
      const held = app as unknown as { __observer?: ResizeObserver } | null;
      held?.__observer?.disconnect();
      app?.destroy(true, { children: true });
    };
  }, []);

  return <div ref={hostRef} style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#eef0f2" }} />;
}
