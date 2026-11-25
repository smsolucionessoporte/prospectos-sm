
const AGENTE_ZOOM = {
  6: "smsoluciones.soporte@gmail.com",      // Marisol
  7: "danielgonzalezf98@gmail.com",         // Daniel
  8: "rafaelaltadonna@gmail.com",           // Rafael
  10: "romanfontanetcasas@gmail.com",        // Román
};

const AGENTE_TELEFONO = {
  6: "+54 9 11 3278-0621", // Marisol
  8: "+54 9 11 5564-4899", // Rafael
  10: "+54 9 11 6927-3611", // Román
  11: "+54 9 11 5403-7905", // Tomás
  7: "+54 9 11 2478-5622", // Daniel (solo compatibilidad histórica)
  13: process.env.VENTAS_TELEFONO_SANTIAGO || undefined, // Obligatorio para avisos a Santiago

};

const AGENTE_CHATWOOT_ID = {
  // Chatwoot agent_id : usuarios.id de prospectos-sm
  2: 6,   // Marisol
  8: 7,   // Daniel
  4: 8,   // Rafael
  5: 10,  // Román
  13: 11, // Tomás
  19: 13, // Santiago

};

const AGENTE_INBOX = {
  // usuarios.id de prospectos-sm : inbox_id de su canal en Chatwoot
  6: 1,  // Marisol
  8: 3,  // Rafael
  10: 2, // Román
};


function telefonoVendedor(usuarioId) {
  const variables = {
    8: process.env.VENTAS_TELEFONO_RAFAEL,
    13: process.env.VENTAS_TELEFONO_SANTIAGO,
  };
  // Solo vendedores actualmente habilitados: no reutilizar teléfono histórico de Daniel.
  if (![8,13].includes(Number(usuarioId))) return null;
  const telefono = String(variables[usuarioId] || AGENTE_TELEFONO[usuarioId] || '').trim();
  return /^\+?[0-9 ()-]{10,25}$/.test(telefono) ? telefono : null;
}
module.exports = { AGENTE_ZOOM, AGENTE_TELEFONO, AGENTE_INBOX, AGENTE_CHATWOOT_ID, telefonoVendedor };

