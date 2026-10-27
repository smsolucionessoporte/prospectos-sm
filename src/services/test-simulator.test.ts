import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { TestSimulatorService } from "./test-simulator.js";
import { loadConfig } from "../config.js";

test("TestSimulatorService simula interacción de chat sin modificar estadísticas", async () => {
  const mockPool = {
    async query(sql: string) {
      if (sql.includes("FROM bot_settings WHERE key = 'qualification_flow'")) {
        return {
          rows: [
            {
              enabled: true,
              intro_message: "Para orientarte mejor, unas preguntas breves.",
              questions: ["¿Cómo administrás hoy el negocio?"],
              completion_message: "¡Gracias por responder!"
            }
          ]
        };
      }
      if (sql.includes("FROM bot_settings")) {
        return {
          rows: [{ text: "¡Hola! ¿Qué tipo de negocio tenés?" }]
        };
      }
      if (sql.includes("FROM authoritative_rules")) {
        return { rows: [] };
      }
      return { rows: [] };
    }
  } as unknown as Pool;

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost/test"
  });

  const simulator = new TestSimulatorService(mockPool, config);

  // 1. Mensaje de bienvenida inicial
  const res1 = await simulator.processTestMessage("Hola", { stage: "new" });
  assert.equal(res1.nextState.stage, "awaiting_rubro");
  assert.equal(res1.debug.statsAltered, false);
  assert.ok(res1.reply.includes("Hola"));

  // 2. Rubro + primera pregunta escrita
  const res2 = await simulator.processTestMessage("Tengo una dietética", { stage: "awaiting_rubro" });
  assert.equal(res2.nextState.stage, "awaiting_current_system");
  assert.equal(res2.nextState.rubro, "dietetica");
  assert.equal(res2.debug.statsAltered, false);
  assert.ok(res2.reply.includes("¿cómo llevás hoy las ventas"));
  assert.doesNotMatch(res2.reply, /1️⃣|2️⃣/);

  // 3. Un número solo no se acepta como respuesta de calificación.
  const numerico = await simulator.processTestMessage("1", res2.nextState);
  assert.equal(numerico.nextState.stage, "awaiting_current_system");
  const uso = await simulator.processTestMessage("Uso Excel para llevar las ventas", res2.nextState);
  assert.equal(uso.nextState.stage, "awaiting_main_need");
  const necesidad = await simulator.processTestMessage("Quiero mejorar el control de stock", uso.nextState);
  assert.equal(necesidad.nextState.stage, "proposal_sent");
  assert.equal(necesidad.nextState.qualificationAnswers.length, 2);
  assert.match(necesidad.reply, /demostración de SM/);
  const demo = await simulator.processTestMessage("Quiero ver una demostración", necesidad.nextState);
  assert.equal(demo.nextState.stage, "awaiting_name");

  // 3. Detección de número equivocado
  const res3 = await simulator.processTestMessage("Perdón, me equivoqué de número", { stage: "new" });
  assert.equal(res3.nextState.stage, "closed");
  assert.equal(res3.debug.responseKind, "wrong_number");
  assert.equal(res3.debug.statsAltered, false);
});
