import { createServer } from "./app";
import { GameLiftSessionGate } from "./GameLiftSessionGate";
import { RemotePersistence } from "./db/RemotePersistence";

const adapterUrl = process.env.GAMELIFT_ADAPTER_URL;
const { app } = await createServer({
  gameLift: adapterUrl ? new GameLiftSessionGate({ adapterUrl }) : undefined,
  persistence: adapterUrl ? new RemotePersistence(process.env.DOTBOT_MATCHMAKER_FUNCTION ?? "") : undefined,
});
const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
