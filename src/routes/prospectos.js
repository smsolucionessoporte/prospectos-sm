const express = require("express");
const axios = require("axios");
const router = express.Router();
const { pool } = require("../db");
const { requireAuth, requireRol, layout } = require("../middleware/auth");
const { renderSeguimientosFicha, puedeGestionar, vendedorAsignado } = require("../crm/seguimientos");
const { pasoPorEstado } = require("../crm/pasos");
const {checkSlot,crearReunionMeet,cancelarReunionMeet,parseLocal}=require("../meet/calendar");
const {
  AGENTE_ZOOM,
  AGENTE_TELEFONO,
  AGENTE_INBOX,
  AGENTE_CHATWOOT_ID,
} = require("../zoomAgentes");
const {
  crearReunionZoom,
  enviarPorChatwoot,
  formatearFechaAR,
  normalizarTelefono,
  enviarAvisoInterno,
} = require("../zoomChatwoot");


// Las acciones de ficha (incluyendo demo, relevamiento, edición y cierre)
// son exclusivas del vendedor realmente asignado, no de cualquier vendedor autenticado.
router.use('/prospectos/:id', requireAuth, async (req, res, next) => {
  if (req.session.usuario.rol !== 'vendedor') return next();
  const prospectoId = Number(req.params.id);
  if (!Number.isSafeInteger(prospectoId) || prospectoId <= 0) return next();
  try {
    const {rows} = await pool.query(`SELECT id,chatwoot_conversation_id,creado_por,demo_responsable
      FROM prospectos WHERE id=$1`,[prospectoId]);
    if (!rows.length) return res.status(404).send('Prospecto no encontrado');
    if (!await puedeGestionar(rows[0],req.session.usuario))
      return res.status(403).send('Solo podés gestionar tus prospectos asignados');
    return next();
  } catch (error) {
    console.error('[CRM] Error verificando propietario del prospecto',prospectoId,error.message);
    return res.status(503).send('No se pudo validar el responsable comercial');
  }
});

// Canal individual de avisos del bot de Ventas. Nunca envía al grupo.
router.post('/api/ventas/aviso-directo', express.json(), async (req,res) => {
  if (!process.env.AUTOMATION_API_KEY || req.headers['x-api-key'] !== process.env.AUTOMATION_API_KEY)
    return res.status(401).json({ok:false,error:'No autorizado'});
  const agentId = Number(req.body?.chatwoot_agent_id);
  const mensaje = String(req.body?.mensaje || '').trim();
  if (![4,11,19].includes(agentId) || !mensaje || mensaje.length > 4000)
    return res.status(400).json({ok:false,error:'Destinatario o mensaje inválido'});
  const usuarioId = AGENTE_CHATWOOT_ID[agentId];
  try {
    const ok = await enviarAvisoInterno(mensaje,usuarioId);
    if (!ok) return res.status(503).json({ok:false,error:'No se pudo entregar al vendedor; revisar teléfono y canal individual'});
    return res.json({ok:true});
  } catch(err) {
    console.error('[VENTAS] No se pudo enviar aviso directo al agente',agentId,err.message);
    return res.status(502).json({ok:false,error:'Error del canal de notificaciones'});
  }
});

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatearDateTimeLocalAR(fecha) {
  if (!fecha) return "";

  const d = new Date(fecha);

  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);

  const get = (tipo) =>
    partes.find((p) => p.type === tipo)?.value || "";

  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}


async function alertarResponsableError(
  responsableId,
  titulo,
  prospecto,
  detalle,
) {
  const telefono = AGENTE_TELEFONO[responsableId];

  if (!telefono) {
    console.error(
      "No hay teléfono configurado para alertar al responsable:",
      responsableId,
    );
    return false;
  }

  const nombre =
    prospecto.nombre_negocio ||
    prospecto.contacto ||
    `Prospecto #${prospecto.id}`;

  const mensaje =
    `⚠️ *${titulo}*\n\n` +
    `Prospecto: *${nombre}*\n` +
    `${detalle}\n\n` +
    `Revisalo desde Prospectos para resolverlo.`;

  try {
    return await enviarPorChatwoot(
      telefono,
      mensaje,
      responsableId,
    );
  } catch (err) {
    console.error(
      "ERROR enviando alerta al responsable:",
      err.response?.data || err.message,
    );
    return false;
  }
}

function guardarResultadoAccion(req, titulo, resultados) {
  req.session.resultadoAccion = {
    titulo,
    resultados,
  };
}



function renderResultadoAccion(resultado) {
  if (!resultado) return "";

  const tieneError = resultado.resultados.some((r) => !r.ok);

  return `
    <div style="
      margin-bottom:18px;
      padding:16px 18px;
      border-radius:10px;
      border:1px solid ${tieneError ? "#f59e0b" : "#22c55e"};
      background:${tieneError ? "#fffbeb" : "#f0fdf4"};
    ">
      <div style="font-weight:700; margin-bottom:8px;">
        ${tieneError ? "⚠️" : "✅"} ${esc(resultado.titulo)}
      </div>

      ${resultado.resultados
        .map(
          (r) => `
            <div style="margin:4px 0;">
              ${r.ok ? "✅" : "❌"} ${esc(r.texto)}
            </div>
          `,
        )
        .join("")}

      ${
        tieneError
          ? `
            <div style="margin-top:10px; font-size:13px;">
              La acción principal quedó guardada, pero revisá los puntos indicados con ❌.
            </div>
          `
          : ""
      }
    </div>
  `;
}

const ESTADOS_LABEL = {
  prospecto: "Prospecto",
  sin_respuesta: "Sin respuesta",
  demo_coordinada: "Demo coordinada",
  demo_realizada: "Demo realizada",
  confirmado: "Confirmado",
  perdido: "Perdido",
};

const PROXIMA_ACCION = {
  prospecto: "Coordinar demo",
  sin_respuesta: "Reintentar contacto",
  demo_coordinada: "Completar relevamiento",
  demo_realizada: "Cerrar cliente",
  confirmado: "Dar de alta en SM Admin",
  perdido: "—",
};

const ESTADOS_COLOR = {
  prospecto: "gray",
  sin_respuesta: "yellow",
  demo_coordinada: "blue",
  demo_realizada: "purple",
  confirmado: "green",
  perdido: "red",
};

// Determina si el usuario logueado puede ejecutar acciones de cierre
// (confirmar / marcar perdido) sobre un prospecto puntual.
function puedeCerrar(usuarioSesion, prospecto) {
  if (usuarioSesion.rol === "admin" || usuarioSesion.rol === "administrativa")
    return true;
  if (usuarioSesion.rol === "vendedor")
    return prospecto.creado_por === usuarioSesion.id;
  return false;
}

function responsableCierre(p) {
  if (p.origen === "prospecto-interno") return "Admin";
  return p.creado_por_nombre || "Ventas";
}

router.post(
  "/api/prospectos/responsable-chatwoot",
  express.json(),
  async (req, res) => {
    const apiKey = req.headers["x-api-key"];

    if (apiKey !== process.env.AUTOMATION_API_KEY) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const {
      chatwoot_conversation_id,
      chatwoot_agent_id,
    } = req.body;

    if (!chatwoot_conversation_id || !chatwoot_agent_id) {
      return res.status(400).json({
        error: "Faltan datos",
      });
    }

    const usuarioId =
      AGENTE_CHATWOOT_ID[chatwoot_agent_id];

    if (!usuarioId) {
      return res.status(400).json({
        error: "Agente de Chatwoot no mapeado",
      });
    }

    try {
      // Prospectos
      const { rows } = await pool.query(
        `
        SELECT id, demo_responsable
        FROM prospectos
        WHERE chatwoot_conversation_id = $1
        LIMIT 1
        `,
        [chatwoot_conversation_id],
      );

      if (rows.length) {
        const prospecto = rows[0];

        if (prospecto.demo_responsable !== null) {
          await pool.query(
            `
            UPDATE prospectos
            SET demo_responsable = $2,
                actualizado_en = NOW()
            WHERE chatwoot_conversation_id = $1
            `,
            [chatwoot_conversation_id, usuarioId],
          );
        } else {
          await pool.query(
            `
            UPDATE prospectos
            SET creado_por = $2,
                actualizado_en = NOW()
            WHERE chatwoot_conversation_id = $1
            `,
            [chatwoot_conversation_id, usuarioId],
          );
        }
      }

      // Control / estadísticas
      const controlActual = await pool.query(
        `
        SELECT vendedor_id
        FROM control_ventas
        WHERE chatwoot_conversation_id = $1
        LIMIT 1
        `,
        [chatwoot_conversation_id],
      );

      const vendedorAnterior =
        controlActual.rows[0]?.vendedor_id ?? null;

if (vendedorAnterior !== usuarioId) {
  await pool.query(
    `
    UPDATE control_ventas
    SET vendedor_id = $2,
        fecha_inicio_espera_vendedor = CASE
          WHEN fecha_inicio_espera_vendedor IS NOT NULL THEN NOW()
          ELSE NULL
        END,
        actualizado_en = NOW()
    WHERE chatwoot_conversation_id = $1
    `,
    [chatwoot_conversation_id, usuarioId],
  );
}

      return res.json({
        ok: true,
        usuario_id: usuarioId,
      });
    } catch (err) {
      console.error(
        "Error actualizando responsable desde Chatwoot:",
        err,
      );

      return res.status(500).json({
        error: "Error interno",
      });
    }
  },
);

// ─── ALTA AUTOMÁTICA DESDE AUTOMATIZACIÓN EXTERNA (Chatwoot) ─────────────────
router.post("/api/prospectos/auto-crear", express.json(), async (req, res) => {
  const apiKey = req.headers["x-api-key"];

  if (apiKey !== process.env.AUTOMATION_API_KEY) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const {
    nombre_contacto,
    telefono,
    rubro,
    origen,
    chatwoot_agent_id,
    chatwoot_conversation_id,
  } = req.body;

  if (!telefono) {
    return res.status(400).json({ error: "Falta teléfono" });
  }

  try {
    const creadoPor = AGENTE_CHATWOOT_ID[chatwoot_agent_id] || null;

    // Esta ruta es exclusiva de automatizaciones de Chatwoot.
    // Nunca registrar como "manual" un alta automática por falta de origen:
    // si todavía no se pudo identificar, debe quedar como "otro".
    const origenNormalizado = [
      "meta",
      "google",
      "web",
      "otro",
      "prospecto-interno",
    ].includes(origen)
      ? origen
      : "otro";

    const rubroNormalizado =
      typeof rubro === "string" && rubro.trim()
        ? rubro.trim()
        : null;

    // 1. Buscar primero por conversación de Chatwoot.
    if (chatwoot_conversation_id) {
      const { rows: porConversacion } = await pool.query(
        `SELECT id
         FROM prospectos
         WHERE chatwoot_conversation_id = $1
         LIMIT 1`,
        [chatwoot_conversation_id],
      );

      if (porConversacion.length) {
        const prospectoId = porConversacion[0].id;

        // Si vuelve a llegar el webhook, actualizamos los datos
        // disponibles en lugar de crear otro prospecto.
        await pool.query(
          `UPDATE prospectos
            SET contacto = COALESCE($2, contacto),
                telefono = COALESCE($3, telefono),
                creado_por = COALESCE($4, creado_por),
                rubro = COALESCE($5, rubro),
                origen = CASE
                  WHEN $6 IN ('meta', 'google', 'web', 'prospecto-interno') THEN $6
                  WHEN origen IS NULL OR BTRIM(origen) = '' THEN $6
                  ELSE origen
                END,
                actualizado_en = NOW()
            WHERE id = $1`,
        [
          prospectoId,
          nombre_contacto || null,
          telefono || null,
          creadoPor,
          rubroNormalizado,
          origenNormalizado,
        ],        
        );

        console.log(
          "DEBUG auto-crear: prospecto ya existente por conversación",
          chatwoot_conversation_id,
          "id",
          prospectoId,
        );

        return res.status(200).json({
          ok: true,
          duplicado: true,
          actualizado: true,
          id: prospectoId,
        });
      }
    }

    // 2. Protección adicional por teléfono.
    const variantes = normalizarTelefono(telefono);

    const { rows: porTelefono } = await pool.query(
      `SELECT id, chatwoot_conversation_id
       FROM prospectos
       WHERE telefono = ANY($1)
       LIMIT 1`,
      [variantes],
    );

    if (porTelefono.length) {
      const prospectoId = porTelefono[0].id;

      await pool.query(
        `UPDATE prospectos
         SET contacto = COALESCE($2, contacto),
             creado_por = COALESCE($3, creado_por),
             chatwoot_conversation_id =
               COALESCE(chatwoot_conversation_id, $4),
             rubro = COALESCE($5, rubro),
             origen = CASE
               WHEN $6 IN ('meta', 'google', 'web', 'prospecto-interno') THEN $6
               WHEN origen IS NULL OR BTRIM(origen) = '' THEN $6
               ELSE origen
             END,
             actualizado_en = NOW()
         WHERE id = $1`,
        [
          prospectoId,
          nombre_contacto || null,
          creadoPor,
          chatwoot_conversation_id || null,
          rubroNormalizado,
          origenNormalizado,
        ],
      );

      console.log(
        "DEBUG auto-crear: prospecto ya existente por teléfono, id",
        prospectoId,
      );

      return res.status(200).json({
        ok: true,
        duplicado: true,
        actualizado: true,
        id: prospectoId,
      });
    }

        // 3. No existe: intentar crear prospecto.
        // ON CONFLICT protege contra dos webhooks concurrentes de la misma
        // conversación. La BD tiene un índice UNIQUE sobre
        // chatwoot_conversation_id.
        const result = await pool.query(
          `INSERT INTO prospectos (
            nombre_negocio,
            contacto,
            telefono,
            rubro,
            nota_prospecto,
            creado_por,
            origen,
            chatwoot_conversation_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (chatwoot_conversation_id)
            WHERE chatwoot_conversation_id IS NOT NULL
          DO NOTHING
          RETURNING id`,
            [
            null,                              // nombre_negocio
            nombre_contacto || null,           // contacto
            telefono,                          // telefono
            rubroNormalizado || "Otro",          // rubro
            null,                              // nota_prospecto
            creadoPor,                         // creado_por
            origenNormalizado,                 // origen
            chatwoot_conversation_id || null,  // chatwoot_conversation_id
          ],
        );

        // Si otro request creó la misma conversación entre nuestro SELECT
        // y el INSERT, PostgreSQL evita el duplicado. Recuperamos ese registro
        // y respondemos como actualización/duplicado.
        if (result.rows.length === 0) {
          const { rows: existente } = await pool.query(
            `SELECT id
            FROM prospectos
            WHERE chatwoot_conversation_id = $1
            LIMIT 1`,
            [chatwoot_conversation_id],
          );

          if (existente.length) {
            const prospectoId = existente[0].id;

            await pool.query(
              `UPDATE prospectos
              SET contacto = COALESCE($2, contacto),
                  telefono = COALESCE($3, telefono),
                  creado_por = COALESCE($4, creado_por),
                  rubro = COALESCE($5, rubro),
                  origen = CASE
                    WHEN $6 IN ('meta', 'google', 'web', 'prospecto-interno') THEN $6
                    WHEN origen IS NULL OR BTRIM(origen) = '' THEN $6
                    ELSE origen
                  END,
                  actualizado_en = NOW()
              WHERE id = $1`,
              [
                prospectoId,
                nombre_contacto || null,
                telefono || null,
                creadoPor,
                rubroNormalizado,
                origenNormalizado,
              ],
            );

            console.log(
              "DEBUG auto-crear: alta concurrente detectada; se reutiliza prospecto",
              prospectoId,
              "conversation_id",
              chatwoot_conversation_id,
            );

            return res.status(200).json({
              ok: true,
              duplicado: true,
              actualizado: true,
              id: prospectoId,
            });
          }

          throw new Error(
            "Conflicto al crear prospecto pero no se encontró el registro existente",
          );
        }

    const prospectoId = result.rows[0].id;

    await pool.query(
      `INSERT INTO historial_estados (
         prospecto_id,
         estado_anterior,
         estado_nuevo,
         usuario_id,
         nota
       )
       VALUES ($1, NULL, 'prospecto', $2, 'Alta automática desde Chatwoot')`,
      [prospectoId, creadoPor],
    );

    console.log(
      "DEBUG auto-crear: prospecto creado, id",
      prospectoId,
      "conversation_id",
      chatwoot_conversation_id,
      "creado_por",
      creadoPor,
      "origen",
      origen,
    );

    return res.status(201).json({
      ok: true,
      id: prospectoId,
    });
  } catch (err) {
    console.error("Error creando prospecto automático:", err);

    return res.status(500).json({
      error: "Error interno",
    });
  }
});

