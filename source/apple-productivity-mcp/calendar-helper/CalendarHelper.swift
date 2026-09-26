import AppKit
import EventKit
import Foundation

enum HelperError: LocalizedError {
    case invalidInput(String)
    case calendarAccessDenied
    case calendarNotFound(String)

    var errorDescription: String? {
        switch self {
        case .invalidInput(let message):
            return message
        case .calendarAccessDenied:
            return "Calendar access is not enabled for Unreal Agent Calendar. Open System Settings > Privacy & Security > Calendars and enable Full Access."
        case .calendarNotFound(let name):
            return name.isEmpty ? "No writable calendar was found." : "Writable calendar not found: \(name)"
        }
    }
}

let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

let fallbackISOFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

func parseDate(_ value: Any?) -> Date? {
    guard let text = value as? String else { return nil }
    return isoFormatter.date(from: text) ?? fallbackISOFormatter.date(from: text)
}

func iso(_ date: Date?) -> String? {
    guard let date else { return nil }
    return isoFormatter.string(from: date)
}

func intValue(_ value: Any?, default fallback: Int) -> Int {
    if let number = value as? NSNumber { return number.intValue }
    if let text = value as? String, let number = Int(text) { return number }
    return fallback
}

func boolValue(_ value: Any?) -> Bool {
    if let number = value as? NSNumber { return number.boolValue }
    if let value = value as? Bool { return value }
    return false
}

func requestCalendarAccess(_ store: EKEventStore) throws {
    let status = EKEventStore.authorizationStatus(for: .event)
    if status == .fullAccess { return }
    if status == .denied || status == .restricted { throw HelperError.calendarAccessDenied }

    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    var requestError: Error?
    store.requestFullAccessToEvents { allowed, error in
        granted = allowed
        requestError = error
        semaphore.signal()
    }

    let deadline = Date().addingTimeInterval(120)
    while semaphore.wait(timeout: .now() + 0.1) == .timedOut {
        if Date() >= deadline {
            throw HelperError.invalidInput("Calendar authorization timed out. Try again with the Mac unlocked.")
        }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }

    if let requestError { throw requestError }
    if !granted { throw HelperError.calendarAccessDenied }
}

func calendarRecord(_ calendar: EKCalendar) -> [String: Any] {
    [
        "name": calendar.title,
        "writable": calendar.allowsContentModifications
    ]
}

func eventRecord(_ event: EKEvent) -> [String: Any] {
    [
        "id": event.eventIdentifier ?? "",
        "calendar": event.calendar?.title ?? "",
        "title": event.title ?? "Untitled",
        "start": iso(event.startDate) ?? NSNull(),
        "end": iso(event.endDate) ?? NSNull(),
        "allDay": event.isAllDay,
        "location": event.location ?? "",
        "notes": event.notes ?? ""
    ]
}

func matchingCalendars(_ store: EKEventStore, named requestedName: String?) -> [EKCalendar] {
    let calendars = store.calendars(for: .event)
    guard let requestedName, !requestedName.isEmpty else { return calendars }
    return calendars.filter { $0.title.caseInsensitiveCompare(requestedName) == .orderedSame }
}

func searchEvents(_ store: EKEventStore, input: [String: Any], todayOnly: Bool) throws -> [String: Any] {
    let now = Date()
    let start: Date
    let end: Date

    if todayOnly {
        start = Calendar.current.startOfDay(for: now)
        end = Calendar.current.date(byAdding: .day, value: 1, to: start) ?? now.addingTimeInterval(86_400)
    } else {
        start = parseDate(input["start"]) ?? now
        end = parseDate(input["end"]) ?? now.addingTimeInterval(30 * 86_400)
    }

    guard end >= start else { throw HelperError.invalidInput("Use a valid start/end date range.") }
    let query = (input["query"] as? String ?? "").lowercased()
    let calendarName = input["calendar"] as? String
    let limit = min(100, max(1, intValue(input["limit"], default: 30)))
    let calendars = matchingCalendars(store, named: calendarName)
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
    let events = store.events(matching: predicate)
        .filter { event in
            guard !query.isEmpty else { return true }
            return [event.title, event.location, event.notes]
                .compactMap { $0 }
                .joined(separator: "\n")
                .lowercased()
                .contains(query)
        }
        .prefix(limit)
        .map(eventRecord)

    return [
        "events": Array(events),
        "count": events.count,
        "range": ["start": iso(start) ?? "", "end": iso(end) ?? ""]
    ]
}

func perform(action: String, input: [String: Any], store: EKEventStore) throws -> [String: Any] {
    switch action {
    case "calendarList":
        return ["calendars": store.calendars(for: .event).map(calendarRecord)]
    case "calendarToday":
        return try searchEvents(store, input: input, todayOnly: true)
    case "calendarSearch":
        return try searchEvents(store, input: input, todayOnly: false)
    case "calendarCreate":
        let title = (input["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, let start = parseDate(input["start"]), let end = parseDate(input["end"]), end > start else {
            throw HelperError.invalidInput("A title and a valid start/end range are required.")
        }

        let requestedName = (input["calendar"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let candidates = matchingCalendars(store, named: requestedName.isEmpty ? nil : requestedName)
        guard let calendar = candidates.first(where: { $0.allowsContentModifications }) else {
            throw HelperError.calendarNotFound(requestedName)
        }

        let event = EKEvent(eventStore: store)
        event.calendar = calendar
        event.title = title
        event.startDate = start
        event.endDate = end
        event.isAllDay = boolValue(input["allDay"])
        event.location = input["location"] as? String ?? ""
        event.notes = input["notes"] as? String ?? ""
        try store.save(event, span: .thisEvent, commit: true)
        return ["created": true, "event": eventRecord(event)]
    default:
        throw HelperError.invalidInput("Unknown Calendar action: \(action)")
    }
}

do {
    NSApplication.shared.setActivationPolicy(.accessory)
    NSApplication.shared.activate(ignoringOtherApps: true)

    if CommandLine.arguments.count == 1 {
        guard let launcher = Bundle.main.url(forResource: "Launch Unreal Agent", withExtension: "command") else {
            throw HelperError.invalidInput("The Unreal Agent launcher is missing. Rebuild the app with build-calendar-helper.sh.")
        }
        let process = Process()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [launcher.path]
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            let detail = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "Startup failed."
            throw HelperError.invalidInput(detail)
        }
        exit(0)
    }

    guard CommandLine.arguments.count >= 3 else {
        throw HelperError.invalidInput("Usage: UnrealAgentCalendar <action> <json>")
    }

    let inputData = Data(CommandLine.arguments[2].utf8)
    let input = try JSONSerialization.jsonObject(with: inputData) as? [String: Any] ?? [:]
    let store = EKEventStore()
    try requestCalendarAccess(store)
    let result = try perform(action: CommandLine.arguments[1], input: input, store: store)
    let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(output)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    if CommandLine.arguments.count == 1 {
        let alert = NSAlert(error: error)
        alert.messageText = "Unreal Agent could not start"
        alert.informativeText = error.localizedDescription
        alert.runModal()
    } else {
        FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    }
    exit(1)
}
