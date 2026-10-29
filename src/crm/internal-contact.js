'use strict';
function esContactoInterno(atributos) {
  if (!atributos || typeof atributos !== 'object' || Array.isArray(atributos)) return false;
  const valor = atributos.equipo_interno_sm;
  return valor === true || valor === 1 || (typeof valor === 'string' && /^(true|1|si|sí|yes)$/i.test(valor.trim()));
}
function tieneAtributoInterno(atributos) {
  return Boolean(atributos && typeof atributos === 'object' && !Array.isArray(atributos) &&
    Object.prototype.hasOwnProperty.call(atributos, 'equipo_interno_sm'));
}
function esGrupoWhatsapp(...campos) {
  return campos.some(c => typeof c === 'string' && /@g\.us(?:\b|$)/i.test(c));
}
module.exports = { esContactoInterno, tieneAtributoInterno, esGrupoWhatsapp };
