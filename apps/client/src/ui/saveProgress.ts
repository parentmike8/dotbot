import type { AccountState } from "./identity";

export function shouldOfferSaveProgress(runComplete: boolean, account: AccountState | null): boolean {
  return runComplete && account?.storageAvailable === true && account.linked === false;
}
