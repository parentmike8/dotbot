import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { IdentityProviderKind, VerifiedExternalIdentity } from "../db/Persistence";

export interface FirebaseIdentityVerifier {
  verifyIdToken(token: string): Promise<VerifiedExternalIdentity>;
}

export function createFirebaseIdentityVerifier(projectId = process.env.FIREBASE_PROJECT_ID): FirebaseIdentityVerifier | null {
  if (!projectId) return null;
  const app = getApps().find((candidate) => candidate.name === "dotbot-auth") ?? initializeApp({
    credential: applicationDefault(),
    projectId,
  }, "dotbot-auth");
  const auth = getAuth(app);
  return {
    async verifyIdToken(token: string): Promise<VerifiedExternalIdentity> {
      const decoded = await auth.verifyIdToken(token, true);
      const provider = firebaseProvider(decoded.firebase?.sign_in_provider);
      if (!provider) throw new Error("Firebase sign-in provider is not supported.");
      return {
        issuer: decoded.iss,
        subject: decoded.sub,
        provider,
        authenticatedAt: decoded.auth_time * 1000,
      };
    },
  };
}

export function firebaseProvider(value: string | undefined): IdentityProviderKind | null {
  // Firebase uses `password` for both email/password and email-link tokens.
  // Production disables password sign-in in the Firebase console, making this
  // value the passwordless email-link path described in the identity contract.
  if (value === "password") return "email_link";
  if (value === "phone") return "phone";
  return null;
}
