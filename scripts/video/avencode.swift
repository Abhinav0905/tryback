// AVFoundation helper for scripts/record-demo.ts (macOS, no ffmpeg needed).
//
//   avencode encode <manifest.json>             JPEG frame runs + PCM16 WAV → H.264/AAC MP4
//   avencode frames <video.mp4> <outdir> t...   one PNG per timestamp (seconds) → <outdir>/f-<t>.png
//   avencode probe  <video.mp4>                 JSON: duration, size, fps, audio
//
// Manifest: { width, height, fps, runs: [{ file, count }], audio: "x.wav" | null,
//             output: "out.mp4", bitrate? }
// Output is constant-frame-rate H.264 High (4:2:0, BT.709) with AAC audio, moov atom
// first (shouldOptimizeForNetworkUse = "faststart"), which is what YouTube wants.
// Compiled once by the recorder with: swiftc -O -swift-version 5 avencode.swift -o <bin>

import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Run: Decodable { let file: String; let count: Int }
struct Manifest: Decodable {
  let width: Int
  let height: Int
  let fps: Int
  let runs: [Run]
  let audio: String?
  let output: String
  let bitrate: Int?
}

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

func loadImage(_ path: String) -> CGImage? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

/// Minimal PCM16 WAV reader (walks chunks). Returns interleaved little-endian bytes.
func readWav(_ path: String) -> (rate: Int, channels: Int, data: Data) {
  guard let d = try? Data(contentsOf: URL(fileURLWithPath: path)), d.count > 12 else { fail("Cannot read \(path)") }
  func u32(_ o: Int) -> Int { Int(d[o]) | Int(d[o + 1]) << 8 | Int(d[o + 2]) << 16 | Int(d[o + 3]) << 24 }
  func u16(_ o: Int) -> Int { Int(d[o]) | Int(d[o + 1]) << 8 }
  var off = 12
  var rate = 0, channels = 0, bits = 0
  var pcm: Data? = nil
  while off + 8 <= d.count {
    let id = String(data: d.subdata(in: off..<(off + 4)), encoding: .ascii) ?? ""
    let size = u32(off + 4)
    let body = off + 8
    if id == "fmt " {
      channels = u16(body + 2); rate = u32(body + 4); bits = u16(body + 14)
    } else if id == "data" {
      pcm = d.subdata(in: body..<min(d.count, body + size))
    }
    off = body + size + (size % 2)
  }
  guard let data = pcm, rate > 0, channels > 0, bits == 16 else { fail("Unsupported WAV \(path) (need PCM16)") }
  return (rate, channels, data)
}

final class Box<T>: @unchecked Sendable { var value: T; init(_ v: T) { value = v } }

