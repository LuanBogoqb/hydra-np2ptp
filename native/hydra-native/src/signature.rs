use minisign_verify::{PublicKey, Signature};
use napi_derive::napi;

/// Verifies a detached minisign signature over `content`.
///
/// Any failure — malformed key, malformed signature, wrong key, tampered
/// content — returns `false`. Callers treat `false` as "reject the file"
/// (fail-closed), so this function never needs to distinguish error causes.
#[napi]
pub fn verify_minisign(content: napi::bindgen_prelude::Buffer, signature_text: String, public_key_b64: String) -> bool {
    verify_minisign_impl(content.as_ref(), &signature_text, &public_key_b64)
}

fn verify_minisign_impl(content: &[u8], signature_text: &str, public_key_b64: &str) -> bool {
    let Ok(public_key) = PublicKey::from_base64(public_key_b64) else {
        return false;
    };
    let Ok(signature) = Signature::decode(signature_text) else {
        return false;
    };
    public_key.verify(content, &signature, false).is_ok()
}

#[cfg(test)]
mod tests {
    use super::verify_minisign_impl;

    // Real np2ptp release public key (pinned in the embedder as well).
    const RELEASE_PUBKEY: &str = "RWSvbqA2exn6e3XkG53XH4blBh0pNcOAVEuaJCnzDGQLqYN1jqUGrkYW";

    const SUMS: &[u8] = b"deadbeef  np2ptp-windows-x86_64.exe\n";

    const VALID_SIG: &str = "untrusted comment: signature from minisign secret key\n\
RUSvbqA2exn6e8B4WfFJymh9fb8QobcpgMX5c+tf+2xsmypeVOGZJS4aayNB5aRgmWSy/JbxINGwOAmluc+W3eajL820XQGiNg0=\n\
trusted comment: np2ptp release vTEST\n\
VjWsSxBc07o+mP2xeNmQlF/M8tHqujHDy6KUwNjZ72/JUG7KtFdzdjrDMSRoLi0hhVjKCPu/zN/CybQcwVUIAQ==\n";

    // Same content signed by a different (attacker) key — MUST be rejected.
    const WRONG_KEY_SIG: &str = "untrusted comment: signature from minisign secret key\n\
RUSWNpfJL9sCeKHCiQs8WbhmH/WU2tetoNnRcTeasbXC3mG3qT1hOceFC/W4qLH8ULCGDwjdEm3aJQUJg6U5jSiCSdxC0zngJA0=\n\
trusted comment: np2ptp release vTEST\n\
x5iR8OEZPAAxhtjOECmSbGAEl21ZOuCP4TazkXS7egkJVT0SZWRcUxfAbPA7zY4ScmMIBradVVGdjrS3TaK4Cg==\n";

    #[test]
    fn accepts_valid_signature() {
        assert!(verify_minisign_impl(SUMS, VALID_SIG, RELEASE_PUBKEY));
    }

    #[test]
    fn rejects_tampered_content() {
        let tampered = b"attacker0  np2ptp-windows-x86_64.exe\n";
        assert!(!verify_minisign_impl(tampered, VALID_SIG, RELEASE_PUBKEY));
    }

    #[test]
    fn rejects_signature_from_wrong_key() {
        assert!(!verify_minisign_impl(SUMS, WRONG_KEY_SIG, RELEASE_PUBKEY));
    }

    #[test]
    fn rejects_garbage_inputs() {
        assert!(!verify_minisign_impl(SUMS, "not a signature", RELEASE_PUBKEY));
        assert!(!verify_minisign_impl(SUMS, VALID_SIG, "not a key"));
        assert!(!verify_minisign_impl(b"", VALID_SIG, RELEASE_PUBKEY));
    }
}
