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
const BUILD_VERSION = "2026-10-06-raw-signal-circuit-breaker";

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

// EasyPanel manda SIGTERM antes de derrubar o container num redeploy. Libera
// os locks aqui pra o container novo não precisar esperar os 30s de TTL
// pra assumir as sessões — reduz a janela de instabilidade a cada deploy.
//
// Esse mesmo caminho agora também é usado pra reinícios "controlados": em
// vez de deixar o processo travado/respondendo errado depois de um erro
// fatal, ou deixar a memória crescer sem limite até o Docker matar o
// container com SIGKILL (sem dar tempo de liberar lock nem fechar socket),
// a gente pede pra sair sozinho de forma limpa. O restart policy do
// container (configurado no EasyPanel) sobe um processo novo em segundos,
// e como o lock já foi liberado aqui, ele não fica esperando os 30s de TTL.
let shuttingDown = false;
async function gracefulShutdown(reason: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] motivo: ${reason} — liberando locks e saindo (exit ${exitCode})...`);
  try {
    await releaseAllLocksForShutdown();
  } catch (err) {
    console.error("[shutdown] falha ao liberar locks", err);
  }
  process.exit(exitCode);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM", 0));
process.on("SIGINT", () => gracefulShutdown("SIGINT", 0));

// ANTES: um erro não tratado só era logado e o processo continuava de pé.
// Isso é perigoso aqui — um uncaughtException pode deixar o event loop ou
// o estado interno do Baileys/libsignal corrompido sem matar o processo,
// então o /health continua respondendo "ok" (o processo tecnicamente está
// vivo) mas as sessões de WhatsApp param de processar de verdade. De fora
// (EasyPanel, hospedagem) isso não aparece como pico de CPU/memória — o
// processo só fica "zumbi" até alguém reiniciar manualmente. É o padrão
// mais parecido com o que aconteceu: 13 sessões mudas por horas, sem uso
// de recurso excessivo. Agora a gente sai de propósito (exit 1) pra forçar
// o restart policy do container a subir um processo novo e saudável.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] erro fatal — reiniciando o processo de forma controlada", err);
  gracefulShutdown("uncaughtException", 1).catch(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] promise rejeitada sem catch — reiniciando o processo de forma controlada", reason);
  gracefulShutdown("unhandledRejection", 1).catch(() => process.exit(1));
});

// Watchdog de memória: os 13 números ficam todos carregados na mesma
// máquina, cada um ocupando memória mesmo parado (chaves de sessão do
// Signal, cache de contatos, etc.), e o processo nunca solta memória de
// volta pro sistema por conta própria (comportamento normal do V8/Node).
// Em vez de deixar a memória crescer até o kernel matar o processo com
// SIGKILL — sem rodar o gracefulShutdown, sem liberar lock, sem fechar
// nada — a gente mesmo decide sair um pouco antes, de forma limpa, e deixa
// o restart policy do container subir de novo. Ajustável por variável de
// ambiente sem precisar de outro deploy.
const MEMORY_RESTART_LIMIT_MB = Number(process.env.MEMORY_RESTART_LIMIT_MB || 1536);
const MEMORY_CHECK_INTERVAL_MS = 30_000;
setInterval(() => {
  const rssMB = process.memoryUsage().rss / 1024 / 1024;
  if (rssMB > MEMORY_RESTART_LIMIT_MB) {
    console.error(
      `[memory-watchdog] RSS em ${rssMB.toFixed(0)}MB, acima do limite de ${MEMORY_RESTART_LIMIT_MB}MB — reiniciando de forma controlada`
    );
    gracefulShutdown("memory-limit", 0).catch(() => process.exit(1));
  }
}, MEMORY_CHECK_INTERVAL_MS).unref();
