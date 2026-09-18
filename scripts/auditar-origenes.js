const axios = require("axios");
const { pool } = require("../src/db");

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

const INTERNAL_PHONES = new Set([
  "5491126181063", // Andrés
  "5491155644899", // Rafael
  "5491132746298", // Giuliano
  "5491168443757", // Santiago
  "5491124785622", // Daniel
]);

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function detectByText(content) {
  const text = normalizeText(content);

  if (
    text.includes("instagram") ||
    text.includes("facebook") ||
    text.includes("chatea con nosotros") ||
    text.includes("vi su publicidad") ||
    text.includes("vi el anuncio") ||
    text.includes("vengo desde meta")
  ) {
    return "meta";
  }

  if (
    text.includes("sitio web") ||
    text.includes("pagina web") ||
    /\bweb\b/.test(text) ||
    text.includes("sitio")
  ) {
    return "google";
  }

  return "otro";
}

async function getLabels(conversationId) {
  const response = await axios.get(
    `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`,
    {
      headers: {
        api_access_token: CHATWOOT_API_TOKEN,
      },
    },
  );

  const data = response.data;

  if (Array.isArray(data)) return data;
  if (Array.isArray(data.payload)) return data.payload;
  if (Array.isArray(data.labels)) return data.labels;

  return [];
}

async function getConversation(conversationId) {
  const response = await axios.get(
    `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`,
    {
      headers: {
        api_access_token: CHATWOOT_API_TOKEN,
      },
    },
  );

  return response.data;
}

async function getMessages(conversationId) {
  const response = await axios.get(
    `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    {
      headers: {
        api_access_token: CHATWOOT_API_TOKEN,
      },
    },
  );

  const data = response.data;

  if (Array.isArray(data)) return data;
  if (Array.isArray(data.payload)) return data.payload;

  return [];
}

function detectOrigin(labels, firstMessage) {
  const normalizedLabels = labels.map((l) =>
    String(l).toLowerCase(),
  );

  const hasMeta =
    normalizedLabels.includes("meta-pos-cliente");

  const hasGoogle =
    normalizedLabels.includes("google-pos-cliente");

  if (hasMeta && hasGoogle) {
    return "conflicto";
  }

  if (hasMeta) return "meta";
  if (hasGoogle) return "google";

  return detectByText(firstMessage);
}

async function main() {
  if (
    !CHATWOOT_URL ||
    !CHATWOOT_ACCOUNT_ID ||
    !CHATWOOT_API_TOKEN
  ) {
    throw new Error(
      "Faltan CHATWOOT_URL, CHATWOOT_ACCOUNT_ID o CHATWOOT_API_TOKEN",
    );
  }

    const { rows } = await pool.query(`
    SELECT
        id,
        chatwoot_conversation_id,
        origen,
        fecha_ingreso,
        clasificacion
    FROM control_ventas
    WHERE origen = 'otro'
        OR origen IS NULL
    ORDER BY fecha_ingreso ASC
    `);

  let revisadas = 0;
  let correctas = 0;
  let diferencias = 0;
  let internas = 0;
  let conflictos = 0;
  let errores = 0;

  const resultados = [];

  for (const row of rows) {
    const conversationId =
      Number(row.chatwoot_conversation_id);

    try {
      const [conversation, labels, messages] =
        await Promise.all([
          getConversation(conversationId),
          getLabels(conversationId),
          getMessages(conversationId),
        ]);

      const phone =
        conversation?.meta?.sender?.phone_number || null;

      const normalizedPhone = normalizePhone(phone);

      if (INTERNAL_PHONES.has(normalizedPhone)) {
        internas++;

        resultados.push({
          conversationId,
          actual: row.origen,
          detectado: "INTERNO",
          telefono: phone,
          labels: labels.join(", "),
          mensaje: "",
        });

        continue;
      }

      const incoming = messages
        .filter((m) => {
          const type = String(
            m.message_type ?? "",
          ).toLowerCase();

          return (
            type === "incoming" ||
            type === "0"
          );
        })
        .sort(
          (a, b) =>
            Number(a.created_at || 0) -
            Number(b.created_at || 0),
        );

      const firstMessage =
        incoming[0]?.content || "";

      const detected =
        detectOrigin(labels, firstMessage);

      revisadas++;

      if (detected === "conflicto") {
        conflictos++;

        resultados.push({
          conversationId,
          actual: row.origen,
          detectado: "CONFLICTO META/GOOGLE",
          telefono: phone,
          labels: labels.join(", "),
          mensaje: firstMessage,
        });

        continue;
      }

      if (row.origen === detected) {
        correctas++;
        continue;
      }

      diferencias++;

      resultados.push({
        conversationId,
        actual: row.origen || "NULL",
        detectado: detected,
        telefono: phone,
        labels: labels.join(", "),
        mensaje: firstMessage,
      });
    } catch (err) {
      errores++;

      resultados.push({
        conversationId,
        actual: row.origen,
        detectado: "ERROR",
        telefono: "",
        labels: "",
        mensaje:
          err.response?.status
            ? `HTTP ${err.response.status}`
            : err.message,
      });
    }
  }

  console.log("\n===== AUDITORÍA DE ORÍGENES =====");
  console.log(`Total en Control: ${rows.length}`);
  console.log(`Revisadas: ${revisadas}`);
  console.log(`Correctas: ${correctas}`);
  console.log(`Diferencias: ${diferencias}`);
  console.log(`Internas: ${internas}`);
  console.log(`Conflictos: ${conflictos}`);
  console.log(`Errores: ${errores}`);

  if (resultados.length) {
    console.log("\n===== REVISAR =====\n");

    console.table(
      resultados.map((r) => ({
        conversacion: r.conversationId,
        actual: r.actual,
        detectado: r.detectado,
        telefono: r.telefono,
        etiquetas: r.labels,
        mensaje:
          String(r.mensaje || "").slice(0, 100),
      })),
    );
  } else {
    console.log(
      "\nNo se encontraron registros para corregir.",
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });