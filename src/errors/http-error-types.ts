export interface HttpErrorMapping {
  statusCode: number;
  message: string;
  extra?: Record<string, unknown>;
}

export type ErrorConstructor<T extends Error = Error> = new (...args: any[]) => T;

export type ErrorHttpResolver<T extends Error = any> =
  | number
  | ((error: T) => HttpErrorMapping);

export type ErrorHttpEntry<T extends Error = any> = readonly [
  ErrorConstructor<T>,
  ErrorHttpResolver<T>,
];
