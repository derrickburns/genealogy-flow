import type { Env, UserContext } from "../../_middleware";

async function encryptKey(plaintext: string, secretHex: string): Promise<string> {
  const keyBytes = hexToBytes(secretHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    enc.encode(plaintext)
  );
  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(ciphertext))}`;
}

function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  const resp = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  return resp.ok;
}

export const onRequestPut: PagesFunction<Env> = async (ctx) => {
  const user = (ctx as unknown as { user: UserContext }).user;

  if (user.type === "anon") {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (user.type === "vip") {
    return new Response(
      JSON.stringify({ error: "VIP accounts use the app key" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: { api_key?: string };
  try {
    body = await ctx.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = body.api_key?.trim();
  if (!apiKey || !apiKey.startsWith("sk-ant-")) {
    return new Response(
      JSON.stringify({ error: "Invalid Anthropic API key format" }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    );
  }

  const valid = await validateAnthropicKey(apiKey);
  if (!valid) {
    return new Response(JSON.stringify({ error: "API key rejected by Anthropic" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encrypted = await encryptKey(apiKey, ctx.env.KEY_ENCRYPTION_SECRET);
  await ctx.env.DB.prepare(`UPDATE users SET api_key = ? WHERE user_id = ?`)
    .bind(encrypted, user.id)
    .run();

  return new Response(JSON.stringify({ stored: true }), {
    headers: { "Content-Type": "application/json" },
  });
};
