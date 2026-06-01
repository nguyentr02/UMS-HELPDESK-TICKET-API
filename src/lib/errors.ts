/** Base class for every controlled error the API surfaces. Carries an HTTP
 *  status, a stable `code` for clients to switch on, and an optional `fields`
 *  map for per-field validation errors. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (fields) this.fields = fields;
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Yêu cầu xác thực') {
    super(401, 'unauthenticated', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Không có quyền truy cập') {
    super(403, 'forbidden', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Không tìm thấy') {
    super(404, 'not_found', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Xung đột trạng thái') {
    super(409, 'conflict', message);
  }
}

export class ValidationError extends AppError {
  constructor(fields: Record<string, string>, message = 'Dữ liệu không hợp lệ') {
    super(422, 'validation_error', message, fields);
  }
}
