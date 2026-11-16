// Uma linha por minuto com o estado de recursos do processo e da máquina.
// Serve pra, depois de uma queda, ver no log a ÚLTIMA leitura antes de morrer:
// se a memória (do processo ou da VPS) vinha subindo, se o event loop estava
// atrasado, etc. Sem isso, um container morto de fora não deixa nenhuma pista.

import fs from "node:fs";

function readNum(path: string): number | null {
  try {
    const v = fs.readFileSync(path, "utf8").trim();
    return v === "max" ? null : Number(v);
  } catch {
    return null;
  }
}

function hostMemAvailableMB(): number | null {
  try {
    const m = fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

const mb = (n: number | null) => (n === null ? "?" : Math.round(n / 1048576));

export function installResourceLog(): void {
  const INTERVAL_MS = 60_000;
  let expected = Date.now() + INTERVAL_MS;
  setInterval(() => {
    const lag = Math.max(0, Date.now() - expected);
    expected = Date.now() + INTERVAL_MS;
    const m = process.memoryUsage();
    const cg = readNum("/sys/fs/cgroup/memory.current");
    console.log(
      `[stats] rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}MB ext=${mb(m.external)}MB buf=${mb(m.arrayBuffers)}MB cgroup=${mb(cg)}MB hostAvail=${hostMemAvailableMB() ?? "?"}MB lag=${lag}ms up=${Math.round(process.uptime() / 60)}min`
    );
  }, INTERVAL_MS).unref();
}
