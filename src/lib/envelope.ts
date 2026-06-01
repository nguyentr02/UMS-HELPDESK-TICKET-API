import { randomUUID } from 'node:crypto';

export interface EnvelopeError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export interface Envelope<T> {
  data: T | null;
  error: EnvelopeError | null;
  requestId: string;
}

export function ok<T>(data: T, requestId: string): Envelope<T> {
  return { data, error: null, requestId };
}

export function fail(error: EnvelopeError, requestId: string): Envelope<null> {
  return { data: null, error, requestId };
}

/** Fresh request ID, used when the incoming request didn't supply one. */
export function newRequestId(): string {
  return randomUUID();
}
