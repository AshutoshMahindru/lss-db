export type { AuditFinding } from '../registry/types';

export type Result = {
  command: string;
  startedAt: string;
  finishedAt?: string;
  actions: string[];
  errors: string[];
  notes: string[];
};

export type CommandContext = {
  uuid?: string;
  payload?: {
    uuid?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