// ─── REASIGNACIÓN AUTOMÁTICA DESDE CHATWOOT ─────────────────────────────────
router.post("/api/prospectos/reasignar", express.json(), async (req, res) => {
  const apiKey = req.headers["x-api-key"];

  if (apiKey !== process.env.AUTOMATION_API_KEY) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const {
    chatwoot_conversation_id,
    vendedor_id,
    vendedor_nombre,
    vendedor_anterior_nombre,
    tipo = "automatica",
    solicitado_por,
  } = req.body;

  if (!chatwoot_conversation_id) {
    return res.status(400).json({
      error: "Falta chatwoot_conversation_id",
    });
  }

  if (!vendedor_id) {
    return res.status(400).json({
      error: "Falta vendedor_id",
    });
  }

  const nuevoResponsableId = AGENTE_CHATWOOT_ID[vendedor_id] || null;

  if (!nuevoResponsableId) {
    return res.status(400).json({
      error: `No existe mapeo local para el agente Chatwoot ${vendedor_id}`,
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows: prospectos } = await client.query(
      `
      SELECT
        p.id,
        p.estado,
        p.creado_por,
        p.demo_responsable,
        uc.nombre AS creado_por_nombre,
        ud.nombre AS demo_responsable_nombre
      FROM prospectos p
      LEFT JOIN usuarios uc
        ON uc.id = p.creado_por
      LEFT JOIN usuarios ud
        ON ud.id = p.demo_responsable
      WHERE p.chatwoot_conversation_id = $1
      LIMIT 1
      FOR UPDATE OF p
      `,
      [chatwoot_conversation_id],
    );

    if (!prospectos.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Prospecto no encontrado para esa conversación",
      });
    }

    const actual = prospectos[0];

    const { rows: responsables } = await client.query(
      `
      SELECT id, nombre
      FROM usuarios
      WHERE id = $1
        AND activo = true
        AND rol IN ('soporte', 'admin', 'vendedor')
      LIMIT 1
      `,
      [nuevoResponsableId],
    );

    if (!responsables.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "El nuevo responsable no existe o está inactivo",
      });
    }

    const nuevoResponsable = responsables[0];

    const tieneResponsableDemo = actual.demo_responsable !== null;

    const responsableAnteriorNombre =
      vendedor_anterior_nombre ||
      (tieneResponsableDemo
        ? actual.demo_responsable_nombre
        : actual.creado_por_nombre) ||
      "Sin asignar";

    if (tieneResponsableDemo) {
      await client.query(
        `
        UPDATE prospectos
        SET
          demo_responsable = $1,
          actualizado_en = NOW()
        WHERE id = $2
        `,
        [nuevoResponsable.id, actual.id],
      );
    } else {
      await client.query(
        `
        UPDATE prospectos
        SET
          creado_por = $1,
          actualizado_en = NOW()
        WHERE id = $2
        `,
        [nuevoResponsable.id, actual.id],
      );
    }

    await client.query(
      `
      UPDATE control_ventas
      SET
        vendedor_id = $2,
        vendedor_nombre = $3,
        fecha_inicio_espera_vendedor = CASE WHEN $4 = 'manual' THEN NULL ELSE NOW() END,
        actualizado_en = NOW()
      WHERE chatwoot_conversation_id = $1
      `,
      [
        chatwoot_conversation_id,
        nuevoResponsable.id,
        vendedor_nombre || nuevoResponsable.nombre,
        tipo === "manual" ? "manual" : "automatica",
      ],
    );

    const nota = tipo === "manual"
      ? `Reasignación manual solicitada por ${String(solicitado_por || "Administración").slice(0, 120)}: ` +
        `${responsableAnteriorNombre} → ${nuevoResponsable.nombre}`
      : `Reasignación automática por falta de respuesta: ` +
        `${responsableAnteriorNombre} → ${nuevoResponsable.nombre}`;

    await client.query(
      `
      INSERT INTO historial_estados
        (
          prospecto_id,
          estado_anterior,
          estado_nuevo,
          usuario_id,
          nota
        )
      VALUES ($1, $2, $2, NULL, $3)
      `,
      [actual.id, actual.estado, nota],
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      prospecto_id: actual.id,
      chatwoot_conversation_id,
      responsable_anterior: responsableAnteriorNombre,
      responsable_nuevo: nuevoResponsable.nombre,
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(
      "Error sincronizando reasignación automática:",
      err,
    );

    return res.status(500).json({
      error: "Error interno",
    });
  } finally {
    client.release();
  }
});

// ─── SINCRONIZAR ORIGEN DESDE ETIQUETAS DE CHATWOOT ──────────────────────────
router.post(
  "/api/prospectos/origen-chatwoot",
  express.json(),
  async (req, res) => {
    const apiKey = req.headers["x-api-key"];

    if (apiKey !== process.env.AUTOMATION_API_KEY) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const {
      chatwoot_conversation_id,
      origen,
    } = req.body;

    if (!chatwoot_conversation_id) {
      return res.status(400).json({
        error: "Falta chatwoot_conversation_id",
      });
    }

    if (!["google", "meta", "web"].includes(origen)) {
      return res.status(400).json({
        error: "Origen no válido",
      });
    }

const origenProspecto = origen;

    try {
      // 1. Corregir estadísticas / Control.
      await pool.query(
        `
        UPDATE control_ventas
        SET origen_detalle = CASE
              WHEN origen IS DISTINCT FROM $2 THEN $3
              ELSE origen_detalle
            END,
            origen = $2,
            actualizado_en = NOW()
        WHERE chatwoot_conversation_id = $1
        `,
        [chatwoot_conversation_id, origen, `${origen}_label`],
      );

      // 2. Si ya existe Prospecto, corregir también su origen.
      // No crea un Prospecto nuevo.
      await pool.query(
        `
        UPDATE prospectos
        SET origen = $2,
            actualizado_en = NOW()
        WHERE chatwoot_conversation_id = $1
        `,
        [chatwoot_conversation_id, origenProspecto],
      );

      return res.json({
        ok: true,
        chatwoot_conversation_id,
        origen,
      });
    } catch (err) {
      console.error(
        "Error sincronizando origen desde Chatwoot:",
        err,
      );

      return res.status(500).json({
        error: "Error interno",
      });
    }
  },
);

// Estado comercial para evitar alertas/reasignaciones de demos o cierres.
router.get("/api/prospectos/etapa-chatwoot/:conversationId", async (req, res) => {
  if (!process.env.AUTOMATION_API_KEY || req.headers["x-api-key"] !== process.env.AUTOMATION_API_KEY) {
    return res.status(401).json({ error: "No autorizado" });
  }
  const conversationId = Number(req.params.conversationId);
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
    return res.status(400).json({ error: "Conversación inválida" });
  }
  try {
    const result = await pool.query(
      `SELECT estado FROM prospectos WHERE chatwoot_conversation_id = $1
       ORDER BY actualizado_en DESC NULLS LAST, id DESC LIMIT 1`,
      [conversationId],
    );
    return res.json({ estado: result.rows[0]?.estado ?? null });
  } catch (error) {
    console.error("Error leyendo estado comercial:", error);
    return res.status(500).json({ error: "Error consultando etapa comercial" });
  }
});

