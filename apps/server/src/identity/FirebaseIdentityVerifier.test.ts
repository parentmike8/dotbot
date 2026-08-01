import { describe, expect, it } from "vitest";
import { firebaseProvider } from "./FirebaseIdentityVerifier";

describe("Firebase provider policy", () => {
  it("permits only console-constrained passwordless email link and phone", () => {
    expect(firebaseProvider("password")).toBe("email_link");
    expect(firebaseProvider("phone")).toBe("phone");
    expect(firebaseProvider("google.com")).toBeNull();
    expect(firebaseProvider("custom")).toBeNull();
    expect(firebaseProvider(undefined)).toBeNull();
  });
});
