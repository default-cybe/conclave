import Foundation

// Renaming and removing a device (packages/server routes.ts PATCH and DELETE /api/devices/:id).
extension ConclaveClient {
    /// Renames a device; the hub answers with the device. `local` is the hub's own row (owner only).
    public func updateDevice(_ id: String, name: String) async throws -> Device {
        try await send("PATCH", ["api", "devices", id], ["name": name])
    }

    /// Removes a paired computer; the hub's own row (`local`) cannot be removed. Answers { ok: true }.
    public func deleteDevice(_ id: String) async throws { try await sendUnit("DELETE", ["api", "devices", id]) }
}
