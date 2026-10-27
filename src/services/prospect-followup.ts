import type { Pool } from "pg";
import type { ChatwootClient } from "../chatwoot/client.js";
import type { ProspectosClient } from "../prospectos/client.js";

interface FollowupLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

interface PendingFollowup {
  chatwoot_conversation_id: string;
  prospect_followup_attempt: number;
  human_handoff: boolean;
  stage?: string;
}

export class ProspectFollowupService {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly chatwoot: ChatwootClient,
    private readonly logger: FollowupLogger,
    private readonly prospectos?: ProspectosClient
  ) {}

  start(): void {
    if (this.timer) return;

    void this.check();

    this.timer = setInterval(() => {
      void this.check();
    }, 60_000);

    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async check(): Promise<void> {
    if (this.running) return;

    this.running = true;

    try {
      const result = await this.pool.query<PendingFollowup>(
        `SELECT
           chatwoot_conversation_id::text,
           prospect_followup_attempt,
           human_handoff,
           stage
         FROM conversation_state
         WHERE prospect_followup_due_at IS NOT NULL
           AND prospect_followup_due_at <= NOW()
           AND prospect_followup_completed = FALSE
           AND human_handoff = FALSE
         ORDER BY prospect_followup_due_at ASC
         LIMIT 50`
      );

      for (const conversation of result.rows) {
        await this.processFollowup(conversation);
      }
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error)
        },
        "Error revisando seguimientos pendientes de prospectos"
      );
    } finally {
      this.running = false;
    }
  }

  private async processFollowup(
    conversation: PendingFollowup
  ): Promise<void> {
    const conversationId = Number(
      conversation.chatwoot_conversation_id
    );

    const attempt = Number(
      conversation.prospect_followup_attempt
    );

    try {
  const chatwootConversation =
    await this.chatwoot.getConversation(conversationId);

        if (
          chatwootConversation === null ||
          chatwootConversation.status === "resolved"
        ) {
          await this.pool.query(
            `UPDATE conversation_state
            SET prospect_followup_due_at = NULL,
                prospect_followup_completed = TRUE
            WHERE chatwoot_conversation_id = $1`,
            [conversationId]
          );

          this.logger.info(
            {
              conversationId,
              reason:
                chatwootConversation === null
                  ? "conversation_deleted"
                  : "conversation_resolved"
            },
            "Seguimiento cancelado porque la conversación ya no está activa"
          );

          return;
        }
      } catch (error) {
        this.logger.warn(
          {
            conversationId,
            error:
              error instanceof Error
                ? error.message
                : String(error)
          },
          "No se pudo verificar el estado de la conversación en Chatwoot"
        );

        return;
      }

    // Ya se enviaron los 3 recordatorios.
    // Si pasaron otras 24 h sin respuesta, finalizar.
    if (attempt >= 3) {
      await this.finishWithoutResponse(conversationId);
      return;
    }

    // Reservar este intento para evitar envíos duplicados.
    const claimed = await this.pool.query(
      `UPDATE conversation_state
       SET prospect_followup_attempt = prospect_followup_attempt + 1,
           prospect_followup_due_at = NULL
       WHERE chatwoot_conversation_id = $1
         AND prospect_followup_due_at IS NOT NULL
         AND prospect_followup_due_at <= NOW()
         AND prospect_followup_completed = FALSE
         AND human_handoff = FALSE
         AND prospect_followup_attempt = $2
       RETURNING prospect_followup_attempt`,
      [conversationId, attempt]
    );

    if (claimed.rowCount !== 1) return;

    const newAttempt = attempt + 1;

    const messages: Record<number, string> = {
      1: "¡Hola! 👋 ¿Pudiste revisar la información que te enviamos? Si querés avanzar con una demostración o hablar con un asesor, contanos cómo preferís continuar.",
      2: "¡Hola nuevamente! 😊 Queríamos saber si te quedaron dudas sobre el sistema o si te interesa coordinar una demostración. Contanos qué necesitás.",
      3: "¡Hola! 👋 Antes de cerrar tu consulta, ¿todavía te gustaría conocer el sistema o hablar con nuestro equipo comercial? Si no estás interesado por ahora, también podés comentárnoslo."
    };

    // Los recordatorios no deben saltarse las dos preguntas de calificación
    // ni volver a pedir respuestas con 1/2/3.
    const stagePrompts: Record<string, string> = {
      awaiting_rubro: "¡Hola! 👋 Para ayudarte con la información sobre SM, ¿nos contás de qué rubro es tu negocio?",
      awaiting_current_system: "¡Hola! 👋 ¿Cómo llevás actualmente las ventas, el stock y la administración de tu comercio? Contanos un poco y te orientamos mejor.",
      awaiting_main_need: "¡Hola! 😊 ¿Qué te gustaría mejorar o resolver con un sistema de gestión? Queremos conocer tus necesidades antes de derivarte.",
      awaiting_name: "¡Hola! 😊 Para ponerte en contacto con un asesor comercial, ¿nos compartís tu nombre?"
    };
    const message = (conversation.stage && stagePrompts[conversation.stage]) || messages[newAttempt];

      if (!message) {
        this.logger.warn(
          { conversationId, attempt: newAttempt },
          "No existe mensaje configurado para este intento de seguimiento"
        );
        return;
      }

    try {
      await this.chatwoot.sendMessage(
        conversationId,
        message
      );

      // Programar el siguiente paso dentro de 24 horas.
      await this.pool.query(
        `UPDATE conversation_state
         SET prospect_followup_due_at = NOW() + INTERVAL '24 hours'
         WHERE chatwoot_conversation_id = $1
           AND prospect_followup_attempt = $2
           AND prospect_followup_completed = FALSE`,
        [conversationId, newAttempt]
      );

      this.logger.info(
        {
          conversationId,
          attempt: newAttempt
        },
        "Recordatorio automático enviado al prospecto"
      );
    } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // La conversación pudo haberse eliminado entre el GET anterior
        // y el momento de enviar el mensaje.
        if (errorMessage.includes("HTTP 404")) {
          await this.pool.query(
            `UPDATE conversation_state
            SET prospect_followup_due_at = NULL,
                prospect_followup_completed = TRUE
            WHERE chatwoot_conversation_id = $1`,
            [conversationId]
          );

          this.logger.info(
            {
              conversationId,
              reason: "conversation_deleted_during_send"
            },
            "Seguimiento cancelado porque la conversación fue eliminada"
          );

          return;
        }

        // Para errores temporales sí restauramos el intento
        // y volvemos a probar dentro de 5 minutos.
        await this.pool.query(
          `UPDATE conversation_state
          SET prospect_followup_attempt = $2,
              prospect_followup_due_at = NOW() + INTERVAL '5 minutes'
          WHERE chatwoot_conversation_id = $1
            AND prospect_followup_completed = FALSE`,
          [conversationId, attempt]
        );

        this.logger.warn(
          {
            conversationId,
            attempt: newAttempt,
            error: errorMessage
          },
          "No se pudo enviar recordatorio automático al prospecto"
        );
      }
  }

  private async finishWithoutResponse(
    conversationId: number
  ): Promise<void> {
    // Primero reservar/finalizar en BD para evitar duplicados.
    const claimed = await this.pool.query(
      `UPDATE conversation_state
       SET prospect_followup_due_at = NULL,
           prospect_followup_completed = TRUE
       WHERE chatwoot_conversation_id = $1
         AND prospect_followup_completed = FALSE
         AND prospect_followup_attempt >= 3
         AND prospect_followup_due_at IS NOT NULL
         AND prospect_followup_due_at <= NOW()
         AND human_handoff = FALSE
       RETURNING chatwoot_conversation_id`,
      [conversationId]
    );

    if (claimed.rowCount !== 1) return;

    try {
      await this.chatwoot.addLabels(
        conversationId,
        ["sin respuesta"]
      );

      // Sincronizar también el estado en SM Prospectos.
      if (this.prospectos) {
        try {
          await this.prospectos.updateStatus(
            conversationId,
            "sin_respuesta"
          );
        } catch (error) {
          this.logger.warn(
            {
              conversationId,
              error: error instanceof Error
                ? error.message
                : String(error)
            },
            "No se pudo marcar el prospecto como sin respuesta en SM Prospectos"
          );
        }
      }

      this.logger.info(
        { conversationId },
        "Prospecto marcado sin respuesta después de 3 intentos"
      );
   } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Si desapareció de Chatwoot, el seguimiento debe terminar
      // definitivamente. No tiene sentido volver a intentarlo.
      if (errorMessage.includes("HTTP 404")) {
        this.logger.info(
          {
            conversationId,
            reason: "conversation_deleted_during_finish"
          },
          "Seguimiento finalizado: la conversación ya no existe en Chatwoot"
        );

        return;
      }

      // Para errores temporales de Chatwoot sí dejamos pendiente
      // únicamente el cierre.
      await this.pool.query(
        `UPDATE conversation_state
        SET prospect_followup_completed = FALSE,
            prospect_followup_due_at = NOW() + INTERVAL '5 minutes'
        WHERE chatwoot_conversation_id = $1`,
        [conversationId]
      );

      this.logger.warn(
        {
          conversationId,
          error: errorMessage
        },
        "No se pudo agregar etiqueta sin respuesta; se reintentará"
      );
    }
  }
}