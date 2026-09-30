const axios = require("axios");
const { pool } = require("../src/db");

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

const FIX = process.argv.includes("--fix");
const daysArg = process.argv.find((arg) => arg.startsWith("--days="));
const DAYS = Math.max(1, Number(daysArg?.split("=")[1] || 60) || 60);

const api = axios.create({
  baseURL: `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}`,
  headers: { api_access_token: CHATWOOT_API_TOKEN },
  timeout: 30000,
});

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectMetadata(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectMetadata(item, depth + 1));
  }

  if (typeof value !== "object") return [];

  const result = [];
  const relevantKey = /(source|referr|referer|utm|campaign|medium|gclid|gbraid|wbraid|fbclid|landing|page_url|browser_url|channel|provider|origin)/i;

  for (const [key, raw] of Object.entries(value)) {
    if (
      relevantKey.test(key) &&
      (typeof raw === "string" ||
        typeof raw === "number" ||
        typeof raw === "boolean")
    ) {
      result.push(`${key}=${String(raw)}`);
    }

    if (raw && typeof raw === "object") {
      result.push(...collectMetadata(raw, depth + 1));
    }
  }

  return result;
}

function detectFromEvidence(conversation, messages) {
  const labels = Array.isArray(conversation?.labels)
    ? conversation.labels.map((label) => String(label).toLowerCase())
    : [];

  if (labels.includes("prospecto-interno")) {
    return { skip: true, reason: "prospecto-interno" };
  }

  const identifier = String(
    conversation?.meta?.sender?.identifier ||
      conversation?.meta?.sender?.phone_number ||
      "",
  ).toLowerCase();

  if (identifier.includes("@g.us")) {
    return { skip: true, reason: "grupo-whatsapp" };
  }

  const incoming = messages
    .filter((m) => {
      if (m?.private) return false;
      const type = String(m?.message_type ?? "").toLowerCase();
      return type === "incoming" || type === "0";
    })
    .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));

  const first = incoming[0] || null;
  const firstText = String(first?.content || "");

  const metadataSignals = collectMetadata({
    source: conversation?.source,
    source_id: conversation?.source_id,
    additional_attributes: conversation?.additional_attributes,
    custom_attributes: conversation?.custom_attributes,
    meta: conversation?.meta,
    inbox: conversation?.inbox,
    first_content_attributes: first?.content_attributes,
    first_additional_attributes: first?.additional_attributes,
    first_sender: first?.sender,
  });

  const metadata = normalizeText(metadataSignals.join(" "));
  const text = normalizeText(firstText);

  const isOrganic = /\b(organic|organico|organica|seo)\b/.test(metadata);
  const isDirect = /\b(direct|directo|directa|none)\b/.test(metadata);
  const hasMeta = /\b(meta|facebook|instagram|fbclid|fb ads|facebook ads|instagram ads)\b/.test(metadata);
  const hasGoogle = /\b(google|adwords|google ads|gclid|gbraid|wbraid)\b/.test(metadata);
  const hasPaidMedium = /\b(cpc|ppc|paid|paidsearch|paid search|ads|ad)\b/.test(metadata);
  const hasWeb = /\b(web|website|browser|landing|referrer|referer|page url|page_url)\b/.test(metadata);

  if (hasMeta) {
    return { origin: "meta", detail: "meta_metadata", source: "metadata", firstText, labels };
  }

  if (
    hasGoogle &&
    !isOrganic &&
    !isDirect &&
    (hasPaidMedium || /\b(gclid|gbraid|wbraid|adwords|google ads)\b/.test(metadata))
  ) {
    return { origin: "google", detail: "google_ads_metadata", source: "metadata", firstText, labels };
  }

  if (isOrganic) {
    return { origin: "web", detail: "web_organic", source: "metadata", firstText, labels };
  }

  if (isDirect) {
    return { origin: "web", detail: "web_direct", source: "metadata", firstText, labels };
  }

  if (hasWeb || hasGoogle) {
    return { origin: "web", detail: "web_metadata", source: "metadata", firstText, labels };
  }

  if (
    text.includes("instagram") ||
    text.includes("facebook") ||
    text.includes("chatea con nosotros") ||
    text.includes("vi su publicidad") ||
    text.includes("vi el anuncio") ||
    text.includes("vengo desde meta")
  ) {
    return { origin: "meta", detail: "meta_text", source: "text", firstText, labels };
  }

  if (/\b(google ads|adwords|anuncio de google|publicidad de google)\b/.test(text)) {
    return { origin: "google", detail: "google_ads_text", source: "text", firstText, labels };
  }

  if (
    text.includes("sitio web") ||
    text.includes("pagina web") ||
    /\bweb\b/.test(text) ||
    text.includes("sitio")
  ) {
    return { origin: "web", detail: "web_text", source: "text", firstText, labels };
  }

  const explicitOrigins = ["meta", "google", "web"].filter((origin) =>
    labels.includes(origin),
  );

  if (explicitOrigins.length > 1) {
    return {
      conflict: true,
      reason: `etiquetas en conflicto: ${explicitOrigins.join(" + ")}`,
      firstText,
      labels,
    };
  }

  if (explicitOrigins.length === 1) {
    const origin = explicitOrigins[0];
    return {
      origin,
      detail: `${origin}_label`,
      source: "label",
      firstText,
      labels,
    };
  }

  return {
    origin: "otro",
    detail: "unknown",
    source: "unknown",
    firstText,
    labels,
  };
}

