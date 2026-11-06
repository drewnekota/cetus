// OS notification permission. macOS asks on first post; the host can always
// post, so permission is reported as granted.

export async function isPermissionGranted(): Promise<boolean> {
  return true;
}

export async function requestPermission(): Promise<"granted" | "denied" | "default"> {
  return "granted";
}
