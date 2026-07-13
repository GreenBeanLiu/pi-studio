# Runtime dependencies

## Required

- Windows 10/11.
- A configured model provider API key for Agent nodes.
- Git is strongly recommended for diff, rollback, and run-change review.

System Node.js is not required. Pi's patched `RpcClient` starts the current process runtime;
in pi-studio that is the packaged Electron executable running with `ELECTRON_RUN_AS_NODE=1`.

## Optional

- Docker Desktop: required only when Docker sandbox mode is enabled. Without Docker,
  pi-studio runs the Agent directly on the Windows host.
- ComfyUI and its Python runtime: required only for local image generation.
- Tavily: required only for the optional web-search tool.
- Helicone: required only when model request logging through Helicone is enabled.
- Feishu and WeChat credentials: required only by their respective workflow nodes.

## Behavior when optional dependencies are unavailable

- Docker sandbox disabled: Docker is never required or started.
- Docker sandbox enabled but daemon/image unavailable: opening an Agent workspace fails
  with an actionable error; pi-studio does not silently fall back to unsandboxed execution.
- ComfyUI unavailable: cloud image generation remains usable when configured.
