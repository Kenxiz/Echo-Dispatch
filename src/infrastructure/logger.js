function normalizeContext(context) {
  if (context === undefined) return undefined;
  if (context instanceof Error) return { name: context.name, message: context.message, stack: context.stack };
  return context;
}

export class Logger {
  constructor(scope = "echo-dispatch", sink = console) {
    this.scope = scope;
    this.sink = sink;
  }

  child(scope) {
    return new Logger(`${this.scope}:${scope}`, this.sink);
  }
  debug(message, context) {
    this.write("debug", message, context);
  }
  info(message, context) {
    this.write("info", message, context);
  }
  warn(message, context) {
    this.write("warn", message, context);
  }
  error(message, context) {
    this.write("error", message, context);
  }

  write(level, message, context) {
    const method = typeof this.sink[level] === "function" ? level : "log";
    const prefix = `[${this.scope}] ${message}`;
    const normalized = normalizeContext(context);
    if (normalized === undefined) this.sink[method](prefix);
    else this.sink[method](prefix, normalized);
  }
}

export const logger = new Logger();
