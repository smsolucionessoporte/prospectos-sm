const axios = require("axios");
const { pool } = require("../src/db");

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;
const INBOX_ID = Number(process.env.CHATWOOT_INBOX_ID_VENTAS);

const FIX = process.argv.includes("--fix");

const headers = {
  api_access_token: CHATWOOT_API_TOKEN,
};

function normalizarOrigenProspecto(origen) {
  if (origen === "google-pos-cliente") return "google";
  if (origen === "meta-pos-cliente") return "meta";
  return origen;
}

function detectarOrigen(labels) {
  const normalized = labels.map((x) =>
    String(x).toLowerCase(),
  );

  const google = normalized.includes("google-pos-cliente");
  const meta = normalized.includes("meta-pos-cliente");
  const interno = normalized.includes("prospecto-interno");
  const auditar = normalized.includes("auditar-origen");

  /*
   * Google/Meta + auditar es un conflicto corregible:
   * ya conocemos el origen, por lo que auditar debe eliminarse.
   */
  if (google && auditar && !meta && !interno) {
    return {
      tipo: "conflicto-auditar",
      origen: "google",
    };
  }

  if (meta && auditar && !google && !interno) {
    return {
      tipo: "conflicto-auditar",
      origen: "meta",
    };
  }

  const origenesDefinitivos = [
    google ? "google" : null,
    meta ? "meta" : null,
    interno ? "prospecto-interno" : null,
  ].filter(Boolean);

  if (origenesDefinitivos.length > 1) {
    return {
      tipo: "conflicto",
      origen: origenesDefinitivos.join(" + "),
    };
  }

  if (google) {
    return { tipo: "definitivo", origen: "google" };
  }

  if (meta) {
    return { tipo: "definitivo", origen: "meta" };
  }

  if (interno) {
    return {
      tipo: "definitivo",
      origen: "prospecto-interno",
    };
  }

  if (auditar) {
    return {
      tipo: "auditar",
      origen: "auditar-origen",
    };
  }

  return {
    tipo: "sin-clasificacion",
    origen: null,
  };
}

