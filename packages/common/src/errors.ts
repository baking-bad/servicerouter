/**
 * Base class for every error the platform raises on purpose.
 *
 * `code` is a stable snake_case identifier. Apps map codes to HTTP statuses, and clients depend on
 * them, so a code is never renamed.
 */
export abstract class ServiceRouterError extends Error {
  override readonly name: string;
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);

    this.name = this.constructor.name;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    };
  }
}

export interface ValidationIssue {
  // JSON Pointer to the offending value, such as `/upstreams/0/baseUrl`. `` is the document root.
  readonly path: string;
  readonly message: string;
  // Where the value came from, such as a file name, when the input had several sources
  readonly source?: string;
  // 1-based position in the source document, when the input was text
  readonly line?: number;
  readonly column?: number;
}

export const formatIssue = (issue: ValidationIssue): string => {
  const location = issue.line === undefined
    ? ''
    : ` (${issue.source ? `${issue.source}:` : ''}${issue.line}:${issue.column ?? 1})`;

  return `${issue.path || '/'}: ${issue.message}${location}`;
};

export class ValidationError extends ServiceRouterError {
  readonly code = 'validation_failed';
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[] = []) {
    super(issues.length > 0
      ? issues.reduce((result, issue, index) => `${result}\n\t${index + 1}. ${formatIssue(issue)}`, message)
      : message);

    this.issues = issues;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      issues: this.issues,
    };
  }
}

export const getSafeErrorMessage = (error: unknown): string => error instanceof Error
  ? error.message
  : 'An unknown error occurred';
