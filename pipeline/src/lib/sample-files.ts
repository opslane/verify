// pipeline/src/lib/sample-files.ts — Pre-create sample files for browse agents
import { writeFileSync, existsSync } from "node:fs";

/** Minimal valid single-page PDF (smallest possible). */
const MINIMAL_PDF_BASE64 =
  "JVBERi0xLjAKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjIwNgolJUVPRgo=";

export const SAMPLE_PDF_PATH = "/tmp/verify-sample.pdf";

/**
 * Write sample files that browse agents may need (e.g., for file upload ACs).
 * Idempotent — skips if file already exists.
 */
export function ensureSampleFiles(): void {
  if (!existsSync(SAMPLE_PDF_PATH)) {
    writeFileSync(SAMPLE_PDF_PATH, Buffer.from(MINIMAL_PDF_BASE64, "base64"));
  }
}