func encode(_ m: Manifest) {
  let url = URL(fileURLWithPath: m.output)
  try? FileManager.default.removeItem(at: url)
  guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { fail("Cannot create \(m.output)") }
  writer.shouldOptimizeForNetworkUse = true

  let videoSettings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: m.width,
    AVVideoHeightKey: m.height,
    AVVideoColorPropertiesKey: [
      AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
      AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
      AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
    ],
    AVVideoCompressionPropertiesKey: [
      AVVideoAverageBitRateKey: m.bitrate ?? 10_000_000,
      AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      AVVideoMaxKeyFrameIntervalKey: m.fps * 2,
      AVVideoExpectedSourceFrameRateKey: m.fps,
    ],
  ]
  let vin = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
  vin.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: vin,
    sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: m.width,
      kCVPixelBufferHeightKey as String: m.height,
      kCVPixelBufferCGImageCompatibilityKey as String: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ])
  writer.add(vin)

  var ain: AVAssetWriterInput? = nil
  var wav: (rate: Int, channels: Int, data: Data)? = nil
  var audioFormat: CMAudioFormatDescription? = nil
  if let a = m.audio {
    let w = readWav(a)
    wav = w
    var asbd = AudioStreamBasicDescription(
      mSampleRate: Float64(w.rate), mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
      mBytesPerPacket: UInt32(2 * w.channels), mFramesPerPacket: 1, mBytesPerFrame: UInt32(2 * w.channels),
      mChannelsPerFrame: UInt32(w.channels), mBitsPerChannel: 16, mReserved: 0)
    CMAudioFormatDescriptionCreate(
      allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
      magicCookie: nil, extensions: nil, formatDescriptionOut: &audioFormat)
    let input = AVAssetWriterInput(
      mediaType: .audio,
      outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: w.rate, AVNumberOfChannelsKey: w.channels,
        AVEncoderBitRateKey: 160_000,
      ])
    input.expectsMediaDataInRealTime = false
    writer.add(input)
    ain = input
  }

  guard writer.startWriting() else { fail("startWriting failed: \(writer.error?.localizedDescription ?? "?")") }
  writer.startSession(atSourceTime: .zero)

  let group = DispatchGroup()
  let fps = Int32(m.fps)

  // ── Video ──
  let runIndex = Box(0)
  let left = Box(0)
  let frameNo = Box<Int64>(0)
  let current = Box<CVPixelBuffer?>(nil)
  let videoDone = Box(false)
  group.enter()
  vin.requestMediaDataWhenReady(on: DispatchQueue(label: "tb.video")) {
    while vin.isReadyForMoreMediaData && !videoDone.value {
      if left.value == 0 {
        if runIndex.value >= m.runs.count {
          videoDone.value = true
          vin.markAsFinished()
          group.leave()
          return
        }
        let run = m.runs[runIndex.value]
        runIndex.value += 1
        guard let img = loadImage(run.file) else { fail("Cannot decode \(run.file)") }
        guard let pool = adaptor.pixelBufferPool else { fail("No pixel buffer pool") }
        var pb: CVPixelBuffer? = nil
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
        guard let buf = pb else { fail("Cannot allocate a pixel buffer") }
        CVPixelBufferLockBaseAddress(buf, [])
        let ctx = CGContext(
          data: CVPixelBufferGetBaseAddress(buf), width: m.width, height: m.height, bitsPerComponent: 8,
          bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: CGColorSpace(name: CGColorSpace.sRGB)!,
          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        ctx?.interpolationQuality = .high
        ctx?.draw(img, in: CGRect(x: 0, y: 0, width: m.width, height: m.height))
        CVPixelBufferUnlockBaseAddress(buf, [])
        current.value = buf
        left.value = max(1, run.count)
      }
      guard let buf = current.value else { fail("No frame") }
      if !adaptor.append(buf, withPresentationTime: CMTime(value: frameNo.value, timescale: fps)) {
        fail("Video append failed at frame \(frameNo.value): \(writer.error?.localizedDescription ?? "?")")
      }
      frameNo.value += 1
      left.value -= 1
    }
  }

  // ── Audio ──
  if let input = ain, let w = wav, let fmt = audioFormat {
    let bytesPerFrame = 2 * w.channels
    let totalFrames = w.data.count / bytesPerFrame
    let pos = Box(0)
    let audioDone = Box(false)
    group.enter()
    input.requestMediaDataWhenReady(on: DispatchQueue(label: "tb.audio")) {
      while input.isReadyForMoreMediaData && !audioDone.value {
        if pos.value >= totalFrames {
          audioDone.value = true
          input.markAsFinished()
          group.leave()
          return
        }
        let n = min(4096, totalFrames - pos.value)
        let len = n * bytesPerFrame
        var block: CMBlockBuffer? = nil
        CMBlockBufferCreateWithMemoryBlock(
          allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: len, blockAllocator: kCFAllocatorDefault,
          customBlockSource: nil, offsetToData: 0, dataLength: len, flags: 0, blockBufferOut: &block)
        guard let bb = block else { fail("Cannot allocate audio block") }
        let start = pos.value * bytesPerFrame
        w.data.subdata(in: start..<(start + len)).withUnsafeBytes { raw in
          _ = CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: bb, offsetIntoDestination: 0, dataLength: len)
        }
        var sb: CMSampleBuffer? = nil
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
          allocator: kCFAllocatorDefault, dataBuffer: bb, formatDescription: fmt, sampleCount: n,
          presentationTimeStamp: CMTime(value: Int64(pos.value), timescale: Int32(w.rate)),
          packetDescriptions: nil, sampleBufferOut: &sb)
        guard let sample = sb, input.append(sample) else {
          fail("Audio append failed: \(writer.error?.localizedDescription ?? "?")")
        }
        pos.value += n
      }
    }
  }

  group.wait()
  let sem = DispatchSemaphore(value: 0)
  writer.finishWriting { sem.signal() }
  sem.wait()
  if writer.status != .completed { fail("Encoding failed: \(writer.error?.localizedDescription ?? "unknown")") }
  print("{\"frames\":\(frameNo.value),\"output\":\"\(m.output)\"}")
}

func frames(_ video: String, _ outDir: String, _ times: [Double]) {
  let asset = AVURLAsset(url: URL(fileURLWithPath: video))
  let gen = AVAssetImageGenerator(asset: asset)
  gen.requestedTimeToleranceBefore = .zero
  gen.requestedTimeToleranceAfter = .zero
  gen.appliesPreferredTrackTransform = true
  try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
  var written: [String] = []
  for t in times {
    let time = CMTime(seconds: t, preferredTimescale: 600)
    guard let img = try? gen.copyCGImage(at: time, actualTime: nil) else { fail("No frame at \(t)s") }
    let path = "\(outDir)/f-\(String(format: "%.2f", t)).png"
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
      fail("Cannot write \(path)")
    }
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
    written.append(path)
  }
  let json = try! JSONSerialization.data(withJSONObject: written)
  print(String(data: json, encoding: .utf8)!)
}

func probe(_ video: String) {
  let asset = AVURLAsset(url: URL(fileURLWithPath: video))
  let v = asset.tracks(withMediaType: .video).first
  let a = asset.tracks(withMediaType: .audio).first
  let size = v?.naturalSize ?? .zero
  var codec = ""
  if let desc = v?.formatDescriptions.first {
    let sub = CMFormatDescriptionGetMediaSubType(desc as! CMFormatDescription)
    let chars = [24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((sub >> UInt32($0)) & 0xff))) }
    codec = String(chars)
  }
  let out: [String: Any] = [
    "durationSec": CMTimeGetSeconds(asset.duration),
    "width": Int(size.width), "height": Int(size.height),
    "fps": Double(v?.nominalFrameRate ?? 0),
    "videoCodec": codec,
    "hasAudio": a != nil,
    "audioDurationSec": a.map { CMTimeGetSeconds($0.timeRange.duration) } ?? 0,
  ]
  let json = try! JSONSerialization.data(withJSONObject: out)
  print(String(data: json, encoding: .utf8)!)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: avencode encode <manifest.json> | frames <video> <outdir> <t>... | probe <video>") }
switch args[1] {
case "encode":
  guard let d = try? Data(contentsOf: URL(fileURLWithPath: args[2])),
    let m = try? JSONDecoder().decode(Manifest.self, from: d)
  else { fail("Bad manifest \(args[2])") }
  encode(m)
case "frames":
  guard args.count >= 5 else { fail("usage: avencode frames <video> <outdir> <t>...") }
  frames(args[2], args[3], args[4...].compactMap { Double($0) })
case "probe":
  probe(args[2])
default:
  fail("unknown command \(args[1])")
}
