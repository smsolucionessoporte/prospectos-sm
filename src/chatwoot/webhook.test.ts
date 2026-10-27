import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import type { ChatwootClient } from "./client.js";
import { createChatwootWebhookProcessor, downloadAudioWithRetry, extractCleanName, isHumanClosingMessage, isSocialClosingReply, normalizeAudioExtension } from "./webhook.js";

test("extractCleanName limpia frases de respuesta y extrae únicamente el nombre", () => {
  assert.equal(extractCleanName("si, mi nombre es hernan"), "Hernan");
  assert.equal(extractCleanName("sí, me llamo Hernán Perez"), "Hernán Perez");
  assert.equal(extractCleanName("dale, soy Hernan gracias"), "Hernan");
  assert.equal(extractCleanName("hola buenas me llamo Andrés"), "Andrés");
  assert.equal(extractCleanName("Hernan"), "Hernan");
});


test("detecta el cierre humano que habilita ignorar cortesías posteriores", () => {
  assert.equal(isHumanClosingMessage("Gracias por la respuesta. Saludos."), true);
  assert.equal(isHumanClosingMessage("Muchas gracias por avisar"), true);
  assert.equal(isHumanClosingMessage("¿Querés coordinar una demo?"), false);
});

test("distingue cortesías de cierre de una nueva consulta comercial", () => {
  for (const reply of ["gracias", "ok", "dale", "igualmente", "👍", "Gracias igualmente"]) {
    assert.equal(isSocialClosingReply(reply), true, reply);
  }
  assert.equal(isSocialClosingReply("Al final quiero una demo"), false);
  assert.equal(isSocialClosingReply("¿Cuánto cuesta el sistema?"), false);
});

const TOKEN = "a".repeat(64);


test("normaliza audios .oga de Chatwoot a .ogg antes de transcribir", () => {
  assert.equal(normalizeAudioExtension("oga"), "ogg");
  assert.equal(normalizeAudioExtension(".OGA"), "ogg");
  assert.equal(normalizeAudioExtension("ogg"), "ogg");
});

test("downloadAudioWithRetry reintenta un 404 transitorio de Chatwoot y luego descarga el audio", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls < 3) {
      return new Response("todavía no disponible", { status: 404 });
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "audio/ogg" },
    });
  };

  const result = await downloadAudioWithRetry("https://chatwoot.example/audio.ogg", {
    fetchImpl: fakeFetch as typeof fetch,
    delaysMs: [0, 0, 0],
    timeoutMs: 1_000,
  });

  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.contentType, "audio/ogg");
  assert.equal(result.buffer.length, 4);
});

test("downloadAudioWithRetry no reintenta errores HTTP definitivos", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response("forbidden", { status: 403 });
  };

  await assert.rejects(
    () => downloadAudioWithRetry("https://chatwoot.example/audio.ogg", {
      fetchImpl: fakeFetch as typeof fetch,
      delaysMs: [0, 0, 0],
      timeoutMs: 1_000,
    }),
    /HTTP 403/,
  );
  assert.equal(calls, 1);
});

function payload(overrides: Record<string, unknown> = {}) {
  return {
    event: "message_created",
    id: 900,
    content: "Hola",
    message_type: "incoming",
    private: false,
    sender: { id: 44 },
    inbox: { id: 6 },
    account: { id: 1 },
    conversation: { id: 1405, inbox_id: 6, status: "pending", meta: {} },
    ...overrides
  };
}

test("rechaza un webhook sin el token privado correcto", () => {
  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: false },
    {} as Pool,
    {} as ChatwootClient
  );

  assert.equal(processor.accept("incorrecto", {}, payload()), null);
  assert.ok(processor.accept(TOKEN, {}, payload()));
});

test("filtra, deduplica y envía una sola bienvenida", async () => {
  const eventKeys = new Set<string>();
  let stage = "new";
  const sent: Array<{ conversationId: number; content: string }> = [];

  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("INSERT INTO webhook_events")) {
        const key = String(values?.[0]);
        if (eventKeys.has(key)) return { rowCount: 0, rows: [] };
        eventKeys.add(key);
        return { rowCount: 1, rows: [{ event_key: key }] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return { rowCount: 1, rows: [{ stage, human_handoff: false, state: {} }] };
      }

      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("prospect_followup_due_at") &&
        !sql.includes("SET stage =")
      ) {
        return { rowCount: 1, rows: [] };
      }

      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("SET stage =")
      ) {
        if (stage !== "new") return { rowCount: 0, rows: [] };
        stage = "awaiting_rubro";
        return { rowCount: 1, rows: [{ chatwoot_conversation_id: 1405 }] };
      }

      if (sql.includes("FROM bot_settings")) {
        return { rowCount: 1, rows: [{ text: "¿Qué tipo de negocio tenés?" }] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {

    async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

    async sendMessage(conversationId, content) {
      sent.push({ conversationId, content });
    },
    async setStatus() {},
    async getLabels() { return []; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },

    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client
  );
  const accepted1 = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "delivery-1" },
    payload()
  );

  const accepted2 = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "delivery-2" },
    payload()
  );

  assert.ok(accepted1);
  assert.ok(accepted2);

  // Mismo message.id de Chatwoot, pero dos entregas distintas del webhook.
  await processor.process(accepted1);
  await processor.process(accepted2);

  assert.deepEqual(sent, [
    {
      conversationId: 1405,
      content: "¡Hola! 👋 Soy el asistente virtual de SM Soluciones.\n\nTenemos distintas soluciones de gestión según las necesidades y la etapa de cada comercio. Te vamos a hacer unas preguntas breves para orientarte mejor. Primero contame:\n\n¿De qué rubro es tu negocio? 😊 (dietética, pet shop, carnicería, almacén, distribuidora, indumentaria, ferretería, etc.)"
    }
  ]);
});

test("responde el costo y vuelve a ofrecer demo o asesor", async () => {
  let stage = "awaiting_rubro";
  const sent: string[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return { rowCount: 1, rows: [{ stage, human_handoff: false, state: {} }] };
      }
      if (sql.includes("UPDATE conversation_state")) {
        if (values?.[1]) stage = String(values[1]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("FROM bot_settings")) {
        return { rowCount: 1, rows: [{ text: "Los planes arrancan desde los 30 mil pesos por mes." }] };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    {
          async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

      async sendMessage(_conversationId, content) { sent.push(content); },
      async setStatus() {},
      async getLabels() { return []; },
      async addLabels(_id, labels) { return labels; },            
      async removeLabels() { return []; },
      async assignAgent() {},
      async sendPrivateNote() {},
    }
  );
  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "delivery-dietetica" },
    payload({ id: 901, content: "cuál es el costo?" })
  );
  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(stage, "qualified");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.includes("Los planes arrancan desde los 30 mil pesos por mes"));
  assert.ok(sent[0]!.includes("¿Te gustaría ver una demostración de SM para tu negocio"));
  assert.ok(sent[0]!.includes("Contame qué preferís"));
});

