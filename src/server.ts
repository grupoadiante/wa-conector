import { PANEL_HTML } from "./panelHtml";
import express from "express";
import { config } from "./config";
import { requireApiKey } from "./authMiddleware";
import { sessionsRouter } from "./routes/sessions";
import { messagesRouter } from "./routes/messages";
import { labelsRouter } from "./routes/labels";
import { resumeAllSessions, releaseAllLocksForShutdown, countLiveSessions } from "./baileys/session";
import { installConsoleNoiseFilter } from "./baileys/consoleNoise";
import { installLibsignalGuard, getQuarantinedContacts } from "./baileys/libsignalGuard";
import { installEventLoopWatchdog } from "./baileys/eventLoopWatchdog";
import { installResourceLog, noteUnhandledRejection, setLiveCounter } from "./baileys/resourceLog";
import { installSelfHeal } from "./baileys/selfHeal";

// Precisa instalar ANTES de qualquer sessão iniciar: o filtro descarta as
// linhas que o libsignal escreve direto no console (inclusive o despejo de
// chaves privadas das sessões).
installConsoleNoiseFilter();
installLibsignalGuard();
installEventLoopWatchdog();
setLiveCounter(countLiveSessions);
installResourceLog();

// Identificador de build — aparece no log de subida e em GET /version.
const BUILD_VERSION = "2026-11-18-labels-mode-self-heal-v9";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Healthcheck público (sem API key) — EasyPanel usa isso pra saber se o
// container está de pé.
app.get("/health", (_req, res) => res.json({ ok: true }));

// Também público (sem API key) — pra confirmar por curl qual build está
// rodando de verdade, sem precisar abrir o painel de logs do EasyPanel.
app.get("/version", (_req, res) =>
  res.json({
    build: BUILD_VERSION,
    default_mode: config.defaultSessionMode,
    sessions: countLiveSessions(),
    quarantined: getQuarantinedContacts(),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  })
);

// Painel de operação (HTML estático, sem dados). Público como /health e
// /version: a página não contém nenhum segredo — cada botão chama a API com a
// chave que o operador digita, e sem a chave nada responde.
app.get(["/painel", "/painel/"], (_req, res) => {
  res.set({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.send(PANEL_HTML);
});

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
  installSelfHeal();
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

// Erro solto (promise sem catch / exceção não tratada).
//
// ANTES: qualquer um desses encerrava o processo. Com várias sessões no
// mesmo processo, um erro em UM número derrubava TODOS — e o Baileys solta
// rejeições assim em situações normais (consulta que expira, conexão que
// fecha no meio de uma operação). O efeito era o servidor inteiro caindo e
// voltando, com o CRM recebendo 502 do proxy nesse intervalo.
//
// AGORA: o erro é logado e contado. O processo só reinicia se vier uma
// rajada (mais de FATAL_BURST em 1 minuto), que aí sim indica estado
// corrompido. Sessão que ficou ruim é tratada pela auto-cura periódica.
const FATAL_BURST = Number(process.env.FATAL_BURST || 40);
let recentFatal: number[] = [];
function noteFatal(kind: string, detail: unknown): void {
  noteUnhandledRejection();
  const message = detail instanceof Error ? `${detail.message}` : String(detail);
  const where = detail instanceof Error ? (detail.stack ?? "").split("\n").slice(1, 3).join(" | ").trim() : "";
  console.error(`[${kind}] ${message}${where ? ` — ${where}` : ""}`);
  const now = Date.now();
  recentFatal = recentFatal.filter((t) => now - t < 60_000);
  recentFatal.push(now);
  if (recentFatal.length > FATAL_BURST) {
    console.error(`[${kind}] mais de ${FATAL_BURST} erros soltos em 1 minuto — reiniciando o processo de forma controlada`);
    gracefulShutdown(`${kind}-burst`, 1).catch(() => process.exit(1));
  }
}
process.on("uncaughtException", (err) => noteFatal("uncaughtException", err));
process.on("unhandledRejection", (reason) => noteFatal("unhandledRejection", reason));

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
