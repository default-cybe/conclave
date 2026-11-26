import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client EffortTest.kt: levels from the hub's model list, as the composer lists them.
struct EffortTests {
    private let groups: [ModelGroup] = try! decode("""
    [{"provider":"anthropic","models":[
      {"id":"claude-opus-5-5","ref":"anthropic/claude-opus-5-5","thinking":true,"effort":{"levels":["low","medium","high","xhigh","max"],"off":false,"default":"medium"}},
      {"id":"claude-opus-4-6","ref":"anthropic/claude-opus-4-6","thinking":true,"effort":{"levels":["low","medium","high","max"],"off":true,"default":"high"}},
      {"id":"claude-haiku-4-5","ref":"anthropic/claude-haiku-4-5","thinking":true}
    ]}]
    """)
    private var opus55: ModelEffort { groups[0].models[0].effort! }
    private var opus46: ModelEffort { groups[0].models[1].effort! }

    @Test func listsOnlyTheModelsLevels() {
        #expect(Effort.choices(opus55) == [.low, .medium, .high, .xhigh, .max])
        #expect(Effort.choices(opus46) == [.off, .low, .medium, .high, .max])
        #expect(Effort.choices(groups[0].models[2].effort).isEmpty)
        #expect(Effort.defaultOf(opus55) == .medium)
        #expect(Effort.label(.xhigh, opus55) == "Extra high")
    }

    @Test func aLevelTheModelLacksIsTheNearestOne() {
        #expect(Effort.clamp(.xhigh, opus46) == .high)
        #expect(Effort.clamp(.off, opus55) == .low)
        #expect(Effort.shown(nil, opus55) == .medium)
        #expect(Effort.shown(.xhigh, opus46) == .high)
        #expect(Effort.clamp(.high, nil) == nil)
    }

    @Test func theComposerChipSaysModelAndLevel() {
        #expect(Effort.label(.high, ModelEffort(levels: ["high"])) == "On")
        #expect(Effort.words("anthropic/claude-opus-5-5", nil, opus55).hasSuffix(" Medium"))
        #expect(Effort.words("anthropic/claude-haiku-4-5", nil, nil) == ModelRefs.displayName("anthropic/claude-haiku-4-5"))
        #expect(Effort.words(nil, nil, nil) == "Choose a model")
    }
}
