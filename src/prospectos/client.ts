export interface ProspectosPayload {
  nombre_contacto?: string | null;
  telefono: string;
  rubro?: string | null;
  origen: string;
  chatwoot_agent_id?: number | null;
  chatwoot_conversation_id: number;
}

export interface ProspectosResult {
  ok: boolean;
  id?: number;
  duplicado?: boolean;
  actualizado?: boolean;
}

export type ControlVentasEvento =
  | "ingreso"
  | "respuesta_cliente"
  | "consulta_erronea"
  | "no_interesado"
  | "derivacion"
  | "espera_vendedor"
  | "cancelar_espera_vendedor"
  | "respuesta_vendedor";

export interface ControlVentasPayload {
  chatwoot_conversation_id: number;
  evento: ControlVentasEvento;
  origen?: "meta" | "google" | "web" | "otro" | null;
  origen_detalle?: string | null;
  vendedor_id?: number | null;
  vendedor_nombre?: string | null;
}

export interface ProspectosReassignmentPayload {
  chatwoot_conversation_id: number;
  vendedor_id: number;
  vendedor_nombre: string;
  vendedor_anterior_nombre: string;
}

export interface ProspectosClient {
  // Puede no estar implementado en instalaciones anteriores de SM Prospectos.
  getConversationStage?(conversationId: number): Promise<string | null>;
  syncProspect(payload: ProspectosPayload): Promise<ProspectosResult>;

  updateStatus(
    conversationId: number,
    estado: "prospecto" | "sin_respuesta"
  ): Promise<void>;

  registerControlEvent(
    payload: ControlVentasPayload
  ): Promise<void>;
    reassignProspect?(
    payload: ProspectosReassignmentPayload
  ): Promise<void>;

  updateOrigin(
    conversationId: number,
    origen: "meta" | "google" | "web"
  ): Promise<void>;

    updateAssignee(
    conversationId: number,
    chatwootAgentId: number,
  ): Promise<void>;
}

interface ProspectosClientConfig {
  baseUrl: string;
  apiKey: string;
}

export function createProspectosClient(
  config: ProspectosClientConfig
): ProspectosClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  return {
    async syncProspect(
      payload: ProspectosPayload
    ): Promise<ProspectosResult> {
      const response = await fetch(
        `${baseUrl}/api/prospectos/auto-crear`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey
          },
          body: JSON.stringify(payload)
        }
      );

      const text = await response.text();

      let body: unknown = {};

      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
      }

      if (!response.ok) {
        throw new Error(
          `SM Prospectos respondió ${response.status}: ${text || response.statusText}`
        );
      }

      return body as ProspectosResult;
    },

    async updateStatus(
      conversationId: number,
      estado: "prospecto" | "sin_respuesta"
    ): Promise<void> {
      const response = await fetch(
        `${baseUrl}/api/prospectos/estado-chatwoot`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey
          },
          body: JSON.stringify({
            chatwoot_conversation_id: conversationId,
            estado
          })
        }
      );

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `SM Prospectos respondió ${response.status}: ${text || response.statusText}`
        );
      }
    },

    async updateOrigin(
  conversationId: number,
  origen: "meta" | "google" | "web"
): Promise<void> {
  const response = await fetch(
    `${baseUrl}/api/prospectos/origen-chatwoot`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify({
        chatwoot_conversation_id: conversationId,
        origen,
      }),
    },
  );

  

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `SM Prospectos respondió ${response.status}: ${
        text || response.statusText
      }`,
    );
  }
},

async updateAssignee(
  conversationId: number,
  chatwootAgentId: number,
): Promise<void> {
  const response = await fetch(
    `${baseUrl}/api/prospectos/responsable-chatwoot`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify({
        chatwoot_conversation_id: conversationId,
        chatwoot_agent_id: chatwootAgentId,
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `SM Prospectos respondió ${response.status}: ${text || response.statusText}`,
    );
  }
},

    async registerControlEvent(
      payload: ControlVentasPayload
    ): Promise<void> {
      const response = await fetch(
        `${baseUrl}/api/control-ventas/evento`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey
          },
          body: JSON.stringify(payload)
        }
      );

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `SM Prospectos respondió ${response.status}: ${text || response.statusText}`
        );
      }
    },
        async reassignProspect(
      payload: ProspectosReassignmentPayload
    ): Promise<void> {
      const response = await fetch(
        `${baseUrl}/api/prospectos/reasignar`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey
          },
          body: JSON.stringify(payload)
        }
      );

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `SM Prospectos respondió ${response.status}: ${text || response.statusText}`
        );
      }
    }
    
  };
  
}
    
  
