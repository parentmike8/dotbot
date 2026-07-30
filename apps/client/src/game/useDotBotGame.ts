import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import { getKeyboardVector, mergeMoveVectors, movementKeyCodes } from "./input";
import { clamp, normalizeInputVector } from "@dotbot/game/math";
import { GameRenderer, type InteractionChannelVisual } from "./renderer/GameRenderer";
import {
  KillCamPlayback,
  killCamCameraTarget,
  killCamDoorCatalog,
  killCamSnapshot,
  liveStateEndsKillCam,
} from "./killCam";
import {
  ImpactFeedback,
  loadFeedbackPreferences,
  saveFeedbackPreferences,
  type AudioFeedbackStatus,
  type FeedbackPreferences,
  type ImpactPerspective,
} from "./feedback/ImpactFeedback";
import { earshotGain } from "./feedback/earshot";
import { selectSpectatedBot } from "./spectate";
import { createSession } from "./session/createSession";
import type { GameSession } from "./session/GameSession";
import type { BayIndex, DotBotEntity, DownedVerb, GameSnapshot, InputCommand, Item, MapDocument, PingKind, SimEvent, TakeCommand, Vec2 } from "@dotbot/game/types";
import { CLICK_PING_KIND, collectPings, type LiveMark } from "./pings";
import type { NetworkDebugStats } from "./session/netgraph";
import { WORLD_MAP_PING_FLOOR } from "./worldMap/worldMap";
import type { EntityMeta, KillCamClip } from "@dotbot/protocol";
import { initialHudOverlays, transitionHudOverlay, type HudOverlayEvent } from "./hudOverlayLifecycle";

export type RunOutcome = "extracted" | "died" | "timeout";

export type RunResult = {
  outcome: RunOutcome;
  keptItems: Item[];
  lostItems: Item[];
  learnedBlueprints: string[];
  contractCompletions: Array<{ contractId: string; title: string; payout: Item[] }>;
  persistenceStatus?: "saved" | "failed";
  runTimeMs: number;
};

export type KillCamView = {
  clip: KillCamClip;
  progress: number;
  label: string;
};

type JoystickState = {
  active: boolean;
  pointerId: number | null;
  origin: Vec2;
  knob: Vec2;
  move: Vec2;
};

const joystickRadius = 54;

function isEditableTarget(event: KeyboardEvent): boolean {
  const element = event.target as HTMLElement | null;
  return Boolean(
    element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable),
  );
}

const emptyJoystick: JoystickState = {
  active: false,
  pointerId: null,
  origin: { x: 0, y: 0 },
  knob: { x: 0, y: 0 },
  move: { x: 0, y: 0 },
};

type UseDotBotGameOptions = {
  session?: GameSession;
  map?: MapDocument;
  spectate?: boolean;
  worldMapEnabled?: boolean;
};

