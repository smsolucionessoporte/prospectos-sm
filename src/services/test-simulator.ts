import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { isGreeting } from "../ai/answer.js";

const normalize = (text: string) =>
  text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

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

export function extractCleanName(input: string | null | undefined): string {
  if (!input) return "";
  let text = input.trim();
  const norm = normalizeText(text);

  if (
    /^(si|sí|dale|bueno|ok|okay|perfecto|quiero|me interesa|quiero la demo|quiero una demo|demo)$/i.test(norm) ||
    /\b(demo|demostracion|asesor|vendedor|reunion|meet|informacion|presupuesto)\b/i.test(norm)
  ) {
    return "";
  }

  while (true) {
    const prev = text;
    text = text.replace(/^(si|sí|dale|bueno|ok|okay|perfecto|hola|buenas|buenos dias|buenas tardes|buenas noches)[\s,!.]*/i, "").trim();
    text = text.replace(/^(mi nombre es|me llamo|soy|mi nombre|nombre|es)[\s:]+/i, "").trim();
    if (text === prev) break;
  }

  text = text.replace(/[\s,!.]+(gracias|por favor|dale).*$/i, "").trim();
  text = text.replace(/[.,!?:;]+$/g, "").trim();

  if (text.length > 40 || text.length === 0) {
    return "";
  }

  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
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

function detectRubro(content: string | null | undefined): string | null {
  const text = normalizeText(content ?? "");
  if (/\b(dietetica|dieteticas|almacen natural|almacenes naturales|dietetica y almacen natural)\b/.test(text)) {
    return "dietetica";
  }
  if (/\b(pet shop|petshop|veterinaria)\b/.test(text)) {
    return "petshop";
  }
  if (/\b(almacen|almacenes|kiosco|kiosko|maxikiosco|despensa|autoservicio|supermercado|minimarket|mercadito|comercio|tienda|rotiseria|panaderia|verduleria|carniceria|polleria|ferreteria|bazar|regaleria|farmacia|libreria|indumentaria|calzado)\b/.test(text)) {
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
  const text = normalizeText(content ?? "");
  if (isMultiBranchOrSpecial(content)) return true;
  return /\b(asesor|humano|persona|vendedor|ventas|reunion|demo|demostracion|meet|contratar|contratacion|contacto)\b/.test(
    text
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
  const text = normalizeText(content ?? "");
  return /\b(quiero|coordinar|agendar|ver|hacer|me interesa)\b.*\b(demo|demostracion)\b/.test(text)
    || /\b(demo|demostracion)\b.*\b(quiero|coordinar|agendar|ver|hacer|me interesa)\b/.test(text);
}

const CURRENT_QUESTION = "📝 Para orientarte mejor, ¿cómo llevás hoy las ventas, el stock y la administración de tu negocio? (Por ejemplo: otro sistema, Excel, anotaciones o todavía no abriste). Contame con tus palabras 😊";
const NEED_QUESTION = "Gracias por contarme 😊 ¿Qué es lo que más necesitás mejorar o resolver con un sistema de gestión?";
const INTEREST_QUESTION = "🤝 ¿Te gustaría ver una demostración de SM para tu negocio o preferís hablar primero con un asesor sobre planes y precios? Contame qué preferís y te ponemos en contacto con nuestro equipo 😊";
function validAnswer(content: string): boolean {
  const text = normalizeText(content);
  return text.length >= 3 && !/^(?:[0-9]+|si|no|dale|ok|bueno|perfecto|gracias|hola|listo)$/.test(text) && !isPrefilledAdOrWebsiteTemplate(content);
}

function refusesDemo(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "");
  if (/^(no|nop|no gracias|por ahora no|no me interesa|paso|no quiero|no por ahora)$/.test(text)) {
    return true;
  }
  if (/^no\s+(gracias|me interesa|quiero|por ahora|hace falta|necesito)$/.test(text)) {
    return true;
  }
  return false;
}

function isWrongNumber(content: string | null | undefined): boolean {
  const text = normalizeText(content ?? "");
  return /\b(equivocado|error|equivoque|numero equivocado|telefono equivocado|no soy|no es aca|no pedi|no solicite)\b/.test(text);
}

function isQuestion(content: string | null | undefined): boolean {
  const original = (content ?? "").trim();
  if (original.includes("?")) return true;
  const text = normalizeText(original);
  return /^(como|que|cual|cuanto|cuando|donde|por que|tiene|tienen|puede|pueden|funciona|sirve|hay|se puede)\b/.test(text);
}

function extractSubQueries(question: string): string[] {
  const rawClauses = question
    .split(/\r?\n|\?/)
    .map((p) => p.replace(/^[¿?\s\-\*\d\.]+\s*/, "").trim())
    .filter(Boolean);

  const subQueries: string[] = [];

  for (const clause of rawClauses) {
    let text = clause;
    const norm = normalizeText(text);

    if (
      /^(hola|buenas|buenos dias|buenas tardes|buenas noches|como estas|como andas|que tal)\b/.test(norm) ||
      norm === "como estas" ||
      norm === "como andas" ||
      norm === "que tal"
    ) {
      const qMatch = text.match(/(podrian|puedo|el stock|que incluye|tambien quisiera|como|cuanto|se puede|tienen|funciona|sirve)\b.*/i);
      if (qMatch) {
        text = qMatch[0];
      } else {
        continue;
      }
    }

    if (text.length >= 10) {
      subQueries.push(text);
    }
  }

  return subQueries.length > 0 ? Array.from(new Set(subQueries)) : [question];
}

export interface TestState {
  stage: string;
  rubro: string | null;
  qualificationIndex: number;
  qualificationAnswers: Array<{ question: string; answer: string }>;
  aiCallCount: number;
  proposalSent?: boolean;
  leadName?: string | null;
}

export interface TestDebugDetails {
  responseKind: "welcome" | "directive" | "rag" | "qualification" | "handoff" | "closure" | "wrong_number" | "refused_demo";
  stage: string;
  rubro: string | null;
  matchedDirective: { topic: string; answer: string; triggerTerms: string[]; method: "literal" | "semantic" } | null;
  ragChunks: Array<{ title: string; priority: number; score: number; contentSnippet: string }>;
  guidelinesUsed: { instructions: string; maxAiQuestions: number };
  qualificationProgress: { currentQuestionIndex: number; totalQuestions: number; questionText: string } | null;
  simulatedTokens: { promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostUsd: number } | null;
  statsAltered: false;
}

export interface TestSimulationResult {
  reply: string;
  nextState: TestState;
  debug: TestDebugDetails;
}

export class TestSimulatorService {
  private readonly openai?: OpenAI;

  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    openai?: OpenAI
  ) {
    this.openai =
      openai ??
      (config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : undefined);
  }

  private async loadMessage(key: string): Promise<string> {
    const setting = await this.pool.query<{ text: string }>(
      `SELECT value->>'text' AS text FROM bot_settings WHERE key = $1 LIMIT 1`,
      [key]
    );
    return setting.rows[0]?.text ?? "";
  }

  private async loadPriceMessage(): Promise<string> {
    const result = await this.pool.query<{ price_message: string }>(
      `SELECT COALESCE(value->>'price_message', '') AS price_message
       FROM bot_settings WHERE key = 'bot_guidelines' LIMIT 1`
    );
    return result.rows[0]?.price_message?.trim() ?? "";
  }

  private async loadQualificationFlow() {
    const result = await this.pool.query<{
      enabled: boolean;
      intro_message: string;
      questions: string[];
      completion_message: string;
    }>(
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
      introMessage: value?.intro_message ?? "",
      questions: (value?.questions ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 6),
      completionMessage: value?.completion_message ?? ""
    };
  }

  private async loadGuidelines() {
    const result = await this.pool.query<{
      instructions: string;
      max_ai_questions: number;
    }>(
      `SELECT
         COALESCE(value->>'instructions', '') AS instructions,
         COALESCE((value->>'max_ai_questions')::int, 4) AS max_ai_questions
       FROM bot_settings WHERE key = 'bot_guidelines' LIMIT 1`
    );
    return {
      instructions: result.rows[0]?.instructions ?? "",
      maxAiQuestions: result.rows[0]?.max_ai_questions ?? 4
    };
  }

  async processTestMessage(
    userMessage: string,
    currentState?: Partial<TestState>
  ): Promise<TestSimulationResult> {
    const state: TestState = {
      stage: currentState?.stage ?? "new",
      rubro: currentState?.rubro ?? null,
      qualificationIndex: Math.max(0, currentState?.qualificationIndex ?? 0),
      qualificationAnswers: Array.isArray(currentState?.qualificationAnswers)
        ? currentState.qualificationAnswers
        : [],
      aiCallCount: Math.max(0, currentState?.aiCallCount ?? 0),
      proposalSent: Boolean(currentState?.proposalSent),
      leadName: currentState?.leadName ?? null
    };

    const guidelines = await this.loadGuidelines();

    const debug: TestDebugDetails = {
      responseKind: "welcome",
      stage: state.stage,
      rubro: state.rubro,
      matchedDirective: null,
      ragChunks: [],
      guidelinesUsed: guidelines,
      qualificationProgress: null,
      simulatedTokens: null,
      statsAltered: false
    };

    // 0. Si el estado es awaiting_name: capturar nombre y derivar al asesor
    if (state.stage === "awaiting_name") {
      const rawText = userMessage.trim();
      const cleanName = extractCleanName(rawText);

      state.stage = "human";
      debug.stage = "human";
      debug.responseKind = "handoff";
      const reply = cleanName
        ? `¡Muchas gracias ${cleanName}! Ya le derivamos tus datos a un asesor comercial de nuestro equipo para que se ponga en contacto con vos a la brevedad.`
        : `¡Muchas gracias! Ya le derivamos tu consulta a un asesor comercial de nuestro equipo para que se ponga en contacto con vos a la brevedad.`;
      return { reply, nextState: state, debug };
    }

    // 1. Detección de contacto equivocado
    if (isWrongNumber(userMessage)) {
      state.stage = "closed";
      debug.responseKind = "wrong_number";
      debug.stage = "closed";
      return {
        reply: "Entendido, disculpá las molestias. ¡Saludos!",
        nextState: state,
        debug
      };
    }

    // Misma secuencia de calificación abierta que usa el webhook real.
    if (state.stage === "awaiting_current_system" || state.stage === "awaiting_main_need") {
      const question = state.stage === "awaiting_current_system" ? CURRENT_QUESTION : NEED_QUESTION;
      if (!validAnswer(userMessage) || isPurePriceQuery(userMessage)) {
        debug.responseKind = "qualification";
        debug.qualificationProgress = {
          currentQuestionIndex: state.stage === "awaiting_current_system" ? 0 : 1,
          totalQuestions: 2,
          questionText: question,
        };
        return { reply: `Contame con tus palabras, por favor 😊\n\n${question}`, nextState: state, debug };
      }
      if (state.stage === "awaiting_current_system") {
        state.qualificationAnswers.push({ question: "Cómo gestiona hoy el negocio", answer: userMessage.trim() });
        state.qualificationIndex = 1;
        state.stage = "awaiting_main_need";
        debug.stage = state.stage;
        debug.responseKind = "qualification";
        debug.qualificationProgress = { currentQuestionIndex: 1, totalQuestions: 2, questionText: NEED_QUESTION };
        return { reply: NEED_QUESTION, nextState: state, debug };
      }
      state.qualificationAnswers.push({ question: "Qué necesita mejorar o resolver", answer: userMessage.trim() });
      state.qualificationIndex = 2;
      state.stage = "proposal_sent";
      debug.stage = state.stage;
      debug.responseKind = "qualification";
      return { reply: INTEREST_QUESTION, nextState: state, debug };
    }

    // 5. Saludo inicial y/o captura directa de rubro
    if (["new", "awaiting_rubro"].includes(state.stage) || (isGreeting(userMessage) && !state.rubro)) {
      const detected = detectRubro(userMessage);
      const rubroDetected = detected ?? state.rubro;
      if (rubroDetected) {
        state.rubro = rubroDetected;
        state.proposalSent = true;
        state.stage = "proposal_sent";
        debug.stage = "proposal_sent";
        debug.rubro = rubroDetected;
        debug.responseKind = "welcome";

        state.stage = "awaiting_current_system";
        debug.stage = state.stage;
        debug.responseKind = "qualification";
        debug.qualificationProgress = { currentQuestionIndex: 0, totalQuestions: 2, questionText: CURRENT_QUESTION };
        const intro = rubroDetected === "dietetica"
          ? "¡Perfecto! 😊 Hace más de 15 años acompañamos a dietéticas y almacenes naturales."
          : rubroDetected === "petshop"
            ? "¡Perfecto! 😊 Hace más de 15 años acompañamos a pet shops."
            : "¡Perfecto! 😊 Hace más de 15 años desarrollamos sistemas para comercios y pymes.";
        return {
          reply: `${intro}\n\nCon SM podés gestionar ventas, stock, compras, caja y facturación, además de precios y etiquetas. Tenemos opciones para comercios que están empezando y otros con mayor volumen.\n\n🎥 Mirá la presentación: https://youtu.be/3PlRpHUcK2U\n\n${CURRENT_QUESTION}`,
          nextState: state,
          debug
        };
      }

      state.stage = "awaiting_rubro";
      debug.stage = "awaiting_rubro";
      debug.responseKind = "welcome";
      return {
        reply:
          "¡Hola! 👋 Soy el asistente virtual de SM Soluciones.\n\n" +
          "Tenemos distintas soluciones de gestión según las necesidades de cada comercio. Te vamos a hacer unas preguntas breves para orientarte mejor.\n\n" +
          "¿De qué rubro es tu negocio? (dietética, pet shop, carnicería, almacén, distribuidora, indumentaria, ferretería, etc.)",
        nextState: state,
        debug
      };
    }

    // 6 y 7. Respuestas tras envío de propuesta
    if (["proposal_sent", "awaiting_need", "qualified", "awaiting_name"].includes(state.stage) || isQuestion(userMessage) || userMessage.length > 0) {
      if (refusesDemo(userMessage)) {
        state.stage = "closed";
        debug.stage = "closed";
        debug.responseKind = "refused_demo";
        return {
          reply: "Entendido 😊 Gracias por avisarnos. ¡Saludos!",          nextState: state,
          debug
        };
      }

      if (isPurePriceQuery(userMessage)) {
        state.stage = "proposal_sent";
        debug.stage = "proposal_sent";
        return {
          reply: `Los planes dependen de las necesidades del comercio. ${INTEREST_QUESTION}`,
          nextState: state,
          debug
        };
      }

      if (acceptsDemo(userMessage) || wantsHuman(userMessage)) {
        const cleanName = extractCleanName(userMessage);
        if (state.leadName || cleanName) {
          state.leadName = state.leadName || cleanName;
          state.stage = "human";
          debug.stage = "human";
          debug.responseKind = "handoff";
          return {
            reply: `¡Muchas gracias${state.leadName ? `, ${state.leadName}` : ""}! Ya te derivamos con un asesor comercial de nuestro equipo para que pueda ayudarte personalmente. Se pondrá en contacto con vos a la brevedad.`,
            nextState: state,
            debug
          };
        }

        state.stage = "awaiting_name";
        debug.stage = "awaiting_name";
        return {
          reply: "¡Excelente! ¿Me podrías decir tu nombre así te derivamos con un asesor comercial para mostrarte el sistema y despejar todas tus dudas?",
          nextState: state,
          debug
        };
      }

      state.stage = "proposal_sent";
      debug.stage = "proposal_sent";
      return {
        reply: INTEREST_QUESTION,
        nextState: state,
        debug
      };
    }

    // 8. Derivación por defecto
    const noKnowledgeMsg = await this.loadMessage("no_knowledge_message");
    state.stage = "human";
    debug.stage = "human";
    debug.responseKind = "handoff";
    return { reply: noKnowledgeMsg, nextState: state, debug };
  }

  private async dryRunAnswer(question: string, rubro?: string | null) {
    const normalizedQuestion = normalize(question);
    const rules = await this.pool.query<{
      id: string;
      topic: string;
      trigger_terms: string[];
      answer: string;
      has_embedding: boolean;
    }>(
      `SELECT id::text, topic, trigger_terms, answer, (embedding IS NOT NULL) AS has_embedding
       FROM authoritative_rules WHERE active = TRUE ORDER BY priority DESC`
    );

    const literalMatch = rules.rows.find((r) =>
      r.trigger_terms.some((t) => {
        const normTerm = normalize(t);
        return normTerm.length >= 4 && normalizedQuestion.includes(normTerm);
      })
    );

    if (literalMatch) {
      return {
        kind: "answer" as const,
        text: literalMatch.answer,
        matchedDirective: {
          topic: literalMatch.topic,
          answer: literalMatch.answer,
          triggerTerms: literalMatch.trigger_terms,
          method: "literal" as const
        },
        ragChunks: [],
        simulatedTokens: null
      };
    }

    const priceMsg = await this.loadPriceMessage();
    const subQueries = extractSubQueries(question);
    const accumulatedRows: Array<{ id: string; title: string; content: string; priority: number; score: number }> = [];

    for (const subQ of subQueries) {
      const rows = await this.pool.query<{
        id: string;
        title: string;
        content: string;
        priority: number;
        score: number;
      }>(
        `SELECT kc.id::text, kd.title, kc.content, kd.priority,
           similarity(LOWER(kd.title || ' ' || kc.content), LOWER($1))::float8 AS score
         FROM knowledge_chunks kc
         JOIN knowledge_documents kd ON kd.id = kc.document_id
         WHERE kd.active = TRUE
           AND ($2::text IS NULL OR kd.rubro IS NULL OR kd.rubro = $2)
         ORDER BY score DESC, kd.priority DESC
         LIMIT 4`,
        [subQ, rubro ?? null]
      );
      for (const r of rows.rows) {
        if (!accumulatedRows.some((item) => item.id === r.id)) {
          accumulatedRows.push(r);
        }
      }
    }

    const ragChunks = accumulatedRows.map((r) => ({
      title: r.title,
      priority: r.priority,
      score: Math.round(r.score * 100) / 100,
      contentSnippet: r.content.slice(0, 180) + "..."
    }));

    if (this.openai && accumulatedRows.length) {
      const prompt = `Pregunta o consultas del prospecto:\n${question}\n\nInformación autorizada sobre precios y funciones:\nPrecios configurados: ${priceMsg}\n\nFragmentos de conocimiento:\n${accumulatedRows
        .slice(0, 6)
        .map((r) => `${r.title}: ${r.content}`)
        .join("\n\n---\n\n")}`;

      try {
        const response = await this.openai.responses.create({
          model: this.config.OPENAI_MODEL,
          max_output_tokens: this.config.AI_MAX_OUTPUT_TOKENS,
          store: false,
          instructions:
            `Sos un asesor comercial humano de SM Soluciones (sistema de gestión y ventas para comercios, dietéticas y pet shops). Atendés por WhatsApp de forma cercana, empática, profesional e inteligente en español rioplatense (Argentina).

Flujo conversacional humano obligatorio:
1. REACCIONAR Y EMPATIZAR: Reconocé la situación o mensaje del cliente antes de responder (ej: "¡Hola! Qué bueno saludarte", "Sí, te entiendo perfectamente", "Totalmente, en dietéticas el fraccionado y la balanza son fundamentales", "Ah genial, si tenés Excel...").
2. RESPONDER DIRECTO Y SIN EXAGERACIONES: Sé conciso y claro. Si te piden precio o características, respondé directo según la información configurada sin mandar catálogos innecesarios de 10 viñetas ni discursos armados.
3. MÁXIMO UNA PREGUNTA ÚTIL: Hacé como máximo UNA pregunta útil al final para orientar al cliente o avanzar hacia una demo/asesor, o NINGUNA pregunta si el usuario sólo quería sacarse una duda. NUNCA interrogues al cliente con preguntas repetitivas.
4. FORMATO WHATSAPP NATURAL: Usá párrafos breves. NUNCA estructures la respuesta con listas robóticas tipo "1. ... 2. ... 3. ..." ni uses títulos rígidos en negrita como **Importación desde Excel**. Escribí de forma fluida como una persona real en chat.`,
          input: prompt
        });

        const answerText = response.output_text.trim();
        if (answerText && !answerText.includes("NO_SE_ENCUENTRA")) {
          const pTokens = response.usage?.input_tokens ?? 250;
          const cTokens = response.usage?.output_tokens ?? 50;

          return {
            kind: "answer" as const,
            text: answerText,
            matchedDirective: null,
            ragChunks,
            simulatedTokens: {
              promptTokens: pTokens,
              completionTokens: cTokens,
              totalTokens: pTokens + cTokens,
              estimatedCostUsd: (pTokens / 1_000_000) * 0.20 + (cTokens / 1_000_000) * 1.20
            }
          };
        }
      } catch {
        // Caer al generador local
      }
    }

    const pointAnswers: string[] = [];
    let unknownCount = 0;

    for (let i = 0; i < subQueries.length; i++) {
      const subQ = subQueries[i]!;
      const normSub = normalizeText(subQ);

      if (/\b(mac|macbook|apple|ios)\b/.test(normSub)) {
        pointAnswers.push(`El sistema está diseñado para funcionar en computadoras con Windows 10 o superior (no es compatible de forma nativa con Mac OS, salvo utilizando una máquina virtual Windows).`);
        continue;
      }

      if (/\b(venden|vendes|ofrecen|ofrece|que hacen|que es|que ofrecen|de que trata|producto|productos|informacion|info)\b/.test(normSub)) {
        pointAnswers.push(`Ofrecemos una solución integral de software de gestión y ventas diseñada para comercios, dietéticas y pet shops, con control de stock en tiempo real, facturación electrónica AFIP, integración de balanzas pesadoras y actualización masiva de precios desde Excel.`);
        continue;
      }

      if (/\b(balanza|gramos|fraccionad|balanzas)\b/.test(normSub)) {
        pointAnswers.push(`¡Sí, tal cual! Podés vender productos fraccionados por gramos o kilos, y el sistema se conecta directo con balanzas pesadoras o de mostrador con impresión de etiquetas.`);
        continue;
      }

      if (/\b(excel|importar|importacion)\b/.test(normSub)) {
        pointAnswers.push(`Podés importar fácilmente tus productos con sus precios y códigos desde un archivo Excel en pocos minutos, para no tener que cargar nada a mano.`);
        continue;
      }

      if (/\b(stock|descuenta|descuento)\b/.test(normSub)) {
        pointAnswers.push(`¡Totalmente! El stock se descuenta automáticamente en tiempo real con cada venta realizada en la caja.`);
        continue;
      }

      if (/\b(actualizar|masiva|masivamente|costos)\b/.test(normSub)) {
        pointAnswers.push(`Cuando varíen tus costos podés modificar los precios de forma masiva en segundos, ya sea importando una lista nueva en Excel o aplicando un porcentaje global.`);
        continue;
      }

      if (/\b(precio|precios|costo|costos|plan|planes|iva|mensual)\b/.test(normSub)) {
        const textCost = priceMsg || "Los planes arrancan desde $50.000/mes + instalación. Incluyen el sistema completo con facturación electrónica AFIP y soporte.";
        pointAnswers.push(textCost);
        continue;
      }

      if (/\b(asistencia|configurar|instalacion|soporte|inicial)\b/.test(normSub)) {
        pointAnswers.push(`¡Por supuesto! Te brindamos acompañamiento paso a paso durante la instalación, la configuración inicial y la capacitación de tu equipo.`);
        continue;
      }

      const chunkRes = await this.pool.query<{ title: string; content: string }>(
        `SELECT kd.title, kc.content
         FROM knowledge_chunks kc
         JOIN knowledge_documents kd ON kd.id = kc.document_id
         WHERE kd.active = TRUE
           AND (similarity(LOWER(kd.title || ' ' || kc.content), LOWER($1)) > 0.28)
           AND ($2::text IS NULL OR kd.rubro IS NULL OR kd.rubro = $2)
         ORDER BY kd.priority DESC
         LIMIT 1`,
        [subQ, rubro ?? null]
      );

      if (chunkRes.rows[0]) {
        const snippet = chunkRes.rows[0].content.slice(0, 180).trim();
        pointAnswers.push(`${chunkRes.rows[0].title}: ${snippet}`);
      } else {
        unknownCount++;
        pointAnswers.push(`Esta consulta puntual te la responderá en detalle nuestro asesor comercial.`);
      }
    }

    if (subQueries.length > 1 && unknownCount > subQueries.length / 2) {
      return {
        kind: "answer" as const,
        text: "Un asesor comercial de nuestro equipo se comunicará a la brevedad para responder todas tus consultas de forma personalizada.",
        matchedDirective: null,
        ragChunks,
        simulatedTokens: null
      };
    }

    const compiledText = pointAnswers.join("\n\n");
    return {
      kind: "answer" as const,
      text: compiledText,
      matchedDirective: null,
      ragChunks,
      simulatedTokens: null
    };
  }
}
