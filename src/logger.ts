type LogLevel = "debug" | "info" | "warn" | "error";

type LogPayload = Record<string, unknown>;

function serializeError(error: unknown): LogPayload {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { value: String(error) };
}

function write(level: LogLevel, scope: string, step: string, payload?: LogPayload): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    step,
    ...payload,
  });

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export const log = {
  debug(scope: string, step: string, payload?: LogPayload): void {
    write("debug", scope, step, payload);
  },

  info(scope: string, step: string, payload?: LogPayload): void {
    write("info", scope, step, payload);
  },

  warn(scope: string, step: string, payload?: LogPayload): void {
    write("warn", scope, step, payload);
  },

  error(scope: string, step: string, error?: unknown, payload?: LogPayload): void {
    write("error", scope, step, {
      ...payload,
      error: error === undefined ? undefined : serializeError(error),
    });
  },
};