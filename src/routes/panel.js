const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { requireAuth, layout } = require("../middleware/auth");
const { responsableCierre } = require('./prospectos');

const ESTADOS = {
  prospecto: { label: "Prospecto", color: "gray" },
  sin_respuesta: { label: "Sin respuesta", color: "yellow" },
  demo_coordinada: { label: "Demo coordinada", color: "blue" },
  demo_realizada: { label: "Demo realizada", color: "purple" },
  confirmado: { label: "Confirmado ✓", color: "green" },
  perdido: { label: "Perdido", color: "red" },
};

// Estados tildados por defecto la primera vez que se entra al panel
// (todos menos perdido y sin_respuesta)
const ESTADOS_DEFAULT = Object.keys(ESTADOS).filter(
  (k) => k !== "perdido" && k !== "sin_respuesta",
);

const PROXIMA_ACCION = {
  prospecto: "Coordinar demo",
  sin_respuesta: "Reintentar contacto",
  demo_coordinada: "Realizar demo",
  demo_realizada: "Cerrar cliente",
  confirmado: "Implementación",
  perdido: "Sin acción",
};

// Usuario que representa a "SM" (el jefe) para el cierre de prospectos
// cargados por soporte. Configurable por env var, default id 1 (Administrador).
const JEFE_USUARIO_ID = Number(process.env.JEFE_USUARIO_ID) || 1;

// Determina si el usuario logueado puede ejecutar acciones de cierre
// (confirmar / marcar perdido) sobre un prospecto puntual.
function puedeCerrar(usuarioSesion, prospecto) {
  if (usuarioSesion.rol === 'admin' || usuarioSesion.rol === 'administrativa') return true;
  if (usuarioSesion.rol === 'vendedor') return prospecto.creado_por === usuarioSesion.id;
  return false;
}

const ORIGEN_LABEL = {
  'manual': 'Manual',
  'prospecto-redes': '📱 Redes',
  'prospecto-interno': '💬 Interno',
};

const PAGE_SIZE = 20;