// ─── CONTROL COMERCIAL DESDE CHATWOOT ────────────────────────────────────────
router.post("/api/control-ventas/evento", express.json(), async (req, res) => {
  const apiKey = req.headers["x-api-key"];

  if (apiKey !== process.env.AUTOMATION_API_KEY) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const {
    chatwoot_conversation_id,
    evento,
    origen,
    origen_detalle,
    vendedor_id,
    vendedor_nombre,
  } = req.body;

  if (!chatwoot_conversation_id) {
    return res.status(400).json({
      error: "Falta chatwoot_conversation_id",
    });
  }

  const eventosPermitidos = [
    "ingreso",
    "respuesta_cliente",
    "consulta_erronea",
    "no_interesado",
    "derivacion",
    "espera_vendedor",
    "cancelar_espera_vendedor",
    "respuesta_vendedor",
  ];

  if (!eventosPermitidos.includes(evento)) {
    return res.status(400).json({
      error: "Evento no permitido",
    });
  }

  try {
    // Garantizar que exista el registro.
    // Si llega primero cualquier otro evento, igualmente lo creamos.
    await pool.query(
      `
      INSERT INTO control_ventas (
        chatwoot_conversation_id,
        origen,
        origen_detalle,
        fecha_ingreso
      )
      VALUES ($1, $2, $3, NOW())

      ON CONFLICT (chatwoot_conversation_id)
      DO UPDATE SET
        origen = CASE
          -- Si ya identificamos Meta o Google, nunca degradarlo a "otro".
          WHEN control_ventas.origen IN ('meta', 'google', 'web')
            THEN control_ventas.origen

          -- Si estaba vacío/otro y ahora conseguimos un origen real, mejorarlo.
          WHEN EXCLUDED.origen IN ('meta', 'google', 'web')
            THEN EXCLUDED.origen

          -- En cualquier otro caso conservar lo que ya teníamos.
          ELSE COALESCE(
            control_ventas.origen,
            EXCLUDED.origen
          )
        END,
        origen_detalle = COALESCE(
          EXCLUDED.origen_detalle,
          control_ventas.origen_detalle
        ),
        actualizado_en = NOW()
      `,
      [
        chatwoot_conversation_id,
        origen || null,
        origen_detalle || null,
      ],
    );

    if (evento === "respuesta_cliente") {
      await pool.query(
        `
        UPDATE control_ventas
        SET
          respondio_cliente = TRUE,
          fecha_primera_respuesta_cliente =
            COALESCE(fecha_primera_respuesta_cliente, NOW()),
          actualizado_en = NOW()
        WHERE chatwoot_conversation_id = $1
        `,
        [chatwoot_conversation_id],
      );
    }

if (evento === "consulta_erronea") {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Una consulta errónea nunca debe quedar contabilizada como derivada
    // ni asociada a un vendedor.
    await client.query(
      `
      UPDATE control_ventas
      SET
        respondio_cliente = TRUE,
        fecha_primera_respuesta_cliente =
          COALESCE(fecha_primera_respuesta_cliente, NOW()),
        clasificacion = 'consulta_erronea',
        fecha_clasificacion =
          COALESCE(fecha_clasificacion, NOW()),
        derivado = FALSE,
        fecha_derivacion = NULL,
        vendedor_id = NULL,
        vendedor_nombre = NULL,
        fecha_primera_respuesta_vendedor = NULL,
        fecha_inicio_espera_vendedor = NULL,
        actualizado_en = NOW()
      WHERE chatwoot_conversation_id = $1
      `,
      [chatwoot_conversation_id],
    );

    // Si llegó a crearse un prospecto antes de detectar que la consulta
    // era errónea, eliminarlo del circuito comercial.
    await client.query(
      `
      DELETE FROM prospectos
      WHERE chatwoot_conversation_id = $1
      `,
      [chatwoot_conversation_id],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
    if (evento === "no_interesado") {
      await pool.query(
        `
        UPDATE control_ventas
        SET
          respondio_cliente = TRUE,
          fecha_primera_respuesta_cliente =
            COALESCE(fecha_primera_respuesta_cliente, NOW()),
          clasificacion = 'no_interesado',
          fecha_clasificacion = NOW(),
          fecha_inicio_espera_vendedor = NULL,
          actualizado_en = NOW()
        WHERE chatwoot_conversation_id = $1
        `,
        [chatwoot_conversation_id],
      );
    }

    if (evento === "derivacion") {
      const usuarioLocal =
        vendedor_id
          ? AGENTE_CHATWOOT_ID[vendedor_id] || null
          : null;

      await pool.query(
        `
        UPDATE control_ventas
        SET
          derivado = TRUE,
          fecha_derivacion =
            COALESCE(fecha_derivacion, NOW()),
          vendedor_id =
            COALESCE($2, vendedor_id),
          vendedor_nombre =
            COALESCE($3, vendedor_nombre),
          fecha_inicio_espera_vendedor =
            COALESCE(fecha_inicio_espera_vendedor, NOW()),
          actualizado_en = NOW()
          WHERE chatwoot_conversation_id = $1
            AND COALESCE(clasificacion, '') <> 'consulta_erronea'
          `,
        [
          chatwoot_conversation_id,
          usuarioLocal,
          vendedor_nombre || null,
        ],
      );
    }

    if (evento === "espera_vendedor") {
      await pool.query(
        `
        UPDATE control_ventas
        SET
          -- Se ejecuta ante un NUEVO mensaje del cliente ya derivado.
          -- Si existió atención humana previamente, confirma que el
          -- prospecto volvió a responder luego de esa atención.
          fecha_respuesta_cliente_post_atencion = CASE
            WHEN fecha_primera_respuesta_vendedor IS NOT NULL
            THEN COALESCE(fecha_respuesta_cliente_post_atencion, NOW())
            ELSE fecha_respuesta_cliente_post_atencion
          END,
          fecha_inicio_espera_vendedor =
            COALESCE(fecha_inicio_espera_vendedor, NOW()),
          actualizado_en = NOW()
        WHERE chatwoot_conversation_id = $1
          AND derivado = TRUE
          AND COALESCE(clasificacion, '') <> 'consulta_erronea'
        `,
        [chatwoot_conversation_id],
      );
    }

    if (evento === "cancelar_espera_vendedor") {
      await pool.query(
        `
        UPDATE control_ventas
        SET
          fecha_inicio_espera_vendedor = NULL,
          actualizado_en = NOW()
        WHERE chatwoot_conversation_id = $1
        `,
        [chatwoot_conversation_id],
      );
    }

    if (evento === "respuesta_vendedor") {
      await pool.query(
        `
        UPDATE control_ventas
        SET
          fecha_inicio_seguimiento_post_atencion =
            COALESCE(fecha_inicio_seguimiento_post_atencion, NOW()),
          fecha_primera_respuesta_vendedor =
            COALESCE(fecha_primera_respuesta_vendedor, NOW()),
          fecha_inicio_espera_vendedor = NULL,
          actualizado_en = NOW()
        WHERE chatwoot_conversation_id = $1
          AND derivado = TRUE
        `,
        [chatwoot_conversation_id],
      );
    }

    return res.json({
      ok: true,
      chatwoot_conversation_id,
      evento,
    });
  } catch (err) {
    console.error("Error registrando evento de control:", err);

    return res.status(500).json({
      error: "Error interno",
    });
  }
});

// ─── SINCRONIZAR ESTADO DESDE CHATWOOT ───────────────────────────────────────
router.post(
  "/api/prospectos/estado-chatwoot",
  express.json(),
  async (req, res) => {
    const apiKey = req.headers["x-api-key"];

    if (apiKey !== process.env.AUTOMATION_API_KEY) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const { chatwoot_conversation_id, estado } = req.body;

    if (!chatwoot_conversation_id) {
      return res.status(400).json({ error: "Falta chatwoot_conversation_id" });
    }

    if (!["prospecto", "sin_respuesta"].includes(estado)) {
      return res.status(400).json({ error: "Estado no permitido" });
    }

    try {
      const { rows } = await pool.query(
        `SELECT id, estado
       FROM prospectos
       WHERE chatwoot_conversation_id = $1
       LIMIT 1`,
        [chatwoot_conversation_id],
      );

      if (!rows.length) {
        return res.status(404).json({ error: "Prospecto no encontrado" });
      }

      const prospecto = rows[0];

      if (prospecto.estado === estado) {
        return res.json({
          ok: true,
          actualizado: false,
          id: prospecto.id,
          estado,
        });
      }

      await pool.query(
        `UPDATE prospectos
       SET estado = $2,
           actualizado_en = NOW()
       WHERE id = $1`,
        [prospecto.id, estado],
      );

      await pool.query(
        `INSERT INTO historial_estados (
         prospecto_id,
         estado_anterior,
         estado_nuevo,
         usuario_id,
         nota
       )
       VALUES ($1, $2, $3, NULL, $4)`,
        [
          prospecto.id,
          prospecto.estado,
          estado,
          estado === "sin_respuesta"
            ? "Marcado automáticamente por Chatwoot después de 3 intentos sin respuesta"
            : "Reactivado automáticamente porque el prospecto volvió a escribir",
        ],
      );

      console.log(
        "DEBUG estado-chatwoot:",
        chatwoot_conversation_id,
        prospecto.estado,
        "->",
        estado,
      );

      return res.json({
        ok: true,
        actualizado: true,
        id: prospecto.id,
        estado,
      });
    } catch (err) {
      console.error("ERROR estado-chatwoot:", err);
      return res.status(500).json({ error: "Error actualizando prospecto" });
    }
  },
);

// ─── NUEVO PROSPECTO (Manual) ─────────────────────────────────────────
router.get("/prospectos/nuevo", requireAuth, (req, res) => {
  res.send(
    layout(
      "Nuevo prospecto",
      `
    <div class="page-header">
      <div>
        <a href="/panel" class="back-link"><i class="ti ti-arrow-left"></i> Volver al panel</a>
        <h1 class="page-title">Nuevo prospecto</h1>
        <p class="page-sub">Datos iniciales — Área Administrativa</p>
      </div>
    </div>
    <div class="form-card">
      <form method="POST" action="/prospectos">
        <div class="form-section">
          <div class="section-title-row">
            <i class="ti ti-user"></i>
            <span>Datos del prospecto</span>
          </div>
          <div class="grid2">
            <div class="field">
              <label for="contacto">Nombre <span class="req">*</span></label>
              <input type="text" id="contacto" name="contacto" required placeholder="Nombre de la persona">
            </div>
            <div class="field">
              <label for="nombre_negocio">Nombre del negocio</label>
              <input type="text" id="nombre_negocio" name="nombre_negocio" placeholder="Ej: Dietética La Vida (opcional)">
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label for="telefono">Teléfono <span class="req">*</span></label>
              <input type="text" id="telefono" name="telefono" required placeholder="+549 11 2233-4455" pattern="\+549\d{9,10}" title="Formato requerido: +549 seguido del número (ej: +5491122334455)">
            </div>
            <div class="field">
              <label for="email">Email</label>
              <input type="email" id="email" name="email" placeholder="correo@ejemplo.com">
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row">
            <i class="ti ti-building-store"></i>
            <span>Rubro <span class="req">*</span></span>
          </div>
          <div class="chips-group" id="chips-rubro">
            ${[
              "Dietética",
              "Almacén / minimercado",
              "Carnicería",
              "Pollería",
              "Pet Shop",
              "Forrajería",
              "Fiambrería",
              "Mayorista",
              "Otro",
            ]
              .map(
                (r) =>
                  `<label class="chip-label"><input type="radio" name="rubro" value="${r}" required><span class="chip">${r}</span></label>`,
              )
              .join("")}
          </div>
          <div class="field" style="margin-top:10px">
            <label for="rubro_otro">Especificar si es otro</label>
            <input type="text" id="rubro_otro" name="rubro_otro" placeholder="Rubro específico">
          </div>
        </div>

            
        <div class="form-section">
          <div class="section-title-row">
            <i class="ti ti-note"></i>
            <span>Notas</span>
          </div>
          <div class="field">
            <label for="nota_prospecto">Notas</label>
            <textarea id="nota_prospecto" name="nota_prospecto" placeholder="Contexto del primer contacto, observaciones..."></textarea>
          </div>
        </div>

        <div class="form-actions">
          <a href="/panel" class="btn btn-ghost">Cancelar</a>
          <button type="submit" class="btn btn-primary">
            <i class="ti ti-user-plus"></i> Registrar prospecto
          </button>
        </div>
      </form>
    </div>
    <script>
    document.querySelectorAll('.chip-label input').forEach(input => {
      function sync() { input.nextElementSibling.classList.toggle('active', input.checked); }
      input.addEventListener('change', sync);
      sync();
    });
    </script>
  `,
      req,
    ),
  );
});

router.post("/prospectos", requireAuth, async (req, res) => {
  const {
    nombre_negocio,
    contacto,
    telefono,
    email,
    rubro,
    rubro_otro,
    nota_prospecto
  } = req.body;
  try {
    const variantes = normalizarTelefono(telefono);
    const { rows: existe } = await pool.query(
      "SELECT id, nombre_negocio, contacto FROM prospectos WHERE telefono = ANY($1)",
      [variantes],
    );
    if (existe.length) {
      const nombreExistente = (
        existe[0].nombre_negocio ||
        existe[0].contacto ||
        "Sin nombre"
      ).replace(/'/g, "\\'");
      return res.status(400).send(`
        <script>
          alert('Ya existe un prospecto con ese teléfono: "${nombreExistente}" (ver /prospectos/${existe[0].id})');
          window.history.back();
        </script>
      `);
    }

    const result = await pool.query(
      `
      INSERT INTO prospectos (
        nombre_negocio,
        contacto,
        telefono,
        email,
        rubro,
        rubro_otro,
        nota_prospecto,
        creado_por
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id
    `,
      [
        nombre_negocio || null,
        contacto,
        telefono,
        email,
        rubro,
        rubro_otro,
        nota_prospecto || null,
        req.session.usuario.id,
      ],
    );

    await pool.query(
      `
      INSERT INTO historial_estados (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
      VALUES ($1, null, 'prospecto', $2, 'Alta de prospecto')
    `,
      [result.rows[0].id, req.session.usuario.id],
    );

    res.redirect("/prospectos/" + result.rows[0].id);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error al guardar");
  }
});

// ─── ELIMINAR PROSPECTO (solo usuario id 6) ───────────────────────────────────
router.post("/prospectos/:id/eliminar", requireAuth, async (req, res) => {
  if (req.session.usuario.rol !== "admin") {
    return res.status(403).send("No autorizado");
  }
  try {
    await pool.query("DELETE FROM prospectos WHERE id=$1", [req.params.id]);
    res.redirect("/panel");
  } catch (err) {
    console.error("Error eliminando prospecto:", err);
    res.status(500).send("Error al eliminar");
  }
});

// ─── DETALLE DE PROSPECTO ──────────────────────────────────────────────────────
router.get("/prospectos/:id", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT p.*, 
        uc.nombre as creado_por_nombre,
        ud.nombre as demo_resp_nombre,
        ur.nombre as relevamiento_por_nombre
      FROM prospectos p
      LEFT JOIN usuarios uc ON p.creado_por = uc.id
      LEFT JOIN usuarios ud ON p.demo_responsable = ud.id
      LEFT JOIN usuarios ur ON p.relevamiento_completado_por = ur.id
      WHERE p.id = $1
    `,
      [req.params.id],
    );

    if (!rows.length) return res.status(404).send("Prospecto no encontrado");
    const p = rows[0];

    const historial = await pool.query(
      `
      SELECT h.*, u.nombre as usuario_nombre
      FROM historial_estados h
      LEFT JOIN usuarios u ON h.usuario_id = u.id
      WHERE h.prospecto_id = $1 ORDER BY h.fecha ASC
    `,
      [p.id],
    );

    const seguimientosHtml = await renderSeguimientosFicha(p, req.session.usuario, req.query.tarea);
    const gestionesCRM = await pool.query(`
      SELECT s.gestion_realizada,s.proxima_accion,s.vence_en,s.creado_en,s.recordatorio,
             u.nombre AS usuario_nombre
      FROM crm_seguimientos s LEFT JOIN usuarios u ON u.id=s.usuario_id
      WHERE s.prospecto_id=$1 ORDER BY s.creado_en ASC LIMIT 100`, [p.id]);

    const est = ESTADOS_COLOR[p.estado] || "gray";
    const estadoLabel = ESTADOS_LABEL[p.estado] || p.estado;
    const responsableActualNombre =
      p.demo_resp_nombre || p.creado_por_nombre || "—";

    // Acciones disponibles según estado y rol
    const acciones = [];
    const gestionaEtapa = ['admin','vendedor'].includes(req.session.usuario.rol) &&
      await puedeGestionar(p,req.session.usuario);
    if (gestionaEtapa && ['prospecto','sin_respuesta'].includes(p.estado)) {
      const siguiente = p.estado === 'prospecto' ? 'sin_respuesta' : 'prospecto';
      const texto = siguiente === 'sin_respuesta' ? 'Marcar sin respuesta' : 'Volver a prospecto';
      acciones.push(`<form method="post" action="/prospectos/${p.id}/estado" style="display:inline"
        onsubmit="return confirm('¿Confirmás el cambio de estado comercial?')">
        <input type="hidden" name="estado" value="${siguiente}">
        <button class="btn btn-secondary" type="submit"><i class="ti ti-flag"></i> ${texto}</button></form>`);
    }
    if (["prospecto", "sin_respuesta"].includes(p.estado)) {
      acciones.push(`
          <a href="/prospectos/${p.id}/demo" class="btn btn-primary">
            <i class="ti ti-calendar-event"></i> Coordinar demo
          </a>
        `);

      acciones.push(`
          <button
            type="button"
            class="btn btn-danger"
            onclick="abrirModalPerdido()"
          >
            <i class="ti ti-x"></i> Marcar como perdido
          </button>
        `);
    }
        if (p.estado === "demo_coordinada") {
          const demoYaPaso =
            p.demo_fecha &&
            new Date(p.demo_fecha).getTime() <= Date.now();

          if (demoYaPaso) {
            acciones.push(
              `<a href="/prospectos/${p.id}/relevamiento" class="btn btn-primary">
                <i class="ti ti-clipboard-list"></i> Cargar relevamiento
              </a>`,
            );
          }

          acciones.push(`
            <form
              method="POST"
              action="/prospectos/${p.id}/reprogramar-demo"
              style="display:inline"
              onsubmit="return confirm(
                '¿Confirmás que la demostración fue cancelada y debe reprogramarse?\\n\\n' +
                'Al continuar:\\n' +
                '• La demo actual dejará de figurar como coordinada.\\n' +
                '• El prospecto volverá al estado PROSPECTO.\\n' +
                '• Quedará registrado en el historial que la demo debe reprogramarse.\\n' +
                '• Luego podrás coordinar una nueva fecha.'
              )"
            >
              <button type="submit" class="btn btn-secondary">
                <i class="ti ti-calendar-repeat"></i> Reprogramar
              </button>
            </form>
          `);

          acciones.push(`
            <button
              type="button"
              class="btn btn-danger"
              onclick="abrirModalPerdido()"
            >
              <i class="ti ti-x"></i> Marcar como perdido
            </button>
          `);
        }

    if (p.estado === "demo_realizada") {
      acciones.push(`
        <form
          method="POST"
          action="/prospectos/${p.id}/estado"
          style="display:inline"
          onsubmit="return confirm(
            '¿Confirmás que este prospecto YA ACEPTÓ avanzar como cliente?\\n\\n' +
            'Al continuar:\\n' +
            '• El prospecto pasará a estado CONFIRMADO.\\n' +
            '• Se enviará automáticamente al cliente el mensaje de bienvenida a SM Soluciones.\\n' +
            '• Se avisará por WhatsApp al vendedor responsable.\\n' +
            '• La próxima etapa será el alta e implementación.\\n\\n' +
            'Esta acción debe realizarse solamente cuando el cliente haya confirmado la contratación.'
          )"
        >
          <input type="hidden" name="estado" value="confirmado">

          <button type="submit" class="btn btn-success">
            <i class="ti ti-check"></i> Confirmar cliente
          </button>
        </form>

        <button
          type="button"
          class="btn btn-danger"
          onclick="abrirModalPerdido()"
        >
          <i class="ti ti-x"></i> Marcar como perdido
        </button>
      `);
    }
    if (!["confirmado", "perdido"].includes(p.estado) && await puedeGestionar(p, req.session.usuario)) {
      acciones.push(`<a href="#seguimientos" class="btn btn-primary"><i class="ti ti-notes"></i> Dejar seguimiento</a>`);
    }
    acciones.push(
      `<a href="/prospectos/${p.id}/editar" class="btn btn-secondary"><i class="ti ti-pencil"></i> Editar</a>`,
    );
    if (req.session.usuario.rol === "admin" && p.chatwoot_conversation_id) {
    }

// ELIMINAR PROSPECTO (solo administradores)
if (req.session.usuario.rol === "admin") {
    acciones.push(`
    <form
      method="POST"
      action="/prospectos/${p.id}/eliminar"
      style="display:inline"
      onsubmit="return confirm(
        '¿Estás segura de que querés eliminar este prospecto?\\n\\n' +
        'Se eliminará de SM Prospectos junto con su historial.\\n' +
        'Esta acción no elimina el contacto ni la conversación de Chatwoot.\\n\\n' +
        'Esta acción no se puede deshacer.'
      )"
    >
      <button type="submit" class="btn btn-danger">
        <i class="ti ti-trash"></i> Eliminar prospecto
      </button>
    </form>
  `);
}

    // Sección de relevamiento (si existe)
    const relHtml = p.relevamiento_fecha
      ? `
      <div class="detail-section">
        <div class="section-title-row"><i class="ti ti-clipboard-list"></i><span>Relevamiento post-demo</span>
          <span class="section-meta">por ${esc(p.relevamiento_por_nombre)} · ${new Date(p.relevamiento_fecha).toLocaleDateString("es-AR")}</span>
        </div>
        <div class="detail-grid">
          <div class="detail-item"><span class="detail-label">Módulos de interés</span><span class="detail-val">${(p.modulos || []).join(", ") || "—"}</span></div>
          <div class="detail-item"><span class="detail-label">Sistema actual</span><span class="detail-val">${esc(p.sistema_actual || "—")} ${p.tiempo_sistema ? "(" + esc(p.tiempo_sistema) + ")" : ""}</span></div>
          <div class="detail-item"><span class="detail-label">Problema sistema actual</span><span class="detail-val">${esc(p.problema_sistema || "—")}</span></div>
          <div class="detail-item"><span class="detail-label">Necesidades especiales</span><span class="detail-val">${esc(p.necesidades || "—")}</span></div>
          <div class="detail-item"><span class="detail-label">Cant. productos</span><span class="detail-val">${esc(p.cant_productos || "—")}</span></div>
          <div class="detail-item"><span class="detail-label">Volumen ventas</span><span class="detail-val">${esc(p.cant_ventas || "—")}</span></div>
          <div class="detail-item"><span class="detail-label">Equipamiento</span><span class="detail-val">${(p.equipamiento || []).join(", ") || "—"} ${p.equip_observaciones ? "— " + esc(p.equip_observaciones) : ""}</span></div>
          <div class="detail-item"><span class="detail-label">Nivel de interés</span><span class="detail-val">
            ${{ alto: "🔥 Alto", medio: "👀 Medio", bajo: "❄️ Bajo" }[p.nivel_interes] || "—"}
          </span></div>
          <div class="detail-item full"><span class="detail-label">Objeciones detectadas</span><span class="detail-val">${formatObjeciones(p.objeciones)}</span></div>
          ${p.obj_detalle ? `<div class="detail-item full"><span class="detail-label">Detalle objeciones</span><span class="detail-val">${esc(p.obj_detalle)}</span></div>` : ""}
          <div class="detail-item full"><span class="detail-label">Observaciones generales</span><span class="detail-val">${esc(p.obs_generales || "—")}</span></div>
        </div>
      </div>
    `
      : p.estado !== "prospecto" && p.estado !== "sin_respuesta"
        ? `
      <div class="detail-section empty-section">
        <i class="ti ti-clipboard"></i>
        <span>El relevamiento post-demo aún no fue cargado.</span>
        <a href="/prospectos/${p.id}/relevamiento" class="btn btn-primary btn-SM"><i class="ti ti-plus"></i> Cargar ahora</a>
      </div>
    `
        : "";

    // Historial
    const eventosEstado = historial.rows
      .map(
        (h) => ({ fecha: new Date(h.fecha).getTime(), html: `
      <div class="hist-item">
        <div class="hist-dot ${ESTADOS_COLOR[h.estado_nuevo] || "gray"}"></div>
        <div class="hist-body">
          <span class="hist-estado">${ESTADOS_LABEL[h.estado_nuevo] || h.estado_nuevo}</span>
<span class="hist-meta">${h.usuario_nombre || "Automatización"} · ${new Date(h.fecha).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>        ${
          h.nota
            ? `<span class="hist-nota">${esc(h.nota)}</span>`
            : h.estado_nuevo === "perdido" && p.motivo_perdida
              ? `<span class="hist-nota">Motivo de pérdida: ${esc(p.motivo_perdida)}</span>`
              : ""
        }
        </div>
      </div>
    `}),
      );
    const eventosCRM = gestionesCRM.rows.map(g => ({ fecha: new Date(g.creado_en).getTime(), html: `
      <div class="hist-item">
        <div class="hist-dot blue"></div>
        <div class="hist-body">
          <span class="hist-estado">Seguimiento comercial</span>
          <span class="hist-meta">${esc(g.usuario_nombre || "Equipo comercial")} · ${new Date(g.creado_en).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
          <span class="hist-nota">${esc(g.gestion_realizada)}</span>
          ${g.proxima_accion ? `<span class="hist-nota">Próximo paso: ${esc(g.proxima_accion)} · ${new Date(g.vence_en).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} ${g.recordatorio ? "⏰" : ""}</span>` : ""}
        </div>
      </div>` }));
    const histHtml = [...eventosEstado, ...eventosCRM].sort((a, b) => a.fecha - b.fecha)
      .map(e => e.html).join("");

    const resultadoAccion = req.session.resultadoAccion || null;
    delete req.session.resultadoAccion;

    res.send(
      layout(
        p.contacto || p.nombre_negocio || "Prospecto",
        `
        ${renderResultadoAccion(resultadoAccion)}
        ${req.query.seguimiento === "ok" ? '<div class="crm-notice crm-success"><i class="ti ti-circle-check"></i> Gestión registrada en el historial. Si definiste una próxima acción, también quedó en la agenda.</div>' : ''}

        <div class="page-header">
        <div>
          <a href="/panel" class="back-link"><i class="ti ti-arrow-left"></i> Volver al panel</a>
          <h1 class="page-title">${esc(p.contacto || "Sin nombre")}</h1>
          <p class="page-sub">${p.nombre_negocio ? esc(p.nombre_negocio) + " · " : ""}${p.telefono ? esc(p.telefono) : ""}${p.email ? " · " + esc(p.email) : ""}</p>
        </div>
        <div class="header-actions">
          <span class="badge-estado ${est} lg">${estadoLabel}</span>
          ${acciones.join("")}
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-main">
          <div class="detail-section">
            <div class="section-title-row"><i class="ti ti-user"></i><span>Datos del prospecto</span>
              <span class="section-meta">cargado por ${esc(p.creado_por_nombre || "—")}</span>
            </div>
              <div class="detail-grid">

                <div class="detail-item">
                  <span class="detail-label">Nombre</span>
                  <span class="detail-val">${esc(p.contacto || "—")}</span>
                </div>

                <div class="detail-item">
                  <span class="detail-label">Negocio</span>
                  <span class="detail-val">${esc(p.nombre_negocio || "—")}</span>
                </div>
              
              <div class="detail-item"><span class="detail-label">Rubro</span><span class="detail-val">${esc(p.rubro || "—")}${p.rubro_otro ? " (" + esc(p.rubro_otro) + ")" : ""}</span></div>
              <div class="detail-item"><span class="detail-label">Teléfono</span><span class="detail-val">${esc(p.telefono || "—")}</span></div>
              <div class="detail-item"><span class="detail-label">Email</span><span class="detail-val">${esc(p.email || "—")}</span></div>
              <div class="detail-item"><span class="detail-label">Origen</span><span class="detail-val">${
              {
                manual: "Manual",
                meta: "📱 Meta",
                google: "🔎 Google",
                web: "🌐 Web",
                otro: "❔ Sin identificar",
                "prospecto-interno": "🤝 Referido / Interno"
              }           
                [p.origen] || "—"}</span></div>
              ${p.nota_prospecto ? `<div class="detail-item full"><span class="detail-label">Notas</span><span class="detail-val">${esc(p.nota_prospecto)}</span></div>` : ""}              ${p.demo_fecha ? `<div class="detail-item"><span class="detail-label">Demo agendada</span><span class="detail-val">${new Date(p.demo_fecha).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })} — ${esc(p.demo_resp_nombre || "—")}${p.zoom_join_url ? ` — <a href="${p.zoom_join_url}" target="_blank">Entrar a la reunión <i class="ti ti-external-link"></i></a>` : ""}</span></div>` : ""}
              ${
                !["confirmado", "perdido"].includes(p.estado)
                  ? `
                    <div class="detail-item">
                      <span class="detail-label">Próxima acción</span>
                      <span class="detail-val">${esc(pasoPorEstado(p.estado, p.demo_fecha).accion || "—")}</span>
                    </div>
                  `
                  : ""
              }

              <div class="detail-item">
                <span class="detail-label">Responsable</span>
                <span class="detail-val">${esc(responsableActualNombre)}</span>
              </div>
            </div>
            ${
              p.plan_ofrecido
                ? `
                  <div class="detail-section">
                    <div class="section-title-row">
                      <i class="ti ti-package"></i>
                      <span>Plan ofrecido</span>
                    </div>

                    <div class="detail-grid">
                      <div class="detail-item">
                        <span class="detail-label">Plan</span>
                        <span class="detail-val">${esc(p.plan_ofrecido)}</span>
                      </div>
                    </div>
                  </div>
                `
                : ""
            }

          ${seguimientosHtml}
          ${relHtml}

          ${
            p.estado === "confirmado"
              ? `
          <div class="detail-section confirmado-section">
            <div class="section-title-row"><i class="ti ti-check-circle"></i><span>Cliente confirmado</span></div>
            <div class="detail-grid">
              ${p.modulos_contratados?.length ? `<div class="detail-item full"><span class="detail-label">Módulos contratados</span><span class="detail-val">${p.modulos_contratados.join(", ")}</span></div>` : ""}
              ${p.condiciones_comerciales ? `<div class="detail-item full"><span class="detail-label">Condiciones comerciales</span><span class="detail-val">${esc(p.condiciones_comerciales)}</span></div>` : ""}
            </div>
          </div>`
              : ""
          }
        </div>

        <div class="detail-sidebar">
          <div class="detail-section">
            <div class="section-title-row"><i class="ti ti-history"></i><span>Historial</span></div>
            <div class="historial">${histHtml}</div>
          </div>
        </div>
      </div>

            <div id="modal-perdido-detalle" class="modal-perdido-overlay">
        <div class="modal-perdido-box">

          <div class="section-title-row">
            <i class="ti ti-x-circle"></i>
            <span>Marcar como perdido</span>
            <p style="margin:8px 0 16px;color:#6b7280;font-size:14px;line-height:1.45">
              Esta acción cambiará el estado del prospecto a <strong>PERDIDO</strong>
              y registrará el motivo seleccionado.
              <br><br>
              <strong>No se enviará ningún mensaje automático al cliente.</strong>
            </p>
          </div>

          <form method="POST" action="/prospectos/${p.id}/estado">

            <input type="hidden" name="estado" value="perdido">

            <div class="field">
              <label>Motivo de pérdida</label>

              <select
                name="motivo_perdida"
                id="motivo-perdida-detalle"
                required
                onchange="actualizarOtroPerdida()"
              >
                <option value="">Seleccionar...</option>
                <option value="Sin respuesta">Sin respuesta</option>
                <option value="Económico">Económico</option>
                <option value="Eligió otro sistema">Eligió otro sistema</option>
                <option value="Falta de tiempo">Falta de tiempo</option>
                <option value="Otro">Otro</option>
              </select>
            </div>

            <div
              class="field"
              id="motivo-perdida-otro-wrap"
              style="display:none"
            >
              <label>Aclarar motivo</label>

              <input
                type="text"
                name="motivo_perdida_otro"
                id="motivo-perdida-otro"
                placeholder="Indicá el motivo..."
              >
            </div>

            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">

              <button
                type="button"
                class="btn btn-ghost"
                onclick="cerrarModalPerdido()"
              >
                Cancelar
              </button>

              <button type="submit" class="btn btn-danger">
                <i class="ti ti-x"></i>
                Marcar como perdido
              </button>

            </div>

          </form>
        </div>
      </div>

      <style>
        .badge-estado.yellow { background:#fef9c3; color:#854d0e; }
        .hist-dot.yellow { background:#eab308; }

        .detail-layout {
        display: grid !important;
        grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr) !important;
        gap: 20px !important;
        align-items: start !important;
      }

      .detail-main,
      .detail-sidebar {
        min-width: 0;
      }

      .detail-sidebar {
        position: sticky;
        top: 20px;
      }

      .modal-perdido-overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, .45);
        z-index: 2000;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }

      .modal-perdido-overlay.open {
        display: flex;
      }

      .modal-perdido-box {
        background: white;
        width: 100%;
        max-width: 440px;
        padding: 24px;
        border-radius: 10px;
        box-shadow: 0 15px 45px rgba(0, 0, 0, .20);
      }

      .modal-perdido-box .field {
        margin-top: 14px;
      }

      .modal-perdido-box select,
      .modal-perdido-box input {
        width: 100%;
      }

      @media (max-width: 900px) {
        .detail-layout {
          grid-template-columns: 1fr !important;
        }

        .detail-sidebar {
          position: static;
        }
      }

      </style>


      <script>
        function abrirModalPerdido() {
          const modal = document.getElementById('modal-perdido-detalle');

          document.getElementById('motivo-perdida-detalle').value = '';
          document.getElementById('motivo-perdida-otro').value = '';

          actualizarOtroPerdida();

          modal.classList.add('open');
        }

        function cerrarModalPerdido() {
          document
            .getElementById('modal-perdido-detalle')
            .classList.remove('open');
        }

        function actualizarOtroPerdida() {
          const motivo =
            document.getElementById('motivo-perdida-detalle').value;

          const wrap =
            document.getElementById('motivo-perdida-otro-wrap');

          const input =
            document.getElementById('motivo-perdida-otro');

          const esOtro = motivo === 'Otro';

          wrap.style.display = esOtro ? 'block' : 'none';
          input.required = esOtro;
        }
      </script>

    `,
        req,
      ),
    );
  } catch (err) {
    console.error(err);
    res.status(500).send("Error interno");
  }
});

// ─── REASIGNACIÓN MANUAL DE CONVERSACIÓN CHATWOOT ───────────────────────────
async function reasignarConversacionVentas(req, res) {
  const conversationId = Number(req.body.chatwoot_conversation_id);
  const assigneeId = Number(req.body.chatwoot_agent_id);
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0 || !Number.isSafeInteger(assigneeId) || assigneeId <= 0) {
    return res.status(400).send("Conversación o vendedor no válido");
  }

  const urlBot = (process.env.SALES_BOT_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.SALES_BOT_API_KEY;
  if (!urlBot || !apiKey) {
    return res.status(503).send("Faltan SALES_BOT_BASE_URL y SALES_BOT_API_KEY en Railway. No se cambió la asignación.");
  }
  try {
    const { data } = await axios.post(`${urlBot}/api/internal/sales/manual-reassign`,
      { conversationId, assigneeId,
        requestedBy: String(req.session.usuario.nombre || "Administración").slice(0, 120) },
      { headers: { "x-api-key": apiKey, "content-type": "application/json" }, timeout: 20000 });
    const textos = [
      { ok: true, texto: `Chatwoot: conversación #${conversationId} asignada a ${data.newAssigneeName}` },
      { ok: !!data.prospectosSynced, texto: data.prospectosSynced ? "Sincronizado con Prospectos" : "Sincronización pendiente o no existe prospecto vinculado" },
      { ok: !!data.groupNotified || !data.changed, texto: !data.changed ? "Ya estaba asignado, no se duplicó el aviso" : data.groupNotified ? "Aviso enviado al vendedor" : "Aviso pendiente de entrega individual" },
      { ok: !!data.privateNoteSaved || !data.changed, texto: !data.changed ? "No se duplicó nota" : data.privateNoteSaved ? "Nota interna guardada" : "Falló la nota interna" }
    ];
    guardarResultadoAccion(req, "Reasignación manual de Ventas", textos);
    const prospecto = Number(req.body.prospecto_id);
    return res.redirect(Number.isSafeInteger(prospecto) && prospecto > 0
      ? `/prospectos/${prospecto}` : "/control");
  } catch (error) {
    const detalle = error.response?.data?.error || error.message;
    console.error("Error reasignando conversación de ventas:", detalle);
    return res.status(502).send(`No se pudo confirmar la reasignación: ${esc(detalle)}. Revisá Chatwoot antes de repetir.`);
  }
}
router.post("/ventas/reasignar", requireAuth, requireRol("admin"), reasignarConversacionVentas);

// ─── CAMBIAR RESPONSABLE (SOLO ADMIN) ────────────────────────────────────────

router.post(
  "/prospectos/:id/responsable",
  requireAuth,
  requireRol("admin"),
  async (req, res) => {
    const prospectoId = Number(req.params.id);
    const responsableId = Number(req.body.responsable_id);

    if (!Number.isInteger(prospectoId) || prospectoId <= 0) {
      return res.status(400).send("Prospecto no válido");
    }

    if (!Number.isInteger(responsableId) || responsableId <= 0) {
      return res.status(400).send("Responsable no válido");
    }

    const { rows: linked } = await pool.query(
      'SELECT chatwoot_conversation_id FROM prospectos WHERE id=$1', [prospectoId]);
    if (linked[0]?.chatwoot_conversation_id) {
      const chatwootAgentId = Number(Object.keys(AGENTE_CHATWOOT_ID).find(
        agentId => Number(AGENTE_CHATWOOT_ID[agentId]) === responsableId));
      req.body.chatwoot_conversation_id = linked[0].chatwoot_conversation_id;
      req.body.chatwoot_agent_id = chatwootAgentId;
      req.body.prospecto_id = prospectoId;
      return reasignarConversacionVentas(req, res);
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { rows: prospectos } = await client.query(
        `
        SELECT
          p.id,
          p.estado,
          p.creado_por,
          p.demo_responsable,
          uc.nombre AS creado_por_nombre,
          ud.nombre AS demo_responsable_nombre
        FROM prospectos p
        LEFT JOIN usuarios uc
          ON uc.id = p.creado_por
        LEFT JOIN usuarios ud
          ON ud.id = p.demo_responsable
        WHERE p.id = $1
        FOR UPDATE OF p
      `,
        [prospectoId],
      );

      if (!prospectos.length) {
        await client.query("ROLLBACK");
        return res.status(404).send("Prospecto no encontrado");
      }

      const actual = prospectos[0];

      const { rows: responsables } = await client.query(
        `
        SELECT id, nombre, rol
        FROM usuarios
        WHERE id = $1
          AND activo = true
          AND rol IN ('soporte', 'admin', 'vendedor')
        LIMIT 1
      `,
        [responsableId],
      );

      if (!responsables.length) {
        await client.query("ROLLBACK");

        return res
          .status(400)
          .send("El responsable seleccionado no es válido o está inactivo");
      }

      const nuevoResponsable = responsables[0];

      const tieneResponsableDemo = actual.demo_responsable !== null;

      const responsableAnteriorId = tieneResponsableDemo
        ? actual.demo_responsable
        : actual.creado_por;

      const responsableAnteriorNombre = tieneResponsableDemo
        ? actual.demo_responsable_nombre
        : actual.creado_por_nombre;

      if (Number(responsableAnteriorId) === responsableId) {
        await client.query("ROLLBACK");
        return res.redirect("/prospectos/" + prospectoId);
      }

      if (tieneResponsableDemo) {
        await client.query(
          `
          UPDATE prospectos
          SET
            demo_responsable = $1,
            actualizado_en = NOW()
          WHERE id = $2
        `,
          [responsableId, prospectoId],
        );
      } else {
        await client.query(
          `
          UPDATE prospectos
          SET
            creado_por = $1,
            actualizado_en = NOW()
          WHERE id = $2
        `,
          [responsableId, prospectoId],
        );
      }

      const nota = `Responsable cambiado de ${
        responsableAnteriorNombre || "Sin asignar"
      } a ${nuevoResponsable.nombre}`;

      await client.query(
        `
        INSERT INTO historial_estados
          (
            prospecto_id,
            estado_anterior,
            estado_nuevo,
            usuario_id,
            nota
          )
        VALUES ($1, $2, $2, $3, $4)
      `,
        [prospectoId, actual.estado, req.session.usuario.id, nota],
      );

      await client.query("COMMIT");

      return res.redirect("/prospectos/" + prospectoId);
    } catch (err) {
      await client.query("ROLLBACK");

      console.error("Error al cambiar responsable:", err);

      return res.status(500).send("Error al cambiar responsable");
    } finally {
      client.release();
    }
  },
);

// REPROGRAMAR DEMO

router.post("/prospectos/:id/reprogramar-demo", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT id, estado, demo_fecha, google_event_id, demo_tipo
      FROM prospectos
      WHERE id = $1
      FOR UPDATE
      `,
      [req.params.id],
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).send("Prospecto no encontrado");
    }

    const prospecto = rows[0];

    if (prospecto.estado !== "demo_coordinada") {
      await client.query("ROLLBACK");

      return res.status(409).send(`
        <script>
          alert('Este prospecto ya no tiene una demo coordinada para reprogramar.');
          window.location.href = '/prospectos/${req.params.id}';
        </script>
      `);
    }

    const fechaAnterior = prospecto.demo_fecha
      ? new Date(prospecto.demo_fecha).toLocaleString("es-AR", {
          timeZone: "America/Argentina/Buenos_Aires",
        })
      : "sin fecha registrada";

    await client.query(
      `
      UPDATE prospectos
      SET
        estado = 'prospecto',
        demo_fecha = NULL,
        demo_responsable = NULL,
        zoom_join_url = NULL,
        demo_tipo = NULL,
        google_event_id = NULL,
        demo_solicitud = NULL,
        recordatorio_enviado = FALSE,
        recordatorio_relevamiento_enviado = FALSE,
        actualizado_en = NOW()
      WHERE id = $1
      `,
      [req.params.id],
    );

    await client.query(
      `
      INSERT INTO historial_estados
        (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
      VALUES ($1, 'demo_coordinada', 'prospecto', $2, $3)
      `,
      [
        req.params.id,
        req.session.usuario.id,
        `Demo cancelada. Pendiente de reprogramación. Fecha anterior: ${fechaAnterior}`,
      ],
    );

    await client.query("COMMIT");
    // No cancelar los eventos recurrentes grupales compartidos con otros clientes.
    if (prospecto.google_event_id) {
      await cancelarReunionMeet(prospecto.google_event_id).catch(error => {
        console.error('[MEET] Evento personalizado cancelado en ficha pero no en Calendar',prospecto.google_event_id,error.message);
      });
    }

    res.redirect(`/prospectos/${req.params.id}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error reprogramando demo:", err);
    res.status(500).send("No se pudo reprogramar la demo");
  } finally {
    client.release();
  }
});

