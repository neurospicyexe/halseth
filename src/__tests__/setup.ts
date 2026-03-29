// Test environment setup -- polyfills for Cloudflare Workers APIs not available in Node.js

// crypto.subtle.timingSafeEqual is a Cloudflare Workers extension, not in Node's Web Crypto API.
// Polyfill with a constant-time XOR comparison for test purposes.
if (typeof (crypto.subtle as any).timingSafeEqual !== "function") {
  (crypto.subtle as any).timingSafeEqual = function (a: ArrayBuffer, b: ArrayBuffer): boolean {
    const viewA = new Uint8Array(a);
    const viewB = new Uint8Array(b);
    if (viewA.byteLength !== viewB.byteLength) return false;
    let diff = 0;
    for (let i = 0; i < viewA.byteLength; i++) {
      diff |= (viewA[i] as number) ^ (viewB[i] as number);
    }
    return diff === 0;
  };
}
