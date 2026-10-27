import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Pool } from "pg";
import { z } from "zod";
import OpenAI, { toFile } from "openai";
import type { ChatwootClient } from "./client.js";
import { isGreeting, type KnowledgeAnswerService } from "../ai/answer.js";
import type { UnansweredQuestionTracker } from "../services/unanswered-tracker.js";
import type { ProspectosClient } from "../prospectos/client.js";
import { addSalesBusinessHours, isSalesBusinessTime } from "../services/sales-business-time.js";

const webhookSchema = z
  .object({
    event: z.string(),
    id: z.coerce.number().int().positive(),
    content: z.string().nullish(),
    content_attributes: z.record(z.string(), z.unknown()).optional(),
    attachments: z.array(
      z.object({
        id: z.coerce.number().int().positive().optional(),
        file_type: z.string().optional(),
        data_url: z.string().url().or(z.literal("")).optional(),
        file_size: z.coerce.number().nonnegative().optional(),
        extension: z.string().nullish(),
        content_type: z.string().nullish(),
        transcribed_text: z.string().nullish(),
      }).passthrough()
    ).optional(),
    message_type: z.string().optional(),
    private: z.boolean().optional().default(false),
    sender: z
      .object({ id: z.coerce.number().int().positive(), type: z.string().optional() })
      .passthrough()
      .optional(),
    inbox: z.object({ id: z.coerce.number().int().positive() }).passthrough().optional(),
    account: z.object({ id: z.coerce.number().int().positive() }).passthrough().optional(),
    conversation: z
      .object({
        id: z.coerce.number().int().positive(),
        inbox_id: z.coerce.number().int().positive(),
        status: z.string().optional(),
       meta: z
          .object({
            sender: z.object({
              id: z.number().int().positive(),
              name: z.string().optional(),
              phone_number: z.string().nullable().optional()
            }).passthrough().optional(),
            assignee_type: z.string().nullish()
          })
          .passthrough()
          .optional()
      })
      .passthrough()
  })
  .passthrough();

type WebhookAttachment = NonNullable<
  z.infer<typeof webhookSchema>["attachments"]
>[number];

export interface AcceptedWebhook {
  deliveryId?: string;
  payload: z.infer<typeof webhookSchema>;
  payloadHash: string;
}

export interface ChatwootWebhookProcessor {
  accept(routeToken: string, headers: IncomingHttpHeaders, body: unknown): AcceptedWebhook | null;
  process(event: AcceptedWebhook): Promise<void>;
}

interface ProcessorConfig {
  webhookToken: string;
  accountId: number;
  inboxId: number;
  botAgentId?: number;
  replyEnabled: boolean;
  salesGroupConversationId?: number;
  salesAgents?: Array<{
    id: number;
    name: string;
  }>;
  openAiApiKey?: string;
  now?: () => Date;
}

interface ProcessorLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

interface AudioDownloadResult {
  buffer: Buffer;
  contentType: string;
  attempts: number;
}

const AUDIO_DOWNLOAD_RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000];
const AUDIO_DOWNLOAD_RETRYABLE_STATUSES = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504]);

class NonRetryableAudioDownloadError extends Error {}

export async function downloadAudioWithRetry(
  dataUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    delaysMs?: number[];
    timeoutMs?: number;
  } = {},
): Promise<AudioDownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delaysMs = options.delaysMs ?? AUDIO_DOWNLOAD_RETRY_DELAYS_MS;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let lastError: Error | null = null;

  for (let index = 0; index < delaysMs.length; index += 1) {
    const delayMs = delaysMs[index] ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
      const response = await fetchImpl(dataUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const message = `HTTP ${response.status} al descargar audio`;
        if (!AUDIO_DOWNLOAD_RETRYABLE_STATUSES.has(response.status)) {
          throw new NonRetryableAudioDownloadError(message);
        }
        lastError = new Error(message);
        if (index < delaysMs.length - 1) continue;
        throw lastError;
      }

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        lastError = new Error("El audio descargado está vacío");
        if (index < delaysMs.length - 1) continue;
        throw lastError;
      }

      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: response.headers.get("content-type") || "audio/ogg",
        attempts: index + 1,
      };
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (normalized instanceof NonRetryableAudioDownloadError) throw normalized;
      lastError = normalized;
      if (index >= delaysMs.length - 1) throw normalized;
    }
  }

  throw lastError ?? new Error("No se pudo descargar el audio");
}

interface SalesAssignee {
  id: number;
  name: string;
}
interface QualificationFlow {
  enabled: boolean;
  intro_message: string;
  questions: string[];
  completion_message: string;
}

interface QualificationAnswer {
  question: string;
  answer: string;
}

export interface ConversationData {
  qualification?: {
    question_index?: number;
    answers?: QualificationAnswer[];
  };
  lead_name?: string;
  chat_history?: Array<{ role: "user" | "assistant"; content: string }>;
  memory?: Record<string, unknown>;
  lead_summary?: string;
  [key: string]: unknown;
}


const AUDIO_TRANSCRIPTION_FALLBACK_MESSAGE =
  "Disculpame, no pude interpretar el audio. Intentemos por escrito. " +
  "Para resolver tus consultas sobre nuestro sistema de gestión, te pido que me indiques tu rubro " +
  "(dietética, almacén, carnicería, pollería, pescadería, pet shop, etc.) y tu nombre. " +
  "Y enseguida te atenderá un especialista.";

export const AUDIO_RECOVERY_MESSAGE =
  "¡Hola! Pasamos por acá para retomar la conversación. No pudimos interpretar el audio. " +
  "Probemos por escrito. Para resolver tus consultas sobre nuestro sistema de gestión, te pido que me indiques tu rubro " +
  "(dietética, almacén, carnicería, pollería, pescadería, pet shop, etc.) y tu nombre. " +
  "Y enseguida te atenderá un especialista.";

function isAudioAttachment(
  attachment: WebhookAttachment,
): boolean {
  return normalizeText(String(attachment?.file_type ?? "")) === "audio";
}

const DIETETICA_SPECIALTY_INTRO = `¡Perfecto! 😄 Somos especialistas en sistemas para dietéticas, pet shops, almacenes y mercados naturales. Hace más de 15 años que trabajamos en este rubro y más de 1.000 negocios ya utilizan nuestras soluciones.\n\n`;

function buildProposalMessage(rawSalesMsg: string, isDietetica: boolean): string {
  const hasHeader = rawSalesMsg.includes("Somos especialistas en sistemas para dietéticas");
  
  if (isDietetica) {
    if (!hasHeader) {
      return `${DIETETICA_SPECIALTY_INTRO}${rawSalesMsg}`;
    }
    return rawSalesMsg;
  } else {
    if (hasHeader) {
      const parts = rawSalesMsg.split("Nuestro sistema te ayuda a:");
      if (parts.length > 1) {
        return `Nuestro sistema te ayuda a:${parts.slice(1).join("Nuestro sistema te ayuda a:")}`;
      }
    }
    return rawSalesMsg;
  }
}

function buildLeadSummary(state: ConversationData, rubro?: string | null, leadName?: string): string {
  const parts: string[] = [];
  const name = leadName || (state.lead_name as string);
  if (name) parts.push(`👤 Nombre: ${name}`);
  if (rubro) parts.push(`🏷️ Rubro: ${rubro}`);
  const mem = state.memory ?? {};
  if (mem.locales) parts.push(`🏬 Locales: ${mem.locales}`);
  if (mem.sistema_actual) parts.push(`💻 Sistema actual: ${mem.sistema_actual}`);
  if (mem.problema_principal) parts.push(`⚠️ Problema principal: ${mem.problema_principal}`);
  if (Array.isArray(mem.interes) && mem.interes.length) parts.push(`⭐ Intereses: ${mem.interes.join(", ")}`);

  if (state.qualification?.answers?.length) {
    const qAnswers = state.qualification.answers.map((a) => `- ${a.question}: ${a.answer}`).join("\n");
    parts.push(`📋 Respuestas de diagnóstico:\n${qAnswers}`);
  }
  return parts.join("\n");
}

export function extractCleanName(input: string | null | undefined): string {
  if (!input) return "";

  let text = input.trim();

  // Meta/Instagram puede adjuntar debajo del texto escrito por la persona
  // una vista previa del anuncio. Para capturar el nombre usamos únicamente
  // la primera parte realmente escrita por el prospecto.
  text = text
    .split(/\n\s*(?:chatea con nosotros|ver anuncio|más información|mas informacion|https?:\/\/|fb\.me\/)/i)[0]
    ?.trim() ?? text;

  const norm = normalizeText(text);

  if (
    /^(1|2|si|sí|dale|bueno|ok|okay|perfecto|quiero|me interesa|quiero la demo|quiero una demo|demo)$/i.test(norm) ||
    /\b(demo|demostracion|asesor|vendedor|reunion|meet|informacion|presupuesto)\b/i.test(norm)
  ) {
    return "";
  }

  // No aceptar insultos, agresiones ni frases evidentemente ajenas a un nombre.
  if (
    /\b(puta|puto|mierda|pelotudo|pelotuda|boludo|boluda|forro|forra|idiota|imbecil|concha|verga|culo|pija|coger|cogeme|chupame)\b/i.test(norm)
  ) {
    return "";
  }

  while (true) {
    const prev = text;

    text = text
      .replace(
        /^(si|sí|dale|bueno|ok|okay|perfecto|hola|buenas|buenos dias|buenas tardes|buenas noches)[\s,!.]*/i,
        ""
      )
      .trim();

    text = text
      .replace(
        /^(mi nombre es|me llamo|soy|mi nombre|nombre|es)[\s:]+/i,
        ""
      )
      .trim();

    if (text === prev) break;
  }

  text = text
    .replace(/[\s,!.]+(gracias|por favor|dale).*$/i, "")
    .trim();

  text = text.replace(/[\s.,!?:;]+$/g, "").trim();

  if (!text || text.length > 40) {
    return "";
  }

  // Un nombre razonable: entre 1 y 4 palabras.
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length < 1 || words.length > 4) {
    return "";
  }

  // Solo letras, espacios, apóstrofes o guiones.
  if (!/^[a-záéíóúñü' -]+$/i.test(text)) {
    return "";
  }

  // Evitar frases/oraciones que accidentalmente parecen nombres.
  const invalidWords = [
    "tengo",
    "tenes",
    "tienes",
    "dio",
    "dió",
    "dijo",
    "quiero",
    "necesito",
    "hago",
    "hace",
    "haces",
    "ases",
    "negocio",
    "sistema",
    "nombre",
    "madre",
    "padre",
    "nene",
    "nena",
    "años"
  ];

  if (
    words.some((word) =>
      invalidWords.includes(normalizeText(word))
    )
  ) {
    return "";
  }

  return words
    .map(
      (word) =>
        word.charAt(0).toUpperCase() +
        word.slice(1).toLowerCase()
    )
    .join(" ");
}

function getValidChatwootContactName(
  name: string | null | undefined
): string {
  if (!name) return "";

  const clean = name.trim();

  if (!clean) return "";

  const normalized = normalizeText(clean);

  // Nombres automáticos/genéricos que no sirven como nombre comercial.
  if (
    /^(sin nombre|whatsapp user|usuario|contacto|unknown|desconocido)$/i.test(
      normalized
    )
  ) {
    return "";
  }

  // Si Chatwoot tiene como nombre solamente el teléfono, no utilizarlo.
  const digits = clean.replace(/\D/g, "");
  if (digits.length >= 8 && clean.replace(/[\d\s()+-]/g, "") === "") {
    return "";
  }

  return clean;
}

function extractNameFromRubroMessage(
  input: string | null | undefined
): string {
  if (!input) return "";

  const text = input.trim();

  // "Soy Agustina", "me llamo Juan", "mi nombre es Pedro"
  const explicit = text.match(
    /\b(?:mi nombre es|me llamo|soy)\s+([a-záéíóúñü]+(?:\s+[a-záéíóúñü]+){0,2})/i
  );

  if (explicit?.[1]) {
    return extractCleanName(explicit[1]);
  }

  // Ej.: "Dietética, Agustina"
  const parts = text
    .split(/[,;|-]/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    for (const part of parts) {
      if (!detectRubro(part)) {
        const possibleName = extractCleanName(part);
        if (possibleName) return possibleName;
      }
    }
  }

  return "";
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMeaningfulText(
  content: string | null | undefined
): boolean {
  const text = normalizeText(content ?? "");

  // Después de normalizar, emojis, stickers y símbolos quedan vacíos.
  return /[a-z0-9]/.test(text);
}

function normalizePhone(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

const INTERNAL_PHONES = new Set([
  "5491126181063", // Andrés
  "5491155644899", // Rafael
  "5491132746298", // Giuliano
  "5491168443757", // Santiago
  "5491124785622", // Daniel
]);

function isInternalPhone(value: string | null | undefined): boolean {
  return INTERNAL_PHONES.has(normalizePhone(value));
}

function isPrefilledAdOrWebsiteTemplate(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "");
  if (
    /\b(vengo desde|vengo del|sitio web|pagina web|vi en instagram|vi en facebook|vi su publicidad|vi el anuncio)\b/.test(text)
  ) {
    return true;
  }
  if (
    /\b(hola.*tengo una dietetica y quiero una demo|hola.*quiero una demo|hola.*mas informacion sobre sm soluciones)\b/.test(text)
  ) {
    return true;
  }
  return false;
}

function isWebsiteLead(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "");

  return (
    text.includes("sitio web") ||
    text.includes("sitio") ||
    text.includes("web")
  );
}


function isMetaLead(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "");

  return (
    text.includes("instagram") ||
    text.includes("fb.me") ||
    text.includes("quiero mas informacion") ||
    text.includes("chatea con nosotros") ||
    text.includes("vi su publicidad") ||
    text.includes("vi el anuncio") 
  );
}

function detectRubro(content: string | null | undefined): string | null {
  const text = normalizeText(content ?? "");

    if (
      /\b(dietetica|dieteticas|almacen natural|almacenes naturales|dietetica y almacen natural|suplementacion|suplementos|tienda de suplementos)\b/.test(
        text
      )
    ) {
      return "dietetica";
    }

    if (
      /\b(pet shop|petshop|veterinaria|alimento para mascotas|alimentos para mascotas|alimento balanceado|alimentos balanceados|balanceado para mascotas|balanceados para mascotas)\b/.test(text)
    ) {
      return "petshop";
    }

  if (
    /\b(almacen|almacenes|kiosco|kiosko|maxikiosco|despensa|autoservicio|supermercado|minimercado|minimarket|mercadito|comercio|comercial|tienda|rotiseria|panaderia|verduleria|carniceria|polleria|pescaderia|congelados|ferreteria|bazar|regaleria|farmacia|libreria|indumentaria|ropa|local de ropa|calzado|joyeria|joyas|antiguedad|antiguedades|tapicero|tapicera|tapiceria|carpintero|carpintera|carpinteria|muebleria|muebles|cerrajero|cerrajera|cerrajeria|taller|servicio agricola|servicios agricolas|agricola|agricultura)\b/.test(
      text
    )
  ) {
    return "comercio";
  }

  return null;
}

function isMultiBranchOrSpecial(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "");
  if (/\b(distribuidora|distribuidor|fabrica|fabricante|multisucursal|cadena de locales|cadena de sucursales)\b/.test(text)) {
    return true;
  }
  if (
    /\b(2|3|4|5|6|7|8|9|10|dos|tres|cuatro|cinco|varios|varias|muchos|muchas|mas de un|mas de una|cadena de)\s+(local|locales|sucursal|sucursales|tienda|tiendas|dietetica|dieteticas|petshop|petshops|negocio|negocios|comercio|comercios|almacen|almacenes)\b/.test(
      text
    )
  ) {
    return true;
  }
  if (
    /\b(locales|sucursales)\b/.test(text) &&
    /\b(2|3|4|5|dos|tres|cuatro|cinco|varios|varias|mas)\b/.test(text)
  ) {
    return true;
  }
  return false;
}

function wantsHuman(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "").trim();

  // Opción 2 del CTA.
  // Meta puede reenviar el texto de la publicidad junto con la respuesta,
  // por eso no exigimos que todo el mensaje sea exactamente "2".
  if (/^2(?:\s|$)/.test(text)) {
    return true;
  }

  if (isMultiBranchOrSpecial(content)) {
    return true;
  }

  return /\b(asesor|humano|persona|vendedor|ventas|reunion|demo|demostracion|meet|contratar|contratacion|contacto)\b/.test(
    text
  );
}
function requestsHumanAdvisor(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "").trim();
  if (!text) return false;

  return (
    /\b(quiero|quisiera|necesito|prefiero|puedo|podria|podrían|podrian)\b.*\b(humano|persona|asesor|vendedor|alguien)\b/.test(text) ||
    /\b(hablar|comunicarme|contactarme|contactar|atenderme|atencion)\b.*\b(humano|persona|asesor|vendedor|alguien)\b/.test(text) ||
    /\b(humano|asesor|vendedor)\b.*\b(hablar|atender|contactar|comunicar)\b/.test(text)
  );
}

function isPurePriceQuery(content: string | null | undefined): boolean {
  const original = (content ?? "").trim();
  const text = normalizeText(original);

  if (/\b(balanza|excel|stock|fraccionad|facturacion|imprimir|multiples|sucursales)\b/.test(text)) {
    return false;
  }

  if (
    /\b(precio|precios|costo|costos|valor|valores|cuanto sale|cuanto cuesta|presupuesto|tarifas)\b/.test(
      text
    )
  ) {
    return true;
  }

  return false;
}

function acceptsDemo(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "").trim();

  if (text === "1") return true;

  // El CTA comercial pide 1 o 2. Respuestas genéricas como "ok", "bueno"
  // o "dale" no deben interpretarse como una aceptación de demo.
  return /\b(quiero|coordinar|agendar|ver|hacer|me interesa)\b.*\b(demo|demostracion)\b/.test(text) ||
    /\b(demo|demostracion)\b.*\b(quiero|coordinar|agendar|ver|hacer|me interesa)\b/.test(text);
}

function isGenericAcknowledgement(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "").trim();
  return /^(si|sii+|dale|ok|okay|bueno|perfecto|claro|gracias)$/.test(text);
}

