import { expect, test } from 'bun:test';
import type { ConnectionInfo, ConnectionTestResult, SyncResult } from '../../src/memory/connections/types';
import type { ConnectionPreset } from '../../src/memory/connections/registry';
import type { MemoryConnectionInput } from '../../src/memory/connections/service';
import type { FileImportResult } from '../../src/memory/import-files';
import type { MarkdownExport } from '../../src/memory/export';
import type { InventoryItem } from '../../src/extensions/registry';
import type { HookTrace } from '../../src/extensions/types';
import type { McpConnectStep } from '../../src/extensions/cli-sync';
import type {
  HookTraceDto,
  InventoryItemDto,
  McpConnectStepDto,
  MemoryConnectionInfo,
  MemoryConnectionInputDto,
  MemoryConnectionPreset,
  MemoryConnectionTestResult,
  MemoryFileImportResult,
  MemoryMarkdownExport,
  MemorySyncResult,
} from '../../src/client';

/**
 * The typed client may only import plain type modules (it runs in the
 * browser), so it declares its own copies of these shapes. These checks fail
 * the core typecheck when an engine type drifts from the client's copy.
 */
type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

export type Checks = [
  Assert<Extends<ConnectionInfo, MemoryConnectionInfo>>,
  Assert<Extends<ConnectionTestResult, MemoryConnectionTestResult>>,
  Assert<Extends<SyncResult, MemorySyncResult>>,
  Assert<Extends<ConnectionPreset, MemoryConnectionPreset>>,
  Assert<Extends<MemoryConnectionInputDto, MemoryConnectionInput>>,
  Assert<Extends<FileImportResult, MemoryFileImportResult>>,
  Assert<Extends<MarkdownExport, MemoryMarkdownExport>>,
  Assert<Extends<InventoryItem, InventoryItemDto>>,
  Assert<Extends<HookTrace, HookTraceDto>>,
  Assert<Extends<McpConnectStep, McpConnectStepDto>>,
];

test('client DTOs match the engine types (checked by tsc)', () => {
  expect(true).toBe(true);
});
