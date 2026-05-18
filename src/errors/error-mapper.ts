import { agentMessageErrorHttpEntries } from './http-error-tables/agent-messages';
import { agentErrorHttpEntries } from './http-error-tables/agents';
import { approvalErrorHttpEntries } from './http-error-tables/approvals';
import { authErrorHttpEntries } from './http-error-tables/auth';
import { executiveSummaryErrorHttpEntries } from './http-error-tables/executive-summaries';
import { issueErrorHttpEntries } from './http-error-tables/issues';
import { knowledgeErrorHttpEntries } from './http-error-tables/knowledge';
import { paymentApprovalErrorHttpEntries } from './http-error-tables/payment-approvals';
import { projectAccessErrorHttpEntries } from './http-error-tables/project-access';
import { projectErrorHttpEntries } from './http-error-tables/projects';
import type {
  ErrorConstructor,
  ErrorHttpEntry,
  ErrorHttpResolver,
  HttpErrorMapping,
} from './http-error-types';

export type { HttpErrorMapping } from './http-error-types';

const errorHttpEntries = [
  ...authErrorHttpEntries,
  ...knowledgeErrorHttpEntries,
  ...agentMessageErrorHttpEntries,
  ...projectAccessErrorHttpEntries,
  ...projectErrorHttpEntries,
  ...issueErrorHttpEntries,
  ...agentErrorHttpEntries,
  ...approvalErrorHttpEntries,
  ...paymentApprovalErrorHttpEntries,
  ...executiveSummaryErrorHttpEntries,
] satisfies readonly ErrorHttpEntry[];

const errorHttpMap = createErrorHttpMap(errorHttpEntries);

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || 'Internal server error');
}

function createErrorHttpMap(
  entries: readonly ErrorHttpEntry[]
): Map<ErrorConstructor, ErrorHttpResolver> {
  const map = new Map<ErrorConstructor, ErrorHttpResolver>();

  for (const [errorType, resolver] of entries) {
    if (map.has(errorType)) {
      const errorName = (errorType as { name?: string }).name || 'unknown error';
      throw new Error(`Duplicate HTTP error mapping for ${errorName}`);
    }
    map.set(errorType, resolver);
  }

  return map;
}

function resolveHttpMapping(resolver: ErrorHttpResolver, error: Error): HttpErrorMapping {
  if (typeof resolver === 'number') {
    return { statusCode: resolver, message: error.message };
  }
  return resolver(error);
}

function mapRegisteredError(error: unknown): HttpErrorMapping | null {
  if (!(error instanceof Error)) return null;

  const resolver = errorHttpMap.get(error.constructor as ErrorConstructor);
  if (resolver === undefined) return null;

  return resolveHttpMapping(resolver, error);
}

function mapFrameworkError(error: unknown): HttpErrorMapping | null {
  if (!error || typeof error !== 'object') return null;
  const statusCode = (error as { statusCode?: unknown; status?: unknown }).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600) {
    return { statusCode, message: getErrorMessage(error) };
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return { statusCode: status, message: getErrorMessage(error) };
  }
  return null;
}

export function mapErrorToHttp(error: unknown): HttpErrorMapping | null {
  return mapRegisteredError(error) || mapFrameworkError(error);
}

export function getUnexpectedErrorMessage(error: unknown): string {
  return getErrorMessage(error);
}
