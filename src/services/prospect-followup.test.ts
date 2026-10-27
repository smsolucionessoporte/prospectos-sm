import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { ChatwootClient } from "../chatwoot/client.js";
import { ProspectFollowupService } from "./prospect-followup.js";
import type { ProspectosClient } from "../prospectos/client.js";


const waitForService = async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
};

test("envía el primer recordatorio y programa el siguiente dentro de 24 horas", async () => {
  const sentMessages: Array<{ conversationId: number; content: string }> = [];
  let nextFollowupScheduled = false;

  const pool = {
    async query(sql: string) {
      // Buscar seguimientos vencidos
      if (
        sql.includes("FROM conversation_state") &&
        sql.includes("prospect_followup_due_at <= NOW()")
      ) {
        return {
          rowCount: 1,
          rows: [
            {
              chatwoot_conversation_id: "1001",
              prospect_followup_attempt: 0,
              human_handoff: false
            }
          ]
        };
      }

      // Reservar intento
      if (
        sql.includes("prospect_followup_attempt = prospect_followup_attempt + 1")
      ) {
        return {
          rowCount: 1,
          rows: [{ prospect_followup_attempt: 1 }]
        };
      }

      // Programar próximo seguimiento
      if (
        sql.includes("NOW() + INTERVAL '24 hours'")
      ) {
        nextFollowupScheduled = true;

        return {
          rowCount: 1,
          rows: []
        };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const chatwoot: ChatwootClient = {
      async getConversation(conversationId) {
    return {
      id: conversationId,
      status: "open"
    };
  },

    async sendMessage(conversationId, content) {
      sentMessages.push({ conversationId, content });
    },

    async setStatus() {},

    async getLabels() {
      return [];
    },

    async removeLabels(conversationId, labels) {
  return [];
},

    async addLabels(_conversationId, labels) {
      return labels;
    },
    async assignAgent() {},
    async sendPrivateNote() {},
  };


  const logger = {
    info() {},
    warn() {}
  };

  const service = new ProspectFollowupService(
    pool,
    chatwoot,
    logger
  );

  service.start();
  await waitForService();
  service.stop();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.conversationId, 1001);

  assert.match(
    sentMessages[0]!.content,
    /demostración/
  );
  assert.match(
    sentMessages[0]!.content,
    /hablar con un asesor/
  );
  assert.match(
    sentMessages[0]!.content,
    /contanos cómo preferís continuar/
  );

  assert.equal(
    nextFollowupScheduled,
    true,
    "Debe programar el próximo seguimiento a 24 horas"
  );
});


test("envía correctamente el tercer recordatorio y deja programada la evaluación final", async () => {
  const sentMessages: string[] = [];
  let nextFollowupScheduled = false;

  const pool = {
    async query(sql: string) {
      if (
        sql.includes("FROM conversation_state") &&
        sql.includes("prospect_followup_due_at <= NOW()")
      ) {
        return {
          rowCount: 1,
          rows: [
            {
              chatwoot_conversation_id: "1002",
              prospect_followup_attempt: 2,
              human_handoff: false
            }
          ]
        };
      }

      if (
        sql.includes("prospect_followup_attempt = prospect_followup_attempt + 1")
      ) {
        return {
          rowCount: 1,
          rows: [{ prospect_followup_attempt: 3 }]
        };
      }

      if (
        sql.includes("NOW() + INTERVAL '24 hours'")
      ) {
        nextFollowupScheduled = true;

        return {
          rowCount: 1,
          rows: []
        };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const chatwoot: ChatwootClient = {

        async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

    async sendMessage(_conversationId, content) {
      sentMessages.push(content);
    },

    async setStatus() {},

    async getLabels() {
      return [];
    },

    async addLabels(_conversationId, labels) {
      return labels;
    },
async removeLabels(conversationId, labels) {
  return [];
},

    async assignAgent() {},
      async sendPrivateNote() {},
  };

  const logger = {
    info() {},
    warn() {}
  };

  const service = new ProspectFollowupService(
    pool,
    chatwoot,
    logger
  );

    service.start();
    await waitForService();
    service.stop();

    assert.equal(sentMessages.length, 1);
    assert.match(
      sentMessages[0]!,
      /todavía te gustaría conocer el sistema/
    );
    assert.match(
      sentMessages[0]!,
      /hablar con nuestro equipo comercial/
    );
    assert.match(
      sentMessages[0]!,
      /Si no estás interesado por ahora/
    );

    assert.equal(
      nextFollowupScheduled,
      true,
      "Después del intento 3 debe esperar otras 24 horas antes de marcar sin respuesta"
    );
});


test("después de tres intentos agrega la etiqueta sin respuesta y finaliza el seguimiento", async () => {
  let labelConversationId: number | null = null;
  let labelsAdded: string[] = [];
  let followupCompleted = false;
  let messageSent = false;

  const pool = {
    async query(sql: string) {
      if (
        sql.includes("FROM conversation_state") &&
        sql.includes("prospect_followup_due_at <= NOW()")
      ) {
        return {
          rowCount: 1,
          rows: [
            {
              chatwoot_conversation_id: "1003",
              prospect_followup_attempt: 3,
              human_handoff: false
            }
          ]
        };
      }

      if (
        sql.includes("prospect_followup_completed = TRUE") &&
        sql.includes("prospect_followup_attempt >= 3")
      ) {
        followupCompleted = true;

        return {
          rowCount: 1,
          rows: [{ chatwoot_conversation_id: 1003 }]
        };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const chatwoot: ChatwootClient = {

        async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

    async sendMessage() {
      messageSent = true;
    },

    async setStatus() {},

    async getLabels() {
      return [];
    },

    async addLabels(conversationId, labels) {
      labelConversationId = conversationId;
      labelsAdded = labels;
      return labels;
    },
    async removeLabels(conversationId, labels) {
  return [];
},

    async assignAgent() {},
      async sendPrivateNote() {},
  };

  const logger = {
    info() {},
    warn() {}
  };

  const service = new ProspectFollowupService(
    pool,
    chatwoot,
    logger
  );

  service.start();
  await waitForService();
  service.stop();

  assert.equal(followupCompleted, true);

  assert.equal(
    messageSent,
    false,
    "Después de los tres recordatorios no debe enviar un cuarto mensaje"
  );

  assert.equal(labelConversationId, 1003);

  assert.deepEqual(
    labelsAdded,
    ["sin respuesta"]
  );
});


test("si falla el envío del recordatorio revierte el intento y programa reintento", async () => {
  let retryScheduled = false;
  let revertedAttempt: unknown = null;

  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (
        sql.includes("FROM conversation_state") &&
        sql.includes("prospect_followup_due_at <= NOW()")
      ) {
        return {
          rowCount: 1,
          rows: [
            {
              chatwoot_conversation_id: "1004",
              prospect_followup_attempt: 1,
              human_handoff: false
            }
          ]
        };
      }

      if (
        sql.includes("prospect_followup_attempt = prospect_followup_attempt + 1")
      ) {
        return {
          rowCount: 1,
          rows: [{ prospect_followup_attempt: 2 }]
        };
      }

      if (
        sql.includes("INTERVAL '5 minutes'") &&
        sql.includes("prospect_followup_attempt = $2")
      ) {
        retryScheduled = true;
        revertedAttempt = values?.[1];

        return {
          rowCount: 1,
          rows: []
        };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const chatwoot: ChatwootClient = {

        async getConversation(conversationId) {
      return {
        id: conversationId,
        status: "open"
      };
    },

    async sendMessage() {
      throw new Error("Chatwoot temporalmente no disponible");
    },

    async setStatus() {},

    async getLabels() {
      return [];
    },

    async addLabels(_conversationId, labels) {
      return labels;
    },
    async removeLabels(conversationId, labels) {
  return [];
},

    async assignAgent() {},
      async sendPrivateNote() {},
  };

  const logger = {
    info() {},
    warn() {}
  };

  const service = new ProspectFollowupService(
    pool,
    chatwoot,
    logger
  );

  service.start();
  await waitForService();
  service.stop();

  assert.equal(
    retryScheduled,
    true,
    "Debe programar un reintento si falla Chatwoot"
  );

  assert.equal(
    revertedAttempt,
    1,
    "Debe volver al número de intento anterior"
  );
});


test("si falla agregar la etiqueta sin respuesta deja el seguimiento pendiente para reintentar", async () => {
  let releasedForRetry = false;

  const pool = {
    async query(sql: string) {
      if (
        sql.includes("FROM conversation_state") &&
        sql.includes("prospect_followup_due_at <= NOW()")
      ) {
        return {
          rowCount: 1,
          rows: [
            {
              chatwoot_conversation_id: "1005",
              prospect_followup_attempt: 3,
              human_handoff: false
            }
          ]
        };
      }

      if (
        sql.includes("prospect_followup_completed = TRUE") &&
        sql.includes("prospect_followup_attempt >= 3")
      ) {
        return {
          rowCount: 1,
          rows: [{ chatwoot_conversation_id: 1005 }]
        };
      }

      if (
        sql.includes("prospect_followup_completed = FALSE") &&
        sql.includes("INTERVAL '5 minutes'")
      ) {
        releasedForRetry = true;

        return {
          rowCount: 1,
          rows: []
        };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    }
  } as unknown as Pool;

  const chatwoot: ChatwootClient = {
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

    async addLabels() {
      throw new Error("No se pudo actualizar Chatwoot");
    },
    async removeLabels(conversationId, labels) {
  return [];
},

    async assignAgent() {},
      async sendPrivateNote() {},
  };

  const logger = {
    info() {},
    warn() {}
  };

  const service = new ProspectFollowupService(
    pool,
    chatwoot,
    logger
  );

  service.start();
  await waitForService();
  service.stop();

  assert.equal(
    releasedForRetry,
    true,
    "Debe volver a dejar pendiente el cierre si falla la etiqueta"
  );
});