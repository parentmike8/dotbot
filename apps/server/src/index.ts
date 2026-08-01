import { createServer } from "./app";
import { GameLiftSessionGate } from "./GameLiftSessionGate";
import { RemotePersistence } from "./db/RemotePersistence";
import { RemoteArenaDirectory } from "./ArenaDirectory";

const adapterUrl = process.env.GAMELIFT_ADAPTER_URL;
const publicQuickPlay = process.env.DOTBOT_PUBLIC_QUICK_PLAY === "true";
const gameLift = adapterUrl ? new GameLiftSessionGate({ adapterUrl }) : undefined;
const functionName = process.env.DOTBOT_MATCHMAKER_FUNCTION ?? "";
const { app } = await createServer({
  gameLift,
  persistence: adapterUrl ? new RemotePersistence(functionName) : undefined,
  publicQuickPlay,
  arenaDirectory: publicQuickPlay && gameLift ? new RemoteArenaDirectory(functionName, gameLift) : undefined,
});
const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
