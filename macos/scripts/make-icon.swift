// Draws lu-minal's app icon as a 1024 x 1024 PNG: the night-sky tile with the glowing crescent
// moon, a gold sparkle, a few stars and the mint prompt - the same design as linux/lu-minal.svg
// (256-unit coordinates, the same gradient stops), laid out on the macOS icon grid (an 824 px tile
// with a soft shadow). The SVG's blurs (the moon's halo, the prompt's glow) are shadows here.
//
//   xcrun swift macos/scripts/make-icon.swift <out.png>
import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: make-icon.swift <out.png>\n".utf8))
    exit(2)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("make-icon: \(message)\n".utf8))
    exit(1)
}

let pixels = 1024
let space = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    return CGColor(
        srgbRed: CGFloat((hex >> 16) & 0xff) / 255.0,
        green: CGFloat((hex >> 8) & 0xff) / 255.0,
        blue: CGFloat(hex & 0xff) / 255.0,
        alpha: alpha
    )
}

/// A gradient through (offset, colour, opacity) stops, as in the SVG.
func gradient(_ stops: [(CGFloat, UInt32, CGFloat)]) -> CGGradient {
    let colors: [CGColor] = stops.map { color($0.1, $0.2) }
    let locations: [CGFloat] = stops.map { $0.0 }
    guard let result = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: locations) else {
        fail("cannot create a gradient")
    }
    return result
}

guard let ctx = CGContext(
    data: nil,
    width: pixels,
    height: pixels,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fail("cannot create a bitmap context")
}

// SVG coordinates: y grows downwards, and the 240-unit tile (8...248) becomes 824 px at 100 px.
let scale = CGFloat(824) / 240
let offset = CGFloat(100) - 8 * scale
ctx.translateBy(x: 0, y: CGFloat(pixels))
ctx.scaleBy(x: 1, y: -1)
ctx.translateBy(x: offset, y: offset)
ctx.scaleBy(x: scale, y: scale)

let tile = CGPath(roundedRect: CGRect(x: 8, y: 8, width: 240, height: 240), cornerWidth: 54, cornerHeight: 54, transform: nil)
let extend: CGGradientDrawingOptions = [.drawsBeforeStartLocation, .drawsAfterEndLocation]

// The tile with its shadow (shadow offsets are in device space: negative y is down).
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: color(0x000000, 0.35))
ctx.addPath(tile)
ctx.setFillColor(color(0x0b0920))
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(tile)
ctx.clip()

// The sky: diagonal, deep violet at the top-left to night-950 at the bottom-right.
let sky = gradient([(0, 0x3a2a80, 1), (0.45, 0x1d1742, 1), (1, 0x0b0920, 1)])
ctx.drawLinearGradient(sky, start: CGPoint(x: 8, y: 8), end: CGPoint(x: 248, y: 248), options: extend)

// A faint highlight along the tile's top edge: a 2-unit band inside the edge, fading out by y = 120.
ctx.saveGState()
ctx.addPath(CGPath(roundedRect: CGRect(x: 9, y: 9, width: 238, height: 238), cornerWidth: 53, cornerHeight: 53, transform: nil))
ctx.setLineWidth(2)
ctx.replacePathWithStrokedPath()
ctx.clip()
let rim = gradient([(0, 0xffffff, 0.2), (1, 0xffffff, 0)])
ctx.drawLinearGradient(rim, start: CGPoint(x: 0, y: 8), end: CGPoint(x: 0, y: 120), options: [])
ctx.restoreGState()

// The moonlight: a soft lavender glow behind the crescent.
let glow = gradient([(0, 0xb9aefb, 0.34), (0.25, 0xb9aefb, 0.2), (0.5, 0xb9aefb, 0.09), (0.75, 0xb9aefb, 0.025), (1, 0xb9aefb, 0)])
let glowCenter = CGPoint(x: 132, y: 112)
ctx.drawRadialGradient(glow, startCenter: glowCenter, startRadius: 0, endCenter: glowCenter, endRadius: 124, options: [])

// Stars: lavender dots of different sizes.
let stars: [(CGFloat, CGFloat, CGFloat, UInt32)] = [
    (54, 62, 5, 0xb9aefb),
    (100, 30, 3, 0xd6cffd),
    (222, 150, 4, 0xd6cffd),
    (208, 210, 3, 0xb9aefb),
]
for (x, y, r, hex) in stars {
    ctx.setFillColor(color(hex))
    ctx.fillEllipse(in: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r))
}

