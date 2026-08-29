import { describe, expect, it } from "vitest";

import { isAuthorizedPubsubIdentity } from "../src/web/auth.js";

describe("Pub/Sub push identity authorization", () => {
  const expected = "creator-duty-push@creator-duty-test.iam.gserviceaccount.com";

  it("accepts only the verified, exact configured service-account email", () => {
    expect(isAuthorizedPubsubIdentity({ email: expected, email_verified: true }, expected)).toBe(true);
    expect(isAuthorizedPubsubIdentity({ email: expected, email_verified: false }, expected)).toBe(false);
    expect(isAuthorizedPubsubIdentity({
      email: "other@creator-duty-test.iam.gserviceaccount.com",
      email_verified: true,
    }, expected)).toBe(false);
    expect(isAuthorizedPubsubIdentity(undefined, expected)).toBe(false);
  });
});
