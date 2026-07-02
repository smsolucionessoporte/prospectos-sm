const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireRol, layout } = require('../middleware/auth');

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const ESTADOS_LABEL = {
  prospecto: 'Prospecto',
  demo_coordinada: 'Demo coordinada',
  demo_realizada: 'Demo realizada',
  propuesta_enviada: 'Propuesta enviada',
  confirmado: 'Confirmado',
  perdido: 'Perdido',
};

const ESTADOS_COLOR = {
  prospecto: 'gray', demo_coordinada: 'blue', demo_realizada: 'purple',
  propuesta_enviada: 'orange', confirmado: 'green', perdido: 'red',
};

// ─── NUEVO PROSPECTO (Administrativa) ─────────────────────────────────────────
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
              <label for="nombre_negocio">Nombre / negocio <span class="req">*</span></label>
              <input type="text" id="nombre_negocio" name="nombre_negocio" required placeholder="Ej: Dietética La Vida">
            </div>
            <div class="field">
              <label for="contacto">Responsable / contacto <span class="req">*</span></label>
              <input type="text" id="contacto" name="contacto" required placeholder="Nombre de la persona">
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label for="telefono">Teléfono</label>
              <input type="text" id="telefono" name="telefono" placeholder="+54 11 ...">
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
            <span>Rubro</span>
          </div>
          <div class="chips-group" id="chips-rubro">
            ${['Dietética','Almacén / minimercado','Carnicería','Fiambrería','Mayorista','Otro'].map(r =>
              `<label class="chip-label"><input type="radio" name="rubro" value="${r}"><span class="chip">${r}</span></label>`
            ).join('')}
          </div>
          <div class="field" style="margin-top:10px">
            <label for="rubro_otro">Especificar si es otro</label>
            <input type="text" id="rubro_otro" name="rubro_otro" placeholder="Rubro específico">
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row">
            <i class="ti ti-note"></i>
            <span>Notas iniciales</span>
          </div>
          <div class="field">
            <label for="notas_administrativas">Observaciones o contexto del primer contacto</label>
            <textarea id="notas_administrativas" name="notas_administrativas" placeholder="Cómo llegó el contacto, qué mencionó, urgencia..."></textarea>
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
  `, req));
});

router.post('/prospectos', requireAuth, async (req, res) => {
  const { nombre_negocio, contacto, telefono, email, rubro, rubro_otro, notas_administrativas } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO prospectos (nombre_negocio, contacto, telefono, email, rubro, rubro_otro, notas_administrativas, creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [nombre_negocio, contacto, telefono, email, rubro, rubro_otro, notas_administrativas, req.session.usuario.id]);

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
    }
    if (p.estado === 'demo_coordinada' && (u.rol === 'soporte' || u.rol === 'admin')) {
      acciones.push(`<a href="/prospectos/${p.id}/relevamiento" class="btn btn-primary"><i class="ti ti-clipboard-list"></i> Completar relevamiento</a>`);
    }
    if ((p.estado === 'demo_realizada' || p.estado === 'propuesta_enviada') && (u.rol === 'administrativa' || u.rol === 'admin')) {
      acciones.push(`
        <form method="POST" action="/prospectos/${p.id}/estado" style="display:inline">
          <input type="hidden" name="estado" value="propuesta_enviada">
          <button class="btn btn-secondary"><i class="ti ti-send"></i> Marcar propuesta enviada</button>
        </form>
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
          <div class="detail-item full"><span class="detail-label">Próximos pasos acordados</span><span class="detail-val">${esc(p.proximos_pasos||'—')}</span></div>
          <div class="detail-item full"><span class="detail-label">Observaciones generales</span><span class="detail-val">${esc(p.obs_generales||'—')}</span></div>
        </div>
      </div>
    ` : (p.estado !== 'prospecto' ? `
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

    res.send(layout(p.nombre_negocio, `
      <div class="page-header">
        <div>
          <a href="/panel" class="back-link"><i class="ti ti-arrow-left"></i> Volver al panel</a>
          <h1 class="page-title">${esc(p.nombre_negocio)}</h1>
          <p class="page-sub">${esc(p.contacto)}${p.telefono?' · '+esc(p.telefono):''}${p.email?' · '+esc(p.email):''}</p>
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
              <div class="detail-item"><span class="detail-label">Rubro</span><span class="detail-val">${esc(p.rubro||'—')}${p.rubro_otro?' ('+esc(p.rubro_otro)+')':''}</span></div>
              <div class="detail-item"><span class="detail-label">Teléfono</span><span class="detail-val">${esc(p.telefono||'—')}</span></div>
              <div class="detail-item"><span class="detail-label">Email</span><span class="detail-val">${esc(p.email||'—')}</span></div>
              ${p.notas_administrativas ? `<div class="detail-item full"><span class="detail-label">Notas administrativas</span><span class="detail-val">${esc(p.notas_administrativas)}</span></div>` : ''}
              ${p.demo_fecha ? `<div class="detail-item"><span class="detail-label">Demo agendada</span><span class="detail-val">${new Date(p.demo_fecha).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})} — ${esc(p.demo_resp_nombre||'—')}</span></div>` : ''}
            </div>
          </div>

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
        <p class="page-sub">${esc(p.nombre_negocio)}</p>
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
    await pool.query(`
      UPDATE prospectos SET estado='demo_coordinada', demo_fecha=$1, demo_responsable=$2, actualizado_en=NOW()
      WHERE id=$3
    `, [demo_fecha, demo_responsable_id, req.params.id]);
    await pool.query(`
      INSERT INTO historial_estados (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
      VALUES ($1,'prospecto','demo_coordinada',$2,$3)
    `, [req.params.id, req.session.usuario.id, nota_demo || 'Demo coordinada']);
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
        <p class="page-sub">${esc(p.nombre_negocio)} · Área Soporte</p>
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
          <div class="section-title-row"><i class="ti ti-star"></i><span>Módulos de interés</span><span class="badge-req">obligatorio</span></div>
          <div class="chips-group multi">
            ${MODULOS.map(m =>
              `<label class="chip-label"><input type="checkbox" name="modulos" value="${m}"><span class="chip">${m}</span></label>`
            ).join('')}
          </div>
        </div>

        <div class="form-section">
          <div class="section-title-row"><i class="ti ti-device-desktop"></i><span>Sistema actual</span><span class="badge-req">obligatorio</span></div>
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
          <div class="section-title-row"><i class="ti ti-tools"></i><span>Equipamiento disponible</span><span class="badge-req">obligatorio</span></div>
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
          <div class="section-title-row"><i class="ti ti-message-exclamation"></i><span>Objeciones detectadas</span><span class="badge-req">obligatorio</span></div>
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
          <div class="section-title-row"><i class="ti ti-clipboard-check"></i><span>Interés y próximos pasos</span><span class="badge-req">obligatorio</span></div>
          <div class="field">
            <label>Nivel de interés del prospecto</label>
            <div class="chips-group">
              <label class="chip-label"><input type="radio" name="nivel_interes" value="alto"><span class="chip">🔥 Alto — listo para avanzar</span></label>
              <label class="chip-label"><input type="radio" name="nivel_interes" value="medio"><span class="chip">👀 Medio — necesita más info</span></label>
              <label class="chip-label"><input type="radio" name="nivel_interes" value="bajo"><span class="chip">❄️ Bajo — no es el momento</span></label>
            </div>
          </div>
          <div class="field">
            <label>Próximos pasos acordados</label>
            <textarea name="proximos_pasos" placeholder="Enviar link de requerimientos, llamado en 3 días...">${esc(p.proximos_pasos||'')}</textarea>
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
        nivel_interes = $14, proximos_pasos = $15, obs_generales = $16,
        relevamiento_completado_por = $17, relevamiento_fecha = NOW(),
        actualizado_en = NOW()
      WHERE id = $18
    `, [
      b.rubro, b.rubro_otro,
      modulos, b.sistema_actual, b.tiempo_sistema,
      b.problema_sistema, b.necesidades, b.cant_productos, b.cant_ventas,
      equipamiento, b.equip_observaciones,
      JSON.stringify(objeciones), b.obj_detalle,
      b.nivel_interes, b.proximos_pasos, b.obs_generales,
      req.session.usuario.id, req.params.id
    ]);
    await pool.query(`
      INSERT INTO historial_estados (prospecto_id, estado_anterior, estado_nuevo, usuario_id, nota)
      VALUES ($1,'demo_coordinada','demo_realizada',$2,'Relevamiento completado')
    `, [req.params.id, req.session.usuario.id]);
    res.redirect('/prospectos/' + req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al guardar');
  }
});

// ─── CAMBIO DE ESTADO (Administrativa) ────────────────────────────────────────
router.post('/prospectos/:id/estado', requireAuth, async (req, res) => {
  const { estado, nota, modulos_contratados, condiciones_comerciales, motivo_perdida } = req.body;
  try {
    const { rows } = await pool.query('SELECT estado FROM prospectos WHERE id=$1', [req.params.id]);
    const estadoAnterior = rows[0]?.estado;
    const extra = {};
    if (estado === 'confirmado') {
      extra.modulos_contratados = modulos_contratados ? [modulos_contratados] : null;
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
    res.redirect('/prospectos/' + req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cambiar estado');
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
