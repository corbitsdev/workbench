import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { Step, StepDescription, StepIndicator, StepLabel, StepTitle, Steps } from './steps';

afterEach(cleanup);

describe('Steps', () => {
  it('uses horizontal gap classes by default', () => {
    const { container } = render(<Steps />);
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain('gap-2');
    expect(div.className).not.toContain('flex-col');
  });

  it('switches to vertical layout when orientation is vertical', () => {
    const { container } = render(<Steps orientation="vertical" />);
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain('flex-col');
    expect(div.className).toContain('gap-4');
  });
});

describe('StepIndicator', () => {
  it('renders a checkmark and green styling when complete', () => {
    const { container } = render(<StepIndicator status="complete" index={0} />);
    const div = container.firstChild as HTMLElement;
    expect(div.textContent).toBe('✓');
    expect(div.className).toContain('bg-green');
  });

  it('renders the 1-based index for an active step', () => {
    const { container } = render(<StepIndicator status="active" index={2} />);
    const div = container.firstChild as HTMLElement;
    expect(div.textContent).toBe('3');
    expect(div.className).toContain('border-orange');
  });

  it('renders empty content for an incomplete step without an index', () => {
    const { container } = render(<StepIndicator status="incomplete" />);
    const div = container.firstChild as HTMLElement;
    expect(div.textContent).toBe('');
    expect(div.className).toContain('border-border');
  });
});

describe('step text components', () => {
  it('renders Step, StepLabel, StepTitle and StepDescription with their tags', () => {
    const { container } = render(
      <Step>
        <StepLabel>
          <StepTitle>Title</StepTitle>
          <StepDescription>Desc</StepDescription>
        </StepLabel>
      </Step>
    );
    expect(container.querySelector('h3')?.textContent).toBe('Title');
    expect(container.querySelector('p')?.textContent).toBe('Desc');
  });
});
