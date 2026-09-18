const axios = require("axios");
const { pool } = require("../src/db");

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

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
      contacto,
      telefono,
      origen,
      chatwoot_conversation_id
    FROM prospectos
    WHERE chatwoot_conversation_id IS NOT NULL
    ORDER BY id ASC
  `);

  let etiquetadas = 0;
  let correctas = 0;
  let diferencias = 0;
  let conflictos = 0;
  let errores = 0;

  const resultados = [];

  for (const row of rows) {
    const conversationId = Number(
      row.chatwoot_conversation_id
    );

    try {
      const labels = await getLabels(conversationId);

      const normalized = labels.map((label) =>
        String(label).toLowerCase(),
      );

      const hasGoogle =
        normalized.includes("google-pos-cliente");

      const hasMeta =
        normalized.includes("meta-pos-cliente");

      // Esta auditoría solo revisa conversaciones
      // que tengan una etiqueta de origen en Chatwoot.
      if (!hasGoogle && !hasMeta) {
        continue;
      }

      etiquetadas++;

      // No debería tener ambas etiquetas.
      if (hasGoogle && hasMeta) {
        conflictos++;

        resultados.push({
          prospecto: row.id,
          conversacion: conversationId,
          contacto: row.contacto,
          actual: row.origen || "NULL",
          esperado: "CONFLICTO",
          etiquetas: labels.join(", "),
        });

        continue;
      }

      const expectedOrigin =
        hasGoogle ? "google" : "meta";

      // Soportamos también históricos que hayan guardado
      // el nombre técnico de la etiqueta como origen.
      const actualOrigin =
        row.origen === "google-pos-cliente"
          ? "google"
          : row.origen === "meta-pos-cliente"
            ? "meta"
            : row.origen;

      if (actualOrigin === expectedOrigin) {
        correctas++;
        continue;
      }

      diferencias++;

      resultados.push({
        prospecto: row.id,
        conversacion: conversationId,
        contacto: row.contacto,
        actual: row.origen || "NULL",
        esperado: expectedOrigin,
        etiquetas: labels.join(", "),
      });
    } catch (err) {
      errores++;

      resultados.push({
        prospecto: row.id,
        conversacion: conversationId,
        contacto: row.contacto,
        actual: row.origen || "NULL",
        esperado: "ERROR",
        etiquetas:
          err.response?.status
            ? `HTTP ${err.response.status}`
            : err.message,
      });
    }
  }

  console.log(
    "\n===== AUDITORÍA CHATWOOT → PROSPECTOS ====="
  );

  console.log(
    `Conversaciones etiquetadas revisadas: ${etiquetadas}`
  );
  console.log(`Correctas: ${correctas}`);
  console.log(`Diferencias reales: ${diferencias}`);
  console.log(`Conflictos: ${conflictos}`);
  console.log(`Errores: ${errores}`);

  if (resultados.length) {
    console.log("\n===== REVISAR =====\n");
    console.table(resultados);
  } else {
    console.log(
      "\nTodas las conversaciones etiquetadas coinciden con Prospectos."
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