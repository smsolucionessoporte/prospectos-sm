'use strict';

// Solo notificar al responsable de la oportunidad. Marisol y Román
// reciben avisos únicamente cuando son dueños de un prospecto interno,
// nunca por defecto al registrarse una demo de otro vendedor.
const VENDEDORES = new Set([8, 12, 13]);
const SOPORTE_INTERNO = new Set([6, 10]);

function destinatariosDemo(responsableId, mensaje, telefonos = {}) {
  const id = Number(responsableId);
  if (VENDEDORES.has(id)) {
    return [{ destino: 'vendedor', destinatario: id, telefono: null, conversacion: null, mensaje }];
  }
  if (SOPORTE_INTERNO.has(id)) {
    const telefono = String(telefonos[id] || '').trim();
    if (telefono) {
      return [{ destino: 'responsable-interno', destinatario: id, telefono, conversacion: null, mensaje }];
    }
  }
  return [];
}

module.exports = { destinatariosDemo };
