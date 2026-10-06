'use client';

import { useState } from 'react';

import { shortDate } from '../../../format';
import { displayUsd } from '../../../money';
import { emptyKeyForm, keyFormOf, toKeyLimits, type KeyFormValues } from '../keyForm';
import type { CreatedKey, PaymentKey } from '../../types';
import { useConsole, useConsoleData } from '../ConsoleRoot';
import { ConfirmButton, ConsoleHeading, ErrorNotice, ShownOnce } from '../parts';

const KeyForm = ({ initial, submitLabel, onSubmit, onCancel }: {
  readonly initial: KeyFormValues;
  readonly submitLabel: string;
  readonly onSubmit: (values: KeyFormValues) => Promise<string | undefined>;
  readonly onCancel?: () => void;
}) => {
  const [values, setValues] = useState(initial);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const field = (name: keyof KeyFormValues, label: string, placeholder: string, type = 'text') => (
    <label className="stack field">
      <span className="label">{label}</span>
      <input className="input" type={type} placeholder={placeholder} value={values[name]} onChange={event => setValues({ ...values, [name]: event.target.value })} />
    </label>
  );

  return (
    <form
      className="stack"
      onSubmit={async event => {
        event.preventDefault();
        setBusy(true);
        setProblem(await onSubmit(values));
        setBusy(false);
      }}
    >
      <div className="key-form">
        {field('label', 'Label', 'research-agent')}
        {field('dailyBudget', 'Daily budget, USD', '5')}
        {field('allowance', 'Allowance in total, USD', 'No limit')}
        {field('maxPrice', 'Maximum price per call, USD', 'No limit')}
        {field('expires', 'Expires', 'Never', 'date')}
      </div>
      {problem ? <p className="notice notice-danger" role="alert">{problem}</p> : null}
      <div className="row">
        <button type="submit" className="button button-primary" disabled={busy}>{submitLabel}</button>
        {onCancel ? <button type="button" className="button" onClick={onCancel}>Cancel</button> : null}
      </div>
    </form>
  );
};

const limitText = (key: PaymentKey) => [
  `${displayUsd(key.dailyBudget)} a day`,
  key.allowance ? `${displayUsd(key.allowance)} in total` : undefined,
  key.maxPrice ? `up to ${displayUsd(key.maxPrice)} a call` : undefined,
  key.expiresAt ? `until ${shortDate(key.expiresAt)}` : undefined,
].filter(Boolean).join(' · ');

/** `/console/keys`: payment keys and their limits (AK-6): create, change, and revoke. */
export const KeysPage = () => {
  const { api } = useConsole();
  const { data, error, reload } = useConsoleData(consoleApi => consoleApi.keys());
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<CreatedKey | undefined>(undefined);
  const [actionError, setActionError] = useState<Error | undefined>(undefined);
  const run = async <TResult,>(action: () => Promise<TResult>): Promise<TResult | undefined> => {
    setActionError(undefined);
    try {
      return await action();
    }
    catch (caught) {
      setActionError(caught instanceof Error ? caught : new Error(String(caught)));
      return undefined;
    }
  };
  const active = data?.filter(key => key.revokedAt === null) ?? [];
  const revoked = data?.filter(key => key.revokedAt !== null) ?? [];

  return (
    <>
      <ConsoleHeading title="Payment keys">
        {creating || created ? null : <button type="button" className="button button-primary" onClick={() => setCreating(true)}>New payment key</button>}
      </ConsoleHeading>
      <p className="muted">Give each agent its own payment key, with limits you choose. Payment keys only pay for calls: they can&apos;t change your account. Keep the master key to yourself.</p>
      <ErrorNotice error={error ?? actionError} />
      {created
        ? (
          <section className="section">
            <ShownOnce
              title={`Payment key${created.label ? ` "${created.label}"` : ''}`}
              value={created.key}
              warning="It is shown only now. Store it where your agent reads its secrets, such as an environment variable."
              onDone={() => setCreated(undefined)}
            />
          </section>
        )
        : null}
      {creating
        ? (
          <section className="section card">
            <h3>New payment key</h3>
            <KeyForm
              initial={emptyKeyForm}
              submitLabel="Create the key"
              onCancel={() => setCreating(false)}
              onSubmit={async values => {
                const checked = toKeyLimits(values, 'create', new Date());
                if ('problem' in checked)
                  return checked.problem;
                const key = await run(() => api!.createKey(checked.limits));
                if (key) {
                  setCreated(key);
                  setCreating(false);
                  reload();
                }

                return undefined;
              }}
            />
          </section>
        )
        : null}
      <section className="section stack">
        {data === undefined && !error ? <p className="faint">Loading…</p> : null}
        {data && active.length === 0 ? <div className="card muted">No active payment key. Create one for each agent.</div> : null}
        {active.map(key => (
          <div key={key.id} className="card stack" data-key={key.id}>
            <div className="row spread">
              <div className="stack tight">
                <h3>{key.label ?? 'Unlabeled key'}</h3>
                <span className="muted">{limitText(key)}</span>
              </div>
              <div className="row">
                <button type="button" className="button button-small" onClick={() => setEditing(editing === key.id ? undefined : key.id)}>Change limits</button>
                <ConfirmButton
                  label="Revoke"
                  confirm="Revoke for good"
                  onConfirm={async () => {
                    await run(() => api!.revokeKey(key.id));
                    reload();
                  }}
                />
              </div>
            </div>
            <div className="metrics num">
              <span><b>{displayUsd(key.spent.today)}</b> spent today, <b>{displayUsd(key.remaining.dailyBudget)}</b> left</span>
              <span><b>{displayUsd(key.spent.total)}</b> spent in total{key.remaining.allowance ? <>, <b>{displayUsd(key.remaining.allowance)}</b> left</> : null}</span>
              <span className="faint">Created {shortDate(key.createdAt)}</span>
            </div>
            {editing === key.id
              ? (
                <KeyForm
                  initial={keyFormOf(key)}
                  submitLabel="Save the limits"
                  onCancel={() => setEditing(undefined)}
                  onSubmit={async values => {
                    const checked = toKeyLimits(values, 'change', new Date());
                    if ('problem' in checked)
                      return checked.problem;
                    if (await run(() => api!.updateKey(key.id, checked.limits))) {
                      setEditing(undefined);
                      reload();
                    }

                    return undefined;
                  }}
                />
              )
              : null}
          </div>
        ))}
      </section>
      {revoked.length > 0
        ? (
          <section className="section">
            <h2>Revoked</h2>
            <div className="table-wrap mt-8">
              <table className="table">
                <thead><tr><th>Label</th><th>Revoked</th><th className="num">Spent in total</th></tr></thead>
                <tbody>{revoked.map(key => <tr key={key.id}><td>{key.label ?? 'Unlabeled key'}</td><td>{shortDate(key.revokedAt!)}</td><td className="num">{displayUsd(key.spent.total)}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
        )
        : null}
    </>
  );
};
