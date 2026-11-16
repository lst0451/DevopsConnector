export interface Connection {
  organizationUrl: string;
  project: string;
}

export interface WorkItemComment {
  id: number;
  version?: number;
  text: string;
  createdBy: string;
  createdDate: string;
  modifiedDate?: string;
  format?: string;
}

export interface WorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  comments?: WorkItemComment[];
}

export class UserError extends Error {}
