import { describe, expect, it } from "vitest";
import { withoutCredentials } from "../src/lib/safeFetch.js";
import { readDocs } from "../src/mcp/server.js";
import { fetchText } from "../src/ingest/resolve.js";

describe("outbound requests", () => {
  it("drop credentials when a redirect leaves the original host", () => {
    const h = withoutCredentials({ Authorization: "Bearer sk_test_x", "x-api-key": "k", Cookie: "a=b", accept: "application/json", "user-agent": "ua" });
    expect(h).toEqual({ accept: "application/json", "user-agent": "ua" });
    expect(withoutCredentials(new Headers({ authorization: "x", accept: "y" }))).toEqual({ accept: "y" });
    expect(withoutCredentials(undefined)).toEqual({});
  });

  it("the docs reader only reads public pages", async () => {
    await expect(readDocs("http://localhost/admin")).rejects.toThrow();
    await expect(readDocs("http://127.0.0.1:80/")).rejects.toThrow();
    await expect(fetchText("http://169.254.169.254/latest/meta-data/", 1000, { allowLocal: false })).rejects.toThrow();
  });
});