test("ejecuta el flujo comercial con dos preguntas abiertas antes de derivar", async () => {
  let current = {
    stage: "new",
    human_handoff: false,
    rubro: null as string | null,
    state: {} as Record<string, unknown>
  };
  const sent: string[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return { rowCount: 1, rows: [{ ...current }] };
      }

      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("prospect_followup_due_at") &&
        !sql.includes("SET stage =")
      ) {
        return { rowCount: 1, rows: [] };
      }

      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("SET stage =")
      ) {
        current = {
          ...current,
          stage: String(values?.[1] ?? current.stage),
          rubro: values?.[2] != null ? String(values[2]) : current.rubro,
          human_handoff: values?.[3] != null ? Boolean(values[3]) : current.human_handoff,
          state: typeof values?.[5] === "string" ? JSON.parse(values[5]) : current.state
        };
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("FROM bot_settings")) {
        return { rowCount: 1, rows: [{ text: "Propuesta para dietéticas" }] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    {
          async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

      async sendMessage(_conversationId, content) { sent.push(content); },
      async setStatus() {},
      async getLabels() { return []; },
      async addLabels(_id, labels) { return labels; },
      async removeLabels() { return []; },

      async assignAgent() {},
      async sendPrivateNote() {},
    }
  );

  for (const [id, content] of [
    [910, "Hola como estás?"],
    [911, "Tengo una dietética"],
    [912, "Hoy uso Excel y anoto las ventas a mano"],
    [913, "Me cuesta controlar el stock y los precios"],
    [914, "Quiero coordinar una demo"],
    [915, "Andrés"]
  ] as const) {
    const accepted = processor.accept(TOKEN, { "x-chatwoot-delivery": `qualification-${id}` }, payload({ id, content }));
    assert.ok(accepted);
    await processor.process(accepted);
  }

  console.log("\n=== DEBUG FLUJO COMERCIAL ===");
sent.forEach((message, index) => {
  console.log(`\n[${index}] ${message}`);
});
console.log("\n=== FIN DEBUG ===\n");


assert.equal(sent.length, 7);
assert.equal(
  sent[0],
  "¡Hola! 👋 Soy el asistente virtual de SM Soluciones.\n\nTenemos distintas soluciones de gestión según las necesidades y la etapa de cada comercio. Te vamos a hacer unas preguntas breves para orientarte mejor. Primero contame:\n\n¿De qué rubro es tu negocio? 😊 (dietética, pet shop, carnicería, almacén, distribuidora, indumentaria, ferretería, etc.)"
);

// La propuesta principal viaja en dos mensajes: información + invitación a avanzar.
assert.ok(sent[1]!.includes("Hace más de 15 años"));
assert.ok(sent[1]!.includes("balanzas para venta por peso"));
assert.ok(sent[1]!.includes("diferentes planes"));
assert.ok(sent[1]!.includes("https://youtu.be/3PlRpHUcK2U"));
assert.doesNotMatch(sent[1]!, /1️⃣|2️⃣|asesor puede mostrarte/i);

assert.ok(sent[2]!.includes("¿cómo llevás hoy las ventas"));
assert.ok(sent[2]!.includes("Contame con tus palabras"));
assert.doesNotMatch(sent[2]!, /1️⃣|2️⃣/);
assert.ok(sent[2]!.includes("Excel"));
assert.ok(sent[2]!.includes("stock"));

assert.ok(sent[3]!.includes("¿Qué es lo que más necesitás mejorar"));
assert.ok(sent[4]!.includes("¿Te gustaría ver una demostración"));
assert.ok(sent[5]!.includes("¿Me podrías decir tu nombre?"));
assert.ok(sent[6]!.includes("¡Muchas gracias, Andrés!"));
assert.match(JSON.stringify(current.state), /Hoy uso Excel/);
assert.match(JSON.stringify(current.state), /Me cuesta controlar el stock/);

assert.equal(current.stage, "human");
assert.equal(current.human_handoff, true);
});

test("ignora eventos de otra bandeja", async () => {
  let queried = false;
  const pool = {
    async query() {
      queried = true;
      return { rowCount: 1, rows: [] };
    }
  } as unknown as Pool;

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    {
          async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

      async sendMessage() {},
      async setStatus() {},
      async getLabels() { return []; },
      async addLabels(_id, labels) { return labels; },            
      async removeLabels() { return []; },
      async assignAgent() {},
      async sendPrivateNote() {},
    }
  );
  const accepted = processor.accept(TOKEN, {}, payload({ inbox: { id: 3 } }));
  assert.ok(accepted);
  await processor.process(accepted);
  assert.equal(queried, false);
});

test("solicita nombre y deriva a una persona cuando piden demostración", async () => {
  let handedOff = false;
  const sent: string[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return { rowCount: 1, rows: [{ stage: "qualified", rubro: "dietetica", human_handoff: false }] };
      }
      if (sql.includes("FROM bot_settings")) return { rowCount: 1, rows: [{ text: "Te paso con Ventas" }] };
      if (sql.includes("UPDATE conversation_state")) {
        if (values?.[1] === "awaiting_name") {
          handedOff = true;
        }
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    {
          async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

      async sendMessage(_conversationId, content) { sent.push(content); },
      async setStatus() {},
      async getLabels() { return []; },
      async addLabels(_id, labels) { return labels; },      
      async removeLabels() { return []; },
      async assignAgent() {},
      async sendPrivateNote() {},
    }
  );
  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "delivery-demo" },
    payload({ id: 902, content: "Quiero coordinar una demo" })
  );
  assert.ok(accepted);
  await processor.process(accepted);

  assert.deepEqual(sent, ["¡Excelente! 😊 ¿Me podrías decir tu nombre? Así te derivamos con un asesor que te mostrará cómo funciona el sistema aplicado a tu negocio y podrá resolver todas tus dudas."]);
  assert.equal(handedOff, true);
});

test("detiene el bot cuando interviene un agente humano", async () => {
  let stopped = false;
  let resetAlertLevel = false;
  let sent = false;
  const pool = {
          async query(sql: string) {
        if (
          sql.includes("INSERT INTO conversation_state") &&
          sql.includes("pending_agent_since")
        ) {
          stopped = true;
          resetAlertLevel = sql.includes("sales_alert_level");
          return { rowCount: 1, rows: [] };
        }

        throw new Error(`Consulta inesperada: ${sql}`);
      }
  } as unknown as Pool;

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    {
          async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

      async sendMessage() { sent = true; },
      async setStatus() {},
      async getLabels() { return []; },
      async addLabels(_id, labels) { return labels; },            
      async removeLabels() { return []; },
      async assignAgent() {},
      async sendPrivateNote() {},
    }
  );
  const accepted = processor.accept(
    TOKEN,
    {},
    payload({
      id: 903,
      message_type: "outgoing",
      sender: { id: 12, type: "User" }
    })
  );
  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(stopped, true);
  assert.equal(resetAlertLevel, true, "La respuesta humana debe cortar y reiniciar el SLA");
  assert.equal(sent, false);
});

test("cierra la conversación cuando el cliente dice que no le interesa", async () => {
  const sent: string[] = [];
  const statuses: string[] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "qualified",
            rubro: "petshop",
            human_handoff: false,
            state: {}
          }]
        };
      }

      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

    async sendMessage(_conversationId, content) {
      sent.push(content);
    },

    async setStatus(_conversationId, status) {
      statuses.push(status);
    },

    async getLabels() {
      return ["bot-ventas-activo"];
    },

    async addLabels(_id, labels) {
      return labels;
    },

    async removeLabels() {
      return [];
    },

    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "delivery-no-interesado" },
    payload({
      id: 1501,
      content: "Aa no gracias"
    })
  );

  assert.ok(accepted);

  await processor.process(accepted);

  assert.deepEqual(sent, [
    "Entendido 😊 Gracias por avisarnos. ¡Saludos!"
  ]);

  assert.deepEqual(statuses, ["resolved"]);
});

test("marca una conversación resuelta para que el próximo mensaje sea tratado como recontacto", async () => {
  let markedForRecontact = false;

  const pool = {
    async query(sql: string) {
      if (
        sql.includes("is_recontact") &&
        sql.includes("recontact_prompted")
      ) {
        markedForRecontact = true;
      }

      return { rowCount: 1, rows: [] };
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "resolved" };
    },
    async sendMessage() {},
    async setStatus() {},
    async getLabels() { return ["bot-ventas-activo"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "resolved-recontact-marker" },
    payload({
      event: "conversation_updated",
      id: 1600,
      conversation: {
        id: 2316,
        inbox_id: 6,
        status: "resolved",
        labels: ["bot-ventas-activo"],
        meta: {}
      }
    })
  );

  assert.ok(accepted);
  await processor.process(accepted);
  assert.equal(markedForRecontact, true);
});

test("un recontacto resuelto vuelve a preguntar demo o asesor antes de responder o derivar", async () => {
  const sent: string[] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "proposal_sent",
            rubro: "comercio",
            human_handoff: false,
            prospect_followup_attempt: 0,
            user_message_count: 3,
            state: {
              is_recontact: true,
              recontact_prompted: false,
              memory: { rubro: "comercio" },
              chat_history: []
            }
          }]
        };
      }

      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },
    async sendMessage(_conversationId, content) { sent.push(content); },
    async setStatus() {},
    async getLabels() { return ["bot-ventas-activo", "meta"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "resolved-recontact-incoming" },
    payload({
      id: 1601,
      content: "El sistema funciona para verdulería?",
      conversation: {
        id: 2316,
        inbox_id: 6,
        status: "open",
        meta: {}
      }
    })
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.includes("¿Te gustaría ver una demostración de SM para tu negocio"));
  assert.doesNotMatch(sent[0]!, /1️⃣|2️⃣/);
  assert.ok(sent[0]!.includes("hablar primero con un asesor"));
  assert.ok(sent[0]!.includes("Contame qué preferís"));
  assert.ok(!sent[0]!.includes("Esta consulta puntual"));
});


