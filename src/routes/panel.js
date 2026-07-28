const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { requireAuth, layout } = require("../middleware/auth");

const ESTADOS = {
  prospecto: { label: "Prospecto", color: "gray" },
  demo_coordinada: { label: "Demo coordinada", color: "blue" },
  demo_realizada: { label: "Demo realizada", color: "purple" },
  propuesta_enviada: { label: "Propuesta enviada", color: "orange" },
  confirmado: { label: "Confirmado ✓", color: "green" },
  perdido: { label: "Perdido", color: "red" },
};

const PROXIMA_ACCION = {
  prospecto: "Coordinar demo",
  demo_coordinada: "Realizar demo",
  demo_realizada: "Enviar propuesta",
  propuesta_enviada: "Esperar respuesta",
  confirmado: "Implementación",
  perdido: "Sin acción",
};

const ORIGEN_LABEL = {
  'manual': 'Manual',
  'prospecto-redes': '📱 Redes',
  'prospecto-interno': '💬 Interno',
};

const PAGE_SIZE = 20;

router.get("/panel", requireAuth, async (req, res) => {
  try {
    const { estado, buscar, interes, responsable } = req.query;
    const pagina = Math.max(1, parseInt(req.query.pagina) || 1);

    // Conteos por estado para las cards
    const conteos = await pool.query(`
      SELECT estado, COUNT(*) as total FROM prospectos GROUP BY estado
    `);
    const totales = {};
    conteos.rows.forEach((r) => (totales[r.estado] = parseInt(r.total)));
    const totalGeneral = Object.values(totales).reduce((a, b) => a + b, 0);

    // Lista de responsables para el filtro (soporte + admin activos)
    const responsables = await pool.query(
      `SELECT id, nombre FROM usuarios WHERE activo = true AND rol IN ('soporte','admin') ORDER BY nombre`
    );

    // Filtros
    let where = [];
    let params = [];
    let i = 1;
    if (estado) {
      where.push(`p.estado = $${i++}`);
      params.push(estado);
    }
    if (interes) {
      where.push(`p.nivel_interes = $${i++}`);
      params.push(interes);
    }
    if (responsable) {
      // "responsable" = quien tiene la demo asignada, o quien cargó el prospecto si nunca hubo demo
      where.push(`COALESCE(p.demo_responsable, p.creado_por) = $${i++}`);
      params.push(responsable);
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

    // Cards de estado
    const cardsHtml = Object.entries(ESTADOS)
      .map(
        ([key, meta]) => `
      <a href="/panel?estado=${key}" class="stat-card ${estado === key ? "active" : ""}">
        <span class="stat-num ${meta.color}">${totales[key] || 0}</span>
        <span class="stat-label">${meta.label}</span>
      </a>
    `,
      )
      .join("");

    // Tabla de prospectos
    const filasHtml =
      rows.length === 0
        ? `
      <tr><td colspan="10" class="empty-row">
        <i class="ti ti-users-group"></i>
        <span>No hay prospectos${estado ? " en este estado" : ""}${buscar ? " con esa búsqueda" : ""}</span>
      </td></tr>
    `
        : rows
          .map((p) => {
            const est = ESTADOS[p.estado] || {};
            const intBadge = p.nivel_interes
              ? `<span class="badge-interes ${p.nivel_interes}">${{ alto: "🔥 Alto", medio: "👀 Medio", bajo: "❄️ Bajo" }[
              p.nivel_interes
              ] || p.nivel_interes
              }</span>`
              : '<span class="text-muted">—</span>';
            const fecha = new Date(p.creado_en).toLocaleDateString("es-AR", {
              day: "2-digit",
              month: "2-digit",
              year: "2-digit",
            });
            return `
        <tr onclick="location.href='/prospectos/${p.id}'" class="row-link">
<td>
            <div class="prospect-contact">${esc(p.contacto || "—")}</div>
            ${p.proxima_accion ? `<div class="prospect-next"><i class="ti ti-player-play"></i> ${esc(p.proxima_accion)}</div>` : ""}
          </td>
          <td>${esc(p.telefono || "—")}</td>
          <td>${esc(p.rubro || "—")}</td>
          <td><span class="badge-estado ${est.color}">${est.label}</span></td>
          <td class="text-muted">${PROXIMA_ACCION[p.estado] || '—'}</td>
          <td class="text-muted">${ORIGEN_LABEL[p.origen] || '—'}</td>
          <td>${intBadge}</td>
          <td class="text-muted">${esc(p.demo_responsable_nombre || p.creado_por_nombre || "—")}</td>
          <td class="text-muted">${fecha}</td>
          <td>
          <div class="row-actions" onclick="event.stopPropagation()">
            <a href="/prospectos/${p.id}" class="btn-icon" title="Ver detalle"><i class="ti ti-eye"></i></a>
            ${p.estado === 'prospecto' ? `<a href="/prospectos/${p.id}/demo" class="btn-icon" title="Cargar demo"><i class="ti ti-presentation"></i></a>` : ''}
            ${p.estado === 'demo_coordinada' && p.zoom_join_url ? `<a href="${p.zoom_join_url}" target="_blank" class="btn-icon" title="Entrar a la reunión" onclick="event.stopPropagation()"><i class="ti ti-video"></i></a>` : ''}
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
        <a href="/panel" class="stat-card ${!estado ? "active" : ""}">
          <span class="stat-num">${totalGeneral}</span>
          <span class="stat-label">Todos</span>
        </a>
        ${cardsHtml}
      </div>

      <div class="filter-bar">
        <form method="GET" action="/panel" class="filter-form">
          <div class="search-wrap">
            <i class="ti ti-search"></i>
            <input type="text" name="buscar" placeholder="Buscar por nombre, contacto o teléfono..." 
              value="${esc(buscar || "")}" class="search-input">
          </div>
          <select name="estado" class="filter-select">
            <option value="">Todos los estados</option>
            ${Object.entries(ESTADOS).map(([key, meta]) =>
              `<option value="${key}" ${estado === key ? "selected" : ""}>${meta.label}</option>`
            ).join("")}
          </select>
          <select name="responsable" class="filter-select">
            <option value="">Todos los responsables</option>
            ${responsables.rows.map(u =>
              `<option value="${u.id}" ${String(responsable) === String(u.id) ? "selected" : ""}>${esc(u.nombre)}</option>`
            ).join("")}
          </select>
          <select name="interes" class="filter-select">
            <option value="">Todos los intereses</option>
            <option value="alto" ${interes === "alto" ? "selected" : ""}>🔥 Alto</option>
            <option value="medio" ${interes === "medio" ? "selected" : ""}>👀 Medio</option>
            <option value="bajo" ${interes === "bajo" ? "selected" : ""}>❄️ Bajo</option>
          </select>
          <button type="submit" class="btn btn-secondary">Filtrar</button>
          ${buscar || interes || responsable || estado ? '<a href="/panel" class="btn btn-ghost">Limpiar</a>' : ""}
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
              <th>Interés</th>
              <th>Responsable</th>
              <th>Fecha</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${filasHtml}</tbody>
        </table>
      </div>
      ${paginacionHtml}
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
  const params = new URLSearchParams(req.query);
  Object.entries(overrides).forEach(([k, v]) => params.set(k, v));
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