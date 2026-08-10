// EventDetailView — S4 event overview (design §5 S4). Shows the event summary
// and, gated strictly by the server-granted capabilities, an "edit" affordance
// and a link into the S6 timeline. Read-only users never see write actions
// (design §6 — the client mirrors capabilities, it never decides them).
import SwiftUI
import Mo1Core

public struct EventDetailView: View {
    @StateObject private var vm: EventDetailViewModel
    private let api: MobileApi

    public init(api: MobileApi, eventId: Ids.EventId) {
        _vm = StateObject(wrappedValue: EventDetailViewModel(api: api, eventId: eventId))
        self.api = api
    }

    public var body: some View {
        Group {
            if vm.isLoading && vm.event == nil {
                ProgressView("Loading…")
            } else if let event = vm.event {
                content(event)
            } else {
                ContentUnavailableView("Couldn't load event", systemImage: "exclamationmark.triangle", description: Text("Pull to try again."))
            }
        }
        .navigationTitle(vm.event?.title ?? "Event")
        .navigationBarTitleDisplayModeInlineCompat()
        .task { await vm.load() }
    }

    private func content(_ event: EventSummary) -> some View {
        List {
            Section("Overview") {
                LabeledContent("Title", value: event.title)
                LabeledContent("Phase", value: event.phase.rawValue.capitalized)
                if let startsAt = event.startsAt {
                    LabeledContent("Starts", value: startsAt)
                }
                LabeledContent("Access") {
                    Text(vm.canEdit ? "Can edit" : "Read only")
                        .foregroundStyle(vm.canEdit ? .green : .secondary)
                }
            }

            Section {
                NavigationLink {
                    GanttView(api: api, eventId: event.id, title: "\(event.title) timeline")
                } label: {
                    Label("View timeline", systemImage: "chart.bar.doc.horizontal")
                }
            }

            if vm.canEdit {
                Section("Actions") {
                    Label("Edit event", systemImage: "pencil")
                        .foregroundStyle(.secondary) // editing lands with the event write wave
                }
            }
        }
    }
}

private extension View {
    // iOS-only titleDisplayMode without breaking the macOS test build.
    @ViewBuilder func navigationBarTitleDisplayModeInlineCompat() -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
}
