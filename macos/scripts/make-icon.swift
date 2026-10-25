// Draws lu-minal's app icon as a 1024 x 1024 PNG: the night-sky tile with the crescent moon,
// a few stars and a mint prompt - the same design as linux/lu-minal.svg (256-unit coordinates),
// laid out on the macOS icon grid (an 824 px tile with a soft shadow).
//
//   xcrun swift macos/scripts/make-icon.swift <out.png>
import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: make-icon.swift <out.png>\n".utf8))
    exit(2)
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

guard let ctx = CGContext(
    data: nil,
    width: pixels,
    height: pixels,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    FileHandle.standardError.write(Data("make-icon: cannot create a bitmap context\n".utf8))
    exit(1)
}

// SVG coordinates: y grows downwards, and the 240-unit tile (8...248) becomes 824 px at 100 px.
let scale = CGFloat(824) / 240
let offset = CGFloat(100) - 8 * scale
ctx.translateBy(x: 0, y: CGFloat(pixels))
ctx.scaleBy(x: 1, y: -1)
ctx.translateBy(x: offset, y: offset)
ctx.scaleBy(x: scale, y: scale)

let tile = CGPath(roundedRect: CGRect(x: 8, y: 8, width: 240, height: 240), cornerWidth: 54, cornerHeight: 54, transform: nil)

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

// The sky: night-800 at the top to night-950 at the bottom.
let colors = [color(0x1d1742), color(0x0b0920)] as CFArray
if let sky = CGGradient(colorsSpace: space, colors: colors, locations: [0, 1]) {
    ctx.drawLinearGradient(sky, start: CGPoint(x: 0, y: 8), end: CGPoint(x: 0, y: 248), options: [])
}

// The crescent: the moon's disc minus an offset disc.
let moon = CGRect(x: 146 - 62, y: 104 - 62, width: 124, height: 124)
let shade = CGRect(x: 172 - 54, y: 82 - 54, width: 108, height: 108)
ctx.saveGState()
ctx.addEllipse(in: moon)
ctx.clip()
ctx.addEllipse(in: moon)
ctx.addEllipse(in: shade)
ctx.setFillColor(color(0xf4f1ff))
ctx.fillPath(using: .evenOdd)
ctx.restoreGState()

// Stars: moonlight gold and lavender.
let stars: [(CGFloat, CGFloat, CGFloat, UInt32)] = [
    (196, 150, 5, 0xe0c880),
    (60, 64, 4, 0xb9aefb),
    (206, 58, 3, 0xd6cffd),
    (40, 124, 3, 0xb9aefb),
]
for (x, y, r, hex) in stars {
    ctx.setFillColor(color(hex))
    ctx.fillEllipse(in: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r))
}

// The prompt: a mint chevron and cursor.
let mint = color(0x7fe3c6)
ctx.setStrokeColor(mint)
ctx.setLineWidth(13)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.move(to: CGPoint(x: 58, y: 172))
ctx.addLine(to: CGPoint(x: 84, y: 192))
ctx.addLine(to: CGPoint(x: 58, y: 212))
ctx.strokePath()
ctx.addPath(CGPath(roundedRect: CGRect(x: 98, y: 200, width: 52, height: 13), cornerWidth: 6.4, cornerHeight: 6.4, transform: nil))
ctx.setFillColor(mint)
ctx.fillPath()
ctx.restoreGState()

guard let image = ctx.makeImage(),
      let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write(Data("make-icon: cannot encode the PNG\n".utf8))
    exit(1)
}
do {
    try png.write(to: URL(fileURLWithPath: arguments[1]))
} catch {
    FileHandle.standardError.write(Data("make-icon: \(error)\n".utf8))
    exit(1)
}