async function getConversation(conversationId) {
  const response = await api.get(`/conversations/${conversationId}`);
  return response.data;
}

async function getMessages(conversationId) {
  const all = [];
  const seen = new Set();
  let before = null;

  while (true) {
    const response = await api.get(`/conversations/${conversationId}/messages`, {
      params: before ? { before } : {},
    });

    const payload = Array.isArray(response.data?.payload)
      ? response.data.payload
      : Array.isArray(response.data)
        ? response.data
        : [];

    if (!payload.length) break;

    for (const message of payload) {
      const id = Number(message.id);
      if (Number.isFinite(id)) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      all.push(message);
    }

    const ids = payload
      .map((message) => Number(message.id))
      .filter((id) => Number.isFinite(id));

    if (!ids.length) break;

    const oldest = Math.min(...ids);
    if (before !== null && oldest >= before) break;
    before = oldest;

    if (payload.length < 20) break;
  }

  return all;
}

async function updateChatwootLabels(conversationId, currentLabels, origin) {
  const cleaned = currentLabels.filter(
    (label) => !["meta", "google", "web", "auditar-origen"].includes(String(label).toLowerCase()),
  );

  cleaned.push(origin);

  await api.post(`/conversations/${conversationId}/labels`, {
    labels: [...new Set(cleaned)],
  });
}

async function applyFix(row, detected, conversation) {
  await pool.query("BEGIN");

  try {
    await pool.query(
      `
      UPDATE control_ventas
      SET origen = $2,
          origen_detalle = $3,
          actualizado_en = NOW()
      WHERE chatwoot_conversation_id = $1
      `,
      [row.chatwoot_conversation_id, detected.origin, detected.detail],
    );

    await pool.query(
      `
      UPDATE prospectos
      SET origen = $2,
          actualizado_en = NOW()
      WHERE chatwoot_conversation_id = $1
        AND COALESCE(origen, '') <> 'prospecto-interno'
      `,
      [row.chatwoot_conversation_id, detected.origin],
    );

    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }

  await updateChatwootLabels(
    row.chatwoot_conversation_id,
    Array.isArray(conversation?.labels) ? conversation.labels : [],
    detected.origin,
  );
}

