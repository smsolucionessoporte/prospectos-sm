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

function normalizarOrigenProspectos(origen) {
  if (origen === "google-pos-cliente") return "google";
  if (origen === "meta-pos-cliente") return "meta";
  return origen;
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

  let revisadas = 0;
  let correctas = 0;
  let pendientesAuditoria = 0;
  let diferencias = 0;
  let conflictos = 0;
  let sinClasificacion = 0;
  let errores = 0;

  const resultados = [];

  for (const row of rows) {
    const conversationId = Number(row.chatwoot_conversation_id);

    try {
      const labels = await getLabels(conversationId);

      const normalized = labels.map((label) =>
        String(label).toLowerCase(),
      );

      const hasGoogle =
        normalized.includes("google-pos-cliente");

      const hasMeta =
        normalized.includes("meta-pos-cliente");

      const hasInterno =
        normalized.includes("prospecto-interno");

      const hasAuditar =
        normalized.includes("auditar-origen");

      revisadas++;

      const categorias = [
        hasGoogle ? "google" : null,
        hasMeta ? "meta" : null,
        hasInterno ? "interno" : null,
        hasAuditar ? "auditar" : null,
      ].filter(Boolean);

      if (categorias.length === 0) {
        sinClasificacion++;

        resultados.push({
          prospecto: row.id,
          conversacion: conversationId,
          contacto: row.contacto,
          actual: row.origen || "NULL",
          esperado: "SIN CLASIFICACION",
          etiquetas: labels.join(", "),
        });

        continue;
      }

      if (categorias.length > 1) {
        conflictos++;

        resultados.push({
          prospecto: row.id,
          conversacion: conversationId,
          contacto: row.contacto,
          actual: row.origen || "NULL",
          esperado: `CONFLICTO: ${categorias.join(" + ")}`,
          etiquetas: labels.join(", "),
        });

        continue;
      }

      const actual = normalizarOrigenProspectos(row.origen);

      if (hasGoogle) {
        if (actual === "google") {
          correctas++;
        } else {
          diferencias++;

          resultados.push({
            prospecto: row.id,
            conversacion: conversationId,
            contacto: row.contacto,
            actual: row.origen || "NULL",
            esperado: "google",
            etiquetas: labels.join(", "),
          });
        }

        continue;
      }

      if (hasMeta) {
        if (actual === "meta") {
          correctas++;
        } else {
          diferencias++;

          resultados.push({
            prospecto: row.id,
            conversacion: conversationId,
            contacto: row.contacto,
            actual: row.origen || "NULL",
            esperado: "meta",
            etiquetas: labels.join(", "),
          });
        }

        continue;
      }

      if (hasInterno) {
        if (actual === "prospecto-interno") {
          correctas++;
        } else {
          diferencias++;

          resultados.push({
            prospecto: row.id,
            conversacion: conversationId,
            contacto: row.contacto,
            actual: row.origen || "NULL",
            esperado: "prospecto-interno",
            etiquetas: labels.join(", "),
          });
        }

        continue;
      }

      if (hasAuditar) {
        pendientesAuditoria++;

        resultados.push({
          prospecto: row.id,
          conversacion: conversationId,
          contacto: row.contacto,
          actual: row.origen || "NULL",
          esperado: "PENDIENTE AUDITAR ORIGEN",
          etiquetas: labels.join(", "),
        });

        continue;
      }
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
    "\n===== AUDITORÍA COMPLETA CHATWOOT → PROSPECTOS ====="
  );

  console.log(`Conversaciones revisadas: ${revisadas}`);
  console.log(`Correctas: ${correctas}`);
  console.log(
    `Pendientes auditar origen: ${pendientesAuditoria}`
  );
  console.log(`Diferencias reales: ${diferencias}`);
  console.log(`Conflictos de etiquetas: ${conflictos}`);
  console.log(
    `Sin clasificación de origen: ${sinClasificacion}`
  );
  console.log(`Errores: ${errores}`);

  if (resultados.length) {
    console.log("\n===== REVISAR =====\n");
    console.table(resultados);
  } else {
    console.log(
      "\nTodas las conversaciones coinciden correctamente con Prospectos."
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