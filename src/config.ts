import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_JWT_ISSUER: z.string().url(),
  SUPABASE_JWT_AUDIENCE: z.string().min(1).default("authenticated"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export const loadConfig = (): AppConfig => environmentSchema.parse(process.env);