export function isHumanClosingMessage(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "").trim();
  if (!text) return false;
  return /^(?:muchas )?gracias(?: por (?:la respuesta|avisar|responder|tu respuesta))?(?: saludos)?$/.test(text) ||
    /^(?:gracias|muchas gracias).*(?:saludos|que tengas buen dia|buen dia)$/.test(text) ||
    /^(?:saludos|que tengas buen dia|buen dia)$/.test(text);
}

export function isSocialClosingReply(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "").trim();
  if (!text) return true; // emoji, sticker o reacción
  return /^(?:hola|holaa+|buenas|ok|okay|dale|bueno|perfecto|listo|gracias|muchas gracias|gracias igualmente|igualmente|de nada|saludos|buen dia|buenas tardes|buenas noches|chau|adios|genial|joya|esta bien|todo bien)(?: gracias)?$/.test(text);
}

export function normalizeAudioExtension(extension: string | null | undefined): string {
  const normalized = (extension || "ogg").replace(/^\./, "").toLowerCase();
  return normalized === "oga" ? "ogg" : normalized;
}

function refusesDemo(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "").trim();

  if (!text) return false;

  if (text === "3") return true;

  if (
    /^(?:(?:a+h*|eh|emm)\s+)?(?:no|nop|nope|paso|no gracias|gracias pero no|por ahora no|no por ahora)$/.test(
      text,
    )
  ) {
    return true;
  }

  if (
    /\b(no me interesa|no estoy interesado|no estoy interesada|no quiero|no necesito|no hace falta|no busco|no deseo)\b/.test(
      text,
    )
  ) {
    return true;
  }

  if (
    /\b(entre por error|entre sin querer|fue un error|me equivoque|numero equivocado|no era para ustedes|no es aca)\b/.test(
      text,
    )
  ) {
    return true;
  }

  return false;
}

function isReviewingDecision(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "").trim();
  if (!text) return false;

  return /\b(estoy (?:viendo|revisando|evaluando|pensando)|lo estoy (?:viendo|revisando|evaluando|pensando)|lo voy a (?:ver|revisar|evaluar|pensar)|voy a (?:verlo|revisarlo|evaluarlo|pensarlo)|lo reviso|lo miro|despues (?:te|les) digo)\b/.test(
    text,
  );
}

function isPositiveEmojiOnly(content: string | null | undefined): boolean {
  const compact = (content ?? "").replace(/\s+/g, "");
  if (!compact) return false;

  const normalizedEmoji = compact.replace(
    /[\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]/gu,
    "",
  );

  return /^(?:👍|👌|✅|☑|🙌|🙂|😊|😄|😃|🙏|❤|💚)+$/u.test(
    normalizedEmoji,
  );
}

function saysInfoWasNotReceived(
  content: string | null | undefined
): boolean {
  const text = normalizeText(content ?? "");

  return /\b(no me llego|no recibi|no me enviaron|no me mandaron|no me llego nada|no recibi nada)\b/.test(text);
}

function isWrongNumber(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "");
  return /\b(equivocado|error|equivoque|numero equivocado|telefono equivocado|no soy|no es aca|no pedi|no solicite)\b/.test(text);
}

function isClearlyNonCommercialQuery(
  content: string | null | undefined
): boolean {
  const text = normalizeText(content ?? "");

  if (!text) return false;

  return (
    // Búsqueda laboral
    /\b(busco trabajo|buscando trabajo|busqueda laboral|curriculum|curriculo|cv|empleo|vacante|trabajar con ustedes|trabajar en sm)\b/.test(text) ||

    // Proveedores / ofrecimientos ajenos
    /\b(soy proveedor|somos proveedores|ofrecerles|ofrecerles un servicio|publicidad|marketing|alianza comercial)\b/.test(text) ||

    // Consultas ajenas al producto
    /\b(app de calculadora|aplicacion calculadora|como funciona la calculadora|roblox)\b/.test(text) ||

    // Clientes que en realidad necesitan Soporte
    /\b(soy cliente|ya soy cliente|cliente actual|necesito soporte|soporte tecnico|problema con el sistema|error en el sistema)\b/.test(text) ||

    // Rastreo, búsqueda o acceso a datos/personas/WhatsApp
    /\b(rastrear|rastreo|rastreame|localizar|ubicar|encontrar|buscar)\b.*\b(whatsapp|wasap|wsp|telefono|celular|numero|persona)\b/.test(text) ||

    /\b(whatsapp|wasap|wsp|telefono|celular|numero)\b.*\b(de|del)\b.*\b(persona|chica|chico|mujer|hombre)\b/.test(text) ||

    /\b(rastrear|rastreo|localizar|ubicar)\b/.test(text) ||

    // La persona aclara expresamente que no tiene un negocio/comercio.
    // No aplica si vende/emprende sin local o está por iniciar uno.
    (/\b(no tengo|no tenemos|no poseo|no poseemos)\b.*\b(negocio|comercio|local|empresa|emprendimiento)\b/.test(text) &&
      !/\b(vendo|vendemos|venta|emprendo|emprendemos|desde casa|online|por internet|por redes|quiero abrir|voy a abrir|por abrir|quiero empezar|voy a empezar|quiero emprender)\b/.test(text)) ||

    // Consultas sobre el teléfono que llegaron por error desde un anuncio.
    /\b(ca.?mara|camara)\b.*\b(celular|telefono|movil)\b/.test(text) ||
    /\b(celular|telefono|movil)\b.*\b(ca.?mara|camara)\b/.test(text)
    ||

    // No posee negocio / menor de edad / contacto evidentemente no comercial
    /\b(no tengo negocio|no tengo comercio|no tengo local|no soy comerciante|soy|soi)\s+(un\s+)?(nene|nena|menor)\b/.test(text) ||
    /\btengo\s+\d{1,2}\s+(anos|años)\b/.test(text)
  );
}

function isIncludedEquipmentQuestion(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "").trim();
  if (!text) return false;

  return (
    /\b(tablet|equipo|equipamiento|hardware)\b.*\b(viene|incluye|incluido|incluida|incluidos|incluidas|entregan|dan)\b/.test(text) ||
    /\b(viene|incluye|incluido|incluida|incluidos|incluidas|entregan|dan)\b.*\b(tablet|equipo|equipamiento|hardware)\b/.test(text)
  );
}

function isQuestion(content: string | null | undefined): boolean {
  const original = (content ?? "").trim();
  if (original.includes("?")) return true;
  const text = normalizeText(original);
  return /^(como|que|cual|cuanto|cuando|donde|por que|tiene|tienen|puede|pueden|funciona|sirve|hay|se puede)\b/.test(text);
}

const DEFAULT_MESSAGES: Record<string, string> = {
  welcome_message: "¡Hola! 👋 Bienvenido a SM Soluciones. ¿De qué rubro es tu negocio (dietética, pet shop, etc.) y en qué te podemos ayudar hoy?",
  sales_message_dietetica: `Quiero presentarte nuestra solución de software de gestión, diseñada exclusivamente para tu rubro. Con más de 15 años siendo líderes en este sector, trabajando con proveedores, distribuidoras, franquicias y todo lo relacionado dietéticas, almacenes y mercados naturales ¡La mayoría de las distribuidoras más importantes del país son nuestros clientes!
¿Por qué *elegir* nuestro software? Aquí algunos de sus beneficios:

✨*Factura Electrónica Simple:* Olvídate de los costosos controladores fiscales, nuestro sistema genera facturas electrónicas y solo necesitas una pequeña impresora.

📧 *Envío de Facturas por Email:* Envía facturas en formato PDF directamente por correo electrónico a tus clientes.

🍎 *Integración con Balanzas:* Sincroniza productos con un clic, ahorrándote cientos de horas.

📊 *Gestión de Precios Eficiente:* Actualiza listas de precios rápidamente, incluso desde un Excel. 

📚 *Super completo:* Compras, estadísticas, cuentas corrientes, ¡todo incluido! También administra mix y fabricaciones, automatiza pedidos y controla el stock.

El sistema funciona en Windows 10 o superior. 

*Este sistema ha sido optimizado para tu rubro y respaldado por cientos de clientes satisfechos. Es Rápido, Fácil y Potente! ¡Mejora tu negocio ahora! Contáctanos hoy y descubre cómo podemos ayudarte a alcanzar el éxito. 💼*

▶️ Mirá cómo funciona nuestro sistema en este video:
https://youtu.be/3PlRpHUcK2U`,
  handoff_message: "Te derivamos con un asesor comercial de nuestro equipo para que te brinde atención personalizada.",
  no_knowledge_message: "Un asesor de nuestro equipo te contactará a la brevedad para responder tus consultas."
};

async function loadQualificationFlow(pool: Pool): Promise<QualificationFlow> {
  try {
    const result = await pool.query<QualificationFlow>(
      `SELECT
         COALESCE((value->>'enabled')::boolean, FALSE) AS enabled,
         COALESCE(value->>'intro_message', '') AS intro_message,
         COALESCE(ARRAY(SELECT jsonb_array_elements_text(value->'questions')), ARRAY[]::text[]) AS questions,
         COALESCE(value->>'completion_message', '') AS completion_message
       FROM bot_settings WHERE key = 'qualification_flow' LIMIT 1`
    );
    const value = result.rows[0];
    return {
      enabled: value?.enabled === true,
      intro_message: value?.intro_message ?? "",
      questions: (value?.questions ?? []).map((question) => question.trim()).filter(Boolean).slice(0, 6),
      completion_message: value?.completion_message ?? ""
    };
  } catch {
    return { enabled: false, intro_message: "", questions: [], completion_message: "" };
  }
}

async function loadMessage(pool: Pool, key: string): Promise<string> {
  try {
    const setting = await pool.query<{ text: string }>(
      `SELECT value->>'text' AS text FROM bot_settings WHERE key = $1 LIMIT 1`,
      [key]
    );
    const text = setting.rows[0]?.text?.trim();
    if (text) return text;
  } catch {
    // Si falla la consulta a la BD
  }
  return DEFAULT_MESSAGES[key] ?? "¡Gracias por comunicarte con SM Soluciones!";
}

async function loadPriceMessage(pool: Pool): Promise<string> {
  try {
    const result = await pool.query<{ price_message: string }>(
      `SELECT COALESCE(value->>'price_message', '') AS price_message
       FROM bot_settings WHERE key = 'bot_guidelines' LIMIT 1`
    );
    return result.rows[0]?.price_message?.trim() ?? "";
  } catch {
    return "";
  }
}

type ControlOrigin = "meta" | "google" | "web" | "otro";

interface OriginDetection {
  origin: ControlOrigin;
  detail:
    | "meta_label"
    | "google_label"
    | "web_label"
    | "meta_metadata"
    | "google_ads_metadata"
    | "web_organic"
    | "web_direct"
    | "web_metadata"
    | "meta_text"
    | "google_ads_text"
    | "web_text"
    | "unknown";
}

function getControlOrigin(
  labels: string[],
  content?: string | null
): ControlOrigin {
  const normalized = labels.map((label) => label.toLowerCase());

  if (normalized.includes("meta")) {
    return "meta";
  }

  if (normalized.includes("google")) {
    return "google";
  }

  if (normalized.includes("web")) {
    return "web";
  }

  if (isMetaLead(content)) {
    return "meta";
  }

  if (/\b(google ads|adwords|anuncio de google|publicidad de google)\b/.test(normalizeText(content ?? ""))) {
    return "google";
  }

  if (isWebsiteLead(content)) {
    return "web";
  }

  return "otro";
}

function collectOriginMetadata(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectOriginMetadata(item, depth + 1));
  }

  if (typeof value !== "object") return [];

  const result: string[] = [];
  const relevantKey = /(source|referr|referer|utm|campaign|medium|gclid|gbraid|wbraid|fbclid|landing|page_url|browser_url|channel|provider|origin)/i;

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (relevantKey.test(key) && (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean")) {
      result.push(`${key}=${String(raw)}`);
    }

    if (raw && typeof raw === "object") {
      result.push(...collectOriginMetadata(raw, depth + 1));
    }
  }

  return result;
}

function detectControlOrigin(
  payload: z.infer<typeof webhookSchema>,
  labels: string[],
  content?: string | null,
): OriginDetection {
  const normalizedLabels = labels.map((label) => label.toLowerCase());

  // Las etiquetas explícitas siguen siendo autoritativas para permitir
  // correcciones manuales desde Chatwoot.
  if (normalizedLabels.includes("meta")) {
    return { origin: "meta", detail: "meta_label" };
  }

  if (normalizedLabels.includes("google")) {
    return { origin: "google", detail: "google_label" };
  }

  if (normalizedLabels.includes("web")) {
    return { origin: "web", detail: "web_label" };
  }

  const rawPayload = payload as unknown as Record<string, unknown>;
  const metadataSignals = collectOriginMetadata({
    source: rawPayload.source,
    source_id: rawPayload.source_id,
    content_attributes: rawPayload.content_attributes,
    additional_attributes: rawPayload.additional_attributes,
    contact: rawPayload.contact,
    inbox: rawPayload.inbox,
    conversation_meta: payload.conversation.meta,
    conversation_additional_attributes:
      (payload.conversation as unknown as Record<string, unknown>).additional_attributes,
  });

  const metadata = normalizeText(metadataSignals.join(" "));

  const isOrganic = /\b(organic|organico|organica|seo)\b/.test(metadata);
  const isDirect = /\b(direct|directo|directa|none)\b/.test(metadata);
  const hasMeta = /\b(meta|facebook|instagram|fbclid|fb ads|facebook ads|instagram ads)\b/.test(metadata);
  const hasGoogle = /\b(google|adwords|google ads|gclid|gbraid|wbraid)\b/.test(metadata);
  const hasPaidMedium = /\b(cpc|ppc|paid|paidsearch|paid search|ads|ad)\b/.test(metadata);
  const hasWeb = /\b(web|website|browser|landing|referrer|referer|page url|page_url)\b/.test(metadata);

  if (hasMeta) {
    return { origin: "meta", detail: "meta_metadata" };
  }

  // Google sólo se contabiliza como Google cuando hay señal de Ads.
  // Si metadata indica organic/direct, se conserva como web y no se mezcla
  // con la inversión publicitaria.
  if (hasGoogle && !isOrganic && !isDirect && (hasPaidMedium || /\b(gclid|gbraid|wbraid|adwords|google ads)\b/.test(metadata))) {
    return { origin: "google", detail: "google_ads_metadata" };
  }

  if (isOrganic) {
    return { origin: "web", detail: "web_organic" };
  }

  if (isDirect) {
    return { origin: "web", detail: "web_direct" };
  }

  if (hasWeb || hasGoogle) {
    return { origin: "web", detail: "web_metadata" };
  }

  if (isMetaLead(content)) {
    return { origin: "meta", detail: "meta_text" };
  }

  if (/\b(google ads|adwords|anuncio de google|publicidad de google)\b/.test(normalizeText(content ?? ""))) {
    return { origin: "google", detail: "google_ads_text" };
  }

  if (isWebsiteLead(content)) {
    return { origin: "web", detail: "web_text" };
  }

  return { origin: "otro", detail: "unknown" };
}

function isProspectosCampaignMessage(event: Record<string, unknown>): boolean {
  const attributes = event.content_attributes;
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return false;
  }

  return (attributes as Record<string, unknown>).sm_prospectos_campaign === true;
}

function getCommercialRubroLabel(rubro?: string | null): string {
  if (rubro === "dietetica") return "tu dietética";
  if (rubro === "petshop") return "tu pet shop";
  return "tu negocio";
}

const SALES_PRESENTATION_VIDEO_URL = "https://youtu.be/3PlRpHUcK2U";

// La calificación es escrita: no ofrecer menús con respuestas 1/2.
const SALES_QUALIFICATION_CURRENT =
  "📝 Para orientarte mejor, ¿cómo llevás hoy las ventas, el stock y la administración de tu negocio? (Por ejemplo: otro sistema, Excel, anotaciones o todavía no abriste). Contame con tus palabras 😊";
const SALES_QUALIFICATION_NEED =
  "Gracias por contarme 😊 ¿Qué es lo que más necesitás mejorar o resolver con un sistema de gestión?";

function isWrittenQualificationAnswer(content: string): boolean {
  const text = normalizeText(content).trim();
  return text.length >= 3 && !/^(?:[0-9]+|si|sii+|no|dale|ok|okay|bueno|perfecto|gracias|hola|listo|emoji)$/i.test(text)
    && !isPrefilledAdOrWebsiteTemplate(content);
}

function buildCommercialContinuationPrompt(rubro?: string | null): string {
  return (
    `🤝 ¿Te gustaría ver una demostración de SM para ${getCommercialRubroLabel(rubro)} o preferís hablar primero con un asesor sobre planes y precios?\n\n` +
    "Contame qué preferís y te ponemos en contacto con nuestro equipo 😊"
  );
}

function buildCommercialAdvisorPrompt(_rubro?: string | null): string {
  return SALES_QUALIFICATION_CURRENT;
}

function buildCommercialIntro(rubro?: string | null): string {
  if (rubro === "dietetica") {
    return `¡Perfecto! 😊 Hace más de 15 años acompañamos a dietéticas, almacenes naturales y comercios del rubro.`;
  }

  if (rubro === "petshop") {
    return `¡Perfecto! 😊 Hace más de 15 años acompañamos a pet shops y comercios del rubro.`;
  }

  return `¡Perfecto! 😊 Hace más de 15 años desarrollamos soluciones de gestión para comercios y pymes.`;
}

function buildCommercialProposal(rubro?: string | null): string {
  if (rubro === "dietetica") {
    return `Con SM podés gestionar *ventas, stock, compras, caja y facturación*; precios y etiquetas; códigos de barras y *balanzas para venta por peso*; y sumar tienda online según lo que necesites.`;
  }

  if (rubro === "petshop") {
    return `Con SM podés gestionar *ventas, stock, compras, caja y facturación*; productos, precios y etiquetas; códigos de barras y, si vendés alimento suelto, *balanzas para venta por peso*. También podés sumar tienda online.`;
  }

  return `Con SM podés gestionar *ventas, stock, compras, caja y facturación*, además de precios, códigos de barras, etiquetas y otras herramientas según la operatoria de tu negocio.`;
}

