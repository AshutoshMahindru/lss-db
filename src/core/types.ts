export type { AuditFinding } from '../registry/types';

export type Result = {
  command: string;
  startedAt: string;
  finishedAt?: string;
  actions: string[];
  errors: string[];
  notes: string[];
};