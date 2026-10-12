import { useEffect, useState } from "react";

/** The optional TikTok video helper (yt-dlp), as the server reports it. */
export interface VideoHelperStatus {
  installed: boolean;
  busy: boolean;
  action: "" | "install" | "check" | "update";
  /** The weekly check saw a newer release; it is installed only when the owner chooses Update. */
  updateAvailable?: boolean;
  error: string;
  version?: string;
  checkedAt?: string;
  checksum?: boolean;
}

const listeners = new Set<(status: VideoHelperStatus | null) => void>();
let current: VideoHelperStatus | null = null;
let timer: number | undefined;

function publish(status: VideoHelperStatus | null) {
  current = status;
  for (const listener of listeners) listener(status);
  window.clearTimeout(timer);
  // Follow a download until it finishes.
  if (status?.busy) timer = window.setTimeout(() => void refreshVideoHelper(), 1000);
}

function parse(data: unknown): VideoHelperStatus | null {
  const d = data as Partial<VideoHelperStatus> & { ok?: boolean };
  if (!d || d.ok !== true || typeof d.installed !== "boolean" || typeof d.busy !== "boolean") return null;
  return {
    installed: d.installed, busy: d.busy, action: d.action === "install" || d.action === "update" || d.action === "check" ? d.action : "",
    updateAvailable: d.updateAvailable === true,
    error: typeof d.error === "string" ? d.error : "", checksum: d.checksum === true,
    version: typeof d.version === "string" ? d.version : undefined,
    checkedAt: typeof d.checkedAt === "string" ? d.checkedAt : undefined,
  };
}

export async function refreshVideoHelper(): Promise<void> {
  try {
    const response = await fetch("/api/helpers/video", { cache: "no-store" });
    publish(parse(await response.json()));
  } catch {
    publish(current);
  }
}

/** Install, check for a newer version, update or remove. Returns false when the server refused. */
export async function changeVideoHelper(action: "install" | "check" | "update" | "remove"): Promise<boolean> {
  try {
    const response = await fetch("/api/helpers/video", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
    });
    const status = parse(await response.json());
    if (status) publish(status);
    return response.ok;
  } catch {
    return false;
  }
}

export function useVideoHelper(): VideoHelperStatus | null {
  const [status, setStatus] = useState(current);
  useEffect(() => {
    listeners.add(setStatus);
    if (!current) void refreshVideoHelper();
    return () => { listeners.delete(setStatus); };
  }, []);
  return status;
}

/** One plain sentence for a failed download or update. */
export function helperProblem(code: string): string {
  switch (code) {
    case "checksum_mismatch":
    case "not_listed":
      return "The download didn't match the checksum yt-dlp publishes, so it was thrown away. Try again later.";
    case "not_runnable": return "The downloaded helper wouldn't start on this computer, so it wasn't kept.";
    case "too_large": return "The download was bigger than expected, so it was stopped.";
    case "dns_failure":
    case "timeout":
    case "network_error":
    case "http_error":
    case "busy":
      return "GitHub couldn't be reached. Check the internet connection and try again.";
    default: return "The video helper couldn't be set up.";
  }
}
