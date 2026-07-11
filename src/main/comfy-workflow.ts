const UNSUPPORTED_CHECKPOINT_MARKERS = /(?:^|[._-])(flux\d*|sd3|pixart|hunyuan|qwen\d*|wan\d*|kolors|cascade)(?:$|[._-])/i

/** The built-in graph supports SD1.x/SD2.x/SDXL-style checkpoint models. */
export function isCompatibleCheckpoint(name: string): boolean {
  const basename = name.split(/[\\/]/).pop() ?? name
  return !UNSUPPORTED_CHECKPOINT_MARKERS.test(basename)
}