test("cierra la conversación cuando el contacto indica que ingresó por error", async () => {
  const sent: string[] = [];
  const statuses: string[] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_rubro",
            rubro: null,
            human_handoff: false,
            state: {}
          }]
        };
      }

      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

    async sendMessage(_conversationId, content) {
      sent.push(content);
    },

    async setStatus(_conversationId, status) {
      statuses.push(status);
    },

    async getLabels() {
      return ["bot-ventas-activo"];
    },

    async addLabels(_id, labels) {
      return labels;
    },

    async removeLabels() {
      return [];
    },

    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "delivery-error-ingreso" },
    payload({
      id: 1502,
      content: "Entré por error, disculpá"
    })
  );

  assert.ok(accepted);

  await processor.process(accepted);

  assert.deepEqual(sent, [
    "Entendido 😊 Gracias por avisarnos. ¡Saludos!"
  ]);

  assert.deepEqual(statuses, ["resolved"]);
});


test("una respuesta normal activa el bot pero no agrega derivar-ventas", async () => {
  const labelCalls: string[][] = [];
  const sent: string[] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "new",
            human_handoff: false,
            user_message_count: 1
          }]
        };      
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      if (sql.includes("FROM bot_settings")) return { rowCount: 1, rows: [{ text: "Mensaje" }] };
      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },
    async sendMessage(_id, text) { sent.push(text); },
    async setStatus() {},
    async getLabels() { return ["existente_1"]; },
    async addLabels(_id, labels) {
      labelCalls.push(labels);
      return labels;
    },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client
  );

  const accepted = processor.accept(TOKEN, { "x-chatwoot-delivery": "deliv-normal" }, payload({ id: 950, content: "Hola" }));
  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent.length, 1);
  assert.ok(labelCalls.some((labels) => labels.includes("bot-ventas-activo")));
  assert.ok(!labelCalls.some(labels => labels.includes("derivar-ventas")));
});

test("handoff_to_sales agrega las etiquetas de ventas conservando etiquetas previas", async () => {  let labelsUpdated: string[] = [];
  const sent: string[] = [];
  let statusChanged = false;
  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_name",
            human_handoff: false,
            state: {},
            user_message_count: 1
          }]
        };      
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      if (sql.includes("FROM bot_settings")) return { rowCount: 1, rows: [{ text: "Propuesta" }] };
      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
        async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

    async sendMessage(_id, text) { sent.push(text); },
    async setStatus() {
      statusChanged = true;
    },
    async getLabels() { return ["etiqueta_existente"]; },
    async addLabels(_id, labelsToAdd) {
      labelsUpdated = Array.from(new Set(["etiqueta_existente", ...labelsToAdd]));
      return labelsUpdated;
    },
    async removeLabels() { return []; },

    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const answerService = {
    async answer() {
      return {
        kind: "answer" as const,
        text: "¡Perfecto! Te derivamos con un asesor comercial.",
        handoffToSales: true
      };
    }
  } as any;

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
    { info() {}, warn() {} },
    answerService
  );

  const accepted = processor.accept(TOKEN, { "x-chatwoot-delivery": "deliv-handoff-ai" }, payload({ id: 951, content: "Hernán" }));
  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.includes("¡Muchas gracias, Hernán!"));
  assert.deepEqual(labelsUpdated, [
    "etiqueta_existente",
    "derivar-ventas"
  ]);
  assert.equal(
    statusChanged,
    true,
    "La derivación inicial a ventas debe abrir la conversación"
  );
});

test("una conversación con derivar-ventas inicia/mantiene el SLA y no llama a OpenAI", async () => {
  let openAiCalled = false;
  let sentCount = 0;
  let slaStarted = false;
  const controlEvents: string[] = [];

  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        slaStarted =
          sql.includes("pending_agent_since") &&
          sql.includes("sales_alert_level") &&
          params?.[2] instanceof Date &&
          params?.[3] instanceof Date;
        return { rowCount: 1, rows: [] };
      }
      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("prospect_followup_due_at")
      ) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
        async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

    async sendMessage() { sentCount++; },
    async setStatus() {},
    async getLabels() { return ["derivar-ventas"]; },
    async addLabels(_id, labels) { return labels; },          
    async removeLabels() { return []; },

    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const answerService = {
    async answer() {
      openAiCalled = true;
      return { kind: "answer" as const, text: "No deberia ejecutarse" };
    }
  } as any;

  const prospectosClient = {
    async registerControlEvent(data: any) {
      controlEvents.push(data.evento);
    },
  } as any;

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
    { info() {}, warn() {} },
    answerService,
    undefined,
    prospectosClient,
  );

  const accepted = processor.accept(TOKEN, { "x-chatwoot-delivery": "deliv-already-human" }, payload({ id: 952, content: "Hola hay alguien?" }));
  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(openAiCalled, false);
  assert.equal(sentCount, 0);
  assert.equal(slaStarted, true, "El mensaje entrante derivado debe activar el SLA de 1h/2h/3h");
  assert.deepEqual(
    controlEvents,
    ["espera_vendedor"],
    "El panel de Prospectos debe iniciar el mismo ciclo pendiente que el bot",
  );
});

test("un error al agregar etiquetas registra advertencia y permite retry sin duplicar mensajes", async () => {
  const sent: string[] = [];
  let labelAttempts = 0;

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return { rowCount: 1, rows: [{ stage: "awaiting_name", human_handoff: false, state: {} }] };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      if (sql.includes("FROM bot_settings")) return { rowCount: 1, rows: [{ text: "Mensaje" }] };
      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
        async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

    async sendMessage(_id, text) { sent.push(text); },
    async setStatus() {},
    async getLabels() { return []; },
    async addLabels() {
      labelAttempts++;
      throw new Error("Chatwoot API error 500");
    },
    async sendPrivateNote() {},
    async removeLabels() { return []; },
    async assignAgent() {}
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client
  );

  const accepted = processor.accept(TOKEN, { "x-chatwoot-delivery": "deliv-err-label" }, payload({ id: 953, content: "Hernán" }));
  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent.length, 1);
  assert.ok(labelAttempts >= 1);
  assert.ok(sent[0]!.includes("¡Muchas gracias, Hernán!"));
});

test("sincroniza el prospecto al derivarlo a ventas sin convertir origen desconocido en manual", async () => {
  let prospectPayload: any = null;

  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_name",
            rubro: "dietetica",
            human_handoff: false,
            state: {}
          }]
        };
      }

      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      if (
        sql.includes("FROM bot_settings") &&
        sql.includes("last_assignee_id")
      ) {
        return {
          rowCount: 1,
          rows: [{ last_assignee_id: null }]
        };
      }

      if (
        sql.includes("INSERT INTO bot_settings") &&
        sql.includes("sales_round_robin")
      ) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("FROM bot_settings")) {
        return {
          rowCount: 1,
          rows: [{ text: "Propuesta" }]
        };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
        async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

    async sendMessage() {},
    async setStatus() {},
    async getLabels() {
      return [];
    },
    async addLabels(_id, labels) {
      return labels;
    },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

    const prospectosClient = {
      async syncProspect(payload: any) {
        prospectPayload = payload;
        return { ok: true, id: 123 };
      },

      async updateStatus(_payload: any): Promise<void> {
      },
      async updateOrigin(
        _conversationId: number,
        _origen: "meta" | "google"
      ): Promise<void> {
      },

      async registerControlEvent(_payload: any): Promise<void> {
      },
      async updateAssignee(
        _conversationId: number,
        _chatwootAgentId: number
      ): Promise<void> {
      }
    };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true,
      salesAgents: [
      { id: 8, name: "Rafael" },
      { id: 12, name: "Giuliano" }
    ]
    },
    pool,
    client,
    { info() {}, warn() {} },
    undefined,
    undefined,
    prospectosClient
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "prospect-sync-1" },
    payload({
      id: 970,
      content: "Marisol",
      sender: {
        id: 44,
        name: "Marisol",
        phone_number: "+5491122334455"
      },
      conversation: {
        id: 1601,
        inbox_id: 6,
        status: "pending",
        meta: {
          sender: {
            id: 44,
            phone_number: "+5491122334455"
          }
        }
      }
    })
  );

  assert.ok(accepted);

  await processor.process(accepted);

  assert.ok(prospectPayload);

  assert.equal(prospectPayload.nombre_contacto, "Marisol");
  assert.equal(prospectPayload.telefono, "+5491122334455");
  assert.equal(prospectPayload.rubro, "dietetica");
  assert.equal(prospectPayload.origen, "otro");
  assert.equal(prospectPayload.chatwoot_agent_id, 8);
  assert.equal(prospectPayload.chatwoot_conversation_id, 1601);
});


