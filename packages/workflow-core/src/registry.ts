import type { WorkflowType } from './types';

class WorkflowTypeRegistry {
  private workflows: Map<string, WorkflowType> = new Map();

  register(workflow: WorkflowType): void {
    this.workflows.set(workflow.kind, workflow);
  }

  get(kind: string): WorkflowType | null {
    return this.workflows.get(kind) ?? null;
  }

  list(): WorkflowType[] {
    return Array.from(this.workflows.values());
  }

  isValid(kind: string): boolean {
    return this.workflows.has(kind);
  }
}

export const workflowRegistry = new WorkflowTypeRegistry();
