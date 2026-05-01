import type { Env, UserContext } from "../../_middleware";

async function decryptKey(encrypted: string, secretHex: string): Promise<string> {
  const [ivHex, cipherHex] = encrypted.split(":");
  if (!ivHex || !cipherHex) throw new Error("Invalid encrypted key format");
  const keyBytes = hexToBytes(secretHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(ivHex) },
    cryptoKey,
    hexToBytes(cipherHex)
  );
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
  const user = (ctx as unknown as { user: UserContext }).user;
  if (user.type === "anon") {
    return new Response(JSON.stringify({ error: "Sign in to use AI features" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = await resolveApiKey(user, ctx.env);
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "No Anthropic API key configured." }),
      { status: 402, headers: { "Content-Type": "application/json" } }
    );
  }

  // Proxy the request body directly to Anthropic
  const body = await ctx.request.text();
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body,
  });

  return new Response(resp.body, {
    status: resp.status,
    headers: {
      "Content-Type": resp.headers.get("Content-Type") ?? "application/json",
    },
  });
};
