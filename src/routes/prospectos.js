const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireRol, layout } = require('../middleware/auth');
const { AGENTE_ZOOM, AGENTE_TELEFONO, AGENTE_INBOX, AGENTE_CHATWOOT_ID } = require('../zoomAgentes');
const { crearReunionZoom, enviarPorChatwoot, formatearFechaAR, enviarMensajePorConversationId, normalizarTelefono } = require('../zoomChatwoot');

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const ESTADOS_LABEL = {
  prospecto: 'Prospecto',
  sin_respuesta: 'Sin respuesta',
  demo_coordinada: 'Demo coordinada',
  demo_realizada: 'Demo realizada',
  confirmado: 'Confirmado',
  perdido: 'Perdido',
};

const PROXIMA_ACCION = {
  prospecto: 'Coordinar demo',
  sin_respuesta: 'Reintentar contacto',
  demo_coordinada: 'Completar relevamiento',
  demo_realizada: 'Cerrar cliente',
  confirmado: 'Dar de alta en SM Admin',
  perdido: '—',
};

const ESTADOS_COLOR = {
  prospecto: 'gray', sin_respuesta: 'yellow', demo_coordinada: 'blue', demo_realizada: 'purple',
  confirmado: 'green', perdido: 'red',
};

// Determina si el usuario logueado puede ejecutar acciones de cierre
// (confirmar / marcar perdido) sobre un prospecto puntual.
function puedeCerrar(usuarioSesion, prospecto) {
  if (usuarioSesion.rol === 'admin' || usuarioSesion.rol === 'administrativa') return true;
  if (usuarioSesion.rol === 'vendedor') return prospecto.creado_por === usuarioSesion.id;
  return false;
}


