import { EXECUTIVE_SUMMARY_STATUSES } from './templates';

export class MissingExecutiveSummaryCreateFieldsError extends Error {
  constructor() {
    super('title, period_start, and period_end are required');
    this.name = 'MissingExecutiveSummaryCreateFieldsError';
  }
}

export class InvalidExecutiveSummaryStatusError extends Error {
  constructor() {
    super(`status must be one of: ${EXECUTIVE_SUMMARY_STATUSES.join(', ')}`);
    this.name = 'InvalidExecutiveSummaryStatusError';
  }
}

export class NoValidExecutiveSummaryUpdateFieldsError extends Error {
  constructor() {
    super('No valid fields to update');
    this.name = 'NoValidExecutiveSummaryUpdateFieldsError';
  }
}

export class ExecutiveSummaryNotFoundError extends Error {
  constructor() {
    super('Executive summary not found');
    this.name = 'ExecutiveSummaryNotFoundError';
  }
}

export class ExecutiveSummaryBlockNotFoundError extends Error {
  constructor() {
    super('Block not found');
    this.name = 'ExecutiveSummaryBlockNotFoundError';
  }
}

export class MissingExecutiveSummaryBlockCreateFieldsError extends Error {
  constructor() {
    super('key and title are required');
    this.name = 'MissingExecutiveSummaryBlockCreateFieldsError';
  }
}

export class DuplicateExecutiveSummaryBlockKeyError extends Error {
  constructor() {
    super('Block key already exists for this summary');
    this.name = 'DuplicateExecutiveSummaryBlockKeyError';
  }
}

export class ExecutiveSummaryAlreadyFinalizedError extends Error {
  constructor() {
    super('Summary is already finalized');
    this.name = 'ExecutiveSummaryAlreadyFinalizedError';
  }
}

export class ExecutiveSummaryArchivedFinalizeError extends Error {
  constructor() {
    super('Cannot finalize an archived summary');
    this.name = 'ExecutiveSummaryArchivedFinalizeError';
  }
}
