import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { findPack } from "../src/engine/load.js";
import { serveTwin, type RunningTwin } from "../src/engine/server.js";

let t: RunningTwin;
let anthropic: Anthropic;
beforeAll(async () => {
  t = await serveTwin(findPack("anthropic")!, { port: 0 });
  anthropic = new Anthropic({ apiKey: "sk-ant-mockanything", baseURL: t.url, maxRetries: 0 });
});
afterAll(async () => { await t.close(); });

const tools: Anthropic.Tool[] = [{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: {} } }];

describe("Anthropic pack with the official SDK", () => {
  it("answers messages with a canned [mock] reply", async () => {
    const m = await anthropic.messages.create({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "secret question" }] });
    expect(m.id).toMatch(/^msg_01/);
    expect(m).toMatchObject({ type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn" });
    expect(m.content[0]).toMatchObject({ type: "text" });
    expect((m.content[0] as Anthropic.TextBlock).text).toMatch(/^\[mock\]/);
    expect(JSON.stringify(m)).not.toContain("secret question");
  });

  it("streams text and tool use", async () => {
    const s = anthropic.messages.stream({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "x" }] });
    let text = "";
    s.on("text", (d) => { text += d; });
    const final = await s.finalMessage();
    expect(text).toBe("[mock] This is a canned reply from the Mock Anything Anthropic twin.");
    expect(final.stop_reason).toBe("end_turn");

    t.twin.forceScenario("tool_use");
    const ts = anthropic.messages.stream({ model: "claude-sonnet-5-5", max_tokens: 100, tools, messages: [{ role: "user", content: "weather?" }] });
    const tf = await ts.finalMessage();
    expect(tf.stop_reason).toBe("tool_use");
    expect(tf.content[0]).toMatchObject({ type: "tool_use", name: "get_weather", input: {} });
  });

  it("forces tool use and errors without streaming", async () => {
    t.twin.forceScenario("tool_use");
    const m = await anthropic.messages.create({ model: "claude-sonnet-5-5", max_tokens: 100, tools, messages: [{ role: "user", content: "x" }] });
    expect(m.content[0]).toMatchObject({ type: "tool_use", name: "get_weather" });
    expect((m.content[0] as Anthropic.ToolUseBlock).id).toMatch(/^toolu_01/);

    t.twin.forceScenario("overloaded");
    const e = await anthropic.messages.create({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "x" }] }).catch((x) => x);
    expect(e).toBeInstanceOf(Anthropic.APIError);
    expect(e.status).toBe(529);
    expect(e.error).toMatchObject({ type: "error", error: { type: "overloaded_error" } });

    const missing = await anthropic.messages.create({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "x" }] } as never).catch((x) => x);
    expect(missing).toBeInstanceOf(Anthropic.BadRequestError);
  });

  it("needs the anthropic-version header, like the real API", async () => {
    const r = await fetch(`${t.url}/v1/messages`, { method: "POST", headers: { "x-api-key": "k", "content-type": "application/json" }, body: JSON.stringify({ model: "m", max_tokens: 1, messages: [] }) });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error", message: "anthropic-version: header is required" } });
  });

  it("counts tokens and lists models", async () => {
    expect((await anthropic.messages.countTokens({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "x" }] })).input_tokens).toBe(12);
    expect(await anthropic.models.retrieve("claude-sonnet-5-5")).toMatchObject({ id: "claude-sonnet-5-5", type: "model" });
    const page = await anthropic.models.list();
    expect(page.data.length).toBeGreaterThan(0);
  });
});
