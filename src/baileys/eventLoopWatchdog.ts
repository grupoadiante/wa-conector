// Detecta o processo "travado": container de pé, mas o event loop do Node
// bloqueado (loop de CPU, derivação de chave interminável, deadlock). Nesse
// estado o setInterval do memory-watchdog e o uncaughtException NÃO rodam —
// só um observador fora do event loop principal consegue agir.
//
// Como funciona: a thread principal escreve a hora atual num buffer
// compartilhado a cada 1s. Uma worker thread (que tem event loop próprio)
// confere esse buffer a cada 5s. Se passar STALL_MS sem batida, ela mata o
// processo inteiro com SIGKILL — o restart policy do container sobe um novo.
// SIGKILL (e não exit limpo) porque a thread principal travada não consegue
// rodar o gracefulShutdown; os locks do Redis expiram sozinhos em 30s.

import { Worker } from "node:worker_threads";

const STALL_MS = Number(process.env.EVENT_LOOP_STALL_MS || 60_000);

const WORKER_CODE = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const beat = new Float64Array(workerData.sab);
setInterval(() => {
  const stalled = Date.now() - beat[0];
  if (stalled > workerData.stallMs) {
    try {
      fs.writeSync(2, "[event-loop-watchdog] processo travado ha " + Math.round(stalled / 1000) + "s (event loop sem responder) — matando o processo para o container reiniciar\\n");
    } catch (_) {}
    process.kill(process.pid, "SIGKILL");
  }
}, 5000);
`;

export function installEventLoopWatchdog(): void {
  const sab = new SharedArrayBuffer(8);
  const beat = new Float64Array(sab);
  beat[0] = Date.now();

  setInterval(() => {
    beat[0] = Date.now();
  }, 1000).unref();

  const worker = new Worker(WORKER_CODE, { eval: true, workerData: { sab, stallMs: STALL_MS } });
  worker.unref();
  worker.on("error", (err) => console.error("[event-loop-watchdog] falha na worker thread", err));
  console.log(`[event-loop-watchdog] ativo (limite ${STALL_MS / 1000}s sem batida)`);
}