function buildCommercialOverview(rubro?: string | null): string {
  return (
    `${buildCommercialIntro(rubro)}\n\n` +
    `${buildCommercialProposal(rubro)}\n\n` +
    `💡 Hay *diferentes planes según tu negocio*: opciones simples para quienes están empezando y gestión completa para comercios con mayor volumen o sucursales.\n\n` +
    `🎥 *Mirá una breve presentación de SM:*\n${SALES_PRESENTATION_VIDEO_URL}`
  );
}

export function createChatwootWebhookProcessor(
  config: ProcessorConfig,
  pool: Pool,
  client: ChatwootClient,
  logger: ProcessorLogger = { info() {}, warn() {} },
  answerService?: KnowledgeAnswerService,
  unansweredTracker?: UnansweredQuestionTracker,
  prospectosClient?: ProspectosClient

): ChatwootWebhookProcessor {
  const openai = config.openAiApiKey
    ? new OpenAI({ apiKey: config.openAiApiKey })
    : null;
  const now = config.now ?? (() => new Date());

  const transcribeIncomingAudio = async (
    conversationId: number,
    attachment: WebhookAttachment,
  ): Promise<string> => {
    const existingTranscript = attachment.transcribed_text?.trim();
    if (existingTranscript) return existingTranscript;

    if (!openai || !attachment.data_url) {
      return "";
    }

    // Evitar descargar archivos absurdamente grandes por error. Chatwoot acepta
    // hasta 40 MB por defecto; para audios comerciales este límite es suficiente.
    if ((attachment.file_size ?? 0) > 25 * 1024 * 1024) {
      logger.warn(
        { conversationId, fileSize: attachment.file_size ?? null },
        "Audio omitido por exceder el límite de transcripción",
      );
      return "";
    }

    try {
      const downloaded = await downloadAudioWithRetry(attachment.data_url);
      const contentType =
        downloaded.contentType ||
        attachment.content_type ||
        "audio/ogg";
      const extension = normalizeAudioExtension(attachment.extension);
      const normalizedContentType =
        extension === "ogg" && /^audio\/(?:oga|x-ogg)$/i.test(contentType)
          ? "audio/ogg"
          : contentType;
      const file = await toFile(downloaded.buffer, `audio.${extension}`, {
        type: normalizedContentType,
      });

      if (downloaded.attempts > 1) {
        logger.info(
          {
            conversationId,
            attachmentId: attachment.id ?? null,
            attempts: downloaded.attempts,
          },
          "Audio disponible después de reintentar la descarga desde Chatwoot",
        );
      }

      const transcription = await openai.audio.transcriptions.create({
        file,
        model: "gpt-4o-mini-transcribe",
        language: "es",
        prompt:
          "Conversación comercial en español de Argentina sobre software de gestión para comercios. Puede mencionar dietética, almacén, carnicería, pollería, pescadería, pet shop, facturación, stock, precios, balanza, demo o asesor.",
      });

      const text = transcription.text?.trim() ?? "";
      if (text) {
        logger.info(
          { conversationId, attachmentId: attachment.id ?? null },
          "Audio transcripto correctamente",
        );
      }
      return text;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(
        {
          conversationId,
          attachmentId: attachment.id ?? null,
          error: errorMessage,
        },
        `No se pudo transcribir el audio entrante: ${errorMessage}`,
      );
      return "";
    }
  };

  return {
    accept(routeToken, headers, body) {
      if (!constantTimeEqual(routeToken, config.webhookToken)) {
        console.warn("WEBHOOK RECHAZADO: token incorrecto");
        return null;
      }

      // Chatwoot envía los eventos conversation_* con los datos de la
      // conversación en el nivel principal del payload. Internamente los
      // normalizamos al formato que ya utiliza el resto del bot.
      let normalizedBody = body;

      if (
        body !== null &&
        typeof body === "object" &&
        !Array.isArray(body)
      ) {
        const raw = body as Record<string, unknown>;

        if (
          typeof raw.event === "string" &&
          raw.event.startsWith("conversation_") &&
          raw.conversation === undefined &&
          raw.id !== undefined &&
          raw.inbox_id !== undefined
        ) {
          normalizedBody = {
            ...raw,
            conversation: {
              ...raw,
              id: raw.id,
              inbox_id: raw.inbox_id,
              status: raw.status,
              labels: raw.labels,
              meta: raw.meta
            }
          };
        }
      }

      const parsed = webhookSchema.safeParse(normalizedBody);

      if (!parsed.success) {
        console.warn(
          "WEBHOOK RECHAZADO: payload inválido",
          JSON.stringify(parsed.error.issues, null, 2)
        );
        return null;
      }

      const serialized = JSON.stringify(parsed.data);
      return {
        deliveryId:
          typeof headers["x-chatwoot-delivery"] === "string"
            ? headers["x-chatwoot-delivery"]
            : undefined,
        payload: parsed.data,
        payloadHash: createHash("sha256").update(serialized).digest("hex")
      };
    },

    async process(accepted) {
      const event = accepted.payload;
      const inboxId = event.inbox?.id ?? event.conversation.inbox_id;
      const accountId = event.account?.id;

      
      if (
        event.event === "message_created" &&
        event.message_type === "outgoing" &&
        !event.private &&
        isProspectosCampaignMessage(event as unknown as Record<string, unknown>) &&
        inboxId === config.inboxId &&
        (accountId === undefined || accountId === config.accountId)
      ) {
        await pool.query(
          `INSERT INTO conversation_state (
             chatwoot_conversation_id, chatwoot_contact_id, chatwoot_inbox_id,
             stage, human_handoff, last_message_at, state
           ) VALUES (
             $1, NULL, $2, 'proposal_sent', FALSE, NOW(),
             '{"campaign_recontact":true,"is_recontact":false,"recontact_prompted":true}'::jsonb
           )
           ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET
             stage = 'proposal_sent',
             human_handoff = FALSE,
             prospect_followup_due_at = NULL,
             prospect_followup_completed = TRUE,
             pending_agent_since = NULL,
             pending_agent_alert_due_at = NULL,
             pending_agent_alerted_at = NULL,
             state = jsonb_set(
               jsonb_set(
                 jsonb_set(
                   COALESCE(conversation_state.state, '{}'::jsonb),
                   '{campaign_recontact}', 'true'::jsonb, true
                 ),
                 '{is_recontact}', 'false'::jsonb, true
               ),
               '{recontact_prompted}', 'true'::jsonb, true
             ),
             last_message_at = NOW()`,
          [event.conversation.id, inboxId],
        );

        logger.info(
          { conversationId: event.conversation.id },
          "Mensaje de campaña registrado sin detener Bot Ventas",
        );
        return;
      }

      if (
        event.event === "message_created" &&
        event.message_type === "outgoing" &&
        !event.private &&
        /^(user|agent)$/i.test(event.sender?.type ?? "") &&
        event.sender?.id !== config.botAgentId &&
        !isProspectosCampaignMessage(event as unknown as Record<string, unknown>) &&
        inboxId === config.inboxId &&
        (accountId === undefined || accountId === config.accountId)

        
      ) {
        await pool.query(
          `INSERT INTO conversation_state (
            chatwoot_conversation_id,
            chatwoot_contact_id,
            chatwoot_inbox_id,
            stage,
            human_handoff,
            last_message_at,
            pending_agent_since,
            pending_agent_alert_due_at,
            pending_agent_alerted_at,
            state
          )
          VALUES (
            $1, NULL, $2, 'human', TRUE, NOW(),
            NULL, NULL, NULL,
            jsonb_build_object(
              'sales_alert_level', 0,
              'sales_social_closure', $3::boolean
            )
          )
          ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET
            stage = 'human',
            human_handoff = TRUE,
            last_message_at = NOW(),
            pending_agent_since = NULL,
            pending_agent_alert_due_at = NULL,
            pending_agent_alerted_at = NULL,
            state = jsonb_set(
              jsonb_set(
                COALESCE(conversation_state.state, '{}'::jsonb),
                '{sales_alert_level}',
                '0'::jsonb,
                true
              ),
              '{sales_social_closure}',
              to_jsonb($3::boolean),
              true
            )`,
          [event.conversation.id, inboxId, isHumanClosingMessage(event.content)],
        );

        if (prospectosClient) {
          try {
            await prospectosClient.registerControlEvent({
              chatwoot_conversation_id: event.conversation.id,
              evento: "respuesta_vendedor",
            });
          } catch (controlErr) {
            logger.warn(
              {
                conversationId: event.conversation.id,
                senderId: event.sender?.id,
                error:
                  controlErr instanceof Error
                    ? controlErr.message
                    : String(controlErr),
              },
              "No se pudo registrar la primera respuesta del vendedor en Control de Ventas",
            );
          }
        }

        logger.info(
          { conversationId: event.conversation.id },
          "Intervención humana detectada; bot detenido",
        );
        return;
      }

      // Alta manual de prospectos internos desde Chatwoot.
      // Puede provenir de cualquier inbox de la cuenta.
      // Si un agente agrega la etiqueta "prospecto-interno",
      // se crea o actualiza automáticamente en Prospectos SM.
      if (
        event.event === "conversation_updated" &&
        (accountId === undefined || accountId === config.accountId)
      ) {
        const labels = Array.isArray(
          (event.conversation as { labels?: string[] }).labels,
        )
          ? ((event.conversation as { labels?: string[] }).labels as string[])
          : [];

        // Guardar que la conversación quedó resuelta. Si el prospecto vuelve a
        // escribir más adelante, el bot debe tratarlo como recontacto y volver
        // a mostrar las opciones comerciales antes de cualquier derivación.
        if (
          event.conversation.status === "resolved" &&
          !labels.includes("consulta-erronea") &&
          !labels.includes("bloqueado-bot")
        ) {
          await pool.query(
            `INSERT INTO conversation_state (
               chatwoot_conversation_id,
               chatwoot_contact_id,
               chatwoot_inbox_id,
               last_message_at,
               state
             )
             VALUES (
               $1, NULL, $2, NOW(),
               '{"is_recontact":true,"recontact_prompted":false}'::jsonb
             )
             ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET
               state = jsonb_set(
                 jsonb_set(
                   COALESCE(conversation_state.state, '{}'::jsonb),
                   '{is_recontact}',
                   'true'::jsonb,
                   true
                 ),
                 '{recontact_prompted}',
                 'false'::jsonb,
                 true
               ),
               prospect_followup_due_at = NULL,
               last_message_at = NOW()`,
            [event.conversation.id, inboxId],
          );

          logger.info(
            { conversationId: event.conversation.id },
            "Conversación resuelta marcada para recontacto",
          );
        }

          // ---------------------------------------------------------
// CLIENTE ACTIVO
// ---------------------------------------------------------
// La etiqueta cliente-activo bloquea definitivamente el bot
// comercial para esta conversación.
//
// La marca cliente_activo_notificado se guarda dentro de
// conversation_state.state para que la nota privada se cree
// una sola vez.
// ---------------------------------------------------------

if (labels.includes("cliente-activo")) {
  // Garantizar que exista el estado y detener cualquier
  // automatización comercial pendiente.
  await pool.query(
    `
    INSERT INTO conversation_state (
      chatwoot_conversation_id,
      chatwoot_contact_id,
      chatwoot_inbox_id,
      stage,
      human_handoff,
      last_message_at
    )
    VALUES (
      $1,
      NULL,
      $2,
      'human',
      TRUE,
      NOW()
    )
    ON CONFLICT (chatwoot_conversation_id)
    DO UPDATE SET
      stage = 'human',
      human_handoff = TRUE,
      prospect_followup_due_at = NULL,
      prospect_followup_completed = TRUE,
      pending_agent_since = NULL,
      pending_agent_alert_due_at = NULL,
      last_message_at = NOW()
    `,
    [
      event.conversation.id,
      inboxId,
    ],
  );

  // Tomar de forma atómica el derecho a crear la nota.
  // Si otro webhook ya la creó, RETURNING no devuelve filas.
  const notaPendiente = await pool.query(
    `
    UPDATE conversation_state
    SET state = jsonb_set(
      COALESCE(state, '{}'::jsonb),
      '{cliente_activo_notificado}',
      'true'::jsonb,
      true
    )
    WHERE chatwoot_conversation_id = $1
      AND COALESCE(
        state->>'cliente_activo_notificado',
        'false'
      ) <> 'true'
    RETURNING chatwoot_conversation_id
    `,
    [event.conversation.id],
  );

  if (notaPendiente.rowCount) {
    try {
      await client.sendPrivateNote(
        event.conversation.id,
        "✅ Cliente marcado como activo.\n\n" +
          "La atención operativa debe realizarse desde el canal de Soporte.",
      );

      logger.info(
        {
          conversationId: event.conversation.id,
        },
        "Nota interna de cliente activo creada",
      );
    } catch (err) {
      // Si Chatwoot falló al crear la nota, liberamos la marca
      // para que otro evento pueda reintentarlo.
      await pool.query(
        `
        UPDATE conversation_state
        SET state = jsonb_set(
          COALESCE(state, '{}'::jsonb),
          '{cliente_activo_notificado}',
          'false'::jsonb,
          true
        )
        WHERE chatwoot_conversation_id = $1
        `,
        [event.conversation.id],
      );

      logger.warn(
        {
          conversationId: event.conversation.id,
          error:
            err instanceof Error
              ? err.message
              : String(err),
        },
        "No se pudo crear la nota interna de cliente activo",
      );
    }
  }

  logger.info(
    {
      conversationId: event.conversation.id,
    },
    "Cliente activo: bot de Ventas detenido",
  );

  return;
}

          

          const assignee = (
  event.conversation.meta as
    | {
        assignee?: { id?: number };
      }
    | undefined
)?.assignee;

if (
  prospectosClient &&
  assignee?.id &&
  inboxId === config.inboxId
) {
  try {
    await prospectosClient.updateAssignee(
      event.conversation.id,
      assignee.id,
    );

    logger.info(
      {
        conversationId: event.conversation.id,
        agentId: assignee.id,
      },
      "Responsable sincronizado desde Chatwoot",
    );
  } catch (err) {
    logger.warn(
      {
        conversationId: event.conversation.id,
        agentId: assignee.id,
        error:
          err instanceof Error
            ? err.message
            : String(err),
      },
      "No se pudo sincronizar el responsable desde Chatwoot",
    );
  }
}

          const tieneGoogle = labels.includes("google");
          const tieneMeta = labels.includes("meta");
          const tieneWeb = labels.includes("web");
          const cantidadOrigenes = [tieneGoogle, tieneMeta, tieneWeb].filter(Boolean).length;

if (
  cantidadOrigenes === 1 &&
  labels.includes("auditar-origen")
) {
  try {
    await client.removeLabels(
      event.conversation.id,
      ["auditar-origen"],
    );
  } catch (err) {
    logger.warn(
      {
        conversationId: event.conversation.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "No se pudo eliminar auditar-origen",
    );
  }
}

if (
  prospectosClient &&
  cantidadOrigenes === 1
) {
  const origenEtiqueta: "google" | "meta" | "web" =
    tieneGoogle ? "google" : tieneMeta ? "meta" : "web";

  try {
    await prospectosClient.updateOrigin(
      event.conversation.id,
      origenEtiqueta,
    );

    logger.info(
      {
        conversationId: event.conversation.id,
        origen: origenEtiqueta,
      },
      "Origen sincronizado desde etiqueta de Chatwoot",
    );
  } catch (err) {
    logger.warn(
      {
        conversationId: event.conversation.id,
        origen: origenEtiqueta,
        error:
          err instanceof Error
            ? err.message
            : String(err),
      },
      "No se pudo sincronizar el origen desde Chatwoot",
    );
  }
}


if (labels.includes("consulta-erronea")) {
  // La etiqueta manual es la fuente de verdad para sacar una conversación
  // del circuito comercial. Limpiamos tanto seguimiento como reasignación,
  // aunque el evento anterior haya dejado la conversación en human_handoff.
  await pool.query(
    `INSERT INTO conversation_state (
       chatwoot_conversation_id, chatwoot_contact_id, chatwoot_inbox_id,
       stage, human_handoff, last_message_at
     ) VALUES ($1, NULL, $2, 'human', TRUE, NOW())
     ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET
       stage = 'human',
       human_handoff = TRUE,
       prospect_followup_due_at = NULL,
       prospect_followup_completed = TRUE,
       pending_agent_since = NULL,
       pending_agent_alert_due_at = NULL,
       pending_agent_alerted_at = COALESCE(
         conversation_state.pending_agent_alerted_at,
         NOW()
       ),
       sales_assignee_id = NULL,
       sales_assignee_name = NULL,
       rubro = NULL,
       state = jsonb_set(
         jsonb_set(
           (
             COALESCE(conversation_state.state, '{}'::jsonb)
             - 'rubro'
             - 'rubro_libre'
             - 'lead_intent'
             - 'lead_summary'
             - 'requested_demo'
             - 'proposal_sent'
             - 'is_recontact'
             - 'recontact_prompted'
             - 'rubro_invalid_attempts'
             - 'handoff_message_sent'
             - 'sales_alert_level'
             - 'chat_history'
           ),
           '{memory}',
           (
             COALESCE(conversation_state.state->'memory', '{}'::jsonb)
             - 'rubro'
             - 'lead_intent'
             - 'requested_demo'
             - 'proposal_sent'
           ),
           true
         ),
         '{manual_exclusion}',
         '"consulta_erronea"'::jsonb,
         true
       ) || jsonb_build_object('wrong_query_repeat_count', 0),
       last_message_at = NOW()`,
    [event.conversation.id, inboxId],
  );

  if (prospectosClient) {
    try {
      await prospectosClient.registerControlEvent({
        chatwoot_conversation_id: event.conversation.id,
        evento: "consulta_erronea",
        origen: getControlOrigin(labels),
      });
    } catch (err) {
      logger.warn(
        {
          conversationId: event.conversation.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "No se pudo registrar consulta errónea manual en Control",
      );
    }
  }

  const routingLabelsToRemove = ["derivar-ventas", "bot-ventas-activo"].filter(
    (label) => labels.includes(label),
  );

  if (routingLabelsToRemove.length > 0) {
    try {
      await client.removeLabels(event.conversation.id, routingLabelsToRemove);
    } catch (err) {
      logger.warn(
        { conversationId: event.conversation.id, error: err instanceof Error ? err.message : String(err) },
        "No se pudieron limpiar las etiquetas de ruteo de una consulta errónea",
      );
    }
  }

  if (event.conversation.status !== "resolved") {
    try {
      await client.setStatus(event.conversation.id, "resolved");
    } catch (err) {
      logger.warn(
        { conversationId: event.conversation.id, error: err instanceof Error ? err.message : String(err) },
        "No se pudo resolver automáticamente la consulta errónea",
      );
    }
  }

  logger.info(
    { conversationId: event.conversation.id },
    "Consulta errónea excluida definitivamente del circuito de Ventas",
  );

  return;
}


          
        // Si Ventas contactó al prospecto por fuera de Chatwoot,
        // cancelar la alerta pendiente.
        if (labels.includes("contactado-ventas")) {
          await pool.query(
            `UPDATE conversation_state
              SET pending_agent_since = NULL,
                  pending_agent_alert_due_at = NULL,
                  pending_agent_alerted_at = NULL,
                  state = jsonb_set(
                    COALESCE(state, '{}'::jsonb),
                    '{sales_alert_level}',
                    '0'::jsonb,
                    true
                  )
              WHERE chatwoot_conversation_id = $1`,
            [event.conversation.id],
          );

          if (prospectosClient) {
            try {
              await prospectosClient.registerControlEvent({
                chatwoot_conversation_id: event.conversation.id,
                evento: "cancelar_espera_vendedor",
              });
            } catch (controlErr) {
              logger.warn(
                {
                  conversationId: event.conversation.id,
                  error:
                    controlErr instanceof Error
                      ? controlErr.message
                      : String(controlErr),
                },
                "No se pudo limpiar la espera de Ventas en Prospectos",
              );
            }
          }

          logger.info(
            {
              conversationId: event.conversation.id,
            },
            "Alerta de Ventas cancelada: prospecto marcado como contactado",
          );

          return;
        }

        // Si bot-ventas-activo fue quitada de una conversación que estaba siendo
        // atendida por el bot, detener la atención automática.
        if (
          !labels.includes("bot-ventas-activo") &&
          !labels.includes("derivar-ventas")
        ) {
          const botState = await pool.query<{
            stage: string;
            human_handoff: boolean;
            state: ConversationData;
          }>(
            `SELECT stage, human_handoff, state
          FROM conversation_state
          WHERE chatwoot_conversation_id = $1
          LIMIT 1`,
            [event.conversation.id],
          );

          const previousState = botState.rows[0];

          const isCampaignRecontact =
            previousState?.state?.campaign_recontact === true;

          if (
            previousState &&
            !previousState.human_handoff &&
            previousState.stage !== "new" &&
            !isCampaignRecontact
          ) {
            await pool.query(
              `UPDATE conversation_state
            SET human_handoff = TRUE,
                stage = 'human',
                last_message_at = NOW()
            WHERE chatwoot_conversation_id = $1`,
              [event.conversation.id],
            );

            logger.info(
              {
                conversationId: event.conversation.id,
                labels,
              },
              "Etiqueta bot-ventas-activo removida; bot detenido manualmente",
            );
          }
        }
        // Si la conversación tiene derivar-ventas, el bot debe permanecer detenido.
        if (labels.includes("derivar-ventas")) {
          await pool.query(
            `UPDATE conversation_state
          SET stage = 'human',
              human_handoff = TRUE,
              last_message_at = NOW()
          WHERE chatwoot_conversation_id = $1`,
            [event.conversation.id],
          );

          logger.info(
            {
              conversationId: event.conversation.id,
              labels,
            },
            "Conversación derivada a Ventas; bot detenido",
          );
        }

        // Si se agregó bot-ventas-activo y ya no está derivar-ventas,
        // habilitar nuevamente la atención automática.
        if (
          labels.includes("bot-ventas-activo") &&
          !labels.includes("derivar-ventas")
        ) {
          await pool.query(
            `UPDATE conversation_state
            SET human_handoff = FALSE,
                stage = CASE
                  WHEN stage = 'human' THEN 'qualified'
                  ELSE stage
                END,
                prospect_followup_due_at = NOW() + INTERVAL '24 hours',
                prospect_followup_completed = FALSE,
                pending_agent_since = NULL,
                pending_agent_alert_due_at = NULL,
                pending_agent_alerted_at = NULL,
                state = jsonb_set(
                  COALESCE(state, '{}'::jsonb),
                  '{sales_alert_level}',
                  '0'::jsonb,
                  true
                ),
                last_message_at = NOW()
          WHERE chatwoot_conversation_id = $1`,
            [event.conversation.id],
          );

          if (prospectosClient) {
            try {
              await prospectosClient.registerControlEvent({
                chatwoot_conversation_id: event.conversation.id,
                evento: "cancelar_espera_vendedor",
              });
            } catch (controlErr) {
              logger.warn(
                {
                  conversationId: event.conversation.id,
                  error:
                    controlErr instanceof Error
                      ? controlErr.message
                      : String(controlErr),
                },
                "No se pudo limpiar la espera de Ventas al reactivar el bot",
              );
            }
          }

          logger.info(
            {
              conversationId: event.conversation.id,
              labels,
            },
            "Bot activado mediante etiqueta bot-ventas-activo",
          );
        }

        
      // Sincronización con Prospectos.
      //
      // - derivar-ventas: derivación comercial normal, automática o manual.
      // - prospecto-interno: referido/contacto ingresado por fuera de Meta/Google.
      //
      // IMPORTANTE: auditar-origen es solo una etiqueta técnica para revisar el
      // origen. Nunca debe crear un prospecto por sí sola.
      //
      // syncProspect debe comportarse como alta/actualización y no generar duplicados.
      const esDerivacionVentas = labels.includes("derivar-ventas");
      const esProspectoInterno = labels.includes("prospecto-interno");

      if (!esDerivacionVentas && !esProspectoInterno) {
        return;
      }
      let origenProspecto: string;

      if (esProspectoInterno) {
        origenProspecto = "prospecto-interno";
      } else {
        const origenControl = getControlOrigin(labels);

        origenProspecto = origenControl;
      }

      const estadoConversacion = await pool.query<{
      rubro: string | null;
      state: ConversationData;
    }>(
      `SELECT rubro, state
      FROM conversation_state
      WHERE chatwoot_conversation_id = $1
      LIMIT 1`,
      [event.conversation.id],
    );

    const estadoGuardado = estadoConversacion.rows[0];

    const rubroGuardado =
      estadoGuardado?.rubro ||
      (estadoGuardado?.state?.memory?.rubro as string | undefined) ||
      null;

    const rubroProspecto =
      esProspectoInterno
        ? null
        : rubroGuardado;

        if (!prospectosClient) {
          logger.warn(
            {
              conversationId: event.conversation.id,
              origen: origenProspecto,
              labels,
            },
            "Prospecto no sincronizado: ProspectosClient no configurado",
          );
          return;
        }

        const telefono = event.conversation.meta?.sender?.phone_number ?? null;

        const sender = event.conversation.meta?.sender as
          | {
              id?: number;
              name?: string;
              phone_number?: string | null;
            }
          | undefined;

        const nombreContacto = sender?.name?.trim() || "Sin nombre";

        if (!telefono) {
          logger.warn(
            {
              conversationId: event.conversation.id,
              origen: origenProspecto,
              nombreContacto,
            },
            "Prospecto ignorado: contacto sin teléfono",
          );
          return;
        }

        try {
          const resultado = await prospectosClient.syncProspect({
            nombre_contacto: nombreContacto,
            telefono,
            rubro: rubroProspecto,           
            origen: origenProspecto,
            chatwoot_agent_id: assignee?.id ?? null,
            chatwoot_conversation_id: event.conversation.id,
          });

          logger.info(
            {
              conversationId: event.conversation.id,
              telefono,
              nombreContacto,
              origen: origenProspecto,
              agentId: assignee?.id ?? null,
              prospectoId: resultado.id ?? null,
              duplicado: resultado.duplicado ?? false,
              actualizado: resultado.actualizado ?? false,
            },
            "Prospecto manual creado o actualizado correctamente",
          );
        } catch (err) {
          logger.warn(
            {
              conversationId: event.conversation.id,
              telefono,
              nombreContacto,
              origen: origenProspecto,
              agentId: assignee?.id ?? null,
              error: err instanceof Error ? err.message : String(err),
            },
            "Error al crear o actualizar prospecto manual",
          );
        }

        return;
      }

      logger.info(
  {
    event: event.event,
    messageId: event.id,
    conversationId: event.conversation.id,
    messageType: event.message_type,
    inboxId,
    expectedInboxId: config.inboxId,
    accountId,
    expectedAccountId: config.accountId,
    private: event.private,
    content: event.content ?? null,
  },
  "Webhook recibido desde Chatwoot",
);

      if (
        event.event !== "message_created" ||
        event.message_type !== "incoming" ||
        event.private ||
        inboxId !== config.inboxId ||
        (accountId !== undefined && accountId !== config.accountId)
      ) {
        logger.info(
          {
            event: event.event,
            inboxId,
            accountId,
            messageType: event.message_type,
          },
          "Evento de Chatwoot ignorado",
        );
        return;
      }

      logger.info(
        { event: event.event, inboxId, conversationId: event.conversation.id },
        "Mensaje entrante de Chatwoot aceptado",
      );

      const senderName = event.conversation.meta?.sender?.name?.trim() || null;

      const senderPhone =
        event.conversation.meta?.sender?.phone_number?.trim() || null;

        if (isInternalPhone(senderPhone)) {
        logger.info(
          {
            conversationId: event.conversation.id,
            phone: senderPhone,
          },
          "Conversación interna ignorada por teléfono",
        );

        return;
      }

      if (senderName || senderPhone) {
        await pool.query(
          `UPDATE conversation_state
          SET state =
            jsonb_set(
              jsonb_set(
                COALESCE(state, '{}'::jsonb),
                '{lead_name}',
                to_jsonb(COALESCE($2::text, state->>'lead_name')),
                true
              ),
              '{lead_phone}',
              to_jsonb(COALESCE($3::text, state->>'lead_phone')),
              true
            )
          WHERE chatwoot_conversation_id = $1`,
          [event.conversation.id, senderName, senderPhone],
        );
      }

      const eventKey = `message_created:${config.accountId}:${event.id}`;
      const inserted = await pool.query(
        `INSERT INTO webhook_events (event_key, event_type, payload_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_key) DO NOTHING
         RETURNING event_key`,
        [eventKey, event.event, accepted.payloadHash],
      );
      if (inserted.rowCount !== 1) {
        logger.info(
          { conversationId: event.conversation.id },
          "Evento duplicado ignorado",
        );
        return;
      }

      // Bloqueo definitivo: si la conversación ya fue marcada como bloqueado-bot,
      // ningún mensaje posterior puede reactivar el circuito comercial.
      try {
        const labelsBeforeReactivation = await client.getLabels(event.conversation.id);
        if (labelsBeforeReactivation.some((label) => label.toLowerCase() === "bloqueado-bot")) {
          logger.info(
            { conversationId: event.conversation.id },
            "Conversación bloqueada: mensaje entrante ignorado definitivamente",
          );
          return;
        }
      } catch {
        const webhookLabels = Array.isArray((event.conversation as { labels?: string[] }).labels)
          ? ((event.conversation as { labels?: string[] }).labels as string[])
          : [];
        if (webhookLabels.some((label) => label.toLowerCase() === "bloqueado-bot")) {
          logger.info(
            { conversationId: event.conversation.id },
            "Conversación bloqueada según webhook: mensaje entrante ignorado",
          );
          return;
        }
      }

      // El prospecto respondió: cancelar cualquier seguimiento automático pendiente.
      // Conservamos el número de intento para saber a qué seguimiento está respondiendo.
      await pool.query(
        `UPDATE conversation_state
        SET prospect_followup_due_at = NULL,
            prospect_followup_completed = FALSE
        WHERE chatwoot_conversation_id = $1`,
        [event.conversation.id],
      );

      // Si este prospecto había quedado "sin respuesta",
      // al volver a escribir reactivamos el seguimiento.
      try {
        const currentLabels = await client.getLabels(event.conversation.id);

        const estabaSinRespuesta = currentLabels.some(
          (label) => label.toLowerCase() === "sin respuesta",
        );

        if (estabaSinRespuesta) {
          await client.removeLabels(event.conversation.id, ["sin respuesta"]);

          if (prospectosClient) {
            await prospectosClient.updateStatus(
              event.conversation.id,
              "prospecto",
            );
          }

          logger.info(
            {
              conversationId: event.conversation.id,
            },
            "Prospecto reactivado automáticamente al volver a escribir",
          );
        }
      } catch (error) {
        logger.warn(
          {
            conversationId: event.conversation.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "No se pudo reactivar automáticamente el prospecto",
        );
      }

      if (!config.replyEnabled) {
        logger.warn(
          { conversationId: event.conversation.id },
          "Respuesta desactivada por configuración",
        );
        return;
      }
      const behavior = await pool.query<{ enabled: boolean }>(
        `SELECT COALESCE((value->>'enabled')::boolean, TRUE) AS enabled
         FROM bot_settings WHERE key = 'bot_behavior' LIMIT 1`,
      );
      if (behavior.rows[0]?.enabled === false) {
        logger.warn(
          { conversationId: event.conversation.id },
          "Bot pausado desde la configuración",
        );
        return;
      }

      let currentLabels: string[] = [];
      try {
        currentLabels = await client.getLabels(event.conversation.id);
      } catch {
        currentLabels = Array.isArray(
          (event.conversation as { labels?: string[] }).labels,
        )
          ? ((event.conversation as { labels?: string[] }).labels as string[])
          : [];

          
      }

      

      // Segundo corte de seguridad antes de cualquier lógica comercial.
      if (currentLabels.some((label) => label.toLowerCase() === "bloqueado-bot")) {
        logger.info(
          { conversationId: event.conversation.id },
          "Conversación bloqueada: procesamiento comercial cancelado",
        );
        return;
      }

      if (currentLabels.includes("cliente-activo")) {
        await pool.query(
          `UPDATE conversation_state
          SET stage = 'human',
              human_handoff = TRUE,
              prospect_followup_due_at = NULL,
              prospect_followup_completed = TRUE,
              pending_agent_since = NULL,
              pending_agent_alert_due_at = NULL,
              pending_agent_alerted_at = COALESCE(
                pending_agent_alerted_at,
                NOW()
              ),
              last_message_at = NOW()
          WHERE chatwoot_conversation_id = $1`,
          [event.conversation.id],
        );

        logger.info(
          {
            conversationId: event.conversation.id,
          },
          "Cliente activo: bot de Ventas deshabilitado para esta conversación",
        );

        return;
      }

 

      // Un cierre humano (por ejemplo "Gracias por la respuesta. Saludos")
      // permite ignorar una cortesía posterior sin iniciar un SLA infinito.
      // La regla se aplica solo a conversaciones ya derivadas a Ventas.
      const closingReplyText = (event.content ?? "").trim();
      const hasClosingAudio = (event.attachments ?? []).some(isAudioAttachment);
      if (
        currentLabels.includes("derivar-ventas") &&
        !hasClosingAudio &&
        isSocialClosingReply(closingReplyText)
      ) {
        const closedCourtesy = await pool.query(
          `UPDATE conversation_state
              SET pending_agent_since = NULL,
                  pending_agent_alert_due_at = NULL,
                  pending_agent_alerted_at = NULL,
                  state = jsonb_set(
                    COALESCE(state, '{}'::jsonb),
                    '{sales_alert_level}',
                    '0'::jsonb,
                    true
                  ),
                  last_message_at = NOW()
            WHERE chatwoot_conversation_id = $1
              AND COALESCE((state->>'sales_social_closure')::boolean, FALSE) = TRUE
          RETURNING chatwoot_conversation_id`,
          [event.conversation.id],
        );

        if (closedCourtesy.rowCount === 1) {
          if (prospectosClient) {
            try {
              await prospectosClient.registerControlEvent({
                chatwoot_conversation_id: event.conversation.id,
                evento: "cancelar_espera_vendedor",
              });
            } catch (controlErr) {
              logger.warn(
                { conversationId: event.conversation.id, error: controlErr instanceof Error ? controlErr.message : String(controlErr) },
                "No se pudo limpiar la espera en Prospectos después de una cortesía de cierre",
              );
            }
          }
          try {
            await client.setStatus(event.conversation.id, "resolved");
          } catch (error) {
            logger.warn(
              { conversationId: event.conversation.id, error: error instanceof Error ? error.message : String(error) },
              "No se pudo volver a resolver la conversación después de una cortesía de cierre",
            );
          }
          logger.info(
            { conversationId: event.conversation.id },
            "Cortesía posterior al cierre ignorada; no se inició un nuevo SLA",
          );
          return;
        }
      }

      if (currentLabels.includes("consulta-erronea")) {
        const incomingText = (event.content ?? "").trim();
        const hasIncomingAudio = (event.attachments ?? []).some(isAudioAttachment);
        const hasCommercialReentry =
          Boolean(detectRubro(incomingText)) ||
          isPrefilledAdOrWebsiteTemplate(incomingText) ||
          isPurePriceQuery(incomingText) ||
          wantsHuman(incomingText) ||
          hasIncomingAudio;

        if (hasCommercialReentry) {
          // Si vuelve con una señal comercial válida (por ejemplo "soy tapicero",
          // una nueva consulta web, precio, demo o un audio), recuperamos el chat
          // en lugar de contar el mensaje como spam/consulta errónea repetida.
          await client.removeLabels(event.conversation.id, ["consulta-erronea"]);
          await client.addLabels(event.conversation.id, ["bot-ventas-activo"]);
          try {
            await client.setStatus(event.conversation.id, "open");
          } catch {
            // El webhook puede llegar cuando Chatwoot ya lo reabrió.
          }

          await pool.query(
            `UPDATE conversation_state
             SET stage = 'awaiting_rubro',
                 rubro = NULL,
                 human_handoff = FALSE,
                 prospect_followup_due_at = NULL,
                 prospect_followup_completed = FALSE,
                 pending_agent_since = NULL,
                 pending_agent_alert_due_at = NULL,
                 pending_agent_alerted_at = NULL,
                 sales_assignee_id = NULL,
                 sales_assignee_name = NULL,
                 state = jsonb_set(
                   (
                     COALESCE(state, '{}'::jsonb)
                     - 'rubro'
                     - 'rubro_libre'
                     - 'lead_intent'
                     - 'lead_summary'
                     - 'requested_demo'
                     - 'proposal_sent'
                     - 'is_recontact'
                     - 'recontact_prompted'
                     - 'rubro_invalid_attempts'
                     - 'handoff_message_sent'
                     - 'sales_alert_level'
                     - 'chat_history'
                     - 'manual_exclusion'
                   ),
                   '{memory}',
                   (
                     COALESCE(state->'memory', '{}'::jsonb)
                     - 'rubro'
                     - 'lead_intent'
                     - 'requested_demo'
                     - 'proposal_sent'
                   ),
                   true
                 ) || jsonb_build_object('wrong_query_repeat_count', 0),
                 last_message_at = NOW()
             WHERE chatwoot_conversation_id = $1`,
            [event.conversation.id],
          );

          currentLabels = currentLabels.filter(
            (label) => label.toLowerCase() !== "consulta-erronea",
          );
          if (!currentLabels.includes("bot-ventas-activo")) {
            currentLabels.push("bot-ventas-activo");
          }

          logger.info(
            { conversationId: event.conversation.id },
            "Consulta previamente errónea reactivada por nueva señal comercial válida",
          );
        } else {
          const repeatResult = await pool.query<{ repeat_count: number }>(
            `UPDATE conversation_state
             SET stage = 'human',
                 human_handoff = TRUE,
                 prospect_followup_due_at = NULL,
                 prospect_followup_completed = TRUE,
                 pending_agent_since = NULL,
                 pending_agent_alert_due_at = NULL,
                 pending_agent_alerted_at = COALESCE(pending_agent_alerted_at, NOW()),
                 sales_assignee_id = NULL,
                 sales_assignee_name = NULL,
                 state = jsonb_set(
                   COALESCE(state, '{}'::jsonb),
                   '{wrong_query_repeat_count}',
                   to_jsonb(COALESCE((state->>'wrong_query_repeat_count')::int, 0) + 1),
                   true
                 ),
                 last_message_at = NOW()
             WHERE chatwoot_conversation_id = $1
             RETURNING COALESCE((state->>'wrong_query_repeat_count')::int, 0) AS repeat_count`,
            [event.conversation.id],
          );

          const repeatCount = Number(repeatResult.rows[0]?.repeat_count ?? 1);

          // Un mensaje nuevo reabre una conversación resuelta en Chatwoot. Mientras
          // conserve consulta-erronea la volvemos a cerrar para que no ensucie la bandeja.
          try {
            await client.setStatus(event.conversation.id, "resolved");
          } catch {
            // No interrumpir el flujo si ya estaba resuelta.
          }

          if (repeatCount >= 2) {
            try {
              if (client.muteConversation) {
                await client.muteConversation(event.conversation.id);
              }
              await client.addLabels(event.conversation.id, ["bloqueado-bot"]);
              logger.info(
                { conversationId: event.conversation.id, repeatCount },
                "Contacto bloqueado/muteado después de insistir en una consulta errónea",
              );
            } catch (error) {
              logger.warn(
                {
                  conversationId: event.conversation.id,
                  repeatCount,
                  error: error instanceof Error ? error.message : String(error),
                },
                "No se pudo bloquear/mutear el contacto con consulta errónea repetida",
              );
            }
          } else {
            logger.info(
              { conversationId: event.conversation.id, repeatCount },
              "Consulta errónea: mensaje adicional ignorado",
            );
          }
          return;
        }
      }

      if (currentLabels.includes("derivar-ventas")) {
        // Si el vendedor ya había marcado el prospecto como contactado por fuera
        // de Chatwoot, un nuevo mensaje entrante invalida esa marca: vuelve a
        // existir una respuesta pendiente dentro de la conversación actual.
        if (currentLabels.includes("contactado-ventas")) {
          try {
            await client.removeLabels(
              event.conversation.id,
              ["contactado-ventas"],
            );
            currentLabels = currentLabels.filter(
              (label) => label.toLowerCase() !== "contactado-ventas",
            );

            logger.info(
              { conversationId: event.conversation.id },
              "Nuevo mensaje del prospecto: se quitó contactado-ventas y se reinició el circuito de atención",
            );
          } catch (error) {
            logger.warn(
              {
                conversationId: event.conversation.id,
                error: error instanceof Error ? error.message : String(error),
              },
              "No se pudo quitar contactado-ventas; no se inició un SLA que luego pudiera cancelarse incorrectamente",
            );
            return;
          }
        }

        const pendingStartedAt = now();
        const firstAlertDueAt = addSalesBusinessHours(pendingStartedAt, 1);

        await pool.query(
          `INSERT INTO conversation_state (
             chatwoot_conversation_id, chatwoot_contact_id, chatwoot_inbox_id,
             stage, human_handoff, last_message_at,
             pending_agent_since, pending_agent_alert_due_at,
             pending_agent_alerted_at, state
           ) VALUES (
             $1, NULL, $2, 'human', TRUE, NOW(),
             $3, $4, NULL,
             '{"sales_alert_level":0}'::jsonb
           )
          ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET
            stage = 'human',
            human_handoff = TRUE,
            last_message_at = NOW(),
            pending_agent_since = COALESCE(
              conversation_state.pending_agent_since,
              $3
            ),
            pending_agent_alert_due_at = CASE
              WHEN conversation_state.pending_agent_since IS NULL THEN $4
              ELSE conversation_state.pending_agent_alert_due_at
            END,
            pending_agent_alerted_at = CASE
              WHEN conversation_state.pending_agent_since IS NULL THEN NULL
              ELSE conversation_state.pending_agent_alerted_at
            END,
            state = CASE
              WHEN conversation_state.pending_agent_since IS NULL THEN
                jsonb_set(
                  COALESCE(conversation_state.state, '{}'::jsonb),
                  '{sales_alert_level}',
                  '0'::jsonb,
                  true
                )
              ELSE conversation_state.state
            END`,
          [event.conversation.id, inboxId, pendingStartedAt, firstAlertDueAt],
        );
        if (prospectosClient) {
          try {
            await prospectosClient.registerControlEvent({
              chatwoot_conversation_id: event.conversation.id,
              evento: "espera_vendedor",
            });
          } catch (controlErr) {
            logger.warn(
              {
                conversationId: event.conversation.id,
                error:
                  controlErr instanceof Error
                    ? controlErr.message
                    : String(controlErr),
              },
              "No se pudo sincronizar el inicio de espera del vendedor en Control de Ventas",
            );
          }
        }

        logger.info(
          { conversationId: event.conversation.id },
          "Conversación en atención humana; se mantiene/inicia el SLA desde el primer mensaje pendiente",
        );
        return;
      }

      const contactId =
        event.sender?.id ?? event.conversation.meta?.sender?.id ?? null;
      const state = await pool.query<{
        stage: string;
        human_handoff: boolean;
        rubro: string | null;
        state: ConversationData;
        prospect_followup_attempt: number;
        user_message_count: number;
        is_new: boolean;
      }>(
        `INSERT INTO conversation_state (
           chatwoot_conversation_id, chatwoot_contact_id, chatwoot_inbox_id, last_message_at, user_message_count
         ) VALUES ($1, $2, $3, NOW(), 1)
         ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET
           chatwoot_contact_id = COALESCE(EXCLUDED.chatwoot_contact_id, conversation_state.chatwoot_contact_id),
           user_message_count = conversation_state.user_message_count + 1,
           last_message_at = NOW()
         RETURNING stage, human_handoff, rubro, state, prospect_followup_attempt, user_message_count`,
        [event.conversation.id, contactId, inboxId],
      );

      const current = state.rows[0];
      if (!current) return;

      let userText = (event.content ?? "").trim();

      const audioAttachment = (event.attachments ?? []).find(isAudioAttachment);
      if (!hasMeaningfulText(userText) && audioAttachment) {
        const transcript = await transcribeIncomingAudio(
          event.conversation.id,
          audioAttachment,
        );

        if (!transcript) {
          await client.sendMessage(
            event.conversation.id,
            AUDIO_TRANSCRIPTION_FALLBACK_MESSAGE,
          );

          // Mantener la conversación dentro del flujo comercial y no contabilizar
          // el audio fallido como un intento de rubro inválido.
          await pool.query(
            `UPDATE conversation_state
             SET stage = CASE
                   WHEN human_handoff = FALSE THEN 'awaiting_rubro'
                   ELSE stage
                 END,
                 state = jsonb_set(
                   COALESCE(state, '{}'::jsonb),
                   '{audio_transcription_failed}',
                   'true'::jsonb,
                   true
                 ),
                 last_message_at = NOW()
             WHERE chatwoot_conversation_id = $1`,
            [event.conversation.id],
          );

          logger.info(
            { conversationId: event.conversation.id },
            "Audio no interpretable; se solicitó continuar por escrito",
          );
          return;
        }

        userText = transcript;
      }

      if (
        prospectosClient &&
        Number(current.user_message_count) > 1 &&
        !isPrefilledAdOrWebsiteTemplate(userText)
      ) {
        try {
          await prospectosClient.registerControlEvent({
            chatwoot_conversation_id: event.conversation.id,
            evento: "respuesta_cliente",
            origen: getControlOrigin(currentLabels),
          });
        } catch (controlErr) {
          logger.warn(
            {
              conversationId: event.conversation.id,
              userMessageCount: current.user_message_count,
              error:
                controlErr instanceof Error
                  ? controlErr.message
                  : String(controlErr),
            },
            "No se pudo registrar la primera respuesta del cliente en Control de Ventas",
          );
        }
      }

      // Una conversación derivada solo vuelve al bot si se activa
      // explícitamente la etiqueta "bot-ventas-activo".
      if (
        currentLabels.includes("bot-ventas-activo") &&
        !currentLabels.includes("derivar-ventas") &&
        current.human_handoff &&
        current.stage === "human"
      ) {
        await pool.query(
          `UPDATE conversation_state
        SET human_handoff = FALSE,
            stage = 'qualified'
        WHERE chatwoot_conversation_id = $1`,
          [event.conversation.id],
        );

        current.human_handoff = false;
        current.stage = "qualified";

        logger.info(
          { conversationId: event.conversation.id },
          "Bot reactivado explícitamente mediante etiqueta bot-ventas-activo",
        );
      }
      if (current.human_handoff) return;



const punctuationOnlyReply = /^[?¿!¡.]+$/.test(userText);

if (
  !hasMeaningfulText(userText) &&
  !punctuationOnlyReply &&
  !isPositiveEmojiOnly(userText)
) {
    if (
    !currentLabels.includes("google") &&
    !currentLabels.includes("meta") &&
    !currentLabels.includes("web") &&
    !currentLabels.includes("prospecto-interno") &&
    !currentLabels.includes("auditar-origen")
  ) {
    try {
      await client.addLabels(
        event.conversation.id,
        ["auditar-origen"],
      );
    } catch (err) {
      logger.warn(
        {
          conversationId: event.conversation.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "No se pudo agregar auditar-origen",
      );
    }
  }

  return;
}

      const originDetection = detectControlOrigin(
        event,
        currentLabels,
        userText,
      );
      const detectedOrigin = originDetection.origin;

      // Detectar origen del mensaje inicial y aplicar su etiqueta.
      // Meta y Google utilizan exactamente la misma lógica.
        if (   
          detectedOrigin === "meta" &&
          !currentLabels.includes("meta")
        ) {
          try {
            await client.addLabels(
              event.conversation.id,
              ["meta"]
            );

            currentLabels.push("meta");
          } catch (err) {
            logger.warn(
              {
                conversationId: event.conversation.id,
                error: err instanceof Error ? err.message : String(err),
              },
              "No se pudo agregar la etiqueta meta",
            );
          }
        }

        if (
          detectedOrigin === "google" &&
          !currentLabels.includes("google")
        ) {
          try {
            await client.addLabels(
              event.conversation.id,
              ["google"]
            );

            currentLabels.push("google");
          } catch (err) {
            logger.warn(
              {
                conversationId: event.conversation.id,
                error: err instanceof Error ? err.message : String(err),
              },
              "No se pudo agregar la etiqueta google",
            );
          }

      }

      if (
        detectedOrigin === "web" &&
        !currentLabels.includes("web")
      ) {
        try {
          await client.addLabels(
            event.conversation.id,
            ["web"]
          );

          currentLabels.push("web");
        } catch (err) {
          logger.warn(
            {
              conversationId: event.conversation.id,
              error: err instanceof Error ? err.message : String(err),
            },
            "No se pudo agregar la etiqueta web",
          );
        }
      }

      if (
  detectedOrigin === "otro" &&
  !currentLabels.includes("prospecto-interno") &&
  !currentLabels.includes("auditar-origen")
) {
  try {
    await client.addLabels(
      event.conversation.id,
      ["auditar-origen"],
    );

    currentLabels.push("auditar-origen");
  } catch (err) {
    logger.warn(
      {
        conversationId: event.conversation.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "No se pudo agregar auditar-origen",
    );
  }
}

      // Recién después de determinar el origen registramos el ingreso.
      if (prospectosClient) {
        try {
          await prospectosClient.registerControlEvent({
            chatwoot_conversation_id: event.conversation.id,
            evento: "ingreso",
            origen: detectedOrigin,
            origen_detalle: originDetection.detail,
          });
        } catch (controlErr) {
          logger.warn(
            {
              conversationId: event.conversation.id,
              error:
                controlErr instanceof Error
                  ? controlErr.message
                  : String(controlErr),
            },
            "No se pudo registrar el ingreso en Control de Ventas",
          );
        }
      }

        if (
      !currentLabels.includes("derivar-ventas") &&
      !currentLabels.includes("prospecto-interno")
        ) { 
       try {
        // Solo activar automáticamente en el primer mensaje.
        if (
          !currentLabels.includes("bot-ventas-activo") &&
          current.user_message_count === 1
        ) {
          await client.addLabels(event.conversation.id, [
            "bot-ventas-activo",
          ]);

          currentLabels.push("bot-ventas-activo");
        }
      } catch (error) {
          logger.warn(
            {
              conversationId: event.conversation.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "No se pudo activar/asignar la conversación al bot",
          );
        }
      }



   
      const stateData = current.state ?? {};
      const existingHistory = Array.isArray(stateData.chat_history)
        ? (stateData.chat_history as Array<{ role: "user" | "assistant"; content: string }>).slice(-10)
        : [];
      const updatedHistory = [...existingHistory, { role: "user" as const, content: userText }];

      const memory = (stateData.memory as Record<string, unknown>) ?? {};

      // Recordar si desde el primer mensaje ya solicitó una demostración.
      if (
        isWebsiteLead(userText) &&
        /\b(demo|demostracion)\b/.test(normalizeText(userText))
      ) {
        memory.requested_demo = true;
      }

      const chatwootContactName = getValidChatwootContactName(
      event.conversation.meta?.sender?.name
      );

      const nameFromCurrentMessage =
        extractNameFromRubroMessage(userText);

      const availableLeadName =
        nameFromCurrentMessage ||
        (memory.lead_name as string) ||
        (stateData.lead_name as string) ||
        chatwootContactName ||
        "";

      const detectedRubro = detectRubro(userText);
      const activeRubro = detectedRubro ?? current.rubro ?? (memory.rubro as string | null) ?? null;
      if (detectedRubro && !memory.rubro) {
        memory.rubro = detectedRubro;
      }

      if (availableLeadName) {
        memory.lead_name = availableLeadName;
        stateData.lead_name = availableLeadName;
      }


      const scheduleProspectFollowup = async (
        conversationId: number
      ): Promise<void> => {
        await pool.query(
          `UPDATE conversation_state
          SET prospect_followup_due_at = NOW() + INTERVAL '24 hours',
              prospect_followup_completed = FALSE
          WHERE chatwoot_conversation_id = $1`,
          [conversationId]
        );
      };
      
      // Helper para enviar mensaje y actualizar historial
      const sendAndSave = async (
        text: string,
        nextStage?: string,
        nextRubro?: string | null,
        handoff = false,
        leadStatus?: string,
        extraState: Record<string, unknown> = {}
      ) => {
        await client.sendMessage(event.conversation.id, text);
        const finalHistory = [...updatedHistory, { role: "assistant" as const, content: text }].slice(-10);
        const nextState: ConversationData = {
          ...stateData,
          ...extraState,
          chat_history: finalHistory,
          memory
        };

        const targetStage = nextStage ?? current.stage;
        const targetRubro = nextRubro ?? activeRubro;

        await pool.query(
          `UPDATE conversation_state
           SET stage = $2, rubro = $3, human_handoff = $4,
               lead_status = COALESCE($5, lead_status),
               state = $6::jsonb
           WHERE chatwoot_conversation_id = $1`,
          [
            event.conversation.id,
            targetStage,
            targetRubro,
            handoff,
            leadStatus ?? null,
            JSON.stringify(nextState)
          ]
        );
        // Si el bot queda esperando respuesta del prospecto,
        // programar seguimiento automático a las 24 horas.
        if (
          !handoff &&
          ["awaiting_rubro", "awaiting_current_system", "awaiting_main_need", "proposal_sent", "awaiting_name", "qualified"].includes(targetStage)
        ) {
          await scheduleProspectFollowup(event.conversation.id);
        }
      };

      // Si esta conversación ya había sido resuelta y el cliente vuelve a
      // escribir, no continuar automáticamente desde proposal_sent/qualified.
      // Primero volver a preguntar cómo quiere continuar; recién la siguiente
      // respuesta puede disparar demo/asesor y la derivación correspondiente.
      if (
        stateData.is_recontact === true &&
        stateData.recontact_prompted !== true
      ) {
        const recontactCta =
          `¡Hola nuevamente! 😊 Para retomar tu consulta:\n\n${buildCommercialContinuationPrompt(activeRubro)}`;

        await sendAndSave(
          recontactCta,
          "qualified",
          activeRubro,
          false,
          undefined,
          {
            is_recontact: true,
            recontact_prompted: true,
          },
        );

        logger.info(
          { conversationId: event.conversation.id },
          "Recontacto detectado; se vuelven a ofrecer demo o asesor antes de derivar",
        );

        return;
      }

const getNextSalesAssignee = async (): Promise<SalesAssignee | null> => {
  const agents = (config.salesAgents ?? []).filter(
    (agent) =>
      Number.isInteger(agent.id) &&
      agent.id > 0 &&
      typeof agent.name === "string" &&
      agent.name.trim().length > 0
  );

  logger.info(
    {
      conversationId: event.conversation.id,
      configuredAgents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name
      })),
      configuredAgentsCount: agents.length
    },
    "[SALES-ASSIGNMENT] Agentes disponibles para round-robin"
  );

  if (agents.length === 0) {
      logger.warn(
        {
          conversationId: event.conversation.id,
          rawSalesAgents: config.salesAgents ?? []
        },
        "[SALES-ASSIGNMENT] SALES_AGENTS vacío o inválido"
      );

    return null;
  }

  const result = await pool.query<{ last_assignee_id: string | null }>(
    `SELECT value->>'last_assignee_id' AS last_assignee_id
     FROM bot_settings
     WHERE key = 'sales_round_robin'`
  );

  const rawLastAssigneeId = result.rows[0]?.last_assignee_id ?? null;

  const parsedLastAssigneeId =
    rawLastAssigneeId !== null
      ? Number(rawLastAssigneeId)
      : null;

  const lastAssigneeId =
    parsedLastAssigneeId !== null &&
    Number.isInteger(parsedLastAssigneeId) &&
    parsedLastAssigneeId > 0
      ? parsedLastAssigneeId
      : null;

  const lastIndex = agents.findIndex(
    (agent) => agent.id === lastAssigneeId
  );

  const nextIndex =
    lastIndex === -1
      ? 0
      : (lastIndex + 1) % agents.length;

  const nextAgent = agents[nextIndex] ?? null;

  logger.info(
    {
      conversationId: event.conversation.id,
      lastAssigneeId,
      lastIndex,
      nextIndex,
      nextAgentId: nextAgent?.id ?? null,
      nextAgentName: nextAgent?.name ?? null
    },
    "[SALES-ASSIGNMENT] Resultado del round-robin"
  );

  return nextAgent;
};

      const saveLastSalesAssignee = async (assigneeId: number): Promise<void> => {
        await pool.query(
          `INSERT INTO bot_settings (key, value, description)
          VALUES (
            'sales_round_robin',
            jsonb_build_object('last_assignee_id', $1::integer),
            'Último agente de ventas asignado automáticamente'
          )
          ON CONFLICT (key) DO UPDATE SET
            value = jsonb_build_object('last_assignee_id', $1::integer)`,
          [assigneeId]
        );
      };

      

      const performHandoffToSales = async (
      reason: string,
      handoffMessage: string,
      extraState: Record<string, unknown> = {}
    ) => {
      const alreadySent = Boolean(stateData.handoff_message_sent);
      const leadPhone = event.conversation.meta?.sender?.phone_number ?? null;

      if (!alreadySent) {
        await sendAndSave(handoffMessage, "human", activeRubro, true, "completed", {
          ...extraState,
          handoff_message_sent: true,
          lead_phone: leadPhone
        });
      }

            // Antes de asignar al humano, sacar al bot del control de la conversación.
      // Esto evita que el webhook generado por assignAgent vuelva a asignar Bot Ventas.
      try {
        await client.removeLabels(event.conversation.id, ["bot-ventas-activo"]);

        logger.info(
          { conversationId: event.conversation.id },
          "Etiqueta bot-ventas-activo eliminada antes de asignar a Ventas",
        );
      } catch (err) {
        logger.warn(
          {
            conversationId: event.conversation.id,
            error: err instanceof Error ? err.message : String(err),
          },
          "No se pudo eliminar la etiqueta bot-ventas-activo antes de asignar a Ventas",
        );
      }

      try {
        await client.addLabels(
            event.conversation.id,
            ["derivar-ventas"]
          );
          logger.info(
          { conversationId: event.conversation.id, reason },
          "Etiquetas de derivación agregadas antes de asignar a Ventas"
        );
      } catch (err) {
        logger.warn(
          {
            conversationId: event.conversation.id,
            reason,
            error: err instanceof Error ? err.message : String(err)
          },
          "No se pudieron agregar las etiquetas de derivación antes de asignar a Ventas"
        );
      }

      // Asignación automática de Ventas.
      // Rafael es el fallback si el round-robin o la asignación normal fallan.
      const fallbackAgent: SalesAssignee = {
        id: 4,
        name: "Rafael Altadonna"
      };

      let assignedAgent: SalesAssignee | null = null;
      let selectedAgent: SalesAssignee | null = null;
      let usedFallback = false;

      logger.info(
        {
          conversationId: event.conversation.id,
          reason,
          configuredSalesAgents: config.salesAgents ?? [],
          fallbackAgent
        },
        "[SALES-ASSIGNMENT] Iniciando asignación automática"
      );

      try {
        // 1. Obtener próximo agente del round-robin.
        try {
          selectedAgent = await getNextSalesAssignee();
        } catch (roundRobinErr) {
          logger.warn(
            {
              conversationId: event.conversation.id,
              reason,
              error:
                roundRobinErr instanceof Error
                  ? roundRobinErr.message
                  : String(roundRobinErr)
            },
            "[SALES-ASSIGNMENT] Falló el cálculo del round-robin"
          );
        }

        // 2. Si no hay agente válido, usar Rafael.
        if (!selectedAgent) {
          selectedAgent = fallbackAgent;
          usedFallback = true;

          logger.warn(
            {
              conversationId: event.conversation.id,
              fallbackAgentId: fallbackAgent.id,
              fallbackAgentName: fallbackAgent.name
            },
            "[SALES-ASSIGNMENT] Sin agente válido; usando Rafael como fallback"
          );
        }

        logger.info(
          {
            conversationId: event.conversation.id,
            selectedAgentId: selectedAgent.id,
            selectedAgentName: selectedAgent.name,
            usedFallback
          },
          "[SALES-ASSIGNMENT] Intentando asignar agente en Chatwoot"
        );

        // 3. Intentar asignar el agente elegido.
        try {
          await client.assignAgent(
            event.conversation.id,
            selectedAgent.id
          );

          assignedAgent = selectedAgent;

          logger.info(
            {
              conversationId: event.conversation.id,
              agentId: assignedAgent.id,
              agentName: assignedAgent.name,
              usedFallback
            },
            "[SALES-ASSIGNMENT] Chatwoot aceptó la asignación"
          );
        } catch (assignmentErr) {
          logger.warn(
            {
              conversationId: event.conversation.id,
              attemptedAgentId: selectedAgent.id,
              attemptedAgentName: selectedAgent.name,
              error:
                assignmentErr instanceof Error
                  ? assignmentErr.message
                  : String(assignmentErr)
            },
            "[SALES-ASSIGNMENT] Falló la asignación del agente seleccionado"
          );

          // Si el agente que falló ya era Rafael, no repetir.
          if (selectedAgent.id === fallbackAgent.id) {
            throw assignmentErr;
          }

          // 4. Fallback real a Rafael.
          usedFallback = true;

          logger.warn(
            {
              conversationId: event.conversation.id,
              fallbackAgentId: fallbackAgent.id,
              fallbackAgentName: fallbackAgent.name
            },
            "[SALES-ASSIGNMENT] Intentando fallback con Rafael"
          );

          await client.assignAgent(
            event.conversation.id,
            fallbackAgent.id
          );

          assignedAgent = fallbackAgent;

          logger.warn(
            {
              conversationId: event.conversation.id,
              agentId: fallbackAgent.id,
              agentName: fallbackAgent.name
            },
            "[SALES-ASSIGNMENT] Fallback a Rafael realizado correctamente"
          );
        }

        if (!assignedAgent) {
          throw new Error(
            "La asignación finalizó sin un agente confirmado"
          );
        }

        // 5. Avanzar round-robin solamente cuando la asignación normal fue exitosa.
        // Si hubo fallback, conservamos el turno anterior.
        if (!usedFallback) {
          await saveLastSalesAssignee(assignedAgent.id);

          logger.info(
            {
              conversationId: event.conversation.id,
              lastAssigneeId: assignedAgent.id,
              lastAssigneeName: assignedAgent.name
            },
            "[SALES-ASSIGNMENT] Round-robin actualizado"
          );
        } else {
          logger.warn(
            {
              conversationId: event.conversation.id,
              assignedAgentId: assignedAgent.id,
              assignedAgentName: assignedAgent.name
            },
            "[SALES-ASSIGNMENT] Se utilizó fallback; round-robin no modificado"
          );
        }

        // 6. Guardar el agente realmente asignado e iniciar el SLA comercial.
        const pendingStartedAt = now();
        const firstAlertDueAt = addSalesBusinessHours(pendingStartedAt, 1);

        await pool.query(
          `UPDATE conversation_state
          SET sales_assignee_id = $2,
              sales_assignee_name = $3,
              pending_agent_since = $4,
              pending_agent_alert_due_at = $5,
              pending_agent_alerted_at = NULL,
              state = jsonb_set(
                COALESCE(state, '{}'::jsonb),
                '{sales_alert_level}',
                '0'::jsonb,
                true
              )
          WHERE chatwoot_conversation_id = $1`,
          [
            event.conversation.id,
            assignedAgent.id,
            assignedAgent.name,
            pendingStartedAt,
            firstAlertDueAt,
          ]
        );

        logger.info(
          {
            conversationId: event.conversation.id,
            agentId: assignedAgent.id,
            agentName: assignedAgent.name,
            reason,
            usedFallback
          },
          "[SALES-ASSIGNMENT] Asignación de Ventas completada"
        );
        if (prospectosClient) {
          try {
            await prospectosClient.registerControlEvent({
              chatwoot_conversation_id: event.conversation.id,
              evento: "derivacion",
              origen: getControlOrigin(currentLabels),
              vendedor_id: assignedAgent.id,
              vendedor_nombre: assignedAgent.name,
            });
          } catch (controlErr) {
            logger.warn(
              {
                conversationId: event.conversation.id,
                assignedAgentId: assignedAgent.id,
                error:
                  controlErr instanceof Error
                    ? controlErr.message
                    : String(controlErr),
              },
              "No se pudo registrar la derivación en Control de Ventas",
            );
          }
        }

      } catch (err) {
        assignedAgent = null;

        

        logger.warn(
          {
            conversationId: event.conversation.id,
            reason,
            error: err instanceof Error ? err.message : String(err)
          },
          "[SALES-ASSIGNMENT] ERROR FINAL: no se pudo asignar ningún agente"
        );
      }

      // Una derivación nueva a Ventas debe quedar abierta.
      // Después respetamos cualquier cambio manual a pending/resolved.
      try {
        await client.setStatus(event.conversation.id, "open");
      } catch (err) {
        logger.warn(
          {
            conversationId: event.conversation.id,
            error: err instanceof Error ? err.message : String(err)
          },
          "No se pudo abrir la conversación al derivar a Ventas"
        );
      }


      // Crear o actualizar prospecto desde el bot comercial
          if (prospectosClient) {
            try {
              const telefono =
                event.conversation.meta?.sender?.phone_number;

              if (!telefono) {
                throw new Error(
                  "No se pudo obtener el teléfono del prospecto desde Chatwoot"
                );
              }

              const nombre =
                (extraState.lead_name as string) ||
                (stateData.lead_name as string) ||
                "Sin nombre";

              const rubro =
                activeRubro ||
                (memory.rubro as string) ||
                "Sin especificar";

              await prospectosClient.syncProspect({
                nombre_contacto: nombre,
                telefono: telefono,
                rubro,
                origen: getControlOrigin(currentLabels),
                chatwoot_agent_id: assignedAgent?.id ?? null,
                chatwoot_conversation_id: event.conversation.id
              });

              logger.info(
                {
                  conversationId: event.conversation.id,
                  nombre,
                  telefono,
                  rubro,
                  assignedAgentId: assignedAgent?.id,
                  assignedAgent: assignedAgent?.name
                },
                "Prospecto creado o actualizado correctamente"
              );
            } catch (err) {
              logger.warn(
                {
                  conversationId: event.conversation.id,
                  reason,
                  error: err instanceof Error ? err.message : String(err)
                },
                "Error al crear o actualizar prospecto"
              );
            }
          }

      // Enviar aviso al grupo de ventas
      if (config.salesGroupConversationId) {
        try {
          const telefono =
            event.conversation.meta?.sender?.phone_number ?? null;
            if (!telefono) {
          throw new Error("No se pudo obtener el teléfono del prospecto desde Chatwoot");
        }
          const nombre =
            (extraState.lead_name as string) ||
            (stateData.lead_name as string) ||
            "Sin nombre";

          const rubro =
            activeRubro ||
            (memory.rubro as string) ||
            "Sin especificar";

          const leadIntent =
          memory.lead_intent === "demo"
            ? "Coordinar demostración"
            : memory.lead_intent === "asesor"
              ? "Hablar con un asesor"
              : "Consulta comercial";

          const esRecontacto =
            reason === "recontacto" ||
            extraState.is_recontact === true ||
            stateData.is_recontact === true;

          const mensajeGrupo =
            `${esRecontacto ? "🔄 Prospecto recontactado" : "🔔 Nueva consulta para Ventas"}\n\n` +
            `👤 Nombre: ${nombre}\n` +
            `📞 Teléfono: ${telefono || "Sin teléfono"}\n` +
            `🏷️ Rubro: ${rubro}\n` +
            `🎯 Interés: ${leadIntent}\n` +
            `👨‍💼 Asignado a: ${assignedAgent?.name || "Sin asignar"}`;

          if (isSalesBusinessTime(now())) {
            await client.sendMessage(
              config.salesGroupConversationId,
              mensajeGrupo
            );
            await pool.query(
              `UPDATE conversation_state
               SET state = (COALESCE(state, '{}'::jsonb) - 'sales_group_notice_pending' - 'sales_group_notice_message')
               WHERE chatwoot_conversation_id = $1`,
              [event.conversation.id],
            );
            logger.info(
              { conversationId: event.conversation.id, salesGroupConversationId: config.salesGroupConversationId, reason },
              "Aviso de derivación enviado al grupo de ventas"
            );
          } else {
            await pool.query(
              `UPDATE conversation_state
               SET state = jsonb_set(
                 jsonb_set(COALESCE(state, '{}'::jsonb), '{sales_group_notice_pending}', 'true'::jsonb, true),
                 '{sales_group_notice_message}', to_jsonb($2::text), true
               )
               WHERE chatwoot_conversation_id = $1`,
              [event.conversation.id, mensajeGrupo],
            );
            logger.info(
              { conversationId: event.conversation.id, salesGroupConversationId: config.salesGroupConversationId, reason },
              "Aviso de derivación diferido hasta el próximo horario laboral"
            );
          }
        } catch (err) {
          logger.warn(
            {
              conversationId: event.conversation.id,
              salesGroupConversationId: config.salesGroupConversationId,
              reason,
              error: err instanceof Error ? err.message : String(err)
            },
            "Error al enviar aviso al grupo de ventas"
          );
        }
      } else {
        logger.warn(
          {
            conversationId: event.conversation.id,
            reason
          },
          "CHATWOOT_SALES_GROUP_CONVERSATION_ID no configurado; no se envió aviso al grupo"
        );
      }


    };

          if (isClearlyNonCommercialQuery(userText)) {
            try {
  await client.removeLabels(
    event.conversation.id,
    ["bot-ventas-activo"]
  );

  await client.addLabels(
    event.conversation.id,
    ["consulta-erronea"]
  );

  logger.info(
    { conversationId: event.conversation.id },
    "Consulta errónea: bot desactivado y etiqueta aplicada"
  );
} catch (err) {
  logger.warn(
    {
      conversationId: event.conversation.id,
      error: err instanceof Error ? err.message : String(err),
    },
    "No se pudieron actualizar las etiquetas de consulta errónea"
  );
}

        await sendAndSave(
          "Gracias por escribirnos. Este canal está destinado a consultas comerciales sobre nuestros sistemas de gestión para comercios. Interpreto que nos escribiste por error por lo que cerramos esta conversación.",
          "closed",
          activeRubro,
          true,
          "wrong_number"
        );

        if (prospectosClient) {
          try {
            await prospectosClient.registerControlEvent({
              chatwoot_conversation_id: event.conversation.id,
              evento: "consulta_erronea",
              origen: getControlOrigin(currentLabels),
            });
          } catch (err) {
            logger.warn(
              {
                conversationId: event.conversation.id,
                error: err instanceof Error ? err.message : String(err),
              },
              "No se pudo registrar consulta errónea en Control",
            );
          }
        }

        await pool.query(
          `UPDATE conversation_state
          SET prospect_followup_due_at = NULL,
              prospect_followup_completed = TRUE
          WHERE chatwoot_conversation_id = $1`,
          [event.conversation.id]
        );

        try {
          await client.setStatus(event.conversation.id, "resolved");
        } catch {
          // Si Chatwoot ya la resolvió, no interrumpir el flujo.
        }

        logger.info(
          { conversationId: event.conversation.id },
          "Consulta ajena al canal comercial; conversación cerrada"
        );
        return;
      }

    // 0. Capturar nombre cuando la etapa es awaiting_name y derivar al asesor
    if (current.stage === "awaiting_name") {

      // Si el prospecto ya eligió avanzar y vuelve a hacer clic en un
      // anuncio de Meta, no interpretar el contenido del anuncio como
      // nombre ni reiniciar/modificar el flujo.
      // Conservamos awaiting_name y esperamos el próximo mensaje real.
      if (isMetaLead(userText)) {
        logger.info(
          {
            conversationId: event.conversation.id,
            stage: current.stage
          },
          "Nuevo clic de publicidad ignorado mientras se esperaba el nombre"
        );

        return;
      }

      const cleanName = extractCleanName(userText);

        if (!cleanName) {
          await sendAndSave(
            "¿Me podrías indicar tu nombre, por favor? Así te derivamos con un asesor comercial.",
            "awaiting_name",
            activeRubro
          );
          logger.info(
            { conversationId: event.conversation.id },
            "Respuesta inválida al solicitar nombre; se vuelve a preguntar"
          );
          return;
        }

        const nameToSave = cleanName;
        stateData.lead_name = nameToSave;

        memory.lead_name = nameToSave;

        const summary = buildLeadSummary(stateData, activeRubro, nameToSave);
        stateData.lead_summary = summary;

        const reply = cleanName
          ? `¡Muchas gracias, ${cleanName}! 😊 Ya te derivamos con un asesor comercial. Va a poder mostrarte cómo funciona el sistema aplicado a tu negocio, orientarte sobre la opción más adecuada y resolver tus dudas.`
          : `¡Muchas gracias! 😊 Ya te derivamos con un asesor comercial. Va a poder mostrarte cómo funciona el sistema aplicado a tu negocio, orientarte sobre la opción más adecuada y resolver tus dudas.`;

        await performHandoffToSales("captura_nombre", reply, {
          lead_name: nameToSave,
          lead_summary: summary
        });
        logger.info({ conversationId: event.conversation.id, cleanName }, "Nombre capturado; conversación derivada a asesor humano");
        return;
      }


      if (isWrongNumber(userText)) {
        try {
        await client.removeLabels(
          event.conversation.id,
          ["bot-ventas-activo"]
        );

        await client.addLabels(
          event.conversation.id,
          ["consulta-erronea"]
        );
      } catch (err) {
        logger.warn(
          {
            conversationId: event.conversation.id,
            error: err instanceof Error ? err.message : String(err),
          },
          "No se pudieron actualizar las etiquetas de consulta errónea"
        );
      }

        await sendAndSave(
          "Entendido 😊 Gracias por avisarnos. ¡Saludos!",
          "closed",
          activeRubro,
          true,
          "wrong_number"
        );

        try {
          await client.setStatus(event.conversation.id, "resolved");
        } catch {
          // Si Chatwoot ya la resolvió, no interrumpir el flujo.
        }

                if (prospectosClient) {
          try {
            await prospectosClient.registerControlEvent({
              chatwoot_conversation_id: event.conversation.id,
              evento: "consulta_erronea",
              origen: getControlOrigin(currentLabels),
            });
          } catch (err) {
            logger.warn(
              {
                conversationId: event.conversation.id,
                error: err instanceof Error ? err.message : String(err),
              },
              "No se pudo registrar consulta errónea en Control",
            );
          }
        }
        await pool.query(
          `UPDATE conversation_state
          SET prospect_followup_due_at = NULL,
              prospect_followup_completed = TRUE
          WHERE chatwoot_conversation_id = $1`,
          [event.conversation.id]
        );

        logger.info(
          { conversationId: event.conversation.id },
          "Lead clasificado como ingreso equivocado; conversación cerrada"
        );
        return;
      }



      // Diagnóstico obligatorio para los ingresos nuevos: dos respuestas redactadas.
      // Los flujos antiguos (proposal_sent) siguen siendo compatibles sin reinicio.
      // Un "no" breve al hablar del sistema actual no equivale a rechazar la venta.
      const rechazoExplicitoEnCalificacion = refusesDemo(userText) &&
        !/^(?:no|nop|nope)$/.test(normalizeText(userText).trim());
      if (["awaiting_current_system", "awaiting_main_need"].includes(current.stage) && !rechazoExplicitoEnCalificacion) {
        if (isPrefilledAdOrWebsiteTemplate(userText)) return;
        if (isPurePriceQuery(userText)) {
          const priceMsg = await loadPriceMessage(pool);
          await sendAndSave(
            `${priceMsg || "Los planes tienen diferentes precios según las necesidades del comercio."}\n\n${current.stage === "awaiting_current_system" ? SALES_QUALIFICATION_CURRENT : SALES_QUALIFICATION_NEED}`,
            current.stage,
            activeRubro
          );
          return;
        }
        if (requestsHumanAdvisor(userText) || acceptsDemo(userText)) {
          memory.lead_intent = acceptsDemo(userText) ? "demo" : "asesor";
          await sendAndSave(
            `¡Perfecto! 😊 Antes de coordinar, ¿me contás un poquito sobre tu negocio?\n\n${current.stage === "awaiting_current_system" ? SALES_QUALIFICATION_CURRENT : SALES_QUALIFICATION_NEED}`,
            current.stage,
            activeRubro
          );
          return;
        }
        if (!isWrittenQualificationAnswer(userText)) {
          await sendAndSave(
            current.stage === "awaiting_current_system"
              ? `Para poder orientarte, contame con tus palabras cómo manejás tu negocio actualmente.\n\n${SALES_QUALIFICATION_CURRENT}`
              : `Necesito conocer qué te gustaría solucionar.\n\n${SALES_QUALIFICATION_NEED}`,
            current.stage,
            activeRubro
          );
          return;
        }
        const diagnostic = stateData.qualification ?? { question_index: 0, answers: [] };
        const answers = Array.isArray(diagnostic.answers) ? diagnostic.answers : [];
        if (current.stage === "awaiting_current_system") {
          memory.sistema_actual = userText.trim();
          stateData.qualification = {
            question_index: 1,
            answers: [...answers, { question: "Cómo gestiona hoy el negocio", answer: userText.trim() }]
          };
          await sendAndSave(SALES_QUALIFICATION_NEED, "awaiting_main_need", activeRubro);
        } else {
          memory.problema_principal = userText.trim();
          stateData.qualification = {
            question_index: 2,
            answers: [...answers, { question: "Qué necesita mejorar o resolver", answer: userText.trim() }]
          };
          await sendAndSave(buildCommercialContinuationPrompt(activeRubro), "proposal_sent", activeRubro, false, undefined, {
            sales_questions_complete: true
          });
        }
        return;
      }

      // En el nuevo circuito deben responder con palabras, no con números.
      if (stateData.sales_questions_complete === true &&
          ["proposal_sent", "qualified"].includes(current.stage) &&
          /^[12]$/.test(userText.trim())) {
        await sendAndSave(buildCommercialContinuationPrompt(activeRubro), current.stage, activeRubro);
        return;
      }

      // Consulta explícita de precios / costos
      if (isPurePriceQuery(userText)) {
        memory.precio_informado = true;
        const priceMsg = await loadPriceMessage(pool);
        const textCost = priceMsg || "Los planes arrancan desde los 30 mil pesos por mes. Nuestros precios son a medida de tus necesidades, por lo cual es necesario que hables con un asesor para que pueda darte el precio final.";

        await sendAndSave(
          `${textCost}\n\n${buildCommercialContinuationPrompt(activeRubro)}`,
          "qualified",
          activeRubro
        );
        logger.info(
          { conversationId: event.conversation.id },
          "Respuesta de costos enviada con continuidad comercial"
        );
        return;
      }

      // Consultas sobre si tablet/equipamiento viene incluido: no inventar
      // una condición comercial ni repetir toda la propuesta. La confirma un
      // asesor y dejamos un CTA corto para continuar.
      if (
        ["qualified", "proposal_sent"].includes(current.stage) &&
        isIncludedEquipmentQuestion(userText)
      ) {
        memory.lead_intent = "asesor";
        await sendAndSave(
          "La inclusión de tablet o equipamiento depende de la solución comercial y te la confirma un asesor 😊. ¿Querés que te contacten para explicarte las opciones y los precios?",
          current.stage,
          activeRubro
        );
        logger.info(
          { conversationId: event.conversation.id },
          "Consulta sobre equipamiento derivable respondida con CTA breve"
        );
        return;
      }

      // Si el prospecto indica que está revisando/evaluando la propuesta,
      // no tratarlo como pregunta libre ni volver a insistir con el CTA.
      if (
        ["qualified", "proposal_sent"].includes(current.stage) &&
        isReviewingDecision(userText)
      ) {
        await sendAndSave(
          "Perfecto 😊 Revisalo tranquilo. Si te surge alguna duda, escribinos por acá.",
          current.stage,
          activeRubro,
        );

        logger.info(
          { conversationId: event.conversation.id },
          "Prospecto indicó que está evaluando la propuesta; se mantiene el seguimiento sin repetir CTA",
        );

        return;
      }

      // Un simple "ok", "bueno" o "dale" confirma recepción,
      // pero no autoriza una derivación.
      if (
        ["qualified", "proposal_sent"].includes(current.stage) &&
        isGenericAcknowledgement(userText)
      ) {
        await sendAndSave(
          `Perfecto 😊 ${buildCommercialContinuationPrompt(activeRubro)}`,
          current.stage,
          activeRubro,
        );

        logger.info(
          { conversationId: event.conversation.id },
          "Confirmación genérica recibida; se solicita interés escrito antes de derivar",
        );

        return;
      }

      // Si el prospecto acepta demo o solicita asesor,
      // derivar únicamente después de haber avanzado en el flujo comercial.
      if (
        ["qualified", "proposal_sent"].includes(current.stage) &&
        (wantsHuman(userText) || acceptsDemo(userText))
      ) {
        const isRecontact = stateData.is_recontact === true;
        memory.lead_intent = acceptsDemo(userText) ? "demo" : "asesor";

        const knownName =
          (memory.lead_name as string) ||
          (stateData.lead_name as string) ||
          "";

        const summary = buildLeadSummary(
          stateData,
          activeRubro,
          knownName || undefined
        );

        stateData.lead_summary = summary;

        if (isRecontact && knownName) {
          await performHandoffToSales(
            "recontacto",
            `¡Perfecto, ${knownName}! Te volvemos a poner en contacto con un asesor comercial para que puedan continuar con tu consulta.`,
            {
              lead_name: knownName,
              lead_summary: summary,
              is_recontact: true
            }
          );

          logger.info(
            { conversationId: event.conversation.id, knownName },
            "Prospecto recontactado derivado nuevamente a Ventas"
          );

          return;
        }

        const handoffReply =
          "¡Excelente! 😊 ¿Me podrías decir tu nombre? Así te derivamos con un asesor que te mostrará cómo funciona el sistema aplicado a tu negocio y podrá resolver todas tus dudas.";

        await sendAndSave(
          handoffReply,
          "awaiting_name",
          activeRubro
        );

        logger.info(
          { conversationId: event.conversation.id },
          "Solicitud de nombre enviada tras aceptar demo"
        );

        return;
      }

      // Si después de la propuesta el prospecto aclara o corrige su rubro
      // (por ejemplo: "Pollería" o "Tengo una pollería"), no tratarlo
      // como una pregunta libre para la IA.
      const normalizedRubroClarification = normalizeText(userText).trim();
      const isRubroClarification =
        Boolean(detectedRubro) &&
        !normalizedRubroClarification.includes("?") &&
        (
          normalizedRubroClarification.split(/\s+/).length <= 4 ||
          /^(tengo|es|somos|mi negocio es|mi rubro es|es una|es un)\b/.test(
            normalizedRubroClarification
          )
        );

      if (
        ["qualified", "proposal_sent"].includes(current.stage) &&
        detectedRubro &&
        isRubroClarification
      ) {
        memory.rubro = detectedRubro;
        memory.rubro_detalle = userText.trim();

        const continueOptions = buildCommercialContinuationPrompt(detectedRubro);

        await sendAndSave(
          continueOptions,
          "proposal_sent",
          detectedRubro,
          false,
          undefined,
          {
            proposal_sent: true,
            rubro_detalle: userText.trim()
          }
        );

        logger.info(
          {
            conversationId: event.conversation.id,
            rubro: detectedRubro,
            rubroDetalle: userText.trim()
          },
          "Rubro actualizado después de la propuesta; opciones comerciales reenviadas"
        );

        return;
      }

      if (
        ["qualified", "proposal_sent"].includes(current.stage) &&
        answerService &&
        !wantsHuman(userText) &&
        !acceptsDemo(userText) &&
        !refusesDemo(userText)
      ) {
        try {
          const aiAnswer = await answerService.answer(
            event.conversation.id,
            userText,
            activeRubro,
            existingHistory,
            memory
          );

          if (aiAnswer.kind === "answer" && aiAnswer.text) {
            const continuePrompt =
              `${aiAnswer.text}\n\n${buildCommercialContinuationPrompt(activeRubro)}`;

            await sendAndSave(
              continuePrompt,
              current.stage,
              activeRubro
            );

            logger.info(
              { conversationId: event.conversation.id },
              "Pregunta libre respondida por IA después de la propuesta"
            );

            return;
          }

          if (aiAnswer.handoffToSales) {
            memory.lead_intent = "asesor";

            await sendAndSave(
              "¡Perfecto! ¿Me podrías decir tu nombre así te derivamos con un asesor comercial?",
              "awaiting_name",
              activeRubro
            );

            return;
          }
        } catch (err) {
          logger.warn(
            {
              conversationId: event.conversation.id,
              error: err instanceof Error ? err.message : String(err)
            },
            "Error al responder pregunta libre después de la propuesta"
          );
        }
      }

      if (current.stage === "qualified" && refusesDemo(userText)) {
        await sendAndSave(
          "Entendido 😊 Gracias por avisarnos. ¡Saludos!",
          "closed",
          activeRubro,
          true,
          "refused_demo"
        );

        if (prospectosClient) {
          try {
            await prospectosClient.registerControlEvent({
              chatwoot_conversation_id: event.conversation.id,
              evento: "no_interesado",
              origen: getControlOrigin(currentLabels),
            });
          } catch (err) {
            logger.warn(
              {
                conversationId: event.conversation.id,
                error: err instanceof Error ? err.message : String(err),
              },
              "No se pudo registrar no interesado en Control",
            );
          }
        }

        try {
          await client.setStatus(event.conversation.id, "resolved");
        } catch {
          // Si Chatwoot ya la resolvió, no interrumpir el flujo.
        }

        logger.info(
          { conversationId: event.conversation.id },
          "Lead indicó que no está interesado; conversación cerrada"
        );

        return;
      }



      const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
      // Chatwoot/Evolution procesa cada salida de forma asíncrona. Si enviamos
      // dos mensajes consecutivos sin margen, WhatsApp puede entregarlos invertidos.
      // Este intervalo se usa sólo entre mensajes que dependen de un orden visual.
      const COMMERCIAL_MESSAGE_GAP_MS = 1500;

      const COMMERCIAL_OVERVIEW = buildCommercialOverview(activeRubro);

      const PRICE_INFO_REPLY = `Los planes de suscripción arrancan desde los 50 mil pesos. ¿Te gustaría coordinar una demostración con un asesor comercial para darte el precio exacto a la medida de tu negocio?`;

      const GENERAL_QUESTION_HANDOFF = `Para contestar esa duda en detalle necesito derivarte con un asesor comercial. ¿Te gustaría que te pongamos en contacto con un asesor o coordinar una demostración?`;

      const looksLikeBusinessDescription = (
        content: string | null | undefined
      ): boolean => {
        const text = normalizeText(content ?? "");

        if (!text || text.length < 3) {
          return false;
        }

        // Nunca considerar rubro una consulta ajena al canal comercial.
        if (isClearlyNonCommercialQuery(content) || isWrongNumber(content)) {
          return false;
        }

        // Respuestas conversacionales o negaciones sin actividad comercial
        // no son rubros. En particular, "no tengo" nunca puede guardarse como
        // un rubro libre por contener la palabra "tengo".
        if (
          /^(si|no|dale|ok|okay|bueno|perfecto|gracias|hola|buenas|quiero|me interesa|1|2|3|no tengo|no tenemos|no poseo|no poseemos|ninguno|ninguna)$/.test(
            text
          )
        ) {
          return false;
        }

        // Países / ubicaciones frecuentes no son rubros.
        if (
          /^(argentina|uruguay|paraguay|chile|brasil|bolivia|peru|buenos aires|caba|capital federal|cordoba|rosario|mendoza|tucuman|salta)$/.test(
            text
          )
        ) {
          return false;
        }

        // WhatsApp, contacto, teléfono, redes, etc. no describen un negocio.
        if (
          /\b(whatsapp|wasap|wsp|telefono|celular|numero|instagram|facebook|chat|contacto)\b/.test(
            text
          )
        ) {
          return false;
        }

        // Una pregunta no debe guardarse como rubro.
        if (isQuestion(content)) {
          return false;
        }

        // Expresiones que sí describen explícitamente una actividad comercial.
        if (
          /\b(tengo|tenemos|local|negocio|comercio|tienda|vendo|vendemos|venta|ventas|venta de|ventas de|venta por mayor|ventas por mayor|venta mayorista|ventas mayoristas|venta por menor|ventas por menor|venta minorista|ventas minoristas|mayorista|minorista|nos dedicamos|me dedico|rubro|emprendimiento|empresa|distribuidora|distribuidor|fabrica|fabricante)\b/.test(
            text
          )
        ) {
          return true;
        }

        // Rubros o actividades concretas.
        if (
          /\b(dietetica|almacen|petshop|pet shop|veterinaria|carniceria|fiambreria|pescaderia|polleria|verduleria|panaderia|rotiseria|kiosco|kiosko|maxikiosco|despensa|autoservicio|supermercado|minimercado|minimarket|ferreteria|bazar|regaleria|farmacia|libreria|indumentaria|ropa|calzado|joyeria|congelados|suplementos|suplementacion|celulares|accesorios|servicio tecnico|reparacion|reparaciones|frigorifico|tapicero|tapicera|tapiceria|carpintero|carpintera|carpinteria|muebleria|muebles|cerrajero|cerrajera|cerrajeria|taller)\b/.test(
            text
          )
        ) {
          return true;
        }

        // IMPORTANTE:
        // Si no tenemos evidencia suficiente de que sea un rubro,
        // NO lo inventamos ni guardamos como rubro libre.
        return false;
      };

      
      // Si estamos esperando el rubro y todavía no pudimos identificarlo,
      // distinguir entre una consulta normal y alguien que ya aceptó
      // demo/asesor en un seguimiento.
      
      // Una solicitud explícita de atención humana tiene prioridad sobre el rubro.
      // Si la persona ya pidió hablar con alguien, no la obligamos a contestar
      // primero a qué se dedica: pedimos solo el nombre si todavía falta.
      if (
        ["new", "awaiting_rubro"].includes(current.stage) &&
        !activeRubro &&
        requestsHumanAdvisor(userText)
      ) {
        memory.lead_intent = "asesor";

        if (availableLeadName) {
          const summary = buildLeadSummary(stateData, null, availableLeadName);
          stateData.lead_name = availableLeadName;
          stateData.lead_summary = summary;

          await performHandoffToSales(
            "solicitud_humano_sin_rubro",
            `¡Claro, ${availableLeadName}! 😊 Te derivamos con un asesor comercial para que pueda mostrarte el sistema, orientarte según tu negocio y resolver tus dudas.`,
            {
              lead_name: availableLeadName,
              lead_summary: summary,
              lead_intent: "asesor"
            }
          );
          return;
        }

        await sendAndSave(
          "¡Claro! 😊 Te pongo en contacto con un asesor comercial para que pueda mostrarte el sistema y resolver tus consultas. ¿Me indicás tu nombre para hacer la derivación?",
          "awaiting_name",
          null,
          false,
          undefined,
          { lead_intent: "asesor" }
        );

        logger.info(
          { conversationId: event.conversation.id },
          "Solicitud explícita de atención humana priorizada sin exigir rubro"
        );
        return;
      }

      if (current.stage === "awaiting_rubro" && !activeRubro) {

        // Si vuelve a entrar el mensaje automático de Google/Meta mientras
// esperamos el rubro, no es una respuesta real del prospecto.
// No responder, no sumar intento y conservar awaiting_rubro.
if (isPositiveEmojiOnly(userText)) {
  await sendAndSave(
    "Perfecto 😊 Para poder orientarte, ¿me indicás de qué rubro es tu negocio?",
    "awaiting_rubro",
    null,
  );

  logger.info(
    { conversationId: event.conversation.id, userText },
    "Confirmación por emoji recibida mientras se esperaba el rubro; se repregunta sin penalizar el intento",
  );

  return;
}

if (isPrefilledAdOrWebsiteTemplate(userText)) {
  const lastRecontactAt =
    typeof memory.last_prefilled_recontact_at === "string"
      ? Date.parse(memory.last_prefilled_recontact_at)
      : 0;
  const now = Date.now();
  const canRecontact =
    Number(current.user_message_count) > 1 &&
    (!Number.isFinite(lastRecontactAt) || now - lastRecontactAt >= 6 * 60 * 60 * 1000);

  if (canRecontact) {
    memory.last_prefilled_recontact_at = new Date(now).toISOString();

    await sendAndSave(
      memory.requested_demo === true
        ? "¡Hola nuevamente! 😊 Vemos que retomaste tu consulta para conocer el sistema. Para avanzar con la demostración, indicame de qué rubro es tu negocio y tu nombre, y enseguida te atenderá un especialista."
        : "¡Hola nuevamente! 😊 Vemos que retomaste tu consulta sobre SM Soluciones. Para continuar, indicame de qué rubro es tu negocio y tu nombre, y enseguida te atenderá un especialista.",
      "awaiting_rubro",
      null,
      false,
      undefined,
      { last_prefilled_recontact_at: memory.last_prefilled_recontact_at },
    );

    logger.info(
      { conversationId: event.conversation.id },
      "Reingreso desde plantilla web/ads detectado; seguimiento automático enviado",
    );
    return;
  }

  logger.info(
    {
      conversationId: event.conversation.id,
      userText,
    },
    "Plantilla publicitaria repetida recientemente; se evita duplicar respuesta"
  );

  return;
}

        if (looksLikeBusinessDescription(userText)) {
          const freeRubro = userText.trim();

          memory.rubro = freeRubro;

          await client.sendMessage(
            event.conversation.id,
            buildCommercialOverview(freeRubro)
          );
          await delay(COMMERCIAL_MESSAGE_GAP_MS);

          await sendAndSave(
            buildCommercialAdvisorPrompt(freeRubro),
            "awaiting_current_system",
            freeRubro,
            false,
            undefined,
            {
              proposal_sent: true,
              rubro_libre: freeRubro
            }
          );

          logger.info(
            {
              conversationId: event.conversation.id,
              rubro: freeRubro
            },
            "Rubro libre reconocido y propuesta enviada"
          );

          return;
        }
const opcionSeguimiento =
  current.prospect_followup_attempt > 0 &&
  ["1", "2", "3"].includes(userText.trim());

if (!opcionSeguimiento) {
  const normalizedReply = normalizeText(userText);

  // Respuestas cortas/conversacionales que todavía pueden ser normales.
  const isShortConversationalReply =
    /^(si|sii+|sí|dale|ok|okay|bueno|perfecto|claro|como|como hago|como ago|quiero|me interesa|1|2)$/.test(
      normalizedReply
    );

  const previousRubroAttempts =
    typeof stateData.rubro_invalid_attempts === "number"
      ? stateData.rubro_invalid_attempts
      : 0;

  const nextRubroAttempts = previousRubroAttempts + 1;

  // Permitimos dos repreguntas antes de cerrar automáticamente.
  // Esto reduce falsos positivos con rubros menos frecuentes o respuestas cortas.
  if (nextRubroAttempts >= 3) {
    try {
      await client.removeLabels(
        event.conversation.id,
        ["bot-ventas-activo"]
      );

      await client.addLabels(
        event.conversation.id,
        ["consulta-erronea"]
      );

      logger.info(
        {
          conversationId: event.conversation.id,
          userText,
          rubroInvalidAttempts: nextRubroAttempts
        },
        "Consulta errónea: múltiples respuestas sin rubro válido"
      );
    } catch (err) {
      logger.warn(
        {
          conversationId: event.conversation.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "No se pudieron actualizar las etiquetas de consulta errónea"
      );
    }

    await sendAndSave(
      "Gracias por escribirnos. Este canal está destinado a consultas comerciales sobre nuestros sistemas. Como no pudimos identificar una consulta relacionada con un negocio o comercio, cerramos esta conversación.",
      "closed",
      null,
      true,
      "wrong_number",
      {
        rubro_invalid_attempts: nextRubroAttempts,
        wrong_query_repeat_count: 0
      }
    );

    if (prospectosClient) {
      try {
        await prospectosClient.registerControlEvent({
          chatwoot_conversation_id: event.conversation.id,
          evento: "consulta_erronea",
          origen: getControlOrigin(currentLabels),
        });
      } catch (err) {
        logger.warn(
          {
            conversationId: event.conversation.id,
            error: err instanceof Error ? err.message : String(err),
          },
          "No se pudo registrar consulta errónea por respuestas sin rubro"
        );
      }
    }

    await pool.query(
      `UPDATE conversation_state
      SET prospect_followup_due_at = NULL,
          prospect_followup_completed = TRUE
      WHERE chatwoot_conversation_id = $1`,
      [event.conversation.id]
    );

    try {
      await client.setStatus(
        event.conversation.id,
        "resolved"
      );
    } catch {
      // Si Chatwoot ya la resolvió, no interrumpir el flujo.
    }

    return;
  }

  if (memory.requested_demo === true || memory.lead_intent === "demo") {
    await sendAndSave(
      isShortConversationalReply
        ? "Claro 😊 Para avanzar con la demostración solo necesito saber a qué se dedica tu negocio. Por ejemplo: dietética, carnicería, fiambrería, pet shop, almacén, distribuidora, fábrica u otro tipo de comercio."
        : "Para avanzar con la demostración, ¿me indicás a qué se dedica tu negocio? 😊",
      "awaiting_rubro",
      null,
      false,
      undefined,
      {
        rubro_invalid_attempts: nextRubroAttempts
      }
    );
  } else if (memory.lead_intent === "asesor") {
    await sendAndSave(
      isShortConversationalReply
        ? "Claro 😊 Para ponerte en contacto con un asesor solo necesito saber a qué se dedica tu negocio. Por ejemplo: dietética, carnicería, fiambrería, pet shop, almacén, distribuidora, fábrica u otro tipo de comercio."
        : "Para ponerte en contacto con un asesor, ¿me indicás a qué se dedica tu negocio? 😊",
      "awaiting_rubro",
      null,
      false,
      undefined,
      {
        rubro_invalid_attempts: nextRubroAttempts
      }
    );
  } else {
    await sendAndSave(
      isShortConversationalReply
        ? "Claro 😊 Para poder orientarte necesito saber a qué se dedica tu negocio. Por ejemplo: dietética, carnicería, fiambrería, pet shop, almacén, distribuidora, fábrica u otro tipo de comercio."
        : "Disculpas, no llegué a identificar el rubro 😊. Para brindarte información acorde, me indicarías a qué se dedica tu comercio? Por ejemplo: dietética, pet shop, carnicería, almacén, distribuidora, indumentaria, ferretería, etc.",
      "awaiting_rubro",
      null,
      false,
      undefined,
      {
        rubro_invalid_attempts: nextRubroAttempts
      }
    );
  }

  logger.info(
    {
      conversationId: event.conversation.id,
      userText,
      requestedDemo: memory.requested_demo === true,
      leadIntent: memory.lead_intent ?? null,
      rubroInvalidAttempts: nextRubroAttempts
    },
    "Respuesta sin rubro; se realiza una única repregunta"
  );

  return;
}
      }


      // Si responde a un seguimiento indicando que no recibió la información,
      // reenviar la propuesta comercial completa.
      if (
        current.prospect_followup_attempt > 0 &&
        saysInfoWasNotReceived(userText)
      ) {
        await client.sendMessage(
          event.conversation.id,
          "¡Claro! Te reenvío la información 😊"
        );

        await client.sendMessage(
          event.conversation.id,
          COMMERCIAL_OVERVIEW
        );
        await delay(COMMERCIAL_MESSAGE_GAP_MS);

        await sendAndSave(
          stateData.sales_questions_complete === true
            ? buildCommercialContinuationPrompt(activeRubro)
            : current.stage === "awaiting_main_need"
              ? SALES_QUALIFICATION_NEED
              : buildCommercialAdvisorPrompt(activeRubro),
          stateData.sales_questions_complete === true
            ? "proposal_sent"
            : current.stage === "awaiting_main_need" ? "awaiting_main_need" : "awaiting_current_system",
          activeRubro,
          false,
          undefined,
          { proposal_sent: true }
        );

        logger.info(
          { conversationId: event.conversation.id },
          "Información comercial reenviada porque el prospecto indicó que no la recibió"
        );

        return;
      }

            // ─── RESPUESTA A OPCIONES DE SEGUIMIENTO ─────────────────────────
      // Los mensajes automáticos de seguimiento ofrecen:
      // 1 = demo, 2 = asesor, 3 = no interesado.
      // Debemos resolver estas opciones antes del flujo general
      // de awaiting_rubro para evitar reiniciar la conversación.
      if (
        current.prospect_followup_attempt > 0 &&
        ["1", "2", "3"].includes(userText.trim())
      ) {
        const opcionSeguimiento = userText.trim();

if (opcionSeguimiento === "3") {
  await sendAndSave(
    "Entendido 😊 Gracias por avisarnos. ¡Saludos!",
    "closed",
    activeRubro,
    true,
    "refused_demo",
  );

  if (prospectosClient) {
    try {
      await prospectosClient.registerControlEvent({
        chatwoot_conversation_id: event.conversation.id,
        evento: "no_interesado",
        origen: getControlOrigin(currentLabels),
      });
    } catch (err) {
      logger.warn(
        {
          conversationId: event.conversation.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "No se pudo registrar no interesado en Control",
      );
    }
  }

  await pool.query(
    `UPDATE conversation_state
     SET prospect_followup_completed = TRUE,
         prospect_followup_due_at = NULL
     WHERE chatwoot_conversation_id = $1`,
    [event.conversation.id]
  );

  try {
    await client.setStatus(
      event.conversation.id,
      "resolved"
    );
  } catch {
    // La conversación puede haberse resuelto previamente.
  }

  logger.info(
    { conversationId: event.conversation.id },
    "Seguimiento: prospecto indicó que no está interesado"
  );

  return;
}
        memory.lead_intent =
          opcionSeguimiento === "1"
            ? "demo"
            : "asesor";

        await pool.query(
          `UPDATE conversation_state
           SET prospect_followup_completed = TRUE,
               prospect_followup_due_at = NULL
           WHERE chatwoot_conversation_id = $1`,
          [event.conversation.id]
        );

        // Si todavía no conocemos el rubro, conservar la intención
        // y pedir el dato faltante.
        if (!activeRubro) {
          const mensaje =
            opcionSeguimiento === "1"
              ? "¡Excelente! 😊 Para avanzar con la demostración, ¿me indicarías de qué rubro es tu negocio?"
              : "¡Perfecto! 😊 Para ponerte en contacto con un asesor, ¿me indicarías de qué rubro es tu negocio?";

          await sendAndSave(
            mensaje,
            "awaiting_rubro",
            null
          );

          logger.info(
            {
              conversationId: event.conversation.id,
              opcion: opcionSeguimiento
            },
            "Respuesta a seguimiento procesada; esperando rubro"
          );

          return;
        }

        // Si ya conocemos rubro y nombre, no volver a pedir datos.
        // Derivar directamente a Ventas.
        if (availableLeadName) {
          const summary = buildLeadSummary(
            stateData,
            activeRubro,
            availableLeadName
          );

          stateData.lead_name = availableLeadName;
          stateData.lead_summary = summary;

          const reply =
            opcionSeguimiento === "1"
              ? `¡Perfecto, ${availableLeadName}! 😊 Ya te derivamos con un asesor comercial. Va a mostrarte cómo funciona el sistema aplicado a tu negocio y podrá resolver todas tus dudas.`
              : `¡Perfecto, ${availableLeadName}! 😊 Ya te derivamos con un asesor comercial para resolver tus dudas. Se pondrá en contacto con vos a la brevedad.`;

          await performHandoffToSales(
            "seguimiento_datos_completos",
            reply,
            {
              lead_name: availableLeadName,
              lead_summary: summary
            }
          );

          return;
        }

        const mensaje =
          opcionSeguimiento === "1"
            ? "¡Excelente! 😊 ¿Me podrías indicar tu nombre? Así te ponemos en contacto con un asesor comercial para coordinar la demostración."
            : "¡Perfecto! 😊 ¿Me podrías indicar tu nombre? Así te ponemos en contacto con un asesor comercial para resolver tus dudas.";

        await sendAndSave(
          mensaje,
          "awaiting_name",
          activeRubro
        );

        logger.info(
          {
            conversationId: event.conversation.id,
            opcion: opcionSeguimiento,
            rubro: activeRubro
          },
          "Respuesta a seguimiento procesada correctamente"
        );

        return;
      }

      // Paso 1 & 2: Saludo inicial y/o respuesta con rubro
      if (["new", "awaiting_rubro"].includes(current.stage) || (isGreeting(userText) && !current.rubro)) {
        if (activeRubro) {
          memory.rubro = activeRubro;
          memory.proposal_sent = true;

          // Si viene de la web con interés en demo, conservar la intención,
          // pero calificar primero el uso actual y la necesidad del negocio.
          if (memory.requested_demo === true) memory.lead_intent = "demo";

          // Enviar la presentación en dos mensajes: primero información y video,
          // después una invitación clara a avanzar con un asesor.
          await client.sendMessage(
            event.conversation.id,
            COMMERCIAL_OVERVIEW
          );
          await delay(COMMERCIAL_MESSAGE_GAP_MS);

          await sendAndSave(
            buildCommercialAdvisorPrompt(activeRubro),
            "awaiting_current_system",
            activeRubro,
            false,
            undefined,
            { proposal_sent: true }
          );

          logger.info({ conversationId: event.conversation.id, rubro: activeRubro }, "Propuesta comercial enviada en dos mensajes: información + avance con asesor");
          return;
        }

        const claimed = await pool.query(
          `UPDATE conversation_state
           SET stage = 'awaiting_rubro'
           WHERE chatwoot_conversation_id = $1
           RETURNING chatwoot_conversation_id`,
          [event.conversation.id]
        );
        if (claimed.rowCount !== 1) return;

        const greetingText =
          "¡Hola! 👋 Soy el asistente virtual de SM Soluciones.\n\n" +
          "Tenemos distintas soluciones de gestión según las necesidades y la etapa de cada comercio. Te vamos a hacer unas preguntas breves para orientarte mejor. Primero contame:\n\n" +
          "¿De qué rubro es tu negocio? 😊 (dietética, pet shop, carnicería, almacén, distribuidora, indumentaria, ferretería, etc.)";
        await sendAndSave(greetingText, "awaiting_rubro");
        logger.info({ conversationId: event.conversation.id }, "Paso 1: Saludo inicial y pregunta de rubro enviada");
        return;
      }

      // Paso 6 y 7: Procesar respuestas tras haber enviado la propuesta comercial
if (refusesDemo(userText) || userText.trim() === "3") {
  await sendAndSave(
    "Entendido 😊 Gracias por avisarnos. ¡Saludos!",
    "closed",
    activeRubro,
    true,
    "refused_demo",
  );

  if (prospectosClient) {
    try {
      await prospectosClient.registerControlEvent({
        chatwoot_conversation_id: event.conversation.id,
        evento: "no_interesado",
        origen: getControlOrigin(currentLabels),
      });
    } catch (err) {
      logger.warn(
        {
          conversationId: event.conversation.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "No se pudo registrar no interesado en Control",
      );
    }
  }

  try {
    await client.setStatus(
      event.conversation.id,
      "resolved"
    );
  } catch {
    // Ignorar si Chatwoot ya tenía la conversación resuelta.
  }

  logger.info(
    { conversationId: event.conversation.id },
    "Paso 6c: Cliente rechazó asesor; conversación cerrada en Chatwoot y bot detenido"
  );

  return;
}
    }
  };
}