// ─── ALTA AUTOMÁTICA DESDE AUTOMATIZACIÓN EXTERNA (Chatwoot) ─────────────────
router.post('/api/prospectos/auto-crear', express.json(), async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.AUTOMATION_API_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { nombre_contacto, telefono, origen, chatwoot_agent_id } = req.body;
  if (!telefono) return res.status(400).json({ error: 'Falta teléfono' });

  try {
    const variantes = normalizarTelefono(telefono);
    const { rows: existe } = await pool.query('SELECT id FROM prospectos WHERE telefono = ANY($1)', [variantes]);
    if (existe.length) {
      console.log('DEBUG auto-crear: ya existe prospecto con ese teléfono, id', existe[0].id);
      return res.status(200).json({ ok: true, duplicado: true, id: existe[0].id });
    }

    let creadoPor;
    if (origen === 'prospecto-redes') {
      creadoPor = Number(process.env.RAFAEL_USUARIO_ID);
    } else {
      creadoPor = AGENTE_CHATWOOT_ID[chatwoot_agent_id] || null;
    }

    const result = await pool.query(`
      INSERT INTO prospectos (nombre_negocio, contacto, telefono, rubro, nota_prospecto, creado_por, origen)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [
      null,
      nombre_contacto || null,
      telefono,
      'Otro',
      `Cargado automáticamente desde Chatwoot (${origen || 'etiqueta'})`,
      creadoPor,
      origen || 'manual'
    ]);

    await pool.query(`
      INSERT INTO historial_estados (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
      VALUES ($1, null, 'prospecto', $2, 'Alta automática desde Chatwoot')
    `, [result.rows[0].id, creadoPor]);

    console.log('DEBUG auto-crear: prospecto creado, id', result.rows[0].id, 'creado_por', creadoPor, 'origen', origen);
    res.status(201).json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error('Error creando prospecto automático:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── NUEVO PROSPECTO (Manual) ─────────────────────────────────────────
router.get('/prospectos/nuevo', requireAuth, (req, res) => {
  res.send(layout('Nuevo prospecto', `
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
            ${['Dietética','Almacén / minimercado','Carnicería','Fiambrería','Mayorista','Otro'].map(r =>
              `<label class="chip-label"><input type="radio" name="rubro" value="${r}" required><span class="chip">${r}</span></label>`
            ).join('')}
          </div>
          <div class="field" style="margin-top:10px">
            <label for="rubro_otro">Especificar si es otro</label>
            <input type="text" id="rubro_otro" name="rubro_otro" placeholder="Rubro específico">
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row">
            <i class="ti ti-player-play"></i>
            <span>Próxima acción</span>
          </div>
          <div class="grid2">
            <div class="field">
              <label for="proxima_accion">¿Qué sigue?</label>
              <input type="text" id="proxima_accion" name="proxima_accion" placeholder="Ej: Llamar el lunes, enviar info...">
            </div>
          </div>
          <div class="field">
            <label for="nota_prospecto">Nota</label>
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
  `, req));
});

router.post('/prospectos', requireAuth, async (req, res) => {
  const { nombre_negocio, contacto, telefono, email, rubro, rubro_otro, notas_administrativas, nota_prospecto } = req.body;
  try {
    const variantes = normalizarTelefono(telefono);
    const { rows: existe } = await pool.query('SELECT id, nombre_negocio, contacto FROM prospectos WHERE telefono = ANY($1)', [variantes]);
    if (existe.length) {
      const nombreExistente = (existe[0].nombre_negocio || existe[0].contacto || 'Sin nombre').replace(/'/g, "\\'");
      return res.status(400).send(`
        <script>
          alert('Ya existe un prospecto con ese teléfono: "${nombreExistente}" (ver /prospectos/${existe[0].id})');
          window.history.back();
        </script>
      `);
    }

    const result = await pool.query(`
      INSERT INTO prospectos (nombre_negocio, contacto, telefono, email, rubro, rubro_otro, notas_administrativas, nota_prospecto, creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [nombre_negocio || null, contacto, telefono, email, rubro, rubro_otro, notas_administrativas, nota_prospecto, req.session.usuario.id]);

    await pool.query(`
      INSERT INTO historial_estados (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
      VALUES ($1, null, 'prospecto', $2, 'Alta de prospecto')
    `, [result.rows[0].id, req.session.usuario.id]);

    res.redirect('/prospectos/' + result.rows[0].id);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al guardar');
  }
});

// ─── ELIMINAR PROSPECTO (solo usuario id 6) ───────────────────────────────────
router.post('/prospectos/:id/eliminar', requireAuth, async (req, res) => {
  if (req.session.usuario.id !== 6) {
    return res.status(403).send('No autorizado');
  }
  try {
    await pool.query('DELETE FROM prospectos WHERE id=$1', [req.params.id]);
    res.redirect('/panel');
  } catch (err) {
    console.error('Error eliminando prospecto:', err);
    res.status(500).send('Error al eliminar');
  }
});

// ─── DETALLE DE PROSPECTO ──────────────────────────────────────────────────────
router.get('/prospectos/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, 
        uc.nombre as creado_por_nombre,
        ud.nombre as demo_resp_nombre,
        ur.nombre as relevamiento_por_nombre
      FROM prospectos p
      LEFT JOIN usuarios uc ON p.creado_por = uc.id
      LEFT JOIN usuarios ud ON p.demo_responsable = ud.id
      LEFT JOIN usuarios ur ON p.relevamiento_completado_por = ur.id
      WHERE p.id = $1
    `, [req.params.id]);

    if (!rows.length) return res.status(404).send('Prospecto no encontrado');
    const p = rows[0];

    const historial = await pool.query(`
      SELECT h.*, u.nombre as usuario_nombre
      FROM historial_estados h
      LEFT JOIN usuarios u ON h.usuario_id = u.id
      WHERE h.prospecto_id = $1 ORDER BY h.fecha ASC
    `, [p.id]);

    const est = ESTADOS_COLOR[p.estado] || 'gray';
    const estadoLabel = ESTADOS_LABEL[p.estado] || p.estado;
    const u = req.session.usuario;

    // Acciones disponibles según estado y rol
    const acciones = [];
    if (p.estado === 'prospecto' && (u.rol === 'soporte' || u.rol === 'admin')) {
      acciones.push(`<a href="/prospectos/${p.id}/demo" class="btn btn-primary"><i class="ti ti-calendar-event"></i> Coordinar demo</a>`);
      acciones.push(`
        <form method="POST" action="/prospectos/${p.id}/estado" style="display:inline" onsubmit="return confirm('¿Marcar este prospecto como sin respuesta?')">
          <input type="hidden" name="estado" value="sin_respuesta">
          <input type="hidden" name="nota" value="Se le escribió 3 veces y no respondió.">
          <button class="btn btn-secondary"><i class="ti ti-message-off"></i> Marcar sin respuesta</button>
        </form>
      `);
    }
    if (p.estado === 'demo_coordinada' && (u.rol === 'soporte' || u.rol === 'admin')) {
      acciones.push(`<a href="/prospectos/${p.id}/relevamiento" class="btn btn-primary"><i class="ti ti-clipboard-list"></i> Completar relevamiento</a>`);
    }

    if (p.estado === 'demo_realizada' && puedeCerrar(u, p)) {
      acciones.push(`
        <form method="POST" action="/prospectos/${p.id}/estado" style="display:inline">
          <input type="hidden" name="estado" value="confirmado">
          <button class="btn btn-success"><i class="ti ti-check"></i> Confirmar cliente</button>
        </form>
        <form method="POST" action="/prospectos/${p.id}/estado" style="display:inline">
          <input type="hidden" name="estado" value="perdido">
          <button class="btn btn-danger"><i class="ti ti-x"></i> Marcar como perdido</button>
        </form>
      `);
    }
    if (u.rol === 'admin') {
      acciones.push(`<a href="/prospectos/${p.id}/editar" class="btn btn-secondary"><i class="ti ti-pencil"></i> Editar</a>`);
    }

    // Sección de relevamiento (si existe)
    const relHtml = p.relevamiento_fecha ? `
      <div class="detail-section">
        <div class="section-title-row"><i class="ti ti-clipboard-list"></i><span>Relevamiento post-demo</span>
          <span class="section-meta">por ${esc(p.relevamiento_por_nombre)} · ${new Date(p.relevamiento_fecha).toLocaleDateString('es-AR')}</span>
        </div>
        <div class="detail-grid">
          <div class="detail-item"><span class="detail-label">Módulos de interés</span><span class="detail-val">${(p.modulos||[]).join(', ') || '—'}</span></div>
          <div class="detail-item"><span class="detail-label">Sistema actual</span><span class="detail-val">${esc(p.sistema_actual||'—')} ${p.tiempo_sistema?'('+esc(p.tiempo_sistema)+')':''}</span></div>
          <div class="detail-item"><span class="detail-label">Problema sistema actual</span><span class="detail-val">${esc(p.problema_sistema||'—')}</span></div>
          <div class="detail-item"><span class="detail-label">Necesidades especiales</span><span class="detail-val">${esc(p.necesidades||'—')}</span></div>
          <div class="detail-item"><span class="detail-label">Cant. productos</span><span class="detail-val">${esc(p.cant_productos||'—')}</span></div>
          <div class="detail-item"><span class="detail-label">Volumen ventas</span><span class="detail-val">${esc(p.cant_ventas||'—')}</span></div>
          <div class="detail-item"><span class="detail-label">Equipamiento</span><span class="detail-val">${(p.equipamiento||[]).join(', ') || '—'} ${p.equip_observaciones?'— '+esc(p.equip_observaciones):''}</span></div>
          <div class="detail-item"><span class="detail-label">Nivel de interés</span><span class="detail-val">
            ${{alto:'🔥 Alto',medio:'👀 Medio',bajo:'❄️ Bajo'}[p.nivel_interes] || '—'}
          </span></div>
          <div class="detail-item full"><span class="detail-label">Objeciones detectadas</span><span class="detail-val">${formatObjeciones(p.objeciones)}</span></div>
          ${p.obj_detalle ? `<div class="detail-item full"><span class="detail-label">Detalle objeciones</span><span class="detail-val">${esc(p.obj_detalle)}</span></div>` : ''}
          <div class="detail-item full"><span class="detail-label">Observaciones generales</span><span class="detail-val">${esc(p.obs_generales||'—')}</span></div>
        </div>
      </div>
    ` : (p.estado !== 'prospecto' && p.estado !== 'sin_respuesta' ? `
      <div class="detail-section empty-section">
        <i class="ti ti-clipboard"></i>
        <span>El relevamiento post-demo aún no fue cargado.</span>
        ${(u.rol === 'soporte' || u.rol === 'admin') ? `<a href="/prospectos/${p.id}/relevamiento" class="btn btn-primary btn-SM"><i class="ti ti-plus"></i> Cargar ahora</a>` : ''}
      </div>
    ` : '');

    // Historial
    const histHtml = historial.rows.map(h => `
      <div class="hist-item">
        <div class="hist-dot ${ESTADOS_COLOR[h.estado_nuevo]||'gray'}"></div>
        <div class="hist-body">
          <span class="hist-estado">${ESTADOS_LABEL[h.estado_nuevo]||h.estado_nuevo}</span>
          <span class="hist-meta">${h.usuario_nombre} · ${new Date(h.fecha).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
          ${h.nota ? `<span class="hist-nota">${esc(h.nota)}</span>` : ''}
        </div>
      </div>
    `).join('');

    res.send(layout(p.contacto || p.nombre_negocio || 'Prospecto', `
      <div class="page-header">
        <div>
          <a href="/panel" class="back-link"><i class="ti ti-arrow-left"></i> Volver al panel</a>
          <h1 class="page-title">${esc(p.contacto || 'Sin nombre')}</h1>
          <p class="page-sub">${p.nombre_negocio?esc(p.nombre_negocio)+' · ':''}${p.telefono?esc(p.telefono):''}${p.email?' · '+esc(p.email):''}</p>
        </div>
        <div class="header-actions">
          <span class="badge-estado ${est} lg">${estadoLabel}</span>
          ${acciones.join('')}
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-main">
          <div class="detail-section">
            <div class="section-title-row"><i class="ti ti-user"></i><span>Datos del prospecto</span>
              <span class="section-meta">cargado por ${esc(p.creado_por_nombre||'—')}</span>
            </div>
            <div class="detail-grid">
              <div class="detail-item"><span class="detail-label">Negocio</span><span class="detail-val">${esc(p.nombre_negocio||'—')}</span></div>
              <div class="detail-item"><span class="detail-label">Rubro</span><span class="detail-val">${esc(p.rubro||'—')}${p.rubro_otro?' ('+esc(p.rubro_otro)+')':''}</span></div>
              <div class="detail-item"><span class="detail-label">Teléfono</span><span class="detail-val">${esc(p.telefono||'—')}</span></div>
              <div class="detail-item"><span class="detail-label">Email</span><span class="detail-val">${esc(p.email||'—')}</span></div>
              <div class="detail-item"><span class="detail-label">Origen</span><span class="detail-val">${{'manual':'Manual','prospecto-redes':'📱 Redes','prospecto-interno':'💬 Interno'}[p.origen] || '—'}</span></div>
              ${p.notas_administrativas ? `<div class="detail-item full"><span class="detail-label">Notas administrativas</span><span class="detail-val">${esc(p.notas_administrativas)}</span></div>` : ''}
              ${p.demo_fecha ? `<div class="detail-item"><span class="detail-label">Demo agendada</span><span class="detail-val">${new Date(p.demo_fecha).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})} — ${esc(p.demo_resp_nombre||'—')}${p.zoom_join_url ? ` — <a href="${p.zoom_join_url}" target="_blank">Entrar a la reunión <i class="ti ti-external-link"></i></a>` : ''}</span></div>` : ''}
              ${p.estado === 'demo_realizada' ? `<div class="detail-item"><span class="detail-label">Próxima acción</span><span class="detail-val">Cerrar cliente (${esc(responsableCierre(p))})</span></div>` : ''}
            </div>

          ${p.estado === 'sin_respuesta' ? `
          <div class="detail-section" style="border-left:4px solid #eab308; background:#fefce8;">
            <div class="section-title-row"><i class="ti ti-message-off"></i><span>Sin respuesta</span></div>
            <p style="margin:0;">Se le escribió 3 veces y no respondió.</p>
          </div>` : ''}

          ${relHtml}

          ${p.estado === 'confirmado' ? `
          <div class="detail-section confirmado-section">
            <div class="section-title-row"><i class="ti ti-check-circle"></i><span>Cliente confirmado</span></div>
            <div class="detail-grid">
              ${p.modulos_contratados?.length ? `<div class="detail-item full"><span class="detail-label">Módulos contratados</span><span class="detail-val">${p.modulos_contratados.join(', ')}</span></div>` : ''}
              ${p.condiciones_comerciales ? `<div class="detail-item full"><span class="detail-label">Condiciones comerciales</span><span class="detail-val">${esc(p.condiciones_comerciales)}</span></div>` : ''}
            </div>
          </div>` : ''}
        </div>

        <div class="detail-sidebar">
          <div class="detail-section">
            <div class="section-title-row"><i class="ti ti-history"></i><span>Historial</span></div>
            <div class="historial">${histHtml}</div>
          </div>
        </div>
      </div>

      <style>
        .badge-estado.yellow { background:#fef9c3; color:#854d0e; }
        .hist-dot.yellow { background:#eab308; }
      </style>
    `, req));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error interno');
  }
});

// ─── COORDINAR DEMO ───────────────────────────────────────────────────────────
router.get('/prospectos/:id/demo', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM prospectos WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).send('No encontrado');
  const p = rows[0];

  res.send(layout('Coordinar demo', `
    <div class="page-header">
      <div>
        <a href="/prospectos/${p.id}" class="back-link"><i class="ti ti-arrow-left"></i> Volver</a>
        <h1 class="page-title">Coordinar demo</h1>
        <p class="page-sub">${esc(p.contacto || p.nombre_negocio || 'Sin nombre')}</p>
      </div>
    </div>
    <div class="form-card">
      <form method="POST" action="/prospectos/${p.id}/demo">
        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-calendar-event"></i><span>Fecha y hora de la demo</span></div>
          <div class="grid2">
            <div class="field">
              <label for="demo_fecha">Fecha y hora <span class="req">*</span></label>
              <input type="datetime-local" id="demo_fecha" name="demo_fecha" required>
            </div>
            <div class="field">
              <label for="demo_responsable_id">Responsable de la demo <span class="req">*</span></label>
              <select id="demo_responsable_id" name="demo_responsable_id" required>
                <option value="">Seleccioná un responsable</option>
                ${(await pool.query("SELECT id, nombre FROM usuarios WHERE activo=true AND rol IN ('soporte','admin')")).rows.map(u =>
                  `<option value="${u.id}">${esc(u.nombre)}</option>`
                ).join('')}
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
  `, req));
});

router.post('/prospectos/:id/demo', requireAuth, async (req, res) => {
  const { demo_fecha, demo_responsable_id, nota_demo } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM prospectos WHERE id=$1', [req.params.id]);
    const prospecto = rows[0];

    await pool.query(`
      UPDATE prospectos SET estado='demo_coordinada', demo_fecha=$1, demo_responsable=$2, actualizado_en=NOW()
      WHERE id=$3
    `, [demo_fecha, demo_responsable_id, req.params.id]);
    await pool.query(`
      INSERT INTO historial_estados (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
      VALUES ($1,'prospecto','demo_coordinada',$2,$3)
    `, [req.params.id, req.session.usuario.id, nota_demo || 'Demo coordinada']);

 // ─── NUEVO: crear reunión Zoom y avisar por Chatwoot ───
    console.log('DEBUG demo_fecha:', demo_fecha, '| demo_responsable_id:', demo_responsable_id);
    const zoomEmail = AGENTE_ZOOM[demo_responsable_id];
    console.log('DEBUG zoomEmail encontrado:', zoomEmail);
    if (zoomEmail) {
      try {
        const nombreParaZoom = prospecto.nombre_negocio || prospecto.contacto || 'Prospecto';
        const joinUrl = await crearReunionZoom(zoomEmail, `Demo ${nombreParaZoom}`, demo_fecha);
        console.log('DEBUG reunión creada:', joinUrl);
        await pool.query('UPDATE prospectos SET zoom_join_url=$1 WHERE id=$2', [joinUrl, req.params.id]);

        // Traer el nombre del responsable
        const { rows: agenteRows } = await pool.query('SELECT nombre FROM usuarios WHERE id=$1', [demo_responsable_id]);
        const nombreAgente = agenteRows[0]?.nombre || 'nuestro equipo';

        const fechaFormateada = formatearFechaAR(demo_fecha);
        const telefonoAgente = AGENTE_TELEFONO[demo_responsable_id];
const mensaje = `¡Todo listo! 😊

Te dejamos el link para unirte a la demostración agendada para el día ${fechaFormateada}. 🎥

🔗 ${joinUrl}

💻 Te recomendamos conectarte desde una computadora, con audio y micrófono habilitados.`;         const enviado = await enviarPorChatwoot(prospecto.telefono, mensaje);
        console.log('DEBUG mensaje enviado:', enviado);
      } catch (zoomErr) {
        console.error('ERROR creando reunión o enviando mensaje:', zoomErr.response?.data || zoomErr.message);
      }
    } else {
      console.log('DEBUG: no se encontró email de Zoom para el responsable', demo_responsable_id);
    }

    res.redirect('/prospectos/' + req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al guardar');
  }
});

// ─── RELEVAMIENTO POST-DEMO ───────────────────────────────────────────────────
router.get('/prospectos/:id/relevamiento', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM prospectos WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).send('No encontrado');
  const p = rows[0];

  const MODULOS = ['Productos / stock','Ventas / POS','Compras','Cuentas corrientes','Facturación electrónica','Promociones por cantidad','Tienda online','Green Points (fidelización)','Reportes / contabilidad'];
  const EQUIPOS = ['Balanza con impresora','Impresora de tickets','Lectora de código de barras','Multi-PC / red local','Tablet / móvil','Cajón de dinero'];
  const OBJECIONES = ['Precio / presupuesto','Resistencia al cambio','Necesita evaluar con socio / familiar','Dudas sobre migración de datos','Funcionalidad faltante / específica','Soporte / capacitación'];

  res.send(layout('Relevamiento', `
    <div class="page-header">
      <div>
        <a href="/prospectos/${p.id}" class="back-link"><i class="ti ti-arrow-left"></i> Volver</a>
        <h1 class="page-title">Relevamiento post-demo</h1>
        <p class="page-sub">${esc(p.contacto || p.nombre_negocio || 'Sin nombre')} · Área Soporte</p>
      </div>
    </div>
    <div class="form-card">
      <form method="POST" action="/prospectos/${p.id}/relevamiento">

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-building-store"></i><span>Rubro del negocio</span><span class="badge-req">obligatorio</span></div>
          <div class="chips-group">
            ${['Dietética','Almacén / minimercado','Carnicería','Fiambrería','Mayorista','Otro'].map(r =>
              `<label class="chip-label"><input type="radio" name="rubro" value="${r}" ${p.rubro===r?'checked':''}><span class="chip">${r}</span></label>`
            ).join('')}
          </div>
          <div class="field" style="margin-top:10px">
            <label>Especificar si es otro</label>
            <input type="text" name="rubro_otro" value="${esc(p.rubro_otro||'')}">
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-star"></i><span>Módulos de interés</span><span class="badge-opc">opcional</span></div>
          <div class="chips-group multi">
            ${MODULOS.map(m =>
              `<label class="chip-label"><input type="checkbox" name="modulos" value="${m}"><span class="chip">${m}</span></label>`
            ).join('')}
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-device-desktop"></i><span>Sistema actual</span><span class="badge-opc">opcional</span></div>
          <div class="grid2">
            <div class="field">
              <label>¿Qué sistema usa hoy?</label>
              <input type="text" name="sistema_actual" value="${esc(p.sistema_actual||'')}" placeholder="Ej: Excel, Tango, ninguno...">
            </div>
            <div class="field">
              <label>¿Hace cuánto lo usa?</label>
              <input type="text" name="tiempo_sistema" value="${esc(p.tiempo_sistema||'')}" placeholder="Ej: 2 años">
            </div>
          </div>
          <div class="field">
            <label>¿Qué problema tiene con el sistema actual?</label>
            <textarea name="problema_sistema" placeholder="No maneja granel, no tiene facturación electrónica...">${esc(p.problema_sistema||'')}</textarea>
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-adjustments"></i><span>Necesidades especiales</span><span class="badge-opt">opcional</span></div>
          <div class="field">
            <label>Requerimientos específicos o particularidades</label>
            <textarea name="necesidades" placeholder="Granel con pesaje, múltiples listas de precio, integración contable...">${esc(p.necesidades||'')}</textarea>
          </div>
          <div class="grid2">
            <div class="field">
              <label>Cantidad estimada de productos</label>
              <input type="text" name="cant_productos" value="${esc(p.cant_productos||'')}" placeholder="Ej: 500, más de 1000...">
            </div>
            <div class="field">
              <label>Volumen de ventas diarias</label>
              <input type="text" name="cant_ventas" value="${esc(p.cant_ventas||'')}" placeholder="Ej: 50 tickets/día">
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-tools"></i><span>Equipamiento disponible</span><span class="badge-opt">opcional</span></div>
          <div class="chips-group multi">
            ${EQUIPOS.map(e =>
              `<label class="chip-label"><input type="checkbox" name="equipamiento" value="${e}"><span class="chip">${e}</span></label>`
            ).join('')}
          </div>
          <div class="field" style="margin-top:10px">
            <label>Observaciones sobre el equipamiento</label>
            <input type="text" name="equip_observaciones" value="${esc(p.equip_observaciones||'')}" placeholder="Modelo de balanza, cantidad de PCs, etc.">
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-message-exclamation"></i><span>Objeciones detectadas</span><span class="badge-opt">opcional</span></div>
          ${OBJECIONES.map((obj, idx) => `
            <div class="objecion-row">
              <span class="objecion-label">${esc(obj)}</span>
              <div class="radio-pair">
                <label class="radio-opt si"><input type="radio" name="obj_${idx}" value="si"> Sí</label>
                <label class="radio-opt no"><input type="radio" name="obj_${idx}" value="no"> No</label>
              </div>
            </div>
          `).join('')}
          <div class="field" style="margin-top:12px">
            <label>Detalle de objeciones</label>
            <textarea name="obj_detalle" placeholder="Describir las objeciones planteadas y cómo se respondieron...">${esc(p.obj_detalle||'')}</textarea>
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
            <textarea name="obs_generales" placeholder="Cualquier dato relevante para el área administrativa...">${esc(p.obs_generales||'')}</textarea>
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
  `, req));
});

router.post('/prospectos/:id/relevamiento', requireAuth, async (req, res) => {
  const b = req.body;
  const OBJECIONES = ['Precio / presupuesto','Resistencia al cambio','Necesita evaluar con socio / familiar','Dudas sobre migración de datos','Funcionalidad faltante / específica','Soporte / capacitación'];
  const modulos = Array.isArray(b.modulos) ? b.modulos : (b.modulos ? [b.modulos] : []);
  const equipamiento = Array.isArray(b.equipamiento) ? b.equipamiento : (b.equipamiento ? [b.equipamiento] : []);
  const objeciones = {};
  OBJECIONES.forEach((obj, idx) => { objeciones[obj] = b[`obj_${idx}`] === 'si'; });

  try {
    await pool.query(`
      UPDATE prospectos SET
        estado = 'demo_realizada',
        rubro = $1, rubro_otro = $2,
        modulos = $3, sistema_actual = $4, tiempo_sistema = $5,
        problema_sistema = $6, necesidades = $7, cant_productos = $8, cant_ventas = $9,
        equipamiento = $10, equip_observaciones = $11,
        objeciones = $12, obj_detalle = $13,
        nivel_interes = $14, obs_generales = $15,
        relevamiento_completado_por = $16, relevamiento_fecha = NOW(),
        actualizado_en = NOW()
      WHERE id = $17
    `, [
      b.rubro, b.rubro_otro,
      modulos, b.sistema_actual, b.tiempo_sistema,
      b.problema_sistema, b.necesidades, b.cant_productos, b.cant_ventas,
      equipamiento, b.equip_observaciones,
      JSON.stringify(objeciones), b.obj_detalle,
      b.nivel_interes, b.obs_generales,
      req.session.usuario.id, req.params.id
    ]);
    await pool.query(`
      INSERT INTO historial_estados (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
      VALUES ($1,'demo_coordinada','demo_realizada',$2,'Relevamiento completado')
    `, [req.params.id, req.session.usuario.id]);

    // ─── Enviar mensaje post-demo con documentación (al cliente) ───
    let telefono;
    try {
      const { rows: prospRows } = await pool.query('SELECT * FROM prospectos WHERE id=$1', [req.params.id]);
      const p = prospRows[0];
      telefono = p.telefono;
      if (telefono) {
        const mensajePostDemo = `Gracias por asistir a la demostración. A continuación te compartimos los documentos con las normas generales y requisitos del sistema, para que puedas revisar toda la información necesaria:\n\n📄 Normas generales: https://sm-soluciones.com/ayuda/docs/temas-comunes/normas-generales/\n⚙️ Requisitos y recomendaciones de equipo: https://sm-soluciones.com/ayuda/docs/temas-comunes/requisitos-y-recomendaciones-para-la-instalacion-%f0%9f%9b%a0%ef%b8%8f/\n\nLa información comercial y de alta será enviada por Administración.\n\nQuedo a disposición para cualquier consulta y, en caso de avanzar, para coordinar la implementación.`;
        await enviarPorChatwoot(telefono, mensajePostDemo);
      }

      // ─── Enviar datos del relevamiento al grupo ───
        const grupoConvId = process.env.CHATWOOT_GRUPO_CONVERSATION_ID;
        const nombreParaGrupo = p.nombre_negocio || p.contacto || 'Sin nombre';
      if (grupoConvId) {
        const link = `${process.env.APP_URL}/prospectos/${req.params.id}`;
        const mensajeGrupo = `📋 Demo realizada: *${nombreParaGrupo}*\n\n📞 Tel: ${p.telefono}\n🏬 Rubro: ${p.rubro || '—'}${p.rubro_otro ? ' ('+p.rubro_otro+')' : ''}\n⭐ Módulos: ${(p.modulos||[]).join(', ') || '—'}\n🛠️ Equipamiento: ${(p.equipamiento||[]).join(', ') || '—'}${p.equip_observaciones ? ' — '+p.equip_observaciones : ''}\n🔥 Interés: ${{alto:'Alto',medio:'Medio',bajo:'Bajo'}[p.nivel_interes] || '—'}\n\n👉 Enviar propuesta: ${link}`;
        await enviarMensajePorConversationId(grupoConvId, mensajeGrupo);
      }
    } catch (msgErr) {
      console.error('ERROR enviando mensajes post-relevamiento:', msgErr.response?.data || msgErr.message);
    }

    res.redirect('/prospectos/' + req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al guardar');
  }
});

function responsableCierre(p) {
  if (p.origen === 'prospecto-interno') return 'Andrés';
  return p.creado_por_nombre || '—';
}

// ─── CAMBIAR ESTADO DEL PROSPECTO ─────────────────────────────────────────────
router.post('/prospectos/:id/estado', requireAuth, async (req, res) => {
  const { estado, nota, modulos_contratados, condiciones_comerciales, motivo_perdida } = req.body;
  try {
    const { rows } = await pool.query('SELECT estado, telefono FROM prospectos WHERE id=$1', [req.params.id]);
    const estadoAnterior = rows[0]?.estado;
    const telefono = rows[0]?.telefono;
    const extra = {};
    if (estado === 'confirmado') {
      // Separamos los módulos contratados por coma, igual que en el relevamiento (array de strings)
      extra.modulos_contratados = modulos_contratados
        ? modulos_contratados.split(',').map(m => m.trim()).filter(m => m.length > 0)
        : null;
      extra.condiciones_comerciales = condiciones_comerciales;
      extra.fecha_confirmacion = new Date();
    }
    if (estado === 'perdido') extra.motivo_perdida = motivo_perdida;

    await pool.query(`
      UPDATE prospectos SET estado=$1, actualizado_en=NOW()
      ${estado==='confirmado' ? ', modulos_contratados=$3, condiciones_comerciales=$4, fecha_confirmacion=$5' : ''}
      ${estado==='perdido' ? ', motivo_perdida=$3' : ''}
      WHERE id=$2
    `, estado==='confirmado'
      ? [estado, req.params.id, extra.modulos_contratados, extra.condiciones_comerciales, extra.fecha_confirmacion]
      : estado==='perdido'
      ? [estado, req.params.id, extra.motivo_perdida]
      : [estado, req.params.id]
    );
    await pool.query(`
      INSERT INTO historial_estados (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
      VALUES ($1,$2,$3,$4,$5)
    `, [req.params.id, estadoAnterior, estado, req.session.usuario.id, nota || null]);

 // ─── Mensaje de bienvenida al confirmar ───
    if (estado === 'confirmado' && telefono) {
      try {
        const mensajeBienvenida = `¡Gracias por elegirnos! 🎉 Te damos la bienvenida a SM Soluciones.\n\nTe compartimos las guías paso a paso para que vayas conociendo el sistema, según el producto contratado:\n\n👉 vPlus: https://sm-soluciones.com/ayuda/docs/vplus/guia-paso-a-paso-vplus/\n👉 Professional Plus: https://sm-soluciones.com/ayuda/docs/professional-plus/guia-paso-a-paso-professional-plus/`;
        await enviarPorChatwoot(telefono, mensajeBienvenida);
      } catch (msgErr) {
        console.error('ERROR enviando mensaje de bienvenida:', msgErr.response?.data || msgErr.message);
      }

      // ─── Aviso al grupo con los datos del cliente confirmado ───
          try {
            const grupoConvId = process.env.CHATWOOT_GRUPO_CONVERSATION_ID;
            if (grupoConvId) {
              const { rows: fullRows } = await pool.query('SELECT * FROM prospectos WHERE id=$1', [req.params.id]);
              const full = fullRows[0];
              const nombreParaGrupo = full.nombre_negocio || full.contacto || 'Sin nombre';
              const linkProspecto = `${process.env.APP_URL}/prospectos/${req.params.id}`;
              const linkSmAdmin = process.env.SM_ADMIN_URL;
              const mensajeAlta = `🆕 Nuevo cliente confirmado: *${nombreParaGrupo}*\n\n👤 Contacto: ${full.contacto || '—'}\n📞 Tel: ${full.telefono}\n📧 Email: ${full.email || '—'}\n🏬 Rubro: ${full.rubro || '—'}${full.rubro_otro ? ' ('+full.rubro_otro+')' : ''}\n\n⭐ Módulos de interés: ${(full.modulos||[]).join(', ') || '—'}\n🛠️ Equipamiento: ${(full.equipamiento||[]).join(', ') || '—'}${full.equip_observaciones ? ' — '+full.equip_observaciones : ''}\n\n👉 Ver prospecto: ${linkProspecto}\n👉 Cargar en SM Admin: ${linkSmAdmin}`;
              await enviarMensajePorConversationId(grupoConvId, mensajeAlta);
            }
          } catch (msgErr) {
            console.error('ERROR enviando aviso al grupo:', msgErr.response?.data || msgErr.message);
          }
    }

    res.redirect('/prospectos/' + req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cambiar estado');
  }
});

// ─── EDITAR PROSPECTO (Admin) ─────────────────────────────────────────────────
router.get('/prospectos/:id/editar', requireRol('admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM prospectos WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).send('No encontrado');
  const p = rows[0];
  const demoCoordinada = p.estado !== 'prospecto' && p.estado !== 'sin_respuesta';
  const demoHecha = ['demo_realizada','confirmado','perdido'].includes(p.estado);
  
  const MODULOS = ['Productos / stock','Ventas / POS','Compras','Cuentas corrientes','Facturación electrónica','Promociones por cantidad','Tienda online','Green Points (fidelización)','Reportes / contabilidad'];
  const EQUIPOS = ['Balanza con impresora','Impresora de tickets','Lectora de código de barras','Multi-PC / red local','Tablet / móvil','Cajón de dinero'];
  const ESTADOS_OPTS = ['prospecto','sin_respuesta','demo_coordinada','demo_realizada','confirmado','perdido'];

  res.send(layout('Editar prospecto', `
    <div class="page-header">
      <div>
        <a href="/prospectos/${p.id}" class="back-link"><i class="ti ti-arrow-left"></i> Volver</a>
        <h1 class="page-title">Editar: ${esc(p.contacto || p.nombre_negocio || 'Sin nombre')}</h1>
        <p class="page-sub">Edición completa — Admin</p>
      </div>
    </div>
    <div class="form-card">
      <form method="POST" action="/prospectos/${p.id}/editar">

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-user"></i><span>Datos del prospecto</span></div>
          <div class="grid2">
            <div class="field">
              <label>Nombre <span class="req">*</span></label>
              <input type="text" name="contacto" value="${esc(p.contacto||'')}" required>
            </div>
            <div class="field">
              <label>Nombre del negocio</label>
              <input type="text" name="nombre_negocio" value="${esc(p.nombre_negocio||'')}">
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label>Teléfono <span class="req">*</span></label>
              <input type="text" name="telefono" value="${esc(p.telefono||'')}" required>
            </div>
            <div class="field">
              <label>Email</label>
              <input type="email" name="email" value="${esc(p.email||'')}">
            </div>
          </div>
          <div class="field">
            <label>Notas administrativas</label>
            <textarea name="notas_administrativas">${esc(p.notas_administrativas||'')}</textarea>
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-building-store"></i><span>Rubro</span></div>
          <div class="chips-group">
            ${['Dietética','Almacén / minimercado','Carnicería','Fiambrería','Mayorista','Otro'].map(r =>
              `<label class="chip-label"><input type="radio" name="rubro" value="${r}" ${p.rubro===r?'checked':''}><span class="chip">${r}</span></label>`
            ).join('')}
          </div>
          <div class="field" style="margin-top:10px">
            <label>Especificar si es otro</label>
            <input type="text" name="rubro_otro" value="${esc(p.rubro_otro||'')}">
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row">
            <i class="ti ti-note"></i>
            <span>Nota</span>
          </div>
          <div class="field">
            <label for="nota_prospecto">Nota</label>
            <textarea id="nota_prospecto" name="nota_prospecto" placeholder="Contexto del primer contacto, observaciones..."></textarea>
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-flag"></i><span>Estado</span></div>
          <div class="field">
            <label>Estado actual</label>
            <select name="estado">
              ${ESTADOS_OPTS.map(e => `<option value="${e}" ${p.estado===e?'selected':''}>${e}</option>`).join('')}
            </select>
          </div>
          ${demoCoordinada ? `
          <div class="grid2">
            <div class="field">
              <label>Fecha demo</label>
              <input type="datetime-local" name="demo_fecha" value="${p.demo_fecha ? new Date(p.demo_fecha).toISOString().slice(0,16) : ''}">
            </div>
            ${demoHecha ? `
            <div class="field">
              <label>Nivel de interés</label>
              <select name="nivel_interes">
                <option value="">—</option>
                <option value="alto" ${p.nivel_interes==='alto'?'selected':''}>🔥 Alto</option>
                <option value="medio" ${p.nivel_interes==='medio'?'selected':''}>👀 Medio</option>
                <option value="bajo" ${p.nivel_interes==='bajo'?'selected':''}>❄️ Bajo</option>
              </select>
            </div>
            ` : ''}
          </div>
          ` : ''}
        </div>

      ${demoHecha ? `
        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-star"></i><span>Módulos de interés</span></div>
          <div class="chips-group multi">
            ${MODULOS.map(m =>
              `<label class="chip-label"><input type="checkbox" name="modulos" value="${m}" ${(p.modulos||[]).includes(m)?'checked':''}><span class="chip">${m}</span></label>`
            ).join('')}
          </div>
        </div>
        ` : ''}

        ${demoHecha ? `
        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-device-desktop"></i><span>Sistema actual</span></div>
          <div class="grid2">
            <div class="field">
              <label>Sistema que usa hoy</label>
              <input type="text" name="sistema_actual" value="${esc(p.sistema_actual||'')}">
            </div>
            <div class="field">
              <label>Hace cuánto lo usa</label>
              <input type="text" name="tiempo_sistema" value="${esc(p.tiempo_sistema||'')}">
            </div>
          </div>
          <div class="field">
            <label>Problema con el sistema actual</label>
            <textarea name="problema_sistema">${esc(p.problema_sistema||'')}</textarea>
          </div>
        </div>
        ` : ''}

        ${demoHecha ? `
        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-adjustments"></i><span>Necesidades y volumen</span></div>
          <div class="field">
            <label>Necesidades especiales</label>
            <textarea name="necesidades">${esc(p.necesidades||'')}</textarea>
          </div>
          <div class="grid2">
            <div class="field">
              <label>Cant. de productos</label>
              <input type="text" name="cant_productos" value="${esc(p.cant_productos||'')}">
            </div>
            <div class="field">
              <label>Volumen ventas diarias</label>
              <input type="text" name="cant_ventas" value="${esc(p.cant_ventas||'')}">
            </div>
          </div>
        </div>
        ` : ''}

        ${demoHecha ? `
        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-tools"></i><span>Equipamiento</span></div>
          <div class="chips-group multi">
            ${EQUIPOS.map(e =>
              `<label class="chip-label"><input type="checkbox" name="equipamiento" value="${e}" ${(p.equipamiento||[]).includes(e)?'checked':''}><span class="chip">${e}</span></label>`
            ).join('')}
          </div>
          <div class="field" style="margin-top:10px">
            <label>Observaciones equipamiento</label>
            <input type="text" name="equip_observaciones" value="${esc(p.equip_observaciones||'')}">
          </div>
        </div>
        ` : ''}

     ${demoHecha ? `
        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-clipboard-check"></i><span>Cierre</span></div>
          <div class="field">
            <label>Próxima acción (automática según estado)</label>
              <input type="text" value="${esc(PROXIMA_ACCION[p.estado] || '—')}${p.estado==='demo_realizada' ? ' (' + esc(responsableCierre(p)) + ')' : ''}" disabled>          </div>
          <div class="field">
            <label>Observaciones generales</label>
            <textarea name="obs_generales">${esc(p.obs_generales||'')}</textarea>
          </div>
          <div class="field">
            <label>Condiciones comerciales</label>
            <textarea name="condiciones_comerciales">${esc(p.condiciones_comerciales||'')}</textarea>
          </div>
          <div class="field">
            <label>Motivo de pérdida</label>
            <input type="text" name="motivo_perdida" value="${esc(p.motivo_perdida||'')}">
          </div>
        </div>
        ` : ''}

        <div class="form-actions">
          <a href="/prospectos/${p.id}" class="btn btn-ghost">Cancelar</a>
          <button type="submit" class="btn btn-primary"><i class="ti ti-device-floppy"></i> Guardar cambios</button>
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
          document.querySelectorAll(\`input[name="\${input.name}"]\`).forEach(i => i.nextElementSibling.classList.remove('active'));
        }
        sync();
      });
      sync();
    });
    </script>
  `, req));
});

router.post('/prospectos/:id/editar', requireRol('admin'), async (req, res) => {
  const b = req.body;
  try {
    const { rows: curRows } = await pool.query('SELECT * FROM prospectos WHERE id=$1', [req.params.id]);
    if (!curRows.length) return res.status(404).send('No encontrado');
    const actual = curRows[0];
    const demoCoordinada = actual.estado !== 'prospecto' && actual.estado !== 'sin_respuesta';
    const demoHecha = ['demo_realizada','confirmado','perdido'].includes(actual.estado);

    const modulos = demoHecha
      ? (Array.isArray(b.modulos) ? b.modulos : (b.modulos ? [b.modulos] : []))
      : actual.modulos;
    const equipamiento = demoHecha
      ? (Array.isArray(b.equipamiento) ? b.equipamiento : (b.equipamiento ? [b.equipamiento] : []))
      : actual.equipamiento;

    await pool.query(`
      UPDATE prospectos SET
        nombre_negocio=$1, contacto=$2, telefono=$3, email=$4,
        rubro=$5, rubro_otro=$6, notas_administrativas=$7,
        nota_prospecto=$8,
        estado=$9, demo_fecha=$10, nivel_interes=$11,
        modulos=$12, sistema_actual=$13, tiempo_sistema=$14,
        problema_sistema=$15, necesidades=$16, cant_productos=$17, cant_ventas=$18,
        equipamiento=$19, equip_observaciones=$20,
        obs_generales=$21,
        condiciones_comerciales=$22, motivo_perdida=$23,
        actualizado_en=NOW()
      WHERE id=$24
    `, [
      b.nombre_negocio || null, b.contacto, b.telefono, b.email,
      b.rubro, b.rubro_otro, b.notas_administrativas,
      b.nota_prospecto,
      b.estado,
      demoCoordinada ? (b.demo_fecha || null) : actual.demo_fecha,
      demoHecha ? (b.nivel_interes || null) : actual.nivel_interes,
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
      demoHecha ? b.motivo_perdida : actual.motivo_perdida,
      req.params.id
    ]);
    res.redirect('/prospectos/' + req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al guardar');
  }
});

function formatObjeciones(obj) {
  if (!obj) return '—';
  const si = Object.entries(obj).filter(([,v]) => v).map(([k]) => k);
  const no = Object.entries(obj).filter(([,v]) => !v).map(([k]) => k);
  let parts = [];
  if (si.length) parts.push(`<strong>Sí:</strong> ${si.join(', ')}`);
  if (no.length) parts.push(`<strong>No:</strong> ${no.join(', ')}`);
  return parts.join(' | ') || '—';
}


module.exports = router;