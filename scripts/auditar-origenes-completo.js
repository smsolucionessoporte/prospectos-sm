const axios = require("axios");
const { pool } = require("../src/db");

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

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

function normalizarOrigenProspecto(origen) {
  if (origen === "google-pos-cliente") return "google";
  if (origen === "meta-pos-cliente") return "meta";
  return origen;
}

function detectarOrigenEtiquetas(labels) {
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

  const categorias = [
    hasGoogle ? "google" : null,
    hasMeta ? "meta" : null,
    hasInterno ? "prospecto-interno" : null,
    hasAuditar ? "auditar-origen" : null,
  ].filter(Boolean);

  if (categorias.length > 1) {
    return {
      tipo: "conflicto",
      valor: categorias.join(" + "),
    };
  }

  if (hasGoogle) {
    return { tipo: "origen", valor: "google" };
  }

  if (hasMeta) {
    return { tipo: "origen", valor: "meta" };
  }

  if (hasInterno) {
    return {
      tipo: "origen",
      valor: "prospecto-interno",
    };
  }

  if (hasAuditar) {
    return {
      tipo: "auditar",
      valor: "auditar-origen",
    };
  }

  return {
    tipo: "sin-clasificacion",
    valor: null,
  };
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

  const controlResult = await pool.query(`
    SELECT
      chatwoot_conversation_id,
      origen,
      clasificacion
    FROM control_ventas
    WHERE chatwoot_conversation_id IS NOT NULL
  `);

  const prospectosResult = await pool.query(`
    SELECT
      id,
      contacto,
      telefono,
      origen,
      chatwoot_conversation_id
    FROM prospectos
    WHERE chatwoot_conversation_id IS NOT NULL
  `);

  const controlMap = new Map();

  for (const row of controlResult.rows) {
    controlMap.set(
      Number(row.chatwoot_conversation_id),
      row,
    );
  }

  const prospectosMap = new Map();

  for (const row of prospectosResult.rows) {
    prospectosMap.set(
      Number(row.chatwoot_conversation_id),
      row,
    );
  }

  const conversationIds = new Set([
    ...controlMap.keys(),
    ...prospectosMap.keys(),
  ]);

  let revisadas = 0;
  let correctas = 0;
  let diferenciasControl = 0;
  let diferenciasProspectos = 0;
  let pendientesAuditar = 0;
  let sinClasificacion = 0;
  let conflictos = 0;
  let errores = 0;

  const resultados = [];

  for (const conversationId of conversationIds) {
    try {
const conversation = await getConversation(conversationId);

const inboxId =
  conversation?.inbox_id ??
  conversation?.inbox?.id ??
  null;

// whatsapp-ventas
if (Number(inboxId) !== Number(process.env.CHATWOOT_INBOX_ID_VENTAS)) {
  continue;
}

const labels = Array.isArray(conversation.labels)
  ? conversation.labels
  : [];
      const deteccion =
        detectarOrigenEtiquetas(labels);

      const control =
        controlMap.get(conversationId) ?? null;

      const prospecto =
        prospectosMap.get(conversationId) ?? null;

      revisadas++;

      if (deteccion.tipo === "conflicto") {
        conflictos++;

        resultados.push({
          conversacion: conversationId,
          problema: "CONFLICTO ETIQUETAS",
          chatwoot: deteccion.valor,
          control: control?.origen ?? "NO EXISTE",
          prospectos:
            prospecto?.origen ?? "NO EXISTE",
          etiquetas: labels.join(", "),
        });

        continue;
      }

      if (deteccion.tipo === "auditar") {
        pendientesAuditar++;

        resultados.push({
          conversacion: conversationId,
          problema: "PENDIENTE AUDITAR",
          chatwoot: "auditar-origen",
          control: control?.origen ?? "NO EXISTE",
          prospectos:
            prospecto?.origen ?? "NO EXISTE",
          etiquetas: labels.join(", "),
        });

        continue;
      }

      if (
        deteccion.tipo === "sin-clasificacion"
      ) {
        sinClasificacion++;

        resultados.push({
          conversacion: conversationId,
          problema: "SIN CLASIFICACION",
          chatwoot: "SIN ETIQUETA",
          control: control?.origen ?? "NO EXISTE",
          prospectos:
            prospecto?.origen ?? "NO EXISTE",
          etiquetas: labels.join(", "),
        });

        continue;
      }

      const origenChatwoot = deteccion.valor;

      let tieneError = false;

      // ─── CONTROL / ESTADÍSTICAS ───────────────────────
      if (control) {
        if (
          origenChatwoot === "google" ||
          origenChatwoot === "meta"
        ) {
          if (control.origen !== origenChatwoot) {
            diferenciasControl++;
            tieneError = true;

            resultados.push({
              conversacion: conversationId,
              problema: "CONTROL",
              chatwoot: origenChatwoot,
              control: control.origen ?? "NULL",
              prospectos:
                prospecto?.origen ?? "NO EXISTE",
              etiquetas: labels.join(", "),
            });
          }
        }

        if (
          origenChatwoot === "prospecto-interno"
        ) {
          // Internos no necesitan tener origen Google/Meta en Control.
          // No se marca error por ausencia o por no existir.
        }
      }

      // ─── PROSPECTOS / PANEL ────────────────────────────
      if (prospecto) {
        const origenProspecto =
          normalizarOrigenProspecto(
            prospecto.origen,
          );

        if (
          origenChatwoot === "google" ||
          origenChatwoot === "meta"
        ) {
          if (
            origenProspecto !== origenChatwoot
          ) {
            diferenciasProspectos++;
            tieneError = true;

            resultados.push({
              conversacion: conversationId,
              problema: "PROSPECTOS",
              chatwoot: origenChatwoot,
              control:
                control?.origen ?? "NO EXISTE",
              prospectos:
                prospecto.origen ?? "NULL",
              etiquetas: labels.join(", "),
            });
          }
        }

        if (
          origenChatwoot ===
            "prospecto-interno" &&
          origenProspecto !==
            "prospecto-interno"
        ) {
          diferenciasProspectos++;
          tieneError = true;

          resultados.push({
            conversacion: conversationId,
            problema: "PROSPECTOS INTERNO",
            chatwoot: "prospecto-interno",
            control:
              control?.origen ?? "NO EXISTE",
            prospectos:
              prospecto.origen ?? "NULL",
            etiquetas: labels.join(", "),
          });
        }
      }

      if (!tieneError) {
        correctas++;
      }
    } catch (err) {
      errores++;

      resultados.push({
        conversacion: conversationId,
        problema: "ERROR",
        chatwoot: "",
        control:
          controlMap.get(conversationId)
            ?.origen ?? "NO EXISTE",
        prospectos:
          prospectosMap.get(conversationId)
            ?.origen ?? "NO EXISTE",
        etiquetas:
          err.response?.status
            ? `HTTP ${err.response.status}`
            : err.message,
      });
    }
  }

  console.log(
    "\n===== AUDITORÍA INTEGRAL DE ORÍGENES ====="
  );

  console.log(
    `Conversaciones revisadas: ${revisadas}`
  );

  console.log(`Correctas: ${correctas}`);

  console.log(
    `Diferencias Control/Estadísticas: ${diferenciasControl}`
  );

  console.log(
    `Diferencias Prospectos/Panel: ${diferenciasProspectos}`
  );

  console.log(
    `Pendientes auditar origen: ${pendientesAuditar}`
  );

  console.log(
    `Sin clasificación de origen: ${sinClasificacion}`
  );

  console.log(
    `Conflictos de etiquetas: ${conflictos}`
  );

  console.log(`Errores: ${errores}`);

  if (resultados.length) {
    console.log("\n===== REVISAR =====\n");
    console.table(resultados);
  } else {
    console.log(
      "\nTodo coincide correctamente entre Chatwoot, Control y Prospectos."
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