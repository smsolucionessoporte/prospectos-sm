const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { requireAuth, layout } = require("../middleware/auth");
const { responsableCierre } = require('./prospectos');

const ESTADOS = {
  prospecto: { label: "Prospecto", color: "gray" },
  demo_coordinada: { label: "Demo coordinada", color: "blue" },
  demo_realizada: { label: "Demo realizada", color: "purple" },
  confirmado: { label: "Confirmado ✓", color: "green" },
  perdido: { label: "Perdido", color: "red" },
};

// Estados tildados por defecto la primera vez que se entra al panel
// (todos menos perdido y sin_respuesta)
const ESTADOS_DEFAULT = Object.keys(ESTADOS).filter(
  (k) =>
    k !== "perdido" &&
    k !== "sin_respuesta" &&
    k !== "confirmado"
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
  return true;
}

const ORIGEN_LABEL = {
  'manual': 'Manual',
  'prospecto-redes': '📱 Redes',
  'prospecto-interno': '💬 Interno',
};

router.get("/panel", requireAuth, async (req, res) => {
  try {
    const { buscar, desde, hasta, filtrado } = req.query;

    const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
    const porPagina = 20;
    const offset = (pagina - 1) * porPagina;
    // soporte y vendedor solo ven sus propios prospectos (donde son demo_responsable,
    // o creado_por si nunca hubo demo) y no pueden filtrar por otro responsable
    const usuarioSesion = req.session.usuario;
    const vistaRestringida = usuarioSesion.rol === "soporte" || usuarioSesion.rol === "vendedor";
    const responsable = vistaRestringida ? String(usuarioSesion.id) : req.query.responsable;

    // Si el form ya fue enviado (filtrado=1), respeto lo que vino, aunque sea vacío
    // (ej: el usuario destildó todos los estados a propósito).
    // Si es la primera carga del panel, aplico los defaults.
    const estadosSeleccionados = filtrado
      ? (req.query.estados
          ? (Array.isArray(req.query.estados) ? req.query.estados : [req.query.estados])
          : [])
      : ESTADOS_DEFAULT;

      const hoy = new Date();
      const hoyStr = hoy.toISOString().slice(0, 10);

      // Por defecto: SIEMPRE
      // Sin fecha "desde" = desde el primer registro existente.
      const desdeFiltro = desde || null;
      const hastaFiltro = hasta || hoyStr;

    // Conteos por estado para las cards — respetan el período seleccionado
    // (no el filtro de estados, para que las cards sigan mostrando el desglose completo)
    let conteosWhere = [];
    let conteosParams = [];
    let ci = 1;
    if (desdeFiltro) {
      conteosWhere.push(`creado_en >= $${ci++}`);
      conteosParams.push(desdeFiltro);
    }
    if (hastaFiltro) {
      conteosWhere.push(`creado_en < $${ci++}::date + interval '1 day'`);
      conteosParams.push(hastaFiltro);
    }
    const conteosWhereClause = conteosWhere.length ? "WHERE " + conteosWhere.join(" AND ") : "";
    const conteos = await pool.query(
      `SELECT estado, COUNT(*) as total FROM prospectos ${conteosWhereClause} GROUP BY estado`,
      conteosParams
    );
    const totales = {};
    conteos.rows.forEach((r) => (totales[r.estado] = parseInt(r.total)));
    const totalGeneral = Object.values(totales).reduce((a, b) => a + b, 0);

    // Lista de responsables para el filtro (soporte + admin activos).
    // No hace falta si el usuario tiene vista restringida (no puede elegir otro responsable).
    const responsables = vistaRestringida
      ? { rows: [] }
      : await pool.query(
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

    // Traigo todos los prospectos que matchean el filtro (sin paginado, ya que
    // el filtro por período acota el volumen). Ordeno por fecha de actualización
    // y después agrupo por estado en JS respetando el orden de ESTADOS.
    const totalResult = await pool.query(
      `SELECT COUNT(*) AS total
      FROM prospectos p
      ${whereClause}`,
      params
    );

    const totalFiltrado = parseInt(totalResult.rows[0].total);
    const totalPaginas = Math.max(1, Math.ceil(totalFiltrado / porPagina));

    function crearUrlPagina(nuevaPagina) {
        const qs = new URLSearchParams();

        qs.set("filtrado", "1");
        qs.set("pagina", String(nuevaPagina));

        if (buscar) qs.set("buscar", buscar);
        if (responsable && !vistaRestringida) {
          qs.set("responsable", responsable);
        }

        if (desdeFiltro) qs.set("desde", desdeFiltro);
        if (hastaFiltro) qs.set("hasta", hastaFiltro);

        estadosSeleccionados.forEach(estado => {
          qs.append("estados", estado);
        });

        return "/panel?" + qs.toString();
      }

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
        LIMIT $${i} OFFSET $${i + 1}
      `,
      [...params, porPagina, offset]
    );

    const rows = prospectos.rows;

    // Agrupo las filas por estado, respetando el orden definido en ESTADOS
    const gruposPorEstado = {};
    rows.forEach((p) => {
      if (!gruposPorEstado[p.estado]) gruposPorEstado[p.estado] = [];
      gruposPorEstado[p.estado].push(p);
    });

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

    // Cantidad de filtros "no default" activos, para el badge del botón Filtros
    let filtrosActivosCount = 0;
    if (responsable && !vistaRestringida) filtrosActivosCount++;
    if (
      estadosSeleccionados.length !== ESTADOS_DEFAULT.length ||
      !ESTADOS_DEFAULT.every((e) => estadosSeleccionados.includes(e))
    ) {
      filtrosActivosCount++;
    }

    // Filas de una fila individual (misma estructura que antes)
    function filaHtml(p) {
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
            ${p.estado === 'prospecto' ? `
              <button type="button" class="btn-icon" title="Marcar como perdido" style="color:#dc2626" onclick="abrirModalPerdido(${p.id})"><i class="ti ti-x"></i></button>
            ` : ''}
            ${p.estado === 'demo_coordinada' && p.zoom_join_url ? `<a href="${p.zoom_join_url}" target="_blank" class="btn-icon" title="Entrar a la reunión" onclick="event.stopPropagation()"><i class="ti ti-video"></i></a>` : ''}
            ${p.estado === 'demo_realizada' ? `
                <button type="button" class="btn-icon" title="Confirmar cliente" style="color:#16a34a" onclick="abrirModalConfirmar(${p.id})"><i class="ti ti-check"></i></button>
              <button type="button" class="btn-icon" title="Marcar como perdido" style="color:#dc2626" onclick="abrirModalPerdido(${p.id})"><i class="ti ti-x"></i></button>
            ` : ''}
              <a href="/prospectos/${p.id}/editar" class="btn-icon" title="Editar"><i class="ti ti-pencil"></i></a>            
              ${req.session.usuario.id === 6 ? `
              
                <form method="POST" action="/prospectos/${p.id}/eliminar" style="display:inline" onsubmit="return confirm('¿Eliminar este prospecto? Esta acción no se puede deshacer.')">
                <button type="submit" class="btn-icon" title="Eliminar" style="color:#dc2626"><i class="ti ti-trash"></i></button>
              </form>
            ` : ''}
          </div>
          </td>
        </tr>
      `;
    }

    // Tabla de prospectos, agrupada por estado (respetando el orden de ESTADOS)
    // y mostrando solo los grupos que tienen filas.
    const filasHtml =
      rows.length === 0
        ? `
      <tr><td colspan="9" class="empty-row">
        <i class="ti ti-users-group"></i>
        <span>No hay prospectos${buscar ? " con esa búsqueda" : ""}</span>
      </td></tr>
    `
        : Object.keys(ESTADOS)
            .filter((estadoKey) => gruposPorEstado[estadoKey] && gruposPorEstado[estadoKey].length)
            .map((estadoKey) => {
              const meta = ESTADOS[estadoKey];
              const grupo = gruposPorEstado[estadoKey];
              const headerRow = `
        <tr class="group-header-row">
          <td colspan="9">
            <div class="group-header">
              <span class="badge-estado ${meta.color}">${meta.label}</span>
              <span class="group-count">${grupo.length}</span>
            </div>
          </td>
        </tr>
      `;
              return headerRow + grupo.map(filaHtml).join("");
            })
            .join("");

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

          <div class="filter-periodo-row">
            <span class="periodo-title">
              <i class="ti ti-calendar"></i> Período
            </span>

            <button
              type="button"
              class="periodo-siempre ${!desdeFiltro ? 'active' : ''}"
              onclick="this.form.desde.value=''; this.form.hasta.value='${hoyStr}'; this.form.submit();">
              Siempre
            </button>

            <label class="periodo-field">
              <span>Desde</span>
              <input type="date" name="desde"
                class="${desdeFiltro ? 'periodo-activo' : ''}"
                value="${esc(desdeFiltro || "")}">
            </label>

            <label class="periodo-field">
              <span>Hasta</span>
              <input type="date" name="hasta"
                class="${desdeFiltro ? 'periodo-activo' : ''}"
                value="${esc(hastaFiltro || "")}">            
            </label>
          </div>

          <div class="filter-row-search">
            <div class="search-wrap">
              <input
                type="text"
                name="buscar"
                placeholder="Buscar por nombre, contacto o teléfono..."
                value="${esc(buscar || "")}"
                class="search-input">
            </div>

            <button type="button" class="btn btn-secondary" onclick="abrirModalFiltros()">
              <i class="ti ti-filter"></i>
              Filtros${filtrosActivosCount > 0 ? ` <span class="filtros-badge">${filtrosActivosCount}</span>` : ''}
            </button>

            <button type="submit" class="btn btn-primary">
              <i class="ti ti-search"></i> Buscar
            </button>
          </div>

         
          <div id="modal-filtros" class="modal-overlay">
            <div class="modal-box">
              <h3><i class="ti ti-filter"></i> Filtros</h3>

              ${vistaRestringida ? '' : `
              <div class="field">
                <label>Responsable</label>
                <select name="responsable" class="filter-select">
                  <option value="">Todos los responsables</option>
                  ${responsables.rows.map(u =>
                    `<option value="${u.id}" ${String(responsable) === String(u.id) ? "selected" : ""}>${esc(u.nombre)}</option>`
                  ).join("")}
                </select>
              </div>
              `}

  
              <div class="field">
                <label>Estados</label>
                <div class="filter-row-estados">
                  ${Object.entries(ESTADOS).map(([key, meta]) => `
                    <label class="estado-check">
                      <input type="checkbox" name="estados" value="${key}" ${estadosSeleccionados.includes(key) ? "checked" : ""}>
                      ${meta.label}
                    </label>
                  `).join("")}
                </div>
              </div>

              <div class="modal-actions">
                <a href="/panel" class="btn btn-ghost">Limpiar</a>
                <button type="submit" class="btn btn-secondary">Filtrar</button>
              </div>
            </div>
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
      <p class="results-count">${totalFiltrado} resultado${totalFiltrado === 1 ? '' : 's'}</p>

        ${totalPaginas > 1 ? `
          <div class="pagination">

            ${pagina > 1 ? `
              <a class="btn btn-secondary" href="${crearUrlPagina(pagina - 1)}">
                <i class="ti ti-chevron-left"></i> Anterior
              </a>
            ` : ''}

            <div class="pagination-pages">
              ${Array.from({ length: totalPaginas }, (_, idx) => idx + 1)
                .filter(n => n === 1 || n === totalPaginas || Math.abs(n - pagina) <= 2)
                .map((n, idx, arr) => {
                  const anterior = arr[idx - 1];
                  const puntos = anterior && n - anterior > 1
                    ? `<span class="pagination-dots">…</span>`
                    : '';

                  return puntos + `
                    <a href="${crearUrlPagina(n)}"
                      class="pagination-page ${n === pagina ? 'active' : ''}">
                      ${n}
                    </a>
                  `;
                }).join('')}
            </div>

            ${pagina < totalPaginas ? `
              <a class="btn btn-secondary" href="${crearUrlPagina(pagina + 1)}">
                Siguiente <i class="ti ti-chevron-right"></i>
              </a>
            ` : ''}

          </div>
        ` : ''}

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
              <label>Motivo</label>
              <select name="motivo_perdida" id="motivo-perdida" required onchange="toggleOtroPerdida()">
                <option value="">Seleccionar motivo...</option>
                <option value="Sin respuesta">Sin respuesta</option>
                <option value="Económico">Económico</option>
                <option value="Eligió otro sistema">Eligió otro sistema</option>
                <option value="Falta de tiempo">Falta de tiempo</option>
                <option value="Otro">Otro</option>
              </select>
            </div>
            <div class="field" id="otro-perdida-wrap" style="display:none">
              <label>Aclarar motivo</label>
              <input type="text" name="motivo_perdida_otro" id="motivo-perdida-otro" placeholder="Aclarar el motivo...">
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
        .stats-row { flex-wrap: wrap; gap: 10px; }
        .stat-card { min-width: 110px; }

        .filter-bar {
          background: #fff;
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          padding: 14px 16px;
          margin-bottom: 16px;
        }
        .filter-form { display: flex; flex-direction: column; gap: 12px; }

        .filter-row-search { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
        .filter-row-search .search-wrap { flex: 1 1 240px; }


        .filtros-badge {
          background: #4338ca; color: #fff; border-radius: 999px;
          font-size: 0.72em; padding: 1px 7px; margin-left: 4px;
        }

        .modal-box .field { text-align: left; }
        .modal-box .field label { display: block; font-size: 0.82em; color: #64748b; font-weight: 600; margin-bottom: 6px; }
        .modal-box .filter-select { width: 100%; }

        .filter-row-estados { display: flex; flex-wrap: wrap; gap: 8px; }
        .estado-check {
          display: flex; align-items: center; gap: 5px;
          font-size: 0.82em; white-space: nowrap;
          background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 999px;
          padding: 5px 10px; cursor: pointer;
        }

        .estado-check:has(input:checked) {
          background: #eef2ff; border-color: #c7d2fe; color: #4338ca; font-weight: 600;
        }

        .group-header-row td {
          background: #f8fafc;
          border-top: 1px solid #e2e8f0;
          border-bottom: 1px solid #e2e8f0;
          padding: 8px 12px;
          cursor: default;
        }
        .group-header-row:hover td { background: #f8fafc; }
        .group-header {
          display: flex; align-items: center; gap: 8px;
        }
        .group-count {
          color: #64748b; font-size: 0.82em; font-weight: 600;
        }
        .results-count {
          color: #64748b; font-size: 0.85em; margin-top: 8px;
        }

        .pagination {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          margin: 18px 0 8px;
        }

        .pagination-pages {
          display: flex;
          align-items: center;
          gap: 5px;
        }

        .pagination-page {
          min-width: 34px;
          height: 34px;
          padding: 0 8px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid #e2e8f0;
          border-radius: 7px;
          background: #fff;
          color: #475569;
          text-decoration: none;
          font-size: 0.85em;
        }

        .pagination-page:hover {
          background: #f8fafc;
        }

        .pagination-page.active {
          background: #4338ca;
          border-color: #4338ca;
          color: #fff;
          font-weight: 600;
        }

        .pagination-dots {
          color: #94a3b8;
          padding: 0 3px;
        }

        .filter-periodo-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding-bottom: 12px;
          border-bottom: 1px solid #eef2f7;
        }

        .periodo-title {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 0.82em;
          font-weight: 600;
          color: #475569;
          margin-right: 2px;
        }

        .periodo-siempre {
          height: 34px;
          padding: 0 14px;
          border: 1px solid #d1d5db;
          border-radius: 7px;
          background: #fff;
          color: #475569;
          cursor: pointer;
          font-size: 0.82em;
        }

        .periodo-siempre.active {
          background: #eef2ff;
          border-color: #6366f1;
          color: #4338ca;
          font-weight: 600;
        }

        .periodo-field {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.8em;
          color: #64748b;
        }

        .periodo-field input[type="date"] {
          height: 34px;
          padding: 0 8px;
          border: 1px solid #d1d5db;
          border-radius: 7px;
          background: #fff;
          font-size: 0.9em;
        }

        .periodo-field input.periodo-activo {
        border-color: #8b5cf6;
        background: #f5f3ff;
        color: #6d28d9;
        font-weight: 600;
        }

        .filter-row-search {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .filter-row-search .search-wrap {
          flex: 1;
        }

        .search-input {
          width: 100%;
        }
        .pagination {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 14px;
          margin: 18px 0;
        }

        .pagination-info {
          font-size: 0.85em;
          color: #64748b;
        }

        }
        @media (max-width: 720px) {
          .filter-row-search { flex-direction: column; align-items: stretch; }
        }

      
      </style>

      <script>
        function abrirModalFiltros() {
          document.getElementById('modal-filtros').classList.add('open');
        }
        function abrirModalConfirmar(id) {
          document.getElementById('form-confirmar').action = '/prospectos/' + id + '/estado';
          document.getElementById('modal-confirmar').classList.add('open');
        }
        function abrirModalPerdido(id) {
          document.getElementById('form-perdido').action = '/prospectos/' + id + '/estado';
          document.getElementById('motivo-perdida').value = '';
          document.getElementById('motivo-perdida-otro').value = '';
          toggleOtroPerdida();
          document.getElementById('modal-perdido').classList.add('open');
        }
        function toggleOtroPerdida() {
          const motivo = document.getElementById('motivo-perdida');
          const wrap = document.getElementById('otro-perdida-wrap');
          const otro = document.getElementById('motivo-perdida-otro');
          const esOtro = motivo && motivo.value === 'Otro';
          if (wrap) wrap.style.display = esOtro ? 'block' : 'none';
          if (otro) otro.required = esOtro;
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

function crearUrlPagina(nuevaPagina) {
  const qs = new URLSearchParams();

  qs.set("filtrado", "1");
  qs.set("pagina", String(nuevaPagina));

  if (buscar) qs.set("buscar", buscar);
  if (desdeFiltro) qs.set("desde", desdeFiltro);
  if (hastaFiltro) qs.set("hasta", hastaFiltro);
  if (responsable && !vistaRestringida) qs.set("responsable", responsable);

  estadosSeleccionados.forEach(estado => {
    qs.append("estados", estado);
  });

  return "/panel?" + qs.toString();
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = router;