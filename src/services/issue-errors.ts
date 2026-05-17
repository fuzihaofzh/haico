export class MissingIssueCreateFieldsError extends Error {
  constructor() {
    super('title and created_by are required');
    this.name = 'MissingIssueCreateFieldsError';
  }
}

export class IssueNotFoundError extends Error {
  constructor() {
    super('Issue not found');
    this.name = 'IssueNotFoundError';
  }
}

export class IssueParentNotFoundError extends Error {
  constructor() {
    super('Parent issue not found');
    this.name = 'IssueParentNotFoundError';
  }
}

export class IssueParentProjectMismatchError extends Error {
  constructor() {
    super('Parent issue must be in the same project');
    this.name = 'IssueParentProjectMismatchError';
  }
}

export class InvalidIssueStatusError extends Error {
  constructor() {
    super('Invalid status');
    this.name = 'InvalidIssueStatusError';
  }
}

export class IssueDeleteStatusConflictError extends Error {
  constructor() {
    super('Only open issues can be deleted');
    this.name = 'IssueDeleteStatusConflictError';
  }
}

export class IssueHasChildrenDeleteConflictError extends Error {
  constructor(childCount: number) {
    super(`Cannot delete: issue has ${childCount} child issue(s)`);
    this.name = 'IssueHasChildrenDeleteConflictError';
  }
}

export class MissingIssueCommentFieldsError extends Error {
  constructor() {
    super('author_id and body are required');
    this.name = 'MissingIssueCommentFieldsError';
  }
}

export class IssueCommentNotFoundError extends Error {
  constructor() {
    super('Comment not found');
    this.name = 'IssueCommentNotFoundError';
  }
}

export class InvalidReactionTargetTypeError extends Error {
  constructor() {
    super('Invalid reaction target type');
    this.name = 'InvalidReactionTargetTypeError';
  }
}

export class MissingReactionFieldsError extends Error {
  constructor() {
    super('user_id and emoji required');
    this.name = 'MissingReactionFieldsError';
  }
}

export class MissingMilestoneTitleError extends Error {
  constructor() {
    super('title required');
    this.name = 'MissingMilestoneTitleError';
  }
}

export class MilestoneNotFoundError extends Error {
  constructor() {
    super('Milestone not found');
    this.name = 'MilestoneNotFoundError';
  }
}

export class MissingIssueRelationFieldsError extends Error {
  constructor() {
    super('type and target_issue_id are required');
    this.name = 'MissingIssueRelationFieldsError';
  }
}

export class InvalidIssueRelationTypeError extends Error {
  constructor() {
    super('type must be blocks or related_to');
    this.name = 'InvalidIssueRelationTypeError';
  }
}

export class SelfIssueRelationError extends Error {
  constructor() {
    super('Cannot create relation to self');
    this.name = 'SelfIssueRelationError';
  }
}

export class SourceIssueNotFoundError extends Error {
  constructor() {
    super('Source issue not found');
    this.name = 'SourceIssueNotFoundError';
  }
}

export class TargetIssueNotFoundError extends Error {
  constructor() {
    super('Target issue not found');
    this.name = 'TargetIssueNotFoundError';
  }
}

export class TargetIssueProjectMismatchError extends Error {
  constructor() {
    super('Target issue must belong to the same project');
    this.name = 'TargetIssueProjectMismatchError';
  }
}

export class IssueRelationAlreadyExistsError extends Error {
  constructor() {
    super('Relation already exists');
    this.name = 'IssueRelationAlreadyExistsError';
  }
}

export class IssueRelationNotFoundError extends Error {
  constructor() {
    super('Relation not found');
    this.name = 'IssueRelationNotFoundError';
  }
}
