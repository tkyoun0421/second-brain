import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_JWT_ISSUER: z.string().url(),
  SUPABASE_JWT_AUDIENCE: z.string().min(1).default("authenticated"),
  MEMORY_FORGET_PREVIEW_SECRET: z.string().min(32),
  // Keep local development private by default. Container platforms must opt in
  // to the public interface explicitly through HOST=0.0.0.0.
  HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export const loadConfig = (): AppConfig => environmentSchema.parse(process.env);
