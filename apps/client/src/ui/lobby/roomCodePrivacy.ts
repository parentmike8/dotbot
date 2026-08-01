export function roomCodeDataAttribute(roomCode: string, hideRoomCode = false): string | undefined {
  return hideRoomCode ? undefined : roomCode;
}