// ─── COORDINAR DEMO ───────────────────────────────────────────────────────────
router.get("/prospectos/:id/demo", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM prospectos WHERE id=$1", [
    req.params.id,
  ]);

  if (!rows.length) return res.status(404).send("No encontrado");

  const p = rows[0];

  const { rows: responsablesDemo } = await pool.query(`
    SELECT id, nombre
    FROM usuarios
    WHERE activo = true
      AND rol IN ('soporte','admin','vendedor')
    ORDER BY nombre
  `);

  res.send(
    layout(
      "Coordinar demo",
      `
    <div class="page-header">
      <div>
        <a href="/prospectos/${p.id}" class="back-link"><i class="ti ti-arrow-left"></i> Volver</a>
        <h1 class="page-title">Coordinar demo</h1>
        <p class="page-sub">${esc(p.contacto || p.nombre_negocio || "Sin nombre")}</p>
      </div>
    </div>
    <div class="form-card">
    <form
      method="POST"
      action="/prospectos/${p.id}/demo"
      onsubmit="return confirm(
        '¿Confirmás que querés coordinar esta demostración?\\n\\n' +
        'Al continuar:\\n' +
        '• El prospecto pasará a estado DEMO COORDINADA.\\n' +
        '• Se creará la reunión de Zoom.\\n' +
        '• Se enviará al cliente la confirmación de la demo con la fecha y hora.\\n' +
        'Por favor. Verificá especialmente la fecha, hora y responsable antes de continuar.'
      )"
    >        
    <div class="form-section">
          <div class="section-title-row"><i class="ti ti-calendar-event"></i><span>Fecha y hora de la demo</span></div>
          <div class="grid2">
            <div class="field">
              <label for="demo_fecha">Fecha y hora <span class="req">*</span></label>
              <input type="datetime-local" id="demo_fecha" name="demo_fecha" required>
            </div>
            <div class="field">
              <label for="demo_responsable_id">
                Responsable de la demo <span class="req">*</span>
              </label>

              <select
                id="demo_responsable_id"
                name="demo_responsable_id"
                required
              >
                ${responsablesDemo
                  .map(
                    (u) => `
                  <option
                    value="${u.id}"
                    ${Number(u.id) === Number(p.creado_por) ? "selected" : ""}
                  >
                    ${esc(u.nombre)}
                  </option>
                `,
                  )
                  .join("")}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="nota_demo">Nota para el equipo</label>
            <textarea id="nota_demo" name="nota_demo" placeholder="Plataforma, link de Meet, consideraciones especiales..."></textarea>
          </div>
        </div>
        <div class="form-actions">
          <a href="/prospectos/${p.id}" class="btn btn-ghost">Cancelar</a>
          <button type="submit" class="btn btn-primary"><i class="ti ti-calendar-plus"></i> Registrar demo</button>
        </div>
      </form>
    </div>
  `,
      req,
    ),
  );
});

router.post("/prospectos/:id/demo", requireAuth, async (req, res) => {
  const { demo_fecha, nota_demo, demo_responsable_id } = req.body;

  try {
    const { rows } = await pool.query("SELECT * FROM prospectos WHERE id=$1", [
      req.params.id,
    ]);

    const prospecto = rows[0];

    if (!prospecto) {
      return res.status(404).send("Prospecto no encontrado");
    }

    if (!["prospecto", "sin_respuesta"].includes(prospecto.estado)) {
      return res.status(409).send(`
        <script>
          alert('Este prospecto cambió de estado y la demo no puede volver a coordinarse desde esta pantalla.');
          window.location.href = '/prospectos/${req.params.id}';
        </script>
      `);
    }

    const responsableId = Number(demo_responsable_id);

    if (!responsableId) {
      return res
        .status(400)
        .send("Debe seleccionar un responsable para la demo");
    }

    const { rows: responsableRows } = await pool.query(
      "SELECT id, nombre FROM usuarios WHERE id=$1 AND activo=true",
      [responsableId],
    );

    if (!responsableRows.length) {
      return res.status(400).send("Responsable no válido");
    }

    const nombreResponsable = responsableRows[0].nombre;

    // Guardar la demo SIEMPRE, independientemente de Zoom
    await pool.query(
      `
      UPDATE prospectos
      SET estado='demo_coordinada',
          demo_fecha=$1,
          demo_responsable=$2,
          zoom_join_url=NULL,
          actualizado_en=NOW()
      WHERE id=$3
    `,
      [demo_fecha, responsableId, req.params.id],
    );

    await pool.query(
      `
      INSERT INTO historial_estados
        (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
      VALUES ($1,'prospecto','demo_coordinada',$2,$3)
    `,
      [req.params.id, req.session.usuario.id, nota_demo || "Demo coordinada"],
    );

    console.log(
      "DEBUG demo_fecha:",
      demo_fecha,
      "| responsableId:",
      responsableId,
      "| responsable:",
      nombreResponsable,
    );

    // ---------------------------------------------------------
    // 1. Intentar crear Zoom
    // Si falla, NO interrumpir el resto del proceso.
    // ---------------------------------------------------------

const resultados = [
  {
    ok: true,
    texto: "La demo quedó registrada como coordinada.",
  },
];

    let joinUrl = null;
    let zoomError = null;

    const zoomEmail = AGENTE_ZOOM[responsableId];

    // ---------------------------------------------------------
    // 1. CREAR REUNIÓN DE ZOOM
    // ---------------------------------------------------------

    if (zoomEmail) {
      try {
        const nombreParaZoom =
          prospecto.nombre_negocio ||
          prospecto.contacto ||
          "Prospecto";

        joinUrl = await crearReunionZoom(
          zoomEmail,
          `Demo ${nombreParaZoom}`,
          demo_fecha,
        );

        await pool.query(
          "UPDATE prospectos SET zoom_join_url=$1 WHERE id=$2",
          [joinUrl, req.params.id],
        );

        console.log("DEBUG reunión Zoom creada:", joinUrl);

        resultados.push({
          ok: true,
          texto: "La reunión de Zoom fue creada correctamente.",
        });
      } catch (zoomErr) {
        zoomError =
          zoomErr.response?.data?.message ||
          zoomErr.response?.data?.reason ||
          zoomErr.message ||
          "Error desconocido";

        console.error(
          "ERROR creando reunión Zoom. Se continuará sin link:",
          zoomErr.response?.data || zoomErr.message,
        );

        resultados.push({
          ok: false,
          texto: `No se pudo crear la reunión de Zoom: ${zoomError}`,
        });

        await alertarResponsableError(
          responsableId,
          "Error al crear la reunión de Zoom",
          prospecto,
          `La demo quedó registrada para ${formatearFechaAR(demo_fecha)}, pero no se pudo crear la reunión de Zoom.\n\nError: ${zoomError}`,
        );
      }
    } else {
      zoomError =
        `El responsable ${nombreResponsable} no tiene una cuenta de Zoom configurada`;

      console.error("ERROR:", zoomError);

      resultados.push({
        ok: false,
        texto: zoomError,
      });

      await alertarResponsableError(
        responsableId,
        "Error al crear la reunión de Zoom",
        prospecto,
        `La demo quedó registrada para ${formatearFechaAR(demo_fecha)}, pero no se pudo crear la reunión porque el responsable no tiene una cuenta de Zoom configurada.`,
      );
    }

    const fechaFormateada = formatearFechaAR(demo_fecha);

    // ---------------------------------------------------------
    // 2. MENSAJE AUTOMÁTICO AL CLIENTE
    // ---------------------------------------------------------

    try {
      const mensaje = joinUrl
        ? `*Msj automático*

    ¡Todo listo! 😊

    Te dejamos el link para unirte a la demostración agendada para el día ${fechaFormateada}. 🎥

    🔗 ${joinUrl}

    💻 Te recomendamos conectarte desde una computadora, con audio y micrófono habilitados.`
        : `*Msj automático*

    ¡Todo listo! 😊

    Tu demostración quedó agendada para el día ${fechaFormateada}. 🎥

    El equipo se pondrá en contacto con vos para realizar la demostración.

    💻 Te recomendamos conectarte desde una computadora, con audio y micrófono habilitados.`;

      const enviado = await enviarPorChatwoot(
        prospecto.telefono,
        mensaje,
        responsableId,
      );

      console.log(
        "DEBUG mensaje de demo enviado:",
        enviado,
        "| conZoom:",
        Boolean(joinUrl),
      );

      if (enviado) {
        resultados.push({
          ok: true,
          texto: joinUrl
            ? "Se envió al cliente la confirmación con el link de Zoom."
            : "Se envió al cliente la confirmación de la demo sin link de Zoom.",
        });
          } else {
            resultados.push({
              ok: false,
              texto: "No se pudo enviar el mensaje automático al cliente.",
            });

            await alertarResponsableError(
              responsableId,
              "No se pudo enviar la invitación",
              prospecto,
              `La demo quedó coordinada para ${fechaFormateada}, pero no se pudo enviar el mensaje automático al contacto.`,
            );
          }
    } catch (msgErr) {
      console.error(
        "ERROR enviando mensaje de demo por Chatwoot:",
        msgErr.response?.data || msgErr.message,
      );

      resultados.push({
        ok: false,
        texto:
          `No se pudo enviar el mensaje automático al cliente: ` +
          `${
            msgErr.response?.data?.message ||
            msgErr.message ||
            "Error de Chatwoot"
          }`,
      });

      await alertarResponsableError(
        responsableId,
        "No se pudo enviar la invitación",
        prospecto,
        `La demo quedó coordinada para ${fechaFormateada}, pero falló el envío del mensaje automático al contacto.`,
      );
    }

    // ---------------------------------------------------------
    // 3. AVISO AL GRUPO
    // ---------------------------------------------------------

    try {
      const nombreParaGrupo =
        prospecto.nombre_negocio ||
        prospecto.contacto ||
        `Prospecto #${req.params.id}`;

      const linkProspecto =
        `${process.env.APP_URL}/prospectos/${req.params.id}`;

      let mensajeGrupo =
        `📅 Nueva demo coordinada: *${nombreParaGrupo}*\n\n` +
        `📆 ${fechaFormateada}\n` +
        `👤 Responsable: ${nombreResponsable}\n` +
        `📞 Tel: ${prospecto.telefono || "—"}\n`;

      if (joinUrl) {
        mensajeGrupo += `🎥 Zoom: ${joinUrl}\n`;
      } else {
        mensajeGrupo +=
          `⚠️ Zoom: NO SE PUDO CREAR` +
          `${zoomError ? ` — ${zoomError}` : ""}\n`;
      }

      mensajeGrupo +=
        `\n👉 Ver prospecto: ${linkProspecto}`;

      const avisoEnviado =
        await enviarAvisoInterno(mensajeGrupo, await vendedorAsignado(prospecto));

      if (avisoEnviado) {
        resultados.push({
          ok: true,
          texto: "Se envió el aviso de la demo al vendedor responsable.",
        });
      } else {
        resultados.push({
          ok: false,
          texto: "No se pudo enviar el aviso al vendedor responsable.",
        });
      }
    } catch (avisoErr) {
      console.error(
        "ERROR enviando aviso individual de demo:",
        avisoErr.response?.data || avisoErr.message,
      );

      resultados.push({
        ok: false,
        texto:
          `No se pudo enviar el aviso al responsable: ` +
          `${
            avisoErr.response?.data?.message ||
            avisoErr.message ||
            "Error de Chatwoot"
          }`,
      });
    }

    guardarResultadoAccion(
      req,
      resultados.some((r) => !r.ok)
        ? "Demo coordinada con observaciones"
        : "Demo coordinada correctamente",
      resultados,
    );

    res.redirect("/prospectos/" + req.params.id);
  } catch (err) {
    console.error("ERROR coordinando demo:", err);
    res.status(500).send("Error al guardar");
  }
});

// ─── RELEVAMIENTO POST-DEMO ───────────────────────────────────────────────────
router.get("/prospectos/:id/relevamiento", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM prospectos WHERE id=$1", [
    req.params.id,
  ]);
  if (!rows.length) return res.status(404).send("No encontrado");
  const p = rows[0];

  const MODULOS = [
    "Productos / stock",
    "Ventas / POS",
    "Compras",
    "Cuentas corrientes",
    "Facturación electrónica",
    "Promociones por cantidad",
    "Tienda online",
    "Green Points (fidelización)",
    "Reportes / contabilidad",
  ];
  const EQUIPOS = [
    "Balanza con impresora",
    "Impresora de tickets",
    "Lectora de código de barras",
    "Multi-PC / red local",
    "Tablet / móvil",
    "Cajón de dinero",
  ];
  const OBJECIONES = [
    "Precio / presupuesto",
    "Resistencia al cambio",
    "Necesita evaluar con socio / familiar",
    "Dudas sobre migración de datos",
    "Funcionalidad faltante / específica",
    "Soporte / capacitación",
  ];

  res.send(
    layout(
      "Relevamiento",
      `
    <div class="page-header">
      <div>
        <a href="/prospectos/${p.id}" class="back-link"><i class="ti ti-arrow-left"></i> Volver</a>
        <h1 class="page-title">Relevamiento post-demo</h1>
        <p class="page-sub">${esc(p.contacto || p.nombre_negocio || "Sin nombre")} · Área Soporte</p>
      </div>
    </div>
    <div class="form-card">
    <form
      method="POST"
      action="/prospectos/${p.id}/relevamiento"
      onsubmit="return confirm(
        '¿La demostración YA FUE REALIZADA y querés guardar el relevamiento?\\n\\n' +
        'IMPORTANTE: esta acción debe realizarse únicamente después de haber dado la demo.\\n\\n' +
        'Al continuar:\\n' +
        '• El prospecto pasará a estado DEMO REALIZADA.\\n' +
        '• Se registrará el relevamiento como completado.\\n' +
        '• Se enviará automáticamente al cliente un mensaje agradeciendo su participación y la documentación del sistema.\\n' +
        '• Se avisará al vendedor responsable por WhatsApp.\\n\\n' +
        '¿Confirmás que la demo ya fue realizada?'
      )"
    >
        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-building-store"></i><span>Rubro del negocio</span><span class="badge-req">obligatorio</span></div>
          <div class="chips-group">
            ${[
              "Dietética",
              "Almacén / minimercado",
              "Carnicería",
              "Pollería",
              "Pet Shop",
              "Forrajería",
              "Fiambrería",
              "Mayorista",
              "Otro",
            ]
              .map(
                (r) =>
                  `<label class="chip-label"><input type="radio" name="rubro" value="${r}" ${p.rubro === r ? "checked" : ""}><span class="chip">${r}</span></label>`,
              )
              .join("")}
          </div>
          <div class="field" style="margin-top:10px">
            <label>Especificar si es otro</label>
            <input type="text" name="rubro_otro" value="${esc(p.rubro_otro || "")}">
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-star"></i><span>Módulos de interés</span><span class="badge-opc">opcional</span></div>
          <div class="chips-group multi">
            ${MODULOS.map(
              (m) =>
                `<label class="chip-label"><input type="checkbox" name="modulos" value="${m}"><span class="chip">${m}</span></label>`,
            ).join("")}
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-device-desktop"></i><span>Sistema actual</span><span class="badge-opc">opcional</span></div>
          <div class="grid2">
            <div class="field">
              <label>¿Qué sistema usa hoy?</label>
              <input type="text" name="sistema_actual" value="${esc(p.sistema_actual || "")}" placeholder="Ej: Excel, Tango, ninguno...">
            </div>
            <div class="field">
              <label>¿Hace cuánto lo usa?</label>
              <input type="text" name="tiempo_sistema" value="${esc(p.tiempo_sistema || "")}" placeholder="Ej: 2 años">
            </div>
          </div>
          <div class="field">
            <label>¿Qué problema tiene con el sistema actual?</label>
            <textarea name="problema_sistema" placeholder="No maneja granel, no tiene facturación electrónica...">${esc(p.problema_sistema || "")}</textarea>
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-adjustments"></i><span>Necesidades especiales</span><span class="badge-opt">opcional</span></div>
          <div class="field">
            <label>Requerimientos específicos o particularidades</label>
            <textarea name="necesidades" placeholder="Granel con pesaje, múltiples listas de precio, integración contable...">${esc(p.necesidades || "")}</textarea>
          </div>
          <div class="grid2">
            <div class="field">
              <label>Cantidad estimada de productos</label>
              <input type="text" name="cant_productos" value="${esc(p.cant_productos || "")}" placeholder="Ej: 500, más de 1000...">
            </div>
            <div class="field">
              <label>Volumen de ventas diarias</label>
              <input type="text" name="cant_ventas" value="${esc(p.cant_ventas || "")}" placeholder="Ej: 50 tickets/día">
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-tools"></i><span>Equipamiento disponible</span><span class="badge-opt">opcional</span></div>
          <div class="chips-group multi">
            ${EQUIPOS.map(
              (e) =>
                `<label class="chip-label"><input type="checkbox" name="equipamiento" value="${e}"><span class="chip">${e}</span></label>`,
            ).join("")}
          </div>
          <div class="field" style="margin-top:10px">
            <label>Observaciones sobre el equipamiento</label>
            <input type="text" name="equip_observaciones" value="${esc(p.equip_observaciones || "")}" placeholder="Modelo de balanza, cantidad de PCs, etc.">
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-message-exclamation"></i><span>Objeciones detectadas</span><span class="badge-opt">opcional</span></div>
          ${OBJECIONES.map(
            (obj, idx) => `
            <div class="objecion-row">
              <span class="objecion-label">${esc(obj)}</span>
              <div class="radio-pair">
                <label class="radio-opt si"><input type="radio" name="obj_${idx}" value="si"> Sí</label>
                <label class="radio-opt no"><input type="radio" name="obj_${idx}" value="no"> No</label>
              </div>
            </div>
          `,
          ).join("")}
          <div class="field" style="margin-top:12px">
            <label>Detalle de objeciones</label>
            <textarea name="obj_detalle" placeholder="Describir las objeciones planteadas y cómo se respondieron...">${esc(p.obj_detalle || "")}</textarea>
          </div>
        </div>

                <div class="form-section">
          <div class="section-title-row">
            <i class="ti ti-package"></i>
            <span>Plan ofrecido</span>
            <span class="badge-req">obligatorio</span>
          </div>

          <div class="chips-group">
            ${[
              "Emprendedor",
              "VPlus",
              "VPlus oferta",
              "Professional Plus",
            ]
              .map(
                (plan) => `
                  <label class="chip-label">
                    <input
                      type="radio"
                      name="plan_ofrecido"
                      value="${plan}"
                      ${p.plan_ofrecido === plan ? "checked" : ""}
                      required
                    >
                    <span class="chip">${plan}</span>
                  </label>
                `,
              )
              .join("")}
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-clipboard-check"></i><span>Interés y próximos pasos</span><span class="badge-opt">opcional</span></div>
          <div class="field">
            <label>Nivel de interés del prospecto</label>
            <div class="chips-group">
              <label class="chip-label"><input type="radio" name="nivel_interes" value="alto"><span class="chip">🔥 Alto — listo para avanzar</span></label>
              <label class="chip-label"><input type="radio" name="nivel_interes" value="medio"><span class="chip">👀 Medio — necesita más info</span></label>
              <label class="chip-label"><input type="radio" name="nivel_interes" value="bajo"><span class="chip">❄️ Bajo — no es el momento</span></label>
            </div>
          </div>
          <div class="field">
            <label>Observaciones generales de la demo</label>
            <textarea name="obs_generales" placeholder="Cualquier dato relevante para el área administrativa...">${esc(p.obs_generales || "")}</textarea>
          </div>
        </div>

        <div class="form-actions">
          <a href="/prospectos/${p.id}" class="btn btn-ghost">Cancelar</a>
          <button type="submit" class="btn btn-primary">
            <i class="ti ti-check"></i> Guardar relevamiento
          </button>
        </div>
      </form>
    </div>
    <script>
    // Chips interactivos con inputs radio/checkbox
    document.querySelectorAll('.chip-label input').forEach(input => {
      function sync() {
        const chip = input.nextElementSibling;
        chip.classList.toggle('active', input.checked);
      }
      input.addEventListener('change', () => {
        if (input.type === 'radio') {
          const name = input.name;
          document.querySelectorAll(\`input[name="\${name}"]\`).forEach(i => i.nextElementSibling.classList.remove('active'));
        }
        sync();
      });
      sync();
    });
    </script>
  `,
      req,
    ),
  );
});

