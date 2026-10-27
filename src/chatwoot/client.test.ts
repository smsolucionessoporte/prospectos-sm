import assert from "node:assert/strict";
import test from "node:test";
import { createChatwootClient } from "./client.js";

test("getLabels obtiene la lista de etiquetas de una conversación", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(url).endsWith("/api/v1/accounts/1/conversations/123/labels"));
    assert.equal(init?.method, "GET");
    assert.equal((init?.headers as Record<string, string>)?.api_access_token, "admin-token");
    return new Response(JSON.stringify({ payload: ["vip", "cliente"] }), { status: 200 });
  }) as typeof fetch;

  try {
    const client = createChatwootClient({
      baseUrl: "http://localhost:3000",
      accountId: 1,
      apiToken: "test-token",
      adminApiToken: "admin-token"
    });
    const labels = await client.getLabels(123);
    assert.deepEqual(labels, ["vip", "cliente"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("addLabels preserva las etiquetas existentes al agregar nuevas etiquetas", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    let body: unknown;
    if (init?.body) {
      body = JSON.parse(String(init.body));
    }
    requests.push({ url: urlStr, method, body });

    if (method === "GET") {
      return new Response(JSON.stringify({ payload: ["existente_1", "existente_2"] }), { status: 200 });
    }
    if (method === "POST") {
      assert.deepEqual(body, { labels: ["existente_1", "existente_2", "derivar-ventas"] });
      return new Response(JSON.stringify({ payload: ["existente_1", "existente_2", "derivar-ventas"] }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  try {
    const client = createChatwootClient({
      baseUrl: "http://localhost:3000",
      accountId: 1,
      apiToken: "test-token",
      adminApiToken: "admin-token"
    });
    const result = await client.addLabels(123, ["derivar-ventas"]);
    assert.deepEqual(result, ["existente_1", "existente_2", "derivar-ventas"]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.method, "GET");
    assert.equal(requests[1]!.method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("muteConversation bloquea/mutea una conversación desde la API de Chatwoot", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(url).endsWith("/api/v1/accounts/1/conversations/123/mute"));
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)?.api_access_token, "admin-token");
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const client = createChatwootClient({
      baseUrl: "http://localhost:3000",
      accountId: 1,
      apiToken: "test-token",
      adminApiToken: "admin-token",
    });
    await client.muteConversation?.(123);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("sendMessage usa el token del Agent Bot", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>)?.api_access_token, "bot-token");
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  }) as typeof fetch;

  try {
    const client = createChatwootClient({
      baseUrl: "http://localhost:3000",
      accountId: 1,
      apiToken: "bot-token",
      adminApiToken: "admin-token",
    });
    await client.sendMessage(123, "hola");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assignAgent usa el token del Agent Bot, no el token personal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(url).endsWith("/api/v1/accounts/1/conversations/123/assignments"));
    assert.equal((init?.headers as Record<string, string>)?.api_access_token, "bot-token");
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const client = createChatwootClient({
      baseUrl: "http://localhost:3000",
      accountId: 1,
      apiToken: "bot-token",
      adminApiToken: "admin-token",
    });
    await client.assignAgent(123, 19);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getMessages usa el token admin y normaliza mensajes para validar respuestas humanas", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(url).endsWith("/api/v1/accounts/1/conversations/123/messages"));
    assert.equal(init?.method, "GET");
    assert.equal((init?.headers as Record<string, string>)?.api_access_token, "admin-token");
    return new Response(
      JSON.stringify({
        payload: [
          {
            id: 77,
            message_type: 1,
            private: false,
            created_at: 1791392400,
            sender: { id: 19, type: "User" },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const client = createChatwootClient({
      baseUrl: "http://localhost:3000",
      accountId: 1,
      apiToken: "bot-token",
      adminApiToken: "admin-token",
    });

    const messages = await client.getMessages?.(123);
    assert.equal(messages?.length, 1);
    assert.equal(messages?.[0]?.messageType, 1);
    assert.equal(messages?.[0]?.senderId, 19);
    assert.equal(messages?.[0]?.senderType, "User");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("si Chatwoot rechaza el token del bot, no reintenta con el token personal", async () => {
  const originalFetch = globalThis.fetch;
  const tokens: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    tokens.push((init?.headers as Record<string, string>).api_access_token ?? "");
    return new Response(null, { status: 403 });
  }) as typeof fetch;
  try {
    const client = createChatwootClient({
      baseUrl: "http://localhost:3000", accountId: 1,
      apiToken: "bot-token", adminApiToken: "marisol-token",
    });
    await assert.rejects(() => client.assignAgent(2936, 19), /No se intentará con el token personal/);
    assert.deepEqual(tokens, ["bot-token"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