test("sincroniza prospecto interno al agregar la etiqueta manualmente", async () => {
  let prospectPayload: any = null;

const pool = {
  async query(sql: string) {
    // Paso 9: conversation_updated consulta el estado previo
    // para detectar si bot-ventas-activo fue removida manualmente.
    if (
      sql.includes("SELECT stage, human_handoff") &&
      sql.includes("FROM conversation_state")
    ) {
      return {
        rowCount: 0,
        rows: [],
      };
    }

    if (
      sql.includes("SELECT rubro, state") &&
      sql.includes("FROM conversation_state")
    ) {
      return {
        rowCount: 1,
        rows: [{
          rubro: null,
          state: {}
        }]
      };
    }

    throw new Error(`Consulta inesperada: ${sql}`);
  }
} as unknown as Pool;

  const client: ChatwootClient = {
        async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },
    
    async sendMessage() {},
    async setStatus() {},
    async getLabels() {
      return [];
    },
    async addLabels(_id, labels) {
      return labels;
    },
          async removeLabels() { return []; },

    async assignAgent() {},
    async sendPrivateNote() {},
  };

    const prospectosClient = {
      async syncProspect(payload: any) {
        prospectPayload = payload;
        return { ok: true, id: 123 };
      },

      async updateStatus(_payload: any): Promise<void> {
      },
      async updateOrigin(
        _conversationId: number,
        _origen: "meta" | "google"
      ): Promise<void> {
      },

      async updateAssignee(
        _conversationId: number,
        _chatwootAgentId: number
      ): Promise<void> {
      },

      async registerControlEvent(_payload: any): Promise<void> {
      }
    };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true,
      salesAgents: [
        { id: 8, name: "Rafael" },
        { id: 12, name: "Giuliano" }
      ]    
    },
    pool,
    client,
    { info() {}, warn() {} },
    undefined,
    undefined,
    prospectosClient
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "prospect-interno-1" },
    {
      event: "conversation_updated",
      id: 1602,
      account: {
        id: 1
      },
      inbox: {
        id: 6
      },
      labels: ["prospecto-interno"],
      meta: {
        sender: {
          id: 44,
          name: "Cliente Interno",
          phone_number: "+5491122334455"
        },
        assignee: {
          id: 8
        }
      },
      conversation: {
        id: 1602,
        inbox_id: 6,
        labels: ["prospecto-interno"],
        meta: {
          sender: {
            id: 44,
            name: "Cliente Interno",
            phone_number: "+5491122334455"
          },
          assignee: {
            id: 8
          }
        }
      }
    }
  );

  assert.ok(accepted);

  await processor.process(accepted);

  assert.ok(prospectPayload);
  assert.equal(prospectPayload.nombre_contacto, "Cliente Interno");
  assert.equal(prospectPayload.telefono, "+5491122334455");
  assert.equal(prospectPayload.rubro, null);
  assert.equal(prospectPayload.origen, "prospecto-interno");
  assert.equal(prospectPayload.chatwoot_agent_id, 8);
  assert.equal(prospectPayload.chatwoot_conversation_id, 1602);
});

test("detecta Google Ads por metadata y agrega google", async () => {
  const labelCalls: string[][] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "new",
            human_handoff: false,
            rubro: null,
            state: {},
            user_message_count: 1
          }]
        };
      }

      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("FROM bot_settings")) {
        return { rowCount: 1, rows: [{ text: "Mensaje" }] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },
    async sendMessage() {},
    async setStatus() {},
    async getLabels() {
      return [];
    },
    async addLabels(_id, labels) {
      labelCalls.push(labels);
      return labels;
    },
    async removeLabels() {
      return [];
    },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "google-origin-1" },
    payload({
      id: 1980,
      content:
        "Hola, quiero más información sobre SM Soluciones.",
      conversation: {
        id: 2980,
        inbox_id: 6,
        status: "pending",
        meta: {},
        additional_attributes: {
          source: "google",
          utm_source: "google",
          utm_medium: "cpc",
          gclid: "test-gclid-123"
        }
      }
    })
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.ok(
    labelCalls.some(labels =>
      labels.includes("google")
    )
  );

  assert.ok(
    !labelCalls.some(labels =>
      labels.includes("meta")
    )
  );
});

test("sitio web organico se clasifica como web y no como Google Ads", async () => {
  const labelCalls: string[][] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "new",
            human_handoff: false,
            rubro: null,
            state: {},
            user_message_count: 1
          }]
        };
      }

      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("FROM bot_settings")) {
        return { rowCount: 1, rows: [{ text: "Mensaje" }] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },
    async sendMessage() {},
    async setStatus() {},
    async getLabels() {
      return [];
    },
    async addLabels(_id, labels) {
      labelCalls.push(labels);
      return labels;
    },
    async removeLabels() {
      return [];
    },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "web-organic-origin-1" },
    payload({
      id: 1982,
      content:
        "Hola, vengo desde el sitio web. Me gustaría más información sobre SM Soluciones.",
      conversation: {
        id: 2982,
        inbox_id: 6,
        status: "pending",
        meta: {},
        additional_attributes: {
          source: "website",
          utm_source: "google",
          utm_medium: "organic"
        }
      }
    })
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.ok(
    !labelCalls.some(labels => labels.includes("google"))
  );
  assert.ok(
    !labelCalls.some(labels => labels.includes("meta"))
  );
  assert.ok(
    labelCalls.some(labels => labels.includes("web"))
  );
  assert.ok(
    !labelCalls.some(labels => labels.includes("auditar-origen"))
  );
});

test("detecta Meta por el mensaje inicial y agrega meta", async () => {
  const labelCalls: string[][] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "new",
            human_handoff: false,
            rubro: null,
            state: {},
            user_message_count: 1
          }]
        };
      }

      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("FROM bot_settings")) {
        return { rowCount: 1, rows: [{ text: "Mensaje" }] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },
    async sendMessage() {},
    async setStatus() {},
    async getLabels() {
      return [];
    },
    async addLabels(_id, labels) {
      labelCalls.push(labels);
      return labels;
    },
    async removeLabels() {
      return [];
    },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "meta-origin-1" },
    payload({
      id: 1981,
      content:
        "¡Hola! Quiero más información\n\nChatea con nosotros\nUn pet shop que vende a granel necesita más que intuición. Necesita datos.\nhttps://fb.me/7Ztmwmdun",
      conversation: {
        id: 2981,
        inbox_id: 6,
        status: "pending",
        meta: {}
      }
    })
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.ok(
    labelCalls.some(labels =>
      labels.includes("meta")
    )
  );

  assert.ok(
    !labelCalls.some(labels =>
      labels.includes("google")
    )
  );
});

