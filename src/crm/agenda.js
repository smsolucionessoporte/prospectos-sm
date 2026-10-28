'use strict';
const { pasoPorEstado } = require('./pasos');

// Una sola fila por oportunidad/conversación. El mensaje pendiente y el
// seguimiento no son estados excluyentes: ambos pueden requerir acción.
const fechaMs = valor => {
  if (!valor) return 0;
  const tiempo = new Date(valor).getTime();
  return Number.isFinite(tiempo) ? tiempo : 0;
};
const idValido = valor => Number.isSafeInteger(Number(valor)) && Number(valor) > 0;
const llave = (prospectoId, conversacionId) => idValido(prospectoId)
  ? `prospecto:${Number(prospectoId)}`
  : `chat:${Number(conversacionId)}`;

function seleccionarAgendaHoy({ oportunidades = [], tareas = [], mensajes = [], ahora = Date.now() } = {}) {
  const chatAProspecto = new Map();
  for (const fila of [...oportunidades, ...mensajes]) {
    if (idValido(fila.chatwoot_conversation_id) && idValido(fila.prospecto_id)) {
      chatAProspecto.set(Number(fila.chatwoot_conversation_id), Number(fila.prospecto_id));
    }
  }
  // Un chat puede haber tenido tareas creadas antes de vincularlo a su ficha.
  // Relacionarlas evita una segunda fila para la misma persona.
  const tareasVinculadas = tareas.map(tarea => (!idValido(tarea.prospecto_id) &&
    chatAProspecto.has(Number(tarea.chatwoot_conversation_id)))
    ? {...tarea, prospecto_id: chatAProspecto.get(Number(tarea.chatwoot_conversation_id))} : tarea);
  const tareasPorProspecto = new Map();
  const tareasPorChat = new Map();
  for (const tarea of tareasVinculadas) {
    const mapa = idValido(tarea.prospecto_id) ? tareasPorProspecto : tareasPorChat;
    const clave = idValido(tarea.prospecto_id) ? Number(tarea.prospecto_id) : Number(tarea.chatwoot_conversation_id);
    if (!idValido(clave)) continue;
    if (!mapa.has(clave)) mapa.set(clave, []);
    mapa.get(clave).push(tarea);
  }
  const pendientesPorLlave = new Map();

  function agregar(base, grupo, esMensaje = false) {
    const idProspecto = idValido(base.prospecto_id) ? Number(base.prospecto_id) : null;
    const idChat = idValido(base.chatwoot_conversation_id) ? Number(base.chatwoot_conversation_id) : null;
    if (!idProspecto && !idChat) return;
    const clave = llave(idProspecto, idChat);
    const disponibles = grupo || tareasPorProspecto.get(idProspecto) || tareasPorChat.get(idChat) || [];
    // Los recordatorios se muestran SIEMPRE: programados y vencidos.
    // Si hay tareas automáticas y una gestión manual con recordatorio, priorizar
    // la gestión explícita para que el asesor vea su próxima cita real.
    const recordatorios = disponibles.filter(t => t.recordatorio === true && fechaMs(t.vence_en) > 0)
      .sort((a,b) => fechaMs(a.vence_en)-fechaMs(b.vence_en));
    const vencidosConRecordatorio = recordatorios.filter(t => fechaMs(t.vence_en) <= ahora);
    const tareasSinRecordatorio = disponibles.filter(t => t.recordatorio !== true)
      .sort((a,b) => (fechaMs(a.vence_en)||Infinity)-(fechaMs(b.vence_en)||Infinity));
    const tarea = vencidosConRecordatorio[0] || recordatorios[0] || tareasSinRecordatorio[0] || null;
    const anterior = pendientesPorLlave.get(clave);
    const estado = base.estado || anterior?.estado || null;
    const demoFecha = base.demo_fecha_local || base.demo_fecha || anterior?.demo_fecha_local || null;
    const paso = pasoPorEstado(estado, demoFecha, ahora);
    const descripcionTarea = tarea?.origen === 'demo' ? null : tarea?.descripcion;
    const proximaAccion = descripcionTarea || paso.accion || 'Revisar estado comercial';
    const entrada = {
      estado,
      demo_fecha_local: demoFecha,
      prospecto_id: idProspecto,
      chatwoot_conversation_id: idChat || Number(tarea?.chatwoot_conversation_id || 0) || null,
      inbox_id: base.inbox_id || tarea?.inbox_id || anterior?.inbox_id || 6,
      nombre_negocio: base.nombre_negocio || anterior?.nombre_negocio || null,
      contacto: base.contacto || base.nombre_contacto || anterior?.contacto || null,
      responsable_nombre: base.responsable_nombre || anterior?.responsable_nombre || '',
      descripcion: (esMensaje && tarea?.origen === 'chatwoot')
        ? 'Responder el último mensaje del cliente'
        : (esMensaje && !tarea ? 'Responder el último mensaje del cliente' : proximaAccion),
      prioridad: tarea?.prioridad === 'alta' || esMensaje || anterior?.requiere_respuesta ? 'alta' : 'normal',
      tipo: tarea?.tipo || (esMensaje ? 'respuesta' : paso.tipo),
      vence_en: tarea?.vence_en || null,
      recordatorio: tarea?.recordatorio === true,
      recordatorio_vencido: tarea?.recordatorio === true && fechaMs(tarea.vence_en) <= ahora,
      requiere_respuesta: Boolean(esMensaje || anterior?.requiere_respuesta),
      ultima_entrada: base.ultima_entrada || anterior?.ultima_entrada || null,
      tarea_id: tarea?.id || null
    };
    // Si es un mensaje entrante, conservar la descripción de una gestión comercial
    // existente y evitar volver a crear una segunda fila para la misma oportunidad.
    if (anterior && !esMensaje) {
      entrada.requiere_respuesta = anterior.requiere_respuesta;
      entrada.ultima_entrada = anterior.ultima_entrada;
    }
    if (anterior && esMensaje && anterior.tarea_id && !entrada.tarea_id) {
      Object.assign(entrada, {
        descripcion: anterior.descripcion, vence_en: anterior.vence_en,
        recordatorio: anterior.recordatorio,
        recordatorio_vencido: anterior.recordatorio_vencido,
        tipo: anterior.tipo, tarea_id: anterior.tarea_id
      });
    }
    pendientesPorLlave.set(clave, entrada);
  }

  // Cada oportunidad activa, incluso si todavía nadie creó una tarea manual.
  for (const p of oportunidades) agregar(p);
  // También incluir las tareas sin ficha vinculada, si tuvieran conversación.
  for (const t of tareasVinculadas) {
    const k = llave(t.prospecto_id, t.chatwoot_conversation_id);
    if (!pendientesPorLlave.has(k)) agregar(t);
  }
  // Incluye chats sin ficha aún vinculada, como puede pasar con nuevos contactos.
  for (const m of mensajes) agregar(m, undefined, true);

  const todas = [...pendientesPorLlave.values()].sort((a,b) => {
    // Primero los recordatorios vencidos y mensajes sin respuesta;
    // los recordatorios futuros siguen visibles con su fecha programada.
    if (a.recordatorio_vencido !== b.recordatorio_vencido) return a.recordatorio_vencido ? -1 : 1;
    if (a.requiere_respuesta !== b.requiere_respuesta) return a.requiere_respuesta ? -1 : 1;
    const aV=fechaMs(a.vence_en), bV=fechaMs(b.vence_en);
    if (Boolean(aV) !== Boolean(bV)) return aV ? -1 : 1;
    return (aV||0)-(bV||0);
  });
  return { total: todas.length, visibles: todas };
}

module.exports = { seleccionarAgendaHoy };
