export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  BAD_GATEWAY: 502,
  INTERNAL: 500,
} as const;

export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = HttpStatus.INTERNAL,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  constructor(m = 'Not found') { super(m, HttpStatus.NOT_FOUND); }
}
export class ForbiddenError extends AppError {
  constructor(m = 'Forbidden') { super(m, HttpStatus.FORBIDDEN); }
}
export class BadRequestError extends AppError {
  constructor(m: string, d?: unknown) { super(m, HttpStatus.BAD_REQUEST, d); }
}
export class UnauthorizedError extends AppError {
  constructor(m = 'Unauthorized') { super(m, HttpStatus.UNAUTHORIZED); }
}
export class ConflictError extends AppError {
  constructor(m = 'Conflict', d?: unknown) { super(m, HttpStatus.CONFLICT, d); }
}

/** The Postgres error fields this service cares about, wherever they are nested. */
export interface PgErrorShape {
  code: string | undefined;
  constraint: string | undefined;
}

/**
 * Pulls the driver's SQLSTATE and constraint name out of an error thrown by a
 * drizzle query.
 *
 * drizzle-orm wraps the driver's real error in `DrizzleQueryError`, whose own
 * `message` is just "Failed query: ...params: ..." and which carries no `code`
 * at all — the Postgres `code`/`constraint` live on `.cause`, one level down.
 * Reading only the top-level error is why a constraint violation looks like an
 * unrecognised failure and falls through to a 500 carrying the raw query and
 * its parameters.
 */
export function pgError(error: unknown): PgErrorShape {
  const top = error as
    | { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } }
    | null
    | undefined;
  return {
    code: top?.code ?? top?.cause?.code,
    constraint: top?.constraint ?? top?.cause?.constraint,
  };
}

/**
 * Last-resort translator for raw Postgres errors that reach the error handler,
 * ported from leads-service/src/lib/errors.ts so the two services answer a
 * constraint violation the same way. Call sites that can say something more
 * useful (naming the row that already holds a mapping, say) should catch and
 * throw their own error first; this only guarantees a well-formed 4xx instead
 * of a 500 leaking the raw DB string. Returns null when the error is not a
 * recognised DB error, so the handler falls through to a generic 500.
 */
export function translatePgError(error: unknown): AppError | null {
  switch (pgError(error).code) {
    case '23505': // unique_violation
    case '23P01': // exclusion_violation
      return new ConflictError('This record conflicts with an existing one');
    case '23503': // foreign_key_violation
    case '23514': // check_violation
      return new BadRequestError('The request references invalid or inconsistent data');
    default:
      return null;
  }
}
