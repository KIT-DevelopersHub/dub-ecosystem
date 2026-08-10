// EventsListView — S3 events list (design §5 S3). Lists the caller's upcoming
// events (BFF home aggregate in P0) and pushes the S4 detail on tap.
import SwiftUI
import Mo1Core

public struct EventsListView: View {
    @StateObject private var vm: EventsListViewModel
    private let api: MobileApi

    public init(api: MobileApi) {
        _vm = StateObject(wrappedValue: EventsListViewModel(api: api))
        self.api = api
    }

    public var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading && vm.isEmpty {
                    ProgressView("Loading…")
                } else if vm.isEmpty {
                    ContentUnavailableView("No events", systemImage: "calendar", description: Text("You have no upcoming events."))
                } else {
                    List(vm.events) { event in
                        NavigationLink(value: event.id) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(event.title).font(.headline)
                                Text(event.phase.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .refreshable { await vm.load() }
                }
            }
            .navigationTitle("Events")
            .navigationDestination(for: String.self) { eventId in
                EventDetailView(api: api, eventId: eventId)
            }
        }
        .task { await vm.load() }
    }
}