async function main() {
  if (!CHATWOOT_URL || !CHATWOOT_ACCOUNT_ID || !CHATWOOT_API_TOKEN) {
    throw new Error(
      "Faltan CHATWOOT_URL, CHATWOOT_ACCOUNT_ID o CHATWOOT_API_TOKEN",
    );
  }

  const { rows } = await pool.query(
    `
    SELECT
      chatwoot_conversation_id,
      origen,
      origen_detalle,
      fecha_ingreso,
      clasificacion,
      derivado
    FROM control_ventas
    WHERE chatwoot_conversation_id IS NOT NULL
      AND fecha_ingreso >= NOW() - ($1::int * INTERVAL '1 day')
    ORDER BY fecha_ingreso ASC
    `,
    [DAYS],
  );

  let revisadas = 0;
  let iguales = 0;
  let diferencias = 0;
  let corregidas = 0;
  let desconocidas = 0;
  let conflictos = 0;
  let omitidas = 0;
  let errores = 0;

  const changes = [];

  for (const row of rows) {
    const conversationId = Number(row.chatwoot_conversation_id);

    try {
      const [conversation, messages] = await Promise.all([
        getConversation(conversationId),
        getMessages(conversationId),
      ]);

      const detected = detectFromEvidence(conversation, messages);

      if (detected.skip) {
        omitidas++;
        continue;
      }

      if (detected.conflict) {
        conflictos++;
        changes.push({
          conversacion: conversationId,
          actual: row.origen || "NULL",
          detectado: "CONFLICTO",
          detalle: detected.reason,
          accion: "REVISAR",
          etiquetas: (detected.labels || []).join(", "),
          mensaje: String(detected.firstText || "").slice(0, 90),
        });
        continue;
      }

      revisadas++;

      if (detected.origin === "otro") {
        desconocidas++;
        if (!row.origen || row.origen === "otro") {
          iguales++;
          continue;
        }

        changes.push({
          conversacion: conversationId,
          actual: row.origen || "NULL",
          detectado: "SIN EVIDENCIA",
          detalle: "unknown",
          accion: "NO TOCAR",
          etiquetas: (detected.labels || []).join(", "),
          mensaje: String(detected.firstText || "").slice(0, 90),
        });
        continue;
      }

      const sameOrigin = row.origen === detected.origin;
      const sameDetail = row.origen_detalle === detected.detail;

      if (sameOrigin && sameDetail) {
        iguales++;
        continue;
      }

      diferencias++;

      let action = "PROPUESTA";
      if (FIX) {
        await applyFix(row, detected, conversation);
        corregidas++;
        action = "CORREGIDA";
      }

      changes.push({
        conversacion: conversationId,
        actual: row.origen || "NULL",
        detectado: detected.origin,
        detalle: detected.detail,
        fuente: detected.source,
        accion: action,
        etiquetas: (detected.labels || []).join(", "),
        mensaje: String(detected.firstText || "").slice(0, 90),
      });
    } catch (err) {
      errores++;
      changes.push({
        conversacion: conversationId,
        actual: row.origen || "NULL",
        detectado: "ERROR",
        detalle: err.response?.status
          ? `HTTP ${err.response.status}`
          : err.message,
        accion: "REVISAR",
        etiquetas: "",
        mensaje: "",
      });
    }
  }

  console.log("\n===== AUDITORÍA RECIENTE DE ORÍGENES =====");
  console.log(`Período: últimos ${DAYS} días`);
  console.log(`Modo: ${FIX ? "CORRECCIÓN" : "SOLO LECTURA"}`);
  console.log(`Registros encontrados: ${rows.length}`);
  console.log(`Revisadas: ${revisadas}`);
  console.log(`Sin cambios: ${iguales}`);
  console.log(`Diferencias detectadas: ${diferencias}`);
  console.log(`Corregidas: ${corregidas}`);
  console.log(`Sin evidencia suficiente: ${desconocidas}`);
  console.log(`Conflictos: ${conflictos}`);
  console.log(`Omitidas (internos/grupos): ${omitidas}`);
  console.log(`Errores: ${errores}`);

  if (changes.length) {
    console.log("\n===== DETALLE =====\n");
    console.table(changes);
  } else {
    console.log("\nNo se encontraron diferencias para revisar.");
  }

  if (!FIX && diferencias > 0) {
    console.log(
      `\nNo se modificó nada. Revisá el detalle y, si está correcto, ejecutá:\nnode scripts/auditar-origenes-recientes.js --days=${DAYS} --fix`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err.response?.data || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
