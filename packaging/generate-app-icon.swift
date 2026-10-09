import AppKit
import Foundation

// Generate every required size from the same dark/acid-green Unreal monogram.
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let s = CGFloat(pixels) / 1024
        NSGraphicsContext.current!.cgContext.scaleBy(x: s, y: s)
        NSColor(calibratedRed: 0.07, green: 0.09, blue: 0.08, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 220, yRadius: 220).fill()
        NSColor(calibratedRed: 0.79, green: 0.95, blue: 0.47, alpha: 1).setStroke()
        let u = NSBezierPath()
        u.lineWidth = 113
        u.lineCapStyle = .round
        u.move(to: NSPoint(x: 286, y: 735))
        u.line(to: NSPoint(x: 286, y: 424))
        u.curve(to: NSPoint(x: 738, y: 424), controlPoint1: NSPoint(x: 286, y: 139), controlPoint2: NSPoint(x: 738, y: 139))
        u.line(to: NSPoint(x: 738, y: 735))
        u.stroke()
        NSColor(calibratedRed: 0.45, green: 0.65, blue: 0.19, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: 449, y: 669, width: 126, height: 126)).fill()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
