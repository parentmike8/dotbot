import { useCallback, useEffect, useMemo, useRef } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import type { DotBotEntity, DownedVerb, GameSnapshot, SimEvent } from "@dotbot/game/types";
import { bodyPrompt, downedSelf, type BodyPrompt, type DownedSelf } from "./prompt";

/**
 * Everything the two body prompts need, wired once.
 *
 * The solo surface and the network surface both show these, and both used to build
 * the reasoning inline — which is how the verb strip ended up offering a verb the
 * simulation had stopped accepting on one surface and not the other.
 */
export function useDownedPrompts(input: {
  snapshot: GameSnapshot | null;
  events: readonly SimEvent[];
  playerId: string;
  spectating: DotBotEntity | null;
  runOver: boolean;
  selectDownedVerb: (verb: DownedVerb | undefined) => void;
  takeFromBody: (fromBotId: string, index: number | "all") => void;
  setBodyAction: (action: (() => void) | null) => void;
}): { prompt: BodyPrompt; self: DownedSelf | null; onVerb: (verb: DownedVerb) => void } {
  const { snapshot, playerId, runOver, selectDownedVerb, takeFromBody, setBodyAction } = input;
  const player = snapshot?.bots.find((bot) => bot.id === playerId);

  /**
   * When the player's own last plea actually fired, from the authoritative event
   * rather than from the moment a button was pressed — a plea on cooldown is
   * silently dropped by the simulation, and a client-side timer would show a
   * cooldown that never started.
   */
  const lastPleaAtMs = useRef<number | null>(null);
  useEffect(() => {
    for (const event of input.events) {
      if (event.type === "plea" && event.botId === playerId) lastPleaAtMs.current = snapshot?.timeMs ?? 0;
    }
  }, [input.events, playerId, snapshot?.timeMs]);

  const prompt = useMemo<BodyPrompt>(() => runOver || !snapshot ? { kind: "none" } : bodyPrompt({
    viewer: player,
    bots: snapshot.bots,
    coverages: snapshot.coverages,
    config: defaultGameConfig,
  }), [player, runOver, snapshot]);

  const self = runOver || !snapshot ? null : downedSelf({
    viewer: player,
    bots: snapshot.bots,
    coverages: snapshot.coverages,
    spectating: input.spectating,
    lastPleaAtMs: lastPleaAtMs.current,
    nowMs: snapshot.timeMs,
    pleaCooldownMs: defaultGameConfig.pleaCooldownMs,
  });

  /**
   * A verb belongs to the body it was chosen for.
   *
   * It is standing state — the simulation reads it every tick, so nothing ever
   * cleared it — which meant one press of F latched for the rest of the run: every
   * body walked over afterwards started searching itself, with no input from the
   * player at all. Stepping off a body, or onto a different one, drops the verb.
   */
  const verbTarget = useRef<string | null>(null);
  const promptBodyId = prompt.kind === "none" ? null : prompt.bodyId;
  const onVerb = useCallback((verb: DownedVerb) => {
    verbTarget.current = promptBodyId;
    selectDownedVerb(verb);
  }, [promptBodyId, selectDownedVerb]);

  useEffect(() => {
    if (verbTarget.current !== null && verbTarget.current !== promptBodyId) selectDownedVerb(undefined);
    verbTarget.current = promptBodyId;
  }, [promptBodyId, selectDownedVerb]);

  // F is the body's primary action: search a closed one, empty an open one.
  useEffect(() => {
    if (prompt.kind === "verbs") setBodyAction(() => onVerb("loot"));
    else if (prompt.kind === "picker") setBodyAction(() => takeFromBody(prompt.bodyId, "all"));
    else setBodyAction(null);
    return () => setBodyAction(null);
  }, [onVerb, prompt, setBodyAction, takeFromBody]);

  return { prompt, self, onVerb };
}
