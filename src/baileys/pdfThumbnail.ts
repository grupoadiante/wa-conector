import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Renderiza a primeira página do PDF como JPEG usando pdftoppm (poppler-utils).
// Retorna null se algo falhar — a mensagem ainda é enviada normalmente,
// só sem a miniatura, em vez de travar o envio inteiro por causa disso.
export async function pdfFirstPageThumbnail(pdfBuffer: Buffer): Promise<Buffer | null> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "pdf-thumb-"));
    const inputPath = join(dir, "input.pdf");
    const outputPrefix = join(dir, "thumb");
    await writeFile(inputPath, pdfBuffer);

    await new Promise<void>((resolve, reject) => {
      // -scale-to 200: gera uma miniatura de verdade (maior lado = 200px),
      // não uma página inteira. O WhatsApp espera um jpegThumbnail pequeno
      // (poucos KB) — a versão anterior gerava ~100KB em resolução quase de
      // página inteira, o que provavelmente sobrecarregava sessões já
      // frágeis (como a do Desktop) no envio pra alguns dispositivos.
      const proc = spawn("pdftoppm", [
        "-jpeg", "-f", "1", "-l", "1", "-scale-to", "200", "-singlefile",
        inputPath, outputPrefix,
      ]);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pdftoppm saiu com código ${code}: ${stderr}`));
      });
    });

    return await readFile(`${outputPrefix}.jpg`);
  } catch (err) {
    console.error("[pdf-thumbnail] falha ao gerar miniatura", (err as Error).message);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