test("ignora conversaciones de teléfonos internos", async () => {
  const labelCalls: string[][] = [];
  let sentMessages = 0;

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "new",
            human_handoff: false,
            rubro: null,
            state: {},
            user_message_count: 1
          }]
        };
      }

      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("FROM bot_settings")) {
        return { rowCount: 1, rows: [{ text: "Mensaje" }] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },

    async sendMessage() {
      sentMessages += 1;
    },

    async setStatus() {},

    async getLabels() {
      return [];
    },

    async addLabels(_id, labels) {
      labelCalls.push(labels);
      return labels;
    },

    async removeLabels() {
      return [];
    },

    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "internal-phone-1" },
    payload({
      id: 3001,
      content:
        "Hola, vengo desde el sitio web. Me gustaría más información sobre SM Soluciones.",
      conversation: {
        id: 4001,
        inbox_id: 6,
        status: "pending",
        meta: {
        sender: {
          id: 999,
          phone_number: "+54 9 11 5564-4899"
        }
        }
      }
    })
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sentMessages, 0);
  assert.equal(labelCalls.length, 0);
});

test("si espera el rubro y no entiende la respuesta no repite la bienvenida", async () => {
  const sent: string[] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_rubro",
            rubro: null,
            human_handoff: false,
            state: {}
          }]
        };
      }

      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },

    async sendMessage(_id, content) {
      sent.push(content);
    },

    async setStatus() {},
    async getLabels() {
      return ["bot-ventas-activo"];
    },
    async addLabels(_id, labels) {
      return labels;
    },
    async removeLabels() {
      return [];
    },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "rubro-incomprensible-1" },
    payload({
      id: 990,
      content: "Bno"
    })
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.deepEqual(sent, [
  "Disculpas, no llegué a identificar el rubro 😊. Para brindarte información acorde, me indicarías a qué se dedica tu comercio? Por ejemplo: dietética, pet shop, carnicería, almacén, distribuidora, indumentaria, ferretería, etc."
  ]);

  assert.ok(
    !sent.some(message =>
      message.includes("¡Hola! 👋 ¡Muy bien, gracias por escribirnos!")
    )
  );
});

test("reenvía la información si el prospecto dice que no la recibió después del seguimiento", async () => {
  const sent: string[] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("prospect_followup_due_at = NULL")
      ) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "proposal_sent",
            human_handoff: false,
            rubro: "dietetica",
            prospect_followup_attempt: 1,
            state: {
              memory: {
                rubro: "dietetica",
                proposal_sent: true
              },
              chat_history: []
            }
          }]
        };
      }

      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

    async sendMessage(_conversationId, content) {
      sent.push(content);
    },

    async setStatus() {},
    async getLabels() {
      return ["bot-ventas-activo"];
    },
    async addLabels(_id, labels) {
      return labels;
    },
    async removeLabels() {
      return [];
    },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "followup-info-not-received-1" },
    payload({
      id: 995,
      content: "No me llegó nada"
    })
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent.length, 3);

  assert.equal(
    sent[0],
    "¡Claro! Te reenvío la información 😊"
  );

  assert.ok(sent[1]!.includes("balanzas para venta por peso"));
  assert.ok(sent[1]!.includes("diferentes planes"));
  assert.ok(sent[1]!.includes("https://youtu.be/3PlRpHUcK2U"));
  assert.ok(sent[2]!.includes("¿cómo llevás hoy las ventas"));
  assert.ok(sent[2]!.includes("Contame con tus palabras"));
});

test("un mensaje saliente de Bot Ventas no se interpreta como intervención humana", async () => {
  let humanHandoffActivated = false;

  const pool = {
    async query(sql: string) {
      if (
        sql.includes("stage = 'human'") &&
        sql.includes("human_handoff = TRUE")
      ) {
        humanHandoffActivated = true;
      }

      return {
        rowCount: 1,
        rows: []
      };
    }
  } as unknown as Pool;

  const client = {} as ChatwootClient;

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true,
      botAgentId: 12
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "bot-ventas-outgoing-1" },
    payload({
      id: 996,
      content: "Mensaje enviado por Bot Ventas",
      message_type: "outgoing",
      sender: {
        id: 12,
        type: "agent"
      }
    })
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(
    humanHandoffActivated,
    false,
    "Bot Ventas no debe activar human_handoff"
  );
});



test("la etiqueta consulta-erronea limpia el circuito y resuelve la conversación", async () => {
  const queries: string[] = [];
  const removed: string[][] = [];
  const statuses: string[] = [];
  const controlEvents: string[] = [];

  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rowCount: 1, rows: [] };
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage() {},
    async setStatus(_id, status) { statuses.push(status); },
    async getLabels() { return ["consulta-erronea", "derivar-ventas", "bot-ventas-activo"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels(_id, labels) { removed.push(labels); return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
    { info() {}, warn() {} },
    undefined,
    undefined,
    {
      async registerControlEvent(data: any) { controlEvents.push(data.evento); },
    } as any,
  );

  const accepted = processor.accept(
    TOKEN,
    {},
    {
      event: "conversation_updated",
      id: 2316,
      conversation: {
        id: 2316,
        inbox_id: 6,
        status: "open",
        labels: ["consulta-erronea", "derivar-ventas", "bot-ventas-activo"],
        meta: {},
      },
      account: { id: 1 },
    },
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.ok(queries.some(sql => sql.includes("pending_agent_alert_due_at = NULL")));
  const exclusionQuery = queries.find((sql) => sql.includes("manual_exclusion")) ?? "";
  assert.match(exclusionQuery, /rubro = NULL/);
  assert.match(exclusionQuery, /- 'rubro_libre'/);
  assert.match(exclusionQuery, /- 'lead_intent'/);
  assert.match(exclusionQuery, /- 'requested_demo'/);
  assert.match(exclusionQuery, /- 'handoff_message_sent'/);
  assert.match(exclusionQuery, /- 'sales_alert_level'/);
  assert.match(exclusionQuery, /- 'chat_history'/);
  assert.deepEqual(controlEvents, ["consulta_erronea"]);
  assert.deepEqual(removed, [["derivar-ventas", "bot-ventas-activo"]]);
  assert.deepEqual(statuses, ["resolved"]);
});

test("un mensaje de campaña no se interpreta como intervención humana y reactiva el bot comercial", async () => {
  const queries: string[] = [];

  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rowCount: 1, rows: [] };
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage() {},
    async setStatus() {},
    async getLabels() { return []; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, botAgentId: 99, replyEnabled: true },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    {},
    {
      event: "message_created",
      id: 5001,
      content: "Queremos retomar tu consulta",
      content_attributes: { sm_prospectos_campaign: true, campania_id: 8 },
      message_type: "outgoing",
      private: false,
      sender: { id: 10, type: "user" },
      inbox: { id: 6 },
      account: { id: 1 },
      conversation: { id: 3001, inbox_id: 6, status: "open", meta: {} },
    },
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(queries.length, 1);
  assert.ok(queries[0]!.includes("stage = 'proposal_sent'"));
  assert.ok(queries[0]!.includes("human_handoff = FALSE"));
  assert.ok(!queries[0]!.includes("human_handoff = TRUE"));
});

test("acepta una descripcion libre del negocio mientras espera rubro", async () => {
  // mensaje:
  // "Per Shop y tengo un local de celulares. Servicio técnico y accesorios"

  // verificar:
  // - no vuelve a preguntar rubro
  // - no deriva por duda
  // - guarda rubro libre
  // - avanza a proposal_sent
});
test("si después de la propuesta aclara el rubro, vuelve a ofrecer demo y no responde como duda", async () => {
  const sent: string[] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }

      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }

      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "proposal_sent",
            human_handoff: false,
            rubro: "comercio",
            prospect_followup_attempt: 0,
            state: {
              memory: {
                rubro: "comercio",
                proposal_sent: true
              },
              chat_history: []
            }
          }]
        };
      }

      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },
    async sendMessage(_conversationId, content) {
      sent.push(content);
    },
    async setStatus() {},
    async getLabels() { return ["bot-ventas-activo", "meta"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true
    },
    pool,
    client
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "rubro-after-proposal-1" },
    payload({
      id: 997,
      content: "Pollería"
    })
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.includes("¿Te gustaría ver una demostración de SM para tu negocio"));
  assert.doesNotMatch(sent[0]!, /1️⃣|2️⃣/);
  assert.ok(sent[0]!.includes("hablar primero con un asesor"));
  assert.ok(sent[0]!.includes("Contame qué preferís"));

  assert.ok(
    !sent.some(message => message.includes("Esta consulta puntual te la responderá"))
  );
});