export function useDotBotGame(options: UseDotBotGameOptions = {}) {
  const providedSession = options.session;
  const requestedMap = options.map ?? downtownMap;
  const spectateEnabled = options.spectate ?? false;
  const worldMapEnabledRef = useRef(options.worldMapEnabled ?? true);
  worldMapEnabledRef.current = options.worldMapEnabled ?? true;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const killCamPlaybackRef = useRef<KillCamPlayback | null>(null);
  const killCamObservedDownedRef = useRef(false);
  const killCamDoorsRef = useRef<ReturnType<typeof killCamDoorCatalog>>([]);
  const feedbackRef = useRef<ImpactFeedback | null>(null);
  const keysRef = useRef(new Set<string>());
  const joystickRef = useRef<JoystickState>(emptyJoystick);
  const dashQueuedRef = useRef(false);
  const useBayQueuedRef = useRef<BayIndex | undefined>(undefined);
  const swapQueuedRef = useRef<{ bayIndex: BayIndex; holdIndex: number } | undefined>(undefined);
  const dropQueuedRef = useRef<InputCommand["drop"]>(undefined);
  const downedVerbRef = useRef<DownedVerb | undefined>(undefined);
  const takeQueuedRef = useRef<TakeCommand | undefined>(undefined);
  const pleaQueuedRef = useRef(false);
  const longPressRef = useRef<number | null>(null);
  /**
   * Squad marks live in a ref for the loop and in state for the overlay.
   *
   * The loop reads and rewrites them every frame; React state alone would re-render the
   * whole tree 60 times a second. The state copy exists only so a picker can be positioned
   * and the marks counted — it is set from the ref, never the other way round.
   */
  const pingQueuedRef = useRef<InputCommand["ping"]>(undefined);
  const marksRef = useRef<LiveMark[]>([]);
  const [pingPicker, setPingPicker] = useState<{ screen: Vec2; world: Vec2; floorId?: string } | null>(null);
  const worldMapOpenRef = useRef(false);
  const [worldMapVisible, setWorldMapVisible] = useState(false);
  const spectateCycleQueuedRef = useRef(false);
  const spectatedBotIdRef = useRef<string | null>(null);
  const runEndedRef = useRef(false);
  const interactionChannelRef = useRef<InteractionChannelVisual | null>(null);
  /**
   * What F does to the body underfoot. Search when it is closed, take everything
   * when it is open — one key, because the second press is the obvious next thing
   * to want and a phone has no room for a third.
   *
   * The overlay sets it, for the same reason it sets the interaction channel: only
   * the overlay knows which body is in reach and whether it has been searched, and
   * a second copy of that reasoning in here is a second copy that can disagree.
   */
  const bodyActionRef = useRef<(() => void) | null>(null);
  const pendingDraftsRef = useRef<string[]>([]);
  const interactionVisibilityRef = useRef<ReadonlySet<string> | null>(null);
  const placementVisibilityRef = useRef<boolean | null>(null);
  const frameRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [spectating, setSpectating] = useState<DotBotEntity | null>(null);
  const [killCam, setKillCam] = useState<KillCamView | null>(null);
  const [debugVisible, setDebugVisible] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("netgraph"),
  );
  const [networkDebug, setNetworkDebug] = useState<NetworkDebugStats | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [inventoryVisible, setInventoryVisible] = useState(false);
  const hudOverlaysRef = useRef(initialHudOverlays);
  const [joystickView, setJoystickView] = useState(emptyJoystick);
  const [feedbackPreferences, setFeedbackPreferences] = useState(loadFeedbackPreferences);
  const [audioStatus, setAudioStatus] = useState<AudioFeedbackStatus>(
    () => feedbackPreferences.sound ? "idle" : "off",
  );
  const feedbackPreferencesRef = useRef(feedbackPreferences);

  const resetJoystick = useCallback(() => {
    joystickRef.current = emptyJoystick;
    setJoystickView(emptyJoystick);
  }, []);

  const clearMovementInput = useCallback(() => {
    keysRef.current.clear();
    resetJoystick();
  }, [resetJoystick]);

  const applyHudOverlayEvent = useCallback((event: HudOverlayEvent) => {
    const next = transitionHudOverlay(hudOverlaysRef.current, event);
    hudOverlaysRef.current = next;
    worldMapOpenRef.current = next.worldMap;
    setWorldMapVisible(next.worldMap);
    setSettingsVisible(next.settings);
    setInventoryVisible(next.inventory);
    if (!next.worldMap) setPingPicker(null);
  }, []);

  const setWorldMapOpen = useCallback((visible: boolean) => {
    const nextVisible = visible && worldMapEnabledRef.current;
    applyHudOverlayEvent(nextVisible ? "openWorldMap" : "closeWorldMap");
    setPingPicker(null);
    if (nextVisible) {
      clearMovementInput();
      dashQueuedRef.current = false;
      useBayQueuedRef.current = undefined;
      swapQueuedRef.current = undefined;
      downedVerbRef.current = undefined;
      takeQueuedRef.current = undefined;
      pleaQueuedRef.current = false;
      pingQueuedRef.current = undefined;
      spectateCycleQueuedRef.current = false;
      if (longPressRef.current !== null) {
        window.clearTimeout(longPressRef.current);
        longPressRef.current = null;
      }
    }
  }, [applyHudOverlayEvent, clearMovementInput]);

  useEffect(() => {
    let disposed = false;
    let lastFrame = performance.now();
    let lastHudUpdate = 0;
    let frameCounter = 0;
    let fpsWindowStart = lastFrame;
    let fps = 0;
    let playerSquadId: string | null = null;
    let resizeObserver: ResizeObserver | undefined;
    const feedback = new ImpactFeedback(feedbackPreferencesRef.current, {
      onAudioStatusChange: (status) => {
        if (!disposed) setAudioStatus(status);
      },
    });
    feedbackRef.current = feedback;

    async function start() {
      const host = hostRef.current;

      if (!host) {
        return;
      }

      const session = providedSession ?? createSession("local", {
        map: requestedMap,
        config: defaultGameConfig,
        playerId: "player",
      });
      await session.start();
      const renderer = await GameRenderer.create(host, session.map);
      killCamDoorsRef.current = killCamDoorCatalog(session.map);
      renderer.setReducedMotion(feedbackPreferencesRef.current.reducedMotion);

      if (disposed) {
        feedback.destroy();
        renderer.destroy();
        session.dispose();
        return;
      }

      sessionRef.current = session;
      rendererRef.current = renderer;
      for (const objectId of pendingDraftsRef.current.splice(0)) renderer.draftObject(objectId);
      if (interactionVisibilityRef.current) {
        renderer.setInteractionDotsVisible(interactionVisibilityRef.current);
      }
      if (placementVisibilityRef.current !== null) {
        renderer.setPlacementSlotsVisible(placementVisibilityRef.current);
      }
      const initialSnapshot = session.update(0);
      setSnapshot(initialSnapshot);
      playerSquadId = initialSnapshot?.bots.find((bot) => bot.id === session.playerId)?.squadId ?? null;

      resizeObserver = new ResizeObserver(([entry]) => {
        renderer.resize(entry.contentRect.width, entry.contentRect.height);
      });
      resizeObserver.observe(host);

      const loop = (now: number) => {
        if (disposed) {
          return;
        }

        const frameWorkStartedAt = performance.now();
        const elapsedMs = now - lastFrame;
        lastFrame = now;
        frameCounter += 1;

        if (now - fpsWindowStart >= 500) {
          fps = Math.round((frameCounter * 1000) / (now - fpsWindowStart));
          fpsWindowStart = now;
          frameCounter = 0;
        }

        if (runEndedRef.current) {
          session.sendInput({ move: { x: 0, y: 0 }, dash: false });
        } else if (worldMapOpenRef.current) {
          // The match continues, but the map is a focus-taking surface. The
          // only action it may emit is its deliberate exterior ping.
          session.sendInput({
            move: { x: 0, y: 0 },
            dash: false,
            ping: pingQueuedRef.current,
          });
        } else {
          const keyboardMove = getKeyboardVector(keysRef.current);
          const joystickMove = joystickRef.current.move;
          session.sendInput({
            move: mergeMoveVectors(keyboardMove, joystickMove),
            dash: dashQueuedRef.current,
            useBay: useBayQueuedRef.current,
            swapBay: swapQueuedRef.current,
            drop: dropQueuedRef.current,
            downedVerb: downedVerbRef.current,
            take: takeQueuedRef.current,
            plea: pleaQueuedRef.current,
            ping: pingQueuedRef.current,
          });
        }
        dashQueuedRef.current = false;
        useBayQueuedRef.current = undefined;
        swapQueuedRef.current = undefined;
        dropQueuedRef.current = undefined;
        takeQueuedRef.current = undefined;
        pleaQueuedRef.current = false;
        pingQueuedRef.current = undefined;
        session.setMeasuredFps?.(fps);
        const nextSnapshot = session.update(elapsedMs);
        for (const clip of session.drainKillCams?.() ?? []) {
          if (clip.victimId !== session.playerId) continue;
          killCamPlaybackRef.current = new KillCamPlayback(clip);
          killCamObservedDownedRef.current = false;
          // Replay owns every focus-taking HUD surface, including inventory.
          // Plea and Leave are separate downed controls and stay mounted.
          dropQueuedRef.current = undefined;
          applyHudOverlayEvent("startReplay");
          session.setReplayActive?.(true);
        }
        const frameEvents = session.drainEvents();
        const framePlayer = nextSnapshot?.bots.find((bot) => bot.id === session.playerId);
        if (framePlayer && playerSquadId !== null && framePlayer.squadId !== playerSquadId) {
          marksRef.current = [];
          rendererRef.current?.setSquadMarks([]);
        }
        if (framePlayer) playerSquadId = framePlayer.squadId;
        const uiEvents = frameEvents.filter((event) => event.type !== "hit");
        if (uiEvents.length > 0) setEvents((current) => [...current, ...uiEvents]);

        /**
         * A mark arriving is announced, and only somebody else's.
         *
         * Your own click already had its feedback — you clicked. The cue exists so a
         * squadmate knows one landed without looking at the map, so firing it for the placer
         * would just make marking noisy for the one person who does not need telling.
         *
         * Panned by which side of the screen it is on, so the sound carries a rough direction
         * before you look for the pin.
         *
         * NOT gated by earshot, unlike an impact, and the difference is the point of the
         * feature rather than an oversight. A hit is a sound the world makes and you happen
         * to be near; a mark is a squadmate TELLING you about somewhere, and the somewhere
         * they most need to tell you about is the one you cannot see. Earshot on this would
         * silence it exactly when it matters.
         */
        for (const event of frameEvents) {
          if (event.type !== "pinged") continue;
          const mine = event.botId === (providedSession?.playerId ?? "player");
          if (mine) continue;
          const viewer = nextSnapshot?.bots.find((bot) => bot.id === (providedSession?.playerId ?? "player"));
          const pan = viewer ? clamp((event.position.x - viewer.position.x) / 600, -1, 1) : 0;
          feedbackRef.current?.playPing(event.kind, pan);
        }

        const nextMarks = collectPings(marksRef.current, frameEvents, now);
        if (nextMarks !== marksRef.current) marksRef.current = nextMarks;
        rendererRef.current?.setSquadMarks(nextMarks);

        if (!nextSnapshot) {
          session.recordClientFrame?.(elapsedMs, performance.now() - frameWorkStartedAt);
          frameRef.current = requestAnimationFrame(loop);
          return;
        }

        /**
         * Where the ears are: the bot the camera is following, which is your own body
         * until you go down and a squadmate's after that.
         *
         * Not `session.playerId`, which is what the panning used to use. While spectating
         * those are different bots in different regions, so a sound got its direction from
         * a body lying somewhere the player cannot even see. One listener, used for both
         * the pan and the earshot, so the two can never disagree about where "here" is.
         */
        const listenerId = spectatedBotIdRef.current ?? session.playerId;
        const listener = nextSnapshot.bots.find((bot) => bot.id === listenerId)?.position
          ?? nextSnapshot.bots.find((bot) => bot.id === session.playerId)?.position;
        const view = renderer.visibleWorldBounds();

        const predictedImpacts = session.drainPredictedImpacts?.() ?? [];
        for (const impact of predictedImpacts) {
          const result = renderer.queueImpact(impact, nextSnapshot);
          const pan = impactPan(listener, { x: impact.x, y: impact.y });
          if (impact.kind === "hit" && result) {
            feedback.playPredicted(result, pan);
          } else if (impact.kind !== "hit") {
            feedback.playDashContact(impact.kind, "attacker", false, pan);
          }
        }
        for (const event of frameEvents) {
          if (event.type === "plea") renderer.queuePlea(event);
          if (event.type === "mineSensor") renderer.queueMineSensor(event);
          if (event.type === "dashContact") {
            const alreadyPredicted = renderer.queueDashContact(event, session.playerId);
            const perspective: ImpactPerspective = event.byBotId === session.playerId
              ? "attacker"
              : event.botId === session.playerId
                ? "victim"
                : "observer";
            const earshot = perspective === "observer" && listener
              ? earshotGain(event.position, listener, view)
              : 1;
            feedback.playDashContact(
              event.result,
              perspective,
              alreadyPredicted,
              impactPan(listener, event.position),
              earshot,
            );
          }
          if (event.type === "hit") {
            const alreadyPredicted = renderer.confirmImpact(event, nextSnapshot, session.playerId);
            const perspective: ImpactPerspective = event.byBotId === session.playerId
              ? "attacker"
              : event.botId === session.playerId
                ? "victim"
                : "observer";
            const worldPoint = event.tick > 0 || event.position.x !== 0 || event.position.y !== 0
              ? event.position
              : nextSnapshot.bots.find((bot) => bot.id === event.botId)?.position ?? event.position;
            /**
             * Somebody else's fight is only heard from within earshot; your own is always
             * audible, because you are standing at one end of it.
             *
             * Note where this gate is NOT: the two renderer calls above it. A hit outside
             * earshot still leaves its mark and still reaches the kill feed. Silencing the
             * sound is the fix; dropping the event would be a different bug, and one that
             * would make a squadmate's death across the map simply not happen.
             */
            const earshot = perspective === "observer" && listener
              ? earshotGain(worldPoint, listener, view)
              : 1;
            feedback.playConfirmed(
              event.result,
              perspective,
              alreadyPredicted,
              impactPan(listener, worldPoint),
              earshot,
            );
          }
        }

        const currentPlayer = nextSnapshot.bots.find((bot) => bot.id === session.playerId);
        if (currentPlayer?.state === "downed") killCamObservedDownedRef.current = true;
        const authorityRevived = frameEvents.some((event) =>
          (event.type === "revived" || event.type === "recruited")
          && event.botId === session.playerId);
        if (killCamPlaybackRef.current && liveStateEndsKillCam(
          killCamObservedDownedRef.current,
          currentPlayer?.state,
          authorityRevived,
        )) {
          killCamPlaybackRef.current.skip();
          killCamPlaybackRef.current = null;
          killCamObservedDownedRef.current = false;
          session.setReplayActive?.(false);
          applyHudOverlayEvent("endReplay");
          setKillCam(null);
        }
        if (currentPlayer) playerSquadId = currentPlayer.squadId;
        const runState = session.getRunState();

        if (!runEndedRef.current && runState.phase === "over") {
          const result: RunResult = {
            outcome: runState.reason,
            keptItems: runState.keptItems,
            lostItems: runState.lostItems,
            learnedBlueprints: runState.learnedBlueprints,
            contractCompletions: runState.contractCompletions ?? [],
            persistenceStatus: runState.persistenceStatus,
            runTimeMs: nextSnapshot.timeMs,
          };
          runEndedRef.current = true;
          keysRef.current.clear();
          joystickRef.current = emptyJoystick;
          setJoystickView(emptyJoystick);
          setRunResult(result);
          applyHudOverlayEvent("closeInventory");
        }

        // Watching begins the moment you go down, not when the run ends: you
        // follow a squadmate who is still up, and once none are the camera falls
        // back to your own body — where you can still plea.
        const watching = spectateEnabled && (runState.phase === "over" || currentPlayer?.state === "downed");
        const livingSquadmates = watching && playerSquadId
          ? nextSnapshot.bots.filter((bot) => bot.id !== session.playerId && bot.squadId === playerSquadId && bot.state === "alive")
          : [];
        const spectator = selectSpectatedBot(livingSquadmates, spectatedBotIdRef.current, spectateCycleQueuedRef.current);
        spectateCycleQueuedRef.current = false;
        spectatedBotIdRef.current = spectator?.id ?? null;
        let renderPlayerId = spectator?.id ?? session.playerId;
        let renderSnapshot = nextSnapshot;
        let killCamRender: {
          clip: KillCamClip;
          progress: number;
          cameraTarget: Vec2;
          sourceVisible: boolean;
        } | undefined;
        const playback = killCamPlaybackRef.current;
        if (playback) {
          playback.advance(elapsedMs);
          if (playback.finished) {
            killCamPlaybackRef.current = null;
            killCamObservedDownedRef.current = false;
            session.setReplayActive?.(false);
            applyHudOverlayEvent("endReplay");
            setKillCam(null);
          } else {
            const replayFrame = playback.sample();
            const ids = [playback.clip.victimId, playback.clip.sourceBotId]
              .filter((id): id is string => id !== undefined);
            const meta = new Map<string, EntityMeta>();
            for (const id of ids) {
              const known = session.getEntityMeta?.(id);
              if (known) {
                meta.set(id, known);
                continue;
              }
              const live = nextSnapshot.bots.find((bot) => bot.id === id);
              if (live) {
                meta.set(id, {
                  id,
                  name: live.name,
                  squadId: live.squadId,
                  isAmbient: live.isAmbient,
                  maxShields: live.maxShields,
                  radius: live.radius,
                  color: live.color,
                });
              }
            }
            renderSnapshot = killCamSnapshot(replayFrame, playback.clip, meta, killCamDoorsRef.current);
            renderPlayerId = session.playerId;
            killCamRender = {
              clip: playback.clip,
              progress: playback.progress,
              cameraTarget: killCamCameraTarget(replayFrame, playback.clip),
              sourceVisible: replayFrame.source !== undefined,
            };
          }
        }
        const presentedAt = renderer.render(
          renderSnapshot,
          renderPlayerId,
          !killCamRender && watching && runState.phase === "over" && spectator === null,
          killCamRender ? null : interactionChannelRef.current,
          killCamRender ? undefined : session.intel,
          killCamRender,
        );
        for (const impact of predictedImpacts) {
          session.recordImpactPresented?.(impact.predictionId, presentedAt);
        }
        session.recordClientFrame?.(elapsedMs, performance.now() - frameWorkStartedAt);

        if (now - lastHudUpdate >= 80) {
          setSnapshot(nextSnapshot);
          setSpectating(spectator);
          setKillCam(killCamRender ? {
            clip: killCamRender.clip,
            progress: killCamRender.progress,
            label: killCamLabel(killCamRender.clip, session, killCamRender.sourceVisible),
          } : null);
          setNetworkDebug(session.getNetworkDebug?.() ?? null);
          lastHudUpdate = now;

          if (import.meta.env.DEV) {
            (window as unknown as { __dotbotSnapshot?: GameSnapshot }).__dotbotSnapshot = nextSnapshot;
          }
        }

        frameRef.current = requestAnimationFrame(loop);
      };

      frameRef.current = requestAnimationFrame(loop);
    }

    start();

    const onKeyDown = (event: KeyboardEvent) => {
      // Never capture game hotkeys while the player is typing in a form
      // field (callsign, preset names, room codes).
      if (isEditableTarget(event)) return;
      void feedback.unlock();

      if (event.code === "KeyM") {
        event.preventDefault();
        if (!event.repeat) setWorldMapOpen(!worldMapOpenRef.current);
        return;
      }

      if (worldMapOpenRef.current) {
        event.preventDefault();
        if (event.code === "Escape") setWorldMapOpen(false);
        return;
      }

      if (event.code === "F3") {
        event.preventDefault();
        setDebugVisible((visible) => !visible);
        return;
      }

      if (event.code === "KeyL") {
        event.preventDefault();
        applyHudOverlayEvent(hudOverlaysRef.current.settings ? "closeSettings" : "openSettings");
        return;
      }

      if (event.code === "KeyI") {
        event.preventDefault();
        if (!runEndedRef.current && !event.repeat) {
          applyHudOverlayEvent(hudOverlaysRef.current.inventory ? "closeInventory" : "openInventory");
        }
        return;
      }

      if (event.code === "Escape") {
        applyHudOverlayEvent("closeInventory");
      }

      if (event.code === "KeyF") {
        event.preventDefault();
        if (!runEndedRef.current && !event.repeat) bodyActionRef.current?.();
        return;
      }
      if (event.code === "KeyR") {
        event.preventDefault();
        if (!runEndedRef.current) downedVerbRef.current = "revive";
        return;
      }
      if (event.code === "KeyP") {
        event.preventDefault();
        if (!runEndedRef.current && !event.repeat) pleaQueuedRef.current = true;
        return;
      }

      // One digit per bay, derived rather than listed, so the keys and the bank
      // cannot disagree about how many bays there are.
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit && Number(digit[1]) <= defaultGameConfig.baySlots) {
        event.preventDefault();
        if (!runEndedRef.current && !event.repeat) useBayQueuedRef.current = Number(digit[1]) - 1;
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        if (killCamPlaybackRef.current) {
          killCamPlaybackRef.current.skip();
          killCamPlaybackRef.current = null;
          killCamObservedDownedRef.current = false;
          sessionRef.current?.setReplayActive?.(false);
          applyHudOverlayEvent("endReplay");
          setKillCam(null);
        } else if (runEndedRef.current && spectateEnabled) {
          spectateCycleQueuedRef.current = true;
        } else if (!runEndedRef.current) {
          dashQueuedRef.current = true;
          if (!event.repeat) feedback.playDash();
        }
        return;
      }

      if (movementKeyCodes.has(event.code)) {
        event.preventDefault();
        if (!runEndedRef.current) {
          keysRef.current.add(event.code);
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (isEditableTarget(event)) return;
      if (movementKeyCodes.has(event.code)) {
        event.preventDefault();
        keysRef.current.delete(event.code);
      }
    };

    const onPointerRelease = (event: globalThis.PointerEvent) => {
      if (joystickRef.current.pointerId === event.pointerId) {
        resetJoystick();
      }
    };

    const onAudioGesture = () => {
      void feedback.unlock();
    };

    const onWindowBlur = () => {
      clearMovementInput();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clearMovementInput();
      } else {
        feedback.recover();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerdown", onAudioGesture, true);
    window.addEventListener("pointerup", onPointerRelease);
    window.addEventListener("pointercancel", onPointerRelease);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", onAudioGesture, true);
      window.removeEventListener("pointerup", onPointerRelease);
      window.removeEventListener("pointercancel", onPointerRelease);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver?.disconnect();

      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }

      rendererRef.current?.destroy();
      feedbackRef.current?.destroy();
      sessionRef.current?.dispose();
      killCamPlaybackRef.current = null;
      killCamObservedDownedRef.current = false;
      killCamDoorsRef.current = [];
      sessionRef.current?.setReplayActive?.(false);
      rendererRef.current = null;
      feedbackRef.current = null;
      sessionRef.current = null;
    };
  }, [
    applyHudOverlayEvent,
    clearMovementInput,
    providedSession,
    requestedMap,
    resetJoystick,
    setWorldMapOpen,
    spectateEnabled,
  ]);

  const queueDash = useCallback(() => {
    void feedbackRef.current?.unlock();
    if (!runEndedRef.current) {
      dashQueuedRef.current = true;
      feedbackRef.current?.playDash();
    }
  }, []);

  const useBay = useCallback((bayIndex: BayIndex) => {
    void feedbackRef.current?.unlock();
    if (!runEndedRef.current) useBayQueuedRef.current = bayIndex;
  }, []);

  const swapBayItem = useCallback((bayIndex: BayIndex, holdIndex: number) => {
    void feedbackRef.current?.unlock();
    if (!runEndedRef.current) swapQueuedRef.current = { bayIndex, holdIndex };
  }, []);

  const dropItem = useCallback((from: "bay" | "hold", index: number, expected: Item, revision: number) => {
    void feedbackRef.current?.unlock();
    if (!runEndedRef.current && !hudOverlaysRef.current.replay && !hudOverlaysRef.current.reconnecting) {
      dropQueuedRef.current = { from, index, expected: { ...expected }, revision };
    }
  }, []);

  const setConnectionBlocked = useCallback((blocked: boolean) => {
    dropQueuedRef.current = undefined;
    applyHudOverlayEvent(blocked ? "startReconnect" : "endReconnect");
  }, [applyHudOverlayEvent]);

  const cycleSpectator = useCallback(() => {
    if (runEndedRef.current && spectateEnabled) {
      spectateCycleQueuedRef.current = true;
    }
  }, [spectateEnabled]);

  const leaveRun = useCallback(() => {
    killCamPlaybackRef.current?.skip();
    killCamPlaybackRef.current = null;
    killCamObservedDownedRef.current = false;
    sessionRef.current?.setReplayActive?.(false);
    applyHudOverlayEvent("endReplay");
    setKillCam(null);
    sessionRef.current?.leaveRun();
  }, [applyHudOverlayEvent]);

  const skipKillCam = useCallback(() => {
    killCamPlaybackRef.current?.skip();
    killCamPlaybackRef.current = null;
    killCamObservedDownedRef.current = false;
    sessionRef.current?.setReplayActive?.(false);
    applyHudOverlayEvent("endReplay");
    setKillCam(null);
  }, [applyHudOverlayEvent]);

  /**
   * `undefined` clears it. A verb is standing state — the simulation reads it every
   * tick and cancels the channel when it is absent — so nothing ever cleared it and
   * one press of F latched: every body walked over afterwards started searching
   * itself. The overlay clears it when the body under the player changes.
   */
  const selectDownedVerb = useCallback((verb: DownedVerb | undefined) => {
    if (!runEndedRef.current) downedVerbRef.current = verb;
  }, []);

  const takeFromBody = useCallback((fromBotId: string, index: number | "all") => {
    void feedbackRef.current?.unlock();
    if (!runEndedRef.current) takeQueuedRef.current = { fromBotId, index };
  }, []);

  const plea = useCallback(() => {
    void feedbackRef.current?.unlock();
    if (!runEndedRef.current) pleaQueuedRef.current = true;
  }, []);

  const setInteractionChannel = useCallback((visual: InteractionChannelVisual | null) => {
    interactionChannelRef.current = visual;
  }, []);

  const setBodyAction = useCallback((action: (() => void) | null) => {
    bodyActionRef.current = action;
  }, []);

  const draftObjects = useCallback((objectIds: string[]) => {
    const renderer = rendererRef.current;
    if (renderer) {
      for (const objectId of objectIds) renderer.draftObject(objectId);
    } else {
      pendingDraftsRef.current.push(...objectIds);
    }
  }, []);

  const setInteractionDotsVisible = useCallback((visibleIds: ReadonlySet<string>) => {
    interactionVisibilityRef.current = new Set(visibleIds);
    rendererRef.current?.setInteractionDotsVisible(interactionVisibilityRef.current);
  }, []);

  const setPlacementSlotsVisible = useCallback((visible: boolean) => {
    placementVisibilityRef.current = visible;
    rendererRef.current?.setPlacementSlotsVisible(visible);
  }, []);

  const updateJoystick = useCallback((clientX: number, clientY: number) => {
    const state = joystickRef.current;
    const raw = {
      x: clientX - state.origin.x,
      y: clientY - state.origin.y,
    };
    const length = Math.hypot(raw.x, raw.y);
    const limited = length > joystickRadius ? { x: (raw.x / length) * joystickRadius, y: (raw.y / length) * joystickRadius } : raw;
    const move = normalizeInputVector({
      x: clamp(limited.x / joystickRadius, -1, 1),
      y: clamp(limited.y / joystickRadius, -1, 1),
    });
    const next = {
      ...state,
      knob: limited,
      move,
    };

    joystickRef.current = next;
    setJoystickView(next);
  }, []);

  const joystickHandlers = useMemo(
    () => ({
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        void feedbackRef.current?.unlock();
        event.currentTarget.setPointerCapture(event.pointerId);
        const origin = {
          x: event.clientX,
          y: event.clientY,
        };
        const next = {
          active: true,
          pointerId: event.pointerId,
          origin,
          knob: { x: 0, y: 0 },
          move: { x: 0, y: 0 },
        };
        joystickRef.current = next;
        setJoystickView(next);
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const state = joystickRef.current;

        if (!state.active || state.pointerId !== event.pointerId) {
          return;
        }

        updateJoystick(event.clientX, event.clientY);
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        if (joystickRef.current.pointerId === event.pointerId) {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }

          resetJoystick();
        }
      },
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => {
        if (joystickRef.current.pointerId === event.pointerId) {
          resetJoystick();
        }
      },
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (joystickRef.current.pointerId === event.pointerId) {
          resetJoystick();
        }
      },
    }),
    [resetJoystick, updateJoystick],
  );

  const toggleFeedbackPreference = useCallback((key: keyof FeedbackPreferences) => {
    const next = {
      ...feedbackPreferencesRef.current,
      [key]: !feedbackPreferencesRef.current[key],
    };
    feedbackPreferencesRef.current = next;
    feedbackRef.current?.setPreferences(next);
    rendererRef.current?.setReducedMotion(next.reducedMotion);
    saveFeedbackPreferences(next);
    setFeedbackPreferences(next);
    if (key === "sound" && next.sound) void feedbackRef.current?.unlock();
  }, []);

  const testSound = useCallback(() => {
    feedbackRef.current?.playTest();
  }, []);

  /**
   * Where a click on the canvas points, in world units.
   *
   * Goes through the renderer's own last-drawn camera rather than recomputing one: the
   * camera eases and leads a dash, so un-projecting through a fresh camera lands slightly
   * off the pixel that was actually clicked. What the player aimed at is what was drawn.
   */
  const worldFromPointer = useCallback((event: { clientX: number; clientY: number }): Vec2 | null => {
    const host = hostRef.current;
    const renderer = rendererRef.current;
    if (!host || !renderer) return null;
    const box = host.getBoundingClientRect();
    return renderer.worldAt(event.clientX - box.left, event.clientY - box.top);
  }, []);

  /** Mark a place. A bare click always means "here" — there is no armed type to track. */
  const markHere = useCallback((world: Vec2) => {
    pingQueuedRef.current = { kind: CLICK_PING_KIND, position: world };
  }, []);

  /** A chart click is always the public exterior, even while the bot is indoors. */
  const markExterior = useCallback((world: Vec2) => {
    pingQueuedRef.current = {
      kind: CLICK_PING_KIND,
      position: world,
      floorId: WORLD_MAP_PING_FLOOR,
    };
  }, []);

  const chooseExteriorMark = useCallback((world: Vec2, screen: Vec2) => {
    setPingPicker({ world, screen, floorId: WORLD_MAP_PING_FLOOR });
  }, []);

  /**
   * Left-click marks "here". Right-click opens the picker, and choosing fires that type
   * there without arming it for later — see `CLICK_PING_KIND` for why the sticky version was
   * dropped. Touch has no right button, so a long press stands in for it.
   */
  const pingHandlers = useMemo(() => ({
    onPointerDown: (event: PointerEvent) => {
      // Touch has no right button, so a long press opens the picker instead.
      if (event.pointerType === "touch") {
        const world = worldFromPointer(event);
        if (!world) return;
        const screen = { x: event.clientX, y: event.clientY };
        longPressRef.current = window.setTimeout(() => {
          longPressRef.current = null;
          setPingPicker({ screen, world });
        }, 380);
        return;
      }
      if (event.button === 0) {
        const world = worldFromPointer(event);
        if (world) markHere(world);
      }
    },
    onPointerUp: (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      if (longPressRef.current === null) return;
      // Released before the press became long: it was a tap, so it marks.
      window.clearTimeout(longPressRef.current);
      longPressRef.current = null;
      const world = worldFromPointer(event);
      if (world) markHere(world);
    },
    onPointerCancel: () => {
      if (longPressRef.current === null) return;
      window.clearTimeout(longPressRef.current);
      longPressRef.current = null;
    },
    onContextMenu: (event: MouseEvent) => {
      // Right-click is the picker, so the browser menu must not also open.
      event.preventDefault();
      const world = worldFromPointer(event);
      if (world) setPingPicker({ screen: { x: event.clientX, y: event.clientY }, world });
    },
  }), [markHere, worldFromPointer]);

  /**
   * Clear every mark this client is holding.
   *
   * Local, not a simulation input, because marks are held per client — so this empties your
   * own view and leaves a squadmate's alone. A button that wiped everybody's would be a grief
   * button rather than a tidy-up, and there is no way for the player pressing it to know what
   * a squadmate is still using.
   */
  const clearPings = useCallback(() => {
    marksRef.current = [];
    rendererRef.current?.setSquadMarks([]);
    setPingPicker(null);
  }, []);

  /** Right-click chose a type: fire that one here, and change nothing about left-click. */
  const choosePingKind = useCallback((kind: PingKind) => {
    const picker = pingPicker;
    setPingPicker(null);
    if (picker) pingQueuedRef.current = { kind, position: picker.world, floorId: picker.floorId };
  }, [pingPicker]);

  return {
    hostRef,
    pingHandlers,
    pingPicker,
    choosePingKind,
    clearPings,
    closePingPicker: useCallback(() => setPingPicker(null), []),
    worldMapVisible,
    toggleWorldMap: useCallback(() => setWorldMapOpen(!worldMapOpenRef.current), [setWorldMapOpen]),
    closeWorldMap: useCallback(() => setWorldMapOpen(false), [setWorldMapOpen]),
    markExterior,
    chooseExteriorMark,
    squadMarks: marksRef.current,
    snapshot,
    events,
    runResult,
    map: providedSession?.map ?? requestedMap,
    playerId: providedSession?.playerId ?? "player",
    spectating,
    killCam,
    debugVisible,
    networkDebug,
    settingsVisible,
    toggleSettings: () => applyHudOverlayEvent(hudOverlaysRef.current.settings ? "closeSettings" : "openSettings"),
    inventoryVisible,
    toggleInventory: () => applyHudOverlayEvent(hudOverlaysRef.current.inventory ? "closeInventory" : "openInventory"),
    closeInventory: () => applyHudOverlayEvent("closeInventory"),
    setConnectionBlocked,
    feedbackPreferences,
    audioStatus,
    toggleSound: () => toggleFeedbackPreference("sound"),
    toggleHaptics: () => toggleFeedbackPreference("haptics"),
    toggleReducedMotion: () => toggleFeedbackPreference("reducedMotion"),
    testSound,
    joystick: joystickView,
    joystickHandlers,
    queueDash,
    useBay,
    swapBayItem,
    dropItem,
    leaveRun,
    skipKillCam,
    selectDownedVerb,
    takeFromBody,
    plea,
    cycleSpectator,
    setInteractionChannel,
    setBodyAction,
    draftObjects,
    setInteractionDotsVisible,
    setPlacementSlotsVisible,
  };
}

/** Which side of the listener a sound is on, saturating a third of a screen out. */
function impactPan(listener: Vec2 | undefined, point: Vec2): number {
  if (!listener) return 0;
  return clamp((point.x - listener.x) / 320, -1, 1);
}

function killCamLabel(clip: KillCamClip, session: GameSession, sourceVisible: boolean): string {
  const source = sourceVisible && clip.sourceBotId
    ? session.getEntityMeta?.(clip.sourceBotId)?.name
    : undefined;
  const cause = clip.cause.kind === "environment" ? "IMPACT" : clip.cause.kind.toUpperCase();
  return `${source ? `${source.toUpperCase()} · ` : ""}${cause} · CORE HIT`;
}
