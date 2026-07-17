import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { BaseLayout, BaseShellId, LoadoutPreset } from "@dotbot/game/types";
import type { WireItemCode } from "@dotbot/protocol";
import type {
  FabricationResult,
  Persistence,
  PlayerBase,
  PlayerIdentity,
  PlayerProfile,
  PresetApplyResult,
  RegisteredPlayer,
} from "./Persistence";

type RelayResponse<T> = { result: T } | { error: string };

/**
 * GameLift processes have no database credentials. They invoke the AWS-side
 * matchmaker with their fleet instance role; that Lambda relays only the
 * allow-listed match operations to the existing Cloud Run control plane.
 */
export class RemotePersistence implements Persistence {
  readonly live = true;
  private readonly lambda: LambdaClient;

  constructor(private readonly functionName: string, lambda?: LambdaClient) {
    if (!functionName) throw new Error("DOTBOT_MATCHMAKER_FUNCTION is required in GameLift mode.");
    this.lambda = lambda ?? new LambdaClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  }

  registerPlayer(_name: string): Promise<RegisteredPlayer> { return this.unsupported("registerPlayer"); }
  helloPlayer(_token: string): Promise<PlayerIdentity | null> { return this.unsupported("helloPlayer"); }
  getProfile(_token: string): Promise<PlayerProfile | null> { return this.unsupported("getProfile"); }
  getBase(_token: string): Promise<PlayerBase | null> { return this.unsupported("getBase"); }
  saveBaseLayout(_token: string, _layout: BaseLayout): Promise<BaseLayout | null> { return this.unsupported("saveBaseLayout"); }
  setBaseShell(_token: string, _shell: BaseShellId): Promise<PlayerBase | null> { return this.unsupported("setBaseShell"); }
  setLoadout(_token: string, _loadout: WireItemCode[]): Promise<PlayerBase | null> { return this.unsupported("setLoadout"); }
  fabricate(_token: string, _recipeId: string, _slotId?: string): Promise<FabricationResult | null> { return this.unsupported("fabricate"); }
  savePresets(_token: string, _presets: LoadoutPreset[]): Promise<PlayerBase | null> { return this.unsupported("savePresets"); }
  applyPreset(_token: string, _presetIndex: number): Promise<PresetApplyResult | null> { return this.unsupported("applyPreset"); }
  setInsertionPreference(_token: string, _insertionPointId: string | null): Promise<string | null> { return this.unsupported("setInsertionPreference"); }
  acceptContract(_token: string, _contractId: string): Promise<void> { return this.unsupported("acceptContract"); }
  rerollContracts(_token: string): Promise<void> { return this.unsupported("rerollContracts"); }
  abandonContract(_token: string, _contractId: string): Promise<void> { return this.unsupported("abandonContract"); }

  resolveOrRegisterPlayer(token: string, offeredName: string): Promise<PlayerIdentity> {
    return this.invoke("resolveOrRegisterPlayer", { token, offeredName });
  }

  getInsertionPreference(playerId: string): Promise<string | null> {
    return this.invoke("getInsertionPreference", { playerId });
  }

  getMatchIntelObjects(playerId: string): ReturnType<Persistence["getMatchIntelObjects"]> {
    return this.invoke("getMatchIntelObjects", { playerId });
  }

  consumeLoadout(playerId: string): Promise<WireItemCode[]> {
    return this.invoke("consumeLoadout", { playerId });
  }

  startMatch(input: Parameters<Persistence["startMatch"]>[0]): Promise<void> {
    return this.invoke("startMatch", { ...input, startedAt: input.startedAt.toISOString() });
  }

  recordExtraction(input: Parameters<Persistence["recordExtraction"]>[0]): ReturnType<Persistence["recordExtraction"]> {
    return this.invoke("recordExtraction", input);
  }

  recordOutcome(input: Parameters<Persistence["recordOutcome"]>[0]): Promise<void> {
    return this.invoke("recordOutcome", input);
  }

  finishMatch(input: Parameters<Persistence["finishMatch"]>[0]): Promise<void> {
    return this.invoke("finishMatch", { ...input, endedAt: input.endedAt.toISOString() });
  }

  async close(): Promise<void> {
    this.lambda.destroy();
  }

  private async invoke<T>(operation: string, args: unknown): Promise<T> {
    const response = await this.lambda.send(new InvokeCommand({
      FunctionName: this.functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ source: "dotbot-game-server", operation, args })),
    }));
    if (response.FunctionError || !response.Payload) throw new Error(`Persistence relay failed for ${operation}.`);
    const payload = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as RelayResponse<T>;
    if ("error" in payload) throw new Error(payload.error);
    return payload.result;
  }

  private unsupported<T>(operation: string): Promise<T> {
    return Promise.reject(new Error(`${operation} is not available on a dedicated match server.`));
  }
}
