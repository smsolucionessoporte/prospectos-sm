const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireRol, layout } = require('../middleware/auth');
const {
  obtenerEstadoConversacionChatwoot,
  enviarCampaniaPorConversationId,
} = require('../zoomChatwoot');

let procesando = false;
let timer = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function estadoLabel(estado) {
  const map = {
    pendiente: ['Pendiente', 'gray'],
    enviando: ['Enviando', 'blue'],
    completada: ['Completada', 'green'],
    completada_con_errores: ['Completada con errores', 'orange'],
  };
  return map[estado] || [estado || '—', 'gray'];
}

function buildEligibility({ origen, desde, hasta }, startIndex = 1) {
  const where = [
    'cv.respondio_cliente = FALSE',
    "COALESCE(cv.clasificacion, '') <> 'consulta_erronea'",
    'cv.derivado = FALSE',
    `NOT EXISTS (
      SELECT 1
      FROM prospectos p
      WHERE p.chatwoot_conversation_id = cv.chatwoot_conversation_id
        AND p.estado IN ('confirmado', 'perdido')
    )`,
  ];
  const params = [];
  let index = startIndex;

  if (origen && ['meta', 'google', 'otro'].includes(origen)) {
    where.push(`cv.origen = $${index++}`);
    params.push(origen);
  }
  if (desde) {
    where.push(`cv.fecha_ingreso >= $${index++}::date`);
    params.push(desde);
  }
  if (hasta) {
    where.push(`cv.fecha_ingreso < ($${index++}::date + INTERVAL '1 day')`);
    params.push(hasta);
  }

  return { where: where.join('\n AND '), params };
}

