import Anthropic from "@anthropic-ai/sdk";
import type { Env, UserContext } from "../../_middleware";

const SYSTEM_PROMPT = `You are summarizing a single person's life from a GEDCOM record. Output ONLY the summary text; no preamble, no closing remarks, no headings.

Constraints:
- 1 to 3 sentences, factual, no speculation.
- Markdown allowed: **bold** for the person's full name on first mention, *italics* sparingly, and [link text](url) for any URLs that appear in source citations within the GEDCOM (e.g. PAGE/URL fields in SOUR blocks).
- Lead with the person's name in bold, then their lifespan in parentheses if dates are known (e.g. "(b. 1850 in Norfolk, VA - d. 1922 in Richmond, VA)" or "(1850-1922)" if places aren't given), then a brief life summary drawn from the record's events.
- Preserve at most two source URLs as markdown links if they appear in the record.
- Do NOT invent facts, occupations, relationships, or events not present in the record.

Format examples:
- **Mary Smith** (b. 1850 in Norfolk, VA - d. 1922 in Richmond, VA) married John Doe in 1875 and lived in Hertford County for the 1900 census.
- **Unknown Reid** (no dates recorded) appears as a child in family F1234; no further events on file.
- **John Abner Collins** (b. abt. 1852 in Hertford Co, NC - d. 1931) is recorded with wife Bettie in the 1900 and 1910 censuses; his father is unknown per the [death record](https://www.ancestry.com/).`;

interface Block {
  id: string;
  text: string;
}

interface RequestBody {
  blocks: Block[];
  model?: string;
  max_tokens?: number;
}

async function decryptKey(encrypted: string, secretHex: string): Promise<string> {
  const [ivHex, cipherHex] = encrypted.split(":");
  if (!ivHex || !cipherHex) throw new Error("Invalid encrypted key format");
  const keyBytes = hexToBytes(secretHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]
  );
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(cipherHex);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
  return new TextDecoder().decode(plain);
}

function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

async function resolveApiKey(user: UserContext, env: Env): Promise<string | null> {
  if (user.type === "vip") return env.ANTHROPIC_API_KEY;
  if (user.type === "regular") {
    const row = await env.DB.prepare(
      `SELECT api_key FROM users WHERE user_id = ?`
    ).bind(user.id).first<{ api_key: string | null }>();
    if (!row?.api_key) return null;
    return decryptKey(row.api_key, env.KEY_ENCRYPTION_SECRET);
  }
  return null;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") {
    return new Response(JSON.stringify({ error: "Sign in to use AI features" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = await resolveApiKey(user, ctx.env);
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "No Anthropic API key configured. Add one via /api/user/apikey." }),
      { status: 402, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: RequestBody;
  try {
    body = await ctx.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  if (!Array.isArray(body.blocks) || body.blocks.length === 0) {
    return new Response(JSON.stringify({ error: "blocks array required" }), {
      status: 422, headers: { "Content-Type": "application/json" },
    });
  }

  const model = body.model ?? "claude-opus-4-7";
  const maxTokens = body.max_tokens ?? 400;
  const client = new Anthropic({ apiKey });

  const summaries: Record<string, string> = {};
  for (const { id, text } of body.blocks) {
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `GEDCOM record for one individual:\n\n\`\`\`\n${text}\n\`\`\`\n\nWrite the summary now.` }],
      });
      const out = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (out) summaries[id] = out;
    } catch {
      // skip failed individual; caller can retry
    }
  }

  return new Response(JSON.stringify({ summaries }), {
    headers: { "Content-Type": "application/json" },
  });
};