router.post("/prospectos/:id/relevamiento", requireAuth, async (req, res) => {
  const b = req.body;
    const PLANES_VALIDOS = [
    "Emprendedor",
    "VPlus",
    "VPlus oferta",
    "Professional Plus",
  ];

  if (!PLANES_VALIDOS.includes(b.plan_ofrecido)) {
    return res.status(400).send("Seleccioná un plan ofrecido válido");
  }
  const OBJECIONES = [
    "Precio / presupuesto",
    "Resistencia al cambio",
    "Necesita evaluar con socio / familiar",
    "Dudas sobre migración de datos",
    "Funcionalidad faltante / específica",
    "Soporte / capacitación",
  ];
  const modulos = Array.isArray(b.modulos)
    ? b.modulos
    : b.modulos
      ? [b.modulos]
      : [];
  const equipamiento = Array.isArray(b.equipamiento)
    ? b.equipamiento
    : b.equipamiento
      ? [b.equipamiento]
      : [];
  const objeciones = {};
  OBJECIONES.forEach((obj, idx) => {
    objeciones[obj] = b[`obj_${idx}`] === "si";
  });

  try {
    const { rows: estadoRows } = await pool.query(
      "SELECT estado FROM prospectos WHERE id=$1",
      [req.params.id],
    );

    const estadoAnterior = estadoRows[0]?.estado;

    if (!estadoAnterior) {
      return res.status(404).send("Prospecto no encontrado");
    }

    if (estadoAnterior !== "demo_coordinada") {
      return res.status(400).send(`
            <script>
              alert('No se puede completar el relevamiento porque la demo todavía no figura como coordinada.');
              window.location.href = '/prospectos/${req.params.id}';
            </script>
          `);
    }

    await pool.query(
      `
      UPDATE prospectos SET
        estado = 'demo_realizada',
        rubro = $1, rubro_otro = $2,
        modulos = $3, sistema_actual = $4, tiempo_sistema = $5,
        problema_sistema = $6, necesidades = $7, cant_productos = $8, cant_ventas = $9,
        equipamiento = $10, equip_observaciones = $11,
        objeciones = $12, obj_detalle = $13,
        nivel_interes = $14, obs_generales = $15,
        plan_ofrecido = $16,
        relevamiento_completado_por = $17, relevamiento_fecha = NOW(),
        actualizado_en = NOW()
        WHERE id = $18
    `,
      [
        b.rubro,
        b.rubro_otro,
        modulos,
        b.sistema_actual,
        b.tiempo_sistema,
        b.problema_sistema,
        b.necesidades,
        b.cant_productos,
        b.cant_ventas,
        equipamiento,
        b.equip_observaciones,
        JSON.stringify(objeciones),
        b.obj_detalle,
        b.nivel_interes,
        b.obs_generales,
        b.plan_ofrecido,
        req.session.usuario.id,
        req.params.id,
      ],
    );
    await pool.query(
      `
      INSERT INTO historial_estados
        (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
      VALUES ($1,$2,'demo_realizada',$3,'Relevamiento completado')
    `,
      [req.params.id, estadoAnterior, req.session.usuario.id],
    );

    // ─── Enviar mensaje post-demo con documentación (al cliente) ───
    const resultados = [
      {
        ok: true,
        texto: "El relevamiento quedó guardado y la demo pasó a realizada.",
      },
    ];

    const { rows: prospRows } = await pool.query(
      "SELECT * FROM prospectos WHERE id=$1",
      [req.params.id],
    );

    const p = prospRows[0];
    const demoResponsable = p.demo_responsable;

    const { rows: responsableRows } = await pool.query(
        "SELECT nombre FROM usuarios WHERE id=$1",
        [demoResponsable],
      );

      const nombreResponsableDemo =
        responsableRows[0]?.nombre || "Sin asignar";
    // ---------------------------------------------------------
    // 1. MENSAJE POST-DEMO AL CLIENTE
    // ---------------------------------------------------------

    if (p.telefono) {
      try {
        const mensajePostDemo = `*Msj automático*

    Gracias por asistir a la demostración. 😊

    Te compartimos la documentación para que puedas revisar las normas generales y los requisitos del sistema:

    📄 Normas generales:
    https://sm-soluciones.com/ayuda/docs/temas-comunes/normas-generales/

    ⚙️ Requisitos y recomendaciones de equipo:
    https://sm-soluciones.com/ayuda/docs/temas-comunes/requisitos-y-recomendaciones-para-la-instalacion-%f0%9f%9b%a0%ef%b8%8f/

    Quedamos a disposición ante cualquier consulta.`;

        const enviado = await enviarPorChatwoot(
          p.telefono,
          mensajePostDemo,
          demoResponsable,
        );

        if (enviado) {
          resultados.push({
            ok: true,
            texto:
              "Se envió al cliente el mensaje post-demo con la documentación.",
          });
        } else {
          resultados.push({
            ok: false,
            texto:
              "No se pudo enviar al cliente el mensaje post-demo.",
          });
        }
      } catch (msgErr) {
        console.error(
          "ERROR enviando mensaje post-demo:",
          msgErr.response?.data || msgErr.message,
        );

        resultados.push({
          ok: false,
          texto:
            `No se pudo enviar el mensaje post-demo al cliente: ` +
            `${
              msgErr.response?.data?.message ||
              msgErr.message ||
              "Error de Chatwoot"
            }`,
        });
      }
    } else {
      resultados.push({
        ok: false,
        texto:
          "No se envió el mensaje post-demo porque el prospecto no tiene teléfono.",
      });
    }

    // ---------------------------------------------------------
    // 2. AVISO AL GRUPO
    // ---------------------------------------------------------

    try {
      const nombreParaGrupo =
        p.nombre_negocio ||
        p.contacto ||
        `Prospecto #${req.params.id}`;

      const link =
        `${process.env.APP_URL}/prospectos/${req.params.id}`;

      const mensajeGrupo =
        `📋 Demo realizada: *${nombreParaGrupo}*\n\n` +
        `📞 Tel: ${p.telefono || "—"}\n` +
        `🏬 Rubro: ${p.rubro || "—"}${p.rubro_otro ? ` (${p.rubro_otro})` : ""}\n` +
        `📦 Plan ofrecido: ${p.plan_ofrecido || "—"}\n` +
        `⭐ Módulos: ${(p.modulos || []).join(", ") || "—"}\n` +
        `🛠️ Equipamiento: ${(p.equipamiento || []).join(", ") || "—"}${p.equip_observaciones ? ` — ${p.equip_observaciones}` : ""}\n` +
          `🔥 Interés: ${
          {
            alto: "Alto",
            medio: "Medio",
            bajo: "Bajo",
          }[p.nivel_interes] || "—"
        }\n\n` +
        `👨‍💼 Vendedor a cargo: ${nombreResponsableDemo}\n` +
        `👉 Cerrar cliente: ${link}`;

      const avisoEnviado =
        await enviarAvisoInterno(mensajeGrupo, await vendedorAsignado(p));

      if (avisoEnviado) {
        console.log(
          `✅ Aviso de demo realizada enviado al vendedor: ${req.params.id}`,
        );

        resultados.push({
          ok: true,
          texto: "Se envió el relevamiento al vendedor responsable.",
        });
      } else {
        resultados.push({
          ok: false,
          texto: "No se pudo notificar al vendedor responsable.",
        });
      }
    } catch (msgErr) {
      console.error(
        "ERROR enviando aviso post-relevamiento:",
        msgErr.response?.data || msgErr.message,
      );

      resultados.push({
        ok: false,
        texto:
          `No se pudo enviar el relevamiento al vendedor: ` +
          `${
            msgErr.response?.data?.message ||
            msgErr.message ||
            "Error de Chatwoot"
          }`,
      });
    }

    guardarResultadoAccion(
      req,
      resultados.some((r) => !r.ok)
        ? "Relevamiento guardado con observaciones"
        : "Relevamiento completado correctamente",
      resultados,
    );

    res.redirect("/prospectos/" + req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error al guardar");
  }
});

    // ─── CAMBIAR ESTADO DEL PROSPECTO ─────────────────────────────────────────────
    router.post("/prospectos/:id/estado", requireAuth, async (req, res) => {
      const {
        estado,
        nota,
        modulos_contratados,
        condiciones_comerciales,
        motivo_perdida,
        motivo_perdida_otro,
      } = req.body;
      try {
        const { rows } = await pool.query(
          `
            SELECT
              estado,
              telefono,
              demo_responsable,
              chatwoot_conversation_id,
              creado_por
            FROM prospectos
            WHERE id=$1
            `,
            [req.params.id],
          );

          if (!rows.length) return res.status(404).send('Prospecto no encontrado');
          if (!['admin','vendedor'].includes(req.session.usuario.rol))
            return res.status(403).send('No autorizado para cambiar estados comerciales');
          if (req.session.usuario.rol === 'vendedor' && !(await puedeGestionar({
            id: Number(req.params.id), ...rows[0], creado_por: rows[0].creado_por,
          }, req.session.usuario)))
            return res.status(403).send('Solo podés cambiar el estado de tus prospectos asignados');
          const estadoAnterior = rows[0]?.estado;
          if (!['prospecto','sin_respuesta','confirmado','perdido'].includes(String(estado)))
            return res.status(400).send('Usá Coordinar demo o Cargar relevamiento para esas etapas');
          if (estado === 'confirmado' && estadoAnterior !== 'demo_realizada')
            return res.status(409).send('Para confirmar, primero debe estar registrada la demo realizada');
          if (estado === 'prospecto' && estadoAnterior !== 'sin_respuesta')
            return res.status(409).send('Para volver a Prospecto desde una demo coordinada, usá Reprogramar');
          if (estado === 'sin_respuesta' && estadoAnterior !== 'prospecto')
            return res.status(409).send('Sin respuesta solo se puede establecer desde Prospecto');
          if (['confirmado','perdido'].includes(estadoAnterior))
            return res.status(409).send('La oportunidad está cerrada; contactá a administración para corregirla');
          if (estadoAnterior === 'demo_coordinada' && estado === 'prospecto')
            return res.status(409).send('Usá Reprogramar para volver una demo coordinada a Prospecto');
          const telefono = rows[0]?.telefono;
          const demoResponsable = rows[0]?.demo_responsable;
          const chatwootConversationId =
          rows[0]?.chatwoot_conversation_id;
        const extra = {};
        if (estado === "confirmado") {
          // Separamos los módulos contratados por coma, igual que en el relevamiento (array de strings)
          extra.modulos_contratados = modulos_contratados
            ? modulos_contratados
                .split(",")
                .map((m) => m.trim())
                .filter((m) => m.length > 0)
            : null;
          extra.condiciones_comerciales = condiciones_comerciales;
          extra.fecha_confirmacion = new Date();
        }
        if (estado === "perdido") {
          const motivosValidos = [
            "Sin respuesta",
            "Económico",
            "Eligió otro sistema",
            "Falta de tiempo",
            "Otro",
          ];
          if (!motivosValidos.includes(motivo_perdida)) {
            return res.status(400).send("Seleccioná un motivo de pérdida válido");
          }
          if (
            motivo_perdida === "Otro" &&
            !String(motivo_perdida_otro || "").trim()
          ) {
            return res
              .status(400)
              .send("Aclarar el motivo es obligatorio cuando seleccionás Otro");
          }
          extra.motivo_perdida =
            motivo_perdida === "Otro"
              ? `Otro: ${String(motivo_perdida_otro).trim()}`
              : motivo_perdida;
        }

        await pool.query(
          `
          UPDATE prospectos SET estado=$1, actualizado_en=NOW()
          ${estado === "confirmado" ? ", modulos_contratados=$3, condiciones_comerciales=$4, fecha_confirmacion=$5" : ""}
          ${estado === "perdido" ? ", motivo_perdida=$3" : ""}
          WHERE id=$2
        `,
          estado === "confirmado"
            ? [
                estado,
                req.params.id,
                extra.modulos_contratados,
                extra.condiciones_comerciales,
                extra.fecha_confirmacion,
              ]
            : estado === "perdido"
              ? [estado, req.params.id, extra.motivo_perdida]
              : [estado, req.params.id],
        );
        const notaHistorial =
          estado === "perdido"
            ? `Motivo de pérdida: ${extra.motivo_perdida}`
            : nota || null;

        await pool.query(
          `
          INSERT INTO historial_estados (
            prospecto_id,
            estado_anterior,
            estado_nuevo,
            usuario_id,
            nota
          )
          VALUES ($1,$2,$3,$4,$5)
        `,
          [
            req.params.id,
            estadoAnterior,
            estado,
            req.session.usuario.id,
            notaHistorial,
          ],
        );

        // Las gestiones pendientes salen de la agenda cuando cambia la etapa comercial.
        if (estadoAnterior && estadoAnterior !== estado) {
          try {
            await pool.query(`UPDATE crm_tareas SET estado='cancelada',actualizada_en=NOW()
              WHERE prospecto_id=$1 AND estado='pendiente' AND origen <> 'chatwoot'`, [req.params.id]);
          } catch (errorCRM) {
            // Un error de agenda no debe impedir el cierre comercial ni los avisos al cliente.
            console.error('[CRM] No se pudieron retirar tareas de la etapa anterior:', errorCRM);
          }
        }

        // ─── Mensaje de bienvenida + aviso al confirmar ───

    if (
      estado === "confirmado" &&
      estadoAnterior !== "confirmado"
    ) {
      const resultados = [
        {
          ok: true,
          texto: "El prospecto quedó confirmado como cliente.",
        },
      ];

      // ---------------------------------------------------------
// CHATWOOT: MARCAR COMO CLIENTE ACTIVO
// ---------------------------------------------------------

if (chatwootConversationId) {
  try {
    const chatwootBase =
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}`;

    const headers = {
      api_access_token: process.env.CHATWOOT_API_TOKEN,
    };

    const { data: labelsData } = await axios.get(
      `${chatwootBase}/conversations/${chatwootConversationId}/labels`,
      { headers },
    );

    const etiquetasActuales = Array.isArray(labelsData)
      ? labelsData
      : Array.isArray(labelsData?.payload)
        ? labelsData.payload
        : Array.isArray(labelsData?.labels)
          ? labelsData.labels
          : [];

    const etiquetasNuevas = Array.from(
      new Set([
        ...etiquetasActuales,
        "cliente-activo",
      ]),
    );

    await axios.post(
      `${chatwootBase}/conversations/${chatwootConversationId}/labels`,
      {
        labels: etiquetasNuevas,
      },
      { headers },
    );

    
    await axios.post(
      `${chatwootBase}/conversations/${chatwootConversationId}/toggle_status`,
      {
        status: "resolved",
      },
      { headers },
    );
  } catch (chatwootErr) {
    console.error(
      "ERROR actualizando cliente confirmado en Chatwoot:",
      chatwootErr.response?.data || chatwootErr.message,
    );
  }
}

      // ---------------------------------------------------------
      // 1. BIENVENIDA AL CLIENTE
      // ---------------------------------------------------------

      if (telefono) {
        try {
          const mensajeBienvenida = `*Msj automático*

    ¡Gracias por elegirnos! 🎉
    Te damos la bienvenida a SM Soluciones.

    Te compartimos nuestras guías paso a paso para que puedas ir conociendo el sistema:

    👉 vPlus:
    https://sm-soluciones.com/ayuda/docs/vplus/guia-paso-a-paso-vplus/

    👉 Professional Plus:
    https://sm-soluciones.com/ayuda/docs/professional-plus/guia-paso-a-paso-professional-plus/

    Nuestro equipo de Soporte continuará con la instalación, configuración y capacitación.`;

          const enviado = await enviarPorChatwoot(
            telefono,
            mensajeBienvenida,
            demoResponsable,
          );

          if (enviado) {
            console.log(
              `✅ Bienvenida enviada al prospecto ${req.params.id}`,
            );

            resultados.push({
              ok: true,
              texto:
                "Se envió el mensaje de bienvenida al cliente.",
            });
          } else {
            resultados.push({
              ok: false,
              texto:
                "No se pudo enviar el mensaje de bienvenida al cliente.",
            });
          }
        } catch (msgErr) {
          console.error(
            "ERROR enviando mensaje de bienvenida:",
            msgErr.response?.data || msgErr.message,
          );

          resultados.push({
            ok: false,
            texto:
              `No se pudo enviar el mensaje de bienvenida: ` +
              `${
                msgErr.response?.data?.message ||
                msgErr.message ||
                "Error de Chatwoot"
              }`,
          });
        }
      } else {
        resultados.push({
          ok: false,
          texto:
            "No se envió la bienvenida porque el prospecto no tiene teléfono.",
        });
      }

      // ---------------------------------------------------------
      // 2. AVISO AL GRUPO
      // ---------------------------------------------------------

      try {
        const { rows: prospectoRows } = await pool.query(
          "SELECT * FROM prospectos WHERE id=$1",
          [req.params.id],
        );

        const full = prospectoRows[0];

        if (!full) {
          throw new Error(
            "No se pudo recuperar el prospecto confirmado",
          );
        }

        const nombreParaGrupo =
          full.nombre_negocio ||
          full.contacto ||
          `Prospecto #${req.params.id}`;

        const linkProspecto =
          `${process.env.APP_URL}/prospectos/${req.params.id}`;

        const mensajeAlta =
          `🆕 Nuevo cliente confirmado: *${nombreParaGrupo}*\n\n` +
          `👤 Contacto: ${full.contacto || "—"}\n` +
          `📞 Tel: ${full.telefono || "—"}\n` +
          `📧 Email: ${full.email || "—"}\n` +
          `🏬 Rubro: ${full.rubro || "—"}${full.rubro_otro ? ` (${full.rubro_otro})` : ""}\n\n` +
          `📦 Plan ofrecido: ${full.plan_ofrecido || "—"}\n\n` +
          `⭐ Módulos contratados: ${(full.modulos_contratados || []).join(", ") || "—"}\n` +
          `🛠️ Equipamiento: ${(full.equipamiento || []).join(", ") || "—"}${full.equip_observaciones ? ` — ${full.equip_observaciones}` : ""}\n\n` +
          `👨‍💼 Vendedor a cargo: ${nombreResponsable}\n` +
          `👉 Ver prospecto: ${linkProspecto}`;

        const avisoEnviado =
          await enviarAvisoInterno(mensajeAlta, await vendedorAsignado(full));

        if (avisoEnviado) {
          console.log(
            `✅ Aviso interno de cliente confirmado enviado: ${req.params.id}`,
          );

          resultados.push({
            ok: true,
            texto:
              "Se avisó al vendedor responsable.",
          });
        } else {
          resultados.push({
            ok: false,
            texto:
              "No se pudo avisar al vendedor responsable.",
          });
        }
      } catch (msgErr) {
        console.error(
          "ERROR enviando aviso de cliente confirmado:",
          msgErr.response?.data || msgErr.message,
        );

        resultados.push({
          ok: false,
          texto:
            `No se pudo enviar el aviso al responsable: ` +
            `${
              msgErr.response?.data?.message ||
              msgErr.message ||
              "Error de Chatwoot"
            }`,
        });
      }

      guardarResultadoAccion(
        req,
        resultados.some((r) => !r.ok)
          ? "Cliente confirmado con observaciones"
          : "Cliente confirmado correctamente",
        resultados,
      );
    }

    // ---------------------------------------------------------
    // PERDIDO
    // ---------------------------------------------------------

    if (estado === "perdido") {
      guardarResultadoAccion(
        req,
        "Prospecto marcado como perdido",
        [
          {
            ok: true,
            texto:
              "El prospecto quedó marcado como perdido y se guardó el motivo.",
          },
          {
            ok: true,
            texto:
              "No se envió ningún mensaje automático al cliente.",
          },
        ],
      );
    }

    res.redirect("/prospectos/" + req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error al cambiar estado");
  }
});

// ─── EDITAR PROSPECTO (Admin) ─────────────────────────────────────────────────
router.get("/prospectos/:id/editar", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT p.*,
        uc.nombre AS creado_por_nombre,
        ud.nombre AS demo_resp_nombre,
        ur.nombre AS relevamiento_por_nombre
      FROM prospectos p
      LEFT JOIN usuarios uc ON p.creado_por = uc.id
      LEFT JOIN usuarios ud ON p.demo_responsable = ud.id
      LEFT JOIN usuarios ur ON p.relevamiento_completado_por = ur.id
      WHERE p.id = $1
    `,
      [req.params.id],
    );

    if (!rows.length) return res.status(404).send("No encontrado");

    const p = rows[0];

    const u = req.session.usuario;

    let responsablesAdmin = [];

    if (u.rol === "admin") {
      const { rows: usuariosActivos } = await pool.query(`
        SELECT id, nombre, rol
        FROM usuarios
        WHERE activo = true
          AND rol IN ('soporte', 'admin', 'vendedor')
        ORDER BY nombre
      `);

      responsablesAdmin = usuariosActivos;
    }

    const responsableActualId = p.demo_responsable || p.creado_por || null;

    const demoCoordinada =
      p.estado !== "prospecto" && p.estado !== "sin_respuesta";

    const demoHecha = ["demo_realizada", "confirmado", "perdido"].includes(
      p.estado,
    );

    const MODULOS = [
      "Productos / stock",
      "Ventas / POS",
      "Compras",
      "Cuentas corrientes",
      "Facturación electrónica",
      "Promociones por cantidad",
      "Tienda online",
      "Green Points (fidelización)",
      "Reportes / contabilidad",
    ];

    const EQUIPOS = [
      "Balanza con impresora",
      "Impresora de tickets",
      "Lectora de código de barras",
      "Multi-PC / red local",
      "Tablet / móvil",
      "Cajón de dinero",
    ];

    const origenLabels = {
      manual: "Manual",
      meta: "📱 Meta",
      google: "🔎 Google",
      web: "🌐 Web",
      otro: "❔ Sin identificar",
      "prospecto-interno": "🤝 Referido / Interno"
    };

    const origenLabel =
      origenLabels[p.origen] || p.origen || "Sin identificar";
    const responsableNombre = p.demo_resp_nombre || p.creado_por_nombre || "—";

    res.send(
      layout(
        "Editar prospecto",
        `
      <div class="page-header">
        <div>
          <a href="/prospectos/${p.id}" class="back-link">
            <i class="ti ti-arrow-left"></i> Volver
          </a>

          <h1 class="page-title">
            Editar: ${esc(p.contacto || p.nombre_negocio || "Sin nombre")}
          </h1>

          <p class="page-sub">
            Modificá los datos del prospecto. El avance se realiza desde las acciones del prospecto.
          </p>
        </div>

        <div class="header-actions">
          <span class="badge-estado ${ESTADOS_COLOR[p.estado] || "gray"} lg">
            ${ESTADOS_LABEL[p.estado] || p.estado}
          </span>
        </div>
      </div>

      <div class="form-card">
        <form
            method="POST"
            action="/prospectos/${p.id}/editar"
            onsubmit="return confirmarEdicion()"
          >
            <input
              type="hidden"
              id="reenviar_invitacion"
              name="reenviar_invitacion"
              value="0"
            >

          <!-- DATOS DEL PROSPECTO -->
          <div class="form-section">
            <div class="section-title-row">
              <i class="ti ti-user"></i>
              <span>Datos del prospecto</span>
            </div>

            <div class="grid2">
              <div class="field">
                <label>Nombre <span class="req">*</span></label>
                <input
                  type="text"
                  name="contacto"
                  value="${esc(p.contacto || "")}"
                  required
                >
              </div>

              <div class="field">
                <label>Nombre del negocio</label>
                <input
                  type="text"
                  name="nombre_negocio"
                  value="${esc(p.nombre_negocio || "")}"
                >
              </div>
            </div>

            <div class="grid2">
              <div class="field">
                <label>Teléfono <span class="req">*</span></label>
                <input
                  type="text"
                  name="telefono"
                  value="${esc(p.telefono || "")}"
                  required
                >
              </div>

              <div class="field">
                <label>Email</label>
                <input
                  type="email"
                  name="email"
                  value="${esc(p.email || "")}"
                >
              </div>
            </div>

            <div class="grid2">
              <div class="field">
                <label>Origen</label>
                ${
                  req.session.usuario.rol === "admin"
                    ? `
                      <select name="origen">
                        <option value="google" ${p.origen === "google" ? "selected" : ""}>Google</option>
                        <option value="meta" ${p.origen === "meta" ? "selected" : ""}>Meta</option>
                        <option value="web" ${p.origen === "web" ? "selected" : ""}>Web</option>
                        <option value="prospecto-interno" ${p.origen === "prospecto-interno" ? "selected" : ""}>Referido / Interno</option>
                        <option value="otro" ${p.origen === "otro" ? "selected" : ""}>Sin identificar</option>
                      </select>
                    `
                    : `
                      <input
                        type="text"
                        value="${esc(origenLabel)}"
                        readonly
                      >
                    `
                }
              </div>

              <div class="field">
                <label>Responsable</label>

                ${
                  u.rol === "admin" && !p.chatwoot_conversation_id
                    ? `
                      <select name="responsable_id" required>
                        ${responsablesAdmin
                          .map(
                            (r) => `
                              <option
                                value="${r.id}"
                                ${Number(responsableActualId) === Number(r.id) ? "selected" : ""}
                              >
                                ${esc(r.nombre)} (${esc(r.rol)})
                              </option>
                            `,
                          )
                          .join("")}
                      </select>
                    `
                    : `
                      <input type="text" value="${esc(responsableNombre)}" disabled>
                      ${u.rol === "admin" && p.chatwoot_conversation_id
                        ? "" : ""}
                    `
                }
              </div>
            </div>
          </div>

          <!-- RUBRO -->
          <div class="form-section">
            <div class="section-title-row">
              <i class="ti ti-building-store"></i>
              <span>Rubro</span>
            </div>

            <div class="chips-group">
              ${[
                "Dietética",
                "Almacén / minimercado",
                "Carnicería",
                "Pollería",
                "Pet Shop",
                "Forrajería",
                "Fiambrería",
                "Mayorista",
                "Otro",
              ]
                .map(
                  (r) => `
                <label class="chip-label">
                  <input
                    type="radio"
                    name="rubro"
                    value="${r}"
                    ${p.rubro === r ? "checked" : ""}
                  >
                  <span class="chip">${r}</span>
                </label>
              `,
                )
                .join("")}
            </div>

            <div class="field" style="margin-top:10px">
              <label>Especificar si es otro</label>
              <input
                type="text"
                name="rubro_otro"
                value="${esc(p.rubro_otro || "")}"
              >
            </div>
          </div>

          
          <!-- NOTAS -->
          <div class="form-section">
            <div class="section-title-row">
              <i class="ti ti-note"></i>
              <span>Notas</span>
            </div>

            <div class="field">
              <label>Notas</label>
              <textarea name="nota_prospecto">${esc(p.nota_prospecto || "")}</textarea>
            </div>
          </div>

          <!-- ESTADO: SOLO INFORMATIVO -->
          <div class="form-section">
            <div class="section-title-row">
              <i class="ti ti-flag"></i>
              <span>Estado y demo</span>
            </div>

            <div class="grid2">
              <div class="field">
                <label>Estado actual</label>
                ${
                req.session.usuario.rol === "admin"
                  ? `
                    <select name="estado">
                      ${[
                        ["prospecto", "Prospecto"],
                        ["demo_coordinada", "Demo coordinada"],
                        ["demo_realizada", "Demo realizada"],
                        ["confirmado", "Confirmado"],
                        ["perdido", "Perdido"],
                      ]
                        .map(
                          ([value, label]) => `
                            <option
                              value="${value}"
                              ${p.estado === value ? "selected" : ""}
                            >
                              ${label}
                            </option>
                          `,
                        )
                        .join("")}
                    </select>
                  `
                  : `
                    <input
                      type="text"
                      value="${esc(ESTADOS_LABEL[p.estado] || p.estado)}"
                      disabled
                    >
                  `
              }
              </div>
            </div>

            ${
            p.demo_fecha
              ? `
            <div class="field">
              <label>Fecha y hora de la demo</label>

              <input
                type="datetime-local"
                id="demo_fecha"
                name="demo_fecha"
                value="${formatearDateTimeLocalAR(p.demo_fecha)}"
                data-original="${formatearDateTimeLocalAR(p.demo_fecha)}"
                required
              >

              <small class="text-muted">
                Si modificás la fecha, se creará una nueva reunión en Zoom.
              </small>
            </div>
          `
              : ""
          }

          ${
            demoHecha
              ? `

          <!-- MÓDULOS -->
          <div class="form-section">
            <div class="section-title-row">
              <i class="ti ti-star"></i>
              <span>Módulos de interés</span>
            </div>

            <div class="chips-group multi">
              ${MODULOS.map(
                (m) => `
                <label class="chip-label">
                  <input
                    type="checkbox"
                    name="modulos"
                    value="${m}"
                    ${(p.modulos || []).includes(m) ? "checked" : ""}
                  >
                  <span class="chip">${m}</span>
                </label>
              `,
              ).join("")}
            </div>
          </div>

          <!-- SISTEMA ACTUAL -->
          <div class="form-section">
            <div class="section-title-row">
              <i class="ti ti-device-desktop"></i>
              <span>Sistema actual</span>
            </div>

            <div class="grid2">
              <div class="field">
                <label>Sistema que usa hoy</label>
                <input
                  type="text"
                  name="sistema_actual"
                  value="${esc(p.sistema_actual || "")}"
                >
              </div>

              <div class="field">
                <label>Hace cuánto lo usa</label>
                <input
                  type="text"
                  name="tiempo_sistema"
                  value="${esc(p.tiempo_sistema || "")}"
                >
              </div>
            </div>

            <div class="field">
              <label>Problema con el sistema actual</label>
              <textarea name="problema_sistema">${esc(p.problema_sistema || "")}</textarea>
            </div>
          </div>

          <!-- NECESIDADES -->
          <div class="form-section">
            <div class="section-title-row">
              <i class="ti ti-adjustments"></i>
              <span>Necesidades y volumen</span>
            </div>

            <div class="field">
              <label>Necesidades especiales</label>
              <textarea name="necesidades">${esc(p.necesidades || "")}</textarea>
            </div>

            <div class="grid2">
              <div class="field">
                <label>Cantidad de productos</label>
                <input
                  type="text"
                  name="cant_productos"
                  value="${esc(p.cant_productos || "")}"
                >
              </div>

              <div class="field">
                <label>Volumen de ventas diarias</label>
                <input
                  type="text"
                  name="cant_ventas"
                  value="${esc(p.cant_ventas || "")}"
                >
              </div>
            </div>
          </div>

          <!-- EQUIPAMIENTO -->
          <div class="form-section">
            <div class="section-title-row">
              <i class="ti ti-tools"></i>
              <span>Equipamiento</span>
            </div>

            <div class="chips-group multi">
              ${EQUIPOS.map(
                (e) => `
                <label class="chip-label">
                  <input
                    type="checkbox"
                    name="equipamiento"
                    value="${e}"
                    ${(p.equipamiento || []).includes(e) ? "checked" : ""}
                  >
                  <span class="chip">${e}</span>
                </label>
              `,
              ).join("")}
            </div>

            <div class="field" style="margin-top:10px">
              <label>Observaciones de equipamiento</label>
              <input
                type="text"
                name="equip_observaciones"
                value="${esc(p.equip_observaciones || "")}"
              >
            </div>
          </div>

                    <!-- PLAN OFRECIDO -->
          <div class="form-section">
            <div class="section-title-row">
              <i class="ti ti-package"></i>
              <span>Plan ofrecido</span>
            </div>

            <div class="field">
              <label>Plan ofrecido</label>

              <select name="plan_ofrecido">
                <option value="">— Sin definir —</option>
                <option value="Emprendedor" ${p.plan_ofrecido === "Emprendedor" ? "selected" : ""}>
                  Emprendedor
                </option>
                <option value="VPlus" ${p.plan_ofrecido === "VPlus" ? "selected" : ""}>
                  VPlus
                </option>
                <option value="VPlus oferta" ${p.plan_ofrecido === "VPlus oferta" ? "selected" : ""}>
                  VPlus oferta
                </option>
                <option value="Professional Plus" ${p.plan_ofrecido === "Professional Plus" ? "selected" : ""}>
                  Professional Plus
                </option>
              </select>
            </div>
          </div>

          <!-- CIERRE / OBSERVACIONES -->
          <div class="form-section">
            <div class="section-title-row">
              <i class="ti ti-clipboard-check"></i>
              <span>Relevamiento y observaciones</span>
            </div>

            <div class="grid2">
              <div class="field">
                <label>Nivel de interés</label>

                <select name="nivel_interes">
                  <option value="">—</option>
                  <option value="alto" ${p.nivel_interes === "alto" ? "selected" : ""}>
                    🔥 Alto
                  </option>
                  <option value="medio" ${p.nivel_interes === "medio" ? "selected" : ""}>
                    👀 Medio
                  </option>
                  <option value="bajo" ${p.nivel_interes === "bajo" ? "selected" : ""}>
                    ❄️ Bajo
                  </option>
                </select>
              </div>

              <div class="field">
                <label>Próxima acción</label>
                <input
                  type="text"
                  value="${esc(pasoPorEstado(p.estado,p.demo_fecha).accion || PROXIMA_ACCION[p.estado] || "—")}"
                  disabled
                >
              </div>
            </div>

            <div class="field">
              <label>Observaciones generales</label>
              <textarea name="obs_generales">${esc(p.obs_generales || "")}</textarea>
            </div>

            <div class="field">
              <label>Condiciones comerciales</label>
              <textarea name="condiciones_comerciales">${esc(p.condiciones_comerciales || "")}</textarea>
            </div>
          </div>

          `
              : ""
          }

          ${
            p.motivo_perdida
              ? `
            <div class="form-section">
              <div class="section-title-row">
                <i class="ti ti-info-circle"></i>
                <span>Información de cierre</span>
              </div>

              <div class="field">
                <label>Motivo de pérdida registrado</label>
                <input
                  type="text"
                  value="${esc(p.motivo_perdida)}"
                  disabled
                >
                <small class="text-muted">
                  El motivo se registra mediante la acción “Marcar como perdido” y no se modifica desde Editar.
                </small>
              </div>
            </div>
          `
              : ""
          }

          <div class="form-actions">
            <a href="/prospectos/${p.id}" class="btn btn-ghost">
              Cancelar
            </a>

            <button type="submit" class="btn btn-primary">
              <i class="ti ti-device-floppy"></i>
              Guardar cambios
            </button>
          </div>

        </form>
      </div>

            <script>
        document.querySelectorAll('.chip-label input').forEach(input => {
          function sync() {
            const chip = input.nextElementSibling;
            chip.classList.toggle('active', input.checked);
          }

          input.addEventListener('change', () => {
            if (input.type === 'radio') {
              document
                .querySelectorAll(\`input[name="\${input.name}"]\`)
                .forEach(i =>
                  i.nextElementSibling.classList.remove('active')
                );
            }

            sync();
          });

          sync();
        });

        function confirmarEdicion() {
          const fechaInput = document.getElementById("demo_fecha");
          const reenviarInput = document.getElementById("reenviar_invitacion");

          if (fechaInput) {
            const fechaOriginal = fechaInput.dataset.original || "";
            const fechaNueva = fechaInput.value || "";

            if (fechaNueva !== fechaOriginal) {
              const continuar = confirm(
                "Estás modificando la fecha de la demostración.\\n\\n" +
                "Se creará una nueva reunión en Zoom con la nueva fecha y hora.\\n\\n" +
                "¿Querés continuar?"
              );

              if (!continuar) {
                return false;
              }

              const reenviar = confirm(
                "¿Deseás reenviar la invitación actualizada al contacto?\\n\\n" +
                "Aceptar: guardar y reenviar invitación.\\n" +
                "Cancelar: guardar sin reenviar."
              );

              reenviarInput.value = reenviar ? "1" : "0";

              return true;
            }
          }

          return confirm(
            "¿Confirmás que querés guardar estos cambios?\\n\\n" +
            "No se cambiará la etapa comercial ni se enviarán mensajes automáticos al cliente."
          );
        }
      </script>
    `,
        req,
      ),
    );
  } catch (err) {
    console.error("Error cargando edición:", err);
    res.status(500).send("Error interno");
  }
});

router.post("/prospectos/:id/editar", requireAuth, async (req, res) => {
  const b = req.body;

  try {
    const { rows: curRows } = await pool.query(
      "SELECT * FROM prospectos WHERE id=$1",
      [req.params.id],
    );

    if (!curRows.length) {
      return res.status(404).send("No encontrado");
    }

    const actual = curRows[0];
    if (actual.chatwoot_conversation_id && req.body.responsable_id) {
      return res.status(400).send("Para cambiar el responsable de esta conversación usá Reasignar en Chatwoot.");
    }

    let nuevoOrigen = actual.origen;

if (
  req.session.usuario.rol === "admin" &&
  b.origen
) {
  const origenesValidos = [
    "google",
    "meta",
    "web",
    "otro",
    "prospecto-interno",
  ];

  if (!origenesValidos.includes(b.origen)) {
    return res.status(400).send("Origen no válido");
  }

  nuevoOrigen = b.origen;
}

    let cambioEstado = null;

    if (
      req.session.usuario.rol === "admin" &&
      req.body.estado &&
      req.body.estado !== actual.estado
    ) {
      cambioEstado = {
        anterior: actual.estado,
        nuevo: req.body.estado,
      };
    }

    // Detectar si se modificó la fecha/hora de una demo ya coordinada
    const fechaDemoAnterior = actual.demo_fecha
      ? formatearDateTimeLocalAR(actual.demo_fecha)
      : "";

    const fechaDemoNueva = b.demo_fecha || "";

    const cambioFechaDemo =
      Boolean(actual.demo_fecha) &&
      Boolean(fechaDemoNueva) &&
      fechaDemoNueva !== fechaDemoAnterior;

let cambioResponsable = null;

  if (req.session.usuario.rol === "admin" && b.responsable_id) {
    const responsableId = Number(b.responsable_id);

    if (!Number.isInteger(responsableId) || responsableId <= 0) {
      return res.status(400).send("Responsable no válido");
    }

    const { rows: responsables } = await pool.query(
      `
      SELECT id, nombre
      FROM usuarios
      WHERE id = $1
        AND activo = true
        AND rol IN ('soporte', 'admin', 'vendedor')
      LIMIT 1
      `,
      [responsableId],
    );

    if (!responsables.length) {
      return res.status(400).send("Responsable no válido o inactivo");
    }

    const nuevoResponsable = responsables[0];

    const responsableAnteriorId =
      actual.demo_responsable !== null
        ? actual.demo_responsable
        : actual.creado_por;

    if (Number(responsableAnteriorId) !== responsableId) {
      const { rows: anteriorRows } = await pool.query(
        `SELECT nombre FROM usuarios WHERE id=$1`,
        [responsableAnteriorId],
      );

      cambioResponsable = {
        id: responsableId,
        nombre: nuevoResponsable.nombre,
        anterior: anteriorRows[0]?.nombre || "Sin asignar",
        usaDemoResponsable: actual.demo_responsable !== null,
      };
    }
  }

  const demoHecha = ["demo_realizada", "confirmado", "perdido"].includes(
      actual.estado,
    );

    /*
    * IMPORTANTE:
    * - El estado puede ser corregido manualmente solo por un administrador.
    * - El motivo de pérdida y la fecha de confirmación no se modifican desde Editar.
    * - El responsable puede ser modificado únicamente por un administrador.
    * - La fecha de una demo coordinada puede ser reprogramada desde Editar.
    */

    const modulos = demoHecha
      ? Array.isArray(b.modulos)
        ? b.modulos
        : b.modulos
          ? [b.modulos]
          : []
      : actual.modulos;

    const equipamiento = demoHecha
      ? Array.isArray(b.equipamiento)
        ? b.equipamiento
        : b.equipamiento
          ? [b.equipamiento]
          : []
      : actual.equipamiento;

        await pool.query(
      `
      UPDATE prospectos SET

        nombre_negocio=$1,
        contacto=$2,
        telefono=$3,
        email=$4,

        rubro=$5,
        rubro_otro=$6,

        nota_prospecto=$7,

        nivel_interes=$8,

        modulos=$9,
        sistema_actual=$10,
        tiempo_sistema=$11,

        problema_sistema=$12,
        necesidades=$13,
        cant_productos=$14,
        cant_ventas=$15,

        equipamiento=$16,
        equip_observaciones=$17,

        obs_generales=$18,
        condiciones_comerciales=$19,

        plan_ofrecido=$20,

        actualizado_en=NOW()

      WHERE id=$21
    `,
      [
        b.nombre_negocio || null,
        b.contacto,
        b.telefono,
        b.email,

        b.rubro,
        b.rubro_otro,

        b.nota_prospecto || null,

        demoHecha ? b.nivel_interes || null : actual.nivel_interes,

        modulos,

        demoHecha ? b.sistema_actual : actual.sistema_actual,
        demoHecha ? b.tiempo_sistema : actual.tiempo_sistema,

        demoHecha ? b.problema_sistema : actual.problema_sistema,
        demoHecha ? b.necesidades : actual.necesidades,
        demoHecha ? b.cant_productos : actual.cant_productos,
        demoHecha ? b.cant_ventas : actual.cant_ventas,

        equipamiento,

        demoHecha ? b.equip_observaciones : actual.equip_observaciones,

        demoHecha ? b.obs_generales : actual.obs_generales,
        demoHecha ? b.condiciones_comerciales : actual.condiciones_comerciales,

        b.plan_ofrecido || null,

        req.params.id,
      ],
    );

          if (cambioEstado) {
        const estadosPermitidos = [
          "prospecto",
          "demo_coordinada",
          "demo_realizada",
          "confirmado",
          "perdido",
        ];

        if (!estadosPermitidos.includes(cambioEstado.nuevo)) {
          return res.status(400).send("Estado no válido");
        }

        await pool.query(
          `
          UPDATE prospectos
          SET estado = $1,
              actualizado_en = NOW()
          WHERE id = $2
          `,
          [cambioEstado.nuevo, req.params.id],
        );

        await pool.query(
          `
          INSERT INTO historial_estados
            (
              prospecto_id,
              estado_anterior,
              estado_nuevo,
              usuario_id,
              nota
            )
          VALUES ($1, $2, $3, $4, $5)
          `,
          [
            req.params.id,
            cambioEstado.anterior,
            cambioEstado.nuevo,
            req.session.usuario.id,
            "Estado corregido manualmente desde edición",
          ],
        );
      }

      if (
  req.session.usuario.rol === "admin" &&
  nuevoOrigen !== actual.origen
) {
  await pool.query(
    `
    UPDATE prospectos
    SET origen = $1,
        actualizado_en = NOW()
    WHERE id = $2
    `,
    [nuevoOrigen, req.params.id],
  );

  if (["meta", "google", "web", "otro"].includes(nuevoOrigen)) {
    await pool.query(
      `
      UPDATE control_ventas
      SET origen = $1,
          origen_detalle = $2,
          actualizado_en = NOW()
      WHERE chatwoot_conversation_id = $3
      `,
      [nuevoOrigen, `${nuevoOrigen}_manual`, actual.chatwoot_conversation_id],
    );
  }

  await pool.query(
    `
    INSERT INTO historial_estados
      (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
    VALUES ($1,$2,$2,$3,$4)
    `,
    [
      req.params.id,
      actual.estado,
      req.session.usuario.id,
      `Origen cambiado de ${actual.origen || "sin definir"} a ${nuevoOrigen}`,
    ],
  );
}


        if (cambioResponsable) {
      if (cambioResponsable.usaDemoResponsable) {
        await pool.query(
          `
          UPDATE prospectos
          SET demo_responsable=$1, actualizado_en=NOW()
          WHERE id=$2
          `,
          [cambioResponsable.id, req.params.id],
        );
      } else {
        await pool.query(
          `
          UPDATE prospectos
          SET creado_por=$1, actualizado_en=NOW()
          WHERE id=$2
          `,
          [cambioResponsable.id, req.params.id],
        );
      }

      await pool.query(
        `
        INSERT INTO historial_estados
          (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
        VALUES ($1,$2,$2,$3,$4)
        `,
        [
          req.params.id,
          actual.estado,
          req.session.usuario.id,
          `Responsable cambiado de ${cambioResponsable.anterior} a ${cambioResponsable.nombre}`,
        ],
      );
    }

    // ─── REPROGRAMACIÓN EN GOOGLE MEET (nunca crear Zoom) ───
    if (cambioFechaDemo) {
      const responsableDemoId = cambioResponsable?.id || actual.demo_responsable || actual.creado_por;
      let nuevoJoinUrl = null, nuevoEventId = null;
      let nuevaDemoTipo = actual.demo_tipo || 'personalizada';
      try {
        if (nuevaDemoTipo === 'grupal_am' || nuevaDemoTipo === 'grupal_pm') {
          const turno = nuevaDemoTipo === 'grupal_am' ? 'am' : 'pm';
          const fechaDia = fechaDemoNueva.split('T')[0];
          const sesion = checkSlot(fechaDia,turno);
          if (fechaDemoNueva.slice(11,16)!==sesion.hora)
            return res.status(400).send(`La demo grupal ${turno.toUpperCase()} tiene horario fijo ${sesion.hora}. Cambiá la fecha, no el horario.`);
          nuevoJoinUrl = sesion.url;
        } else {
          const when=parseLocal(fechaDemoNueva);
          if(when.utc.getTime()<=Date.now())return res.status(400).send('La fecha debe ser futura');
          const creada=await crearReunionMeet({title:'SM Soluciones | Demostración personalizada',
            localStart:fechaDemoNueva,description:`Prospecto #${req.params.id}`});
          nuevoJoinUrl=creada.joinUrl;
          nuevoEventId=creada.eventId;
        }
        await pool.query(`UPDATE prospectos SET demo_fecha=$1::timestamp,zoom_join_url=$2,
          google_event_id=$3,demo_tipo=$4,recordatorio_enviado=false,
          recordatorio_relevamiento_enviado=false,actualizado_en=NOW() WHERE id=$5`,
          [fechaDemoNueva,nuevoJoinUrl,nuevoEventId,nuevaDemoTipo,req.params.id]);
        await pool.query(`INSERT INTO historial_estados(prospecto_id,estado_anterior,estado_nuevo,usuario_id,nota)
          VALUES($1,$2,$2,$3,$4)`,[req.params.id,actual.estado,req.session.usuario.id,
          `Demo reprogramada: ${formatearFechaAR(fechaDemoAnterior)} → ${formatearFechaAR(fechaDemoNueva)} · Google Meet`]);
        // El evento anterior solo es cancelable si fue una reunión personalizada creada por API.
        if(actual.google_event_id && actual.google_event_id !== nuevoEventId){
          try{await cancelarReunionMeet(actual.google_event_id);}
          catch(error){console.error('[MEET] Evento anterior no cancelado',actual.google_event_id,error.message);}
        }
      } catch(error) {
        if(nuevoEventId){await cancelarReunionMeet(nuevoEventId).catch(err=>console.error('[MEET] Falló limpieza de evento nuevo',err.message));}
        console.error('[MEET] Error reprogramando',error);
        return res.status(503).send(`No se pudo reprogramar correctamente la reunión: ${esc(error.message)}. Revisá la ficha antes de reintentar.`);
      }
      const nuevaFecha=formatearFechaAR(fechaDemoNueva);
      if(b.reenviar_invitacion === '1'){
        try{
          const ok=await enviarPorChatwoot(b.telefono||actual.telefono,
            `¡Hola! 😊 Tu demostración de SM Soluciones fue reprogramada.\n📅 ${nuevaFecha} (Buenos Aires)\n🎥 Google Meet: ${nuevoJoinUrl}\nDuración: 30 minutos.`,responsableDemoId);
          if(!ok)await alertarResponsableError(responsableDemoId,'Reprogramación sin aviso al cliente',actual,
            'La fecha fue actualizada, pero no se pudo entregar el WhatsApp; contactalo manualmente.');
        }catch(error){console.error('[MEET] Falló reenvío de invitación',error.message);}
      }
    }

    res.redirect("/prospectos/" + req.params.id);
  } catch (err) {
    console.error("Error editando prospecto:", err);
    res.status(500).send("Error al guardar");
  }
});



function formatObjeciones(obj) {
  if (!obj) return "—";
  const si = Object.entries(obj)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const no = Object.entries(obj)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  let parts = [];
  if (si.length) parts.push(`<strong>Sí:</strong> ${si.join(", ")}`);
  if (no.length) parts.push(`<strong>No:</strong> ${no.join(", ")}`);
  return parts.join(" | ") || "—";
}

module.exports = router;
module.exports.responsableCierre = responsableCierre;