async function getConversacionesVentas() {
  const conversaciones = [];

  let page = 1;

  while (true) {
    const response = await axios.get(
      `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
      {
        headers,
        params: {
          inbox_id: INBOX_ID,
          status: "all",
          page,
        },
      },
    );

    const data = response.data;

    const payload = Array.isArray(data?.data?.payload)
      ? data.data.payload
      : Array.isArray(data?.payload)
        ? data.payload
        : [];

    if (!payload.length) {
      break;
    }

    for (const conversation of payload) {
      const inboxId =
        conversation.inbox_id ??
        conversation.inbox?.id ??
        null;

      if (Number(inboxId) === INBOX_ID) {
        conversaciones.push(conversation);
      }
    }

    page++;

    if (page > 100) {
      throw new Error(
        "Se alcanzó el límite de páginas de Chatwoot",
      );
    }
  }

  return conversaciones;
}

async function quitarAuditarOrigen(conversationId) {
  const response = await axios.get(
    `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`,
    { headers },
  );

  const data = response.data;

  let labels = [];

  if (Array.isArray(data)) labels = data;
  else if (Array.isArray(data?.payload)) labels = data.payload;
  else if (Array.isArray(data?.labels)) labels = data.labels;

  const nuevas = labels.filter(
    (label) =>
      String(label).toLowerCase() !== "auditar-origen",
  );

  await axios.post(
    `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`,
    {
      labels: nuevas,
    },
    { headers },
  );
}

async function main() {
  if (
    !CHATWOOT_URL ||
    !CHATWOOT_ACCOUNT_ID ||
    !CHATWOOT_API_TOKEN ||
    !INBOX_ID
  ) {
    throw new Error(
      "Faltan variables de Chatwoot o CHATWOOT_INBOX_ID_VENTAS",
    );
  }

  const conversaciones =
    await getConversacionesVentas();

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
      origen,
      chatwoot_conversation_id
    FROM prospectos
    WHERE chatwoot_conversation_id IS NOT NULL
  `);

  const controlMap = new Map(
    controlResult.rows.map((row) => [
      Number(row.chatwoot_conversation_id),
      row,
    ]),
  );

  const prospectosMap = new Map(
    prospectosResult.rows.map((row) => [
      Number(row.chatwoot_conversation_id),
      row,
    ]),
  );

  let correctas = 0;
  let diferenciasControl = 0;
  let diferenciasProspectos = 0;
  let faltanControl = 0;
  let pendientesAuditar = 0;
  let sinClasificacion = 0;
  let conflictos = 0;
  let corregidas = 0;

  const revisar = [];

  for (const conversation of conversaciones) {
    const id = Number(conversation.id);

    const labels = Array.isArray(conversation.labels)
      ? conversation.labels
      : [];

    const estado = detectarOrigen(labels);

    const control = controlMap.get(id) ?? null;
    const prospecto = prospectosMap.get(id) ?? null;

    /*
     * Google/Meta + auditar:
     * sabemos el origen; auditar es sobrante.
     */
    if (estado.tipo === "conflicto-auditar") {
      conflictos++;

      if (FIX) {
        await quitarAuditarOrigen(id);
        corregidas++;
      } else {
        revisar.push({
          conversacion: id,
          problema: "QUITAR AUDITAR-ORIGEN",
          chatwoot: estado.origen,
          control: control?.origen ?? "NO EXISTE",
          prospectos:
            prospecto?.origen ?? "NO EXISTE",
          etiquetas: labels.join(", "),
        });
      }

      /*
       * Seguimos comprobando las bases usando el
       * origen definitivo que ya conocemos.
       */
    } else if (estado.tipo === "conflicto") {
      conflictos++;

      revisar.push({
        conversacion: id,
        problema: "CONFLICTO DE ORIGEN",
        chatwoot: estado.origen,
        control: control?.origen ?? "NO EXISTE",
        prospectos:
          prospecto?.origen ?? "NO EXISTE",
        etiquetas: labels.join(", "),
      });

      continue;
    }

    if (estado.tipo === "auditar") {
      pendientesAuditar++;

      revisar.push({
        conversacion: id,
        problema: "PENDIENTE AUDITAR",
        chatwoot: "auditar-origen",
        control: control?.origen ?? "NO EXISTE",
        prospectos:
          prospecto?.origen ?? "NO EXISTE",
        etiquetas: labels.join(", "),
      });

      continue;
    }

    if (estado.tipo === "sin-clasificacion") {
      sinClasificacion++;

      revisar.push({
        conversacion: id,
        problema: "SIN CLASIFICACION",
        chatwoot: "SIN ETIQUETA",
        control: control?.origen ?? "NO EXISTE",
        prospectos:
          prospecto?.origen ?? "NO EXISTE",
        etiquetas: labels.join(", "),
      });

      continue;
    }

    const origenChatwoot = estado.origen;

    let error = false;

    /*
     * CONTROL / ESTADÍSTICAS
     *
     * Google y Meta deben coincidir sí o sí.
     */
    if (
      origenChatwoot === "google" ||
      origenChatwoot === "meta"
    ) {
      if (!control) {
        faltanControl++;
        error = true;

        revisar.push({
          conversacion: id,
          problema: "FALTA EN CONTROL",
          chatwoot: origenChatwoot,
          control: "NO EXISTE",
          prospectos:
            prospecto?.origen ?? "NO EXISTE",
          etiquetas: labels.join(", "),
        });
      } else if (control.origen !== origenChatwoot) {
        diferenciasControl++;
        error = true;

        if (FIX) {
          await pool.query(
            `
            UPDATE control_ventas
            SET origen = $2,
                actualizado_en = NOW()
            WHERE chatwoot_conversation_id = $1
            `,
            [id, origenChatwoot],
          );

          corregidas++;
        } else {
          revisar.push({
            conversacion: id,
            problema: "CONTROL / ESTADISTICAS",
            chatwoot: origenChatwoot,
            control: control.origen ?? "NULL",
            prospectos:
              prospecto?.origen ?? "NO EXISTE",
            etiquetas: labels.join(", "),
          });
        }
      }
    }

    /*
     * PROSPECTOS / PANEL
     *
     * Solo lo comprobamos si el prospecto existe.
     * No creamos prospectos desde el auditor.
     */
    if (prospecto) {
      const origenActual =
        normalizarOrigenProspecto(prospecto.origen);

      if (origenActual !== origenChatwoot) {
        diferenciasProspectos++;
        error = true;

        if (FIX) {
          const nuevoOrigen =
            origenChatwoot === "google"
              ? "google"
              : origenChatwoot === "meta"
                ? "meta"
                : "prospecto-interno";

          await pool.query(
            `
            UPDATE prospectos
            SET origen = $2,
                actualizado_en = NOW()
            WHERE chatwoot_conversation_id = $1
            `,
            [id, nuevoOrigen],
          );

          corregidas++;
        } else {
          revisar.push({
            conversacion: id,
            problema: "PROSPECTOS / PANEL",
            chatwoot: origenChatwoot,
            control: control?.origen ?? "NO EXISTE",
            prospectos:
              prospecto.origen ?? "NULL",
            etiquetas: labels.join(", "),
          });
        }
      }
    }

    if (!error) {
      correctas++;
    }
  }

  console.log(
    "\n===== AUDITORÍA TOTAL WHATSAPP-VENTAS =====",
  );

  console.log(
    `Conversaciones Chatwoot inbox ${INBOX_ID}: ${conversaciones.length}`,
  );

  console.log(`Correctas: ${correctas}`);

  console.log(
    `Diferencias Control/Estadísticas: ${diferenciasControl}`,
  );

  console.log(
    `Diferencias Prospectos/Panel: ${diferenciasProspectos}`,
  );

  console.log(`Faltan en Control: ${faltanControl}`);

  console.log(
    `Pendientes auditar origen: ${pendientesAuditar}`,
  );

  console.log(
    `Sin clasificación de origen: ${sinClasificacion}`,
  );

  console.log(
    `Conflictos de etiquetas: ${conflictos}`,
  );

  if (FIX) {
    console.log(`Correcciones realizadas: ${corregidas}`);
  }

  if (revisar.length) {
    console.log("\n===== REVISAR =====\n");
    console.table(revisar);
  } else {
    console.log(
      "\nNo quedaron inconsistencias para revisar.",
    );
  }
}

main()
  .catch((err) => {
    console.error(
      err.response?.data || err,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });