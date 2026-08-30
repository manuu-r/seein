export interface DiagnosticLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export const silentDiagnosticLogger: DiagnosticLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Produces useful, bounded error fields for persisted events and structured logs.
 * Provider SDKs commonly attach HTTP status/codes without including them in the
 * message, while causes carry the actual transport error.
 */
export function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error).slice(0, 8_000) };
  const candidate = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
  const cause = candidate.cause instanceof Error
    ? {
        name: candidate.cause.name,
        message: candidate.cause.message.slice(0, 2_000),
        ...scalarErrorFields(candidate.cause as Error & { code?: unknown; status?: unknown; statusCode?: unknown }),
      }
    : undefined;
  return {
    error: error.message.slice(0, 8_000),
    errorName: error.name,
    ...scalarErrorFields(candidate),
    ...(cause ? { cause } : {}),
  };
}

function scalarErrorFields(error: { code?: unknown; status?: unknown; statusCode?: unknown }): Record<string, unknown> {
  return {
    ...(typeof error.code === "string" || typeof error.code === "number" ? { errorCode: error.code } : {}),
    ...(typeof error.status === "string" || typeof error.status === "number" ? { httpStatus: error.status } : {}),
    ...(typeof error.statusCode === "number" ? { httpStatus: error.statusCode } : {}),
  };
}

/** Keep terminal logs readable and avoid accidentally printing prompts or credentials. */
export function safeLogFields(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeRecord(value, 0);
}

function sanitizeRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth >= 3) return { summary: "[nested detail omitted]" };
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (/api.?key|authorization|password|secret|token|prompt|contents?/i.test(key) || key.toLowerCase() === "code") return [];
      if (typeof entry === "string") return [[key, entry.slice(0, 2_000)]];
      if (Array.isArray(entry)) {
        return [[key, entry.slice(0, 16).map((item) =>
          item && typeof item === "object"
            ? sanitizeRecord(item as Record<string, unknown>, depth + 1)
            : typeof item === "string" ? item.slice(0, 500) : item,
        )]];
      }
      if (entry && typeof entry === "object") {
        return [[key, sanitizeRecord(entry as Record<string, unknown>, depth + 1)]];
      }
      return [[key, entry]];
    }),
  );
}
