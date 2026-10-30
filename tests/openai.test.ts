import { afterAll, beforeAll, describe, expect, it } from "vitest";
import OpenAI from "openai";
import { findPack } from "../src/engine/load.js";
import { serveTwin, type RunningTwin } from "../src/engine/server.js";

let t: RunningTwin;
let openai: OpenAI;
beforeAll(async () => {
  t = await serveTwin(findPack("openai")!, { port: 0 });
  openai = new OpenAI({ apiKey: "sk-mockanything", baseURL: `${t.url}/v1`, maxRetries: 0 });
});
afterAll(async () => { await t.close(); });

describe("OpenAI pack with the official SDK", () => {
  it("answers chat completions with a canned [mock] reply", async () => {
    const r = await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "secret question" }] });
    expect(r.id).toMatch(/^chatcmpl-/);
    expect(r.object).toBe("chat.completion");
    expect(r.model).toBe("gpt-4o");
    expect(r.choices[0]!.message.content).toMatch(/^\[mock\]/);
    expect(r.choices[0]!.finish_reason).toBe("stop");
    expect(JSON.stringify(r)).not.toContain("secret question");
  });

  it("forces a tool call, then errors, on demand", async () => {
    t.twin.forceScenario("tool_call");
    const r = await openai.chat.completions.create({
      model: "gpt-4o", messages: [{ role: "user", content: "weather?" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
    });
    expect(r.choices[0]!.finish_reason).toBe("tool_calls");
    expect(r.choices[0]!.message.tool_calls?.[0]).toMatchObject({ type: "function", function: { name: "get_weather" } });

    t.twin.forceScenario("rate_limit");
    const e = await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }).catch((x) => x);
    expect(e).toBeInstanceOf(OpenAI.RateLimitError);
    expect(e.code).toBe("rate_limit_exceeded");
  });

  it("refuses streaming clearly and needs model + messages", async () => {
    const s = await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "x" }], stream: true }).catch((x) => x);
    expect(s).toBeInstanceOf(OpenAI.BadRequestError);
    expect(String(s.message)).toContain("Streaming");
    const m = await openai.chat.completions.create({ model: "gpt-4o" } as never).catch((x) => x);
    expect(m).toBeInstanceOf(OpenAI.BadRequestError);
  });

  it("supports responses, embeddings and models", async () => {
    const r = await openai.responses.create({ model: "gpt-4o", input: "hi" });
    expect(r.id).toMatch(/^resp_/);
    expect(r.output_text).toMatch(/^\[mock\]/);
    expect((await openai.responses.retrieve(r.id)).id).toBe(r.id);
    const e = await openai.embeddings.create({ model: "text-embedding-3-small", input: "hello" });
    expect(e.data[0]!.embedding).toHaveLength(8);
    const m = await openai.models.retrieve("gpt-4o");
    expect(m).toMatchObject({ id: "gpt-4o", object: "model" });
    const list = await openai.models.list();
    expect(list.data.length).toBeGreaterThan(0);
  });
});
