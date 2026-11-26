import Cocoa
import WebKit
import UniformTypeIdentifiers

func logLine(_ message: String) {
    let line = "[\(Date())] \(message)\n"
    guard let data = line.data(using: .utf8) else { return }
    let url = URL(fileURLWithPath: "/tmp/mdviewer.log")
    if let fh = try? FileHandle(forWritingTo: url) {
        fh.seekToEndOfFile()
        fh.write(data)
        try? fh.close()
    } else {
        try? data.write(to: url)
    }
}

func mimeTypeForURL(_ fileURL: URL) -> String {
    let ext = fileURL.pathExtension.lowercased()
    switch ext {
    case "svg", "svgz": return "image/svg+xml"
    case "png": return "image/png"
    case "jpg", "jpeg", "jfif": return "image/jpeg"
    case "gif": return "image/gif"
    case "webp": return "image/webp"
    case "avif": return "image/avif"
    case "bmp": return "image/bmp"
    case "ico": return "image/x-icon"
    case "tif", "tiff": return "image/tiff"
    case "mp4", "m4v": return "video/mp4"
    case "webm": return "video/webm"
    case "mov": return "video/quicktime"
    case "mp3": return "audio/mpeg"
    case "wav": return "audio/wav"
    case "ogg": return "audio/ogg"
    case "pdf": return "application/pdf"
    case "css": return "text/css"
    case "js": return "application/javascript"
    case "json": return "application/json"
    default:
        if let ut = UTType(filenameExtension: ext), let mime = ut.preferredMIMEType {
            return mime
        }
        return "application/octet-stream"
    }
}

/// Serves local files referenced from Markdown (images, SVGs, videos, etc.) via `mdlocal://local/<path>`.
final class LocalResourceSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let reqURL = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorBadURL))
            return
        }

        let filePath = reqURL.path
        let fileURL = URL(fileURLWithPath: filePath).standardizedFileURL
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDir),
              !isDir.boolValue,
              let data = try? Data(contentsOf: fileURL) else {
            logLine("mdlocal 404: \(fileURL.path)")
            let resp = HTTPURLResponse(
                url: reqURL,
                statusCode: 404,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain; charset=utf-8"]
            )!
            urlSchemeTask.didReceive(resp)
            urlSchemeTask.didReceive(Data("Not Found".utf8))
            urlSchemeTask.didFinish()
            return
        }

        let mime = mimeTypeForURL(fileURL)
        let headers: [String: String] = [
            "Content-Type": mime,
            "Content-Length": "\(data.count)",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*"
        ]
        let resp = HTTPURLResponse(
            url: reqURL,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        urlSchemeTask.didReceive(resp)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Synchronous reads finish immediately; nothing to cancel.
    }
}

