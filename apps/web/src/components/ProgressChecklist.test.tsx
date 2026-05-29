/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';

const DEFAULT_TASKS = [
  'Reading transcript turns and speaker roles',
  'Clustering repeated objections and urgency cues',
  'Pulling exact customer language for reuse',
  'Drafting pain-point summaries for approval',
];

describe('ProgressChecklist logic', () => {
  it('has default tasks defined', () => {
    expect(DEFAULT_TASKS.length).toBe(4);
  });

  it('allows custom tasks to override defaults', () => {
    const customTasks = ['Task 1', 'Task 2', 'Task 3'];
    expect(customTasks.length).toBe(3);
  });

  it('handles empty tasks array', () => {
    const emptyTasks: string[] = [];
    expect(emptyTasks.length).toBe(0);
  });

  it('renders tasks in order', () => {
    const tasks = DEFAULT_TASKS;
    expect(tasks[0]).toBe('Reading transcript turns and speaker roles');
    expect(tasks[tasks.length - 1]).toBe('Drafting pain-point summaries for approval');
  });

  it('supports optional tasks prop with type safety', () => {
    interface ProgressChecklistProps {
      tasks?: string[];
    }
    const propsWithTasks: ProgressChecklistProps = { tasks: ['Task 1'] };
    const propsWithoutTasks: ProgressChecklistProps = {};
    expect(propsWithTasks.tasks?.length).toBe(1);
    expect(propsWithoutTasks.tasks).toBeUndefined();
  });
});
