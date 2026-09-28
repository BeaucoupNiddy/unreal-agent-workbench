import AppKit
import Security
import Foundation

let fm = FileManager.default
let home = fm.homeDirectoryForCurrentUser
let resources = Bundle.main.resourceURL!
let settings = home.appendingPathComponent("Library/Application Support/Harness Chat/settings.json")
func failure(_ message: String) -> NSError { NSError(domain: "Unreal Agent", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
func writeJSON(_ object: [String: Any], to url: URL) throws {
    try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}
func runLauncher(_ args: [String]) throws {
    let task = Process(); let errors = Pipe()
    task.executableURL = resources.appendingPathComponent("runtime/bin/node")
    task.arguments = [resources.appendingPathComponent("launch.mjs").path] + args
    task.standardError = errors
    try task.run()
    // Drain before waiting so a full stderr pipe can never deadlock launch.
    let data = errors.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    if task.terminationStatus != 0 { throw failure(String(data: data, encoding: .utf8) ?? "Startup failed.") }
}
func setup() throws {
    let panel = NSAlert()
    panel.messageText = "Set up Unreal Agent"
    panel.informativeText = "Connect your own model account. OpenRouter usage is billed to your OpenRouter account. The key is stored in your Mac’s Keychain. Claude Code requires a separate Claude Code installation and `claude login` in Terminal. Codex requires an existing ~/.codex/auth.json login."
    panel.addButton(withTitle: "Save and launch"); panel.addButton(withTitle: "Cancel")
    let view = NSView(frame: NSRect(x:0,y:0,width:420,height:156))
    let provider = NSPopUpButton(frame:NSRect(x:0,y:122,width:420,height:28))
    provider.addItems(withTitles:["OpenRouter API key", "Use existing Codex login", "Use Claude Code login"])
    let modelLabel = NSTextField(labelWithString:"Model ID (include the provider prefix for OpenRouter)")
    modelLabel.frame=NSRect(x:0,y:96,width:420,height:20)
    let model = NSTextField(frame:NSRect(x:0,y:68,width:420,height:24)); model.stringValue="openai/gpt-6-luna"
    let keyLabel = NSTextField(labelWithString:"OpenRouter API key (only needed for OpenRouter)")
    keyLabel.frame=NSRect(x:0,y:38,width:420,height:20)
    let key = NSSecureTextField(frame:NSRect(x:0,y:8,width:420,height:24));key.placeholderString="sk-or-…"
    for control in [provider,modelLabel,model,keyLabel,key] as [NSView] {view.addSubview(control)}
    panel.accessoryView=view
    guard panel.runModal() == .alertFirstButtonReturn else {exit(0)}
    let useRouter = provider.indexOfSelectedItem == 0
    var modelID=model.stringValue.trimmingCharacters(in:.whitespacesAndNewlines)
    if modelID.isEmpty {throw failure("Enter a model ID offered by your provider, then reopen the app.")}
    if useRouter {
        let value=key.stringValue.trimmingCharacters(in:.whitespacesAndNewlines)
        if value.isEmpty {throw failure("Enter your OpenRouter API key, then reopen the app.")}
        let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"Harness Chat OpenRouter",kSecAttrAccount as String:NSUserName()]
        let update=SecItemUpdate(query as CFDictionary,[kSecValueData as String:Data(value.utf8)] as CFDictionary)
        if update == errSecItemNotFound {
            var item=query;item[kSecValueData as String]=Data(value.utf8)
            let result=SecItemAdd(item as CFDictionary,nil)
            if result != errSecSuccess {throw failure("Could not store the key in Keychain (\(result)).")}
        } else if update != errSecSuccess {throw failure("Could not update the key in Keychain (\(update)).")}
    } else if provider.indexOfSelectedItem == 1 {
        guard fm.fileExists(atPath:home.appendingPathComponent(".codex/auth.json").path) else {throw failure("No existing Codex login was found. Use OpenRouter or establish a compatible Codex login first.")}
        if modelID.hasPrefix("openai/") {modelID=String(modelID.dropFirst(7))}
    } else {
        if modelID == "openai/gpt-6-luna" {modelID="sonnet"}
        // Sign-in is managed by Claude Code itself; no credentials are collected here.
    }
    var saved=(try? JSONSerialization.jsonObject(with:Data(contentsOf:settings))) as? [String:Any] ?? [:]
    saved["provider"]=useRouter ? "openrouter" : provider.indexOfSelectedItem == 1 ? "openai-codex" : "claude-code";saved["model"]=modelID
    try writeJSON(saved,to:settings)
    // Current optional title/memory generator uses Codex; avoid authentication
    // failures for a new OpenRouter-only user. It can be enabled in Preferences.
    let generation=home.appendingPathComponent("Library/Application Support/Unreal Agent Console/generation-settings.json")
    if provider.indexOfSelectedItem != 1 {try writeJSON(["titleEnabled":false,"memoryEnabled":false,"titleModel":"gpt-6-luna","memoryModel":"gpt-6-luna"],to:generation)}
    let mcp=home.appendingPathComponent("Library/Application Support/Unreal Agent Console/mcp-settings.json")
    if !fm.fileExists(atPath:mcp.path) {try writeJSON(["appleNotes":false,"appleCalendar":false],to:mcp)}
}
let app=NSApplication.shared
app.setActivationPolicy(.accessory)
do {
    try runLauncher(["--preflight"])
    if !fm.fileExists(atPath:settings.path) || NSEvent.modifierFlags.contains(.option) {app.activate(ignoringOtherApps:true);try setup()}
    try runLauncher([])
} catch {
    app.activate(ignoringOtherApps:true)
    let alert=NSAlert(error:error);alert.messageText="Unreal Agent could not start";alert.runModal();exit(1)
}
