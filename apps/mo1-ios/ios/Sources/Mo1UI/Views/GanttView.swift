// GanttView — S6 Gantt (design §5 S6). Renders the dependency-ordered rows from
// GanttViewModel as an indented list of scheduled bars: each row is offset and
// sized by its day offset/duration within the chart window. A zoom picker and
// per-row collapse toggle drive the local view state; a cycle in the graph
// surfaces a non-blocking banner (design §6 never-crash).
import SwiftUI
import Mo1Core

public struct GanttView: View {
    @StateObject private var vm: GanttViewModel
    private let title: String

    public init(api: MobileApi, eventId: Ids.EventId, title: String = "Timeline") {
        _vm = StateObject(wrappedValue: GanttViewModel(api: api, eventId: eventId))
        self.title = title
    }

    public var body: some View {
        Group {
            if vm.isLoading && vm.data == nil {
                ProgressView("Loading…")
            } else if let data = vm.data, !data.rows.isEmpty {
                content(data)
            } else if vm.errorKind != nil {
                ContentUnavailableView("Couldn't load timeline", systemImage: "exclamationmark.triangle", description: Text("Pull to try again."))
            } else {
                ContentUnavailableView("No scheduled tasks", systemImage: "calendar", description: Text("This event has no timeline yet."))
            }
        }
        .navigationTitle(title)
        .task { await vm.load() }
    }

    private func content(_ data: GanttViewData) -> some View {
        VStack(spacing: 0) {
            Picker("Zoom", selection: Binding(get: { vm.zoom }, set: { vm.setZoom($0) })) {
                ForEach(GanttZoom.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding()

            if data.hasCycle {
                Label("Some dependencies form a cycle; order is approximate.", systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
            }

            List {
                ForEach(data.rows) { row in
                    GanttRowView(row: row, totalDays: max(1, data.range.totalDays))
                        .contentShape(Rectangle())
                        .onTapGesture { vm.toggleCollapse(row.taskId) }
                }
            }
            .listStyle(.plain)
            .refreshable { await vm.load() }
        }
    }
}

private struct GanttRowView: View {
    let row: GanttViewRow
    let totalDays: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if row.depth > 0 {
                    Spacer().frame(width: CGFloat(row.depth) * 12)
                }
                Text(row.title).font(.subheadline).lineLimit(1)
                Spacer()
                if row.progressPercent >= 100 {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.caption)
                }
            }
            if !row.collapsed {
                bar
            }
        }
        .padding(.vertical, 2)
    }

    private var bar: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let unit = width / CGFloat(totalDays)
            let offset = CGFloat(row.offsetDays ?? 0) * unit
            let length = max(unit * CGFloat(max(row.durationDays, row.offsetDays == nil ? 0 : 1)), row.offsetDays == nil ? 0 : 6)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.gray.opacity(0.12)).frame(height: 8)
                if row.offsetDays != nil {
                    Capsule().fill(Color.accentColor).frame(width: length, height: 8).offset(x: offset)
                }
            }
        }
        .frame(height: 10)
    }
}
