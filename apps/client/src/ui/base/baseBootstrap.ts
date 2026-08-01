export function shouldPauseForBaseBootstrap(_identityReady: boolean, _baseReady: boolean): boolean {
  // The local base is the immediate guest experience. Network bootstrap may
  // replace it with authoritative state, but must never take movement away.
  return false;
}
