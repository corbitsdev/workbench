// Runtime-checked mint of a CredentialCipher. Missing or wrong-shape
// input fails closed and the tag is not minted.
import type { CredentialCipher } from "@intx/types";

function isCredentialCipher(value: unknown): value is CredentialCipher {
  if (value === null || typeof value !== "object") return false;
  if (!("encrypt" in value) || !("decrypt" in value)) return false;
  return (
    typeof value.encrypt === "function" && typeof value.decrypt === "function"
  );
}

export function tagCredentialCipher(cipher: unknown): CredentialCipher {
  if (!isCredentialCipher(cipher)) {
    throw new Error(
      "credentialCipher is missing or has the wrong shape; refusing to mint a tagged cipher",
    );
  }
  return cipher;
}
