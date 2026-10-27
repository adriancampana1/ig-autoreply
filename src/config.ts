import { z } from 'zod';

const list = (lowercase: boolean) =>
  z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .map((item) => (lowercase ? item.replace(/^@/, '').toLowerCase() : item))
        .filter((item) => item.length > 0),
    );

const key32 = z
  .string()
  .refine((value) => Buffer.from(value, 'base64').length === 32, {
    message: 'deve ter exatamente 32 bytes codificados em base64 (gere com: openssl rand -base64 32)',
  });

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.url().transform((value) => value.replace(/\/+$/, '')),
  CONTACT_EMAIL: z.email(),
  DATABASE_PATH: z.string().min(1).default('./data/app.db'),
  IG_APP_ID: z.string().min(1),
  IG_APP_SECRET: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_WEBHOOK_SECRETS: list(false),
  WEBHOOK_VERIFY_TOKEN: z.string().min(16),
  GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v26.0'),
  ENCRYPTION_KEY: key32,
  SESSION_SECRET: key32,
  IG_ALLOWED_USERNAMES: list(true),
  REVIEW_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MAX_ACTIONS_PER_HOUR: z.coerce.number().int().positive().default(200),
});

export type Config = z.output<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuração inválida no .env:\n${problems}`);
  }
  const config = parsed.data;
  if (config.META_WEBHOOK_SECRETS.length === 0) {
    // A doc da Meta diz apenas "App Secret"; aceitamos os dois até confirmar qual assina (spec §15).
    config.META_WEBHOOK_SECRETS = [config.META_APP_SECRET, config.IG_APP_SECRET];
  }
  return config;
}
