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

  it("streams chat completions, including a forced tool call", async () => {
    const stream = await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "x" }], stream: true });
    let text = "", finish = "";
    for await (const chunk of stream) { text += chunk.choices[0]?.delta?.content ?? ""; finish = chunk.choices[0]?.finish_reason ?? finish; }
    expect(text).toBe("[mock] This is a canned reply from the Mock Anything OpenAI twin.");
    expect(finish).toBe("stop");

    t.twin.forceScenario("tool_call");
    const runner = openai.chat.completions.stream({
      model: "gpt-4o", messages: [{ role: "user", content: "weather?" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
    });
    const final = await runner.finalChatCompletion();
    expect(final.choices[0]!.finish_reason).toBe("tool_calls");
    expect(final.choices[0]!.message.tool_calls?.[0]).toMatchObject({ type: "function", function: { name: "get_weather", arguments: "{}" } });
  });

  it("streams responses with named events", async () => {
    const stream = await openai.responses.create({ model: "gpt-4o", input: "hi", stream: true });
    const types: string[] = []; let text = "";
    for await (const ev of stream) { types.push(ev.type); if (ev.type === "response.output_text.delta") text += ev.delta; }
    expect(types[0]).toBe("response.created");
    expect(types.at(-1)).toBe("response.completed");
    expect(text).toMatch(/^\[mock\]/);
    const helper = openai.responses.stream({ model: "gpt-4o", input: "hi" });
    expect((await helper.finalResponse()).output_text).toMatch(/^\[mock\]/);
  });

  it("needs model + messages", async () => {
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
