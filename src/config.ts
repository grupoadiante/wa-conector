function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Env var obrigatória ausente: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  apiKey: required("CONNECTOR_API_KEY"),
  redisUrl: required("REDIS_URL"),
  webhookUrl: required("WEBHOOK_URL"),
  webhookSecret: required("WEBHOOK_SECRET"),
};
