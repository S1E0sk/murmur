#!/usr/bin/swift
// Murmur — Native macOS Speech Recognition
// Apple SFSpeechRecognizer kullanır, internet gerekmez.
// Kullanım: swift speech.swift [tr-TR|en-US]
// Çıktı: INTERIM:metin veya FINAL:metin veya ERROR:sebep

import Foundation
import Speech
import AVFoundation

let lang = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "tr-TR"
let locale = Locale(identifier: lang)

guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
    print("ERROR:recognizer_unavailable")
    exit(1)
}

let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
// Cihaz üzerinde — internet gerekmez
if #available(macOS 13, *) {
    request.requiresOnDeviceRecognition = true
}

let engine = AVAudioEngine()
let inputNode = engine.inputNode
let format = inputNode.outputFormat(forBus: 0)

inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
}

engine.prepare()
do {
    try engine.start()
} catch {
    print("ERROR:engine_\(error.localizedDescription)")
    exit(1)
}

var done = false

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        print("ERROR:not_authorized")
        exit(1)
    }
}

let task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        let text = result.bestTranscription.formattedString
        if result.isFinal {
            print("FINAL:\(text)")
            fflush(stdout)
            engine.stop()
            inputNode.removeTap(onBus: 0)
            done = true
            exit(0)
        } else {
            print("INTERIM:\(text)")
            fflush(stdout)
        }
    }
    if let error = error {
        let msg = (error as NSError).domain
        if msg != "kAFAssistantErrorDomain" {
            print("ERROR:\(error.localizedDescription)")
            exit(1)
        }
    }
}

// Signal handler — dışarıdan durdurulabilir
signal(SIGTERM) { _ in
    task.cancel()
    exit(0)
}
signal(SIGINT) { _ in
    task.cancel()
    exit(0)
}

RunLoop.main.run()
