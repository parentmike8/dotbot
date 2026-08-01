import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFirebaseIdentityVerifier,
  firebaseProvider,
  identityFromVerifiedFirebaseClaims,
  isPasswordlessEmailTenantConfig,
  type VerifiedFirebaseClaims,
} from "./FirebaseIdentityVerifier";

const firebaseMocks = vi.hoisted(() => ({
  applicationDefault: vi.fn(() => ({ credential: true })),
  authForTenant: vi.fn(),
  getApps: vi.fn(() => [] as unknown[]),
  getAuth: vi.fn(),
  getTenant: vi.fn(),
  initializeApp: vi.fn(() => ({ name: "dotbot-auth" })),
  tenantManager: vi.fn(),
  verifyIdToken: vi.fn(),
}));

vi.mock("firebase-admin/app", () => ({
  applicationDefault: firebaseMocks.applicationDefault,
  getApps: firebaseMocks.getApps,
  initializeApp: firebaseMocks.initializeApp,
}));

vi.mock("firebase-admin/auth", () => ({ getAuth: firebaseMocks.getAuth }));

beforeEach(() => {
  vi.clearAllMocks();
  firebaseMocks.getApps.mockReturnValue([]);
  firebaseMocks.authForTenant.mockReturnValue({ verifyIdToken: firebaseMocks.verifyIdToken });
  firebaseMocks.tenantManager.mockReturnValue({
    authForTenant: firebaseMocks.authForTenant,
    getTenant: firebaseMocks.getTenant,
  });
  firebaseMocks.getAuth.mockReturnValue({ tenantManager: firebaseMocks.tenantManager });
});

describe("Firebase provider policy", () => {
  it("uses tenant-aware revoked-token verification and reads live policy for email-link tokens", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    firebaseMocks.verifyIdToken.mockResolvedValue({
      iss: "https://securetoken.google.com/dotbot-test",
      aud: "dotbot-test",
      sub: "email-user",
      exp: nowSeconds + 3_600,
      iat: nowSeconds - 30,
      auth_time: nowSeconds - 60,
      email_verified: true,
      firebase: { sign_in_provider: "password", tenant: "dotbot-users" },
    });
    firebaseMocks.getTenant.mockResolvedValue({
      emailSignInConfig: { enabled: false, passwordRequired: false },
    });

    const verifier = createFirebaseIdentityVerifier("dotbot-test", "dotbot-users");
    await expect(verifier?.verifyIdToken("signed-token")).resolves.toMatchObject({
      provider: "email_link",
      subject: "email-user",
    });
    expect(firebaseMocks.authForTenant).toHaveBeenCalledWith("dotbot-users");
    expect(firebaseMocks.verifyIdToken).toHaveBeenCalledWith("signed-token", true);
    expect(firebaseMocks.getTenant).toHaveBeenCalledWith("dotbot-users");
  });

  it("permits email-link tokens only after verifying a password-disabled tenant config", () => {
    expect(firebaseProvider("password")).toBeNull();
    expect(firebaseProvider("password", true)).toBe("email_link");
    expect(firebaseProvider("phone")).toBe("phone");
    expect(firebaseProvider("google.com")).toBeNull();
    expect(firebaseProvider("custom")).toBeNull();
    expect(firebaseProvider(undefined)).toBeNull();
    expect(isPasswordlessEmailTenantConfig({ enabled: false, passwordRequired: false })).toBe(true);
    expect(isPasswordlessEmailTenantConfig({ enabled: true, passwordRequired: false })).toBe(false);
    expect(isPasswordlessEmailTenantConfig({ enabled: false, passwordRequired: true })).toBe(false);
    expect(isPasswordlessEmailTenantConfig(undefined)).toBe(false);
  });

  it("fails closed on issuer, audience, expiry, subject, auth-time, and provider confusion", () => {
    const now = 2_000_000_000_000;
    const valid: VerifiedFirebaseClaims = {
      iss: "https://securetoken.google.com/dotbot-test",
      aud: "dotbot-test",
      sub: "firebase-user",
      exp: now / 1000 + 3_600,
      iat: now / 1000 - 30,
      auth_time: now / 1000 - 60,
      firebase: { sign_in_provider: "phone", tenant: "dotbot-users" },
    };
    const policy = { tenantId: "dotbot-users", now };
    expect(identityFromVerifiedFirebaseClaims(valid, "dotbot-test", policy)).toEqual({
      issuer: `${valid.iss}/tenants/dotbot-users`,
      subject: valid.sub,
      provider: "phone",
      authenticatedAt: valid.auth_time * 1000,
    });
    for (const mutation of [
      { ...valid, iss: "https://securetoken.google.com/other-project" },
      { ...valid, aud: "other-project" },
      { ...valid, exp: now / 1000 },
      { ...valid, iat: now / 1000 + 61 },
      { ...valid, sub: "" },
      { ...valid, auth_time: Number.NaN },
      { ...valid, firebase: { ...valid.firebase, tenant: "other-tenant" } },
      { ...valid, firebase: { sign_in_provider: "google.com" } },
    ]) {
      expect(() => identityFromVerifiedFirebaseClaims(mutation, "dotbot-test", policy)).toThrow();
    }
  });

  it("requires verified email ownership and the live email-link-only tenant policy", () => {
    const now = 2_000_000_000_000;
    const emailLink: VerifiedFirebaseClaims = {
      iss: "https://securetoken.google.com/dotbot-test",
      aud: "dotbot-test",
      sub: "email-user",
      exp: now / 1000 + 3_600,
      iat: now / 1000 - 30,
      auth_time: now / 1000 - 60,
      email_verified: true,
      firebase: { sign_in_provider: "password", tenant: "dotbot-users" },
    };
    expect(() => identityFromVerifiedFirebaseClaims(emailLink, "dotbot-test", {
      tenantId: "dotbot-users",
      now,
    })).toThrow("provider is not supported");
    expect(() => identityFromVerifiedFirebaseClaims({ ...emailLink, email_verified: false }, "dotbot-test", {
      tenantId: "dotbot-users",
      passwordlessEmailConfigVerified: true,
      now,
    })).toThrow("not verified");
    expect(identityFromVerifiedFirebaseClaims(emailLink, "dotbot-test", {
      tenantId: "dotbot-users",
      passwordlessEmailConfigVerified: true,
      now,
    })).toMatchObject({ provider: "email_link", subject: "email-user" });
  });
});
