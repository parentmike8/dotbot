import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { IdentityProviderKind, VerifiedExternalIdentity } from "../db/Persistence";

export interface FirebaseIdentityVerifier {
  verifyIdToken(token: string): Promise<VerifiedExternalIdentity>;
}

export type VerifiedFirebaseClaims = {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  auth_time: number;
  email_verified?: boolean;
  firebase?: { sign_in_provider?: string; tenant?: string };
};

type FirebaseVerificationPolicy = {
  tenantId: string;
  passwordlessEmailConfigVerified?: boolean;
  now?: number;
};

type EmailSignInConfig = {
  /** Firebase Admin maps this field to Identity Platform's allowPasswordSignup. */
  enabled: boolean;
  /** False maps to Identity Platform's enableEmailLinkSignin. */
  passwordRequired?: boolean;
};

export function createFirebaseIdentityVerifier(
  projectId = process.env.FIREBASE_PROJECT_ID,
  tenantId = process.env.FIREBASE_AUTH_TENANT_ID,
): FirebaseIdentityVerifier | null {
  // A root-project `password` claim cannot distinguish password from email-link
  // auth. Require the dedicated tenant boundary so the server can verify the
  // token scope and the live email-link-only provider configuration.
  if (!projectId || !tenantId) return null;
  const app = getApps().find((candidate) => candidate.name === "dotbot-auth") ?? initializeApp({
    credential: applicationDefault(),
    projectId,
  }, "dotbot-auth");
  const tenantManager = getAuth(app).tenantManager();
  const auth = tenantManager.authForTenant(tenantId);
  return {
    async verifyIdToken(token: string): Promise<VerifiedExternalIdentity> {
      // firebase-admin verifies the signature, issuer, audience, issued-at and
      // expiry claims. `true` additionally rejects revoked/disabled sessions.
      const decoded = await auth.verifyIdToken(token, true);
      let passwordlessEmailConfigVerified = false;
      if (decoded.firebase?.sign_in_provider === "password") {
        // Firebase deliberately uses `password` for both password and email-link
        // sessions. Read the authoritative tenant config before accepting every
        // email token so configuration drift fails closed immediately.
        const tenant = await tenantManager.getTenant(tenantId);
        passwordlessEmailConfigVerified = isPasswordlessEmailTenantConfig(tenant.emailSignInConfig);
      }
      return identityFromVerifiedFirebaseClaims(decoded, projectId, {
        tenantId,
        passwordlessEmailConfigVerified,
      });
    },
  };
}

/** Defense-in-depth validation after firebase-admin's cryptographic verifier. */
export function identityFromVerifiedFirebaseClaims(
  decoded: VerifiedFirebaseClaims,
  projectId: string,
  policy: FirebaseVerificationPolicy,
): VerifiedExternalIdentity {
  const now = policy.now ?? Date.now();
  const nowSeconds = now / 1000;
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  if (decoded.iss !== expectedIssuer || decoded.aud !== projectId) {
    throw new Error("Firebase token issuer or audience does not match this project.");
  }
  if (decoded.firebase?.tenant !== policy.tenantId) {
    throw new Error("Firebase token does not belong to the configured tenant.");
  }
  if (!decoded.sub || !Number.isFinite(decoded.exp) || decoded.exp <= nowSeconds) {
    throw new Error("Firebase token identity is missing or expired.");
  }
  if (!Number.isFinite(decoded.iat) || decoded.iat < 0 || decoded.iat > nowSeconds + 60 || decoded.exp <= decoded.iat) {
    throw new Error("Firebase token issue time is invalid.");
  }
  if (!Number.isFinite(decoded.auth_time)
    || decoded.auth_time < 0
    || decoded.auth_time > nowSeconds + 60
    || decoded.auth_time > decoded.iat + 60) {
    throw new Error("Firebase authentication time is invalid.");
  }
  const provider = firebaseProvider(decoded.firebase?.sign_in_provider, policy.passwordlessEmailConfigVerified);
  if (!provider) throw new Error("Firebase sign-in provider is not supported.");
  if (provider === "email_link" && decoded.email_verified !== true) {
    throw new Error("Firebase email-link identity is not verified.");
  }
  return {
    // Firebase UIDs are tenant-local. Namespace the stored issuer so a future
    // tenant change cannot collide with an unrelated account using the same UID.
    issuer: `${decoded.iss}/tenants/${policy.tenantId}`,
    subject: decoded.sub,
    provider,
    authenticatedAt: decoded.auth_time * 1000,
  };
}

export function firebaseProvider(value: string | undefined, passwordlessEmailConfigVerified = false): IdentityProviderKind | null {
  if (value === "password" && passwordlessEmailConfigVerified) return "email_link";
  if (value === "phone") return "phone";
  return null;
}

export function isPasswordlessEmailTenantConfig(config: EmailSignInConfig | undefined): boolean {
  return config?.enabled === false && config.passwordRequired === false;
}
