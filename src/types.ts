export interface Connection {
  organizationUrl: string;
  project: string;
}

export interface WorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
}

export class UserError extends Error {}
