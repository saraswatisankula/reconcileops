import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  META_DATABASE_URL: z.string().url(),
  DEMO_DATABASE_URL: z.string().url(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  API_TOKEN: z.string().optional().default(''),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

if (parsed.data.META_DATABASE_URL === parsed.data.DEMO_DATABASE_URL) {
  console.error('META_DATABASE_URL and DEMO_DATABASE_URL must point to different databases.');
  process.exit(1);
}

export const config = parsed.data;

// Used by the settings page so nobody has to look at raw connection strings.
export function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return '(invalid url)';
  }
}
