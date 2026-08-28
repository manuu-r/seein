# Local setup

## Runtime modes

Production-local mode uses:

```env
AI_DRIVER=gemini
CONTEXT_DRIVER=clickhouse
BLENDER_DRIVER=qwen-mcp
SCREENSHOT_DRIVER=playwright
```

The default Gemini model assignment is capability-specific:

```env
GEMINI_RESEARCH_MODEL=gemini-3.7-flash
GEMINI_REFERENCE_MODEL=gemini-3.1-flash-image
GEMINI_PLANNER_MODEL=gemini-3.7-flash
GEMINI_INSPECTOR_MODEL=gemini-3.7-flash
```

The reference model is separate because Google Image Search is supported by Gemini 3.1 Flash Image, while 3.7 Flash supplies the current structured text/multimodal workhorse. Model IDs remain independently overridable, and each role is included in its phase cache identity.

Verification mode uses deterministic adapters:

```env
AI_DRIVER=deterministic
CONTEXT_DRIVER=memory
BLENDER_DRIVER=deterministic
SCREENSHOT_DRIVER=placeholder
```

Verification mode exercises project creation, caching, asset generation, manifest revisions, QA patching, and artifact persistence without claiming visual equivalence to Blender and Chromium.

The QA loop is bounded with:

```env
WORKFLOW_MAX_ITERATIONS=2
```

Allowed values are 1–4. The default `2` means “inspect the initial render, apply at most one patch, then inspect the corrected render.” A value of `1` performs inspection without any correction opportunity. If the last allowed inspection still asks for a fix, the run records `qaExhausted: true`.

## ClickHouse

```bash
docker compose up clickhouse -d
npm run migrate
```

The migration command is idempotent and does not require a Gemini key or Blender installation.

To prove reuse, run the same deterministic prompt twice with `CONTEXT_DRIVER=clickhouse`. The second run should report cache hits for research, plan, each applicable render and inspection, while reusing only matching assets whose files still pass SHA-256 and measured-bounds validation. Queries and table purposes are documented in [CLICKHOUSE.md](CLICKHOUSE.md).

## Qwen-MM-Plugins and Blender

Install the Qwen-MM Blender capability following its pinned release instructions. The backend starts its MCP entry through stdio using `QWEN_MCP_COMMAND`. On Linux, the capability launches Blender through Xvfb; on macOS, a native Blender installation is used without Xvfb.

Recommended environment:

```env
QWEN_MCP_COMMAND=qwen-mm-plugins-blender
QWEN_MM_AUTOLAUNCH=1
BLENDER_HOST=127.0.0.1
BLENDER_PORT=9876
```

The Blender process and core API must see the same absolute `DATA_ROOT`. In containers, mount the same volume path into both processes.

The Compose `core` service is explicitly `linux/amd64` for a reproducible worker image on Docker Desktop. Blender is installed during the image build, avoiding Qwen-MM's first-run download path and the possibility of CDN bot protection blocking an unattended container. Native macOS development can instead install Blender and run the Node backend outside Docker.

The backend allows up to 20 minutes total for the batched MCP call, resets the idle timeout when progress arrives, and sends every missing recipe in the run through that single Blender execution.

## Chromium

Install Playwright's browser once:

```bash
npx playwright install chromium
```

`PLAYWRIGHT_EXECUTABLE_PATH` can point to an existing Chromium-compatible binary. When unset, the backend explicitly uses Playwright's bundled Chromium path; this avoids a separate headless-shell lookup on installations that only contain full Chromium.

## Failure behavior

A production provider failure fails the run and records the stage. Production mode never silently switches to deterministic content, because that would make a successful-looking run misleading.
