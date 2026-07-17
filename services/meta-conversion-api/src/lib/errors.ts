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
