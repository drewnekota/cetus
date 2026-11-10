import SwiftUI
import UIKit

/// An image attached to a message: decoded off the main thread, shown as a
/// rounded thumbnail; tap opens it full screen.
struct MessageImage: View {
    let id: Int
    let data: Data?
    var maxSide: CGFloat = 220

    @State private var image: UIImage?
    @State private var viewing = false

    var body: some View {
        Group {
            if let image {
                let size = Self.fit(image.size, in: maxSide)
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size.width, height: size.height)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
                    .contentShape(Rectangle())
                    .onTapGesture { viewing = true }
                    .fullScreenCover(isPresented: $viewing) { ImageViewer(image: image) }
            } else if data != nil {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Theme.surface)
                    .frame(width: maxSide * 0.7, height: maxSide * 0.5)
            } else {
                Label("Image", systemImage: "photo")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
        }
        .task(id: id) {
            guard image == nil, let data else { return }
            image = await Task.detached(priority: .userInitiated) {
                UIImage(data: data)?.preparingThumbnail(of: CGSize(width: 900, height: 900)) ?? UIImage(data: data)
            }.value
        }
    }

    private static func fit(_ s: CGSize, in side: CGFloat) -> CGSize {
        guard s.width > 0, s.height > 0 else { return CGSize(width: side, height: side) }
        let scale = side / max(s.width, s.height)
        // Keep very thin images tappable.
        return CGSize(width: max(80, s.width * scale), height: max(80, s.height * scale))
    }
}

/// Full-screen image: pinch or double-tap to zoom, swipe down or tap ✕ to close.
private struct ImageViewer: View {
    let image: UIImage
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .scaleEffect(scale)
                .offset(offset)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .gesture(
                    MagnifyGesture()
                        .onChanged { scale = max(1, lastScale * $0.magnification) }
                        .onEnded { _ in
                            lastScale = scale
                            if scale == 1 { offset = .zero; lastOffset = .zero }
                        }
                        .simultaneously(with: DragGesture()
                            .onChanged { g in
                                offset = CGSize(width: lastOffset.width + g.translation.width,
                                                height: lastOffset.height + g.translation.height)
                            }
                            .onEnded { g in
                                if scale == 1 && g.translation.height > 120 {
                                    dismiss()
                                } else if scale == 1 {
                                    withAnimation(.snappy) { offset = .zero }
                                }
                                lastOffset = scale == 1 ? .zero : offset
                            })
                )
                .onTapGesture(count: 2) {
                    withAnimation(.snappy) {
                        scale = scale > 1 ? 1 : 2.5
                        lastScale = scale
                        if scale == 1 { offset = .zero; lastOffset = .zero }
                    }
                }
            HStack(spacing: 4) {
                ShareLink(item: Image(uiImage: image), preview: SharePreview("Image", image: Image(uiImage: image))) {
                    Image(systemName: "square.and.arrow.up")
                        .frame(width: 44, height: 44)
                }
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .frame(width: 44, height: 44)
                }
            }
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
        }
        .statusBarHidden()
    }
}
