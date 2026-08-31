import express from "express";
import { config } from "./config";
import { requireApiKey } from "./authMiddleware";
import { sessionsRouter } from "./routes/sessions";
import { messagesRouter } from "./routes/messages";
import { labelsRouter } from "./routes/labels";

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

app.listen(config.port, () => {
  console.log(`wa-connector ouvindo na porta ${config.port}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
