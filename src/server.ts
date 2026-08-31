import express from "express";
import { config } from "./config";
import { requireApiKey } from "./authMiddleware";
import { sessionsRouter } from "./routes/sessions";
import { messagesRouter } from "./routes/messages";
import { labelsRouter } from "./routes/labels";
import { resumeAllSessions, releaseAllLocksForShutdown } from "./baileys/session";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Healthcheck público (sem API key) — EasyPanel usa isso pra saber se o
// container está de pé.
app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(requireApiKey);
app.use(sessionsRouter);
app.use(messagesRouter);
app.use(labelsRouter);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[unhandled]", err);
  res.status(500).json({ error: "internal_error" });
});

// Identificador de build — muda a cada versão que eu te mando, pra você
// conseguir confirmar no log qual código está rodando de verdade, sem
// depender de lembrar qual zip foi o último aplicado.
const BUILD_VERSION = "2026-08-31-auto-heal-lock-24hcache";

app.listen(config.port, () => {
  console.log(`wa-connector ouvindo na porta ${config.port} — build: ${BUILD_VERSION}`);
  resumeAllSessions().catch((err) => console.error("[resume] falha geral ao religar sessões", err));
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// EasyPanel manda SIGTERM antes de derrubar o container num redeploy. Libera
// os locks aqui pra o container novo não precisar esperar os 30s de TTL
// pra assumir as sessões — reduz a janela de instabilidade a cada deploy.
async function gracefulShutdown(signal: string) {
  console.log(`[shutdown] recebido ${signal}, liberando locks...`);
  try {
    await releaseAllLocksForShutdown();
  } catch (err) {
    console.error("[shutdown] falha ao liberar locks", err);
  }
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