test("interpreta un audio usando transcribed_text de Chatwoot y reconoce tapicero como comercio", async () => {
  const sent: string[] = [];
  let savedStage = "awaiting_rubro";

  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }
      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("prospect_followup_due_at = NULL") &&
        !sql.includes("SET stage =")
      ) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: savedStage,
            human_handoff: false,
            rubro: null,
            state: {},
            prospect_followup_attempt: 0,
            user_message_count: 1,
          }],
        };
      }
      if (sql.includes("UPDATE conversation_state")) {
        if (typeof values?.[1] === "string") savedStage = String(values[1]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage(_id, content) { sent.push(content); },
    async setStatus() {},
    async getLabels() { return ["bot-ventas-activo", "web"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "audio-transcribed-1" },
    payload({
      id: 6001,
      content: "",
      attachments: [{
        id: 77,
        file_type: "audio",
        data_url: "https://example.invalid/audio.ogg",
        transcribed_text: "Soy tapicero",
      }],
    }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.ok(sent.some((message) => message.includes("Con SM podés")));
  assert.ok(sent.some((message) => message.includes("¿cómo llevás hoy las ventas")));
  assert.ok(!sent.some((message) => message.includes("no pude interpretar el audio")));
});

test("si no puede interpretar un audio pide continuar por escrito sin marcar rubro inválido", async () => {
  const sent: string[] = [];
  const queries: string[] = [];

  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_rubro",
            human_handoff: false,
            rubro: null,
            state: {},
            prospect_followup_attempt: 0,
            user_message_count: 1,
          }],
        };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage(_id, content) { sent.push(content); },
    async setStatus() {},
    async getLabels() { return ["bot-ventas-activo"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "audio-fallback-1" },
    payload({
      id: 6002,
      content: "",
      attachments: [{
        id: 78,
        file_type: "audio",
        data_url: "",
      }],
    }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /no pude interpretar el audio/i);
  assert.match(sent[0] ?? "", /rubro \(dietética, almacén, carnicería/i);
  assert.ok(queries.some((sql) => sql.includes("audio_transcription_failed")));
  assert.ok(!queries.some((sql) => sql.includes("rubro_invalid_attempts")));
});

test("una consulta-erronea se recupera si el contacto vuelve con un rubro válido", async () => {
  const sent: string[] = [];
  const removed: string[][] = [];
  const added: string[][] = [];
  const statuses: string[] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_rubro",
            human_handoff: false,
            rubro: null,
            state: {},
            prospect_followup_attempt: 0,
            user_message_count: 2,
          }],
        };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  let firstLabelsRead = true;
  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage(_id, content) { sent.push(content); },
    async setStatus(_id, status) { statuses.push(status); },
    async getLabels() {
      if (firstLabelsRead) {
        firstLabelsRead = false;
        return ["consulta-erronea", "web"];
      }
      return ["consulta-erronea", "web"];
    },
    async addLabels(_id, labels) { added.push(labels); return labels; },
    async removeLabels(_id, labels) { removed.push(labels); return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "wrong-query-recovery-1" },
    payload({ id: 6003, content: "Soy tapicero" }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.ok(removed.some((labels) => labels.includes("consulta-erronea")));
  assert.ok(added.some((labels) => labels.includes("bot-ventas-activo")));
  assert.ok(statuses.includes("open"));
  assert.ok(sent.some((message) => message.includes("Con SM podés")));
});

test("bloquea una consulta-erronea solo después de dos mensajes adicionales que siguen siendo ajenos", async () => {
  let repeatCount = 0;
  let muteCalls = 0;
  const added: string[][] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("wrong_query_repeat_count") && sql.includes("RETURNING")) {
        repeatCount += 1;
        return { rowCount: 1, rows: [{ repeat_count: repeatCount }] };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage() {},
    async setStatus() {},
    async getLabels() { return ["consulta-erronea"]; },
    async addLabels(_id, labels) { added.push(labels); return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async muteConversation() { muteCalls += 1; },
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
  );

  for (const [id, content] of [[6004, "asdf qwerty"], [6005, "lalala nada que ver"]] as const) {
    const accepted = processor.accept(
      TOKEN,
      { "x-chatwoot-delivery": `wrong-query-repeat-${id}` },
      payload({ id, content }),
    );
    assert.ok(accepted);
    await processor.process(accepted);
  }

  assert.equal(muteCalls, 1);
  assert.ok(added.some((labels) => labels.includes("bloqueado-bot")));
});

test("un segundo ingreso con la plantilla web recibe seguimiento automático en vez de quedar sin respuesta", async () => {
  const sent: string[] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_rubro",
            human_handoff: false,
            rubro: null,
            state: { requested_demo: true },
            prospect_followup_attempt: 0,
            user_message_count: 2,
          }],
        };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage(_id, content) { sent.push(content); },
    async setStatus() {},
    async getLabels() { return ["bot-ventas-activo", "web"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "website-reentry-2619" },
    payload({
      id: 6006,
      content: "Hola, vengo desde el sitio web. Me gustaría solicitar una demostración del software de gestión.",
      conversation: { id: 2619, inbox_id: 6, status: "open", meta: {} },
    }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /retomaste tu consulta/i);
  assert.match(sent[0] ?? "", /rubro es tu negocio y tu nombre/i);
});


test("si Ventas ya había contactado pero el cliente vuelve a escribir, quita contactado-ventas y reinicia el SLA", async () => {
  let labels = ["derivar-ventas", "contactado-ventas", "meta"];
  const removed: string[][] = [];
  const controlEvents: string[] = [];
  let slaStarted = false;

  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }
      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("prospect_followup_due_at = NULL") &&
        !sql.includes("SET stage =")
      ) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }
      if (sql.includes("INSERT INTO conversation_state")) {
        slaStarted =
          sql.includes("pending_agent_since") &&
          params?.[2] instanceof Date &&
          params?.[3] instanceof Date;
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },
    async sendMessage() {},
    async setStatus() {},
    async getLabels() {
      return labels;
    },
    async addLabels(_id, labelsToAdd) {
      labels = Array.from(new Set([...labels, ...labelsToAdd]));
      return labels;
    },
    async removeLabels(_id, labelsToRemove) {
      removed.push(labelsToRemove);
      labels = labels.filter((label) => !labelsToRemove.includes(label));
      return labels;
    },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const prospectosClient = {
    async registerControlEvent(data: any) {
      controlEvents.push(data.evento);
    },
  } as any;

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
    { info() {}, warn() {} },
    undefined,
    undefined,
    prospectosClient,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "sales-client-replied-after-contact" },
    payload({
      id: 7001,
      content: "Tengo una carnicería",
      conversation: { id: 2686, inbox_id: 6, status: "open", meta: {} },
    }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.ok(
    removed.some((item) => item.includes("contactado-ventas")),
    "Un mensaje nuevo del cliente debe invalidar la marca contactado-ventas anterior",
  );
  assert.ok(!labels.includes("contactado-ventas"));
  assert.equal(slaStarted, true);
  assert.deepEqual(controlEvents, ["espera_vendedor"]);
});

test("estoy viendo gracias mantiene seguimiento y no repite el CTA ni consulta a la IA", async () => {
  const sent: string[] = [];
  let aiCalled = false;
  let followupScheduled = false;

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }
      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("prospect_followup_due_at = NULL") &&
        !sql.includes("SET stage =")
      ) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "qualified",
            human_handoff: false,
            rubro: "comercio",
            state: {
              memory: { rubro: "comercio" },
              chat_history: [],
            },
            prospect_followup_attempt: 0,
            user_message_count: 2,
          }],
        };
      }
      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("prospect_followup_due_at = NOW() + INTERVAL '24 hours'")
      ) {
        followupScheduled = true;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },
    async sendMessage(_id, content) {
      sent.push(content);
    },
    async setStatus() {},
    async getLabels() {
      return ["bot-ventas-activo", "web"];
    },
    async addLabels(_id, labelsToAdd) {
      return labelsToAdd;
    },
    async removeLabels() {
      return [];
    },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const answerService = {
    async answer() {
      aiCalled = true;
      return {
        kind: "answer" as const,
        text: "Esta consulta puntual te la responderá un asesor.",
      };
    },
  } as any;

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
    { info() {}, warn() {} },
    answerService,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "reviewing-proposal-1" },
    payload({ id: 7002, content: "Estoy viendo gracias" }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(aiCalled, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /revisalo tranquilo/i);
  assert.ok(!(sent[0] ?? "").includes("1️⃣"));
  assert.ok(!(sent[0] ?? "").includes("2️⃣"));
  assert.equal(followupScheduled, true);
});

