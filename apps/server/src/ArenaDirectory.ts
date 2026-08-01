import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { GameLiftSessionGate } from "./GameLiftSessionGate";

export interface ArenaDirectory {
  publish(state: { arenaId: string; open: boolean; closesAt?: number }): Promise<void>;
  close(): void;
}

/** Fleet-role/IAM protected availability reporter. It never calls GameLift or
 * creates capacity; it only reopens/closes the existing public Dynamo record. */
export class RemoteArenaDirectory implements ArenaDirectory {
  private readonly lambda: LambdaClient;
  private revision = 0;

  constructor(
    private readonly functionName: string,
    private readonly gameLift: GameLiftSessionGate,
    lambda?: LambdaClient,
  ) {
    if (!functionName) throw new Error("DOTBOT_MATCHMAKER_FUNCTION is required for public arena reporting.");
    this.lambda = lambda ?? new LambdaClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  }

  async publish(state: { arenaId: string; open: boolean; closesAt?: number }): Promise<void> {
    // Order revisions by the room's desired-state calls, not by completion of
    // the asynchronous GameLift metadata lookup. Otherwise a slow old open
    // can be assigned a newer revision than a later close and reopen a live
    // arena after the close already reached DynamoDB.
    const revision = ++this.revision;
    const session = await this.gameLift.publicSession();
    if (session.arenaId !== state.arenaId) throw new Error("Public arena reporter received a mismatched arena id.");
    if (revision !== this.revision) return;
    const response = await this.lambda.send(new InvokeCommand({
      FunctionName: this.functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({
        source: "dotbot-arena-server",
        operation: "setAdmission",
        args: { ...session, open: state.open, closesAt: state.closesAt, revision },
      })),
    }), { abortSignal: AbortSignal.timeout(3_000) });
    if (response.FunctionError || !response.Payload) throw new Error("Arena directory update failed.");
    const payload = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as { result?: unknown; error?: string };
    if (payload.error) throw new Error(payload.error);
  }

  close(): void {
    this.lambda.destroy();
  }
}