// The crescent (the moon's disc minus the shade's disc), white to pale lavender, drawn in a
// transparency layer so its shadow becomes the halo around the whole shape. Shadow blur is in
// device pixels and about twice the SVG's standard deviation.
let moon = CGRect(x: 146 - 68, y: 100 - 68, width: 136, height: 136)
let shade = CGRect(x: 176 - 58, y: 76 - 58, width: 116, height: 116)
let moonlight = gradient([(0, 0xffffff, 1), (0.55, 0xf4f1ff, 1), (1, 0xd6cffd, 1)])
ctx.saveGState()
ctx.setShadow(offset: .zero, blur: 2 * 6 * scale, color: color(0xd6cffd, 0.55))
ctx.beginTransparencyLayer(auxiliaryInfo: nil)
ctx.saveGState()
ctx.addEllipse(in: moon)
ctx.clip()
ctx.addEllipse(in: moon)
ctx.addEllipse(in: shade)
ctx.clip(using: .evenOdd)
ctx.drawLinearGradient(moonlight, start: CGPoint(x: 104, y: 142), end: CGPoint(x: 188, y: 58), options: extend)
ctx.restoreGState()
ctx.endTransparencyLayer()
ctx.restoreGState()

// The sparkle: a 4-point star of quadratic curves, white-hot at the centre to gold, in a gold glow.
let sparkleCenter = CGPoint(x: 196, y: 64)
let sparkleGlow = gradient([(0, 0xe0c880, 0.45), (0.4, 0xe0c880, 0.14), (1, 0xe0c880, 0)])
ctx.drawRadialGradient(sparkleGlow, startCenter: sparkleCenter, startRadius: 0, endCenter: sparkleCenter, endRadius: 34, options: [])
let sparkle = CGMutablePath()
sparkle.move(to: CGPoint(x: 196, y: 40))
sparkle.addQuadCurve(to: CGPoint(x: 220, y: 64), control: CGPoint(x: 200, y: 60))
sparkle.addQuadCurve(to: CGPoint(x: 196, y: 88), control: CGPoint(x: 200, y: 68))
sparkle.addQuadCurve(to: CGPoint(x: 172, y: 64), control: CGPoint(x: 192, y: 68))
sparkle.addQuadCurve(to: CGPoint(x: 196, y: 40), control: CGPoint(x: 192, y: 60))
sparkle.closeSubpath()
let sparkleFill = gradient([(0, 0xfffbef, 1), (0.3, 0xf7e2a6, 1), (1, 0xe0c880, 1)])
ctx.saveGState()
ctx.addPath(sparkle)
ctx.clip()
ctx.drawRadialGradient(sparkleFill, startCenter: sparkleCenter, startRadius: 0, endCenter: sparkleCenter, endRadius: 24, options: [.drawsAfterEndLocation])
ctx.restoreGState()

// The prompt: a mint chevron and cursor with a faint phosphor glow (a shadow again).
let mint = color(0x7fe3c6)
ctx.saveGState()
ctx.setShadow(offset: .zero, blur: 2 * 5 * scale, color: color(0x7fe3c6, 0.4))
ctx.beginTransparencyLayer(auxiliaryInfo: nil)
ctx.setStrokeColor(mint)
ctx.setLineWidth(17)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.move(to: CGPoint(x: 60, y: 166))
ctx.addLine(to: CGPoint(x: 88, y: 188))
ctx.addLine(to: CGPoint(x: 60, y: 210))
ctx.strokePath()
ctx.addPath(CGPath(roundedRect: CGRect(x: 104, y: 201, width: 52, height: 17), cornerWidth: 8.4, cornerHeight: 8.4, transform: nil))
ctx.setFillColor(mint)
ctx.fillPath()
ctx.endTransparencyLayer()
ctx.restoreGState()
ctx.restoreGState()

guard let image = ctx.makeImage(),
      let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
    fail("cannot encode the PNG")
}
do {
    try png.write(to: URL(fileURLWithPath: arguments[1]))
} catch {
    fail("\(error)")
}
