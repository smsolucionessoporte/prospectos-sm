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

  let revisados = 0;
  let correctos = 0;
  let diferencias = 0;
  let sinEtiquetaOrigen = 0;
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

      revisados++;

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

      let expectedOrigin = null;

      if (hasGoogle) {
        expectedOrigin = "google-pos-cliente";
      }

      if (hasMeta) {
        expectedOrigin = "meta-pos-cliente";
      }

      if (!expectedOrigin) {
        sinEtiquetaOrigen++;

        resultados.push({
          prospecto: row.id,
          conversacion: conversationId,
          contacto: row.contacto,
          actual: row.origen || "NULL",
          esperado: "SIN ETIQUETA META/GOOGLE",
          etiquetas: labels.join(", "),
        });

        continue;
      }

      if (row.origen === expectedOrigin) {
        correctos++;
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

  console.log(`Prospectos revisados: ${revisados}`);
  console.log(`Correctos: ${correctos}`);
  console.log(`Diferencias: ${diferencias}`);
  console.log(
    `Sin etiqueta Meta/Google: ${sinEtiquetaOrigen}`
  );
  console.log(`Conflictos: ${conflictos}`);
  console.log(`Errores: ${errores}`);

  if (resultados.length) {
    console.log("\n===== REVISAR =====\n");

    console.table(resultados);
  } else {
    console.log(
      "\nTodos los Prospectos coinciden con Chatwoot."
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