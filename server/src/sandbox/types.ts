export interface SandboxConfig {
  template: string;
  timeoutMs: number;
  envVars: Record<string, string>;
  metadata: { sessionId: string; userId: string };
  network?: {
    allowOut?: string[];
    denyOut?: string[];
  };
}

export interface Sandbox {
  id: string;
  status: "running" | "stopped" | "error";
  createdAt: Date;
}

export interface FileUpload {
  path: string;
  content: Buffer | string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface SandboxProvider {
  create(config: SandboxConfig): Promise<Sandbox>;
  destroy(sandboxId: string): Promise<void>;
  runCommand(sandboxId: string, command: string, opts?: RunOptions): AsyncIterable<string>;
  uploadFiles(sandboxId: string, files: FileUpload[]): Promise<void>;
}
