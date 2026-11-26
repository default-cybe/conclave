import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client AttachTest.kt, plus the picture size the iOS composer scales to.
struct AttachTests {
    private func file(_ bytes: Int, _ name: String = "a.txt") -> Attachment {
        Attachment(mediaType: "text/plain", data: String(repeating: "A", count: bytes * 4 / 3), name: name)
    }

    @Test func noCountCap() {
        #expect(Attach.refusal(Array(repeating: file(10), count: 40), file(10)) == nil)
    }

    @Test func togetherUnderWhatTheHubReads() {
        let big = file(40 * 1024 * 1024)
        #expect(Attach.refusal([], big) == nil)
        #expect(Attach.refusal([big], file(6 * 1024 * 1024)) == Attach.tooLarge)
    }

    @Test func anyFileIsPicked() {
        #expect(Attach.isZip("application/x-zip-compressed", "src.zip"))
        #expect(Attach.isZip("application/octet-stream", "Src.ZIP"))
        #expect(!Attach.isZip("text/plain", "notes.zip"))
        #expect(Attach.mediaTypeOf("application/octet-stream", "src.zip") == "application/zip")
        #expect(Attach.mediaTypeOf("application/x-zip-compressed", "src.zip") == "application/x-zip-compressed")
        #expect(Attach.mediaTypeOf("application/pdf", "a.pdf") == "application/pdf")
        #expect(Attach.mediaTypeOf(nil, "a.bin") == "application/octet-stream")
    }

    @Test func aPastedPictureIsAFileAndTextIsNot() {
        #expect(Attach.isPastedImage("image/png"))
        #expect(Attach.isPastedImage("image/gif"))
        #expect(Attach.isPastedImage("Image/JPEG"))
        #expect(!Attach.isPastedImage("text/plain"))
        #expect(!Attach.isPastedImage("application/pdf"))
        #expect(!Attach.isPastedImage(""))
        #expect(!Attach.isPastedImage(nil))
    }

    @Test func theCountOnceTheRowScrolls() {
        #expect(Attach.filesWord(1) == "1 file")
        #expect(Attach.filesWord(7) == "7 files")
    }

    @Test func aFileTheHubCouldNotReadAsksInsteadOfFailing() {
        #expect(Attach.lostWords("Attachment not included: a.pdf could not be read. Send again to go without it.") == "a.pdf could not be read. Send again to go without it.")
        #expect(Attach.lostWords("Network error") == nil)
    }

    @Test func aPictureFitsTheLongSideAndNeverGrows() {
        func fit(_ w: Int, _ h: Int) -> [Int] { let f = Attach.fitted(width: w, height: h); return [f.width, f.height] }
        #expect(fit(4032, 3024) == [2000, 1500])
        #expect(fit(3024, 4032) == [1500, 2000])
        #expect(fit(800, 600) == [800, 600])
        #expect(fit(10000, 1) == [2000, 1])
    }
}
