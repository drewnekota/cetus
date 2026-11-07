import CryptoKit
import Foundation

/// Initiator side of `Noise_NK_25519_ChaChaPoly_SHA256` — the phone's half of
/// the handshake the Mac runs with `snow` (backend/src/remote_secure.rs).
/// The phone knows the Mac's static key from the pairing QR, so whoever
/// answers message 1 must hold the Mac's private key.
struct NoiseNKInitiator {
    static let protocolName = "Noise_NK_25519_ChaChaPoly_SHA256"

    private var symmetric: SymmetricState
    private let remoteStatic: Curve25519.KeyAgreement.PublicKey
    private let ephemeral = Curve25519.KeyAgreement.PrivateKey()

    init(remoteStatic: Data, prologue: Data) throws {
        self.remoteStatic = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: remoteStatic)
        symmetric = SymmetricState(protocolName: Self.protocolName)
        symmetric.mixHash(prologue)
        // Pre-message pattern: <- s
        symmetric.mixHash(remoteStatic)
    }

    /// -> e, es (+ empty encrypted payload)
    mutating func writeMessage1() throws -> Data {
        let e = ephemeral.publicKey.rawRepresentation
        symmetric.mixHash(e)
        try symmetric.mixKey(dh(ephemeral, remoteStatic))
        return e + (try symmetric.encryptAndHash(Data()))
    }

    /// <- e, ee; returns (send, receive) cipher states.
    mutating func readMessage2(_ message: Data) throws -> (CipherState, CipherState) {
        guard message.count >= 32 + 16 else { throw NoiseError.shortMessage }
        let re = message.prefix(32)
        symmetric.mixHash(Data(re))
        let remoteEphemeral = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: re)
        try symmetric.mixKey(dh(ephemeral, remoteEphemeral))
        _ = try symmetric.decryptAndHash(Data(message.dropFirst(32)))
        return symmetric.split()
    }

    private func dh(_ priv: Curve25519.KeyAgreement.PrivateKey, _ pub: Curve25519.KeyAgreement.PublicKey) throws -> Data {
        let secret = try priv.sharedSecretFromKeyAgreement(with: pub)
        return secret.withUnsafeBytes { Data($0) }
    }
}

enum NoiseError: Error {
    case shortMessage
    case nonceExhausted
}

struct CipherState {
    private var key: SymmetricKey?
    private var nonce: UInt64 = 0

    init(key: Data?) {
        self.key = key.map { SymmetricKey(data: $0) }
    }

    var hasKey: Bool { key != nil }

    private static func nonceBytes(_ n: UInt64) -> ChaChaPoly.Nonce {
        var bytes = Data(count: 4)
        withUnsafeBytes(of: n.littleEndian) { bytes.append(contentsOf: $0) }
        return try! ChaChaPoly.Nonce(data: bytes)
    }

    mutating func encrypt(ad: Data, plaintext: Data) throws -> Data {
        guard let key else { return plaintext }
        guard nonce < UInt64.max else { throw NoiseError.nonceExhausted }
        let box = try ChaChaPoly.seal(plaintext, using: key, nonce: Self.nonceBytes(nonce), authenticating: ad)
        nonce += 1
        return box.ciphertext + box.tag
    }

    mutating func decrypt(ad: Data, ciphertext: Data) throws -> Data {
        guard let key else { return ciphertext }
        guard ciphertext.count >= 16 else { throw NoiseError.shortMessage }
        guard nonce < UInt64.max else { throw NoiseError.nonceExhausted }
        let box = try ChaChaPoly.SealedBox(
            nonce: Self.nonceBytes(nonce),
            ciphertext: ciphertext.dropLast(16),
            tag: ciphertext.suffix(16)
        )
        let plain = try ChaChaPoly.open(box, using: key, authenticating: ad)
        nonce += 1
        return plain
    }
}

private struct SymmetricState {
    var ck: Data
    var h: Data
    var cipher = CipherState(key: nil)

    init(protocolName: String) {
        let name = Data(protocolName.utf8)
        if name.count <= 32 {
            h = name + Data(count: 32 - name.count)
        } else {
            h = Data(SHA256.hash(data: name))
        }
        ck = h
    }

    mutating func mixHash(_ data: Data) {
        var hasher = SHA256()
        hasher.update(data: h)
        hasher.update(data: data)
        h = Data(hasher.finalize())
    }

    mutating func mixKey(_ ikm: Data) throws {
        let (a, b) = Self.hkdf(chainingKey: ck, ikm: ikm)
        ck = a
        cipher = CipherState(key: b)
    }

    mutating func encryptAndHash(_ plaintext: Data) throws -> Data {
        let c = try cipher.encrypt(ad: h, plaintext: plaintext)
        mixHash(c)
        return c
    }

    mutating func decryptAndHash(_ ciphertext: Data) throws -> Data {
        let p = try cipher.decrypt(ad: h, ciphertext: ciphertext)
        mixHash(ciphertext)
        return p
    }

    func split() -> (CipherState, CipherState) {
        let (a, b) = Self.hkdf(chainingKey: ck, ikm: Data())
        return (CipherState(key: a), CipherState(key: b))
    }

    /// Noise's two-output HKDF (HMAC-SHA256).
    static func hkdf(chainingKey: Data, ikm: Data) -> (Data, Data) {
        let temp = Data(HMAC<SHA256>.authenticationCode(for: ikm, using: SymmetricKey(data: chainingKey)))
        let tempKey = SymmetricKey(data: temp)
        let out1 = Data(HMAC<SHA256>.authenticationCode(for: Data([1]), using: tempKey))
        let out2 = Data(HMAC<SHA256>.authenticationCode(for: out1 + Data([2]), using: tempKey))
        return (out1, out2)
    }
}
