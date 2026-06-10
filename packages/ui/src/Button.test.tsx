import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Button, buttonVariants } from './Button';

afterEach(cleanup);

describe('buttonVariants', () => {
  it('applies primary defaults when no variant or size is given', () => {
    const classes = buttonVariants({});
    expect(classes).toContain('bg-orange');
    expect(classes).toContain('text-base');
  });

  it('selects the secondary variant classes', () => {
    const classes = buttonVariants({ variant: 'secondary' });
    expect(classes).toContain('bg-surface-2');
    expect(classes).toContain('border-border');
  });

  it('selects the ghost variant and small size classes', () => {
    const classes = buttonVariants({ variant: 'ghost', size: 'sm' });
    expect(classes).toContain('hover:bg-surface-2');
    expect(classes).toContain('text-sm');
  });

  it('selects the large size classes', () => {
    expect(buttonVariants({ size: 'lg' })).toContain('text-lg');
  });
});

describe('Button', () => {
  it('forwards clicks and arbitrary button props', () => {
    let clicked = 0;
    render(
      <Button type="submit" onClick={() => (clicked += 1)}>
        Go
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button.getAttribute('type')).toBe('submit');
    fireEvent.click(button);
    expect(clicked).toBe(1);
  });

  it('merges a caller className with the variant classes', () => {
    render(<Button className="custom-class">X</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('custom-class');
    expect(button.className).toContain('bg-orange');
  });

  it('honors the disabled attribute', () => {
    render(<Button disabled>Nope</Button>);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
