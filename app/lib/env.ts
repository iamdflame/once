// Server-only environment access. Every secret is read here and nowhere else,
// so the names Stripe Projects writes (and their aliases) live in one place.
import "server-only";

function pick(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

export const env = {
  /** Local world (e.g. http://127.0.0.1:8080). When set, CreateOS is skipped entirely. */
  worldUrl: () => pick("WORLD_URL")?.replace(/\/+$/, ""),

  /** CreateOS sandbox key. Stripe Projects writes CREATEOS_PROJECT_API_KEY; the SDK alone only reads CREATEOS_SANDBOX_API_KEY. */
  createosKey: () => pick("CREATEOS_SANDBOX_API_KEY", "CREATEOS_PROJECT_API_KEY", "CREATEOS_API_KEY"),
  /**
   * Sandbox API base URL. Deliberately NOT CREATEOS_PROJECT_API_URL: that is the CreateOS
   * platform API (api-createos.nodeops.network), not the Sandbox API the SDK talks to.
   */
  createosBaseUrl: () => pick("CREATEOS_SANDBOX_BASE_URL"),

  stripeSecret: () => pick("STRIPE_SECRET_KEY"),
  stripePublishable: () => pick("STRIPE_PUBLISHABLE_KEY"),

  anthropicKey: () => pick("ANTHROPIC_API_KEY"),
  anthropicModel: () => pick("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5",
  /** Stripe Projects provisions OpenRouter as OPENROUTER_API_API_KEY. */
  openrouterKey: () => pick("OPENROUTER_API_KEY", "OPENROUTER_API_API_KEY"),
  /** Comma-separated override of the free-model fallback chain. */
  openrouterModels: () => pick("OPENROUTER_MODELS"),

  /** Where the world bundle lives on disk (default: ../world/dist/world.cjs from app/). */
  worldBundle: () => pick("WORLD_BUNDLE"),
};

export function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new HttpError(500, `missing environment variable ${name}`);
  return value;
}

/** An error that carries an HTTP status for the API routes. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}