async function countEligible(filters) {
  const { where, params } = buildEligibility(filters, 1);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
       FROM control_ventas cv
      WHERE ${where}`,
    params,
  );
  return Number(rows[0]?.total || 0);
}

router.get(
  '/campanias',
  requireAuth,
  requireRol('admin'),
  async (req, res) => {
    try {
      const totalBase = await countEligible({});
      const { rows: historial } = await pool.query(`
        SELECT c.*, u.nombre AS creado_por_nombre
        FROM campanias c
        LEFT JOIN usuarios u ON u.id = c.creado_por
        ORDER BY c.creado_en DESC
        LIMIT 30
      `);

      const creada = req.query.creada;
      const error = req.query.error;

      const filas = historial.map((c) => {
        const [label, color] = estadoLabel(c.estado);
        const fecha = c.creado_en
          ? new Date(c.creado_en).toLocaleString('es-AR', {
              timeZone: 'America/Argentina/Buenos_Aires',
              day: '2-digit', month: '2-digit', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })
          : '—';
        return `
          <tr>
            <td><div class="prospect-name">${escapeHtml(c.nombre)}</div><div class="text-muted">${fecha}</div></td>
            <td><span class="badge-estado ${color}">${escapeHtml(label)}</span></td>
            <td>${c.total_destinatarios}</td>
            <td>${c.enviados}</td>
            <td>${c.omitidos}</td>
            <td>${c.errores}</td>
            <td class="text-muted">${escapeHtml(c.origen_filtro || 'Todos')}</td>
          </tr>`;
      }).join('');

      res.send(layout('Campañas', `
        <div class="page-header">
          <div>
            <h1 class="page-title">Campañas</h1>
            <p class="page-sub">Recontactá prospectos sin respuesta sin alterar las estadísticas ni derivarlos automáticamente.</p>
          </div>
        </div>

        ${creada ? '<div class="alert alert-success"><i class="ti ti-check"></i> Campaña creada. El envío comenzó y podés actualizar esta página para ver el avance.</div>' : ''}
        ${error ? `<div class="alert alert-error"><i class="ti ti-alert-circle"></i> ${escapeHtml(error)}</div>` : ''}

        <div class="control-stats-grid">
          <div class="control-stat-card control-stat-highlight">
            <div class="control-stat-value" id="preview-total">${totalBase}</div>
            <div class="control-stat-title">Sin respuesta disponibles</div>
            <div class="control-stat-desc">No incluye consultas erróneas, derivados, confirmados ni perdidos.</div>
          </div>
        </div>

        <form class="form-card" method="post" action="/campanias" id="campania-form">
          <div class="form-section">
            <div class="section-title-row"><i class="ti ti-speakerphone"></i> Nueva campaña</div>
            <div class="grid2">
              <div class="field">
                <label>Nombre de la campaña <span class="req">*</span></label>
                <input type="text" name="nombre" maxlength="150" required placeholder="Ej. Recontacto septiembre">
              </div>
              <div class="field">
                <label>Segmento</label>
                <select name="segmento" disabled>
                  <option>No respondieron</option>
                </select>
                <input type="hidden" name="segmento" value="no_respondieron">
              </div>
              <div class="field">
                <label>Origen</label>
                <select name="origen" id="campania-origen">
                  <option value="">Todos</option>
                  <option value="meta">Meta</option>
                  <option value="google">Google</option>
                  <option value="otro">Otro</option>
                </select>
              </div>
              <div class="field">
                <label>Período de ingreso</label>
                <div class="grid2">
                  <input type="date" name="desde" id="campania-desde" aria-label="Desde">
                  <input type="date" name="hasta" id="campania-hasta" aria-label="Hasta">
                </div>
              </div>
            </div>
            <div class="field">
              <label>Mensaje <span class="req">*</span></label>
              <textarea name="mensaje" rows="7" maxlength="1800" required placeholder="Escribí el mensaje que querés enviar..."></textarea>
              <div class="text-muted" style="margin-top:6px">Antes de cada envío se vuelve a validar que el contacto siga habilitado para la campaña.</div>
            </div>
          </div>
          <div class="form-actions">
            <span class="text-muted" style="margin-right:auto">Destinatarios estimados: <strong id="preview-inline">${totalBase}</strong></span>
            <button type="submit" class="btn btn-primary" id="campania-submit"><i class="ti ti-send"></i> Iniciar campaña</button>
          </div>
        </form>

        <div class="control-section">
          <div class="control-section-header">
            <div><h2>Historial de campañas</h2><p>Los omitidos son contactos que dejaron de cumplir las condiciones antes del envío.</p></div>
          </div>
          <div class="table-wrap">
            <table class="prospects-table">
              <thead><tr><th>Campaña</th><th>Estado</th><th>Destinatarios</th><th>Enviados</th><th>Omitidos</th><th>Errores</th><th>Origen</th></tr></thead>
              <tbody>${filas || '<tr><td colspan="7" class="empty-row"><i class="ti ti-speakerphone"></i>Todavía no hay campañas.</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <script>
          const ids = ['campania-origen', 'campania-desde', 'campania-hasta'];
          let previewTimer;
          async function actualizarPreview() {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(async () => {
              const params = new URLSearchParams();
              const origen = document.getElementById('campania-origen').value;
              const desde = document.getElementById('campania-desde').value;
              const hasta = document.getElementById('campania-hasta').value;
              if (origen) params.set('origen', origen);
              if (desde) params.set('desde', desde);
              if (hasta) params.set('hasta', hasta);
              try {
                const r = await fetch('/campanias/preview?' + params.toString());
                const data = await r.json();
                document.getElementById('preview-total').textContent = data.total ?? 0;
                document.getElementById('preview-inline').textContent = data.total ?? 0;
              } catch (_) {}
            }, 200);
          }
          ids.forEach(id => document.getElementById(id).addEventListener('change', actualizarPreview));
          document.getElementById('campania-form').addEventListener('submit', (event) => {
            const total = Number(document.getElementById('preview-inline').textContent || 0);
            if (!total) {
              event.preventDefault();
              alert('No hay contactos que cumplan las condiciones seleccionadas.');
              return;
            }
            if (!confirm('Se enviará este mensaje a ' + total + ' contactos elegibles. ¿Continuar?')) {
              event.preventDefault();
            }
          });
        </script>
      `, req));
    } catch (err) {
      console.error('Error cargando campañas:', err);
      res.status(500).send(layout('Error', '<div class="alert alert-error">No se pudo cargar Campañas.</div>', req));
    }
  },
);

router.get(
  '/campanias/preview',
  requireAuth,
  requireRol('admin'),
  async (req, res) => {
    try {
      const total = await countEligible({
        origen: req.query.origen || '',
        desde: req.query.desde || '',
        hasta: req.query.hasta || '',
      });
      res.json({ total });
    } catch (err) {
      console.error('Error en preview de campaña:', err);
      res.status(500).json({ error: 'No se pudo calcular el segmento' });
    }
  },
);

router.post(
  '/campanias',
  requireAuth,
  requireRol('admin'),
  async (req, res) => {
    const nombre = String(req.body.nombre || '').trim();
    const mensaje = String(req.body.mensaje || '').trim();
    const origen = ['meta', 'google', 'otro'].includes(req.body.origen) ? req.body.origen : null;
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.body.desde || '') ? req.body.desde : null;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.body.hasta || '') ? req.body.hasta : null;

    if (!nombre || !mensaje) {
      return res.redirect('/campanias?error=' + encodeURIComponent('Nombre y mensaje son obligatorios.'));
    }
    if (mensaje.length > 1800) {
      return res.redirect('/campanias?error=' + encodeURIComponent('El mensaje supera el máximo permitido.'));
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO campanias (
           nombre, mensaje, segmento, origen_filtro, desde_filtro, hasta_filtro,
           estado, creado_por
         ) VALUES ($1, $2, 'no_respondieron', $3, $4, $5, 'pendiente', $6)
         RETURNING id`,
        [nombre, mensaje, origen, desde, hasta, req.session.usuario.id],
      );
      const campaniaId = rows[0].id;
      const { where, params } = buildEligibility({ origen, desde, hasta }, 2);
      const insert = await client.query(
        `INSERT INTO campania_destinatarios (
           campania_id, chatwoot_conversation_id, estado
         )
         SELECT $1, cv.chatwoot_conversation_id, 'pendiente'
         FROM control_ventas cv
         WHERE ${where}
         ON CONFLICT (campania_id, chatwoot_conversation_id) DO NOTHING`,
        [campaniaId, ...params],
      );

      await client.query(
        `UPDATE campanias SET total_destinatarios = $2 WHERE id = $1`,
        [campaniaId, insert.rowCount || 0],
      );
      await client.query('COMMIT');

      setImmediate(() => void procesarCampaniasPendientes());
      return res.redirect(`/campanias?creada=${campaniaId}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error creando campaña:', err);
      return res.redirect('/campanias?error=' + encodeURIComponent('No se pudo crear la campaña.'));
    } finally {
      client.release();
    }
  },
);

async function marcarDestinatario(id, estado, detalle = null) {
  await pool.query(
    `UPDATE campania_destinatarios
        SET estado = $2,
            detalle = $3,
            enviado_en = CASE WHEN $2 = 'enviado' THEN NOW() ELSE enviado_en END
      WHERE id = $1`,
    [id, estado, detalle],
  );
}

async function actualizarTotalesCampania(campaniaId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE estado = 'enviado')::int AS enviados,
       COUNT(*) FILTER (WHERE estado = 'omitido')::int AS omitidos,
       COUNT(*) FILTER (WHERE estado = 'error')::int AS errores,
       COUNT(*) FILTER (WHERE estado IN ('pendiente', 'procesando'))::int AS pendientes
     FROM campania_destinatarios
     WHERE campania_id = $1`,
    [campaniaId],
  );
  const r = rows[0] || {};
  const pendientes = Number(r.pendientes || 0);
  const errores = Number(r.errores || 0);
  await pool.query(
    `UPDATE campanias
        SET enviados = $2,
            omitidos = $3,
            errores = $4,
            estado = CASE
              WHEN $5 = 0 AND $4 > 0 THEN 'completada_con_errores'
              WHEN $5 = 0 THEN 'completada'
              ELSE 'enviando'
            END,
            finalizado_en = CASE WHEN $5 = 0 THEN NOW() ELSE NULL END
      WHERE id = $1`,
    [campaniaId, Number(r.enviados || 0), Number(r.omitidos || 0), errores, pendientes],
  );
}