router.get("/panel", requireAuth, async (req, res) => {
  try {
    const { buscar, responsable, desde, hasta, filtrado } = req.query;
    const pagina = Math.max(1, parseInt(req.query.pagina) || 1);

    // Si el form ya fue enviado (filtrado=1), respeto lo que vino, aunque sea vacío
    // (ej: el usuario destildó todos los estados a propósito).
    // Si es la primera carga del panel, aplico los defaults.
    const estadosSeleccionados = filtrado
      ? (req.query.estados
          ? (Array.isArray(req.query.estados) ? req.query.estados : [req.query.estados])
          : [])
      : ESTADOS_DEFAULT;

    const hoy = new Date();
    const primerDiaMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1)
      .toISOString()
      .slice(0, 10);
    const hoyStr = hoy.toISOString().slice(0, 10);
    const desdeFiltro = filtrado ? (desde || null) : primerDiaMes;
    const hastaFiltro = filtrado ? (hasta || null) : hoyStr;

    // Conteos por estado para las cards
    const conteos = await pool.query(`
      SELECT estado, COUNT(*) as total FROM prospectos GROUP BY estado
    `);
    const totales = {};
    conteos.rows.forEach((r) => (totales[r.estado] = parseInt(r.total)));
    const totalGeneral = Object.values(totales).reduce((a, b) => a + b, 0);

    // Lista de responsables para el filtro (soporte + admin activos)
    const responsables = await pool.query(
      `SELECT id, nombre FROM usuarios WHERE activo = true AND rol IN ('soporte','admin','vendedor') ORDER BY nombre`
    );

    // Filtros
    let where = [];
    let params = [];
    let i = 1;

    if (estadosSeleccionados.length) {
      where.push(`p.estado = ANY($${i++})`);
      params.push(estadosSeleccionados);
    } else {
      // ningún estado tildado => no mostrar nada
      where.push(`1=0`);
    }
    if (responsable) {
      // "responsable" = quien tiene la demo asignada, o quien cargó el prospecto si nunca hubo demo
      where.push(`COALESCE(p.demo_responsable, p.creado_por) = $${i++}`);
      params.push(responsable);
    }
    if (desdeFiltro) {
      where.push(`p.creado_en >= $${i++}`);
      params.push(desdeFiltro);
    }
    if (hastaFiltro) {
      where.push(`p.creado_en < $${i++}::date + interval '1 day'`);
      params.push(hastaFiltro);
    }
    if (buscar) {
      where.push(
        `(p.nombre_negocio ILIKE $${i} OR p.contacto ILIKE $${i} OR p.telefono ILIKE $${i})`,
      );
      params.push("%" + buscar + "%");
      i++;
    }
    const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

    // Total de filas que matchean el filtro (para el paginado)
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM prospectos p ${whereClause}`,
      params
    );
    const totalFiltrado = parseInt(countResult.rows[0].total);
    const totalPaginas = Math.max(1, Math.ceil(totalFiltrado / PAGE_SIZE));
    const paginaActual = Math.min(pagina, totalPaginas);
    const offset = (paginaActual - 1) * PAGE_SIZE;

    const limitParamIdx = i++;
    const offsetParamIdx = i++;

    const prospectos = await pool.query(
      `
      SELECT p.*, 
        uc.nombre as creado_por_nombre,
        uc.rol as creado_por_rol,
        ud.nombre as demo_responsable_nombre
      FROM prospectos p
      LEFT JOIN usuarios uc ON p.creado_por = uc.id
      LEFT JOIN usuarios ud ON p.demo_responsable = ud.id
      ${whereClause}
      ORDER BY p.actualizado_en DESC
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
    `,
      [...params, PAGE_SIZE, offset],
    );

    const rows = prospectos.rows;

    // Cards de estado (cada una tilda solo ese estado y dispara filtrado=1)
    const qsFechas = `${desdeFiltro ? "&desde=" + desdeFiltro : ""}${hastaFiltro ? "&hasta=" + hastaFiltro : ""}`;
    const cardsHtml = Object.entries(ESTADOS)
      .map(([key, meta]) => {
        const esUnico =
          estadosSeleccionados.length === 1 && estadosSeleccionados[0] === key;
        return `
      <a href="/panel?filtrado=1&estados=${key}${qsFechas}" class="stat-card ${esUnico ? "active" : ""}">
        <span class="stat-num ${meta.color}">${totales[key] || 0}</span>
        <span class="stat-label">${meta.label}</span>
      </a>
    `;
      })
      .join("");

    const todosLosEstadosQs = Object.keys(ESTADOS)
      .map((k) => `estados=${k}`)
      .join("&");
    const esTodos = estadosSeleccionados.length === Object.keys(ESTADOS).length;

    // Tabla de prospectos
    const filasHtml =
      rows.length === 0
        ? `
      <tr><td colspan="9" class="empty-row">
        <i class="ti ti-users-group"></i>
        <span>No hay prospectos${buscar ? " con esa búsqueda" : ""}</span>
      </td></tr>
    `
        : rows
          .map((p) => {
            const est = ESTADOS[p.estado] || {};
            const fecha = new Date(p.creado_en).toLocaleDateString("es-AR", {
              day: "2-digit",
              month: "2-digit",
              year: "2-digit",
            });
            return `
        <tr onclick="location.href='/prospectos/${p.id}'" class="row-link">
<td>
            <div class="prospect-contact">${esc(p.contacto || "—")}</div>
            ${p.propuesta_texto ? `<div class="prospect-next"><i class="ti ti-message-check"></i> Propuesta cargada</div>` : ""}
          </td>
          <td>${esc(p.telefono || "—")}</td>
          <td>${esc(p.rubro || "—")}</td>
          <td><span class="badge-estado ${est.color}">${est.label}</span></td>
          <td class="text-muted">${PROXIMA_ACCION[p.estado] || '—'}${p.estado === 'demo_realizada' ? ' (' + esc(responsableCierre(p)) + ')' : ''}</td>          <td class="text-muted">${ORIGEN_LABEL[p.origen] || '—'}</td>
          <td class="text-muted">${esc(p.demo_responsable_nombre || p.creado_por_nombre || "—")}</td>
          <td class="text-muted">${fecha}</td>
          <td>
          <div class="row-actions" onclick="event.stopPropagation()">
            <a href="/prospectos/${p.id}" class="btn-icon" title="Ver detalle"><i class="ti ti-eye"></i></a>
            ${p.estado === 'prospecto' ? `<a href="/prospectos/${p.id}/demo" class="btn-icon" title="Cargar demo"><i class="ti ti-presentation"></i></a>` : ''}
            ${p.estado === 'demo_coordinada' && p.zoom_join_url ? `<a href="${p.zoom_join_url}" target="_blank" class="btn-icon" title="Entrar a la reunión" onclick="event.stopPropagation()"><i class="ti ti-video"></i></a>` : ''}
            ${p.estado === 'demo_realizada' && puedeCerrar(req.session.usuario, p) ? `
              <button type="button" class="btn-icon" title="Confirmar cliente" style="color:#16a34a" onclick="abrirModalConfirmar(${p.id})"><i class="ti ti-check"></i></button>
              <button type="button" class="btn-icon" title="Marcar como perdido" style="color:#dc2626" onclick="abrirModalPerdido(${p.id})"><i class="ti ti-x"></i></button>
            ` : ''}
                        ${req.session.usuario.rol === 'admin' ? `<a href="/prospectos/${p.id}/editar" class="btn-icon" title="Editar"><i class="ti ti-pencil"></i></a>` : ''}
            ${req.session.usuario.id === 6 ? `
              <form method="POST" action="/prospectos/${p.id}/eliminar" style="display:inline" onsubmit="return confirm('¿Eliminar este prospecto? Esta acción no se puede deshacer.')">
                <button type="submit" class="btn-icon" title="Eliminar" style="color:#dc2626"><i class="ti ti-trash"></i></button>
              </form>
            ` : ''}
          </div>
          </td>
        </tr>
      `;
          })
          .join("");

    // Controles de paginado
    const paginacionHtml = totalPaginas > 1 ? `
      <div class="pagination">
        <a href="${buildUrl(req, { pagina: paginaActual - 1 })}" 
           class="btn-icon ${paginaActual <= 1 ? 'disabled' : ''}" 
           ${paginaActual <= 1 ? 'aria-disabled="true"' : ''}>
          <i class="ti ti-chevron-left"></i>
        </a>
        <span class="pagination-info">Página ${paginaActual} de ${totalPaginas} (${totalFiltrado} resultados)</span>
        <a href="${buildUrl(req, { pagina: paginaActual + 1 })}" 
           class="btn-icon ${paginaActual >= totalPaginas ? 'disabled' : ''}"
           ${paginaActual >= totalPaginas ? 'aria-disabled="true"' : ''}>
          <i class="ti ti-chevron-right"></i>
        </a>
      </div>
    ` : '';

    res.send(
      layout(
        "Panel de control",
        `
      <div class="page-header">
        <div>
          <h1 class="page-title">Panel de prospectos</h1>
          <p class="page-sub">${totalGeneral} prospectos en total</p>
        </div>
        <a href="/prospectos/nuevo" class="btn btn-primary">
          <i class="ti ti-user-plus"></i> Nuevo prospecto
        </a>
      </div>

      <div class="stats-row">
        <a href="/panel?filtrado=1&${todosLosEstadosQs}${qsFechas}" class="stat-card ${esTodos ? "active" : ""}">
          <span class="stat-num">${totalGeneral}</span>
          <span class="stat-label">Todos</span>
        </a>
        ${cardsHtml}
      </div>

      <div class="filter-bar">
  <form method="GET" action="/panel" class="filter-form">
    <input type="hidden" name="filtrado" value="1">

    <div class="filter-row filter-row-search">
      <div class="search-wrap">
        <i class="ti ti-search"></i>
        <input type="text" name="buscar" placeholder="Buscar por nombre, contacto o teléfono..." 
          value="${esc(buscar || "")}" class="search-input">
      </div>
      <select name="responsable" class="filter-select">
        <option value="">Todos los responsables</option>
        ${responsables.rows.map(u =>
          `<option value="${u.id}" ${String(responsable) === String(u.id) ? "selected" : ""}>${esc(u.nombre)}</option>`
        ).join("")}
      </select>
      <label class="periodo-field">Desde <input type="date" name="desde" value="${esc(desdeFiltro || "")}"></label>
      <label class="periodo-field">Hasta <input type="date" name="hasta" value="${esc(hastaFiltro || "")}"></label>
    </div>

    <div class="filter-row filter-row-estados">
      <span class="filter-row-label">Estados:</span>
      ${Object.entries(ESTADOS).map(([key, meta]) => `
        <label class="estado-check">
          <input type="checkbox" name="estados" value="${key}" ${estadosSeleccionados.includes(key) ? "checked" : ""}>
          ${meta.label}
        </label>
      `).join("")}
    </div>

    <div class="filter-row filter-row-actions">
      <button type="submit" class="btn btn-secondary">Filtrar</button>
      <a href="/panel" class="btn btn-ghost">Restablecer defaults</a>
    </div>
  </form>
</div>

      <div class="table-wrap">
        <table class="prospects-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Teléfono</th>
              <th>Rubro</th>
              <th>Estado</th>
              <th>Próxima acción</th>
              <th>Origen</th>
              <th>Responsable</th>
              <th>Fecha</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${filasHtml}</tbody>
        </table>
      </div>
      ${paginacionHtml}

      <div id="modal-confirmar" class="modal-overlay">
        <div class="modal-box">
          <h3><i class="ti ti-check-circle"></i> Confirmar cliente</h3>
          <form method="POST" id="form-confirmar">
            <input type="hidden" name="estado" value="confirmado">
            <div class="field">
              <label>Módulos contratados <span class="opc">(opcional)</span></label>
              <input type="text" name="modulos_contratados" placeholder="Ej: POS, Facturación electrónica, Cuentas corrientes">
            </div>
            <div class="field">
              <label>Condiciones comerciales <span class="opc">(opcional)</span></label>
              <textarea name="condiciones_comerciales" placeholder="Plan, forma de pago, descuentos acordados..."></textarea>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn btn-ghost" onclick="cerrarModal('modal-confirmar')">Cancelar</button>
              <button type="submit" class="btn btn-success"><i class="ti ti-check"></i> Confirmar cliente</button>
            </div>
          </form>
        </div>
      </div>

      <div id="modal-perdido" class="modal-overlay">
        <div class="modal-box">
          <h3><i class="ti ti-x-circle"></i> Marcar como perdido</h3>
          <form method="POST" id="form-perdido">
            <input type="hidden" name="estado" value="perdido">
            <div class="field">
              <label>Motivo <span class="opc">(opcional)</span></label>
              <input type="text" name="motivo_perdida" placeholder="Ej: eligió otro sistema, precio, no responde...">
            </div>
            <div class="modal-actions">
              <button type="button" class="btn btn-ghost" onclick="cerrarModal('modal-perdido')">Cancelar</button>
              <button type="submit" class="btn btn-danger"><i class="ti ti-x"></i> Marcar como perdido</button>
            </div>
          </form>
        </div>
      </div>

      <style>
        .modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); align-items:center; justify-content:center; z-index:1000; }
        .modal-overlay.open { display:flex; }
        .modal-box { background:#fff; border-radius:10px; padding:24px; width:100%; max-width:440px; box-shadow:0 10px 40px rgba(0,0,0,0.2); }
        .modal-box h3 { margin-top:0; margin-bottom:16px; display:flex; align-items:center; gap:8px; }
        .modal-box .field { margin-bottom:14px; }
        .modal-box .req { color:#dc2626; }
        .modal-box .opc { color:#6b7280; font-weight:normal; font-size:0.85em; }
        .modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:8px; }
        .badge-estado.yellow { background:#fef9c3; color:#854d0e; }
        .stat-num.yellow { color:#854d0e; }
        .estados-check-group { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
        .estado-check { display:flex; align-items:center; gap:4px; font-size:0.85em; white-space:nowrap; }
        .periodo-group { display:flex; gap:10px; align-items:center; font-size:0.85em; }
        .periodo-group input[type="date"] { padding:4px 6px; }
      </style>

      <script>
        function abrirModalConfirmar(id) {
          document.getElementById('form-confirmar').action = '/prospectos/' + id + '/estado';
          document.getElementById('modal-confirmar').classList.add('open');
        }
        function abrirModalPerdido(id) {
          document.getElementById('form-perdido').action = '/prospectos/' + id + '/estado';
          document.getElementById('modal-perdido').classList.add('open');
        }
        function cerrarModal(id) {
          document.getElementById(id).classList.remove('open');
        }
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
          overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cerrarModal(overlay.id);
          });
        });
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

function buildUrl(req, overrides) {
  const params = new URLSearchParams();
  Object.entries(req.query).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      v.forEach((val) => params.append(k, val));
    } else if (v !== undefined) {
      params.append(k, v);
    }
  });
  Object.entries(overrides).forEach(([k, v]) => {
    params.delete(k);
    params.append(k, v);
  });
  return `/panel?${params.toString()}`;
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = router;