/// WKWebView subclass that intercepts file drops natively so we retain the real filesystem path.
final class DropAwareWebView: WKWebView {
    var onFileDrop: ((String) -> Void)?
    private let supportedExts: Set<String> = ["md", "markdown", "mdown", "mkd", "txt"]

    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        registerForDraggedTypes([.fileURL])
    }

    private func droppedMarkdownURL(from info: NSDraggingInfo) -> URL? {
        guard let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true
        ]) as? [URL] else { return nil }
        return urls.first { supportedExts.contains($0.pathExtension.lowercased()) }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if droppedMarkdownURL(from: sender) != nil {
            return .copy
        }
        return super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if droppedMarkdownURL(from: sender) != nil {
            return .copy
        }
        return super.draggingUpdated(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if let url = droppedMarkdownURL(from: sender) {
            onFileDrop?(url.path)
            return true
        }
        return super.performDragOperation(sender)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: DropAwareWebView!
    private var pendingPath: String?
    private var pageReady = false
    private let markdownExts: Set<String> = ["md", "markdown", "mdown", "mkd"]

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        buildWindow()
        loadViewer()

        // A path passed directly on the command line (e.g. `MarkdownViewer file.md`).
        if let arg = CommandLine.arguments.dropFirst().first(where: { !$0.hasPrefix("-") }) {
            pendingPath = arg
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Finder / `open -a` delivery
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        if let first = filenames.first {
            open(path: first)
        }
        sender.reply(toOpenOrPrint: .success)
    }

    private func buildMenu() {
        let mainMenu = NSMenu()

        // App menu
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Markdown Viewer", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Markdown Viewer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // File menu
        let fileItem = NSMenuItem()
        mainMenu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileItem.submenu = fileMenu
        fileMenu.addItem(withTitle: "Open…", action: #selector(openDocument(_:)), keyEquivalent: "o")
        fileMenu.addItem(withTitle: "Reload", action: #selector(reloadDocument(_:)), keyEquivalent: "r")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Export HTML…", action: #selector(exportHTML(_:)), keyEquivalent: "s")

        // Edit menu (enables Cmd+C / Cmd+V / Cmd+A / Cmd+Z inside WKWebView)
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        // View menu
        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewItem.submenu = viewMenu
        let wideItem = NSMenuItem(title: "Toggle Wide Mode", action: #selector(toggleWideMode(_:)), keyEquivalent: "W")
        wideItem.keyEquivalentModifierMask = [.command, .shift]
        viewMenu.addItem(wideItem)
        viewMenu.addItem(.separator())
        let fsItem = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fsItem.keyEquivalentModifierMask = [.control, .command]
        viewMenu.addItem(fsItem)

        NSApp.mainMenu = mainMenu
    }

    private func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1180, height: 800)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Markdown Viewer"
        window.center()
        window.setFrameAutosaveName("MarkdownViewerMain")
        window.minSize = NSSize(width: 640, height: 420)
        window.collectionBehavior = [.fullScreenPrimary]
        window.delegate = self

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.setURLSchemeHandler(LocalResourceSchemeHandler(), forURLScheme: "mdlocal")
        config.userContentController.add(self, name: "export")
        config.userContentController.add(self, name: "native")

        webView = DropAwareWebView(frame: rect, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.onFileDrop = { [weak self] path in
            self?.open(path: path)
        }
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func loadViewer() {
        guard let res = Bundle.main.resourceURL?.appendingPathComponent("viewer") else { return }
        let index = res.appendingPathComponent("index.html")
        webView.loadFileURL(index, allowingReadAccessTo: res)
    }

    private func open(path: String) {
        pendingPath = path
        guard pageReady else { return }
        applyPending()
    }

    private func applyPending() {
        guard let path = pendingPath else { return }
        pendingPath = nil
        let url = URL(fileURLWithPath: path).standardizedFileURL
        logLine("opening \(url.path)")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            presentError("无法读取文件", "\(url.lastPathComponent) 不是 UTF-8 文本，或已被移动。")
            return
        }
        window.title = url.lastPathComponent
        window.representedURL = url

        let meta: [String: String] = [
            "filePath": url.path,
            "baseDir": url.deletingLastPathComponent().path,
            "fileName": url.lastPathComponent
        ]
        guard let textData = try? JSONEncoder().encode(text),
              let textJSON = String(data: textData, encoding: .utf8),
              let metaData = try? JSONEncoder().encode(meta),
              let metaJSON = String(data: metaData, encoding: .utf8) else { return }

        webView.evaluateJavaScript("window.__loadMarkdown && window.__loadMarkdown(\(textJSON), \(metaJSON))") { result, error in
            if let error = error {
                logLine("inject failed: \(error)")
            } else {
                logLine("injected \(text.count) chars from \(url.path), result=\(String(describing: result))")
            }
        }
    }

    private func presentError(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }

    @objc private func openDocument(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        var types: [UTType] = [.plainText]
        for ext in ["md", "markdown", "mdown", "mkd"] {
            if let t = UTType(filenameExtension: ext) { types.insert(t, at: 0) }
        }
        panel.allowedContentTypes = types
        if panel.runModal() == .OK, let url = panel.url {
            open(path: url.path)
        }
    }

    @objc private func reloadDocument(_ sender: Any?) {
        if let url = window.representedURL {
            open(path: url.path)
        }
    }

    @objc private func toggleWideMode(_ sender: Any?) {
        webView.evaluateJavaScript("window.__toggleWide && window.__toggleWide()") { _, _ in }
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        webView.evaluateJavaScript("window.__setFullScreen && window.__setFullScreen(true)") { _, _ in }
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        webView.evaluateJavaScript("window.__setFullScreen && window.__setFullScreen(false)") { _, _ in }
    }

    @objc private func exportHTML(_ sender: Any?) {
        webView.evaluateJavaScript("window.__exportHTML && window.__exportHTML()") { _, _ in }
    }

    /// Replaces `mdlocal://local/...` image/media references with base64 data URIs for standalone HTML export.
    private func inlineLocalAssets(in html: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"mdlocal://local/[^"'\s<>)]+"#, options: []) else {
            return html
        }
        let nsHTML = html as NSString
        let matches = regex.matches(in: html, options: [], range: NSRange(location: 0, length: nsHTML.length))
        if matches.isEmpty { return html }

        let result = NSMutableString(string: html)
        for match in matches.reversed() {
            let raw = nsHTML.substring(with: match.range)
            guard let url = URL(string: raw) else { continue }
            let fileURL = URL(fileURLWithPath: url.path).standardizedFileURL
            guard let data = try? Data(contentsOf: fileURL) else { continue }
            let mime = mimeTypeForURL(fileURL)
            let dataURI = "data:\(mime);base64,\(data.base64EncodedString())"
            result.replaceCharacters(in: match.range, with: dataURI)
        }
        return result as String
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "export", let html = message.body as? String {
            let standalone = inlineLocalAssets(in: html)
            let panel = NSSavePanel()
            panel.allowedContentTypes = [.html]
            panel.nameFieldStringValue = (window.representedURL?.deletingPathExtension().lastPathComponent ?? "markdown") + ".html"
            if panel.runModal() == .OK, let url = panel.url {
                try? standalone.write(to: url, atomically: true, encoding: .utf8)
            }
            return
        }

        if message.name == "native", let dict = message.body as? [String: Any], let type = dict["type"] as? String {
            switch type {
            case "openDialog":
                openDocument(nil)
            case "toggleFullScreen":
                window.toggleFullScreen(nil)
            case "openExternal":
                if let raw = dict["url"] as? String, let url = URL(string: raw) {
                    NSWorkspace.shared.open(url)
                }
            case "openLocalFile":
                if let path = dict["path"] as? String {
                    let url = URL(fileURLWithPath: path).standardizedFileURL
                    if FileManager.default.fileExists(atPath: url.path) {
                        if markdownExts.contains(url.pathExtension.lowercased()) {
                            open(path: url.path)
                        } else {
                            NSWorkspace.shared.open(url)
                        }
                    } else {
                        presentError("文件不存在", "找不到：\(url.path)")
                    }
                }
            default:
                break
            }
        }
    }
}

extension AppDelegate: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        logLine("page ready")
        applyPending()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        logLine("navigation failed: \(error)")
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" || scheme == "mailto" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
