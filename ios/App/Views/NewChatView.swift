import CetusRemoteKit
import SwiftUI

/// Start a chat: pick the folder, Mac and runtime, then type the first
/// message. The chat is created on the Mac only when that message is sent.
struct NewChatView: View {
    @Environment(RemoteStore.self) private var store
    var initialFolder: String?
    let onCreated: (Conversation) -> Void

    @AppStorage("lastRuntime") private var runtime: String = Runtime.claudeCode.rawValue
    @AppStorage("lastFolder") private var lastFolder: String = ""
    @State private var folder: String?
    @State private var text = ""
    @State private var images: [OutgoingImage] = []
    @State private var busy = false
    @State private var error: String?
    @State private var pickingFolder = false

    private var chosenFolder: String {
        folder ?? initialFolder ?? (store.folders.contains(lastFolder) ? lastFolder : store.sidebar.defaultDir)
    }

    var body: some View {
        VStack(spacing: 10) {
            Spacer()
            Button {
                pickingFolder = true
            } label: {
                FieldCard(label: "Folder") {
                    HStack(spacing: 8) {
                        FolderAvatar(name: store.folderName(chosenFolder), size: 20)
                        Text(store.folderName(chosenFolder)).lineLimit(1)
                    }
                }
            }
            .buttonStyle(.plain)
            Menu {
                ForEach(store.hosts) { host in
                    Button {
                        store.selectedHostId = host.sid
                    } label: {
                        if host.sid == store.selectedHostId {
                            Label(host.macName, systemImage: "checkmark")
                        } else {
                            Text(host.macName)
                        }
                    }
                }
            } label: {
                FieldCard(label: "Mac") {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(store.state == .connected ? Theme.success : .orange)
                            .frame(width: 8, height: 8)
                        Text(store.selectedHost?.macName ?? "Mac").lineLimit(1)
                    }
                }
            }
            .buttonStyle(.plain)
            Menu {
                ForEach(Runtime.allCases) { r in
                    Button {
                        runtime = r.rawValue
                    } label: {
                        if r.rawValue == runtime {
                            Label(r.label, systemImage: "checkmark")
                        } else {
                            Text(r.label)
                        }
                    }
                }
            } label: {
                FieldCard(label: "Runtime") {
                    HStack(spacing: 8) {
                        Image(systemName: Runtime.symbol(for: runtime))
                            .font(.system(size: 14, weight: .medium))
                            .frame(width: 20)
                        Text(Runtime.label(for: runtime))
                    }
                }
            }
            .buttonStyle(.plain)
            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ComposerBar(text: $text, images: $images, placeholder: "What should it do?", busy: busy, onSend: start) {
                RuntimeChip(backend: runtime)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
            .background(Theme.background)
        }
        .navigationTitle("New chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .sheet(isPresented: $pickingFolder) {
            FolderPickerSheet(selected: chosenFolder) { dir in
                folder = dir
                pickingFolder = false
            }
            .presentationDetents([.medium, .large])
        }
    }

    private func start() {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let photos = images
        let dir = chosenFolder
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let c = try await store.createConversation(
                    runtime: Runtime(rawValue: runtime) ?? .pi,
                    workspaceDir: dir.isEmpty ? nil : dir)
                try await store.send(message, images: photos, to: c.id)
                lastFolder = dir
                onCreated(c)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// Folder list with search, plus "Add folder" at the bottom.
struct FolderPickerSheet: View {
    @Environment(RemoteStore.self) private var store
    let selected: String
    let onPick: (String) -> Void
    @State private var query = ""
    @State private var adding = false

    private var matches: [String] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return store.folders.filter { q.isEmpty || $0.lowercased().contains(q) || store.folderName($0).lowercased().contains(q) }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(matches, id: \.self) { dir in
                    Button {
                        onPick(dir)
                    } label: {
                        HStack(spacing: 10) {
                            FolderAvatar(name: store.folderName(dir), size: 22)
                            Text(store.folderName(dir))
                                .foregroundStyle(Theme.text)
                            Text(dir.tildePath)
                                .font(.footnote)
                                .foregroundStyle(Theme.muted)
                                .lineLimit(1)
                                .truncationMode(.head)
                            Spacer(minLength: 4)
                            if dir == selected {
                                Image(systemName: "checkmark")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(Theme.text)
                            }
                        }
                    }
                    .listRowBackground(Theme.background)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search folders")
            .navigationTitle("Folder")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Button {
                    adding = true
                } label: {
                    Label("Add folder", systemImage: "folder.badge.plus")
                        .foregroundStyle(Theme.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)
                        .frame(height: 52)
                }
                .background(Theme.background)
                .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 0.5) }
            }
            .sheet(isPresented: $adding) {
                AddFolderSheet { dir in
                    adding = false
                    if let dir { onPick(dir) }
                }
                .presentationDetents([.large])
            }
        }
    }
}

