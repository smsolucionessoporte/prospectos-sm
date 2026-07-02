const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, layout } = require('../middleware/auth');

const ESTADOS = {
  prospecto:         { label: 'Prospecto',         color: 'gray' },
  demo_coordinada:   { label: 'Demo coordinada',   color: 'blue' },
  demo_realizada:    { label: 'Demo realizada',     color: 'purple' },
  propuesta_enviada: { label: 'Propuesta enviada', color: 'orange' },
  confirmado:        { label: 'Confirmado ✓',      color: 'green' },
  perdido:           { label: 'Perdido',            color: 'red' },
};

router.get('/panel', requireAuth, async (req, res) => {
  try {
    const { estado, buscar, interes } = req.query;

    // Conteos por estado para las cards
    const conteos = await pool.query(`
      SELECT estado, COUNT(*) as total FROM prospectos GROUP BY estado
    `);
    const totales = {};
    conteos.rows.forEach(r => totales[r.estado] = parseInt(r.total));
    const totalGeneral = Object.values(totales).reduce((a, b) => a + b, 0);

    // Lista filtrada
    let where = [];
    let params = [];
    let i = 1;
    if (estado) { where.push(`p.estado = $${i++}`); params.push(estado); }
    if (interes) { where.push(`p.nivel_interes = $${i++}`); params.push(interes); }
    if (buscar) {
      where.push(`(p.nombre_negocio ILIKE $${i} OR p.contacto ILIKE $${i} OR p.telefono ILIKE $${i})`);
      params.push('%' + buscar + '%'); i++;
    }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const prospectos = await pool.query(`
      SELECT p.*, 
        uc.nombre as creado_por_nombre,
        ud.nombre as demo_responsable_nombre
      FROM prospectos p
      LEFT JOIN usuarios uc ON p.creado_por = uc.id
      LEFT JOIN usuarios ud ON p.demo_responsable = ud.id
      ${whereClause}
      ORDER BY p.actualizado_en DESC
    `, params);

    const rows = prospectos.rows;

    // Cards de estado
    const cardsHtml = Object.entries(ESTADOS).map(([key, meta]) => `
      <a href="/panel?estado=${key}" class="stat-card ${estado === key ? 'active' : ''}">
        <span class="stat-num ${meta.color}">${totales[key] || 0}</span>
        <span class="stat-label">${meta.label}</span>
      </a>
    `).join('');

    // Tabla de prospectos
    const filasHtml = rows.length === 0 ? `
      <tr><td colspan="7" class="empty-row">
        <i class="ti ti-users-group"></i>
        <span>No hay prospectos${estado ? ' en este estado' : ''}${buscar ? ' con esa búsqueda' : ''}</span>
      </td></tr>
    ` : rows.map(p => {
      const est = ESTADOS[p.estado] || {};
      const intBadge = p.nivel_interes ? `<span class="badge-interes ${p.nivel_interes}">${
        {alto:'🔥 Alto', medio:'👀 Medio', bajo:'❄️ Bajo'}[p.nivel_interes] || p.nivel_interes
      }</span>` : '<span class="text-muted">—</span>';
      const fecha = new Date(p.creado_en).toLocaleDateString('es-AR', {day:'2-digit',month:'2-digit',year:'2-digit'});
      return `
        <tr onclick="location.href='/prospectos/${p.id}'" class="row-link">
<td>
            <div class="prospect-name">${esc(p.nombre_negocio)}</div>
            <div class="prospect-contact">${esc(p.contacto || '—')}</div>
            ${p.proxima_accion ? `<div class="prospect-next"><i class="ti ti-player-play"></i> ${esc(p.proxima_accion)}</div>` : ''}
          </td>
          <td>${esc(p.rubro || '—')}</td>
          <td><span class="badge-estado ${est.color}">${est.label}</span></td>
          <td>${intBadge}</td>
          <td class="text-muted">${esc(p.creado_por_nombre || '—')}</td>
          <td class="text-muted">${fecha}</td>
          <td>
     <div class="row-actions" onclick="event.stopPropagation()">
              <a href="/prospectos/${p.id}" class="btn-icon" title="Ver detalle"><i class="ti ti-eye"></i></a>
              ${p.estado === 'prospecto' ? `<a href="/prospectos/${p.id}/demo" class="btn-icon" title="Cargar demo"><i class="ti ti-presentation"></i></a>` : ''}
              ${req.session.usuario.rol === 'admin' ? `<a href="/prospectos/${p.id}/editar" class="btn-icon" title="Editar"><i class="ti ti-pencil"></i></a>` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');

    res.send(layout('Panel de control', `
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
        <a href="/panel" class="stat-card ${!estado ? 'active' : ''}">
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
              value="${esc(buscar || '')}" class="search-input">
          </div>
          ${estado ? `<input type="hidden" name="estado" value="${esc(estado)}">` : ''}
          <select name="interes" class="filter-select">
            <option value="">Todos los intereses</option>
            <option value="alto" ${interes==='alto'?'selected':''}>🔥 Alto</option>
            <option value="medio" ${interes==='medio'?'selected':''}>👀 Medio</option>
            <option value="bajo" ${interes==='bajo'?'selected':''}>❄️ Bajo</option>
          </select>
          <button type="submit" class="btn btn-secondary">Filtrar</button>
          ${buscar || interes ? '<a href="/panel" class="btn btn-ghost">Limpiar</a>' : ''}
        </form>
      </div>

      <div class="table-wrap">
        <table class="prospects-table">
          <thead>
            <tr>
              <th>Negocio / Contacto</th>
              <th>Rubro</th>
              <th>Estado</th>
              <th>Interés</th>
              <th>Cargado por</th>
              <th>Fecha</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${filasHtml}</tbody>
        </table>
      </div>
    `, req));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error interno');
  }
});

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = router;
