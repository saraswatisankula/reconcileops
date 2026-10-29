import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { IssueList, Badge, ErrorBox } from './ui.jsx';
import MetricStrip from './MetricStrip.jsx';
import SignalTrack from './SignalTrack.jsx';
import { qs } from '../api.js';
import { ms } from '../format.js';

describe('IssueList', () => {
  it('lists errors before warnings', () => {
    render(<IssueList issues={[
      { rule: 'blocking-index', severity: 'warning', message: 'slow index' },
      { rule: 'rename-column', severity: 'error', message: 'breaks app v1', suggestion: 'use expand/contract' },
    ]} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('breaks app v1');
    expect(items[0]).toHaveTextContent('use expand/contract');
    expect(items[1]).toHaveTextContent('slow index');
  });

  it('says so when there is nothing to report', () => {
    render(<IssueList issues={[]} />);
    expect(screen.getByText('No issues found.')).toBeInTheDocument();
  });
});

describe('Badge and ErrorBox', () => {
  it('uses readable status labels', () => {
    render(<Badge status="rolled_back" />);
    expect(screen.getByText('Rolled back')).toBeInTheDocument();
  });

  it('shows the reasons a run was blocked', () => {
    const err = Object.assign(new Error('Migration blocked'), { reasons: ['Earlier version(s) not applied: V2'] });
    render(<ErrorBox error={err} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Earlier version(s) not applied: V2');
  });
});

describe('MetricStrip', () => {
  it('renders values from the summary', () => {
    render(<MetricStrip s={{
      success_rate: 80, success: 4, failed: 1, rolled_back: 0, total_downtime_ms: 1500, probe_failed: 3,
      probe_total: 40, rollbacks: 0, avg_rollback_ms: 0, compatibility_issues: 2, validations_rejected: 1, manual: 0,
    }} />);
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('1.50 s')).toBeInTheDocument();
    expect(screen.getByText('4 of 5 finished runs')).toBeInTheDocument();
  });
});

describe('SignalTrack', () => {
  it('labels each lamp with its state', () => {
    render(
      <MemoryRouter>
        <SignalTrack rows={[{
          id: 1, name: 'Order Service', environments: [
            { name: 'development', checked: true, passed: true, failing: [], version: 3 },
            { name: 'staging', checked: true, passed: false, failing: ['compat_probe:v1.0:orders'], version: 2 },
            { name: 'production', checked: false, passed: null, failing: [], version: 0 },
          ],
        }]} />
      </MemoryRouter>
    );
    expect(screen.getByLabelText('development: healthy')).toBeInTheDocument();
    expect(screen.getByLabelText('staging: compat_probe:v1.0:orders')).toBeInTheDocument();
    expect(screen.getByLabelText('production: not checked yet')).toBeInTheDocument();
  });
});

describe('helpers', () => {
  it('builds query strings without empty values', () => {
    expect(qs({ projectId: 2, environment: '', status: 'failed' })).toBe('?projectId=2&status=failed');
    expect(qs({})).toBe('');
  });
  it('formats durations', () => {
    expect(ms(12)).toBe('12 ms');
    expect(ms(null)).toBe('–');
  });
});
