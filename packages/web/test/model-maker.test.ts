import { describe, expect, test } from 'bun:test';
import { makerOf } from '../src/components/pickers/ModelPicker';

describe('makerOf groups models by who made them', () => {
  test('each family lands under its maker, whatever route reaches it', () => {
    expect(makerOf('claude-opus-5-5')).toBe('anthropic');
    expect(makerOf('gpt-5.5')).toBe('openai');
    expect(makerOf('gemini-3.1-pro-preview')).toBe('google');
    expect(makerOf('glm-5.3')).toBe('zai');
    expect(makerOf('z-ai/glm-5.3')).toBe('zai');
    expect(makerOf('deepseek-v4-pro')).toBe('deepseek');
    expect(makerOf('kimi-k3')).toBe('moonshot');
    expect(makerOf('qwen3.8-max')).toBe('qwen');
  });
  test('an unknown model keeps its provider', () => {
    expect(makerOf('llama-4-local')).toBeUndefined();
  });
});