async function procesarCampaniasPendientes() {
  if (procesando) return;
  procesando = true;
  try {
    const { rows: campanias } = await pool.query(`
      SELECT id, mensaje
      FROM campanias
      WHERE estado IN ('pendiente', 'enviando')
      ORDER BY creado_en ASC
      LIMIT 1
    `);
    const campania = campanias[0];
    if (!campania) return;

    await pool.query(
      `UPDATE campanias
          SET estado = 'enviando',
              iniciado_en = COALESCE(iniciado_en, NOW())
        WHERE id = $1`,
      [campania.id],
    );

    const { rows: destinatarios } = await pool.query(
      `UPDATE campania_destinatarios
          SET estado = 'procesando'
        WHERE id IN (
          SELECT id
          FROM campania_destinatarios
          WHERE campania_id = $1
            AND estado = 'pendiente'
          ORDER BY id
          LIMIT 10
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, chatwoot_conversation_id`,
      [campania.id],
    );

    for (const d of destinatarios) {
      try {
        const { rows: control } = await pool.query(
          `SELECT respondio_cliente, clasificacion, derivado
             FROM control_ventas
            WHERE chatwoot_conversation_id = $1
            LIMIT 1`,
          [d.chatwoot_conversation_id],
        );
        const actual = control[0];
        if (
          !actual ||
          actual.respondio_cliente === true ||
          actual.clasificacion === 'consulta_erronea' ||
          actual.derivado === true
        ) {
          await marcarDestinatario(d.id, 'omitido', 'Dejó de cumplir el segmento antes del envío');
          continue;
        }

        const estadoChatwoot = await obtenerEstadoConversacionChatwoot(d.chatwoot_conversation_id);
        if (!estadoChatwoot) {
          await marcarDestinatario(d.id, 'omitido', 'La conversación ya no existe en Chatwoot');
          continue;
        }

        const labels = (estadoChatwoot.labels || []).map((x) => String(x).toLowerCase());
        const bloqueadas = ['consulta-erronea', 'cliente-activo', 'derivar-ventas', 'contactado-ventas'];
        const motivo = bloqueadas.find((label) => labels.includes(label));
        if (motivo) {
          await marcarDestinatario(d.id, 'omitido', `Etiqueta excluyente: ${motivo}`);
          continue;
        }

        await enviarCampaniaPorConversationId(
          d.chatwoot_conversation_id,
          campania.mensaje,
          campania.id,
        );
        await marcarDestinatario(d.id, 'enviado');
      } catch (err) {
        console.error('Error enviando destinatario de campaña:', d.chatwoot_conversation_id, err.response?.data || err.message || err);
        await marcarDestinatario(
          d.id,
          'error',
          String(err.response?.data?.message || err.message || 'Error de envío').slice(0, 500),
        );
      }
    }

    await actualizarTotalesCampania(campania.id);
  } catch (err) {
    console.error('Error procesando campañas:', err);
  } finally {
    procesando = false;
  }
}

async function iniciarProcesadorCampanias() {
  try {
    await pool.query(`UPDATE campania_destinatarios SET estado = 'pendiente' WHERE estado = 'procesando'`);
    await pool.query(`UPDATE campanias SET estado = 'pendiente' WHERE estado = 'enviando'`);
  } catch (err) {
    console.error('No se pudo recuperar el estado de campañas:', err);
  }

  void procesarCampaniasPendientes();
  if (!timer) {
    timer = setInterval(() => void procesarCampaniasPendientes(), 10_000);
    timer.unref?.();
  }
}

module.exports = router;
module.exports.procesarCampaniasPendientes = procesarCampaniasPendientes;
module.exports.iniciarProcesadorCampanias = iniciarProcesadorCampanias;
