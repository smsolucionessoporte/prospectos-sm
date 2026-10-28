'use strict';

// demo_fecha es TIMESTAMP WITHOUT TIME ZONE en PostgreSQL: representa
// fecha/hora local de Argentina. No compararla como si fuese UTC.
function instanteDemoAR(fecha) {
  if (!fecha) return null;
  let isoLocal;
  if (fecha instanceof Date) {
    if (Number.isNaN(fecha.getTime())) return null;
    // Con pg en Railway (TZ=UTC), el timestamp sin zona llega como Date UTC.
    isoLocal = fecha.toISOString().slice(0, 19);
  } else {
    const texto = String(fecha).trim();
    const local = texto.match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d)(?::(\d\d))?$/);
    if (local) isoLocal = `${local[1]}T${local[2]}:${local[3] || '00'}`;
    else {
      const fechaReal = new Date(texto);
      return Number.isFinite(fechaReal.getTime()) ? fechaReal.getTime() : null;
    }
  }
  const instante = Date.parse(`${isoLocal}-03:00`);
  return Number.isFinite(instante) ? instante : null;
}

function pasoPorEstado(estado, demoFecha, ahora = Date.now()) {
  switch (String(estado || '').trim().toLowerCase()) {
    case 'prospecto':
      return { accion: 'Coordinar demo', tipo: 'demo', terminal: false };
    case 'sin_respuesta':
      return { accion: 'Reintentar contacto', tipo: 'seguimiento', terminal: false };
    case 'demo_coordinada': {
      const instante = instanteDemoAR(demoFecha);
      if (!instante) return { accion: 'Confirmar fecha de la demo', tipo: 'demo', terminal: false };
      return ahora < instante
        ? { accion: 'Dar demo', tipo: 'demo', vencimiento: instante, terminal: false, demoVencida: false }
        : { accion: 'Cargar relevamiento o reagendar', tipo: 'demo', vencimiento: instante, terminal: false, demoVencida: true };
    }
    case 'demo_realizada':
      return { accion: 'Cerrar cliente', tipo: 'cierre', terminal: false };
    case 'confirmado':
    case 'perdido':
      return { accion: null, tipo: null, terminal: true };
    default:
      return { accion: 'Revisar estado comercial', tipo: 'seguimiento', terminal: false };
  }
}

module.exports = { instanteDemoAR, pasoPorEstado };
