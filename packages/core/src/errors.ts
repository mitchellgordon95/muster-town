import type { Permission } from "@muster-town/schema";

export type ErrorCode =
  | "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict"
  | "unreachable" | "timeout" | "out_of_budget" | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409,
  unreachable: 422, timeout: 504, out_of_budget: 402, internal: 500,
};

/** The one error type core throws. The server maps `status` to HTTP; MCP returns `message` as a tool error. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** set when code === "forbidden" */
  readonly permission?: Permission;
  constructor(code: ErrorCode, message: string, status?: number, permission?: Permission) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status ?? STATUS[code];
    this.permission = permission;
  }
}

export function forbidden(permission: Permission, message?: string): AppError {
  return new AppError("forbidden", message ?? `Not allowed: you need the "${permission}" permission here.`, 403, permission);
}
export function notFound(what: string, id: string): AppError {
  return new AppError("not_found", `${what} not found: ${id}`);
}
export function badRequest(message: string): AppError {
  return new AppError("bad_request", message);
}
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
