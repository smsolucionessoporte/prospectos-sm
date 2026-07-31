// src/zoomAgentes.js
const AGENTE_ZOOM = {
  6: 'smsoluciones.soporte@gmail.com',
  10: 'romanfontanetcasas@gmail.com', 
  8: 'rafaelaltadonna@gmail.com'
};

const AGENTE_TELEFONO = {
  6: '+54 9 11 3278-0621', 
  10: '+54 9 11 6927-3611', 
  8: '+54 9 11 5564-4899'
};

const AGENTE_CHATWOOT_ID = {
  // id del agente en Chatwoot : id del usuario en tu tabla usuarios de prospectos-sm
  2: 6,  
  4: 8,
  5: 10,
};

const AGENTE_INBOX = {
  // id del usuario (usuarios.id) : inbox_id de su canal en Chatwoot
  6: 1,
  8: 3,
  10: 2
};

module.exports = { AGENTE_ZOOM, AGENTE_TELEFONO, AGENTE_INBOX, AGENTE_CHATWOOT_ID };

