import type { SourcePosition, StrictYamlDocument, ValidationIssue, ValuePath } from '@servicerouter/common';

/** An issue before it has a source position. */
export interface IssueDraft {
  readonly path: ValuePath;
  readonly message: string;
  // The issue is about the key at `path`, such as an unknown field, rather than its value
  readonly key?: boolean;
}

export interface IssueLocation {
  readonly source?: string;
  readonly position?: SourcePosition;
}

export type IssueLocator = (draft: IssueDraft) => IssueLocation;

const escapeSegment = (segment: string | number): string => String(segment).replaceAll('~', '~0').replaceAll('/', '~1');

export const toPointer = (path: ValuePath): string => path.map(segment => `/${escapeSegment(segment)}`).join('');

export const fromPointer = (pointer: string): readonly string[] => pointer === ''
  ? []
  : pointer.slice(1).split('/').map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

/**
 * Locates issues in the documents a value was merged from. A path is attributed to the last document
 * that defines it; otherwise to the nearest ancestor in the first document.
 */
export const createDocumentLocator = (documents: readonly StrictYamlDocument[]): IssueLocator => draft => {
  const document = [...documents].reverse().find(candidate => candidate.has(draft.path)) ?? documents[0];

  return document
    ? { source: document.source, position: document.locate(draft.path, { key: draft.key }) }
    : {};
};

export const toIssue = (draft: IssueDraft, locator?: IssueLocator): ValidationIssue => {
  const { source, position } = locator?.(draft) ?? {};

  return {
    path: toPointer(draft.path),
    message: draft.message,
    ...(source === undefined ? {} : { source }),
    ...(position ? { line: position.line, column: position.column } : {}),
  };
};

export const toIssues = (drafts: readonly IssueDraft[], locator?: IssueLocator): readonly ValidationIssue[] => {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const draft of drafts) {
    const issue = toIssue(draft, locator);
    const id = `${issue.path}\n${issue.message}`;
    if (seen.has(id))
      continue;
    seen.add(id);
    issues.push(issue);
  }

  // Source order when positions are known, so a reader can walk the document top to bottom
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((left, right) => (left.issue.line ?? Infinity) - (right.issue.line ?? Infinity)
      || (left.issue.column ?? 0) - (right.issue.column ?? 0)
      || left.index - right.index)
    .map(({ issue }) => issue);
};
