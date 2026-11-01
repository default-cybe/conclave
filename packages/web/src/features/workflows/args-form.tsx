/**
 * The typed half of the workflow launch form: fields from the workflow's
 * declared args (meta.args -> WorkflowSummary.argsSchema), and the args
 * object back out of them. A workflow without a schema keeps the raw JSON
 * textarea in RunSheet; extras are args a preset carries that the schema
 * does not name, merged back untouched.
 */
import type { WorkflowArgFieldDto } from '@conclave/core/client';
import { Checkbox, Field, Input } from '@/components/ui/Field';

export type ArgValues = Record<string, string | boolean>;

/** The form's values from a preset's (or any) args object; keys the schema does not name come back as extras. */
export function valuesFromArgs(schema: Record<string, WorkflowArgFieldDto>, args: unknown): { values: ArgValues; extras: Record<string, unknown> } {
  const values: ArgValues = {};
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((args ?? {}) as Record<string, unknown>)) {
    const f = schema[k];
    if (!f) {
      extras[k] = v;
      continue;
    }
    if (f.type === 'boolean') values[k] = !!v;
    else values[k] = v === null || v === undefined ? '' : String(v);
  }
  return { values, extras };
}

/** The args object to start the run with: filled fields typed, empty ones left out, extras merged. Returns an error string on a bad number, not the args. */
export function argsFromValues(schema: Record<string, WorkflowArgFieldDto>, values: ArgValues, extras: Record<string, unknown> = {}): { args?: Record<string, unknown>; error?: string } {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(schema)) {
    const v = values[k];
    // a declared boolean is always sent, false included: absent and false must not collapse
    if (f.type === 'boolean') {
      out[k] = v === true;
      continue;
    }
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) continue;
    if (f.type === 'number') {
      const n = Number(s);
      if (!Number.isFinite(n)) return { error: `${k} must be a number, like 3 or 1.5.` };
      out[k] = n;
    } else out[k] = s;
  }
  return { args: { ...extras, ...out } };
}

export function ArgsForm({
  schema,
  values,
  set,
}: {
  schema: Record<string, WorkflowArgFieldDto>;
  values: ArgValues;
  set: (name: string, v: string | boolean) => void;
}) {
  return (
    <div className="space-y-4">
      {Object.entries(schema).map(([name, f]) =>
        f.type === 'boolean' ? (
          <Field key={name} label={f.description ?? name} optional>
            <Checkbox checked={values[name] === true} onChange={(v) => set(name, v)} label={name} />
          </Field>
        ) : (
          <Field key={name} label={name} help={f.description} optional>
            <Input value={typeof values[name] === 'string' ? (values[name] as string) : ''} onChange={(e) => set(name, e.target.value)} placeholder={f.type === 'number' ? '3' : ''} />
          </Field>
        ),
      )}
    </div>
  );
}
