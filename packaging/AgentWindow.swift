import AppKit
import WebKit

// Keep the console in its own macOS window rather than losing it among browser tabs.
// The web view may only navigate to the loopback console; other links open in the browser.
final class AgentWindow: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private let console = URL(string: "http://127.0.0.1:4318/")!
    private var window: NSWindow!
    private var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appMenu = NSMenuItem()
        let appSubmenu = NSMenu()
        appSubmenu.addItem(withTitle: "Quit Unreal Agent", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenu.submenu = appSubmenu
        menu.addItem(appMenu)
        let edit = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        edit.submenu = editMenu
        menu.addItem(edit)
        let view = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
        view.submenu = viewMenu
        menu.addItem(view)
        NSApp.mainMenu = menu

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1160, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Unreal Agent"
        window.minSize = NSSize(width: 720, height: 480)
        window.contentView = webView
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString("<html style='background:#0f100e;color:#c9f277;font:18px system-ui'><body style='padding:35px'>Starting Unreal Agent…</body></html>", baseURL: nil)
    }

    func showConsole() { webView.load(URLRequest(url: console)) }

    func showError(_ error: Error) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert(error: error)
        alert.messageText = "Unreal Agent could not start"
        // NSAlert(error:) puts the reason in messageText; keep it visible below the title.
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }

    @objc private func reload() { webView.load(URLRequest(url: console)) }

    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        sender.activate(ignoringOtherApps: true)
        return true
    }

    private func isConsole(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == 4318
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if isConsole(url) || url.scheme == "about" { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated || action.targetFrame == nil { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isConsole(url) { webView.load(URLRequest(url: url)) }
            else { NSWorkspace.shared.open(url) }
        }
        return nil
    }
}
