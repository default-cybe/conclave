import Testing
@testable import ConclaveKit

// familyOf in packages/web/src/components/pickers/ModelPicker.tsx
@Test func familiesMatchTheWebPicker() {
    #expect(ModelFamilies.of("anthropic/claude-opus-5-5").name == "Opus")
    #expect(ModelFamilies.of("claude-fable-1").rank < ModelFamilies.of("claude-opus-5-5").rank)
    #expect(ModelFamilies.of("claude-haiku-5-20260101").name == "Haiku")
    #expect(ModelFamilies.of("claude-instant").name == "Claude")
    #expect(ModelFamilies.of("gpt-5.3-codex").name == "Codex")
    #expect(ModelFamilies.of("openai/gpt-5.5-mini").name == "GPT mini and nano")
    #expect(ModelFamilies.of("gpt-5.5").name == "GPT")
    #expect(ModelFamilies.of("o4").name == "o-series")
    #expect(ModelFamilies.of("gemini-3-flash-lite").name == "Gemini Flash-Lite")
    #expect(ModelFamilies.of("gemini-3-pro").name == "Gemini Pro")
    #expect(ModelFamilies.of("glm-4.5-air").name == "GLM Air")
    #expect(ModelFamilies.of("qwen3").name == "")
    #expect(ModelFamilies.of("qwen3").rank == 9)
}
