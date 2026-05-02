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

  const apiKey = typeof ctx.env.ANTHROPIC_API_KEY === "string" ? ctx.env.ANTHROPIC_API_KEY.trim() : "";
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Anthropic API key is not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const client = new Anthropic({ apiKey });
  const enc = new TextEncoder();

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (payload: unknown) => {
        const data = typeof payload === "string" ? payload : JSON.stringify(payload);
        controller.enqueue(enc.encode(`data: ${data}\n\n`));
      };
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
            write({ text: event.delta.text });
          }
        }

        write("[DONE]");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        write({ error: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
};