/// Add a folder from the Mac to the sidebar: find an existing one, or
/// create a new one. Mirrors "Add folder" on the desktop.
struct AddFolderSheet: View {
    @Environment(RemoteStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// Called with the added folder, or nil when cancelled.
    let onDone: (String?) -> Void

    @State private var query = ""
    @State private var hits: [DirHit] = []
    @State private var searching = false
    @State private var error: String?
    @State private var creatingIn: DirHit?
    @State private var newName = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(hits) { hit in
                        HStack(spacing: 12) {
                            Image(systemName: "folder")
                                .foregroundStyle(Theme.muted)
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(hit.display)
                                    .foregroundStyle(Theme.text)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                                Text(hit.path)
                                    .font(.caption)
                                    .foregroundStyle(Theme.muted)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                            }
                            Spacer(minLength: 4)
                            if store.folders.contains(hit.path) {
                                Text("Added")
                                    .font(.caption)
                                    .foregroundStyle(Theme.faint)
                            }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { add(hit.path) }
                        .swipeActions {
                            Button("New folder here", systemImage: "folder.badge.plus") {
                                newName = ""
                                creatingIn = hit
                            }
                            .tint(Theme.accent)
                        }
                        .contextMenu {
                            Button("Add", systemImage: "plus") { add(hit.path) }
                            Button("New folder inside…", systemImage: "folder.badge.plus") {
                                newName = ""
                                creatingIn = hit
                            }
                            Button("Browse", systemImage: "arrow.turn.down.right") { query = hit.display + "/" }
                        }
                        .listRowBackground(Theme.background)
                    }
                } footer: {
                    Text(hits.isEmpty && !searching
                        ? "No folders found."
                        : "Type a name, or a path like ~/Developer/. Long-press a folder to create a new one inside it.")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .listRowBackground(Theme.background)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search folders or enter a path")
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .navigationTitle("Add folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onDone(nil); dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if searching { ProgressView().controlSize(.small) }
                }
            }
            .task(id: query) {
                // Debounce keystrokes; the first load runs at once.
                if !query.isEmpty { try? await Task.sleep(for: .milliseconds(180)) }
                guard !Task.isCancelled else { return }
                searching = true
                defer { searching = false }
                do {
                    hits = try await store.searchDirs(query)
                    error = nil
                } catch {
                    self.error = error.localizedDescription
                }
            }
            .alert("New folder in \(creatingIn?.display ?? "")", isPresented: Binding(
                get: { creatingIn != nil }, set: { if !$0 { creatingIn = nil } }
            )) {
                TextField("Name", text: $newName)
                    .textInputAutocapitalization(.never)
                Button("Cancel", role: .cancel) {}
                Button("Create") {
                    guard let parent = creatingIn?.path else { return }
                    let name = newName
                    Task {
                        do {
                            let path = try await store.makeFolder(in: parent, named: name)
                            add(path)
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
            }
        }
    }

    private func add(_ dir: String) {
        Task {
            do {
                try await store.addFolder(dir)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                onDone(dir)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

extension String {
    /// `/Users/me/x` → `~/x` (best effort; the Mac's home is usually /Users/<name>).
    var tildePath: String {
        let parts = split(separator: "/", omittingEmptySubsequences: false)
        if parts.count >= 3, parts[1] == "Users" {
            return "~/" + parts.dropFirst(3).joined(separator: "/")
        }
        return self
    }
}
