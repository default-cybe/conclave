/**
 * The component and message of each event line, in one place, so the lines
 * the hub writes and the counts the reader makes of them agree. Each value
 * is "<component> <msg>".
 */
export const EV = {
  hubStarted: 'hub hub started',
  hubStopped: 'hub hub stopped',
  crash: 'hub unhandled error',
  debugOn: 'logs debug on',
  debugOff: 'logs debug off',
  turn: 'session turn',
  sessionCreated: 'session session created',
  tool: 'tool tool call',
  approvalAsked: 'approval approval asked',
  approvalAnswered: 'approval approval answered',
  questionAsked: 'approval question asked',
  questionAnswered: 'approval question answered',
  routineRun: 'routine routine run',
  routineStarted: 'routine routine started',
  workflowRun: 'workflow workflow run',
  deviceConnected: 'device device connected',
  deviceDisconnected: 'device device disconnected',
  peerIn: 'peer message in',
  peerOut: 'peer message out',
  peerDelivered: 'peer message delivered',
  peerFailed: 'peer delivery failed',
  importBatch: 'import import batch',
  wsConnected: 'ws client connected',
  wsDisconnected: 'ws client disconnected',
  http5xx: 'http server error',
  alert: 'alert alert raised',
  notice: 'notice error notice',
  limit: 'limits provider limit',
} as const;

export type EventName = (typeof EV)[keyof typeof EV];

/** [component, msg] of an event. */
export function ev(name: EventName): [string, string] {
  const i = name.indexOf(' ');
  return [name.slice(0, i), name.slice(i + 1)];
}
