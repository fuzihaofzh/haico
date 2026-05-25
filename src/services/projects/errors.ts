import { ToolReadinessSummary } from '../tool-readiness';

export class MissingProjectTaskDescriptionError extends Error {
  constructor() {
    super('task_description is required');
    this.name = 'MissingProjectTaskDescriptionError';
  }
}

export class InvalidProjectOrchestratorEngineError extends Error {
  constructor() {
    super('Invalid orchestrator_engine. Use native or langgraph.');
    this.name = 'InvalidProjectOrchestratorEngineError';
  }
}

export class ProjectCommandProfileNotFoundError extends Error {
  constructor() {
    super('Command profile not found');
    this.name = 'ProjectCommandProfileNotFoundError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super('Project not found');
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectDeleteForbiddenError extends Error {
  constructor() {
    super('Only project owners or admins can delete projects');
    this.name = 'ProjectDeleteForbiddenError';
  }
}

export class ProjectDeleteBlockedError extends Error {
  constructor() {
    super('Project could not be deleted because related records still block deletion. Please restart the server to apply database migrations and retry.');
    this.name = 'ProjectDeleteBlockedError';
  }
}

export class ProjectMemberIdentityRequiredError extends Error {
  constructor() {
    super('user_id or username is required');
    this.name = 'ProjectMemberIdentityRequiredError';
  }
}

export class InvalidProjectMemberRoleError extends Error {
  constructor() {
    super('role must be one of: member, editor, owner');
    this.name = 'InvalidProjectMemberRoleError';
  }
}

export class ProjectUserNotFoundError extends Error {
  constructor() {
    super('User not found');
    this.name = 'ProjectUserNotFoundError';
  }
}

export class ProjectOwnerAlreadyHasAccessError extends Error {
  constructor() {
    super('Project owner already has access');
    this.name = 'ProjectOwnerAlreadyHasAccessError';
  }
}

export class ProjectOwnerMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectOwnerMutationError';
  }
}

export class ProjectMemberNotFoundError extends Error {
  constructor() {
    super('Project member not found');
    this.name = 'ProjectMemberNotFoundError';
  }
}

export class MissingProjectMetadataDescriptionError extends Error {
  constructor() {
    super('description is required');
    this.name = 'MissingProjectMetadataDescriptionError';
  }
}

export class ProjectMetadataInvalidResponseError extends Error {
  constructor(readonly raw: string) {
    super('AI did not return valid JSON');
    this.name = 'ProjectMetadataInvalidResponseError';
  }
}

export class ProjectMetadataToolError extends Error {
  constructor(
    message: string,
    readonly errorCode: 'missing_cli' | 'auth_required' | 'timeout' | 'execution_failed',
    readonly readiness: ToolReadinessSummary,
    readonly actionCommand: string | null = null
  ) {
    super(message);
    this.name = 'ProjectMetadataToolError';
  }
}
