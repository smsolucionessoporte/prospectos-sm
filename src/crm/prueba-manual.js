"use strict";
// Corregir una prueba ya iniciada desde Editar NO dispara mensajes ni activaciones.
const {parseLocal} = require('../meet/calendar');
const SIETE_DIAS = 7 * 24 * 60 * 60 * 1000;
function periodoPruebaManual(fechaInicio = '', ahora = new Date()) {
  let base;
  try { base = fechaInicio ? parseLocal(fechaInicio).utc : new Date(ahora); }
  catch { throw new Error('Fecha de inicio inválida'); }
  if (!Number.isFinite(base.getTime())) throw new Error('Fecha de inicio inválida');
  if (base.getTime() > new Date(ahora).getTime() + 60_000)
    throw new Error('La fecha de inicio de la prueba no puede ser futura');
  return {inicio: base, vence: new Date(base.getTime() + SIETE_DIAS)};
}
module.exports = {periodoPruebaManual};
