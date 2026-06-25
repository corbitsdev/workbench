/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { deriveBranding } from './app-env';

describe('deriveBranding', () => {
  it('returns the neutral base with brand attribution when the environment is unset', () => {
    expect(deriveBranding(undefined)).toEqual({
      env: null,
      label: null,
      title: 'Workbench | Corbits',
    });
  });

  it('does not decorate an unknown environment value', () => {
    expect(deriveBranding('preview')).toEqual({
      env: null,
      label: null,
      title: 'Workbench | Corbits',
    });
  });

  it('leaves production label-free but keeps brand attribution', () => {
    expect(deriveBranding('production')).toEqual({
      env: 'production',
      label: null,
      title: 'Workbench | Corbits',
    });
  });

  it('labels staging in the title and nav', () => {
    expect(deriveBranding('staging')).toEqual({
      env: 'staging',
      label: 'Staging',
      title: 'Workbench Staging | Corbits',
    });
  });

  it('labels spike in the title and nav', () => {
    expect(deriveBranding('spike')).toEqual({
      env: 'spike',
      label: 'Spike',
      title: 'Workbench Spike | Corbits',
    });
  });
});
