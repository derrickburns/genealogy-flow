import Anthropic from "@anthropic-ai/sdk";
import type { Env, UserContext } from "../../_middleware";

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type !== "vip") {
    return new Response(JSON.stringify({ error: "VIP access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Anthropic.MessageCreateParamsNonStreaming & { stream?: boolean };
  try {
    body = await ctx.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const client = new Anthropic({ apiKey: ctx.env.ANTHROPIC_API_KEY });
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  ctx.waitUntil((async () => {
    try {
      const system = Array.isArray(body.system)
        ? body.system
        : body.system
          ? [{ type: "text" as const, text: String(body.system) }]
          : undefined;
      const stream = client.messages.stream({
        model: body.model ?? "claude-sonnet-4-6",
        max_tokens: body.max_tokens ?? 8192,
        system,
        messages: body.messages ?? [],
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          await writer.write(enc.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`));
        }
      }

      await writer.write(enc.encode("data: [DONE]\n\n"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writer.write(enc.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
    } finally {
      await writer.close();
    }
  })());

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
};
