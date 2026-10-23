/**
 * Build the text copied from the example host's GPU error dialog.
 *
 * Keep this formatter independent of the DOM so the report stays deterministic and the dialog can
 * be tested without booting WebGPU. The caller supplies a snapshot of the live engine state at the
 * moment the user presses Copy.
 */
export interface GpuErrorReportContext {
  error: string;
  build: string;
  capturedAt: string;
  page: {
    url: string;
    referrer: string;
    userAgent: string;
    viewport: { width: number; height: number; devicePixelRatio: number };
    scene: string;
    platform: string;
    secureContext: boolean;
    hardwareConcurrency: number;
  };
  engine?: Readonly<Record<string, unknown>>;
}

export function buildGpuErrorReport(context: GpuErrorReportContext): string {
  const debug = {
    capturedAt: context.capturedAt,
    build: context.build,
    page: context.page,
    engine: context.engine ?? "unavailable (engine did not finish starting)",
  };
  return [
    "Forge Engine GPU error report",
    "",
    "Error information",
    context.error,
    "",
    "Debug information",
    JSON.stringify(debug, null, 2),
  ].join("\n");
}