test("un emoji positivo mientras espera rubro repregunta sin sumar intento inválido", async () => {
  const sent: string[] = [];
  let savedState: Record<string, unknown> | null = null;

  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rowCount: 1, rows: [{}] };
      }
      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("prospect_followup_due_at = NULL") &&
        !sql.includes("SET stage =")
      ) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("bot_behavior")) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_rubro",
            human_handoff: false,
            rubro: null,
            state: { memory: {}, chat_history: [] },
            prospect_followup_attempt: 0,
            user_message_count: 2,
          }],
        };
      }
      if (
        sql.includes("UPDATE conversation_state") &&
        sql.includes("SET stage = $2, rubro = $3")
      ) {
        savedState = JSON.parse(String(params?.[5] ?? "{}"));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE conversation_state")) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },
    async sendMessage(_id, content) {
      sent.push(content);
    },
    async setStatus() {},
    async getLabels() {
      return ["bot-ventas-activo", "web"];
    },
    async addLabels(_id, labelsToAdd) {
      return labelsToAdd;
    },
    async removeLabels() {
      return [];
    },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
    { info() {}, warn() {} },
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "emoji-rubro-1" },
    payload({
      id: 7003,
      content: "👍",
      conversation: { id: 2795, inbox_id: 6, status: "open", meta: {} },
    }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /de qué rubro es tu negocio/i);
  assert.ok(!(sent[0] ?? "").includes("Soy el asistente virtual"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(savedState ?? {}, "rubro_invalid_attempts"),
    false,
  );
});

test("auditar-origen nunca crea un prospecto por si sola", async () => {
  let syncCalls = 0;

  const pool = {
    async query(sql: string) {
      if (
        sql.includes("SELECT stage, human_handoff") &&
        sql.includes("FROM conversation_state")
      ) {
        return { rowCount: 0, rows: [] };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) {
      return { id: conversationId, status: "open" };
    },
    async sendMessage() {},
    async setStatus() {},
    async getLabels() {
      return ["web", "auditar-origen"];
    },
    async addLabels(_id, labels) {
      return labels;
    },
    async removeLabels() {
      return ["web"];
    },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const prospectosClient = {
    async syncProspect(_payload: any) {
      syncCalls += 1;
      return { ok: true, id: 999 };
    },
    async updateStatus(_conversationId: number, _estado: "prospecto" | "sin_respuesta") {},
    async updateOrigin(_conversationId: number, _origen: "meta" | "google" | "web") {},
    async updateAssignee(_conversationId: number, _chatwootAgentId: number) {},
    async registerControlEvent(_payload: any) {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true,
      salesAgents: [
        { id: 8, name: "Rafael" },
        { id: 12, name: "Giuliano" },
      ],
    },
    pool,
    client,
    { info() {}, warn() {} },
    undefined,
    undefined,
    prospectosClient,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "auditar-origen-no-prospecto-1" },
    {
      event: "conversation_updated",
      id: 1799,
      account: { id: 1 },
      inbox: { id: 6 },
      labels: ["web", "auditar-origen"],
      meta: {
        sender: {
          id: 44,
          name: "Contacto Web",
          phone_number: "+5491122334455",
        },
      },
      conversation: {
        id: 1799,
        inbox_id: 6,
        status: "open",
        labels: ["web", "auditar-origen"],
        meta: {
          sender: {
            id: 44,
            name: "Contacto Web",
            phone_number: "+5491122334455",
          },
        },
      },
    },
  );

  assert.ok(accepted);
  await processor.process(accepted);
  assert.equal(syncCalls, 0);
});


test("una consulta-erronea reactivada limpia rubro e intención viejos antes de continuar", async () => {
  const recoveryQueries: string[] = [];
  const sent: string[] = [];
  let labels = ["consulta-erronea", "web"];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("UPDATE conversation_state") && sql.includes("rubro = NULL")) {
        recoveryQueries.push(sql);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_rubro",
            human_handoff: false,
            rubro: null,
            state: { memory: {}, chat_history: [] },
            prospect_followup_attempt: 0,
            user_message_count: 3,
          }],
        };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage(_id, content) { sent.push(content); },
    async setStatus() {},
    async getLabels() { return labels; },
    async addLabels(_id, toAdd) { labels = [...new Set([...labels, ...toAdd])]; return labels; },
    async removeLabels(_id, toRemove) { labels = labels.filter((l) => !toRemove.includes(l)); return labels; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "wrong-query-prefilled-reset" },
    payload({
      id: 8101,
      content: "Hola, vengo desde el sitio web. Me gustaría solicitar una demostración del software de gestión.",
      conversation: { id: 2793, inbox_id: 6, status: "open", meta: {} },
    }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(recoveryQueries.length, 1);
  assert.match(recoveryQueries[0] ?? "", /rubro = NULL/);
  assert.match(recoveryQueries[0] ?? "", /- 'is_recontact'/);
  assert.match(recoveryQueries[0] ?? "", /- 'requested_demo'/);
  assert.match(recoveryQueries[0] ?? "", /- 'rubro_libre'/);
  assert.match(recoveryQueries[0] ?? "", /- 'handoff_message_sent'/);
  assert.match(recoveryQueries[0] ?? "", /- 'sales_alert_level'/);
  assert.match(recoveryQueries[0] ?? "", /- 'chat_history'/);
  assert.match(recoveryQueries[0] ?? "", /- 'manual_exclusion'/);
  assert.ok(sent.some((message) => /rubro es tu negocio|indica.*rubro/i.test(message)));
  assert.ok(!sent.some((message) => /Respondeme con \*?1 o 2\*?/i.test(message)));
});

test("no tengo no puede guardarse como rubro libre", async () => {
  const sent: string[] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_rubro",
            human_handoff: false,
            rubro: null,
            state: { memory: { requested_demo: true }, chat_history: [] },
            prospect_followup_attempt: 0,
            user_message_count: 2,
          }],
        };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage(_id, content) { sent.push(content); },
    async setStatus() {},
    async getLabels() { return ["bot-ventas-activo", "web"]; },
    async addLabels(_id, labelsToAdd) { return labelsToAdd; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "no-tengo-rubro" },
    payload({ id: 8102, content: "no. tengo", conversation: { id: 2793, inbox_id: 6, status: "open", meta: {} } }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.ok(sent.some((message) => /a qué se dedica tu negocio|de qué rubro es tu negocio/i.test(message)));
  assert.ok(!sent.some((message) => message.includes("Con SM podés")));
});

test("ok en un recontacto no autoriza una derivación", async () => {
  const sent: string[] = [];
  let assignCalls = 0;

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "qualified",
            human_handoff: false,
            rubro: "comercio",
            state: {
              is_recontact: true,
              recontact_prompted: true,
              lead_name: "Facu",
              memory: { lead_name: "Facu", rubro: "comercio" },
              chat_history: [],
            },
            prospect_followup_attempt: 0,
            user_message_count: 4,
          }],
        };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage(_id, content) { sent.push(content); },
    async setStatus() {},
    async getLabels() { return ["bot-ventas-activo", "web"]; },
    async addLabels(_id, labelsToAdd) { return labelsToAdd; },
    async removeLabels() { return []; },
    async assignAgent() { assignCalls += 1; },
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "recontact-ok-no-handoff" },
    payload({ id: 8103, content: "ok", conversation: { id: 2793, inbox_id: 6, status: "open", meta: {} } }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(assignCalls, 0);
  assert.ok(sent.some((message) => /demostración de SM|hablar primero con un asesor/i.test(message)));
  assert.ok(!sent.some((message) => /te volvemos a poner en contacto/i.test(message)));
});

