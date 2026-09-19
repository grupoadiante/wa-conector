import express from "express";
import { config } from "./config";
import { requireApiKey } from "./authMiddleware";
import { sessionsRouter } from "./routes/sessions";
import { messagesRouter } from "./routes/messages";
import { labelsRouter } from "./routes/labels";
import { resumeAllSessions, releaseAllLocksForShutdown } from "./baileys/session";
import { installRawSignalErrorWatch } from "./baileys/rawSignalErrorWatch";

// Precisa instalar ANTES de qualquer sessão iniciar, senão perde os
// primeiros erros crus do libsignal (ver rawSignalErrorWatch.ts). A partir
// de agora cada sessão se registra como "sink" (em session.ts) e o próprio
// contato é renegociado (assertSessions), não a sessão inteira reiniciada.
installRawSignalErrorWatch();

// Identificador de build — muda a cada versão que eu te mando, pra você
// conseguir confirmar no log qual código está rodando de verdade, sem
// depender de lembrar qual zip foi o último aplicado.
const BUILD_VERSION = "2026-08-31-staggered-reconnect";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Healthcheck público (sem API key) — EasyPanel usa isso pra saber se o
// container está de pé.
app.get("/health", (_req, res) => res.json({ ok: true }));

// Também público (sem API key) — pra confirmar por curl qual build está
// rodando de verdade, sem precisar abrir o painel de logs do EasyPanel.
app.get("/version", (_req, res) => res.json({ build: BUILD_VERSION }));

app.use(requireApiKey);
app.use(sessionsRouter);
app.use(messagesRouter);
app.use(labelsRouter);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[unhandled]", err);
  res.status(500).json({ error: "internal_error" });
});

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
