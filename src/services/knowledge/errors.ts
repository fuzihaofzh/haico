import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_STATUSES } from './lifecycle';

export class KnowledgeEntryNotFoundError extends Error {
  constructor() {
    super('Knowledge entry not found');
    this.name = 'KnowledgeEntryNotFoundError';
  }
}

export class KnowledgeAgentNotFoundError extends Error {
  constructor() {
    super('Agent not found');
    this.name = 'KnowledgeAgentNotFoundError';
  }
}

export class MissingKnowledgeTitleError extends Error {
  constructor() {
    super('title is required');
    this.name = 'MissingKnowledgeTitleError';
  }
}

export class MissingKnowledgeContentError extends Error {
  constructor() {
    super('content is required');
    this.name = 'MissingKnowledgeContentError';
  }
}

export class InvalidKnowledgeImportanceError extends Error {
  constructor() {
    super('Invalid importance. Must be one of: high, medium, low');
    this.name = 'InvalidKnowledgeImportanceError';
  }
}

export class InvalidKnowledgeCategoryError extends Error {
  constructor() {
    super(`Invalid category. Must be one of: ${KNOWLEDGE_CATEGORIES.join(', ')}`);
    this.name = 'InvalidKnowledgeCategoryError';
  }
}

export class InvalidKnowledgeStatusError extends Error {
  constructor(options: { includeAll?: boolean } = {}) {
    const values = options.includeAll ? ['all', ...KNOWLEDGE_STATUSES] : KNOWLEDGE_STATUSES;
    super(`Invalid status. Must be one of: ${values.join(', ')}`);
    this.name = 'InvalidKnowledgeStatusError';
  }
}

export class InvalidKnowledgeOwnerAgentError extends Error {
  constructor() {
    super('owner_agent_id must reference an agent in this project');
    this.name = 'InvalidKnowledgeOwnerAgentError';
  }
}

export class DuplicateOwnerKnowledgeEntryError extends Error {
  constructor() {
    super('Knowledge entry for this owner already exists');
    this.name = 'DuplicateOwnerKnowledgeEntryError';
  }
}
