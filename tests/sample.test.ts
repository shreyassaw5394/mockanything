import { afterAll, describe, expect, it } from "vitest";
import { ingestOpenApi } from "../src/ingest/openapi.js";
import { serveTwin, type RunningTwin } from "../src/engine/server.js";

// A read-only API (no create call): the twin should hand back realistic samples, not empty lists and 404s.
const spec = {
  openapi: "3.0.3", info: { title: "Music Catalog" }, servers: [{ url: "https://api.music.example/v1" }],
  paths: {
    "/albums": { get: { responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/Album" } } } } } } } } } },
    "/albums/{id}": { get: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Album" } } } } } } },
    "/artists/{id}/albums": { get: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/Album" } } } } } } } } } },
  },
  components: { schemas: { Album: { type: "object", properties: { id: { type: "string", example: "4aawyAB9vmqN3uQ7FjRGTy" }, name: { type: "string", example: "Global Warming" }, total_tracks: { type: "integer", example: 18 } } } } },
};

let t: RunningTwin;
afterAll(async () => { await t?.close(); });

describe("read-only APIs", () => {
  it("return sample objects for any id and a non-empty list", async () => {
    const { def, report } = ingestOpenApi(spec);
    expect(def.resources.albums?.sample).toBe(true);
    expect(def.resources.albums?.scope ?? []).not.toContain("id");
    expect(report.guesses.some((g) => g.includes("made-up sample objects"))).toBe(true);
    t = await serveTwin(def, { port: 0 });
    const one = await (await fetch(`${t.url}/v1/albums/abc123`)).json() as Record<string, unknown>;
    expect(one).toMatchObject({ id: "abc123", name: "Global Warming", total_tracks: 18 });
    // the same id gives the same object back
    expect(await (await fetch(`${t.url}/v1/albums/abc123`)).json()).toEqual(one);
    const list = await (await fetch(`${t.url}/v1/albums`)).json() as { items?: unknown[] } | unknown[];
    const items = Array.isArray(list) ? list : (list.items ?? []);
    expect(items.length).toBeGreaterThanOrEqual(3);
  });
});

describe("odd specs", () => {
  it("copes with an error response whose example is a string", () => {
    const odd = structuredClone(spec) as Record<string, any>;
    odd.paths["/albums/{id}"].get.responses[404] = { description: "missing", content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" } }, example: '{"message":"nope"}' } } } };
    odd.paths["/albums/{id}"].get.responses[400] = { description: "bad", content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" } }, example: '{"message":"bad"}' } } } };
    expect(() => ingestOpenApi(odd)).not.toThrow();
  });
});
