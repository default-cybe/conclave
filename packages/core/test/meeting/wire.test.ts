/**
 * The JSON fixtures that Track A (wire.rs) and Track C round-trip are the
 * shapes of wire.ts: every key is one the type has, every required key is
 * there, and the batch passes the hub's own check.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { segmentBatchProblem, type DesktopMeetingStatus, type Meeting, type MeetingAnswer, type MeetingNotes, type SegmentBatch } from '../../src/meeting/wire';

const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8'));

const MEETING_KEYS = ['id', 'accountId', 'sessionId', 'projectId', 'device', 'cwd', 'title', 'agenda', 'status', 'createdAt', 'startedAt', 'endedAt', 'audioClientId', 'briefMessageId', 'notesPath', 'autoAnswer', 'error'];
const MEETING_REQUIRED = ['id', 'accountId', 'sessionId', 'device', 'cwd', 'title', 'status', 'createdAt', 'autoAnswer'];
const ANSWER_KEYS = ['id', 'meetingId', 'messageId', 'trigger', 'question', 'state', 'createdAt', 'firstTokenAt', 'error'];
const SEGMENT_KEYS = ['seq', 'channel', 'startMs', 'endMs', 'text', 'final'];

function shape(obj: Record<string, unknown>, keys: string[], required: string[] = []) {
  for (const k of Object.keys(obj)) expect(keys).toContain(k);
  for (const k of required) expect(obj[k]).toBeDefined();
}

describe('wire fixtures', () => {
  test('meeting', () => {
    const m = fx('meeting.json') as Meeting;
    shape(m as never, MEETING_KEYS, MEETING_REQUIRED);
    expect(['preparing', 'ready', 'live', 'paused', 'ending', 'ended', 'failed']).toContain(m.status);
  });

  test('create input', () => {
    shape(fx('create-meeting-input.json'), ['sessionId', 'projectId', 'device', 'cwd', 'title', 'agenda']);
  });

  test('segment batch passes the hub check, and broken ones do not', () => {
    const b = fx('segment-batch.json') as SegmentBatch;
    expect(segmentBatchProblem(b)).toBeUndefined();
    for (const s of b.segments) shape(s as never, SEGMENT_KEYS, SEGMENT_KEYS);
    expect(segmentBatchProblem({ ...b, segments: [] })).toContain('1 to 32');
    expect(segmentBatchProblem({ ...b, segments: Array(33).fill(b.segments[0]) })).toContain('1 to 32');
    expect(segmentBatchProblem({ ...b, clientId: '' })).toContain('clientId');
    expect(segmentBatchProblem({ ...b, segments: [{ ...b.segments[0], channel: 'both' }] })).toContain('channel');
    expect(segmentBatchProblem({ ...b, segments: [{ ...b.segments[0], seq: -1 }] })).toContain('seq');
    expect(segmentBatchProblem({ ...b, segments: [{ ...b.segments[0], seq: 1.5 }] })).toContain('seq');
    expect(segmentBatchProblem({ ...b, segments: [{ ...b.segments[0], text: 'x'.repeat(2001) }] })).toContain('2000');
    expect(segmentBatchProblem({ ...b, segments: [{ ...b.segments[0], startMs: 5, endMs: 4 }] })).toContain('startMs');
    expect(segmentBatchProblem({ ...b, segments: [{ ...b.segments[0], final: 'yes' }] })).toContain('final');
    expect(segmentBatchProblem([])).toBeDefined();
  });

  test('ack', () => {
    const a = fx('segment-ack.json');
    shape(a, ['accepted', 'lastSeq'], ['accepted', 'lastSeq']);
    expect(Object.keys(a.lastSeq).sort()).toEqual(['me', 'them']);
  });

  test('answer now', () => {
    shape(fx('answer-now-input.json'), ['reason', 'question'], ['reason']);
  });

  test('answer and detail', () => {
    const a = fx('meeting-answer.json') as MeetingAnswer;
    shape(a as never, ANSWER_KEYS, ['id', 'meetingId', 'messageId', 'trigger', 'question', 'state', 'createdAt']);
    const d = fx('meeting-detail.json');
    shape(d, [...MEETING_KEYS, 'segments', 'answers'], [...MEETING_REQUIRED, 'segments', 'answers']);
    for (const s of d.segments) shape(s, SEGMENT_KEYS, SEGMENT_KEYS);
    for (const x of d.answers) shape(x, ANSWER_KEYS);
  });

  test('notes', () => {
    const n = fx('meeting-notes.json') as MeetingNotes;
    shape(n as never, ['summary', 'decisions', 'actionItems', 'openQuestions', 'markdown'], ['summary', 'decisions', 'actionItems', 'openQuestions', 'markdown']);
    for (const i of n.actionItems) shape(i as never, ['who', 'what', 'due', 'taskId'], ['who', 'what']);
  });

  test('desktop status', () => {
    const s = fx('desktop-meeting-status.json') as DesktopMeetingStatus;
    shape(s as never, ['meetingId', 'live', 'paused', 'clickThrough', 'hiddenForShare', 'exclusion', 'mic', 'system', 'stt', 'queue'], ['live', 'paused', 'clickThrough', 'hiddenForShare', 'exclusion', 'mic', 'system', 'stt', 'queue']);
  });

  test('events', () => {
    const evs = fx('events.json') as Array<Record<string, any>>;
    expect(evs.map((e) => e.type)).toEqual(['meeting.updated', 'meeting.segment', 'meeting.answer', 'meeting.notes']);
    for (const e of evs) expect(typeof e.sessionId).toBe('string');
  });
});
