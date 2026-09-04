
const AGENTE_ZOOM = {
  6: "smsoluciones.soporte@gmail.com",      // Marisol
  7: "danielgonzalezf98@gmail.com",         // Daniel
  8: "rafaelaltadonna@gmail.com",           // Rafael
  10: "romanfontanetcasas@gmail.com",        // Román
  11: "tomassmsoluciones@gmail.com",         // Tomás
  12: "giuliano69carabajal@gmail.com",       // Giuliano
};

const AGENTE_TELEFONO = {
  6: "+54 9 11 3278-0621", // Marisol
  8: "+54 9 11 5564-4899", // Rafael
  10: "+54 9 11 6927-3611", // Román
};

const AGENTE_CHATWOOT_ID = {
  // Chatwoot agent_id : usuarios.id de prospectos-sm
  2: 6,   // Marisol
  8: 7,   // Daniel
  4: 8,   // Rafael
  5: 10,  // Román
  13: 11, // Tomás
  11: 12, // Giuliano
};

const AGENTE_INBOX = {
  // usuarios.id de prospectos-sm : inbox_id de su canal en Chatwoot
  6: 1,  // Marisol
  8: 3,  // Rafael
  10: 2, // Román
};


module.exports = { AGENTE_ZOOM, AGENTE_TELEFONO, AGENTE_INBOX, AGENTE_CHATWOOT_ID };

