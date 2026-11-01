/**
 * OTLP/HTTP JSON metrics ingest for Claude Code telemetry:
 *
 *   CLAUDE_CODE_ENABLE_TELEMETRY=1
 *   OTEL_METRICS_EXPORTER=otlp
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/json
 *   OTEL_EXPORTER_OTLP_ENDPOINT=<hub>
 *   OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer cgw_..."
 *
 * claude_code.token.usage (type: input/output/cacheRead/cacheCreation) and
 * claude_code.cost.usage become usage records with source "claude-code-otel".
 * Delta temporality is the Claude Code default; cumulative series are turned
 * into deltas against the last value seen in this process.
 */
import type { UsageRecord } from '@conclave/core/types.ts';
import { newId } from '@conclave/core/util/ids.ts';

export const OTEL_SOURCE = 'claude-code-otel';

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
type KeyValue = { key: string; value?: AnyValue };
interface DataPoint {
  attributes?: KeyValue[];
  startTimeUnixNano?: string | number;
  timeUnixNano?: string | number;
  asInt?: string | number;
  asDouble?: number;
}
interface Metric {
  name?: string;
  sum?: { dataPoints?: DataPoint[]; aggregationTemporality?: number | string };
  gauge?: { dataPoints?: DataPoint[] };
}

const CUMULATIVE = 2;

function attrs(list: KeyValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of list ?? []) {
    const v = kv.value;
    if (!v) continue;
    const s = v.stringValue ?? (v.intValue !== undefined ? String(v.intValue) : v.doubleValue !== undefined ? String(v.doubleValue) : v.boolValue !== undefined ? String(v.boolValue) : undefined);
    if (s !== undefined) out[kv.key] = s;
  }
  return out;
}

function pointValue(p: DataPoint): number {
  const v = p.asDouble ?? (p.asInt !== undefined ? Number(p.asInt) : 0);
  return Number.isFinite(v) ? v : 0;
}

function nanosToMs(n: string | number | undefined): number {
  if (n === undefined) return Date.now();
  let v = 0;
  try {
    v = typeof n === 'string' ? Number(BigInt(n) / 1_000_000n) : Math.floor(n / 1e6);
  } catch {
    v = 0;
  }
  return v > 0 ? v : Date.now();
}

function temporality(t: number | string | undefined): number {
  if (t === 'AGGREGATION_TEMPORALITY_CUMULATIVE') return CUMULATIVE;
  return typeof t === 'number' ? t : 1;
}

interface Pending {
  record: UsageRecord;
  extKey: string;
}

/**
 * Converts OTLP metric exports into usage records. Keeps cumulative state, so
 * use one instance per process.
 */
export class OtlpIngest {
  private last = new Map<string, { start: string; value: number }>();

  /** Parse an ExportMetricsServiceRequest. Returns records and their dedupe keys. */
  convert(body: unknown): Pending[] {
    const groups = new Map<string, Pending>();
    const rms = (body as { resourceMetrics?: unknown[] })?.resourceMetrics;
    if (!Array.isArray(rms)) return [];
    for (const rm of rms as Array<{ resource?: { attributes?: KeyValue[] }; scopeMetrics?: Array<{ metrics?: Metric[] }> }>) {
      const res = attrs(rm.resource?.attributes);
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          if (m.name !== 'claude_code.token.usage' && m.name !== 'claude_code.cost.usage') continue;
          const cumulative = temporality(m.sum?.aggregationTemporality) === CUMULATIVE;
          for (const p of m.sum?.dataPoints ?? m.gauge?.dataPoints ?? []) {
            const a = { ...res, ...attrs(p.attributes) };
            const model = a.model || 'unknown';
            const session = a['session.id'] ?? '';
            const kind = m.name === 'claude_code.cost.usage' ? 'cost' : a.type || 'input';
            let value = pointValue(p);
            if (cumulative) {
              const series = `${session}|${model}|${kind}|${a['user.id'] ?? ''}`;
              const start = String(p.startTimeUnixNano ?? '');
              const prev = this.last.get(series);
              this.last.set(series, { start, value });
              if (prev && prev.start === start) value = Math.max(0, value - prev.value);
            }
            if (!value) continue;
            const tsMs = nanosToMs(p.timeUnixNano);
            const extKey = `${session}|${model}|${p.timeUnixNano ?? tsMs}`;
            let g = groups.get(extKey);
            if (!g) {
              g = {
                extKey,
                record: {
                  id: newId('use'),
                  ts: tsMs,
                  source: OTEL_SOURCE,
                  provider: 'anthropic',
                  model,
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  reasoningTokens: 0,
                  costUsd: 0,
                  purpose: a['query_source'] || 'claude-code',
                },
              };
              groups.set(extKey, g);
            }
            const r = g.record;
            switch (kind) {
              case 'input':
                r.inputTokens += Math.round(value);
                break;
              case 'output':
                r.outputTokens += Math.round(value);
                break;
              case 'cacheRead':
                r.cacheReadTokens += Math.round(value);
                break;
              case 'cacheCreation':
                r.cacheWriteTokens += Math.round(value);
                break;
              case 'cost':
                r.costUsd += value;
                break;
            }
          }
        }
      }
    }
    if (this.last.size > 50_000) this.last.clear();
    return [...groups.values()];
  }
}