test("resolver una consulta-erronea no la marca como recontacto comercial", async () => {
  let markedForRecontact = false;

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (
        sql.includes("INSERT INTO conversation_state") &&
        sql.includes('{"is_recontact":true,"recontact_prompted":false}')
      ) {
        markedForRecontact = true;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE conversation_state") || sql.includes("INSERT INTO conversation_state")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "resolved" }; },
    async sendMessage() {},
    async setStatus() {},
    async getLabels() { return ["consulta-erronea"]; },
    async addLabels(_id, labelsToAdd) { return labelsToAdd; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "wrong-query-resolved-no-recontact" },
    payload({
      event: "conversation_updated",
      id: 8104,
      content: null,
      conversation: {
        id: 2793,
        inbox_id: 6,
        status: "resolved",
        labels: ["consulta-erronea"],
        meta: {},
      },
    }),
  );

  assert.ok(accepted);
  await processor.process(accepted);
  assert.equal(markedForRecontact, false);
});

test("extractCleanName ignora la vista previa de Meta adjunta al nombre", () => {
  assert.equal(
    extractCleanName("Mónica. !!\n\nChatea con nosotros\nUn pet shop que vende a granel necesita más que intuición.\nhttps://fb.me/50jOfQgTu"),
    "Mónica",
  );
});

test("hola solo después de un cierre comercial se considera cortesía y no nueva consulta", () => {
  assert.equal(isSocialClosingReply("hola"), true);
  assert.equal(isSocialClosingReply("Hola!!"), true);
  assert.equal(isSocialClosingReply("Hola, quería consultar precios"), false);
});

test("una solicitud explícita de humano prioriza pedir nombre sin exigir rubro", async () => {
  const sent: string[] = [];

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_rubro",
            human_handoff: false,
            rubro: null,
            state: { memory: {}, chat_history: [] },
            prospect_followup_attempt: 0,
            user_message_count: 2,
          }],
        };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage(_id, content) { sent.push(content); },
    async setStatus() {},
    async getLabels() { return ["bot-ventas-activo", "web"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "human-without-rubro-2876" },
    payload({ id: 8201, content: "Quisiera hablar con un humano", conversation: { id: 2876, inbox_id: 6, status: "open", meta: {} } }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /asesor comercial/i);
  assert.match(sent[0] ?? "", /indicás tu nombre/i);
  assert.doesNotMatch(sent[0] ?? "", /de qué rubro|a qué se dedica/i);
});

test("una consulta por tablet incluida ofrece asesor con CTA breve sin repetir toda la propuesta", async () => {
  const sent: string[] = [];
  let aiCalled = false;

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "proposal_sent",
            human_handoff: false,
            rubro: "petshop",
            state: { memory: { rubro: "petshop" }, chat_history: [] },
            prospect_followup_attempt: 0,
            user_message_count: 3,
          }],
        };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage(_id, content) { sent.push(content); },
    async setStatus() {},
    async getLabels() { return ["bot-ventas-activo", "meta"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const answerService = {
    async answer() {
      aiCalled = true;
      return { kind: "answer" as const, text: "No debería llegar acá" };
    },
  } as any;

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
    { info() {}, warn() {} },
    answerService,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "tablet-included-2869" },
    payload({ id: 8202, content: "Viene la tablet incluida?", conversation: { id: 2869, inbox_id: 6, status: "open", meta: {} } }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(aiCalled, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /tablet|equipamiento/i);
  assert.match(sent[0] ?? "", /asesor/i);
  assert.match(sent[0] ?? "", /querés que te contacten/i);
  assert.doesNotMatch(sent[0] ?? "", /1️⃣/);
});

test("bloqueado-bot es terminal incluso si llega una nueva consulta comercial", async () => {
  let sent = 0;
  let assigned = 0;
  let prospectSync = 0;
  let followupCancelled = false;

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("prospect_followup_due_at = NULL")) followupCancelled = true;
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "resolved" }; },
    async sendMessage() { sent += 1; },
    async setStatus() {},
    async getLabels() { return ["bloqueado-bot", "consulta-erronea", "web"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() { assigned += 1; },
    async sendPrivateNote() {},
  };

  const prospectosClient = {
    async syncProspect() { prospectSync += 1; return { ok: true }; },
  } as any;

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
    { info() {}, warn() {} },
    undefined,
    undefined,
    prospectosClient,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "blocked-commercial-reentry" },
    payload({ id: 8203, content: "Hola, al final quiero una demo para mi dietética" }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent, 0);
  assert.equal(assigned, 0);
  assert.equal(prospectSync, 0);
  assert.equal(followupCancelled, false);
});

test("una demo pedida desde el primer mensaje recibe información principal antes de pedir nombre", async () => {
  const sent: string[] = [];

  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "new",
            human_handoff: false,
            rubro: null,
            state: { memory: {}, chat_history: [] },
            prospect_followup_attempt: 0,
            user_message_count: 1,
          }],
        };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [{ chatwoot_conversation_id: values?.[0] }] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage(_id, content) { sent.push(content); },
    async setStatus() {},
    async getLabels() { return ["web"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    { webhookToken: TOKEN, accountId: 1, inboxId: 6, replyEnabled: true },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "direct-demo-info-first" },
    payload({
      id: 8204,
      content: "Hola, vengo desde el sitio web. Busco un sistema para mi dietética / negocio saludable. Quiero información o demo.",
      conversation: { id: 2842, inbox_id: 6, status: "open", meta: {} },
    }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(sent.length, 2);
  assert.match(sent[0] ?? "", /diferentes planes/i);
  assert.match(sent[0] ?? "", /https:\/\/youtu\.be\/3PlRpHUcK2U/);
  assert.doesNotMatch(sent[0] ?? "", /1️⃣|2️⃣/);
  assert.match(sent[1] ?? "", /cómo llevás hoy las ventas/i);
  assert.doesNotMatch(sent[1] ?? "", /1️⃣|2️⃣|decir tu nombre/i);
});

test("una derivación fuera de 9 a 17 difiere el aviso al grupo en vez de enviarlo de madrugada", async () => {
  const sentTo: number[] = [];
  let deferredNoticeSaved = false;

  const pool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO webhook_events")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("bot_behavior")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes("INSERT INTO conversation_state")) {
        return {
          rowCount: 1,
          rows: [{
            stage: "awaiting_name",
            human_handoff: false,
            rubro: "petshop",
            state: { memory: { rubro: "petshop", lead_intent: "asesor" }, chat_history: [] },
            prospect_followup_attempt: 0,
            user_message_count: 4,
          }],
        };
      }
      if (sql.includes("FROM bot_settings") && sql.includes("last_assignee_id")) {
        return { rowCount: 1, rows: [{ last_assignee_id: null }] };
      }
      if (sql.includes("INSERT INTO bot_settings") && sql.includes("sales_round_robin")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("sales_group_notice_pending") && sql.includes("to_jsonb($2::text)")) {
        deferredNoticeSaved = true;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE conversation_state")) return { rowCount: 1, rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  } as unknown as Pool;

  const client: ChatwootClient = {
    async getConversation(conversationId) { return { id: conversationId, status: "open" }; },
    async sendMessage(conversationId) { sentTo.push(conversationId); },
    async setStatus() {},
    async getLabels() { return ["bot-ventas-activo", "meta"]; },
    async addLabels(_id, labels) { return labels; },
    async removeLabels() { return []; },
    async assignAgent() {},
    async sendPrivateNote() {},
  };

  const processor = createChatwootWebhookProcessor(
    {
      webhookToken: TOKEN,
      accountId: 1,
      inboxId: 6,
      replyEnabled: true,
      salesGroupConversationId: 9999,
      salesAgents: [{ id: 8, name: "Rafael" }],
      now: () => new Date("2026-10-13T03:13:00.000Z"), // 00:13 en Argentina
    },
    pool,
    client,
  );

  const accepted = processor.accept(
    TOKEN,
    { "x-chatwoot-delivery": "night-handoff-notice" },
    payload({
      id: 8205,
      content: "Mónica",
      conversation: {
        id: 2865,
        inbox_id: 6,
        status: "open",
        meta: { sender: { id: 44, phone_number: "+5491112345678" } },
      },
    }),
  );

  assert.ok(accepted);
  await processor.process(accepted);

  assert.equal(deferredNoticeSaved, true);
  assert.ok(sentTo.includes(2865), "Debe enviar el mensaje de handoff al prospecto");
  assert.ok(!sentTo.includes(9999), "No debe avisar al grupo a las 00:13");
});
