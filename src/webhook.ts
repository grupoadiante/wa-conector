import { config } from "./config";

// Envia um evento pra edge function custom-webhook no Supabase. Falha de
// rede aqui NUNCA deve derrubar a sessão do WhatsApp — é best effort com
// duas tentativas curtas, e loga se não conseguir.
export async function sendWebhookEvent(
  sessionId: string,
  event: string,
  payload: unknown
): Promise<void> {
  const body = JSON.stringify({
    session_id: sessionId,
    event,
    payload,
    sent_at: new Date().toISOString(),
  });

  for (const attempt of [0, 1]) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(config.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": config.webhookSecret,
        },
        body,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (res.ok) {
        console.log(`[webhook] ${event} (sessão ${sessionId}) entregue com sucesso`);
        return;
      }
      console.error(
        `[webhook] ${event} respondeu ${res.status} (tentativa ${attempt + 1})`
      );
    } catch (err) {
      console.error(
        `[webhook] ${event} falhou (tentativa ${attempt + 1})`,
        (err as Error).message
      );
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
  }
}
