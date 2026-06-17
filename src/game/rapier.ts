import RAPIER from "@dimforge/rapier2d-compat";

let rapierReady: Promise<typeof RAPIER> | undefined;

export function loadRapier(): Promise<typeof RAPIER> {
  if (!rapierReady) {
    rapierReady = RAPIER.init().then(() => RAPIER);
  }

  return rapierReady;
}
