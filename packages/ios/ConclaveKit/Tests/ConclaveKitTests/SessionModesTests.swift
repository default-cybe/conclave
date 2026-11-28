import Testing
@testable import ConclaveKit

// Port of packages/android/client SessionModesTest.kt (feat/same-model-picker).
struct SessionModesTests {
    @Test func theModelPickersSameModelSwitchIsOffOnlyForAMemberOnARefusedModel() {
        let why = "Same model for all work needs a model your account may use; Opus 5.5 is not one."
        #expect(SessionModes.sameModelRefusal(member: true, unavailable: "Not allowed for you on this hub.", on: false, name: "Opus 5.5") == why)
        // the owner is never checked; a member on a model they may use, or with it on already (so it can go off), is free
        #expect(SessionModes.sameModelRefusal(member: false, unavailable: "Plan refused", on: false, name: "Opus 5.5") == nil)
        #expect(SessionModes.sameModelRefusal(member: true, unavailable: nil, on: false, name: "Opus 5.5") == nil)
        #expect(SessionModes.sameModelRefusal(member: true, unavailable: "Not allowed", on: true, name: "Opus 5.5") == nil)
    }
}
